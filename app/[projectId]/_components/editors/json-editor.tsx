"use client";

import { useMemo, useState } from "react";
import { Braces, ChevronRight, Code2, Columns2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import { SourceCodeEditor } from "./source-code-editor";
import type { WorkspaceEditorProps } from "./types";
import { useTextFile } from "./use-text-file";
import { errorDetail } from "@/lib/error-detail";

type JsonMode = "tree" | "source" | "split";

export function JsonEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const text = useTextFile(projectId, file.path, onSaved);
  const [mode, setMode] = useState<JsonMode>("tree");
  const parsed = useMemo(() => {
    try {
      return { value: JSON.parse(text.draft) as unknown, error: undefined };
    } catch (error) {
      return { value: undefined, error: errorDetail(error, "Invalid JSON") };
    }
  }, [text.draft]);
  const itemCount = parsed.value && typeof parsed.value === "object" ? Object.keys(parsed.value).length : 1;

  return (
    <EditorShell
      path={file.path}
      sourceUrl={sourceUrl}
      dirty={text.dirty}
      status={<span className="text-xs text-muted-foreground">
        {/* JSON ·  */}
      {parsed.error ? "Invalid syntax" : `${itemCount} Root ${itemCount === 1 ? "Item" : "Items"}`}</span>}
      viewModes={[{
        value: mode,
        onChange: (value) => setMode(value as JsonMode),
        options: [
          { value: "tree", label: "Tree view", icon: Braces },
          { value: "source", label: "Source view", icon: Code2 },
          { value: "split", label: "Split view", icon: Columns2 },
        ],
      }]}
      actions={<Button size="sm" variant="ghost" disabled={!!parsed.error} onClick={() => text.setDraft(JSON.stringify(parsed.value, null, 2))}><Braces />Format</Button>}
      discard={{ onDiscard: text.discard, disabled: text.saving }}
      save={{ onClick: () => text.save(), saving: text.saving, disabled: !!parsed.error }}
      review={text.review}
    >
      {text.loading ? <EditorLoading name={file.name} size={file.size} /> : text.error ? <EditorError message={text.error} /> : mode === "source" ? <JsonSource value={text.draft} error={parsed.error} onChange={text.setDraft} /> : mode === "split" ? <div className="grid h-full min-h-0 grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1"><div className="min-h-0 border-r"><JsonSource value={text.draft} error={parsed.error} onChange={text.setDraft} /></div><JsonTree value={parsed.value} error={parsed.error} /></div> : <JsonTree value={parsed.value} error={parsed.error} />}
    </EditorShell>
  );
}

function JsonSource({ value, error, onChange }: { value: string; error?: string; onChange: (value: string) => void }) {
  return <div className="flex h-full min-h-0 flex-col"><div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/50 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><span>JSON source</span><span>{value.split("\n").length} lines</span></div><SourceCodeEditor value={value} extension="json" onChange={onChange} />{error ? <div className="border-t bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">{error}</div> : null}</div>;
}

function JsonTree({ value, error }: { value: unknown; error?: string }) {
  const [expansion, setExpansion] = useState<"default" | "all" | "none">("default");
  const [version, setVersion] = useState(0);
  if (error) return <EditorError message={`Fix the JSON source to restore the tree view: ${error}`} />;
  const setAll = (next: "all" | "none") => { setExpansion(next); setVersion((current) => current + 1); };
  return <div className="flex h-full min-h-0 flex-col bg-card"><div className="flex h-8 shrink-0 items-center border-b bg-muted/50 px-3"><span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Structured data</span><div className="ml-auto flex gap-1"><Button size="xs" variant="ghost" onClick={() => setAll("all")}>Expand all</Button><Button size="xs" variant="ghost" onClick={() => setAll("none")}>Collapse all</Button></div></div><div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs"><JsonNode key={version} name="root" value={value} depth={0} expansion={expansion} /></div></div>;
}

function JsonNode({ name, value, depth, expansion }: { name: string; value: unknown; depth: number; expansion: "default" | "all" | "none" }) {
  const complex = value !== null && typeof value === "object";
  const [open, setOpen] = useState(expansion === "all" || (expansion === "default" && depth < 2));
  const paddingLeft = depth * 18;
  if (!complex) return <div className="flex min-h-7 items-start gap-2 rounded px-2 py-1 hover:bg-muted/50" style={{ paddingLeft }}><span className="break-all text-sky-700 dark:text-sky-400">{name}:</span><JsonPrimitive value={value} /></div>;
  const entries = Object.entries(value as Record<string, unknown>);
  const collection = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return <div><button type="button" className="flex min-h-7 w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted/60" style={{ paddingLeft }} onClick={() => setOpen((current) => !current)}><ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} /><span className="text-sky-700 dark:text-sky-400">{name}</span><span className="ml-1 text-muted-foreground">{collection}</span></button>{open ? entries.map(([key, item]) => <JsonNode key={key} name={key} value={item} depth={depth + 1} expansion={expansion} />) : null}</div>;
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-rose-600 dark:text-rose-400">null</span>;
  if (typeof value === "string") return <span className="break-all text-emerald-700 dark:text-emerald-400">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="text-amber-700 dark:text-amber-400">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-violet-700 dark:text-violet-400">{String(value)}</span>;
  return <span className="text-muted-foreground">{String(value)}</span>;
}
