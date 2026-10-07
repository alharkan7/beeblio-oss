import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  describeCheckFailure,
  effectiveUpdateMode,
  releasePageUrl,
  startUpdates,
  type UpdateMode,
  type Updater,
} from "../desktop/src/updates.ts";

/** Stands in for electron-updater: records calls and lets a test fire its events. */
function fakeUpdater() {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    checks: 0,
    installs: [] as Array<[boolean | undefined, boolean | undefined]>,
    onCheck: undefined as (() => void) | undefined,
    async checkForUpdates() {
      updater.checks++;
      updater.onCheck?.();
      return null;
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
      updater.installs.push([isSilent, isForceRunAfter]);
    },
    on(event: string, listener: (arg?: never) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as (arg?: unknown) => void]);
      return updater;
    },
    emit(event: string, arg?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(arg);
    },
  };
  return updater;
}

function setup(mode: UpdateMode, answers: number[] = []) {
  const updater = fakeUpdater();
  const asked: Array<{ message: string; buttons: string[] }> = [];
  const opened: string[] = [];
  const timers: Array<[string, number]> = [];
  const events: string[] = [];
  const updates = startUpdates({
    mode,
    updater: updater as unknown as Updater,
    currentVersion: "0.1.0",
    releaseRepo: "owner/repo",
    ask: async (options) => {
      asked.push(options);
      return answers.shift() ?? 1;
    },
    openExternal: (url) => opened.push(url),
    log: () => {},
    prepareToInstall: async () => { events.push("servers stopped"); },
    setTimeout: (_callback, ms) => timers.push(["once", ms]),
    setInterval: (_callback, ms) => timers.push(["every", ms]),
  });
  return { updater, updates, asked, opened, timers, events };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("desktop updates", () => {
  test("only packaged macOS and Windows builds update, in the mode they were built with", () => {
    assert.equal(effectiveUpdateMode("install", { packaged: true, platform: "win32" }), "install");
    assert.equal(effectiveUpdateMode("notify", { packaged: true, platform: "darwin" }), "notify");
    assert.equal(effectiveUpdateMode("install", { packaged: false, platform: "darwin" }), "off");
    assert.equal(effectiveUpdateMode("install", { packaged: true, platform: "linux" }), "off");
    assert.equal(effectiveUpdateMode(undefined, { packaged: true, platform: "win32" }), "off");
  });

  test("install mode downloads in the background; notify mode only checks", () => {
    assert.equal(setup("install").updater.autoDownload, true);
    const notify = setup("notify").updater;
    assert.equal(notify.autoDownload, false);
    assert.equal(notify.autoInstallOnAppQuit, false);
    assert.equal(notify.allowPrerelease, false);
  });

  test("checks start after a delay and repeat; nothing is scheduled when off", () => {
    const on = setup("install");
    on.updates.schedule();
    assert.deepEqual(on.timers, [["once", FIRST_CHECK_DELAY_MS], ["every", CHECK_INTERVAL_MS]]);
    const off = setup("off");
    off.updates.schedule();
    assert.deepEqual(off.timers, []);
  });

  test("notify mode offers each version once and links to its release page", async () => {
    const { updater, asked, opened } = setup("notify", [0]);
    updater.emit("update-available", { version: "0.2.0" });
    updater.emit("update-available", { version: "0.2.0" });
    await settle();
    assert.equal(asked.length, 1);
    assert.match(asked[0].message, /0\.2\.0 is available/);
    assert.deepEqual(opened, [releasePageUrl("owner/repo", "0.2.0")]);
    assert.equal(opened[0], "https://github.com/owner/repo/releases/tag/v0.2.0");
  });

  test("restarting stops the servers before the installer runs", async () => {
    const { updater, events } = setup("install", [0]);
    updater.emit("update-downloaded", { version: "0.2.0" });
    await settle();
    await settle();
    assert.deepEqual(events, ["servers stopped"]);
    assert.deepEqual(updater.installs, [[false, true]]);
  });

  test("Later leaves the update for the next quit", async () => {
    const { updater } = setup("install", [1]);
    updater.emit("update-downloaded", { version: "0.2.0" });
    await settle();
    assert.deepEqual(updater.installs, []);
    assert.equal(updater.autoInstallOnAppQuit, true);
  });

  test("a failed background check stays silent", async () => {
    const { updater, asked } = setup("install");
    updater.emit("error", new Error("HttpError: 404"));
    await settle();
    assert.equal(asked.length, 0);
  });

  test("a manual check reports its result, including failures", async () => {
    const latest = setup("install");
    latest.updater.onCheck = () => latest.updater.emit("update-not-available");
    await latest.updates.checkNow();
    assert.equal(latest.asked.at(-1)?.message, "Updates");

    const failing = setup("install");
    failing.updater.onCheck = () => failing.updater.emit("error", new Error("HttpError: 404 Not Found"));
    await failing.updates.checkNow();
    assert.equal(failing.asked.at(-1)?.message, "Update check failed");
  });

  test("a manual check asks again about a version already offered", async () => {
    const { updater, updates, asked } = setup("notify");
    updater.emit("update-available", { version: "0.2.0" });
    updater.onCheck = () => updater.emit("update-available", { version: "0.2.0" });
    await updates.checkNow();
    await settle();
    assert.equal(asked.length, 2);
  });

  test("a manual check after a download offers the restart again", async () => {
    const { updater, updates, asked } = setup("install");
    updater.emit("update-downloaded", { version: "0.2.0" });
    await settle();
    await updates.checkNow();
    assert.equal(asked.length, 2);
    assert.match(asked[1].message, /ready to install/);
    assert.equal(updater.checks, 0);
  });

  test("failure reasons are short and readable", () => {
    assert.match(describeCheckFailure(new Error("HttpError: 404 \n long body")), /private repository/);
    assert.match(describeCheckFailure(new Error("getaddrinfo ENOTFOUND api.github.com")), /internet connection/);
    assert.equal(describeCheckFailure(new Error("first line\nsecond")), "first line");
  });
});
