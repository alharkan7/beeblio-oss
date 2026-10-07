// Applies the SQLite migrations in drizzle/ with drizzle-orm's migrator.
// Used instead of the drizzle-kit CLI because that is a development tool and
// is not shipped in the desktop app; both record applied migrations in the
// same __drizzle_migrations table, so databases move freely between the two.
// It runs as its own process so callers such as Electron's main process never
// load better-sqlite3, whose native binary is built for Node.js.
//
// Usage: node scripts/migrate.mjs <database file> <migrations folder>
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const [databasePath, migrationsFolder] = process.argv.slice(2);
if (!databasePath || !migrationsFolder) {
  console.error("Usage: node migrate.mjs <database file> <migrations folder>");
  process.exit(2);
}

mkdirSync(path.dirname(databasePath), { recursive: true });
const client = new Database(databasePath);
try {
  // Matches db/index.ts, so the servers open the file in the mode it was left in.
  client.pragma("journal_mode = WAL");
  client.pragma("busy_timeout = 5000");
  migrate(drizzle(client), { migrationsFolder });
} finally {
  client.close();
}
