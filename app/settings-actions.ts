"use server";

import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { appSetting, saveSettings as storeSettings, settingsSnapshot } from "@/lib/app-settings";
import { checkSystemTools, type SystemToolStatus } from "@/lib/system-tools";
import { isSettingName, settingDefinition, type SettingKind, type SettingName, type SettingsSnapshot } from "@/lib/app-settings-registry";

type SaveResult =
  | { success: true; snapshot: SettingsSnapshot; warnings: string[] }
  | { success: false; error: string; field?: SettingName };

/** OpenRouter answers within a second normally; this keeps a stalled proxy from freezing the dialog. */
const OPENROUTER_TIMEOUT_MS = 10_000;

const noSpaces = (what: string) => z.string().regex(/^\S+$/, `${what} cannot contain spaces.`);

/** Validation by kind, so every setting of a kind follows the same rules. */
const SCHEMAS: Record<SettingKind, z.ZodType<string>> = {
  secret: noSpaces("API keys").min(8, "That doesn't look like an API key.").max(500, "That doesn't look like an API key."),
  model: noSpaces("Model IDs").max(200, "That model ID is too long."),
  integer: z.string().regex(/^\d+$/, "Enter a whole number.").refine((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0, "Enter a whole number above zero."),
  email: z.email("Enter an email address."),
  // Only the origin is used, so a pasted URL with a path is reduced to it.
  url: z.url({ protocol: /^https$/, error: "Enter an https:// address." }).transform((value) => new URL(value).origin),
};

/** Everything the dialog shows; secrets only by their last four characters. */
export async function getSettings(): Promise<SettingsSnapshot> {
  await requireUser();
  return settingsSnapshot();
}

/** Which programs the agent uses are installed, checked with the agent's own shell and PATH. */
export async function getSystemTools(): Promise<SystemToolStatus[]> {
  await requireUser();
  return checkSystemTools();
}

/** Whether the agent can run: the labels of required settings that are still missing. */
export async function getSetupStatus(): Promise<{ missingRequired: string[] }> {
  await requireUser();
  return { missingRequired: settingsSnapshot().missingRequired };
}

/**
 * Validates and saves changed settings; a null or empty value removes the
 * saved one so the environment applies again. An OpenRouter key is checked
 * with OpenRouter first. A new main model is looked up there too, which
 * catches typos and fills in its context window when that is left empty.
 */
export async function saveSettings(input: unknown): Promise<SaveResult> {
  await requireUser();
  const parsed = parsePatch(input);
  if (!parsed.success) return parsed;
  const patch = parsed.patch;
  const warnings: string[] = [];

  const key = patch.OPENROUTER_API_KEY;
  if (key) {
    const problem = await checkOpenRouterKey(key);
    if (problem) return { success: false, error: problem, field: "OPENROUTER_API_KEY" };
  }

  const model = patch.OPENROUTER_MODEL_ID;
  if (model) {
    const lookup = await lookUpOpenRouterModel(model);
    if (lookup.kind === "missing") return { success: false, error: `OpenRouter has no model called "${model}". Copy the ID from openrouter.ai/models.`, field: "OPENROUTER_MODEL_ID" };
    if (lookup.kind === "unreachable") warnings.push(`Couldn't check the model with OpenRouter (${lookup.reason}), so it was saved as entered.`);
    const contextWindowGiven = "OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS" in patch;
    if (lookup.kind === "found" && lookup.contextLength && !contextWindowGiven) patch.OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS = String(lookup.contextLength);
    if (lookup.kind !== "found" && !contextWindowGiven && !appSetting("OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS")) warnings.push("Enter the model's context window, which could not be looked up.");
  }

  try {
    storeSettings(patch);
  } catch (error) {
    // A read-only checkout or a full disk; say so instead of failing opaquely.
    console.error("Could not update settings.json", error);
    const reason = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return { success: false, error: `Settings could not be written to the data folder (${reason}).` };
  }
  return { success: true, snapshot: settingsSnapshot(), warnings };
}

function parsePatch(input: unknown): { success: true; patch: Partial<Record<SettingName, string | null>> } | { success: false; error: string; field?: SettingName } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { success: false, error: "Nothing to save." };
  const patch: Partial<Record<SettingName, string | null>> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!isSettingName(name)) return { success: false, error: `Unknown setting ${name}.` };
    if (raw === null || (typeof raw === "string" && !raw.trim())) {
      patch[name] = null;
      continue;
    }
    const setting = settingDefinition(name)!;
    const result = SCHEMAS[setting.kind].safeParse(typeof raw === "string" ? raw.trim() : raw);
    if (!result.success) return { success: false, error: `${setting.label}: ${result.error.issues[0]?.message ?? "invalid value."}`, field: name };
    patch[name] = result.data;
  }
  return { success: true, patch };
}

/** Only a 401 means a bad key; any other failure may be a proxy or firewall, so show what it said. */
async function checkOpenRouterKey(key: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS) });
  } catch {
    return "Couldn't reach OpenRouter to check the key. Check your connection and try again.";
  }
  if (response.status === 401) return "OpenRouter rejected this key.";
  if (!response.ok) return `Couldn't check the key with OpenRouter (HTTP ${response.status}): ${await failureDetail(response)}`;
  return undefined;
}

type ModelLookup = { kind: "found"; contextLength?: number } | { kind: "missing" } | { kind: "unreachable"; reason: string };

/** The public model list needs no key, so a model can be checked before a key is saved. */
async function lookUpOpenRouterModel(id: string): Promise<ModelLookup> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS) });
    if (!response.ok) return { kind: "unreachable", reason: `HTTP ${response.status}` };
    const { data } = (await response.json()) as { data?: Array<{ id?: unknown; context_length?: unknown }> };
    const model = data?.find((candidate) => candidate.id === id);
    if (!model) return Array.isArray(data) ? { kind: "missing" } : { kind: "unreachable", reason: "unexpected response" };
    return { kind: "found", contextLength: typeof model.context_length === "number" && model.context_length > 0 ? model.context_length : undefined };
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error && error.name === "TimeoutError" ? "timed out" : "no connection" };
  }
}

/** A short, human-readable reason from an error response, whether OpenRouter's JSON or a proxy's page. */
async function failureDetail(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string" && message) return message.slice(0, 200);
  } catch {
    // Not JSON: a proxy's plain-text page.
  }
  return text.slice(0, 200) || response.statusText || "no details";
}
