import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { checkSystemTools, SYSTEM_TOOLS, type SystemTool } from "../lib/system-tools.ts";

const posixOnly = process.platform === "win32" && "uses sh scripts as stand-in tools";

describe("system tools", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "beeblio-tools-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const executable = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  // The checks' own helpers; real tools such as ffmpeg stay off this PATH.
  if (!posixOnly) for (const helper of ["/bin/sh", "/usr/bin/head"]) symlinkSync(helper, path.join(dir, path.basename(helper)));
  // Runs the check like `bash -lc` would, but without a login profile that could reset PATH.
  const shell = executable("fake-shell", 'shift; exec /bin/sh -c "$1"');
  const tool = (id: string, check: string, binary = id): SystemTool => ({ id, label: id, purpose: `for ${id}`, binary, check, hints: { darwin: { text: "brew", command: `brew install ${id}` }, default: { text: "download", href: "https://example.org" } } });

  test("reports found tools with their version and missing ones with the platform's install hint", { skip: posixOnly }, async () => {
    executable("pandoc", 'echo "pandoc 9.9"; echo "more lines"');
    // A pipeline succeeds when its last command does, so a missing tool behind "| head" must still count as missing.
    const results = await checkSystemTools({ shell, env: { PATH: dir }, platform: "darwin", tools: [tool("pandoc", "pandoc --version | head -n 1"), tool("ffmpeg", "ffmpeg -version 2>&1 | head -n 1")] });
    assert.deepEqual(results, [
      { id: "pandoc", label: "pandoc", purpose: "for pandoc", found: true, detail: "pandoc 9.9" },
      { id: "ffmpeg", label: "ffmpeg", purpose: "for ffmpeg", found: false, hint: { text: "brew", command: "brew install ffmpeg" } },
    ]);
  });

  test("falls back to the general hint on other platforms", { skip: posixOnly }, async () => {
    const [result] = await checkSystemTools({ shell, env: { PATH: dir }, platform: "linux", tools: [tool("ffmpeg", "ffmpeg -version")] });
    assert.deepEqual(result.hint, { text: "download", href: "https://example.org" });
  });

  test("Windows' Microsoft Store placeholder does not count as Python", { skip: posixOnly }, async () => {
    const [result] = await checkSystemTools({ shell, env: { PATH: dir }, platform: "darwin", tools: [tool("python3", "echo 'C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps\\\\python3.exe'", "sh")] });
    assert.equal(result.found, false);
  });

  test("without Git Bash on Windows nothing is reported as found", async () => {
    const results = await checkSystemTools({ shell, env: { PATH: dir }, platform: "win32" });
    assert.equal(results.length, SYSTEM_TOOLS.length);
    assert.ok(results.every((result) => !result.found));
    assert.match(results.find((result) => result.id === "shell")!.hint!.href!, /git-scm/);
  });

  test("every tool has an install hint for every platform", () => {
    for (const entry of SYSTEM_TOOLS) assert.ok(entry.hints.default.text, entry.id);
  });
});
