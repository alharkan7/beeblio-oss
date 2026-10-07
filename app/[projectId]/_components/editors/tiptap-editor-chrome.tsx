"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isNodeSelection, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import katex from "katex";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDownToLine, ArrowLeftToLine,
  ArrowRightToLine, ArrowUpToLine, ArrowUpRight, Bold, BookOpen, BookOpenText, Braces, ChevronDown, ChevronRight, ChevronUp, Code2,
  Columns3, Folder, FolderOpen, ImagePlus, Italic, Link2, List, ListChecks, Loader2,
  ListOrdered, Minus, Pencil, PencilSparkles, Pilcrow, Plus, Quote, Radical, Redo2, RemoveFormatting, Rows3, Sigma,
  Strikethrough, Subscript as SubscriptIcon, Superscript as SuperscriptIcon,
  Table2, Trash2, Underline, Undo2, Unlink, Upload, Workflow, Search
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { resizeImageForAgent } from "@/lib/client-image-resize";
import { isStorageLimitError } from "@/lib/storage-errors";
import { CITATION_STYLES, formatBibliographyEntry, sortCitedReferences, type CitationReference, type CitationStyle } from "@/lib/citations";
import type { LiteratureItem } from "@/lib/literature/types";
import { documentFontFamilyCss, type DocumentDefaultSettings } from "@/lib/project-settings";
import { getFileContent, listFiles, type FileEntry } from "../../file-actions";
import { uploadWorkspaceFile } from "@/lib/workspace-upload";
import { fileUrl } from "../file-viewer";
import { workspacePathRelativeToDocument } from "./markdown-image-path";
import {
  DIAGRAM_EXTENSIONS, IMAGE_EXTENSIONS, UPLOADABLE_VISUAL_ACCEPT, isDiagramFile, isUploadableVisualName, isVisualFile,
} from "./tiptap-markdown-extensions";
import { errorDetail } from "@/lib/error-detail";

const fonts = [
  ["", "Default"],
  ["Arial", "Arial"],
  ["Aptos", "Aptos"],
  ["Calibri", "Calibri"],
  ["Georgia", "Georgia"],
  ["Garamond", "Garamond"],
  ["Times New Roman", "Times New Roman"],
  ["Verdana", "Verdana"],
  ["Courier New", "Courier New"],
] as const;

const fontSizes = [
  ["", "Size"], ["12px", "9"], ["13px", "10"], ["15px", "11"],
  ["16px", "12"], ["19px", "14"], ["24px", "18"], ["32px", "24"],
] as const;

export type EquationKind = "inline" | "block";
export type EquationDraft = { kind: EquationKind; latex: string; pos?: number };
export type LinkDraft = { mode: "create" | "edit"; href: string; text: string };

const TABLE_PICKER_ROWS = 8;
const TABLE_PICKER_COLS = 10;
const MENTION_TRIGGER_HEIGHT = 32;

const equationTemplates = [
  ["Fraction", "\\frac{a}{b}"],
  ["Root", "\\sqrt{x}"],
  ["Power", "x^{n}"],
  ["Subscript", "x_{i}"],
  ["Sum", "\\sum_{i=1}^{n} x_i"],
  ["Integral", "\\int_{a}^{b} f(x) \\,dx"],
  ["Derivative", "\\frac{\\partial f}{\\partial x}"],
  ["Matrix", "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}"],
] as const;

