export const AI_TASKS = ["chat", "conversationTitle", "sentenceSuggestion", "documentReview", "equation", "imageAnalysis"] as const;
export type AiTask = (typeof AI_TASKS)[number];
export type AiChoice = { modelId: string; contextLength: number };
export type AiPreferences = Record<AiTask, AiChoice>;
