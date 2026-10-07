import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { agentEnvironment } from "../lib/agent-environment.ts";

describe("agent environment", () => {
  test("on Windows the python3 shim comes first, in the existing Path entry", () => {
    const env = agentEnvironment({ env: { Path: "C:\\Windows;C:\\Python312" }, platform: "win32", root: "C:\\Beeblio\\app", nodeDir: "C:\\Beeblio\\node" });
    assert.equal(env.Path, "C:\\Beeblio\\app\\agent\\sandbox\\shims\\win32;C:\\Windows;C:\\Python312;C:\\Beeblio\\node");
    assert.equal("PATH" in env, false, "a second PATH entry would make the child's PATH unpredictable");
  });

  test("on macOS LibreOffice is added when installed, and the bundled Node.js never overrides the person's", () => {
    const env = agentEnvironment({ env: { PATH: "/opt/homebrew/bin:/usr/bin" }, platform: "darwin", root: "/app", nodeDir: "/app/node", exists: () => true });
    assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/Applications/LibreOffice.app/Contents/MacOS:/app/node");
    const withoutLibreOffice = agentEnvironment({ env: { PATH: "/usr/bin" }, platform: "darwin", root: "/app", nodeDir: "/usr/bin", exists: () => false });
    assert.equal(withoutLibreOffice.PATH, "/usr/bin");
  });

  test("points skills and the Python helpers at the app's files, keeping the person's own paths", () => {
    const env = agentEnvironment({ env: { PATH: "/usr/bin", PYTHONPATH: "/mine" }, platform: "linux", root: "/app", nodeDir: "/usr/bin" });
    assert.equal(env.BEEBLIO_SKILLS_DIR, "/app/agent/skills");
    assert.equal(env.PYTHONPATH, "/app/agent/sandbox:/mine");
    assert.equal(env.NODE_PATH, "/app/node_modules");
  });
});

describe("Windows python3 shim", { skip: process.platform === "win32" && "run under sh, as Git Bash does" }, () => {
  const shim = path.join(import.meta.dirname, "..", "agent", "sandbox", "shims", "win32", "python3");

  /** Runs the shim with only the given fake interpreters on PATH. */
  function runShim(interpreters: Record<string, string>) {
    const root = mkdtempSync(path.join(tmpdir(), "beeblio-shim-"));
    try {
      const dirs: string[] = [];
      for (const [location, name] of Object.entries(interpreters)) {
        const dir = path.join(root, location);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${location}/${name} $*"\n`);
        chmodSync(path.join(dir, name), 0o755);
        dirs.push(dir);
      }
      // Only the fakes: the shim needs nothing but shell builtins, and a real python on the machine would hide the case under test.
      return spawnSync("/bin/sh", [shim, "-c", "print(1)"], { env: { ...process.env, PATH: dirs.join(":") }, encoding: "utf8" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("forwards to python with the same arguments", () => {
    assert.equal(runShim({ Python312: "python" }).stdout.trim(), "Python312/python -c print(1)");
  });

  test("skips the Microsoft Store placeholder and uses the py launcher", () => {
    assert.equal(runShim({ WindowsApps: "python", launcher: "py" }).stdout.trim(), "launcher/py -3 -c print(1)");
  });

  test("explains how to install Python when there is none", () => {
    const result = runShim({});
    assert.equal(result.status, 127);
    assert.match(result.stderr, /python\.org/);
  });
});
