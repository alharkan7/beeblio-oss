"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowUp10,
  ArrowDownAZ,
  ArrowDown10,
  ArrowUpAZ,
  BookOpenText,
  CalendarArrowDown,
  CalendarArrowUp,
  Check,
  FileCheck2,
  FileDown,
  Loader2,
  ListFilter,
  Search,
  Table2,
  TriangleAlert, Bookmark, BookmarkCheck
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OPEN_WORKSPACE_FILE_EVENT } from "@/lib/chat-context";
import { PROJECT_BIBLIOGRAPHY_PATH } from "@/lib/project-bibliography";
import { announceWorkspaceChange } from "@/lib/workspace-change";
import { cn } from "@/lib/utils";
import type {
  LiteratureItem,
  LiteratureSearchResponse,
  LiteratureSourceSelection,
} from "@/lib/literature/types";
import {
  getLiteratureSavedState,
  saveLiteratureCitation,
  saveLiteraturePdf,
  searchLiterature,
} from "../literature-actions";
import { getMatrixSavedState } from "../matrix-actions";
import { ReferenceSheet, literatureSourceLabels as sourceLabels, referenceFromSearchItem } from "./reference-sheet";
import { MatrixTargetDialog, useMatrixAdd, type MatrixAddRequest } from "./matrix-add";
import { rememberLiteratureMatrixPaths } from "./matrix-membership-cache";
import { errorDetail } from "@/lib/error-detail";

type LiteratureSort = "relevance" | "year-desc" | "year-asc" | "citations-desc" | "citations-asc" | "title-asc" | "title-desc";
type SearchDefinition = Pick<LiteratureSearchSnapshot, "query" | "source" | "openAccessOnly">;

type LiteratureSearchSnapshot = {
  query: string;
  source: LiteratureSourceSelection;
  openAccessOnly: boolean;
  results: LiteratureSearchResponse;
  sort?: LiteratureSort;
  savedCitationIds: string[];
  savedPdfIds: string[];
  savedPdfPaths?: Record<string, string>;
  savedMatrixIds?: string[];
};

function snapshotKey(projectId: string) {
  return `beeblio:literature-search:${projectId}`;
}

