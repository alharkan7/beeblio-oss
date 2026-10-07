import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { startLocalServers, terminate } from "../scripts/local-servers.mjs";

/** Frees a port for the test servers by letting the OS pick one. */
async function freePort() {
  const { createServer } = await import("node:net");
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A stand-in for the desktop app's staged servers: each script records the
 * working directory and environment it was given, and the UI answers the
 * health check the launcher waits for.
 */
function writeFakeBundle(root, reportDir) {
  // The real watchdog: the bundle layout loads it from the bundle's root.
  writeFileSync(path.join(root, "parent-watchdog.mjs"), readFileSync(path.join(import.meta.dirname, "..", "scripts", "parent-watchdog.mjs")));
  const report = (name) => `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(path.join(reportDir, `${name}.json`))}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2), env: process.env }));`;
  const serve = (name, body) => `${report(name)}\nprocess.getBuiltinModule("node:http").createServer((req, res) => res.end(${JSON.stringify(body)})).listen(Number(process.env.PORT), process.env.HOSTNAME || process.env.HOST);`;
  for (const dir of ["ui", "agent/server", "drizzle"]) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, "ui", "migrate.mjs"), report("migrate"));
  writeFileSync(path.join(root, "ui", "server.js"), serve("next", "ok"));
  // Stands in for the agent running a long shell command.
  const agentCommand = `const command = process.getBuiltinModule("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });\nprocess.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(path.join(reportDir, "command.pid"))}, String(command.pid));\n`;
  writeFileSync(path.join(root, "agent", "server", "index.mjs"), (process.platform === "win32" ? "" : agentCommand) + serve("eve", "ok"));
}

const posixOnly = process.platform === "win32" && "process groups are POSIX-only; Windows uses taskkill /T";

/** Spawns a Node script as its own process group, the way the launcher starts servers. */
function spawnServerLike(source) {
  return spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
}

/** Reads the first line the child prints, which these fixtures use to report a PID or readiness. */
async function firstLine(child) {
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes("\n")) return output.split("\n")[0];
  }
  throw new Error("The child exited before printing a line");
}

/** True while the process runs; a killed orphan can linger as a zombie if PID 1 does not reap it, so Linux checks its state too. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return true;
  }
}

describe("terminate", () => {
  test("stops processes the server started, not just the server", { skip: posixOnly }, async () => {
    // Stands in for the agent server running a long shell command.
    const child = spawnServerLike(`
      const shell = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
      console.log(shell.pid);
      setInterval(() => {}, 1000);
    `);
    const grandchildPid = Number(await firstLine(child));
    assert.ok(isAlive(grandchildPid));

    await terminate(child);

    // Delivery of the group signal is asynchronous; give the kernel a moment.
    for (let i = 0; i < 20 && isAlive(grandchildPid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isAlive(grandchildPid), false);
  });

  test("force-kills a server that ignores SIGTERM", { skip: posixOnly, timeout: 15_000 }, async () => {
    const child = spawnServerLike(`
      process.on("SIGTERM", () => {});
      console.log("ready");
      setInterval(() => {}, 1000);
    `);
    await firstLine(child);
    const started = Date.now();

    await terminate(child);

    assert.equal(child.signalCode, "SIGKILL");
    assert.ok(Date.now() - started >= 4_000, "the server first gets time to shut down cleanly");
  });

  test("still stops a child that does not lead its own process group", async () => {
    const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "inherit"] });
    await firstLine(child);
    await terminate(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  });

  test("resolves at once for a process that already exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    await terminate(child);
  });
});

describe("startLocalServers", () => {
  test("servers stop on their own when whatever started them is killed", { skip: posixOnly, timeout: 30_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "beeblio-orphans-"));
    const reports = path.join(root, "reports");
    mkdirSync(reports);
    writeFakeBundle(root, reports);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const [uiPort, agentPort] = [await freePort(), await freePort()];
    // A launcher in its own process, like the desktop app, so the test can kill it without warning.
    const launcherSource = `
      import { startLocalServers } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "local-servers.mjs")).href)};
      const servers = await startLocalServers({ root: ${JSON.stringify(root)}, layout: "bundle", uiPort: ${uiPort}, agentPort: ${agentPort}, dataDir: ${JSON.stringify(path.join(root, "data"))}, onOutput: () => {} });
      await servers.waitUntilReady({ timeoutMs: 15000 });
      console.log("ready");
    `;
    const launcher = spawn(process.execPath, ["--input-type=module", "-e", launcherSource], { stdio: ["ignore", "pipe", "inherit"] });
    await firstLine(launcher);
    const read = (name) => JSON.parse(readFileSync(path.join(reports, `${name}.json`), "utf8"));
    const pids = [read("next").pid, read("eve").pid, Number(readFileSync(path.join(reports, "command.pid"), "utf8"))];
    assert.ok(pids.every(isAlive));

    launcher.kill("SIGKILL");

    // Generous: the watchdog escalates to SIGKILL after 3 s, and a loaded machine can be slow to deliver signals.
    for (let i = 0; i < 300 && pids.some(isAlive); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(pids.filter(isAlive), [], "processes left behind");
  });

  test("runs the desktop app's staged servers with their state in the data folder", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "beeblio-bundle-"));
    const dataDir = path.join(root, "user-data");
    const reports = path.join(root, "reports");
    mkdirSync(reports);
    writeFakeBundle(root, reports);
    const [uiPort, agentPort] = [await freePort(), await freePort()];

    const servers = await startLocalServers({ root, layout: "bundle", uiPort, agentPort, dataDir, extraEnv: { BEEBLIO_TEST: "1" }, onOutput: () => {} });
    // One hook, in this order: Windows cannot delete a folder that running servers
    // use as their working directory, and a throwing hook would skip the stop.
    t.after(async () => {
      await servers.stop();
      rmSync(root, { recursive: true, force: true });
    });
    await servers.waitUntilReady({ timeoutMs: 15_000 });

    const read = (name) => JSON.parse(readFileSync(path.join(reports, `${name}.json`), "utf8"));
    const [migrate, ui, agent] = [read("migrate"), read("next"), read("eve")];
    assert.deepEqual(migrate.argv, [path.join(dataDir, "beeblio.sqlite"), path.join(root, "drizzle")]);
    // Eve keeps workflow state under its working directory, which must be writable.
    // .native expands Windows 8.3 short names (C:\\Users\\RUNNER~1), which a server's cwd may use.
    assert.equal(realpathSync.native(agent.cwd), realpathSync.native(dataDir));
    for (const server of [ui, agent]) {
      assert.equal(server.env.BEEBLIO_DATA_DIR, dataDir);
      assert.equal(server.env.BEEBLIO_APP_ROOT, path.join(root, "app"));
      assert.equal(server.env.AGENT_URL, `http://127.0.0.1:${agentPort}`);
      assert.equal(server.env.BEEBLIO_TEST, "1");
    }
    assert.equal(ui.env.PORT, String(uiPort));
    assert.equal(agent.env.PORT, String(agentPort));
  });

  test("explains how to fix a checkout without installed dependencies", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "beeblio-empty-checkout-"));
    try {
      await assert.rejects(startLocalServers({ root, onOutput: () => {} }), /Run pnpm install/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
