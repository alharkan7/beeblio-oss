"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, Code2, Copy, Eraser, Pencil, Plus, Text, Trash2 } from "lucide-react";
import type { BundledLanguage } from "shiki";

import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import type { WorkspaceEditorProps } from "./types";
import { useTextFile } from "./use-text-file";
import { errorDetail } from "@/lib/error-detail";

type NotebookCell = { id?: string; cell_type: "markdown" | "code" | "raw"; source: string | string[]; outputs?: Array<Record<string, unknown>>; execution_count?: number | null; metadata?: Record<string, unknown> };
type Notebook = { cells: NotebookCell[]; metadata: Record<string, unknown>; nbformat: number; nbformat_minor: number };

export function NotebookEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const text = useTextFile(projectId, file.path, onSaved);
  const [selectedCell, setSelectedCell] = useState(0);
  const [editAll, setEditAll] = useState(false);
  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(text.draft) as Notebook;
      return Array.isArray(value.cells) ? { value } : { error: "Notebook has no cells array." };
    } catch (error) {
      return { error: errorDetail(error, "Invalid notebook JSON") };
    }
  }, [text.draft]);

  const update = (updater: (notebook: Notebook) => Notebook) => {
    if (parsed.value) text.setDraft(JSON.stringify(updater(structuredClone(parsed.value)), null, 2));
  };
  const addCell = (cell_type: "markdown" | "code", insertIndex?: number) => {
    update((notebook) => {
      const targetIndex = insertIndex ?? notebook.cells.length;
      const newCell = { cell_type, metadata: {}, source: [], ...(cell_type === "code" ? { outputs: [], execution_count: null } : {}) };
      return { ...notebook, cells: [...notebook.cells.slice(0, targetIndex), newCell, ...notebook.cells.slice(targetIndex)] };
    });
    if (insertIndex !== undefined) setSelectedCell(insertIndex);
    else setSelectedCell(parsed.value?.cells.length ?? 0);
  };
  const kernel = parsed.value?.metadata?.kernelspec as { display_name?: string; language?: string } | undefined;
  const languageInfo = parsed.value?.metadata?.language_info as { name?: string } | undefined;
  const codeLanguage = notebookLanguage(languageInfo?.name ?? kernel?.language);

  return <EditorShell path={file.path} sourceUrl={sourceUrl} dirty={text.dirty} status={<span className="text-xs text-muted-foreground">{kernel?.display_name || kernel?.language || "Notebook"} · {parsed.value?.cells.length || 0} Cells</span>} actions={<><Button size="sm" variant={editAll ? "secondary" : "ghost"} onClick={() => setEditAll((current) => !current)}>{editAll ? <Check /> : <Pencil />}{editAll ? "Done Editing" : "Edit All"}</Button><Button size="sm" variant="ghost" onClick={() => addCell("markdown")}><Plus />Markdown</Button><Button size="sm" variant="ghost" onClick={() => addCell("code")}><Plus />Code</Button></>} discard={{ onDiscard: text.discard, disabled: text.saving }} save={{ onClick: () => text.save(), saving: text.saving, disabled: !!parsed.error }} review={text.review}>
    {text.loading ? <EditorLoading name={file.name} size={file.size} /> : text.error ? <EditorError message={text.error} /> : parsed.error ? <EditorError message={parsed.error} /> : <div className="h-full overflow-auto bg-muted/30 p-4"><div className="mx-auto max-w-4xl space-y-3 pb-8">{parsed.value?.cells.map((cell, index) => <div key={cell.id || index} className="group/cell relative"><NotebookCellView cell={cell} index={index} count={parsed.value?.cells.length || 0} selected={selectedCell === index} editAll={editAll} codeLanguage={codeLanguage} onSelect={() => setSelectedCell(index)} onChange={(next) => update((notebook) => ({ ...notebook, cells: notebook.cells.map((item, itemIndex) => itemIndex === index ? next : item) }))} onMove={(direction) => update((notebook) => { const target = index + direction; if (target < 0 || target >= notebook.cells.length) return notebook; [notebook.cells[index], notebook.cells[target]] = [notebook.cells[target], notebook.cells[index]]; setSelectedCell(target); return notebook; })} onDuplicate={() => update((notebook) => ({ ...notebook, cells: [...notebook.cells.slice(0, index + 1), { ...structuredClone(cell), id: undefined, execution_count: null }, ...notebook.cells.slice(index + 1)] }))} onClearOutputs={() => onClearNotebookOutputs(index, update)} onDelete={() => update((notebook) => ({ ...notebook, cells: notebook.cells.filter((_, itemIndex) => itemIndex !== index) }))} /><div className="absolute -bottom-[22px] left-1/2 z-10 flex -translate-x-1/2 scale-90 items-center justify-center gap-1 rounded-md border bg-card p-0.5 opacity-0 shadow-sm transition-all hover:scale-100 hover:opacity-100 group-hover/cell:scale-100 group-hover/cell:opacity-100"><Button size="xs" variant="ghost" className="h-6 px-2 text-[10px]" onClick={(e) => { e.stopPropagation(); addCell("code", index + 1); }}><Plus className="mr-1 size-3" />Code</Button><Button size="xs" variant="ghost" className="h-6 px-2 text-[10px]" onClick={(e) => { e.stopPropagation(); addCell("markdown", index + 1); }}><Plus className="mr-1 size-3" />Markdown</Button></div></div>)}</div></div>}
  </EditorShell>;
}

