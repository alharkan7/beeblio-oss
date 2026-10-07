// Loaded into each local server with `node --import` (see local-servers.mjs)
// so a server never outlives whatever started it.
//
// A graceful quit stops the servers itself, but a crash, Force Quit, or
// kill -9 of the desktop app (or of `pnpm dev`) gives it no chance. The
// orphaned servers would then keep port 3210, and the next launch would fail.
// The launcher hands each server a stdin pipe it never writes to; the OS
// closes that pipe when the launcher dies, however it dies, and the server
// then stops its whole process tree.
import { spawnSync } from "node:child_process";

const FORCE_AFTER_MS = 3000;

// Only the server the launcher started arms the watchdog. Removing the flag
// keeps workers and agent commands, which inherit this module through
// execArgv and the environment, from reacting to a stdin that is not theirs.
if (process.env.BEEBLIO_PARENT_WATCHDOG === "1") {
  delete process.env.BEEBLIO_PARENT_WATCHDOG;
  process.stdin.on("data", () => {});
  process.stdin.once("end", stopTree);
  process.stdin.once("error", stopTree);
  // The pipe must not keep the server alive on its own, nor stop it from exiting normally.
  process.stdin.unref?.();
}

/**
 * Stops this server and everything it started. On macOS and Linux the server
 * leads its own process group, so a negative PID reaches the agent's shell
 * commands and the framework's workers too.
 */
function stopTree() {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  // A server that shuts down cleanly exits before the timer; members of its
  // group that ignored SIGTERM, such as a busy agent command, go with it.
  process.once("exit", () => signalGroup("SIGKILL"));
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), FORCE_AFTER_MS).unref();
}

function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch {
    // Not a group leader (started some other way): stop at least this process.
    process.kill(process.pid, signal);
  }
}
