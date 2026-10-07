import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dataDir } from "./app-paths";

/** Shared only by the two local server processes; never exposed to the browser. */
export function localAgentSecret(): string {
  const file = path.join(dataDir(), "agent-secret");
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(file, "utf8").trim();
}
