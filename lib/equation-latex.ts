import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { integerEnv } from "@/lib/env-config";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getAiTaskConfig } from "@/lib/local-ai-settings";

export const EQUATION_PROMPT_MAX_CHARS = 1_000;
export const EQUATION_LATEX_MAX_CHARS = 4_000;

/**
 * Turns a plain-language description into a single KaTeX-ready LaTeX
 * expression. The current source-box content rides along as a draft, so the
 * model can repair a failed render or refine an existing equation in place
 * instead of starting from scratch.
 */
export async function generateEquationLatex(input: {
  userId: string;
  projectId: string;
  prompt: string;
  latex: string;
  kind: "inline" | "block";
}): Promise<{ latex: string; modelSource: "system" | "byok" } | { error: string }> {
  const project = await db.query.projects.findFirst({ where: and(eq(projects.slug, input.projectId), eq(projects.userId, input.userId)) });
  if (!project) return { error: "Project not found." };
  const { modelId, apiKey } = await getAiTaskConfig("equation");
  if (!modelId || !apiKey) return { error: "Equation AI is not configured." };

  try {
    const openrouter = createOpenRouter({ apiKey });
    const generate = async () => generateText({
          model: openrouter(modelId),
          system: [
        "You convert plain-language requests into LaTeX math for an equation editor.",
        "Return ONLY the LaTeX source of the math: no $ or $$ delimiters, no \\( \\) \\[ \\] wrappers, no markdown fences, no commentary.",
        "The result is rendered with KaTeX, so use only standard LaTeX math commands KaTeX supports.",
        input.kind === "inline"
          ? "The equation renders inline in a sentence, so it must fit on one line; prefer compact forms."
          : "The equation renders as a display block; multi-line environments such as aligned or cases are fine when the request needs them.",
          ].join(" "),
          prompt: buildPrompt(input),
          maxOutputTokens: 400,
          temperature: 0.1,
          timeout: integerEnv("EQUATION_AI_TIMEOUT_MS", 30_000, 1_000),
        });
    const generatedText = (await generate()).text;
    const latex = normalizeLatex(generatedText).slice(0, EQUATION_LATEX_MAX_CHARS);
    if (!latex) return { error: "The model returned an empty equation. Try rephrasing." };
    return { latex, modelSource: "system" };
  } catch (error) {
    console.error("Equation LaTeX generation failed:", error);
    return { error: "Equation generation failed. Try again in a moment." };
  }
}

function buildPrompt({ prompt, latex, kind }: { prompt: string; latex: string; kind: "inline" | "block" }) {
  const lines = [`Request (for an ${kind === "inline" ? "inline" : "display"} equation): ${prompt}`];
  lines.push(
    latex.trim()
      ? `The user's LaTeX source box currently contains:\n${latex.trim()}\nTreat it as the starting point: it may contain syntax errors or an incomplete attempt — repair it and apply the request on top of it, preserving its intent.`
      : "The user's LaTeX source box is empty; write the equation from scratch.",
  );
  return lines.join("\n\n");
}

// LLMs wrap math in fences or delimiters despite instructions; peel them off so
// the source box receives bare KaTeX source.
function normalizeLatex(value: string) {
  let out = value.trim();
  for (let pass = 0; pass < 3; pass++) {
    const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(out);
    const match = fenced ?? /^(\$\$([\s\S]*?)\$\$|\$([\s\S]*?)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\])$/.exec(out);
    if (!match) break;
    out = (match[1] ?? "").trim();
  }
  return out;
}
