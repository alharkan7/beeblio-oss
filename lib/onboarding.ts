import { readFileSync } from "node:fs";
import path from "node:path";

import { dataDir } from "./app-paths";
import { writeAtomically } from "./atomic-write";

/**
 * Whether the person has been through the first-run walkthrough: the welcome
 * on the projects page and the tour of a project's workspace. Kept in the data
 * folder rather than browser storage, which the desktop app loses with its
 * cache and a browser can refuse, and either would bring the welcome back on
 * every launch.
 */

export type OnboardingPart = "welcome" | "tour";
/** Skipped counts as seen; the walkthrough never comes back by itself. */
export type OnboardingOutcome = "done" | "skipped";
export type OnboardingState = Partial<Record<OnboardingPart, { outcome: OnboardingOutcome; at: string }>>;

const PARTS: readonly OnboardingPart[] = ["welcome", "tour"];
const OUTCOMES: readonly OnboardingOutcome[] = ["done", "skipped"];

const onboardingFile = () => path.join(dataDir(), "onboarding.json");

/** A missing or damaged file means nothing has been seen yet; the next record rewrites it. */
export function onboardingState(): OnboardingState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(onboardingFile(), "utf8"));
  } catch {
    return {};
  }
  const state: OnboardingState = {};
  if (!parsed || typeof parsed !== "object") return state;
  for (const part of PARTS) {
    const entry = (parsed as Record<string, unknown>)[part] as { outcome?: unknown; at?: unknown } | undefined;
    if (entry && OUTCOMES.includes(entry.outcome as OnboardingOutcome) && typeof entry.at === "string") {
      state[part] = { outcome: entry.outcome as OnboardingOutcome, at: entry.at };
    }
  }
  return state;
}

export function recordOnboarding(part: OnboardingPart, outcome: OnboardingOutcome): OnboardingState {
  const state = { ...onboardingState(), [part]: { outcome, at: new Date().toISOString() } };
  writeAtomically(onboardingFile(), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function isOnboardingPart(value: unknown): value is OnboardingPart {
  return PARTS.includes(value as OnboardingPart);
}

export function isOnboardingOutcome(value: unknown): value is OnboardingOutcome {
  return OUTCOMES.includes(value as OnboardingOutcome);
}
