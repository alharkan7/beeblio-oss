import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Windows reports these while antivirus or an indexer briefly holds the target open. */
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;

/**
 * Writes through a uniquely named temporary file and renames it into place, so
 * the other server process never reads a half-written file and two concurrent
 * saves cannot clobber each other's temporary file. Mode 600 keeps keys private.
 */
export function writeAtomically(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameWithRetry(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= RENAME_ATTEMPTS || !code || !TRANSIENT_RENAME_ERRORS.has(code)) throw error;
      // Synchronous on purpose: callers rely on the file being in place when this returns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}