function NotebookCellView({ cell, index, count, selected, editAll, codeLanguage, onSelect, onChange, onMove, onDuplicate, onClearOutputs, onDelete }: { cell: NotebookCell; index: number; count: number; selected: boolean; editAll: boolean; codeLanguage: BundledLanguage; onSelect: () => void; onChange: (cell: NotebookCell) => void; onMove: (direction: -1 | 1) => void; onDuplicate: () => void; onClearOutputs: () => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source;
  const isEditing = editAll || editing;
  return <section onFocus={onSelect} onClick={onSelect} className={`overflow-hidden rounded-lg border bg-card transition-shadow ${selected ? "border-primary/60 shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_30%,transparent)]" : ""}`}>
    <header className="flex h-8 items-center gap-2 border-b bg-muted/40 px-2"><span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{cell.cell_type === "code" ? <Code2 className="size-3" /> : <Text className="size-3" />}{cell.cell_type}</span>{cell.cell_type === "code" ? <span className="text-[10px] text-muted-foreground">In [{cell.execution_count ?? " "}]</span> : null}<div className="ml-auto flex"><Button size="icon-xs" variant={isEditing ? "secondary" : "ghost"} title={isEditing ? "Finish editing cell" : "Edit cell"} aria-label={isEditing ? "Finish editing cell" : "Edit cell"} onClick={() => setEditing((current) => !current)} disabled={editAll}>{isEditing ? <Check /> : <Pencil />}</Button><Button size="icon-xs" variant="ghost" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></Button><Button size="icon-xs" variant="ghost" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown /></Button><Button size="icon-xs" variant="ghost" title="Duplicate cell" onClick={onDuplicate}><Copy /></Button>{cell.cell_type === "code" && cell.outputs?.length ? <Button size="icon-xs" variant="ghost" title="Clear output" onClick={onClearOutputs}><Eraser /></Button> : null}<Button size="icon-xs" variant="ghost" title="Delete cell" onClick={onDelete}><Trash2 /></Button></div></header>
    {isEditing ? <textarea value={source} onChange={(event) => onChange({ ...cell, source: event.target.value.split(/(?<=\n)/) })} spellCheck={cell.cell_type === "markdown"} autoFocus={!editAll} className="min-h-24 w-full resize-y bg-card p-3 font-mono text-[13px] leading-6 outline-none" /> : <RenderedCell cell={cell} source={source} codeLanguage={codeLanguage} />}
    {cell.cell_type === "code" && cell.outputs?.length ? <div className="border-t bg-muted/20 p-3 text-xs"><NotebookOutputs outputs={cell.outputs} /></div> : null}
  </section>;
}

function RenderedCell({ cell, source, codeLanguage }: { cell: NotebookCell; source: string; codeLanguage: BundledLanguage }) {
  if (!source.trim()) return <div className="p-4 text-xs italic text-muted-foreground">Empty {cell.cell_type} cell</div>;
  if (cell.cell_type === "markdown") return <div className="bg-card p-4"><MessageResponse>{source}</MessageResponse></div>;
  if (cell.cell_type === "code") return <CodeBlock code={source} language={codeLanguage} showLineNumbers className="rounded-none border-0 bg-card" />;
  return <pre className="overflow-auto whitespace-pre-wrap bg-card p-4 font-mono text-[13px] leading-6">{source}</pre>;
}

function notebookLanguage(language: string | undefined): BundledLanguage {
  const aliases: Record<string, BundledLanguage> = { csharp: "csharp", "c#": "csharp", fsharp: "fsharp", "f#": "fsharp", javascript: "javascript", js: "javascript", julia: "julia", python: "python", python3: "python", r: "r", ruby: "ruby", rust: "rust", scala: "scala", sql: "sql", typescript: "typescript", ts: "typescript" };
  return aliases[language?.toLowerCase() ?? ""] ?? "python";
}

function onClearNotebookOutputs(index: number, update: (updater: (notebook: Notebook) => Notebook) => void) {
  update((notebook) => ({ ...notebook, cells: notebook.cells.map((cell, itemIndex) => itemIndex === index ? { ...cell, outputs: [], execution_count: null } : cell) }));
}

function NotebookOutputs({ outputs }: { outputs: Array<Record<string, unknown>> }) {
  return <>{outputs.map((output, index) => {
    const data = output.data as Record<string, unknown> | undefined;
    const png = joined(data?.["image/png"]); const jpeg = joined(data?.["image/jpeg"]); const svg = joined(data?.["image/svg+xml"]); const html = joined(data?.["text/html"]); const text = joined(output.text ?? data?.["text/plain"]); const traceback = Array.isArray(output.traceback) ? output.traceback.join("\n") : undefined;
    return <div key={index} className="mb-3 overflow-auto rounded border bg-card p-3 last:mb-0">{png || jpeg ? <img alt="Notebook output" src={`data:image/${png ? "png" : "jpeg"};base64,${png || jpeg}`} className="max-w-full" /> : svg ? <img alt="Notebook SVG output" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} className="max-w-full" /> : html ? <iframe title={`Notebook HTML output ${index + 1}`} sandbox="" srcDoc={html} className="min-h-32 w-full border-0 bg-white" /> : traceback ? <pre className="whitespace-pre-wrap font-mono text-destructive">{traceback}</pre> : <pre className="whitespace-pre-wrap font-mono">{text || String(output.ename ?? "")}</pre>}</div>;
  })}</>;
}

function joined(value: unknown) { return Array.isArray(value) ? value.join("") : typeof value === "string" ? value : ""; }
