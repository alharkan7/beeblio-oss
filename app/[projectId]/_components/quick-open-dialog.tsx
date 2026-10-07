"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { bibliographyReferences, type CitationReference } from "@/lib/citations";
import { setPendingLibraryFocus, LIBRARY_REFERENCE_FOCUS_EVENT } from "@/lib/library-focus";
import {
  OPEN_LITERATURE_SEARCH_EVENT,
  type LiteratureItem,
} from "@/lib/literature/types";
import {
  PROJECT_BIBLIOGRAPHY_NAME,
  PROJECT_BIBLIOGRAPHY_PATH,
} from "@/lib/project-bibliography";
import { announceWorkspaceChange } from "@/lib/workspace-change";
import { getFileContent, listAllFiles, type FileEntry } from "../file-actions";
import { saveLiteratureCitation, searchLiterature } from "../literature-actions";
import { errorDetail } from "@/lib/error-detail";

const FILE_RESULT_LIMIT = 100;
const LIBRARY_RESULT_LIMIT = 8;
const LIBRARY_IDLE_RESULT_LIMIT = 5;
const LITERATURE_RESULT_LIMIT = 5;
const MIN_LITERATURE_QUERY = 2;

const BIBLIOGRAPHY_FILE: FileEntry = {
  name: PROJECT_BIBLIOGRAPHY_NAME,
  path: PROJECT_BIBLIOGRAPHY_PATH,
  isDir: false,
  size: 0,
};

type LiteratureState = {
  results: LiteratureItem[];
  searching: boolean;
  error?: string;
  searchedQuery: string | null;
  savingId?: string;
};

const IDLE_LITERATURE: LiteratureState = { results: [], searching: false, searchedQuery: null };

