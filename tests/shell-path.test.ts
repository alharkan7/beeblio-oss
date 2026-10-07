import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { extractMarkedPath, loginShellPath } from "../desktop/src/shell-path.ts";
import { mergePaths } from "../lib/path-list.ts";

const posixOnly = process.platform === "win32" && "login shells are a macOS concern";

describe("login shell PATH", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "beeblio-shell-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in for the user's shell: it runs the script it is given (`-ilc <script>`) after `setup`. */
  function fakeShell(name: string, setup: string) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${setup}\neval "$2"\n`);
    chmodSync(file, 0o755);
    return file;
  }

  test("only the marked text counts, whatever the profile prints around it", () => {
    const output = "Welcome!\n__BEEBLIO_PATH_START__/a:/b\n__BEEBLIO_PATH_END__prompt> ";
    assert.equal(extractMarkedPath(output), "/a:/b");
    assert.equal(extractMarkedPath("no markers here"), undefined);
    assert.equal(extractMarkedPath("__BEEBLIO_PATH_START__/a"), undefined);
  });

  test("merging keeps the first occurrence and drops empty entries", () => {
    assert.equal(mergePaths(["/a::/b", "/b:/c", undefined], ":"), "/a:/b:/c");
    assert.equal(mergePaths(["C:\\a;C:\\b", "C:\\a"], ";"), "C:\\a;C:\\b");
  });

  test("uses the PATH the user's profile sets, ahead of the minimal one", { skip: posixOnly }, async () => {
    const shell = fakeShell("profile-shell", 'echo "Last login: today"\nPATH="/custom/bin:$PATH"; export PATH');
    const result = await loginShellPath({ shell, currentPath: "/usr/bin:/bin" });
    assert.equal(result.split(":")[0], "/custom/bin");
    assert.ok(result.split(":").includes("/usr/bin"));
  });

  test("falls back to the usual tool folders when the shell hangs", { skip: posixOnly }, async () => {
    const shell = fakeShell("slow-shell", "sleep 10");
    const started = Date.now();
    const result = await loginShellPath({ shell, currentPath: "/usr/bin:/bin", timeoutMs: 200 });
    assert.ok(Date.now() - started < 5000);
    assert.equal(result, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  });
});
