"use server";

import { requireUser } from "@/lib/auth/session";
import { isOnboardingOutcome, isOnboardingPart, onboardingState, recordOnboarding, type OnboardingState } from "@/lib/onboarding";

export async function getOnboarding(): Promise<OnboardingState> {
  await requireUser();
  return onboardingState();
}

/** Called when the person finishes or skips a part, so it does not start by itself again. */
export async function completeOnboarding(part: unknown, outcome: unknown): Promise<OnboardingState> {
  await requireUser();
  if (!isOnboardingPart(part) || !isOnboardingOutcome(outcome)) throw new Error("Unknown onboarding step.");
  return recordOnboarding(part, outcome);
}
