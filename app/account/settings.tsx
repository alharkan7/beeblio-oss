"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AI_TASKS, type AiPreferences, type AiTask } from "@/lib/ai-settings-types";

const labels: Record<AiTask, [string, string]> = {
  chat: ["Agent Conversations", "The main agent model. Must support tool calling."],
  conversationTitle: ["Conversation Titles", "Names a new chat from its first message."],
  sentenceSuggestion: ["Sentence Suggestions", "Short completions in the document editor."],
  documentReview: ["Document Review", "Review and proofreading of documents."],
  equation: ["Equation Generation", "Creates LaTeX from a description."],
  imageAnalysis: ["Image Analysis", "Understands images passed to the agent's analyze_image tool."],
};

export function AiModelSettings() {
  const [preferences, setPreferences] = useState<AiPreferences | null>(null);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyFromEnvironment, setKeyFromEnvironment] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void fetch("/api/ai-settings", { cache: "no-store" }).then((r) => r.json()).then((data) => { setPreferences(data.preferences); setHasKey(data.hasKey); setKeyFromEnvironment(data.keyFromEnvironment); }).catch(() => toast.error("Could not load AI settings.")); }, []);
  function update(task: AiTask, modelId: string) { setPreferences((current) => current ? { ...current, [task]: { ...current[task], modelId } } : current); }
  async function save(removeKey = false) {
    if (!preferences) return;
    setSaving(true);
    try {
      const response = await fetch("/api/ai-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preferences, ...(key.trim() ? { apiKey: key.trim() } : {}), removeKey }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save AI settings.");
      setPreferences(result.preferences); setHasKey(result.hasKey); setKey("");
      toast.success("AI settings saved.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save AI settings."); }
    finally { setSaving(false); }
  }
  return <div className="mt-8 space-y-6 rounded-2xl border bg-card p-6">
    <div><h2 className="text-lg font-semibold">OpenRouter</h2><p className="mt-1 text-sm text-muted-foreground">One key powers these tasks. Each task can use a different model. Changes apply to new calls across all projects.</p></div>
    <div className="space-y-2"><Label htmlFor="ai-key">API key</Label><Input id="ai-key" type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? "Key configured — enter a new one to replace it" : "sk-or-v1-…"} autoComplete="off" /><p className="text-xs text-muted-foreground">A saved key is encrypted in the local app data directory. {keyFromEnvironment ? "OPENROUTER_API_KEY remains available as a fallback." : ""}</p></div>
    <div className="divide-y rounded-xl border">{AI_TASKS.map((task) => <div key={task} className="grid gap-3 p-4 sm:grid-cols-[1fr_1.2fr] sm:items-center"><div><Label htmlFor={`model-${task}`}>{labels[task][0]}</Label><p className="mt-1 text-xs text-muted-foreground">{labels[task][1]}</p></div><Input id={`model-${task}`} value={preferences?.[task].modelId ?? ""} onChange={(event) => update(task, event.target.value)} placeholder="provider/model-id" className="font-mono text-xs" /></div>)}</div>
    <p className="text-xs text-muted-foreground">Saving verifies every model with OpenRouter, checks that the chat model supports tools, and reads each model’s context window.</p>
    <div className="flex flex-wrap gap-2"><Button disabled={!preferences || saving} onClick={() => void save()}>{saving ? "Validating…" : "Save Settings"}</Button>{hasKey && !keyFromEnvironment ? <Button variant="outline" disabled={saving} onClick={() => void save(true)}>Remove saved key</Button> : null}</div>
  </div>;
}
