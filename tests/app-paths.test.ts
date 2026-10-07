import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { appRoot, dataDir } from "../lib/app-paths.ts";

describe("app paths", () => {
  const saved = { data: process.env.BEEBLIO_DATA_DIR, root: process.env.BEEBLIO_APP_ROOT };

  afterEach(() => {
    for (const [key, value] of [["BEEBLIO_DATA_DIR", saved.data], ["BEEBLIO_APP_ROOT", saved.root]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a checkout keeps data in .beeblio/ and reads sources from the working directory", () => {
    delete process.env.BEEBLIO_DATA_DIR;
    delete process.env.BEEBLIO_APP_ROOT;
    assert.equal(dataDir(), path.join(process.cwd(), ".beeblio"));
    assert.equal(appRoot(), process.cwd());
  });

  test("the desktop app can point both elsewhere, as absolute paths", () => {
    process.env.BEEBLIO_DATA_DIR = "relative/data ";
    process.env.BEEBLIO_APP_ROOT = path.join(path.sep, "opt", "beeblio", "app");
    assert.equal(dataDir(), path.resolve("relative/data"));
    // path.resolve, not join: on Windows an absolute path without a drive gets the current one.
    assert.equal(appRoot(), path.resolve(path.sep, "opt", "beeblio", "app"));
  });
});
