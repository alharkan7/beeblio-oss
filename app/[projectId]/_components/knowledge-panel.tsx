"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookMarked, ChevronDown, FileText, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { MessageResponse } from "@/components/ai-elements/message";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { KnowledgeDocumentDTO, KnowledgeSearchResult } from "@/lib/knowledge";
import { acceptsKnowledgeFile, KNOWLEDGE_MAX_FILE_BYTES } from "@/lib/knowledge-files";
import { REFERENCES_DIRECTORY } from "@/lib/research-workspace";
import { cn } from "@/lib/utils";
import { getWorkspaceDragPaths } from "@/lib/workspace-drag";
import { uploadWorkspaceFile } from "@/lib/workspace-upload";
import { addFileToKnowledge, listKnowledgeDocuments, removeFileFromKnowledge } from "../knowledge-actions";
import { listAllFiles, type FileEntry } from "../file-actions";
import { errorDetail } from "@/lib/error-detail";

type KnowledgePanelSnapshot = {
  documents: KnowledgeDocumentDTO[];
  files: FileEntry[];
};

// Navigation rail content is remounted when switching activities. Keep the
// latest successful result available so revisiting Knowledge is instant while
// the effect below reconciles it with the server in the background.
const knowledgePanelCache = new Map<string, KnowledgePanelSnapshot>();
const knowledgeSearchCache = new Map<string, { query: string; result: KnowledgeSearchResult }>();

function bytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function KnowledgePanel({ projectId, initialDocuments, initialFiles, onOpenFile }: { projectId: string; initialDocuments?: KnowledgeDocumentDTO[]; initialFiles?: FileEntry[]; onOpenFile: (file: FileEntry, pinned?: boolean) => void }) {
  const cachedSnapshot = knowledgePanelCache.get(projectId);
  const cachedSearch = knowledgeSearchCache.get(projectId);
  const [documents, setDocuments] = useState<KnowledgeDocumentDTO[]>(() => cachedSnapshot?.documents ?? initialDocuments ?? []);
  const [files, setFiles] = useState<FileEntry[]>(() => cachedSnapshot?.files ?? initialFiles ?? []);
  const [query, setQuery] = useState(() => cachedSearch?.query ?? "");
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(() => cachedSearch?.result ?? null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [documentToRemove, setDocumentToRemove] = useState<KnowledgeDocumentDTO | null>(null);
  const [loading, setLoading] = useState(() => !cachedSnapshot && initialDocuments === undefined);
  const [busyPaths, setBusyPaths] = useState<Set<string>>(() => new Set());
  const [isDragging, setIsDragging] = useState(false);
  const searchRequestRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);

  const clearSearch = useCallback(() => {
    searchRequestRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    knowledgeSearchCache.delete(projectId);
    setQuery("");
    setSearchResult(null);
    setSearchError(undefined);
    setIsSearching(false);
  }, [projectId]);

  useEffect(() => () => searchAbortRef.current?.abort(), []);

  const refresh = useCallback(async () => {
    try {
      const [nextDocuments, entries] = await Promise.all([listKnowledgeDocuments(projectId), listAllFiles(projectId)]);
      knowledgePanelCache.set(projectId, { documents: nextDocuments, files: entries });
      setDocuments(nextDocuments);
      setFiles(entries);
    } catch (error) {
      // A fixed id, because this runs on a timer while files index: a failing
      // agent should update one toast, not stack a new one every few seconds.
      toast.error("Could not load Knowledge", { id: "knowledge-load-failed", description: errorDetail(error) });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const knowledgeChanged = () => { clearSearch(); void refresh(); };
    const workspaceChanged = () => void refresh();
    window.addEventListener("beeblio:knowledge-changed", knowledgeChanged);
    window.addEventListener("beeblio:workspace-changed", workspaceChanged);
    return () => {
      window.removeEventListener("beeblio:knowledge-changed", knowledgeChanged);
      window.removeEventListener("beeblio:workspace-changed", workspaceChanged);
    };
  }, [clearSearch, refresh]);

  useEffect(() => {
    if (!documents.some((document) => document.status === "indexing" || document.status === "removing")) return;
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [documents, refresh]);

  const availableFiles = useMemo(() => files.filter((file) => !file.isDir && acceptsKnowledgeFile(file.name)), [files]);
  const filteredAvailableFiles = useMemo(() => {
    const search = pickerQuery.trim().toLocaleLowerCase();
    return search ? availableFiles.filter((file) => file.name.toLocaleLowerCase().includes(search) || file.path.toLocaleLowerCase().includes(search)) : availableFiles;
  }, [availableFiles, pickerQuery]);
  const readyCount = useMemo(() => documents.filter((document) => document.status === "ready").length, [documents]);

  const handleSearch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedQuery = query.trim();
    if (submittedQuery.length < 2 || isSearching || readyCount === 0) return;
    const requestId = ++searchRequestRef.current;
    const abortController = new AbortController();
    searchAbortRef.current = abortController;
    setIsSearching(true);
    setSearchError(undefined);
    setSearchResult({ answer: "", citations: [] });
    try {
      const response = await fetch("/api/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, query: submittedQuery }),
        signal: abortController.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Knowledge search failed.");
      }
      if (!response.body) throw new Error("Knowledge search did not return a stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      const handleEvent = (line: string) => {
        const event = JSON.parse(line) as
          | { type: "delta"; text: string }
          | { type: "result"; result: KnowledgeSearchResult }
          | { type: "error"; message: string };
        if (requestId !== searchRequestRef.current) return;
        if (event.type === "delta") {
          setSearchResult((current) => ({ answer: (current?.answer ?? "") + event.text, citations: current?.citations ?? [] }));
        } else if (event.type === "result") {
          completed = true;
          knowledgeSearchCache.set(projectId, { query: submittedQuery, result: event.result });
          setQuery(submittedQuery);
          setSearchResult(event.result);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) handleEvent(line);
          newline = buffer.indexOf("\n");
        }
        if (done) break;
      }
      if (buffer.trim()) handleEvent(buffer);
      if (!completed && requestId === searchRequestRef.current) throw new Error("Knowledge search ended before the answer was complete.");
    } catch (error) {
      if (requestId !== searchRequestRef.current) return;
      if (!abortController.signal.aborted) {
        setSearchError(errorDetail(error, "Knowledge search failed."));
        setSearchResult((current) => current?.answer ? current : null);
      }
    } finally {
      if (requestId === searchRequestRef.current) {
        searchAbortRef.current = null;
        setIsSearching(false);
      }
    }
  };

  const add = async (filePath: string) => {
    setBusyPaths((current) => new Set(current).add(filePath));
    try {
      const result = await addFileToKnowledge(projectId, filePath);
      if (result.kind === "configuration_error") {
        toast.error("Could not add to Knowledge", { description: result.error });
      } else if (result.kind === "already_exists") {
        toast.info("Already in Knowledge", { description: `${result.document.displayName} is already in this project's Knowledge.` });
      } else {
        clearSearch();
        setDocuments((current) => {
          const next = [...current.filter((item) => item.id !== result.document.id), result.document].sort((a, b) => a.displayName.localeCompare(b.displayName));
          knowledgePanelCache.set(projectId, { documents: next, files });
          return next;
        });
        toast.success("Added to Knowledge", { description: `${result.document.displayName} is processing in the background.` });
      }
    } catch (error) {
      toast.error("Could not add to Knowledge", { description: errorDetail(error) });
    } finally {
      setBusyPaths((current) => { const next = new Set(current); next.delete(filePath); return next; });
    }
  };

  const remove = async (document: KnowledgeDocumentDTO) => {
    setBusyPaths((current) => new Set(current).add(document.filePath));
    try {
      await removeFileFromKnowledge(projectId, document.id);
      setDocuments((current) => {
        const next = current.filter((item) => item.id !== document.id);
        knowledgePanelCache.set(projectId, { documents: next, files });
        return next;
      });
      setDocumentToRemove(null);
      toast.success("File removed from Knowledge");
      window.dispatchEvent(new CustomEvent("beeblio:knowledge-changed"));
    } catch (error) {
      toast.error("Could not remove from Knowledge", { description: errorDetail(error) });
    } finally {
      setBusyPaths((current) => { const next = new Set(current); next.delete(document.filePath); return next; });
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const workspacePaths = getWorkspaceDragPaths(event.dataTransfer);
    if (workspacePaths.length) {
      const accepted = workspacePaths.filter((candidate) => acceptsKnowledgeFile(candidate));
      if (accepted.length !== workspacePaths.length) toast.error("Some files were skipped", { description: "Their file type is not supported by Knowledge." });
      for (const candidate of accepted) void add(candidate);
      return;
    }
    const dropped = Array.from(event.dataTransfer.files);
    const accepted = dropped.filter((file) => acceptsKnowledgeFile(file.name) && file.size <= KNOWLEDGE_MAX_FILE_BYTES);
    if (accepted.length !== dropped.length) toast.error("Some files were skipped", { description: "Knowledge accepts supported documents, text, code, and images up to 100 MB." });
    for (const file of accepted) {
      const result = await uploadWorkspaceFile(projectId, REFERENCES_DIRECTORY, file);
      if (!result.success) {
        toast.error(`Could not upload ${file.name}`, { description: result.error });
        continue;
      }
      setFiles((current) => {
        const next = [...current.filter((item) => item.path !== result.file.path), result.file];
        knowledgePanelCache.set(projectId, { documents, files: next });
        return next;
      });
      void add(result.file.path);
    }
    if (accepted.length) window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
  };

  return <div className="relative flex min-h-0 flex-1 flex-col" onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setIsDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false); }} onDrop={(event) => void handleDrop(event)}>
    <div className="space-y-3 border-b p-3">
      <div><h2 className="text-sm font-semibold">Knowledge Base</h2><p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">Files content the agent can search in details.</p></div>
      <form className="flex items-center gap-2" onSubmit={(event) => void handleSearch(event)}><div className="relative min-w-0 flex-1">
        {isSearching ? <Loader2 className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" /> : <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />}
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Knowledge…" aria-label="Search Knowledge" className="h-8 pl-7 text-xs md:text-xs" disabled={loading || readyCount === 0} /></div>
        <Button type="button" size="icon-sm" variant="default" className="shrink-0 rounded-full"
        onClick={() => setPickerOpen(true)}
        aria-label="Add file to Knowledge" title="Add file to Knowledge"><Plus /></Button>
      </form>
      {searchError ? <p className="text-[10px] text-destructive" role="alert">{searchError}</p> : null}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {loading ? <div className="flex h-28 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : searchResult ? <KnowledgeSearchResults result={searchResult} files={files} onOpenFile={onOpenFile} onClear={clearSearch} isSearching={isSearching} hasError={Boolean(searchError)} /> : documents.length ? <div className="space-y-1">
        {documents.map((document) => {
          const file = files.find((item) => item.path === document.filePath);
          const busy = busyPaths.has(document.filePath);
          return <div key={document.id} className="group rounded-lg border border-transparent p-2 hover:border-border hover:bg-card">
            <div className="flex items-start gap-2">
              <button className="flex min-w-0 flex-1 items-start gap-2 text-left" disabled={!file} onClick={() => file && onOpenFile(file)}>
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-600"><FileText className="size-4" /></span>
                <span className="min-w-0"><span className="block truncate text-xs font-medium">{document.displayName}</span><span className="block truncate text-[10px] text-muted-foreground">{document.filePath} · {bytes(document.sizeBytes)}</span>{document.citationKey ? <span className="block truncate font-mono text-[10px] text-muted-foreground">[@{document.citationKey}]</span> : null}<span className={cn("mt-1 block text-[10px]", document.status === "ready" ? "text-emerald-600" : document.status === "failed" ? "text-destructive" : "text-amber-600")}>{document.status === "ready" ? "Ready" : document.status === "failed" ? document.error || "Processing failed" : document.status === "removing" ? "Removing…" : "Processing…"}</span></span>
              </button>
              <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => setDocumentToRemove(document)} aria-label={`Remove ${document.displayName} from Knowledge`}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}</Button>
            </div>
            {document.status === "failed" ? <Button size="xs" variant="ghost" className="mt-1 ml-9" disabled={busy} onClick={() => void add(document.filePath)}><RefreshCw />Retry</Button> : null}
          </div>;
        })}
      </div> : <div className="flex h-52 flex-col items-center justify-center px-5 text-center"><span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary/8 text-primary"><BookMarked className="size-5" /></span><p className="text-sm font-medium">No Knowledge files yet</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Add a workspace file so the agent can search it without attaching it to every chat.</p>
        <Button size="sm" className="mt-4"
        onClick={() => setPickerOpen(true)}
        >
          <Plus />Add file</Button></div>}
    </div>
    <Dialog open={pickerOpen} onOpenChange={(open) => { setPickerOpen(open); if (!open) setPickerQuery(""); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Add to Knowledge</DialogTitle><DialogDescription>Select supported workspace files up to 100 MB. Added files process in the background.</DialogDescription></DialogHeader><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input type="search" value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Search workspace files…" aria-label="Search workspace files" className="pl-8" /></div><div className="max-h-80 overflow-y-auto rounded-lg border p-1">{filteredAvailableFiles.length ? filteredAvailableFiles.map((file) => { const existing = documents.find((item) => item.filePath === file.path); const busy = busyPaths.has(file.path); return <button key={file.path} disabled={busy || file.size > KNOWLEDGE_MAX_FILE_BYTES} className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-muted disabled:opacity-45" onClick={() => void add(file.path)}><FileText className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{file.name}</span><span className="block truncate text-[10px] text-muted-foreground">{file.path} · {bytes(file.size)}</span></span>{busy ? <Loader2 className="size-4 animate-spin" /> : existing ? <span className="text-[10px] text-muted-foreground">{existing.status === "ready" ? "Added" : existing.status}</span> : <Plus className="size-4" />}</button>; }) : <p className="p-6 text-center text-xs text-muted-foreground">{availableFiles.length ? "No files match your search." : "No supported workspace files are available."}</p>}</div><p className="text-[11px] text-muted-foreground">You can also drag workspace files here, or drop files from your computer to upload them into References and add them.</p><DialogFooter><Button variant="outline" onClick={() => setPickerOpen(false)}>Done</Button></DialogFooter></DialogContent></Dialog>
    <AlertDialog open={documentToRemove !== null} onOpenChange={(open) => { if (!open && !busyPaths.has(documentToRemove?.filePath ?? "")) setDocumentToRemove(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove from Knowledge?</AlertDialogTitle>
          <AlertDialogDescription>
            Remove <span className="font-medium text-foreground">{documentToRemove?.displayName}</span> from Knowledge? The file will remain in your project folder.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={documentToRemove ? busyPaths.has(documentToRemove.filePath) : false}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!documentToRemove || busyPaths.has(documentToRemove.filePath)} onClick={() => { if (documentToRemove) void remove(documentToRemove); }}>
            {documentToRemove && busyPaths.has(documentToRemove.filePath) ? <Loader2 className="animate-spin" /> : null}Remove from Knowledge
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {isDragging ? <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 text-center shadow-lg"><div><BookMarked className="mx-auto mb-2 size-6 text-primary" /><p className="text-sm font-medium">Add to Knowledge</p><p className="mt-1 text-xs text-muted-foreground">Drop supported files here</p></div></div> : null}
  </div>;
}

function KnowledgeSearchResults({ result, files, onOpenFile, onClear, isSearching, hasError }: { result: KnowledgeSearchResult; files: FileEntry[]; onOpenFile: (file: FileEntry, pinned?: boolean) => void; onClear: () => void; isSearching: boolean; hasError: boolean }) {
  return <div className="space-y-3 p-1">
    <div className="flex items-center justify-between gap-2">
      <Button type="button" size="xs" variant="ghost" onClick={onClear}><ArrowLeft />Knowledge Files</Button>
    </div>
    <div className="rounded-xl border bg-card p-3 text-xs leading-5">
      {result.answer ? <MessageResponse className="knowledge-answer-markdown text-xs leading-5">{result.answer}</MessageResponse> : null}
      {isSearching ? <div className={cn("flex items-center gap-1.5 text-[11px] text-muted-foreground", result.answer && "mt-2")} role="status"><Loader2 className="size-3 animate-spin" />{result.answer ? "Still generating…" : "Searching your files…"}</div> : null}
    </div>
    {result.citations.length ? <div>
      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sources</p>
      <div className="space-y-1.5">{result.citations.map((citation, index) => {
        const normalizedPath = citation.filePath.replace(/^\/workspace\//, "");
        const file = files.find((candidate) => candidate.path === normalizedPath || candidate.path === citation.filePath);
        const key = `${citation.filePath}:${citation.pageNumber ?? ""}:${index}`;
        if (!citation.excerpt) {
          return <button type="button" key={key} disabled={!file} onClick={() => file && onOpenFile(file)} className="w-full rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-muted/55 disabled:cursor-default">
            <span className="flex items-center gap-2"><FileText className="size-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-xs font-medium">{citation.fileName}</span>{citation.citationKey ? <span className="shrink-0 font-mono text-[10px] text-muted-foreground">[@{citation.citationKey}]</span> : null}{citation.pageNumber ? <span className="shrink-0 text-[10px] text-muted-foreground">p. {citation.pageNumber}</span> : null}</span>
          </button>;
        }
        return <Collapsible key={key}>
          <CollapsibleTrigger
            className="group w-full rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-muted/55"
            onClick={(event) => {
              if (!file) return;
              // dataset.state is the pre-toggle state; "closed" means this click expands the item.
              if (event.currentTarget.dataset.state !== "closed") return;
              onOpenFile(file);
            }}
          >
            <span className="flex items-center gap-2"><FileText className="size-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-xs font-medium">{citation.fileName}</span>{citation.citationKey ? <span className="shrink-0 font-mono text-[10px] text-muted-foreground">[@{citation.citationKey}]</span> : null}{citation.pageNumber ? <span className="shrink-0 text-[10px] text-muted-foreground">p. {citation.pageNumber}</span> : null}<ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" /></span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1.5 border-l-2 border-primary/20 pl-2 text-[10px] leading-4 text-muted-foreground">
              <MessageResponse className="knowledge-answer-markdown knowledge-source-markdown text-[10px] leading-4">{citation.excerpt}</MessageResponse>
            </div>
          </CollapsibleContent>
        </Collapsible>;
      })}</div>
    </div> : !isSearching && !hasError ? <p className="px-2 text-[11px] text-muted-foreground">No source passages were returned for this answer.</p> : null}
  </div>;
}
