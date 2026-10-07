import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent, defineDynamic } from "eve";
import { timedModelFetch } from "./lib/model-timeout";
import { appSetting, openRouterApiKey } from "../lib/app-settings";

// Direct OpenRouter models do not provide Eve with context-window metadata,
// so the size of the selected main model is configured alongside it.
function mainModelConfig() {
  const modelId = appSetting("OPENROUTER_MODEL_ID");
  const contextWindow = Number(appSetting("OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS"));
  if (!modelId) throw new Error("Choose a main model in Settings → Models");
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("Set the main model's context window in Settings → Models");
  }
  return { modelId, contextWindow };
}

export default defineAgent({
  // A dynamic model has no compiled fallback in current eve: the resolver must
  // return a concrete model for every step, so non-BYOK turns resolve to the
  // system OpenRouter model here.
  model: defineDynamic({
    events: {
      "step.started": async () => {
        const fetch = timedModelFetch();
        const apiKey = openRouterApiKey();
        if (!apiKey) throw new Error("Add your OpenRouter API key in Settings → API Keys");
        const openrouter = createOpenRouter({ apiKey, fetch });
        const { modelId, contextWindow } = mainModelConfig();
        return { model: openrouter(modelId), modelContextWindowTokens: contextWindow };
      },
    },
  }),
  reasoning: "medium",
  limits: {
    // Input consumption re-bills the full context every model call, so it grows
    // far faster than context size; 5M keeps the continuation prompt out of
    // legitimate long runs while still stopping defective ones. Output must be
    // sized alongside it: approving either window resets both, so a tight
    // output cap resurfaces the dialog once input approvals become rare.
    maxInputTokensPerSession: 5_000_000,
    maxOutputTokensPerSession: 200_000,
  },
  build: {
    // Keep the sandbox/storage SDKs external instead of bundling them.
    externalDependencies: ["better-sqlite3", "sharp"],
  },
});
