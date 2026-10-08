import { NextResponse } from "next/server";
import { z } from "zod";
import { AI_TASKS, getAiKey, getAiPreferences, isValidModelId, saveAiSettings } from "@/lib/local-ai-settings";

export const dynamic = "force-dynamic";
const choice = z.object({ modelId: z.string().refine(isValidModelId), contextLength: z.number().int().min(8192).max(4_000_000) });
const schema = z.object({ preferences: z.object(Object.fromEntries(AI_TASKS.map((task) => [task, choice])) as Record<(typeof AI_TASKS)[number], typeof choice>), apiKey: z.string().trim().min(10).max(500).optional(), removeKey: z.boolean().optional() });

export async function GET() {
  return NextResponse.json({ preferences: await getAiPreferences(), hasKey: Boolean(await getAiKey()), keyFromEnvironment: Boolean(process.env.OPENROUTER_API_KEY) }, { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid AI settings." }, { status: 400 });
  const { preferences, apiKey, removeKey } = parsed.data;
  const key = removeKey ? process.env.OPENROUTER_API_KEY?.trim() : apiKey || await getAiKey();
  if (removeKey && !key) {
    await saveAiSettings(preferences, null);
    return NextResponse.json({ preferences, hasKey: false });
  }
  if (!key) return NextResponse.json({ error: "Enter an OpenRouter API key or configure OPENROUTER_API_KEY." }, { status: 400 });
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
    if (!response.ok) return NextResponse.json({ error: "OpenRouter rejected the API key." }, { status: 400 });
  } catch { return NextResponse.json({ error: "Could not validate the OpenRouter API key." }, { status: 400 }); }
  const checks = await Promise.all(AI_TASKS.map(async (task) => {
    const modelId = preferences[task].modelId;
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/model/${encodeURI(modelId)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
      if (!response.ok) return `${task}: OpenRouter could not find ${modelId}.`;
      const model = await response.json() as { data?: { context_length?: number; supported_parameters?: string[] } };
      if (task === "chat" && !model.data?.supported_parameters?.includes("tools")) return "Chat model must support tool calling.";
      preferences[task].contextLength = Math.max(8192, model.data?.context_length || preferences[task].contextLength);
      return null;
    } catch { return `${task}: Could not validate the model with OpenRouter.`; }
  }));
  const failure = checks.find(Boolean);
  if (failure) return NextResponse.json({ error: failure }, { status: 400 });
  await saveAiSettings(preferences, removeKey ? null : apiKey);
  return NextResponse.json({ preferences, hasKey: Boolean(await getAiKey()) });
}