// Quick Open (⌘P / Ctrl+P) searches three sources: every workspace file, the
// reference library behind references.bib, and — on demand — the online
// literature providers. All matching and ranking happens here, so the cmdk
// root runs with shouldFilter disabled and renders exactly these tiers.
export function QuickOpenDialog({
  projectId,
  open,
  onOpenChange,
  seedFiles,
  openFiles,
  activeFilePath,
  onOpenFile,
  onOpenFileWithCue,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seedFiles: FileEntry[];
  openFiles: FileEntry[];
  activeFilePath?: string;
  onOpenFile: (file: FileEntry) => void;
  onOpenFileWithCue: (file: FileEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileEntry[]>(seedFiles);
  const [filesLoading, setFilesLoading] = useState(false);
  const [references, setReferences] = useState<CitationReference[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [literature, setLiterature] = useState<LiteratureState>(IDLE_LITERATURE);
  const queryRef = useRef(query);
  queryRef.current = query;

  // Both sources refresh on every open: uploads and saved citations land
  // between opens, and the previous list stays visible while refreshing.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setLiterature(IDLE_LITERATURE);
      return;
    }

    let cancelled = false;
    setFilesLoading(true);
    listAllFiles(projectId)
      .then((entries) => { if (!cancelled) setFiles(entries); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setFilesLoading(false); });

    setReferencesLoading(true);
    getFileContent(projectId, PROJECT_BIBLIOGRAPHY_PATH)
      .then((source) => {
        if (!cancelled) setReferences(source ? bibliographyReferences(source) : []);
      })
      .catch(() => { if (!cancelled) setReferences([]); })
      .finally(() => { if (!cancelled) setReferencesLoading(false); });

    return () => { cancelled = true; };
  }, [projectId, open]);

  const openQuickFiles = useMemo(() => openFiles.filter((file) => !file.isDir), [openFiles]);

  const persistedFiles = useMemo(() => {
    const byPath = new Map<string, FileEntry>();
    for (const file of files) {
      if (!file.isDir) byPath.set(file.path, file);
    }
    return [...byPath.values()];
  }, [files]);

  const matchingFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const openPaths = new Set(openQuickFiles.map((file) => file.path));
    const candidates = new Map<string, FileEntry>();
    for (const file of [...openQuickFiles, ...persistedFiles]) {
      candidates.set(file.path, file);
    }

    return [...candidates.values()]
      .filter((file) => {
        if (!normalized) return true;
        const path = file.path.toLocaleLowerCase();
        return normalized.split(/\s+/).every((part) => path.includes(part));
      })
      .sort((a, b) => {
        if (!normalized) {
          const openComparison = Number(openPaths.has(b.path)) - Number(openPaths.has(a.path));
          if (openComparison) return openComparison;
        }
        const aName = a.name.toLocaleLowerCase();
        const bName = b.name.toLocaleLowerCase();
        const rank = (name: string, path: string) =>
          name === normalized ? 0 : name.startsWith(normalized) ? 1 : name.includes(normalized) ? 2 : path.includes(normalized) ? 3 : 4;
        const rankComparison = rank(aName, a.path.toLocaleLowerCase()) - rank(bName, b.path.toLocaleLowerCase());
        return rankComparison || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      })
      .slice(0, FILE_RESULT_LIMIT);
  }, [openQuickFiles, persistedFiles, query]);

  // Library entries match across the fields a researcher would recall —
  // title, authors, year, venue, DOI, or the citation key itself.
  const matchingReferences = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return references.slice(0, LIBRARY_IDLE_RESULT_LIMIT);
    return references
      .filter((reference) => {
        const haystack = [
          reference.title,
          reference.authors,
          reference.year,
          reference.container,
          reference.doi,
          reference.id,
        ].filter(Boolean).join(" ").toLocaleLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .slice(0, LIBRARY_RESULT_LIMIT);
  }, [query, references]);

  // The online tier only appears once the query is long enough for the
  // search action (min 2 chars) and shows results solely for the query that
  // fetched them, so continuing to type falls back to the action row alone.
  const trimmedQuery = query.trim();
  const literatureEnabled = trimmedQuery.length >= MIN_LITERATURE_QUERY;
  const literatureMatchesQuery = literature.searchedQuery === trimmedQuery;
  const literatureResults = literatureEnabled && literatureMatchesQuery
    ? literature.results.slice(0, LITERATURE_RESULT_LIMIT)
    : [];
  const literatureResultsShown = literatureEnabled && literatureMatchesQuery
    && !literature.searching && !literature.error;

  const runLiteratureSearch = async () => {
    const searchQuery = queryRef.current.trim();
    if (searchQuery.length < MIN_LITERATURE_QUERY || literature.searching || literature.savingId) return;
    setLiterature({ results: [], searching: true, searchedQuery: searchQuery });
    try {
      const response = await searchLiterature({
        projectId,
        query: searchQuery,
        source: "all",
        openAccessOnly: false,
        page: 1,
      });
      // Drop responses that outlived their query: the user may have closed
      // the palette or kept typing while the providers answered.
      if (queryRef.current.trim() !== searchQuery) return;
      setLiterature({ results: response.items, searching: false, searchedQuery: searchQuery });
    } catch (error) {
      if (queryRef.current.trim() !== searchQuery) return;
      setLiterature({
        results: [],
        searching: false,
        searchedQuery: searchQuery,
        error: errorDetail(error, "Literature search failed."),
      });
    }
  };

  const openBibliographyAt = (citationKey: string) => {
    // Stage the focus before opening: a freshly mounting bibliography editor
    // consumes the pending pick, while one that is already mounted takes the
    // event (and refreshes its text after a save through the reload event).
    setPendingLibraryFocus({ citationKey });
    window.dispatchEvent(new CustomEvent("beeblio:reload-workspace-file", {
      detail: { path: PROJECT_BIBLIOGRAPHY_PATH },
    }));
    window.dispatchEvent(new CustomEvent(LIBRARY_REFERENCE_FOCUS_EVENT, { detail: { citationKey } }));
    onOpenFileWithCue(BIBLIOGRAPHY_FILE);
  };

  const chooseFile = (file: FileEntry) => {
    onOpenChange(false);
    onOpenFile(file);
  };

  const chooseReference = (reference: CitationReference) => {
    onOpenChange(false);
    openBibliographyAt(reference.id);
  };

  // A web result must exist in references.bib to be usable, so selecting one
  // saves it first and then lands the library on the saved entry — the same
  // flow as the editor's "@" menu minus the in-document citation insertion.
  const chooseLiteratureItem = async (item: LiteratureItem) => {
    if (literature.savingId) return;
    setLiterature((current) => ({ ...current, savingId: item.id }));
    try {
      const result = await saveLiteratureCitation({ projectId, item });
      if (!result.success || !result.citationKey) {
        toast.error("Could not save the citation", { description: result.error });
        setLiterature((current) => ({ ...current, savingId: undefined }));
        return;
      }
      // Clears the client text cache so the bibliography opens with the new entry.
      announceWorkspaceChange([{ path: PROJECT_BIBLIOGRAPHY_PATH, content: result.bibliographyContent }]);
      onOpenChange(false);
      openBibliographyAt(result.citationKey);
      toast.success(result.alreadyExisted ? "Citation already in your library" : "Citation saved to your library", {
        description: result.citationPath,
      });
    } catch (error) {
      toast.error("Could not save the citation", {
        description: errorDetail(error),
      });
      setLiterature((current) => ({ ...current, savingId: undefined }));
    }
  };

  // Hands the query to the Literature rail, which runs the full search with
  // filters, paging, and save/PDF actions this palette does not offer.
  const openLiteraturePanel = () => {
    const searchQuery = queryRef.current.trim();
    onOpenChange(false);
    if (searchQuery) {
      window.dispatchEvent(new CustomEvent(OPEN_LITERATURE_SEARCH_EVENT, {
        detail: { query: searchQuery },
      }));
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick Open"
      description="Search workspace files, your reference library, or online literature"
      showCloseButton={false}
      className="top-[22%] translate-y-0 sm:max-w-xl"
      commandProps={{ shouldFilter: false }}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search files, your library, or literature…"
      />
      <CommandList className="max-h-[min(55dvh,26rem)]">
        <CommandEmpty>
          {filesLoading || referencesLoading ? "Loading workspace…" : "No matching files or references."}
        </CommandEmpty>
        {matchingFiles.length > 0 ? (
          <CommandGroup heading={trimmedQuery ? "Files" : "Your Workspace Files"}>
            {matchingFiles.map((file) => {
              const parentPath = file.path.length > file.name.length
                ? file.path.slice(0, file.path.length - file.name.length - 1)
                : "Project root";
              return (
                <CommandItem
                  key={file.path}
                  value={file.path}
                  onSelect={() => chooseFile(file)}
                  className="min-w-0"
                >
                  <span className="-mt-0.5 self-start">
                    <FileTabIcon name={file.name} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{file.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{parentPath}</span>
                  </span>
                  {activeFilePath === file.path ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">Current</span>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {matchingReferences.length > 0 || referencesLoading ? (
          <CommandGroup heading="Library">
            {matchingReferences.map((reference) => (
              <CommandItem
                key={`library:${reference.id}`}
                value={`library:${reference.id}`}
                onSelect={() => chooseReference(reference)}
                className="min-w-0"
              >
                <BookOpen className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{reference.title || reference.id}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {[reference.authors, reference.year].filter(Boolean).join(" · ") || reference.id}
                  </span>
                </span>
                <span
                  className="max-w-[16ch] shrink-0 truncate font-mono text-[10px] text-muted-foreground"
                  title={reference.id}
                >
                  {reference.id}
                </span>
              </CommandItem>
            ))}
            {referencesLoading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Loading Library
              </div>
            ) : null}
          </CommandGroup>
        ) : null}
        {literatureEnabled ? (
          <CommandGroup heading={literatureResultsShown ? `Literature Matching “${trimmedQuery}”` : "Literature Search"}>
            {!literatureResultsShown ? (
              <CommandItem value="literature:search" onSelect={() => void runLiteratureSearch()}>
                {literature.searching && literatureMatchesQuery ? <Loader2 className="animate-spin" /> : <Search />}
                <span className="min-w-0 flex-1 truncate">
                  {literature.searching && literatureMatchesQuery
                    ? `Searching literature for “${trimmedQuery}”…`
                    : `Search online literature for “${trimmedQuery}”`}
                </span>
                {/* <span className="shrink-0 text-[10px] text-muted-foreground">OpenAlex · Crossref · PubMed</span> */}
              </CommandItem>
            ) : null}
            {literatureMatchesQuery && literature.error ? (
              <div className="px-3 py-2 text-center text-xs text-destructive">{literature.error}</div>
            ) : null}
            {literatureResults.map((item) => {
              const saving = literature.savingId === item.id;
              const details = [item.year, item.authors.slice(0, 2).join(", "), item.venue].filter(Boolean).join(" · ");
              return (
                <CommandItem
                  key={`literature:${item.id}`}
                  value={`literature:${item.id}`}
                  onSelect={() => void chooseLiteratureItem(item)}
                  className="min-w-0"
                >
                  {saving ? <Loader2 className="animate-spin" /> : <BookOpen className="size-4 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{item.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {saving ? "Saving to your library…" : details || "Web result"}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
            {literatureResultsShown && literatureResults.length === 0 ? (
              <div className="px-3 py-2 text-center text-xs text-muted-foreground">No online results.</div>
            ) : null}
            {literatureResults.length > 0 ? (
              <CommandItem value="literature:more" onSelect={openLiteraturePanel}>
                <ArrowUpRight />
                <span className="min-w-0 flex-1 truncate">More Results</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">Literature Panel</span>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}
        {filesLoading && matchingFiles.length > 0 ? (
          <div className="flex items-center justify-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Refreshing Files
          </div>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

function FileTabIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase();
  return <span className="w-4 shrink-0 text-[9px] font-semibold uppercase text-primary">{ext?.slice(0, 3) || "file"}</span>;
}
