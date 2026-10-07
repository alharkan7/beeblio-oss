import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { dataDir } from "./app-paths";
import { writeAtomically } from "./atomic-write";
import { SETTINGS, settingDefinition, type SettingName, type SettingsSnapshot, type SettingStatus } from "./app-settings-registry";

/**
 * Settings saved in the Settings dialog. They live in the data folder so both
 * local server processes read the same values, and they take precedence over
 * the environment (.env.local in a checkout), which the installed desktop app
 * does not have. Values are read when used, so a change applies without a
 * restart. Never send a secret to the browser; use settingsSnapshot().
 */

type StoredSettings = { version: 1; values: Partial<Record<SettingName, string>> };

const settingsFile = () => path.join(dataDir(), "settings.json");
/** Where the first desktop release kept the OpenRouter key; moved into settings.json on first read. */
const legacyCredentialsFile = () => path.join(dataDir(), "credentials.json");

/**
 * Keyed by file so tests and processes with another data folder never share an
 * entry. The inode matters: every save renames a new file into place, so it
 * changes even where mtime is coarse (1 s on HFS+) and the size stays the same.
 */
let cache: { file: string; ino: number; mtimeMs: number; size: number; values: StoredSettings["values"] } | undefined;

/** The saved value, else the environment's; undefined when neither is set. */
export function appSetting(name: SettingName): string | undefined {
  return savedValues()[name] ?? environmentValue(name);
}

/** Same rules as integerEnv: a fallback when unset, an error when not an integer of at least `minimum`. */
export function integerSetting(name: SettingName, fallback: number, minimum = 0): number {
  const raw = appSetting(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${settingDefinition(name)?.label ?? name} must be a whole number of at least ${minimum}. Change it in Settings.`);
  return value;
}

/** The OpenRouter key the agent and writing tools should use. */
export function openRouterApiKey(): string | undefined {
  return appSetting("OPENROUTER_API_KEY");
}

/** Everything the Settings dialog may show, with secrets reduced to their last four characters. */
export function settingsSnapshot(): SettingsSnapshot {
  const saved = savedValues();
  const settings = {} as SettingsSnapshot["settings"];
  const missingRequired: string[] = [];
  for (const setting of SETTINGS) {
    const fromSettings = saved[setting.name];
    const value = fromSettings ?? environmentValue(setting.name);
    const status: SettingStatus = { source: fromSettings ? "settings" : value ? "env" : null };
    if (value) {
      if (setting.kind === "secret") status.last4 = value.slice(-4);
      else status.value = value;
    }
    settings[setting.name] = status;
    if ("required" in setting && setting.required && !value) missingRequired.push(setting.label);
  }
  return { settings, missingRequired };
}

/**
 * Applies a validated patch: a string saves the value, null removes the saved
 * one so the environment applies again. Other saved values are kept.
 */
export function saveSettings(patch: Partial<Record<SettingName, string | null>>): void {
  const values = { ...savedValues() };
  for (const [name, value] of Object.entries(patch) as Array<[SettingName, string | null]>) {
    if (value) values[name] = value;
    else delete values[name];
  }
  writeSettingsFile(values);
}

function writeSettingsFile(values: StoredSettings["values"]): void {
  writeAtomically(settingsFile(), `${JSON.stringify({ version: 1, values } satisfies StoredSettings, null, 2)}\n`);
  cache = undefined;
}

function environmentValue(name: SettingName): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/**
 * Reads settings.json, reusing the parsed values while the file is unchanged
 * because some settings are read several times per request. A damaged file is
 * reported and treated as empty, so a bad hand edit falls back to the
 * environment instead of breaking every model call; the next save repairs it.
 */
function savedValues(): StoredSettings["values"] {
  const file = settingsFile();
  let stats;
  try {
    stats = statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return migrateLegacyCredentials();
  }
  if (cache?.file === file && cache.ino === stats.ino && cache.mtimeMs === stats.mtimeMs && cache.size === stats.size) return cache.values;
  const values = parseSettings(readFileSync(file, "utf8"), file);
  cache = { file, ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size, values };
  return values;
}

function parseSettings(text: string, file: string): StoredSettings["values"] {
  try {
    const parsed: unknown = JSON.parse(text);
    const values = parsed && typeof parsed === "object" && "values" in parsed ? (parsed as { values: unknown }).values : undefined;
    if (values && typeof values === "object" && !Array.isArray(values)) {
      // Unknown names and non-string values come only from hand edits; ignoring them keeps reads typed.
      return Object.fromEntries(Object.entries(values).filter(([name, value]) => settingDefinition(name) && typeof value === "string" && value.trim()).map(([name, value]) => [name, (value as string).trim()]));
    }
  } catch {
    // Reported below together with valid JSON of the wrong shape.
  }
  console.warn(`Ignoring ${file}: it is not a Beeblio settings file. Save in Settings to repair it.`);
  return {};
}

/** Moves a key saved by the first desktop release into settings.json, once. */
function migrateLegacyCredentials(): StoredSettings["values"] {
  let legacy: unknown;
  try {
    legacy = JSON.parse(readFileSync(legacyCredentialsFile(), "utf8"));
  } catch {
    return {};
  }
  const key = (legacy as { openRouterApiKey?: unknown } | null)?.openRouterApiKey;
  const values: StoredSettings["values"] = typeof key === "string" && key.trim() ? { OPENROUTER_API_KEY: key.trim() } : {};
  // Written directly: saveSettings reads the settings first, which would land back here.
  writeSettingsFile(values);
  rmSync(legacyCredentialsFile(), { force: true });
  return values;
}
