import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { onboardingState, recordOnboarding } from "../lib/onboarding.ts";

describe("onboarding state", () => {
  const originalDataDir = process.env.BEEBLIO_DATA_DIR;
  let dir: string;
  const file = () => path.join(dir, "onboarding.json");

  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), "beeblio-onboarding-")), "data");
    process.env.BEEBLIO_DATA_DIR = dir;
  });

  afterEach(() => {
    rmSync(path.dirname(dir), { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.BEEBLIO_DATA_DIR;
    else process.env.BEEBLIO_DATA_DIR = originalDataDir;
  });

  test("starts with nothing seen, and creates the data folder on the first record", () => {
    assert.deepEqual(onboardingState(), {});
    recordOnboarding("welcome", "skipped");
    assert.ok(existsSync(file()));
    assert.equal(onboardingState().welcome?.outcome, "skipped");
    assert.equal(onboardingState().tour, undefined);
  });

  test("keeps each part separately, and a later record replaces the earlier one", () => {
    recordOnboarding("welcome", "done");
    recordOnboarding("tour", "skipped");
    recordOnboarding("tour", "done");
    assert.equal(onboardingState().welcome?.outcome, "done");
    assert.equal(onboardingState().tour?.outcome, "done");
  });

  test("treats a damaged file as nothing seen, and the next record repairs it", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(), "{ not json");
    assert.deepEqual(onboardingState(), {});

    writeFileSync(file(), JSON.stringify({ welcome: { outcome: "maybe", at: "x" }, tour: "done" }));
    assert.deepEqual(onboardingState(), {});

    recordOnboarding("tour", "done");
    assert.equal(onboardingState().tour?.outcome, "done");
  });
});
