import { startLocalServers } from "./local-servers.mjs";

let servers;
servers = await startLocalServers({
  root: process.cwd(),
  onExit(_name, code, error) {
    if (error) console.error(error);
    else console.error(`Local server exited (${code})`);
    process.exitCode = typeof code === "number" && code !== 0 ? code : 1;
    void servers?.stop();
  },
});
for (const warning of servers.warnings) console.warn(warning);
// SIGHUP too: the servers run in their own process groups, so a closed terminal no longer reaches them directly.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void servers.stop());
