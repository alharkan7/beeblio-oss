import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { dataDir } from "../lib/app-paths";

import * as schema from "./schema";

const databasePath = path.resolve(process.env.LOCAL_DB_PATH || path.join(dataDir(), "beeblio.sqlite"));
mkdirSync(path.dirname(databasePath), { recursive: true });
const client = new Database(databasePath, { timeout: 5000 });
enableWal(client);
client.pragma("foreign_keys = ON");

/**
 * Switches the database to WAL once; the mode is stored in the file, so later
 * opens find it set and take no lock. The switch needs an exclusive lock, and
 * when several processes open a new database at once (the build's page-data
 * workers, or the UI and agent servers) SQLite reports SQLITE_BUSY at once
 * rather than waiting out the busy timeout, so it is retried here.
 */
function enableWal(connection: Database.Database): void {
  for (let attempt = 1; connection.pragma("journal_mode", { simple: true }) !== "wal"; attempt++) {
    try {
      connection.pragma("journal_mode = WAL");
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY" || attempt >= 50) throw error;
      // A synchronous pause: this runs while the module loads, before anything can await.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.random() * 80);
    }
  }
}

export const db = drizzle(client, { schema });

export { schema };