function readSnapshot(projectId: string): LiteratureSearchSnapshot | undefined {
  try {
    const raw = window.sessionStorage.getItem(snapshotKey(projectId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<LiteratureSearchSnapshot>;
    const validSource = value.source === "all" || Object.hasOwn(sourceLabels, value.source || "");
    if (
      typeof value.query !== "string" ||
      !validSource ||
      typeof value.openAccessOnly !== "boolean" ||
      !value.results ||
      !Array.isArray(value.results.items) ||
      !Array.isArray(value.results.providers)
    ) return undefined;
    return {
      query: value.query,
      source: value.source as LiteratureSourceSelection,
      openAccessOnly: value.openAccessOnly,
      results: {
        ...value.results,
        page: Number.isInteger(value.results.page) ? value.results.page : 1,
        hasMore: Boolean(value.results.hasMore),
      },
      sort: isLiteratureSort(value.sort) ? value.sort : "relevance",
      savedCitationIds: Array.isArray(value.savedCitationIds) ? value.savedCitationIds : [],
      savedPdfIds: Array.isArray(value.savedPdfIds) ? value.savedPdfIds : [],
      savedPdfPaths: value.savedPdfPaths && typeof value.savedPdfPaths === "object"
        ? value.savedPdfPaths
        : {},
      savedMatrixIds: Array.isArray(value.savedMatrixIds) ? value.savedMatrixIds : [],
    };
  } catch {
    return undefined;
  }
}

function isLiteratureSort(value: unknown): value is LiteratureSort {
  return ["relevance", "year-desc", "year-asc", "citations-desc", "citations-asc", "title-asc", "title-desc"].includes(String(value));
}

function writeSnapshot(projectId: string, snapshot: LiteratureSearchSnapshot) {
  try {
    window.sessionStorage.setItem(snapshotKey(projectId), JSON.stringify(snapshot));
  } catch {
    // Search still works if storage is disabled or its quota has been reached.
  }
}

function updateSnapshotSavedState(
  projectId: string,
  citationIds: Set<string>,
  pdfPaths: Record<string, string>,
  matrixIds?: Set<string>,
) {
  const snapshot = readSnapshot(projectId);
  if (!snapshot) return;
  writeSnapshot(projectId, {
    ...snapshot,
    savedCitationIds: [...citationIds],
    savedPdfIds: Object.keys(pdfPaths),
    savedPdfPaths: pdfPaths,
    savedMatrixIds: matrixIds ? [...matrixIds] : snapshot.savedMatrixIds,
  });
}

function itemIdentity(item: LiteratureItem) {
  if (item.doi) return `doi:${item.doi.toLocaleLowerCase()}`;
  if (item.pmid) return `pmid:${item.pmid}`;
  return `title:${item.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
}

type SavingKind = "citation" | "pdf" | "matrix";

const EMPTY_SAVING = new Set<SavingKind>();

// Saves the action already confirmed locally. A sync response can trail the
// write it was triggered by (overview cache TTL, instance routing), and it
// replaces badge state wholesale — so these marks override the server's sets
// until a sync acknowledges them or they age out.
const LOCAL_SAVED_MARK_TTL_MS = 30_000;

type LocalSavedMarks = {
  citation: Map<string, number>;
  matrix: Map<string, number>;
  pdf: Map<string, { markedAt: number; path: string }>;
};

function reconcileMarkedIds(marks: Map<string, number>, serverIds: Set<string>, now: number) {
  for (const [id, markedAt] of marks) {
    if (serverIds.has(id) || now - markedAt >= LOCAL_SAVED_MARK_TTL_MS) marks.delete(id);
    else serverIds.add(id);
  }
}

function reconcileMarkedPdfs(
  marks: Map<string, { markedAt: number; path: string }>,
  serverPaths: Record<string, string>,
  now: number,
) {
  for (const [id, mark] of marks) {
    if (serverPaths[id] !== undefined || now - mark.markedAt >= LOCAL_SAVED_MARK_TTL_MS) marks.delete(id);
    else serverPaths[id] = mark.path;
  }
}

function mergePagedResults(current: LiteratureSearchResponse, next: LiteratureSearchResponse) {
  const items = new Map(current.items.map((item) => [itemIdentity(item), item]));
  for (const item of next.items) if (!items.has(itemIdentity(item))) items.set(itemIdentity(item), item);
  return { ...next, items: [...items.values()] };
}

function compareOptionalNumber(left: number | undefined, right: number | undefined, ascending: boolean) {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return ascending ? left - right : right - left;
}

function sortLiteratureItems(items: LiteratureItem[], sort: LiteratureSort) {
  if (sort === "relevance") return items;
  return [...items].sort((left, right) => {
    if (sort.startsWith("year")) return compareOptionalNumber(left.year, right.year, sort.endsWith("asc"));
    if (sort.startsWith("citations")) return compareOptionalNumber(left.citationCount, right.citationCount, sort.endsWith("asc"));
    const order = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    return sort === "title-asc" ? order : -order;
  });
}

export function LiteratureSearch({
  projectId,
  searchRequest,
  onSearchRequestConsumed,
}: {
  projectId: string;
  /** A query handed over from elsewhere (e.g. the editor's "@" menu). */
  searchRequest?: { query: string } | null;
  /** Called once a searchRequest has been picked up so it does not re-run. */
  onSearchRequestConsumed?: () => void;
}) {
  const savedStateRequest = useRef(0);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<LiteratureSourceSelection>("all");
  const [openAccessOnly, setOpenAccessOnly] = useState(false);
  const [activeSearch, setActiveSearch] = useState<SearchDefinition>();
  const [results, setResults] = useState<LiteratureSearchResponse>();
  const [sort, setSort] = useState<LiteratureSort>("relevance");
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Per-item, per-action saving flags: saving one study never disables the
  // other buttons on the card, or on any other card.
  const [savingByItem, setSavingByItem] = useState<Map<string, Set<SavingKind>>>(() => new Map());
  const [savedCitationIds, setSavedCitationIds] = useState<Set<string>>(() => new Set());
  const [savedPdfIds, setSavedPdfIds] = useState<Set<string>>(() => new Set());
  const [savedPdfPaths, setSavedPdfPaths] = useState<Record<string, string>>({});
  const [savedMatrixIds, setSavedMatrixIds] = useState<Set<string>>(() => new Set());
  const [searchError, setSearchError] = useState<string>();
  const [selectedItem, setSelectedItem] = useState<LiteratureItem>();
  const localSavedMarksRef = useRef<LocalSavedMarks>({
    citation: new Map(),
    matrix: new Map(),
    pdf: new Map(),
  });
  // The matrix commit already succeeded when this runs: flip the badge now
  // instead of waiting for the post-save sync to catch up.
  const handleMatrixCommitSuccess = useCallback((request: MatrixAddRequest) => {
    if (request.kind !== "literature") return;
    const ids = request.items.map((item) => item.id);
    const now = Date.now();
    for (const id of ids) localSavedMarksRef.current.matrix.set(id, now);
    setSavedMatrixIds((current) => {
      if (ids.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  const matrixAdd = useMatrixAdd(projectId, handleMatrixCommitSuccess);
  const restoredSnapshotProjectRef = useRef<string | undefined>(undefined);

  const startSaving = useCallback((itemId: string, kind: SavingKind) => {
    setSavingByItem((current) => {
      const next = new Map(current);
      const kinds = new Set(next.get(itemId) ?? []);
      kinds.add(kind);
      next.set(itemId, kinds);
      return next;
    });
  }, []);

  const finishSaving = useCallback((itemId: string, kind: SavingKind) => {
    setSavingByItem((current) => {
      const kinds = current.get(itemId);
      if (!kinds?.has(kind)) return current;
      const next = new Map(current);
      const rest = new Set(kinds);
      rest.delete(kind);
      if (rest.size === 0) next.delete(itemId);
      else next.set(itemId, rest);
      return next;
    });
  }, []);

  const syncSavedState = useCallback(async (items: LiteratureItem[]) => {
    const request = ++savedStateRequest.current;
    try {
      const identities = items.map(({ id, title, authors, year, doi, pmid }) => ({ id, title, authors, year, doi, pmid }));
      const [state, matrixState] = await Promise.all([
        getLiteratureSavedState({ projectId, items: identities }),
        getMatrixSavedState({ projectId, items: identities }),
      ]);
      if (request !== savedStateRequest.current) return;
      const citationIds = new Set(state.citationIds);
      const matrixIds = new Set(matrixState.itemIds);
      rememberLiteratureMatrixPaths(projectId, Object.fromEntries(
        items.map((item) => [item.id, matrixState.itemMatrixPaths[item.id] ?? []]),
      ));
      const pdfPaths = { ...state.pdfPaths };
      // The response may not reflect writes that finished moments ago; merge
      // locally confirmed saves over it rather than letting it replace them.
      const now = Date.now();
      reconcileMarkedIds(localSavedMarksRef.current.citation, citationIds, now);
      reconcileMarkedIds(localSavedMarksRef.current.matrix, matrixIds, now);
      reconcileMarkedPdfs(localSavedMarksRef.current.pdf, pdfPaths, now);
      setSavedCitationIds(citationIds);
      setSavedPdfIds(new Set(Object.keys(pdfPaths)));
      setSavedPdfPaths(pdfPaths);
      setSavedMatrixIds(matrixIds);
      updateSnapshotSavedState(projectId, citationIds, pdfPaths, matrixIds);
    } catch (error) {
      console.warn("[literature-saved-state] failed", error);
    }
  }, [projectId]);

  useEffect(() => {
    if (restoredSnapshotProjectRef.current === projectId) return;
    restoredSnapshotProjectRef.current = projectId;
    const snapshot = readSnapshot(projectId);
    if (!snapshot) return;
    setQuery(snapshot.query);
    setSource(snapshot.source);
    setOpenAccessOnly(snapshot.openAccessOnly);
    setActiveSearch({ query: snapshot.query, source: snapshot.source, openAccessOnly: snapshot.openAccessOnly });
    setResults(snapshot.results);
    setSort(snapshot.sort || "relevance");
    setSavedCitationIds(new Set(snapshot.savedCitationIds));
    setSavedPdfIds(new Set(snapshot.savedPdfIds));
    setSavedPdfPaths(snapshot.savedPdfPaths || {});
    setSavedMatrixIds(new Set(snapshot.savedMatrixIds || []));
    void syncSavedState(snapshot.results.items);
  }, [projectId, syncSavedState]);

  useEffect(() => {
    if (!results) return;
    const refresh = () => void syncSavedState(results.items);
    window.addEventListener("beeblio:workspace-changed", refresh);
    return () => window.removeEventListener("beeblio:workspace-changed", refresh);
  }, [results, syncSavedState]);

  const addToMatrix = (item: LiteratureItem) => {
    startSaving(item.id, "matrix");
    matrixAdd.add({ kind: "literature", items: [item] });
  };

  // Once no commit is running and the picker is closed, the add either
  // committed or was cancelled; drop any lingering matrix spinners.
  useEffect(() => {
    if (matrixAdd.saving || matrixAdd.pickerOpen) return;
    setSavingByItem((current) => {
      let changed = false;
      const next = new Map<string, Set<SavingKind>>();
      for (const [itemId, kinds] of current) {
        const rest = new Set(kinds);
        if (rest.delete("matrix")) changed = true;
        if (rest.size > 0) next.set(itemId, rest);
      }
      return changed ? next : current;
    });
  }, [matrixAdd.pickerOpen, matrixAdd.saving]);

  const executeSearch = useCallback(async (definition: SearchDefinition) => {
    if (definition.query.trim().length < 2) return;
    setSearching(true);
    setSearchError(undefined);
    try {
      const response = await searchLiterature({
        projectId,
        ...definition,
        page: 1,
      });
      setActiveSearch(definition);
      setResults(response);
      setSavedCitationIds(new Set());
      setSavedPdfIds(new Set());
      setSavedPdfPaths({});
      writeSnapshot(projectId, {
        ...definition,
        results: response,
        sort,
        savedCitationIds: [],
        savedPdfIds: [],
        savedPdfPaths: {},
        savedMatrixIds: [],
      });
      void syncSavedState(response.items);
    } catch (error) {
      setSearchError(errorDetail(error, "Literature search failed."));
    } finally {
      setSearching(false);
    }
  }, [projectId, sort, syncSavedState]);

  const runSearch = (event: FormEvent) => {
    event.preventDefault();
    void executeSearch({ query: query.trim(), source, openAccessOnly });
  };

  // Search requests handed over from the document editor's "@" menu ("More
  // results"): run the query, then hand control back so the same request does
  // not re-run on later renders.
  useEffect(() => {
    if (!searchRequest?.query) return;
    setQuery(searchRequest.query);
    void executeSearch({ query: searchRequest.query, source, openAccessOnly });
    onSearchRequestConsumed?.();
  }, [searchRequest, executeSearch, source, openAccessOnly, onSearchRequestConsumed]);

  const loadMore = async () => {
    if (!results?.hasMore || !activeSearch) return;
    setLoadingMore(true);
    setSearchError(undefined);
    try {
      const response = await searchLiterature({
        projectId,
        ...activeSearch,
        page: results.page + 1,
      });
      const merged = mergePagedResults(results, response);
      setResults(merged);
      writeSnapshot(projectId, {
        ...activeSearch,
        results: merged,
        sort,
        savedCitationIds: [...savedCitationIds],
        savedPdfIds: [...savedPdfIds],
        savedPdfPaths,
        savedMatrixIds: [...savedMatrixIds],
      });
      void syncSavedState(merged.items);
    } catch (error) {
      setSearchError(errorDetail(error, "Could not load more literature."));
    } finally {
      setLoadingMore(false);
    }
  };

  const changeSort = (value: LiteratureSort) => {
    setSort(value);
    const snapshot = readSnapshot(projectId);
    if (snapshot) writeSnapshot(projectId, { ...snapshot, sort: value });
  };

  const saveCitation = async (item: LiteratureItem) => {
    startSaving(item.id, "citation");
    // Optimistic: the button flips to Saved immediately and rolls back if the
    // server rejects the save.
    setSavedCitationIds((current) => new Set(current).add(item.id));
    localSavedMarksRef.current.citation.set(item.id, Date.now());
    const rollback = () => {
      localSavedMarksRef.current.citation.delete(item.id);
      setSavedCitationIds((current) => {
        if (!current.has(item.id)) return current;
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    };
    try {
      const result = await saveLiteratureCitation({ projectId, item });
      if (!result.success) {
        rollback();
        toast.error("Could not save citation", { description: result.error });
        return;
      }
      const nextCitationIds = new Set(savedCitationIds);
      nextCitationIds.add(item.id);
      updateSnapshotSavedState(projectId, nextCitationIds, savedPdfPaths);
      announceWorkspaceChange([{ path: PROJECT_BIBLIOGRAPHY_PATH, content: result.bibliographyContent }]);
      toast.success(result.alreadyExisted ? "Citation already saved" : "Citation saved", {
        description: result.citationPath,
      });
    } catch (error) {
      rollback();
      toast.error("Could not save citation", {
        description: errorDetail(error),
      });
    } finally {
      finishSaving(item.id, "citation");
    }
  };

  const savePdf = async (item: LiteratureItem) => {
    startSaving(item.id, "pdf");
    try {
      const result = await saveLiteraturePdf({ projectId, item });
      if (!result.success) {
        toast.error("Could not save PDF", { description: result.error });
        return;
      }
      if (!result.pdfPath) return;
      const nextPdfIds = new Set(savedPdfIds).add(item.id);
      const nextPdfPaths = { ...savedPdfPaths, [item.id]: result.pdfPath };
      setSavedPdfIds(nextPdfIds);
      setSavedPdfPaths(nextPdfPaths);
      // Saving the PDF also files the citation in references.bib, so the item
      // counts as citation-saved from here on.
      const nextCitationIds = result.citationKey
        ? new Set(savedCitationIds).add(item.id)
        : savedCitationIds;
      setSavedCitationIds(nextCitationIds);
      localSavedMarksRef.current.pdf.set(item.id, { markedAt: Date.now(), path: result.pdfPath });
      updateSnapshotSavedState(projectId, nextCitationIds, nextPdfPaths);
      announceWorkspaceChange([{ path: PROJECT_BIBLIOGRAPHY_PATH, content: result.bibliographyContent }]);
      const bibliographyNote = result.citationAdded
        ? "Citation added to references.bib"
        : result.citationLinked
          ? "Linked File updated in references.bib"
          : undefined;
      toast.success(result.alreadyExisted ? "PDF already saved" : "PDF saved", {
        description: [result.pdfPath, bibliographyNote].filter(Boolean).join(" · "),
      });
    } catch (error) {
      toast.error("Could not save PDF", {
        description: errorDetail(error),
      });
    } finally {
      finishSaving(item.id, "pdf");
    }
  };

  const openPdf = (pdfPath: string) => {
    window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE_EVENT, {
      detail: { name: pdfPath.split("/").at(-1) || pdfPath, path: pdfPath },
    }));
  };

  const failures = results?.providers.filter((provider) => !provider.ok) || [];
  const visibleItems = useMemo(() => sortLiteratureItems(results?.items || [], sort), [results?.items, sort]);
  const showEmptySearch = !results && !searching && !searchError;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className={cn("flex shrink-0 gap-1", showEmptySearch
          ? "min-h-0 flex-1 flex-col items-center justify-center gap-5 px-4 py-8"
          : "h-10 items-center border-b px-2")}
        onSubmit={runSearch}
      >
        {showEmptySearch ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl border bg-card text-primary">
              <BookOpenText className="size-5" />
            </div>
            <h2 className="text-base font-semibold">Search Literature</h2>
          </div>
        ) : null}
        <div className={cn("flex min-w-0 gap-2", showEmptySearch
          ? "w-full max-w-md flex-col items-stretch"
          : "flex-1 items-center gap-1")}>
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Topic, title, DOI, or author"
            aria-label="Search scholarly literature"
            className={cn("min-w-0 rounded-lg selection:bg-primary/20 selection:text-foreground dark:selection:bg-primary/35 dark:selection:text-foreground", showEmptySearch
              ? "h-11 w-full shrink-0 px-3 text-sm md:text-sm"
              : "h-7 flex-1 text-xs md:text-xs")}
            disabled={searching}
          />
          <Button type="submit" size={showEmptySearch ? "default" : "icon-sm"} className={cn("shrink-0", showEmptySearch ? "h-11 w-full rounded-lg" : "h-7 w-7")} aria-label="Search Literature" disabled={searching || query.trim().length < 2}>
            {searching ? <Loader2 className="animate-spin" /> : <Search className={showEmptySearch ? "size-5" : "size-3.5"} />}
            {showEmptySearch ? "Search Literature" : null}
          </Button>
        </div>
        {/* <div className="flex items-center gap-2">
          <Select
            value={source}
            onValueChange={(value) => setSource(value as LiteratureSourceSelection)}
            disabled={searching}
          >
            <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 rounded-lg px-2.5 text-xs">
              <SelectValue placeholder="Sources" />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="all">All Sources</SelectItem>
              {Object.entries(sourceLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div> */}
        {/* <button
          type="button"
          role="checkbox"
          aria-checked={openAccessOnly}
          className="flex items-center gap-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpenAccessOnly((current) => !current)}
          disabled={searching}
        >
          <span className={cn(
            "flex size-4 items-center justify-center rounded border",
            openAccessOnly ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card",
          )}>
            {openAccessOnly ? <Check className="size-3" /> : null}
          </span>
          Open-Access Only
        </button> */}
      </form>

      {!showEmptySearch ? <div className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          <div className="space-y-2 p-3" aria-label="Searching literature">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="animate-pulse rounded-xl border bg-card p-3">
                <div className="h-3 w-5/6 rounded bg-muted" />
                <div className="mt-2 h-2.5 w-3/5 rounded bg-muted" />
                <div className="mt-3 h-7 w-full rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : searchError && !results ? (
          <div className="m-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{searchError}</span>
            </div>
          </div>
        ) : results ? (
          <div className="p-3">
            {searchError ? (
              <div className="mb-2 rounded-xl border border-destructive/25 bg-destructive/5 p-2.5 text-[10px] text-destructive">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>{searchError} Showing the previous search.</span>
                </div>
              </div>
            ) : null}
            {/* <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{results.items.length} Results</span>
              <span>{successfulProviders}/{results.providers.length} Sources</span>
            </div> */}
            <Select value={sort} onValueChange={(value) => changeSort(value as LiteratureSort)}>
              <SelectTrigger size="sm" className="mb-2 h-8 w-full rounded-lg text-xs" aria-label="Sort literature results">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="relevance"><ListFilter />Relevance</SelectItem>
                <SelectItem value="year-desc"><CalendarArrowDown />Year: Newest First</SelectItem>
                <SelectItem value="year-asc"><CalendarArrowUp />Year: Oldest First</SelectItem>
                <SelectItem value="citations-desc"><ArrowDown10 />Citations: Most First</SelectItem>
                <SelectItem value="citations-asc"><ArrowUp10 />Citations: Fewest First</SelectItem>
                <SelectItem value="title-asc"><ArrowDownAZ />Title: A–Z</SelectItem>
                <SelectItem value="title-desc"><ArrowUpAZ />Title: Z–A</SelectItem>
              </SelectContent>
            </Select>
            {failures.length > 0 ? (
              <details className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[10px] text-muted-foreground">
                <summary className="cursor-pointer font-medium text-amber-700 dark:text-amber-400">
                  {failures.length} {failures.length === 1 ? "source is" : "sources are"} unavailable
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {failures.map((provider) => (
                    <li key={provider.source}>
                      <span className="font-medium text-foreground">{sourceLabels[provider.source]}:</span>{" "}
                      {provider.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="space-y-2">
              {visibleItems.map((item) => (
                <LiteratureResultCard
                  key={item.id}
                  item={item}
                  citationSaved={savedCitationIds.has(item.id)}
                  pdfPath={savedPdfPaths[item.id]}
                  matrixSaved={savedMatrixIds.has(item.id)}
                  saving={savingByItem.get(item.id) ?? EMPTY_SAVING}
                  matrixCommitting={matrixAdd.saving}
                  onOpenDetails={() => setSelectedItem(item)}
                  onSaveCitation={() => void saveCitation(item)}
                  onSavePdf={() => void savePdf(item)}
                  onAddToMatrix={() => addToMatrix(item)}
                  onOpenPdf={() => {
                    const pdfPath = savedPdfPaths[item.id];
                    if (pdfPath) openPdf(pdfPath);
                  }}
                />
              ))}
            </div>
            {results.items.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center px-4 text-center text-muted-foreground">
                <BookOpenText className="mb-2 size-6 opacity-50" />
                <p className="text-xs font-medium text-foreground">No matching literature</p>
                <p className="mt-1 text-[11px]">Try broader terms or another source.</p>
              </div>
            ) : null}
            {results.hasMore ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {loadingMore ? "Loading…" : "Show More Results"}
              </Button>
            ) : results.items.length > 0 ? (
              <p className="mt-3 text-center text-[10px] text-muted-foreground">All available results loaded</p>
            ) : null}
          </div>
        ) : null}
      </div> : null}

      {/* <div className="shrink-0 border-t px-3 py-2 text-[9px] leading-4 text-muted-foreground">
        Metadata from OpenAlex, Crossref, and{" "}
        <a
          href="https://www.ncbi.nlm.nih.gov/home/about/policies/"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          NCBI/PubMed
        </a>.
      </div> */}
      <ReferenceSheet
        open={Boolean(selectedItem)}
        onOpenChange={(open) => {
          if (!open) setSelectedItem(undefined);
        }}
        mode="preview"
        reference={selectedItem ? referenceFromSearchItem(selectedItem) : undefined}
        matrixSaved={selectedItem ? savedMatrixIds.has(selectedItem.id) : false}
        addingToMatrix={selectedItem ? (savingByItem.get(selectedItem.id)?.has("matrix") ?? false) : false}
        onAddToMatrix={selectedItem ? () => addToMatrix(selectedItem) : undefined}
      />
      <MatrixTargetDialog
        projectId={projectId}
        open={matrixAdd.pickerOpen}
        targets={matrixAdd.targets}
        saving={matrixAdd.saving}
        savingPath={matrixAdd.savingPath}
        memberPaths={matrixAdd.memberPaths}
        onCancel={matrixAdd.cancel}
        onPick={matrixAdd.pick}
      />
    </div>
  );
}

function LiteratureResultCard({
  item,
  citationSaved,
  pdfPath,
  matrixSaved,
  saving,
  matrixCommitting,
  onOpenDetails,
  onSaveCitation,
  onSavePdf,
  onAddToMatrix,
  onOpenPdf,
}: {
  item: LiteratureItem;
  citationSaved: boolean;
  pdfPath?: string;
  matrixSaved: boolean;
  saving: Set<SavingKind>;
  matrixCommitting: boolean;
  onOpenDetails: () => void;
  onSaveCitation: () => void;
  onSavePdf: () => void;
  onAddToMatrix: () => void;
  onOpenPdf: () => void;
}) {
  const busy = saving.size > 0;
  const details = [item.authors.slice(0, 2).join(", "), item.year, item.venue]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-primary/25">
      <button
        type="button"
        className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpenDetails}
      >
        <h3 className="line-clamp-3 text-xs font-semibold leading-[1.45] hover:text-primary">
          {item.title}
        </h3>
        {details ? <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{details}</p> : null}
        <div className="mt-2 flex flex-wrap gap-1">
          {item.sources.map((source) => (
            <Badge key={source} variant="secondary" className="h-4 px-1.5 text-[8px] font-medium">
              {sourceLabels[source]}
            </Badge>
          ))}
          {item.pdfUrl ? (
            <Badge variant="outline" className="h-4 border-emerald-500/30 px-1.5 text-[8px] font-medium text-emerald-700 dark:text-emerald-400">
              PDF
            </Badge>
          ) : item.isOpenAccess ? (
            <Badge variant="outline" className="h-4 border-emerald-500/30 px-1.5 text-[8px] font-medium text-emerald-700 dark:text-emerald-400">
              Open Access
            </Badge>
          ) : null}
          {item.citationCount !== undefined ? (
            <span className="ml-auto text-[9px] text-muted-foreground">{item.citationCount.toLocaleString()} Cited</span>
          ) : null}
        </div>
      </button>
      <div className="mt-2 flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={citationSaved ? "secondary" : "outline"}
          className="h-7 min-w-0 flex-1 px-2"
          disabled={busy || citationSaved}
          onClick={onSaveCitation}
        >
          {saving.has("citation") ? <Loader2 className="animate-spin" /> : citationSaved ? <BookmarkCheck /> : <Bookmark />}
          {saving.has("citation") ? "Saving…" : citationSaved ? "Saved" : "Save"}
        </Button>
        {item.pdfUrl || pdfPath ? (
          <Button
            type="button"
            size="sm"
            variant={pdfPath ? "secondary" : "outline"}
            className="h-7 min-w-0 flex-1 px-2"
            disabled={!pdfPath && busy}
            onClick={pdfPath ? onOpenPdf : onSavePdf}
            title={pdfPath ? "Open saved PDF" : "Save PDF"}
          >
            {saving.has("pdf") ? <Loader2 className="animate-spin" /> : pdfPath ? <FileCheck2 /> : <FileDown />}
            {saving.has("pdf") ? "Saving" : pdfPath ? "Saved" : "PDF"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={matrixSaved ? "secondary" : "outline"}
          className="h-7 shrink-0 px-2.5"
          disabled={busy || matrixCommitting}
          onClick={onAddToMatrix}
          title={matrixSaved ? "Already in a matrix — click to add it to another" : "Add to the literature matrix"}
          aria-label={matrixSaved ? "Already in a matrix — add to another literature matrix" : "Add to the literature matrix"}
        >
          {saving.has("matrix") ? <Loader2 className="animate-spin" /> : matrixSaved ? <Check /> : <Table2 />}
        </Button>
      </div>
    </article>
  );
}