export function MentionSearchMenu({
  projectId,
  search,
  citations,
  files,
  literature,
  activeIndex,
  citationsLoading,
  citationsError,
  filesLoading,
  filesError,
  onActiveIndexChange,
  onSelectCitation,
  onSelectFile,
  onRunLiteratureSearch,
  onSelectLiterature,
  onOpenLiteraturePanel,
  citationOnly = false,
  onQueryChange,
  onClose,
}: {
  projectId: string;
  search: { query: string; left: number; top: number };
  citations: CitationReference[];
  files: FileEntry[];
  literature: {
    enabled: boolean;
    query: string;
    items: LiteratureItem[];
    searching: boolean;
    error?: string;
    searched: boolean;
    citingId?: string;
  };
  activeIndex: number;
  citationsLoading: boolean;
  citationsError: boolean;
  filesLoading: boolean;
  filesError: boolean;
  onActiveIndexChange: (index: number) => void;
  onSelectCitation: (reference: CitationReference) => void;
  onSelectFile: (entry: FileEntry) => void;
  onRunLiteratureSearch: () => void;
  onSelectLiterature: (item: LiteratureItem) => void;
  onOpenLiteraturePanel: () => void;
  citationOnly?: boolean;
  onQueryChange?: (query: string) => void;
  onClose?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: search.left, top: search.top, measured: false });

  // Anchor the menu to the Cite button. Prefer directly below it, flip above
  // when necessary, and clamp both axes after measuring the real menu size.
  useLayoutEffect(() => {
    const place = () => {
      const menu = rootRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      const left = Math.min(Math.max(search.left, margin), window.innerWidth - rect.width - margin);
      const triggerTop = search.top - MENTION_TRIGGER_HEIGHT - gap;
      const top = search.top + rect.height <= window.innerHeight - margin
        ? search.top
        : Math.max(margin, triggerTop - rect.height - gap);
      setPosition({ left, top, measured: true });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [search.left, search.top, citations.length, files.length, literature.enabled, literature.items.length, literature.searching, literature.error]);

  useEffect(() => {
    if (!onClose) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [onClose]);

  // All visible actions share an index space in their visual order so arrow
  // navigation moves naturally from literature into the library and files.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const optionClasses = (active: boolean) =>
    cn("block w-full rounded-md px-2.5 py-2 text-left", active ? "bg-accent" : "hover:bg-accent/60");

  // The raw query may end in the spaces the user typed mid-thought; headers
  // and the literature row all show it trimmed.
  const headerQuery = search.query.trim();
  const literatureResultsShown = literature.enabled && literature.searched && !literature.error;
  const visibleFiles = citationOnly ? [] : files;
  const noCitationMatches = !!headerQuery && !citationsLoading && !citationsError && citations.length === 0;
  const noFileMatches = !!headerQuery && !filesLoading && !filesError && files.length === 0;
  const literatureActionIndex = literature.enabled && !literatureResultsShown ? 0 : -1;
  const literatureItemsStart = 0;
  const literatureMoreIndex = literatureResultsShown && literature.items.length > 0
    ? literature.items.length
    : -1;
  const literatureOptionCount = literature.enabled
    ? literatureResultsShown
      ? literature.items.length + (literature.items.length > 0 ? 1 : 0)
      : 1
    : 0;
  const citationsStart = literatureOptionCount;
  const lastCitationOnlyIndex = citationsStart + citations.length - 1;

  const handleCitationSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const lastIndex = Math.max(literatureMoreIndex, lastCitationOnlyIndex);
      if (lastIndex < 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      onActiveIndexChange(Math.max(0, Math.min(lastIndex, activeIndex + direction)));
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (activeIndex === literatureActionIndex) {
      onRunLiteratureSearch();
    } else if (literatureResultsShown && activeIndex < literature.items.length) {
      const item = literature.items[activeIndex - literatureItemsStart];
      if (item) onSelectLiterature(item);
    } else if (activeIndex === literatureMoreIndex) {
      onOpenLiteraturePanel();
    } else {
      const reference = citations[activeIndex - citationsStart];
      if (reference) onSelectCitation(reference);
    }
  };

  // Each section scrolls on its own under a fixed header, so a long citation
  // list can never push the file section out of view. The literature tier
  // makes the menu taller, so it reserves more viewport space when shown.
  return (
    <div
      ref={rootRef}
      className="beeblio-mention-menu"
      style={{
        left: position.left,
        top: position.top,
        visibility: position.measured ? "visible" : "hidden",
      }}
      role="listbox"
      aria-label={citationOnly ? "Find a citation" : "Insert citation, embed a file, or search literature"}
    >
      {citationOnly ? (
        <div className="border-b p-2">
          <div className="flex items-center gap-2 rounded-md border bg-background px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={search.query}
              onChange={(event) => onQueryChange?.(event.target.value)}
              onKeyDown={handleCitationSearchKeyDown}
              placeholder="Search your library or literature…"
              aria-label="Search citations"
              className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      ) : null}
            {literature.enabled ? (
        <>
          <p className="flex items-start gap-1.5 border-b px-3 py-2 text-[11px] font-medium text-muted-foreground">
            <BookOpenText className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0">
              {literatureResultsShown ? `Literature Matching “${literature.query}”` : "Search Literature"}
            </span>
          </p>
          <div className="max-h-44 overflow-auto p-1">
            {!literatureResultsShown ? (
              <button
                type="button"
                role="option"
                aria-selected={activeIndex === literatureActionIndex}
                data-active={activeIndex === literatureActionIndex}
                className={optionClasses(activeIndex === literatureActionIndex)}
                onMouseEnter={() => onActiveIndexChange(literatureActionIndex)}
                onMouseDown={(event) => { event.preventDefault(); onRunLiteratureSearch(); }}
              >
                <span className="flex items-start gap-1.5">
                  {literature.searching
                    ? <Loader2 className="mt-px size-3.5 shrink-0 animate-spin" />
                    : <Search className="mt-px size-3.5 shrink-0" />}
                  <span className="min-w-0">
                    <span className="block break-words text-xs font-medium">
                      {literature.searching ? "Searching Literature…" : `Search literature for “${literature.query}”`}
                    </span>
                    {/* <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">OpenAlex, Crossref, and PubMed</span> */}
                  </span>
                </span>
              </button>
            ) : null}
            {literature.error ? <p className="px-3 py-2 text-center text-xs text-destructive">{literature.error}</p> : null}
            {literature.items.map((item, index) => {
              const optionIndex = literatureItemsStart + index;
              const active = optionIndex === activeIndex;
              const citing = literature.citingId === item.id;
              const details = [item.year, item.authors.slice(0, 2).join(", "), item.venue].filter(Boolean).join(" · ");
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  className={optionClasses(active)}
                  onMouseEnter={() => onActiveIndexChange(optionIndex)}
                  onMouseDown={(event) => { event.preventDefault(); onSelectLiterature(item); }}
                >
                  <span className="block truncate text-xs font-medium">
                    {citing ? <Loader2 className="mr-1 inline size-3 animate-spin align-[-1px]" /> : null}
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    {citing ? "Saving to your library…" : details || "Web result"}
                  </span>
                </button>
              );
            })}
            {literatureResultsShown && literature.items.length === 0 ? (
              <p className="px-3 py-2.5 text-center text-xs text-muted-foreground">No literature results.</p>
            ) : null}
            {literature.items.length > 0 ? (
              <button
                type="button"
                role="option"
                aria-selected={activeIndex === literatureMoreIndex}
                data-active={activeIndex === literatureMoreIndex}
                className={cn(optionClasses(activeIndex === literatureMoreIndex), "flex items-center justify-between gap-2")}
                onMouseEnter={() => onActiveIndexChange(literatureMoreIndex)}
                onMouseDown={(event) => { event.preventDefault(); onOpenLiteraturePanel(); }}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <ArrowUpRight className="size-3.5" />
                  More Results
                </span>
                <span className="text-[10px] text-muted-foreground">Literature Panel</span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      <p className="flex items-start gap-1.5 border-t px-3 py-2 text-[11px] font-medium text-muted-foreground">
        <BookOpen className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">{headerQuery ? `${noCitationMatches ? "No Library Matching" : "Library Matching"} “${headerQuery}”` : "Search Library"}</span>
      </p>
      {citations.length || citationsLoading || citationsError ? <div className="max-h-44 overflow-auto p-1">
        {citations.map((reference, index) => {
          const optionIndex = citationsStart + index;
          return (
          <button
            key={reference.id}
            type="button"
            role="option"
            aria-selected={optionIndex === activeIndex}
            data-active={optionIndex === activeIndex}
            className={optionClasses(optionIndex === activeIndex)}
            onMouseEnter={() => onActiveIndexChange(optionIndex)}
            onMouseDown={(event) => { event.preventDefault(); onSelectCitation(reference); }}
          >
            <span className="block truncate text-xs font-medium">{reference.title || reference.id}</span>
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{[reference.year, reference.authors].filter(Boolean).join(" · ") || "No author or year"}</span>
          </button>
          );
        })}
        {citationsLoading ? <p className="px-3 py-2.5 text-center text-xs text-muted-foreground">Loading references…</p> : null}
        {citationsError ? <p className="px-3 py-2.5 text-center text-xs text-destructive">Could not read 1-References/references.bib.</p> : null}
      </div> : null}
      {!citationOnly ? <p className="flex items-start gap-1.5 border-t px-3 py-2 text-[11px] font-medium text-muted-foreground">
        <FolderOpen className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">{headerQuery ? `${noFileMatches ? "No Files Matching" : "Files Matching"} “${headerQuery}”` : "Insert File"}</span>
      </p> : null}
      {!citationOnly && (visibleFiles.length || filesLoading || filesError) ? <div className="max-h-44 overflow-auto p-1">
        {visibleFiles.map((file, index) => {
          const optionIndex = citationsStart + citations.length + index;
          const active = optionIndex === activeIndex;
          const diagram = isDiagramFile(file);
          const folder = file.path.split("/").slice(0, -1).join("/");
          return (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={active}
              data-active={active}
              className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left", active ? "bg-accent" : "hover:bg-accent/60")}
              onMouseEnter={() => onActiveIndexChange(optionIndex)}
              onMouseDown={(event) => { event.preventDefault(); onSelectFile(file); }}
            >
              <span className="flex size-6 shrink-0 items-center justify-center self-center overflow-hidden rounded border bg-muted">
                {diagram
                  ? <Workflow className="size-3.5 text-muted-foreground" aria-hidden />
                  : <img src={fileUrl(projectId, file.path)} alt="" loading="lazy" className="size-full object-cover" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{file.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{folder || (diagram ? "Mermaid diagram" : "Image")}</span>
              </span>
            </button>
          );
        })}
        {filesLoading ? <p className="px-3 py-2.5 text-center text-xs text-muted-foreground">Loading workspace files…</p> : null}
        {filesError ? <p className="px-3 py-2.5 text-center text-xs text-destructive">Could not list workspace files.</p> : null}
      </div> : null}

    </div>
  );
}

export function GeneratedBibliography({ references, citationOrder, style, title, font, defaultFont, loading = false, onTitleChange, onFontChange }: {
  references: CitationReference[];
  citationOrder: string[];
  style: CitationStyle;
  title: string;
  font: { family: string; size: string };
  defaultFont?: { family: string; size: string };
  loading?: boolean;
  onTitleChange: (title: string) => void;
  onFontChange: (font: { family: string; size: string }) => void;
}) {
  const ordered = loading ? [] : sortCitedReferences(references, style, citationOrder);
  const knownIds = new Set(ordered.map((reference) => reference.id));
  const missing = loading ? [] : citationOrder.filter((id) => !knownIds.has(id));
  const effectiveFont = {
    family: font.family || defaultFont?.family || "",
    size: font.size || defaultFont?.size || "",
  };
  const sectionStyle = effectiveFont.family || effectiveFont.size
    ? {
        fontFamily: documentFontFamilyCss((effectiveFont.family || "") as DocumentDefaultSettings["fontFamily"]),
        fontSize: effectiveFont.size || undefined,
      }
    : undefined;
  return <section className="beeblio-generated-bibliography" style={sectionStyle} contentEditable={false} aria-label="Generated bibliography" aria-busy={loading}>
    <div className="relative">
      <h2 contentEditable suppressContentEditableWarning spellCheck onBlur={(event) => onTitleChange(event.currentTarget.textContent?.trim() || "References")}>{title}</h2>
      {/* Font controls for the generated section: entries stay read-only, only
          their presentation is user-chosen. */}
      <div className="absolute right-0 top-[1.65rem] flex items-center gap-1">
        <Select value={font.family || "default"} onValueChange={(value) => onFontChange({ ...font, family: value === "default" ? "" : value })}>
          <SelectTrigger aria-label="Bibliography font" title="Bibliography font" className="!h-7 w-auto max-w-36 gap-1 bg-transparent px-2 text-xs opacity-60 shadow-none transition-[color,background-color,border-color,box-shadow,opacity] hover:bg-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 data-[state=open]:opacity-100">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fonts.map(([value, label]) => <SelectItem className="py-1 text-xs" key={label} value={value || "default"}>{value ? label : "Font"}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={font.size || "default"} onValueChange={(value) => onFontChange({ ...font, size: value === "default" ? "" : value })}>
          <SelectTrigger aria-label="Bibliography font size" title="Bibliography font size" className="!h-7 w-[4rem] gap-1 bg-transparent px-2 text-xs opacity-60 shadow-none transition-[color,background-color,border-color,box-shadow,opacity] hover:bg-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 data-[state=open]:opacity-100">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fontSizes.map(([value, label]) => <SelectItem className="py-1 text-xs" key={label} value={value || "default"}>{value ? label : "Size"}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
    <div className="space-y-3">
      {loading ? citationOrder.slice(0, 8).map((id) => (
        <p key={id} className="pl-5 [text-indent:-1.25rem]" aria-hidden>
          <span className="inline-block h-3 animate-pulse rounded bg-muted-foreground/25 align-middle" style={{ width: `${50 + (id.length % 5) * 10}%` }} />
        </p>
      )) : (
        <>
          {ordered.map((reference) => <p key={reference.id} className="pl-5 [text-indent:-1.25rem]">{linkBibliographyUrls(formatBibliographyEntry(reference, style, Math.max(1, citationOrder.indexOf(reference.id) + 1)))}</p>)}
          {missing.map((id) => <p key={id} className="pl-5 text-destructive [text-indent:-1.25rem]">Missing reference: @{id}</p>)}
        </>
      )}
    </div>
  </section>;
}

export function EquationEditorDialog({
  projectId,
  draft,
  canUseAi = true,
  onClose,
  onDelete,
  onSave,
}: {
  projectId: string;
  draft: EquationDraft;
  canUseAi?: boolean;
  onClose: () => void;
  onDelete?: () => void;
  onSave: (latex: string) => void;
}) {
  const [latex, setLatex] = useState(draft.latex);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiPending, setAiPending] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewHtml = useMemo(() => {
    if (!latex.trim()) return "";
    try {
      return katex.renderToString(latex, {
        displayMode: draft.kind === "block",
        throwOnError: false,
        strict: false,
      });
    } catch {
      return "";
    }
  }, [draft.kind, latex]);

  const insertTemplate = (template: string) => {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? latex.length;
    const end = input?.selectionEnd ?? start;
    const next = `${latex.slice(0, start)}${template}${latex.slice(end)}`;
    setLatex(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + template.length, start + template.length);
    });
  };

  // Sends the description plus whatever is already in the source box, so a
  // failed render or an existing equation is fixed or improved in place
  // rather than regenerated from scratch.
  const generateWithAi = async () => {
    const description = aiPrompt.trim();
    if (!description || aiPending) return;
    setAiPending(true);
    setAiError(null);
    try {
      const response = await fetch("/api/equation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, prompt: description, latex, kind: draft.kind }),
      });
      const payload = await response.json().catch(() => null) as { latex?: string; modelSource?: "system" | "byok"; error?: string } | null;
      if (!response.ok || !payload || typeof payload.latex !== "string" || !payload.latex.trim()) {
        throw new Error(payload?.error || "The AI could not generate an equation.");
      }
      setLatex(payload.latex);
      if (payload.modelSource === "system") {
        }
    } catch (error) {
      setAiError(errorDetail(error, "The AI could not generate an equation."));
    } finally {
      setAiPending(false);
    }
  };

  const submit = () => {
    const value = latex.trim();
    if (value) onSave(value);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.pos === undefined ? "Insert" : "Edit"} {draft.kind === "block" ? "display" : "inline"} equation</DialogTitle>
          {/* <DialogDescription>
            Write LaTeX directly or insert a common structure{canUseAi ? ", or describe it with AI" : ""}. The preview updates as you type.
          </DialogDescription> */}
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-wrap gap-1.5" aria-label="Equation templates">
            {equationTemplates.map(([label, template]) => (
              <Button key={label} type="button" size="sm" variant="outline" onClick={() => insertTemplate(template)}>
                {label}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="beeblio-equation-source" className="text-sm font-medium">LaTeX</label>
            {canUseAi ? (
              <Button
                type="button"
                size="xs"
                variant={aiOpen ? "secondary" : "outline"}
                aria-pressed={aiOpen}
                onClick={() => { setAiOpen((open) => !open); setAiError(null); }}
              >
                Beeblio AI
              </Button>
            ) : null}
          </div>
          {canUseAi && aiOpen ? (
            <div className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <Input
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void generateWithAi();
                    }
                  }}
                  placeholder="Describe the equation in plain words…"
                  aria-label="Describe the equation for AI"
                  disabled={aiPending}
                />
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  // onClick={() => notifyUpcomingFeature("AI equation creation")}
                  onClick={() => void generateWithAi()}
                  disabled={aiPending || !aiPrompt.trim()}
                >
                  {aiPending ? <Loader2 className="animate-spin" /> : <PencilSparkles />}
                  Create
                </Button>
              </div>
              {aiError ? <p className="text-xs text-destructive">{aiError}</p> : null}
              {/* <p className="text-xs text-muted-foreground">
                {latex.trim()
                  ? "Your current LaTeX is included, so the AI fixes or improves it."
                  : "The result fills the LaTeX source below; the preview updates with it."}
              </p> */}
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            id="beeblio-equation-source"
            autoFocus
            value={latex}
            onChange={(event) => setLatex(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            spellCheck={false}
            className="min-h-28 resize-y font-mono text-sm leading-6"
            placeholder={draft.kind === "block" ? "\\int_{a}^{b} f(x) \\,dx" : "E = mc^2"}
          />
          <div className="rounded-lg border bg-muted/35 p-3">
            <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Preview</div>
            <div
              className={cn("min-h-16 overflow-x-auto rounded-md bg-background p-4", draft.kind === "block" ? "text-center" : "flex items-center")}
              aria-label="Equation preview"
              dangerouslySetInnerHTML={{ __html: previewHtml || '<span class="text-sm text-muted-foreground">Enter LaTeX to preview the equation.</span>' }}
            />
          </div>
        </div>

        <DialogFooter className={cn(onDelete && "sm:justify-between")}>
          {onDelete ? <Button type="button" variant="destructive" onClick={onDelete}>Delete Equation</Button> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={!latex.trim()} onClick={submit}>Save Equation</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LinkEditorDialog({
  draft,
  onClose,
  onRemove,
  onSave,
}: {
  draft: LinkDraft;
  onClose: () => void;
  onRemove?: () => void;
  onSave: (href: string, text: string) => void;
}) {
  const [href, setHref] = useState(draft.href);
  const [text, setText] = useState(draft.text);

  const submit = () => {
    if (href.trim()) onSave(href, text);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{draft.mode === "edit" ? "Edit link" : "Insert link"}</DialogTitle>
          <DialogDescription>
            Paste a URL — addresses without a protocol are prefixed with https://. In the document, Ctrl/Cmd + click a link to open it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="beeblio-link-text">Text</Label>
            <Input
              id="beeblio-link-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={draft.mode === "edit" || draft.text ? "Linked text" : "Text to display (defaults to the URL)"}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="beeblio-link-url">URL</Label>
            <Input
              id="beeblio-link-url"
              type="url"
              autoFocus
              value={href}
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="https://example.com"
              spellCheck={false}
            />
          </div>
        </div>

        <DialogFooter className={cn(onRemove && "sm:justify-between")}>
          {onRemove ? <Button type="button" variant="destructive" onClick={onRemove}><Unlink />Remove Link</Button> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={!href.trim()} onClick={submit}>Save Link</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImagePickerDialog({
  projectId,
  filePath,
  onClose,
  onInsertImage,
  onInsertMermaid,
}: {
  projectId: string;
  filePath: string;
  onClose: () => void;
  onInsertImage: (source: string, alt: string) => void;
  onInsertMermaid: (source: string) => void;
}) {
  const [tab, setTab] = useState<"workspace" | "url">("workspace");
  const [url, setUrl] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [inserting, setInserting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const browse = async (next: string) => {
    setFolderPath(next);
    setSelected(null);
    setLoading(true);
    try {
      setEntries(await listFiles(projectId, next));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setSelected(null);
    setLoading(true);
    listFiles(projectId, "")
      .then((result) => { if (!cancelled) { setEntries(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setEntries([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId]);

  const folders = (entries ?? []).filter((entry) => entry.isDir);
  const visuals = (entries ?? []).filter(isVisualFile);
  const segments = folderPath.split("/").filter(Boolean);

  const insertEntry = async (entry: FileEntry) => {
    if (isDiagramFile(entry)) {
      setInserting(true);
      try {
        const content = await getFileContent(projectId, entry.path);
        if (content === null) throw new Error("Diagram file is empty or unreadable.");
        onInsertMermaid(content);
      } catch (error) {
        setInserting(false);
        toast.error(`Unable to read ${entry.name}`, {
          description: errorDetail(error),
        });
      }
      return;
    }
    onInsertImage(workspacePathRelativeToDocument(filePath, entry.path), entry.name.replace(/\.[^.]+$/, ""));
  };

  // Uploads into the folder currently browsed in the dialog (same flow as the
  // file explorer), refreshes the listing, then inserts the new file into the
  // document. The picker filters by extension, but the check here stays because
  // accept can be bypassed ("All files" on some platforms).
  const uploadAndInsert = async (file: File) => {
    if (!isUploadableVisualName(file.name)) {
      toast.error(`Cannot insert ${file.name}`, {
        description: `Choose an image (${[...IMAGE_EXTENSIONS].join(", ")}) or a Mermaid diagram (${[...DIAGRAM_EXTENSIONS].join(", ")}).`,
      });
      return;
    }
    setUploading(true);
    try {
      const uploadable = await resizeImageForAgent(file);
      const result = await uploadWorkspaceFile(projectId, folderPath, uploadable);
      if (!result.success) {
        toast.error(isStorageLimitError(result.error) ? "Storage limit reached" : `Could not upload ${file.name}`, {
          description: isStorageLimitError(result.error)
            ? `${result.error} Manage files in the explorer or view your plan on the Usage page.`
            : result.error,
        });
        return;
      }
      window.dispatchEvent(new Event("beeblio:workspace-changed"));
      window.dispatchEvent(new Event("beeblio:storage-changed"));
      toast.success(`${result.file.name} uploaded`, { description: result.file.path });
      await browse(folderPath);
      void insertEntry(result.file);
    } catch (error) {
      toast.error(`Could not upload ${file.name}`, {
        description: errorDetail(error),
      });
    } finally {
      setUploading(false);
    }
  };

  const insertSelected = () => {
    if (tab === "url") {
      const value = url.trim();
      if (value) onInsertImage(value, "");
      return;
    }
    if (selected) void insertEntry(selected);
  };

  const canInsert = (tab === "url" ? url.trim().length > 0 : selected !== null) && !inserting && !uploading;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Insert image</DialogTitle>
          {/* <DialogDescription>
            Choose an image or Mermaid diagram (.mmd) from the project workspace, or paste an image URL. Workspace images are linked with a path relative to this document; diagrams are inserted as rendered Mermaid blocks.
          </DialogDescription> */}
        </DialogHeader>

        <div className="flex w-max rounded-md border bg-muted/40 p-0.5" role="tablist" aria-label="Image source">
          <Button type="button" size="xs" variant={tab === "workspace" ? "secondary" : "ghost"} role="tab" aria-selected={tab === "workspace"} onClick={() => setTab("workspace")}>From Workspace</Button>
          <Button type="button" size="xs" variant={tab === "url" ? "secondary" : "ghost"} role="tab" aria-selected={tab === "url"} onClick={() => setTab("url")}>From URL</Button>
        </div>

        {tab === "url" ? (
          <div className="grid gap-2">
            <Label htmlFor="beeblio-image-source">Image URL</Label>
            <Input
              id="beeblio-image-source"
              autoFocus
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  insertSelected();
                }
              }}
              placeholder="https://example.com/photo.jpg"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              You can also enter a path relative to this document (for example assets/figure.png).
            </p>
          </div>
        ) : (
          <>
          <div className="overflow-hidden rounded-xl border">
            <div className="flex h-9 items-stretch border-b text-xs">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2">
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void browse("")}
                >
                  Files
                </button>
                {segments.map((segment, index) => {
                  const destination = segments.slice(0, index + 1).join("/");
                  return (
                    <span key={destination} className="flex min-w-0 items-center gap-1">
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      <button
                        type="button"
                        className="max-w-32 truncate rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => void browse(destination)}
                      >
                        {segment}
                      </button>
                    </span>
                  );
                })}
              </div>
              <div className="flex shrink-0 items-center border-l pl-1 pr-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={uploading}
                  onClick={() => uploadInputRef.current?.click()}
                  title={`Upload an image or Mermaid diagram to ${folderPath || "Files"}`}
                >
                  {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
                  Upload
                </Button>
              </div>
            </div>
            <div className="max-h-80 min-h-40 overflow-y-auto p-2">
              {loading ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="grid gap-1">
                  {folders.map((folder) => (
                    <button
                      key={folder.path}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => void browse(folder.path)}
                    >
                      <Folder className="size-4 shrink-0 text-blue-500" />
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                  {visuals.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2 pt-1 sm:grid-cols-4">
                      {visuals.map((visual) => {
                        const isSelected = selected?.path === visual.path;
                        const diagram = isDiagramFile(visual);
                        return (
                          <button
                            key={visual.path}
                            type="button"
                            aria-pressed={isSelected}
                            title={visual.name}
                            className={cn(
                              "flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors",
                              isSelected ? "border-primary bg-primary/5 ring-2 ring-primary/25" : "border-transparent hover:bg-muted/60",
                            )}
                            onClick={() => setSelected(visual)}
                            onDoubleClick={() => void insertEntry(visual)}
                          >
                            <span className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted">
                              {diagram
                                ? <Workflow className="size-8 text-muted-foreground" aria-hidden />
                                : <img src={fileUrl(projectId, visual.path)} alt="" loading="lazy" className="size-full object-cover" />}
                            </span>
                            <span className="truncate text-[11px] text-muted-foreground">{visual.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {folders.length === 0 && visuals.length === 0 ? (
                    <div className="flex h-32 flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
                      <span>No images or diagrams in this folder.</span>
                      <span>Upload one with the button above, or paste a URL.</span>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
          <input
            type="file"
            ref={uploadInputRef}
            accept={UPLOADABLE_VISUAL_ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadAndInsert(file);
            }}
          />
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!canInsert} onClick={insertSelected}>
            {inserting ? <Loader2 className="animate-spin" /> : null}
            Insert Image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TableSizePicker({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ rows: 0, cols: 0 });

  const insert = (rows: number, cols: number) => {
    setOpen(false);
    setSize({ rows: 0, cols: 0 });
    editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSize({ rows: 0, cols: 0 }); }}>
      <PopoverTrigger asChild>
        <ToolbarButton label="Insert table" active={open} disabled={disabled}><Table2 /></ToolbarButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${TABLE_PICKER_COLS}, minmax(0, 1fr))` }}
          role="grid"
          aria-label="Choose table size"
          onMouseLeave={() => setSize({ rows: 0, cols: 0 })}
        >
          {Array.from({ length: TABLE_PICKER_ROWS * TABLE_PICKER_COLS }, (_, index) => {
            const row = Math.floor(index / TABLE_PICKER_COLS) + 1;
            const column = (index % TABLE_PICKER_COLS) + 1;
            const active = row <= size.rows && column <= size.cols;
            return (
              <button
                key={index}
                type="button"
                aria-label={`Insert a ${row} by ${column} table`}
                className={cn("size-4 rounded-[4px] border", active ? "border-primary bg-primary/70" : "border-border bg-muted/50 hover:bg-accent")}
                onMouseEnter={() => setSize({ rows: row, cols: column })}
                onFocus={() => setSize({ rows: row, cols: column })}
                onClick={() => insert(row, column)}
              />
            );
          })}
        </div>
        <p className="mt-2.5 text-center text-xs text-muted-foreground">
          {size.rows ? `${size.rows} × ${size.cols} table` : "Move over cells to size the table"}
          <span className="opacity-70"> · first row is the header</span>
        </p>
      </PopoverContent>
    </Popover>
  );
}

function TableMenu({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const run = (command: (chain: ReturnType<Editor["chain"]>) => void) => () => {
    const chain = editor?.chain().focus();
    if (!chain) return;
    command(chain);
    chain.run();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" disabled={disabled} aria-label="Table actions">
          Table<ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuItem onSelect={run((chain) => chain.addRowBefore())}><ArrowUpToLine />Insert row above</DropdownMenuItem>
        <DropdownMenuItem onSelect={run((chain) => chain.addRowAfter())}><ArrowDownToLine />Insert row below</DropdownMenuItem>
        <DropdownMenuItem onSelect={run((chain) => chain.addColumnBefore())}><ArrowLeftToLine />Insert column left</DropdownMenuItem>
        <DropdownMenuItem onSelect={run((chain) => chain.addColumnAfter())}><ArrowRightToLine />Insert column right</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={run((chain) => chain.deleteRow())}><Rows3 />Delete row</DropdownMenuItem>
        <DropdownMenuItem onSelect={run((chain) => chain.deleteColumn())}><Columns3 />Delete Column</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={run((chain) => chain.toggleHeaderRow())}>Toggle header row</DropdownMenuItem>
        <DropdownMenuItem onSelect={run((chain) => chain.toggleHeaderColumn())}>Toggle header column</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={run((chain) => chain.deleteTable())}><Trash2 />Delete table</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FigureToolbar({ editor }: { editor: Editor }) {
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const selection = current?.state.selection;
      if (!current || !isNodeSelection(selection) || selection.node.type.name !== "image") return null;
      const $from = current.state.doc.resolve(selection.from);
      const index = $from.index($from.depth);
      return {
        pos: selection.from,
        alt: String(selection.node.attrs.alt ?? ""),
        canMoveUp: index > 0,
        canMoveDown: index < $from.parent.childCount - 1,
      };
    },
  });
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [altDraft, setAltDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) {
      setAnchor(null);
      return;
    }
    const initialDom = editor.view.nodeDOM(selected.pos);
    const container = initialDom instanceof HTMLElement ? initialDom : null;
    container?.classList.add("beeblio-figure-selected");

    const update = () => {
      const dom = editor.view.nodeDOM(selected.pos);
      const root = dom instanceof HTMLElement ? dom : null;
      const img = root?.querySelector("img");
      const box = (img instanceof HTMLElement ? img : root)?.getBoundingClientRect();
      if (!box) {
        setAnchor(null);
        return;
      }
      let top = box.top - 36;
      let right = box.right;
      const scrollParent = findScrollParent(editor.view.dom.parentElement);
      if (scrollParent) {
        const bounds = scrollParent.getBoundingClientRect();
        // Follow the figure: hide once it scrolls fully out of the preview,
        // and while partially visible keep the toolbar inside the preview
        // instead of floating over the chrome above it.
        if (box.bottom < bounds.top || box.top > bounds.bottom) {
          setAnchor(null);
          return;
        }
        top = Math.min(Math.max(top, bounds.top + 4), bounds.bottom - 36);
        right = Math.min(Math.max(right, bounds.left + 48), bounds.right - 8);
      }
      setAnchor({ top, left: right });
    };
    update();
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    return () => {
      container?.classList.remove("beeblio-figure-selected");
      window.removeEventListener("scroll", update, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", update);
    };
  }, [editor, selected]);

  const moveSelectedFigure = (direction: 1 | -1) => {
    if (!selected) return;
    const selection = editor.state.selection;
    if (!isNodeSelection(selection)) return;
    const node = selection.node;
    const $from = editor.state.doc.resolve(selection.from);
    const index = $from.index($from.depth);
    const target = index + direction;
    if (target < 0 || target >= $from.parent.childCount) return;
    const sibling = $from.parent.child(target);
    let insertAt: number;
    if (direction === 1) {
      insertAt = selection.from + sibling.nodeSize;
    } else {
      insertAt = selection.from - sibling.nodeSize;
    }
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.delete(selection.from, selection.from + node.nodeSize);
        tr.insert(insertAt, node);
        return true;
      })
      .setNodeSelection(insertAt)
      .scrollIntoView()
      .run();
  };

  if (!selected || !anchor) return null;

  return (
    <>
      <div
        className="fixed z-40 flex -translate-x-full items-center gap-0.5 rounded-lg border bg-card/95 p-1 shadow-lg backdrop-blur"
        style={{ top: anchor.top, left: anchor.left }}
        role="toolbar"
        aria-label="Figure actions"
        contentEditable={false}
      >
        <Button size="icon-xs" variant="ghost" title="Move figure up" aria-label="Move figure up" disabled={!selected.canMoveUp} onClick={() => moveSelectedFigure(-1)}><ChevronUp /></Button>
        <Button size="icon-xs" variant="ghost" title="Move figure down" aria-label="Move figure down" disabled={!selected.canMoveDown} onClick={() => moveSelectedFigure(1)}><ChevronDown /></Button>
        <Button size="icon-xs" variant="ghost" title="Edit alt text" aria-label="Edit alt text" onClick={() => setAltDraft(selected.alt)}><Pencil /></Button>
        <Button size="icon-xs" variant="ghost" className="text-destructive hover:text-destructive" title="Delete figure" aria-label="Delete figure" onClick={() => editor.chain().focus().deleteSelection().run()}><Trash2 /></Button>
      </div>
      {altDraft === null ? null : (
        <Dialog open onOpenChange={(open) => { if (!open) setAltDraft(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Edit alt text</DialogTitle>
              <DialogDescription>
                Describes the figure for screen readers or where the image cannot load.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="beeblio-figure-alt">Alt text</Label>
              <Input
                id="beeblio-figure-alt"
                autoFocus
                value={altDraft}
                onChange={(event) => setAltDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    editor.chain().setNodeSelection(selected.pos).updateAttributes("image", { alt: altDraft }).focus().run();
                    setAltDraft(null);
                  }
                }}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAltDraft(null)}>Cancel</Button>
              <Button type="button" onClick={() => {
                editor.chain().setNodeSelection(selected.pos).updateAttributes("image", { alt: altDraft }).focus().run();
                setAltDraft(null);
              }}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function DocumentToolbar({
  editor,
  mode,
  onModeChange,
  onRequestInsertImage,
  onInsertEquation,
  onEditLink,
  citationStyle,
  onCitationStyleChange,
  showMarkdownMode = false,
}: {
  editor: Editor | null;
  mode: "visual" | "source";
  onModeChange?: (mode: "visual" | "source") => void;
  onRequestInsertImage?: () => void;
  onInsertEquation?: (kind: EquationKind) => void;
  onEditLink?: () => void;
  citationStyle?: CitationStyle;
  onCitationStyleChange?: (style: CitationStyle) => void;
  showMarkdownMode?: boolean;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => current ? {
      bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"),
      strike: current.isActive("strike"), code: current.isActive("code"),
      subscript: current.isActive("subscript"), superscript: current.isActive("superscript"),
      inlineMath: current.isActive("inlineMath"), blockMath: current.isActive("blockMath"),
      blockquote: current.isActive("blockquote"),
      bulletList: current.isActive("bulletList"), orderedList: current.isActive("orderedList"), taskList: current.isActive("taskList"),
      link: current.isActive("link"), table: current.isActive("table"),
      align: (["center", "right", "justify"].find((value) => current.isActive({ textAlign: value })) ?? "left"),
      block: current.isActive("heading", { level: 1 }) ? "h1" : current.isActive("heading", { level: 2 }) ? "h2" : current.isActive("heading", { level: 3 }) ? "h3" : current.isActive("codeBlock", { language: "mermaid" }) ? "mermaid" : current.isActive("codeBlock") ? "codeBlock" : current.isActive("blockquote") ? "blockquote" : "paragraph",
      fontFamily: String(current.getAttributes("textStyle").fontFamily ?? ""),
      fontSize: String(current.getAttributes("textStyle").fontSize ?? ""),
      color: String(current.getAttributes("textStyle").color ?? "#1f2937"),
    } : null,
  });

  const disabled = !editor || mode === "source";
  return (
    <div className="beeblio-tiptap-toolbar flex shrink-0 overflow-x-auto overflow-y-hidden border-b bg-card" role="toolbar" aria-label="Document formatting">
      <div className="flex h-10 w-max shrink-0 items-center gap-1 px-2 whitespace-nowrap">
        {showMarkdownMode ? <div className="mr-1 flex rounded-md border bg-muted/40 p-0.5">
          <Button size="icon-xs" variant={mode === "visual" ? "secondary" : "ghost"} onClick={() => onModeChange?.("visual")} title="Visual editor" aria-label="Visual editor"><Pilcrow /></Button>
          <Button size="icon-xs" variant={mode === "source" ? "secondary" : "ghost"} onClick={() => onModeChange?.("source")} title="Markdown source" aria-label="Markdown source"><Braces /></Button>
        </div> : null}

        {showMarkdownMode && citationStyle ? (
          <>
            <Select disabled={mode === "source"} value={citationStyle} onValueChange={(value) => onCitationStyleChange?.(value as CitationStyle)}>
              <SelectTrigger aria-label="Citation style" title="Citation style" className="!h-8 py-1.5 w-auto max-w-44 gap-1 bg-card px-2.5 text-xs shadow-none hover:bg-accent focus-visible:ring-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CITATION_STYLES.map(([value, label]) => (
                  <SelectItem className="py-1 text-xs" key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToolbarDivider />
          </>
        ) : null}

        <ToolbarButton label="Undo" disabled={disabled || !editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}><Undo2 /></ToolbarButton>
        <ToolbarButton label="Redo" disabled={disabled || !editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}><Redo2 /></ToolbarButton>
        <ToolbarDivider />

        <Select disabled={disabled} value={state?.block ?? "paragraph"} onValueChange={(value) => setBlock(editor, value)}>
          <SelectTrigger aria-label="Block type" className="!h-8 py-1.5 w-28 gap-1 bg-card px-2.5 text-xs shadow-none hover:bg-accent focus-visible:ring-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem className="py-1 text-xs" value="paragraph">Paragraph</SelectItem>
            <SelectItem className="py-1 text-xs" value="h1">Heading 1</SelectItem>
            <SelectItem className="py-1 text-xs" value="h2">Heading 2</SelectItem>
            <SelectItem className="py-1 text-xs" value="h3">Heading 3</SelectItem>
            <SelectItem className="py-1 text-xs" value="blockquote">Quote</SelectItem>
            <SelectItem className="py-1 text-xs" value="codeBlock">Code Block</SelectItem>
            <SelectItem className="py-1 text-xs" value="mermaid">Mermaid Diagram</SelectItem>
          </SelectContent>
        </Select>

        <Select disabled={disabled} value={state?.fontFamily || "default"} onValueChange={(value) => value !== "default" ? editor?.chain().focus().setFontFamily(value).run() : editor?.chain().focus().unsetFontFamily().run()}>
          <SelectTrigger aria-label="Font family" className="!h-8 py-1.5 w-32 gap-1 bg-card px-2.5 text-xs shadow-none hover:bg-accent focus-visible:ring-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fonts.map(([value, label]) => <SelectItem className="py-1 text-xs" key={label} value={value || "default"}>{label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select disabled={disabled} value={state?.fontSize || "default"} onValueChange={(value) => value !== "default" ? editor?.chain().focus().setFontSize(value).run() : editor?.chain().focus().unsetFontSize().run()}>
          <SelectTrigger aria-label="Font size" className="!h-8 py-1.5 w-[4.5rem] gap-1 bg-card px-2.5 text-xs shadow-none hover:bg-accent focus-visible:ring-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fontSizes.map(([value, label]) => <SelectItem className="py-1 text-xs" key={label} value={value || "default"}>{label}</SelectItem>)}
          </SelectContent>
        </Select>

        <ToolbarDivider />
        <ToolbarButton label="Bold" active={state?.bold} disabled={disabled} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold /></ToolbarButton>
        <ToolbarButton label="Italic" active={state?.italic} disabled={disabled} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic /></ToolbarButton>
        <ToolbarButton label="Underline" active={state?.underline} disabled={disabled} onClick={() => editor?.chain().focus().toggleUnderline().run()}><Underline /></ToolbarButton>
        <ToolbarButton label="Strikethrough" active={state?.strike} disabled={disabled} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough /></ToolbarButton>
        <ToolbarButton label="Inline code" active={state?.code} disabled={disabled} onClick={() => editor?.chain().focus().toggleCode().run()}><Code2 /></ToolbarButton>
        <ToolbarButton label="Subscript (Ctrl/Cmd + ,)" active={state?.subscript} disabled={disabled} onClick={() => editor?.chain().focus().unsetSuperscript().toggleSubscript().run()}><SubscriptIcon /></ToolbarButton>
        <ToolbarButton label="Superscript (Ctrl/Cmd + .)" active={state?.superscript} disabled={disabled} onClick={() => editor?.chain().focus().unsetSubscript().toggleSuperscript().run()}><SuperscriptIcon /></ToolbarButton>
        <label className="beeblio-tiptap-color" title="Text color"><span className="sr-only">Text color</span><input type="color" value={normalizeColor(state?.color)} disabled={disabled} onChange={(event) => editor?.chain().focus().setColor(event.target.value).run()} /></label>

        <ToolbarDivider />
        <ToolbarButton label="Clear formatting" disabled={disabled} onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting /></ToolbarButton>

        <ToolbarDivider />
        <ToolbarButton label="Align left" active={state?.align === "left"} disabled={disabled} onClick={() => editor?.chain().focus().setTextAlign("left").run()}><AlignLeft /></ToolbarButton>
        <ToolbarButton label="Align center" active={state?.align === "center"} disabled={disabled} onClick={() => editor?.chain().focus().setTextAlign("center").run()}><AlignCenter /></ToolbarButton>
        <ToolbarButton label="Align right" active={state?.align === "right"} disabled={disabled} onClick={() => editor?.chain().focus().setTextAlign("right").run()}><AlignRight /></ToolbarButton>
        <ToolbarButton label="Justify" active={state?.align === "justify"} disabled={disabled} onClick={() => editor?.chain().focus().setTextAlign("justify").run()}><AlignJustify /></ToolbarButton>

        <ToolbarDivider />
        <ToolbarButton label="Bullet list" active={state?.bulletList} disabled={disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List /></ToolbarButton>
        <ToolbarButton label="Numbered list" active={state?.orderedList} disabled={disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolbarButton>
        {showMarkdownMode ? <ToolbarButton label="Task list" active={state?.taskList} disabled={disabled} onClick={() => editor?.chain().focus().toggleTaskList().run()}><ListChecks /></ToolbarButton> : null}

        <ToolbarDivider />
        <ToolbarButton label="Quote" active={state?.blockquote} disabled={disabled} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote /></ToolbarButton>
        <ToolbarButton label="Link (Ctrl/Cmd + K)" active={state?.link} disabled={disabled} onClick={() => onEditLink?.()}><Link2 /></ToolbarButton>

        {showMarkdownMode ? (
          <>
            <ToolbarButton label="Insert Inline Equation" active={state?.inlineMath} disabled={disabled} onClick={() => onInsertEquation?.("inline")}><Sigma /></ToolbarButton>
            <ToolbarButton label="Insert Display Equation" active={state?.blockMath} disabled={disabled} onClick={() => onInsertEquation?.("block")}><Radical /></ToolbarButton>
          </>
        ) : null}

        {onRequestInsertImage ? <ToolbarButton label="Insert image" disabled={disabled} onClick={() => onRequestInsertImage()}><ImagePlus /></ToolbarButton> : null}

        {showMarkdownMode ? <TableSizePicker editor={editor} disabled={disabled} /> : null}

        {state?.table ? (
          <>
            <ToolbarDivider />
            <div className="flex items-center gap-0.5 rounded-lg bg-accent/70 px-1 py-0.5">
              <Button size="xs" variant="ghost" className="h-6" title="Add row below" aria-label="Add row below" disabled={disabled} onClick={() => editor?.chain().focus().addRowAfter().run()}><Plus className="size-3" /><Rows3 className="size-3" />Row</Button>
              <Button size="xs" variant="ghost" className="h-6" title="Add column on the right" aria-label="Add column on the right" disabled={disabled} onClick={() => editor?.chain().focus().addColumnAfter().run()}><Plus className="size-3" /><Columns3 className="size-3" />Column</Button>
              <TableMenu editor={editor} disabled={disabled} />
            </div>
          </>
        ) : null}

        <ToolbarDivider />
        <ToolbarButton label="Horizontal rule" disabled={disabled} onClick={() => editor?.chain().focus().setHorizontalRule().run()}><Minus /></ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton({ label, active, className, children, ...props }: React.ComponentProps<typeof Button> & { label: string; active?: boolean }) {
  return <Button type="button" size="icon-sm" variant={active ? "secondary" : "ghost"} className={cn("rounded-md", className)} title={label} aria-label={label} aria-pressed={active} {...props}>{children}</Button>;
}

function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  while (current && current !== document.body) {
    const overflowY = getComputedStyle(current).overflowY;
    if (/(auto|scroll|overlay)/.test(overflowY)) return current;
    current = current.parentElement;
  }
  return null;
}

function setBlock(editor: Editor | null, value: string) {
  if (!editor) return;
  const chain = editor.chain().focus();
  if (value === "h1") chain.setHeading({ level: 1 }).run();
  else if (value === "h2") chain.setHeading({ level: 2 }).run();
  else if (value === "h3") chain.setHeading({ level: 3 }).run();
  else if (value === "blockquote") chain.setBlockquote().run();
  else if (value === "codeBlock") chain.setCodeBlock().run();
  else if (value === "mermaid") chain.setCodeBlock({ language: "mermaid" }).run();
  else chain.setParagraph().run();
}

function normalizeColor(value: string | undefined) {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#1f2937";
}

function linkBibliographyUrls(value: string) {
  return value.split(/(https?:\/\/[^\s]+)/g).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    try {
      const url = new URL(part);
      if (url.protocol !== "http:" && url.protocol !== "https:") return part;
      return <a key={`${part}:${index}`} href={url.href} target="_blank" rel="noreferrer" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">{part}</a>;
    } catch {
      return part;
    }
  });
}

export function TableBubbleMenu({ editor }: { editor: Editor }) {
  if (!editor) return null;

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableBubbleMenu"
      shouldShow={({ editor }: { editor: Editor }) => editor.isActive("table")}
    >
      <div className="flex items-center gap-0.5 rounded-lg border bg-card p-1 shadow-lg backdrop-blur" role="toolbar" aria-label="Table actions">
        <Button size="icon-xs" variant="ghost" title="Add row above" onClick={() => editor.chain().focus().addRowBefore().run()}><ArrowUpToLine className="size-4" /></Button>
        <Button size="icon-xs" variant="ghost" title="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()}><ArrowDownToLine className="size-4" /></Button>
        <Button size="icon-xs" variant="ghost" title="Delete row" className="text-destructive hover:text-destructive" onClick={() => editor.chain().focus().deleteRow().run()}><Rows3 className="size-4" /></Button>
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        <Button size="icon-xs" variant="ghost" title="Add column left" onClick={() => editor.chain().focus().addColumnBefore().run()}><ArrowLeftToLine className="size-4" /></Button>
        <Button size="icon-xs" variant="ghost" title="Add column right" onClick={() => editor.chain().focus().addColumnAfter().run()}><ArrowRightToLine className="size-4" /></Button>
        <Button size="icon-xs" variant="ghost" title="Delete column" className="text-destructive hover:text-destructive" onClick={() => editor.chain().focus().deleteColumn().run()}><Columns3 className="size-4" /></Button>
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        {/* <Button size="icon-xs" variant="ghost" title="Delete table" className="text-destructive hover:text-destructive" onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 className="size-4" /></Button> */}
      </div>
    </BubbleMenu>
  );
}
