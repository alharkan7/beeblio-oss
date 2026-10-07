import path from "node:path";

/**
 * Where Beeblio keeps its files. A checkout keeps data in .beeblio/ and reads
 * its own sources from the working directory; the installed desktop app runs
 * from a read-only bundle, so it points these at the OS user-data folder and
 * at its resources instead. Resolved per call because the variables are set by
 * whoever starts the server, and tests change them. Only uses Node built-ins
 * so both the Next.js and the Eve bundles can import it.
 */

/** Writable folder for the database, settings, secrets, skills, and default workspaces. */
export function dataDir(): string {
  return path.resolve(process.env.BEEBLIO_DATA_DIR?.trim() || path.join(process.cwd(), ".beeblio"));
}

/** Read-only folder that holds agent/skills, agent/sandbox, and node_modules. */
export function appRoot(): string {
  return path.resolve(process.env.BEEBLIO_APP_ROOT?.trim() || process.cwd());
}
