import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { appSetting, integerSetting, openRouterApiKey, saveSettings, settingsSnapshot } from "../lib/app-settings.ts";

const SAVED_KEY = "sk-or-v1-saved-key-0000000000abcd";
const ENV_KEY = "sk-or-v1-env-key-00000000000wxyz";
const MANAGED_ENV = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL_ID", "OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS", "OPENROUTER_REQUEST_TIMEOUT_MS", "BEEBLIO_DATA_DIR"] as const;

describe("app settings", () => {
  const originalEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  let dir: string;

  const file = () => path.join(dir, "settings.json");
  const writeRaw = (contents: string, name = "settings.json") => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), contents);
  };

  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), "beeblio-settings-")), "data");
    for (const name of MANAGED_ENV) delete process.env[name];
    process.env.BEEBLIO_DATA_DIR = dir;
  });

  afterEach(() => {
    rmSync(path.dirname(dir), { recursive: true, force: true });
    for (const name of MANAGED_ENV) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  test("reports what is missing when nothing is configured", () => {
    assert.equal(openRouterApiKey(), undefined);
    const { settings, missingRequired } = settingsSnapshot();
    assert.deepEqual(settings.OPENROUTER_API_KEY, { source: null });
    assert.deepEqual(missingRequired, ["Main model", "Context window (tokens)", "OpenRouter"]);
  });

  test("falls back to the environment, trimmed", () => {
    process.env.OPENROUTER_API_KEY = `  ${ENV_KEY}\n`;
    process.env.OPENROUTER_MODEL_ID = "provider/model ";
    assert.equal(openRouterApiKey(), ENV_KEY);
    const { settings } = settingsSnapshot();
    assert.deepEqual(settings.OPENROUTER_API_KEY, { source: "env", last4: "wxyz" });
    assert.deepEqual(settings.OPENROUTER_MODEL_ID, { source: "env", value: "provider/model" });
  });

  test("saved values override the environment and apply immediately", () => {
    process.env.OPENROUTER_API_KEY = ENV_KEY;
    saveSettings({ OPENROUTER_API_KEY: SAVED_KEY, OPENROUTER_MODEL_ID: "provider/saved" });
    assert.equal(openRouterApiKey(), SAVED_KEY);
    assert.equal(appSetting("OPENROUTER_MODEL_ID"), "provider/saved");
  });

  test("the snapshot never contains a secret, only its last four characters", () => {
    saveSettings({ OPENROUTER_API_KEY: SAVED_KEY });
    const snapshot = settingsSnapshot();
    assert.deepEqual(snapshot.settings.OPENROUTER_API_KEY, { source: "settings", last4: "abcd" });
    assert.ok(!JSON.stringify(snapshot).includes(SAVED_KEY));
  });

  test("removing a value restores the environment's and keeps the others", () => {
    process.env.OPENROUTER_API_KEY = ENV_KEY;
    saveSettings({ OPENROUTER_API_KEY: SAVED_KEY, OPENROUTER_MODEL_ID: "provider/kept" });
    saveSettings({ OPENROUTER_API_KEY: null });
    assert.equal(openRouterApiKey(), ENV_KEY);
    assert.equal(appSetting("OPENROUTER_MODEL_ID"), "provider/kept");
  });

  test("the file is private to the user and no temporary files are left behind", { skip: process.platform === "win32" && "POSIX modes only" }, () => {
    saveSettings({ OPENROUTER_API_KEY: SAVED_KEY });
    assert.equal(statSync(file()).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  });

  test("sees a save made by the other server process, even when the size is unchanged", () => {
    saveSettings({ OPENROUTER_MODEL_ID: "provider/aaaa" });
    assert.equal(appSetting("OPENROUTER_MODEL_ID"), "provider/aaaa");
    // What the other process's saveSettings does: write a new file and rename it into place.
    const replacement = path.join(dir, "replacement.tmp");
    writeFileSync(replacement, readFileSync(file(), "utf8").replace("provider/aaaa", "provider/bbbb"));
    renameSync(replacement, file());
    assert.equal(appSetting("OPENROUTER_MODEL_ID"), "provider/bbbb");
  });

  for (const [name, contents] of [["malformed JSON", "{ not json"], ["a JSON array", "[]"]] as const) {
    test(`a file containing ${name} is ignored rather than breaking model calls, and saving repairs it`, (t) => {
      const warn = t.mock.method(console, "warn", () => {});
      process.env.OPENROUTER_API_KEY = ENV_KEY;
      writeRaw(contents);
      assert.equal(openRouterApiKey(), ENV_KEY);
      assert.equal(warn.mock.callCount(), 1);
      saveSettings({ OPENROUTER_API_KEY: SAVED_KEY });
      assert.equal(openRouterApiKey(), SAVED_KEY);
    });
  }

  test("hand-edited entries that are unknown or not strings are ignored", () => {
    writeRaw(JSON.stringify({ version: 1, values: { NOT_A_SETTING: "x", OPENROUTER_MODEL_ID: 42, OPENROUTER_API_KEY: ` ${SAVED_KEY} ` } }));
    assert.equal(appSetting("OPENROUTER_MODEL_ID"), undefined);
    assert.equal(openRouterApiKey(), SAVED_KEY);
  });

  test("moves the key saved by the first desktop release into settings.json", () => {
    writeRaw(JSON.stringify({ openRouterApiKey: SAVED_KEY }), "credentials.json");
    assert.equal(openRouterApiKey(), SAVED_KEY);
    assert.equal(existsSync(path.join(dir, "credentials.json")), false);
    assert.equal(JSON.parse(readFileSync(file(), "utf8")).values.OPENROUTER_API_KEY, SAVED_KEY);
  });

  test("integer settings fall back when unset and reject anything but whole numbers", () => {
    assert.equal(integerSetting("OPENROUTER_REQUEST_TIMEOUT_MS", 5, 1), 5);
    saveSettings({ OPENROUTER_REQUEST_TIMEOUT_MS: "250" });
    assert.equal(integerSetting("OPENROUTER_REQUEST_TIMEOUT_MS", 5, 1), 250);
    saveSettings({ OPENROUTER_REQUEST_TIMEOUT_MS: "2.5" });
    assert.throws(() => integerSetting("OPENROUTER_REQUEST_TIMEOUT_MS", 5, 1), /Request timeout \(ms\) must be a whole number/);
  });
});
