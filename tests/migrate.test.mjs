import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import Database from "better-sqlite3";

const repo = path.resolve(import.meta.dirname, "..");
const migrateScript = path.join(repo, "scripts", "migrate.mjs");
const migrations = path.join(repo, "drizzle");

describe("scripts/migrate.mjs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "beeblio-migrate-"));
  const database = path.join(dir, "nested", "beeblio.sqlite");
  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => execFileSync(process.execPath, [migrateScript, database, migrations], { stdio: "pipe" });
  const appliedMigrations = () => {
    const client = new Database(database, { readonly: true });
    try {
      return client.prepare("select count(*) as count from __drizzle_migrations").get().count;
    } finally {
      client.close();
    }
  };

  test("creates the database, including missing folders, and applies every migration", () => {
    run();
    const client = new Database(database, { readonly: true });
    try {
      const tables = client.prepare("select name from sqlite_master where type = 'table'").all().map(({ name }) => name);
      assert.ok(tables.includes("projects"), `tables: ${tables.join(", ")}`);
    } finally {
      client.close();
    }
    assert.ok(appliedMigrations() > 0);
  });

  test("is safe to run on every launch", () => {
    const before = appliedMigrations();
    run();
    assert.equal(appliedMigrations(), before);
  });

  test("explains its arguments when they are missing", () => {
    assert.throws(() => execFileSync(process.execPath, [migrateScript], { stdio: "pipe" }), (error) => error.status === 2 && /Usage/.test(String(error.stderr)));
  });
});
