import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { integerEnv } from "@/lib/env-config";
import { getAiTaskConfig } from "@/lib/local-ai-settings";

const FALLBACK_TITLE = "New Conversation";
const MAX_TITLE_LENGTH = integerEnv("TITLE_MAX_LENGTH", 80, 1);

export async function generateConversationTitle(firstMessage: string | undefined) {
  const prompt = firstMessage?.trim();
  const { modelId, apiKey } = await getAiTaskConfig("conversationTitle");

  if (!prompt || !modelId || !apiKey) {
    return FALLBACK_TITLE;
  }

  try {
    const openrouter = createOpenRouter({ apiKey });
    const result = await generateText({
      model: openrouter(modelId),
      system:
        "Name a chat from its first user message. Return only a concise, specific title of 3 to 7 words. Do not use quotation marks, a trailing period, or generic labels such as New Chat.",
      prompt,
      maxOutputTokens: 30,
      temperature: 0.2,
      timeout: integerEnv("TITLE_TIMEOUT_MS", 10_000, 1_000),
    });

    return normalizeTitle(result.text) || FALLBACK_TITLE;
  } catch (error) {
    console.error("Conversation title generation failed:", error);
    return FALLBACK_TITLE;
  }
}

function normalizeTitle(value: string) {
  return value
    .trim()
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}
