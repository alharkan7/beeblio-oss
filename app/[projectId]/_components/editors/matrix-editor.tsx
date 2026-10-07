"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowUpRight,
  Copy,
  Code2,
  Download,
  Eye,
  FileJson,
  FileSpreadsheet,
  FileText,
  GripVertical,
  Info,
  Loader2,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  Save,
  Search,
  Table2,
  Trash2,
  TriangleAlert,
  BookSearch,
  X, PencilSparkles,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { parseBibtexEntries } from "@/lib/bibtex";
import { ASK_AGENT_EVENT, OPEN_WORKSPACE_FILE_EVENT } from "@/lib/chat-context";
import {
  DERIVED_COLUMN_SOURCES,
  addMatrixColumn,
  matrixColumnLabel,
  matrixToCsv,
  matrixToMarkdown,
  parseMatrix,
  removeMatrixColumn,
  removeMatrixRows,
  resolveMatrixRow,
  serializeMatrix,
  type CitationLookup,
  type CustomColumn,
  type DerivedColumnSource,
  type LiteratureMatrix,
  type ResolvedMatrixRow,
} from "@/lib/literature-matrix";
import { PROJECT_BIBLIOGRAPHY_PATH } from "@/lib/project-bibliography";
import { WORKSPACE_CHANGED_EVENT, type WorkspaceChangedDetail } from "@/lib/workspace-change";
import { REPORTS_DIRECTORY } from "@/lib/research-workspace";
import { usePublicView } from "@/app/share/[shareId]/_components/public-view-context";
import { cn } from "@/lib/utils";
import { getFileContent, saveFile } from "../../file-actions";
import { ReferenceSheet, type ReferenceDetail } from "../reference-sheet";
import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import { LiteratureMap } from "./literature-map/literature-map";
import { SourceCodeEditor } from "./source-code-editor";
import { type WorkspaceEditorProps } from "./types";
import { useTextFile } from "./use-text-file";
import { errorDetail } from "@/lib/error-detail";

type MatrixMode = "table" | "map" | "source";
type SortState = { key: string; direction: "asc" | "desc" };

export function MatrixEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const text = useTextFile(projectId, file.path, onSaved);
  const publicView = usePublicView();
  const [mode, setMode] = useState<MatrixMode>("table");
  const [citations, setCitations] = useState<Map<string, CitationLookup>>();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState>();
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [addStudiesOpen, setAddStudiesOpen] = useState(false);
  const [renameColumn, setRenameColumn] = useState<CustomColumn>();
  const [deleteColumn, setDeleteColumn] = useState<LiteratureMatrix["columns"][number]>();
  const [removeRowTarget, setRemoveRowTarget] = useState<{ citationKey: string; title: string }>();
  const [draggedColumnId, setDraggedColumnId] = useState<string>();
  const [columnDropTarget, setColumnDropTarget] = useState<{ id: string; side: "before" | "after" }>();
  const [draggedRowKey, setDraggedRowKey] = useState<string>();
  const [rowDropTarget, setRowDropTarget] = useState<{ key: string; side: "before" | "after" }>();
  const [detailReference, setDetailReference] = useState<ReferenceDetail>();
  const initialCitationsProjectRef = useRef<string | undefined>(undefined);

  const parsed = useMemo(() => {
    if (text.loading || text.error) return undefined;
    try {
      return { ok: true as const, matrix: parseMatrix(text.draft) };
    } catch (error) {
      return { ok: false as const, message: errorDetail(error, "The matrix file could not be parsed.") };
    }
  }, [text.draft, text.error, text.loading]);

  const applyCitationSource = useCallback((source: string | null) => {
    const map = new Map<string, CitationLookup>();
    if (source) {
      for (const entry of parseBibtexEntries(source)) {
        const fields = Object.fromEntries(
          Object.entries(entry.fields).map(([name, value]) => [name, value.replaceAll(/\s+/g, " ").trim()]),
        );
        map.set(entry.key, {
          title: fields.title,
          authors: fields.author,
          year: fields.year,
          venue: fields.journal || fields.booktitle,
          publisher: fields.publisher,
          doi: fields.doi,
          pmid: fields.pmid,
          url: fields.url,
          type: entry.type,
          volume: fields.volume,
          issue: fields.number,
          pages: fields.pages,
          abstract: fields.abstract,
          keywords: fields.keywords,
          note: fields.note,
          file: fields.file,
          month: fields.month,
          editor: fields.editor,
          edition: fields.edition,
          series: fields.series,
          address: fields.address,
          school: fields.school,
          institution: fields.institution,
          organization: fields.organization,
          howpublished: fields.howpublished,
          urldate: fields.urldate,
          citationCount: /^\d+$/.test(fields.citationcount || "") ? Number(fields.citationcount) : undefined,
          isOpenAccess: fields.openaccess?.toLocaleLowerCase() === "true" ? true : undefined,
        });
      }
    }
    setCitations(map);
  }, []);

  const loadCitations = useCallback(async () => {
    // Share views have no session-scoped access to references.bib; derived
    // columns fall back to each row's saved snapshot.
    if (publicView.shareId) {
      applyCitationSource(null);
      return;
    }
    try {
      const source = await getFileContent(projectId, PROJECT_BIBLIOGRAPHY_PATH);
      applyCitationSource(source);
    } catch {
      applyCitationSource(null);
    }
  }, [applyCitationSource, projectId, publicView.shareId]);

  useEffect(() => {
    if (initialCitationsProjectRef.current !== projectId) {
      initialCitationsProjectRef.current = projectId;
      void loadCitations();
    }
    const refresh = (event: Event) => {
      const known = (event as CustomEvent<WorkspaceChangedDetail>).detail?.files
        ?.find((candidate) => candidate.path === PROJECT_BIBLIOGRAPHY_PATH);
      if (known) applyCitationSource(known.content);
      else void loadCitations();
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, refresh);
  }, [applyCitationSource, loadCitations, projectId]);

  const matrix = parsed?.ok ? parsed.matrix : undefined;
  const updateMatrix = useCallback((next: LiteratureMatrix) => {
    text.setDraft(serializeMatrix(next));
  }, [text]);

  const setCell = (citationKey: string, columnId: string, value: string) => {
    if (!matrix) return;
    updateMatrix({
      ...matrix,
      rows: matrix.rows.map((row) =>
        row.citationKey === citationKey ? { ...row, cells: { ...row.cells, [columnId]: value } } : row,
      ),
    });
  };

  const askAgent = useCallback((prompt: string) => {
    window.dispatchEvent(new CustomEvent(ASK_AGENT_EVENT, {
      detail: {
        text: prompt,
        files: [{ path: file.path, kind: "mention" }],
        interaction: {
          origin: "matrix-action",
          intent: "contextual-file",
          targetFilePath: file.path,
        },
      },
    }));
  }, [file.path]);

  // The table renders as soon as the matrix file parses; bibliography lookups
  // stream in afterwards (derived columns fall back to row snapshots and the
  // "unlinked" badge is suppressed until they arrive).
  const citationsReady = citations !== undefined;
  const resolvedRows = useMemo(() => {
    if (!matrix) return [];
    return matrix.rows.map((row) => resolveMatrixRow(row, matrix.columns, citations?.get(row.citationKey)));
  }, [citations, matrix]);

  const rowsByKey = useMemo(() => new Map(resolvedRows.map((row) => [row.citationKey, row])), [resolvedRows]);

  // Literature map input: rows resolved against the bibliography so the map's
  // relationship edges can use keywords/abstracts/citation counts, falling
  // back to the snapshot saved with each row (unlinked keys, share views).
  const mapSources = useMemo(() => {
    if (!matrix) return [];
    return matrix.rows.map((row) => {
      const citation = citations?.get(row.citationKey);
      return {
        id: row.citationKey,
        title: citation?.title || row.snapshot.title || row.citationKey,
        authors: citation?.authors || row.snapshot.authors,
        year: citation?.year || (row.snapshot.year !== undefined ? String(row.snapshot.year) : undefined),
        container: citation?.venue || row.snapshot.venue,
        keywords: citation?.keywords,
        abstract: citation?.abstract,
        citationCount: citation?.citationCount,
      };
    });
  }, [citations, matrix]);

  const visibleRows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    let rows = query
      ? resolvedRows.filter((row) =>
          row.title.toLocaleLowerCase().includes(query) ||
          Object.values(row.values).some((value) => value.toLocaleLowerCase().includes(query)))
      : resolvedRows;
    if (sort && matrix) {
      const columnIds = new Set(matrix.columns.map(({ id }) => id));
      const key = sort.key === "title" || columnIds.has(sort.key) ? sort.key : undefined;
      if (key) {
        rows = [...rows].sort((left, right) => {
          const leftValue = key === "title" ? left.title : left.values[key] ?? "";
          const rightValue = key === "title" ? right.title : right.values[key] ?? "";
          const order = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
          return sort.direction === "asc" ? order : -order;
        });
      }
    }
    return rows;
  }, [filter, matrix, resolvedRows, sort]);

  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? current.direction === "asc"
          ? { key, direction: "desc" }
          : undefined
        : { key, direction: "asc" },
    );
  };

  const openReference = useCallback((row: ResolvedMatrixRow) => {
    const saved = citations?.get(row.citationKey);
    const snapshot = matrix?.rows.find((candidate) => candidate.citationKey === row.citationKey);
    setDetailReference({
      title: saved?.title || snapshot?.snapshot.title || row.title,
      key: row.citationKey,
      authors: saved?.authors || snapshot?.snapshot.authors,
      year: saved?.year || (snapshot?.snapshot.year ? String(snapshot.snapshot.year) : undefined),
      type: saved?.type,
      container: saved?.venue || snapshot?.snapshot.venue,
      publisher: saved?.publisher,
      volume: saved?.volume,
      issue: saved?.issue,
      pages: saved?.pages,
      doi: saved?.doi || snapshot?.doi,
      pmid: saved?.pmid,
      url: saved?.url,
      abstract: saved?.abstract,
      keywords: saved?.keywords,
      note: saved?.note,
      file: saved?.file,
      month: saved?.month,
      editor: saved?.editor,
      edition: saved?.edition,
      series: saved?.series,
      address: saved?.address,
      school: saved?.school,
      institution: saved?.institution,
      organization: saved?.organization,
      howpublished: saved?.howpublished,
      urldate: saved?.urldate,
      citationCount: saved?.citationCount,
      isOpenAccess: saved?.isOpenAccess,
    });
  }, [citations, matrix]);

  const openColumnMenuAction = (column: CustomColumn, action: "rename" | "fill" | "delete") => {
    if (action === "rename") {
      setRenameColumn(column);
    } else if (action === "fill") {
      askAgent(`Fill the "${column.label}" column of this literature matrix for every study${column.description ? ` (the column compares: ${column.description})` : ""}.`);
    } else {
      setDeleteColumn(column);
    }
  };

  const confirmAddColumn = (label: string, description: string) => {
    if (!matrix) return false;
    try {
      const { matrix: next } = addMatrixColumn(matrix, { label, description, origin: "user" });
      updateMatrix(next);
      return true;
    } catch (error) {
      toast.error("Could not add the column", {
        description: errorDetail(error),
      });
      return false;
    }
  };

  const confirmRenameColumn = (label: string, description: string) => {
    if (!matrix || !renameColumn) return;
    if (!label) return;
    updateMatrix({
      ...matrix,
      columns: matrix.columns.map((column) =>
        column.id === renameColumn.id
          ? { ...column, label, description: description || undefined }
          : column,
      ),
    });
    setRenameColumn(undefined);
  };

  const confirmDeleteColumn = () => {
    if (!matrix || !deleteColumn) return;
    try {
      updateMatrix(removeMatrixColumn(matrix, deleteColumn.id).matrix);
    } catch (error) {
      toast.error("Could not remove the column", {
        description: errorDetail(error),
      });
    }
    setDeleteColumn(undefined);
  };

  const removeRow = (citationKey: string) => {
    if (!matrix) return;
    updateMatrix(removeMatrixRows(matrix, [citationKey]).matrix);
    setRemoveRowTarget(undefined);
  };

  const showDerivedColumn = (source: DerivedColumnSource) => {
    if (!matrix || matrix.columns.some((column) => column.id === source)) return;
    updateMatrix({ ...matrix, columns: [...matrix.columns, { kind: "derived", id: source, source }] });
  };

  const dropColumn = (targetId: string, side: "before" | "after") => {
    if (matrix && draggedColumnId && draggedColumnId !== targetId) {
      const columns = [...matrix.columns];
      const from = columns.findIndex((column) => column.id === draggedColumnId);
      if (from !== -1) {
        const [moved] = columns.splice(from, 1);
        const target = columns.findIndex((column) => column.id === targetId);
        if (target !== -1) {
          columns.splice(target + (side === "after" ? 1 : 0), 0, moved);
          updateMatrix({ ...matrix, columns });
        }
      }
    }
    setDraggedColumnId(undefined);
    setColumnDropTarget(undefined);
  };

  const dropRow = (targetKey: string, side: "before" | "after") => {
    if (matrix && draggedRowKey && draggedRowKey !== targetKey) {
      const visibleKeys = visibleRows.map((row) => row.citationKey);
      const from = visibleKeys.indexOf(draggedRowKey);
      if (from !== -1) {
        const [movedKey] = visibleKeys.splice(from, 1);
        const target = visibleKeys.indexOf(targetKey);
        if (target !== -1) {
          visibleKeys.splice(target + (side === "after" ? 1 : 0), 0, movedKey);
          const byKey = new Map(matrix.rows.map((row) => [row.citationKey, row]));
          const visibleSet = new Set(visibleKeys);
          const orderedVisibleRows = visibleKeys.map((key) => byKey.get(key)!);
          let nextVisible = 0;
          const rows = matrix.rows.map((row) => visibleSet.has(row.citationKey) ? orderedVisibleRows[nextVisible++] : row);
          updateMatrix({ ...matrix, rows });
          setSort(undefined);
        }
      }
    }
    setDraggedRowKey(undefined);
    setRowDropTarget(undefined);
  };

  const submitAiColumn = (description: string) => {
    askAgent(`Add a new column to this literature matrix comparing: ${description}. Create the column with a short label and fill it in for every study.`);
  };

  const submitAiStudies = (topic: string) => {
    askAgent(`Find recent, relevant studies on "${topic}" and add them to this literature matrix. Save each citation to the project bibliography first, then add the studies to the matrix.`);
  };

  const copyMarkdown = async () => {
    if (!matrix) return;
    try {
      await navigator.clipboard.writeText(matrixToMarkdown(matrix.columns, resolvedRows));
      toast.success("Markdown table copied to clipboard");
    } catch {
      toast.error("Could not copy the markdown table");
    }
  };

  const saveMarkdownTable = async () => {
    if (!matrix) return;
    const name = `${file.name.replace(/\.matrix$/i, "")}-table.md`;
    const target = `${REPORTS_DIRECTORY}/${name}`;
    try {
      await saveFile(projectId, target, `${matrixToMarkdown(matrix.columns, resolvedRows)}\n`);
      window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
      toast.success(`Saved ${target}`, {
        action: {
          label: "Open",
          onClick: () => window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE_EVENT, {
            detail: { name, path: target },
          })),
        },
      });
    } catch (error) {
      toast.error("Could not save the markdown table", {
        description: errorDetail(error),
      });
    }
  };

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const baseFileName = file.name.replace(/\.matrix$/i, "");
  const downloadJson = () => {
    if (matrix) downloadFile(text.draft, `${baseFileName}.json`, "application/json");
  };
  const downloadMarkdown = () => {
    if (matrix) downloadFile(`${matrixToMarkdown(matrix.columns, resolvedRows)}\n`, `${baseFileName}-table.md`, "text/markdown");
  };
  const downloadCsv = () => {
    if (matrix) downloadFile(matrixToCsv(matrix.columns, resolvedRows), `${baseFileName}.csv`, "text/csv");
  };

  const readOnly = Boolean(publicView.shareId);
  const columns = matrix?.columns ?? [];
  const hiddenDerivedColumns = DERIVED_COLUMN_SOURCES.filter(
    (source) => !columns.some((column) => column.id === source),
  );
  const status = parsed && !parsed.ok
    ? <span className="mr-2 flex items-center gap-1.5 text-xs font-medium text-destructive"><TriangleAlert className="size-3.5" />{parsed.message}</span>
    : (
      <span className="mr-2 text-xs text-muted-foreground">
        {(matrix?.rows.length ?? 0)} Studies · {columns.length} Columns
      </span>
    );

  return (
    <EditorShell
      path={file.path}
      sourceUrl={sourceUrl}
      dirty={text.dirty}
      status={status}
      viewModes={[{
        value: mode,
        onChange: (value) => setMode(value as MatrixMode),
        options: [
          { value: "table", label: "Table View", icon: Table2 },
          { value: "map", label: "Literature Map", icon: Network },
          { value: "source", label: "Raw Source", icon: Code2 },
        ],
      }]}
      downloadAction={
        <MatrixDownloadMenu
          readOnly={readOnly}
          onDownloadJson={downloadJson}
          onDownloadMarkdown={downloadMarkdown}
          onDownloadCsv={downloadCsv}
          onCopyMarkdown={() => void copyMarkdown()}
          onSaveMarkdownTable={() => void saveMarkdownTable()}
        />
      }
      discard={{ onDiscard: text.discard, disabled: text.saving }}
      save={{ onClick: () => text.save(), saving: text.saving, disabled: Boolean(parsed && !parsed.ok) }}
      review={text.review}
    >
      {text.loading ? (
        <EditorLoading name={file.name} size={file.size} />
      ) : text.error ? (
        <EditorError message={text.error} />
      ) : parsed && !parsed.ok ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-start gap-2 border-b border-destructive/25 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{parsed.message} Fix the JSON source; the table view returns once the file is valid.</span>
          </div>
          <div className="min-h-0 flex-1">
            <SourceCodeEditor value={text.draft} extension="json" onChange={text.setDraft} />
          </div>
        </div>
      ) : mode === "source" ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/50 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Matrix JSON source</span>
            <span>{text.draft.split("\n").length} lines</span>
          </div>
          <SourceCodeEditor value={text.draft} extension="json" onChange={text.setDraft} />
        </div>
      ) : mode === "map" ? (
        <div className="h-full min-h-[28rem]">
          <LiteratureMap
            projectId={projectId}
            filePath={readOnly ? file.path : PROJECT_BIBLIOGRAPHY_PATH}
            citations={mapSources}
            emptyTitle="No studies to map"
            emptyHint="Add studies to this matrix to see how they relate."
            onOpen={(citationKey) => {
              const row = rowsByKey.get(citationKey);
              if (row) openReference(row);
            }}
          />
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {!readOnly ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-2 py-2">
              <div className="relative min-w-36 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter studies"
                  aria-label="Filter matrix studies"
                  className="h-7 pl-7 text-xs"
                />
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {hiddenDerivedColumns.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="xs" variant="outline"><Eye />Metadata</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {hiddenDerivedColumns.map((source) => (
                        <DropdownMenuItem key={source} onSelect={() => showDerivedColumn(source)}>
                          {matrixColumnLabel({ kind: "derived", id: source, source })}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                <Button size="xs" variant="outline" onClick={() => setAddColumnOpen(true)}>
                  <Plus />Column
                </Button>
                <Button size="xs" variant="outline"
                // onClick={() => notifyUpcomingFeature("Add Studies")}
                onClick={() => setAddStudiesOpen(true)}
                >
                  <BookSearch />Studies
                </Button>
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto bg-card">
            {matrix && matrix.rows.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center p-8 text-center">
                <div className="mb-3 flex size-11 items-center justify-center rounded-xl border bg-card text-primary">
                  <Table2 className="size-5" />
                </div>
                <h3 className="text-sm font-semibold">No studies in this matrix yet</h3>
                <p className="mt-1 max-w-72 text-xs leading-5 text-muted-foreground">
                  Add studies from the Literature panel&apos;s search results or your reference library — or describe a topic and let Beeblio AI find them.
                </p>
                {!readOnly ? (
                  <Button size="sm" variant="outline" className="mt-4" onClick={() => setAddStudiesOpen(true)}>
                    <PencilSparkles />Find Studies with AI
                  </Button>
                ) : null}
              </div>
            ) : (
              <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
                <thead className="sticky top-0 z-20 bg-muted">
                  <tr>
                    <th className="sticky left-0 z-30 min-w-56 border-b border-r bg-muted px-2 py-2 text-left font-medium">
                      <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("title")}>
                        Study
                        {sort?.key === "title" ? (
                          sort.direction === "asc" ? <ArrowDownAZ className="size-3" /> : <ArrowUpAZ className="size-3" />
                        ) : null}
                      </button>
                    </th>
                    {columns.map((column) => (
                      <th
                        key={column.id}
                        className={cn(
                          "min-w-44 max-w-72 border-b border-r p-0 text-left font-medium",
                          columnDropTarget?.id === column.id && (columnDropTarget.side === "before" ? "border-l-2 border-l-primary" : "border-r-2 border-r-primary"),
                        )}
                        onDragOver={(event) => {
                          if (!draggedColumnId || draggedColumnId === column.id) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          const side = event.clientX < event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2 ? "before" : "after";
                          if (columnDropTarget?.id !== column.id || columnDropTarget.side !== side) {
                            setColumnDropTarget({ id: column.id, side });
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const side = event.clientX < event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2 ? "before" : "after";
                          dropColumn(column.id, side);
                        }}
                      >
                        <div className="flex items-center">
                          {!readOnly ? (
                            <button
                              type="button"
                              draggable
                              className="flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
                              aria-label={`Drag to reorder ${matrixColumnLabel(column)} column`}
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", column.id);
                                setDraggedColumnId(column.id);
                              }}
                              onDragEnd={() => { setDraggedColumnId(undefined); setColumnDropTarget(undefined); }}
                            >
                              <GripVertical className="size-3.5" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1 px-2 py-2 hover:text-foreground"
                            onClick={() => toggleSort(column.id)}
                          >
                            <span className="truncate" title={matrixColumnLabel(column)}>{matrixColumnLabel(column)}</span>
                            {sort?.key === column.id ? (
                              sort.direction === "asc" ? <ArrowDownAZ className="size-3 shrink-0" /> : <ArrowUpAZ className="size-3 shrink-0" />
                            ) : null}
                            {column.kind === "custom" && column.description ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Info className="size-3 shrink-0 text-muted-foreground/70" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-64 text-xs">{column.description}</TooltipContent>
                              </Tooltip>
                            ) : null}
                            {column.kind === "derived" ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="rounded bg-primary/10 px-1 py-0.5 text-[8px] font-semibold uppercase text-primary">bib</span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-64 text-xs">
                                  Resolved from {PROJECT_BIBLIOGRAPHY_PATH} — editing the cell here overrides the bibliography value.
                                </TooltipContent>
                              </Tooltip>
                            ) : null}
                          </button>
                          {!readOnly ? (
                            <ColumnMenu
                              column={column}
                              onRename={column.kind === "custom" ? () => openColumnMenuAction(column, "rename") : undefined}
                              onFill={column.kind === "custom" ? () => openColumnMenuAction(column, "fill") : undefined}
                              onHide={() => setDeleteColumn(column)}
                            />
                          ) : null}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <MatrixRowView
                      key={row.citationKey}
                      row={row}
                      columns={columns}
                      readOnly={readOnly}
                      showUnlinked={citationsReady}
                      onRemove={() => setRemoveRowTarget({ citationKey: row.citationKey, title: row.title })}
                      dragging={draggedRowKey === row.citationKey}
                      dropSide={rowDropTarget?.key === row.citationKey ? rowDropTarget.side : undefined}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", row.citationKey);
                        setDraggedRowKey(row.citationKey);
                      }}
                      onDragOver={(event) => {
                        if (!draggedRowKey || draggedRowKey === row.citationKey) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        const side = event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? "before" : "after";
                        if (rowDropTarget?.key !== row.citationKey || rowDropTarget.side !== side) {
                          setRowDropTarget({ key: row.citationKey, side });
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const side = event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? "before" : "after";
                        dropRow(row.citationKey, side);
                      }}
                      onDragEnd={() => { setDraggedRowKey(undefined); setRowDropTarget(undefined); }}
                      onSetCell={(columnId, value) => setCell(row.citationKey, columnId, value)}
                      onOpen={() => openReference(row)}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {citations && matrix && matrix.rows.length > 0 && visibleRows.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No studies match your filter.</p>
            ) : null}
          </div>
        </div>
      )}

      <ColumnDialog
        open={addColumnOpen}
        title="Add Column"
        description="Name the column yourself, or describe what to compare and let Beeblio AI create and fill it."
        submitLabel="Add Column"
        onCancel={() => setAddColumnOpen(false)}
        onSubmit={(label, description) => {
          const added = confirmAddColumn(label, description);
          if (added) setAddColumnOpen(false);
        }}
        onSubmitAi={(instruction) => {
          setAddColumnOpen(false);
          submitAiColumn(instruction);
        }}
      />
      <ColumnDialog
        open={renameColumn !== undefined}
        title="Edit Column"
        description="The label heads the column; the description tells Beeblio AI what to compare."
        submitLabel="Save Column"
        initialLabel={renameColumn?.label}
        initialDescription={renameColumn?.description}
        onCancel={() => setRenameColumn(undefined)}
        onSubmit={confirmRenameColumn}
      />
      <AddStudiesDialog
        open={addStudiesOpen}
        onCancel={() => setAddStudiesOpen(false)}
        onSubmit={(topic) => {
          setAddStudiesOpen(false);
          submitAiStudies(topic);
        }}
      />
      <AlertDialog open={deleteColumn !== undefined} onOpenChange={(open) => { if (!open && !text.saving) setDeleteColumn(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteColumn?.kind === "derived" ? "Hide this column?" : "Delete this column?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteColumn?.kind === "derived"
                ? `"${deleteColumn ? matrixColumnLabel(deleteColumn) : ""}" comes from the project bibliography. Hiding it here does not change references.bib, and you can re-add it anytime.`
                : `"${deleteColumn ? matrixColumnLabel(deleteColumn) : ""}" and its values in every study will be removed from this matrix.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={text.saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={deleteColumn?.kind === "derived" ? "default" : "destructive"}
              disabled={text.saving}
              onClick={(event) => { event.preventDefault(); confirmDeleteColumn(); }}
            >
              {text.saving ? <Loader2 className="animate-spin" /> : deleteColumn?.kind === "derived" ? null : <Trash2 />}
              {deleteColumn?.kind === "derived" ? "Hide Column" : "Delete Column"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeRowTarget !== undefined} onOpenChange={(open) => { if (!open) setRemoveRowTarget(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this study?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{removeRowTarget?.title}</span> and its matrix cell values will be removed from this matrix. The citation will remain in the project bibliography.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => { event.preventDefault(); if (removeRowTarget) removeRow(removeRowTarget.citationKey); }}
            >
              <Trash2 />Remove Study
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ReferenceSheet
        open={detailReference !== undefined}
        onOpenChange={(open) => { if (!open) setDetailReference(undefined); }}
        mode="preview"
        projectId={projectId}
        reference={detailReference}
      />
    </EditorShell>
  );
}

function ColumnMenu({
  column,
  onRename,
  onFill,
  onHide,
}: {
  column: LiteratureMatrix["columns"][number];
  onRename?: () => void;
  onFill?: () => void;
  onHide: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={`Column options for ${matrixColumnLabel(column)}`}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onRename ? (
          <DropdownMenuItem onClick={onRename}>
            <Pencil />Rename
          </DropdownMenuItem>
        ) : null}
        {onFill ? (
          <DropdownMenuItem
          //  onClick={() => notifyUpcomingFeature("Fill with AI")}
          onClick={onFill}
          >
            <PencilSparkles />Fill with AI
          </DropdownMenuItem>
        ) : null}
        {onRename || onFill ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem variant="destructive" onClick={onHide}>
          <Trash2 />{column.kind === "derived" ? "Hide Column" : "Delete Column"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnDialog({
  open,
  title,
  description,
  submitLabel,
  initialLabel,
  initialDescription,
  onCancel,
  onSubmit,
  onSubmitAi,
}: {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  initialLabel?: string;
  initialDescription?: string;
  onCancel: () => void;
  onSubmit: (label: string, description: string) => void;
  /** Provided only when the dialog also offers agent-created columns. */
  onSubmitAi?: (instruction: string) => void;
}) {
  const [label, setLabel] = useState(initialLabel ?? "");
  const [columnDescription, setColumnDescription] = useState(initialDescription ?? "");
  const [aiInstruction, setAiInstruction] = useState("");
  const [method, setMethod] = useState<"manual" | "ai">("manual");
  useEffect(() => {
    if (open) {
      setLabel(initialLabel ?? "");
      setColumnDescription(initialDescription ?? "");
      setAiInstruction("");
      setMethod("manual");
    }
  }, [open, initialLabel, initialDescription]);
  const aiAvailable = onSubmitAi !== undefined;
  const submitAi = onSubmitAi && aiInstruction.trim().length >= 2
    ? () => onSubmitAi(aiInstruction.trim())
    : undefined;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {aiAvailable ? (
          <div
            className="flex items-center justify-center rounded-md border bg-muted/30 p-0.5"
            role="tablist"
            aria-label="Column creation method"
          >
            <Button
              type="button"
              size="sm"
              variant={method === "manual" ? "secondary" : "ghost"}
              className="h-7 flex-1"
              role="tab"
              aria-selected={method === "manual"}
              onClick={() => setMethod("manual")}
            >
              Manual
            </Button>
            <Button
              type="button"
              size="sm"
              variant={method === "ai" ? "secondary" : "ghost"}
              className="h-7 flex-1"
              role="tab"
              aria-selected={method === "ai"}
              // onClick={() => notifyUpcomingFeature("Beeblio AI")}
              onClick={() => setMethod("ai")}
            >
              <PencilSparkles />Beeblio AI
            </Button>
          </div>
        ) : null}
        {aiAvailable && method === "ai" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitAi?.();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="matrix-column-ai">What should the column compare?</Label>
              <Textarea
                id="matrix-column-ai"
                value={aiInstruction}
                onChange={(event) => setAiInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && submitAi) {
                    event.preventDefault();
                    submitAi();
                  }
                }}
                placeholder="e.g. sample sizes and study locations — note how each study reports them"
                rows={3}
                autoFocus
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                Beeblio AI adds the column and fills it in for every study in the matrix.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
              <Button type="submit" disabled={!submitAi}>
                <PencilSparkles />Create with AI
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim()) onSubmit(label.trim(), columnDescription.trim());
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="matrix-column-label">Label</Label>
              <Input
                id="matrix-column-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="e.g. Sample size"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="matrix-column-description">Description (optional)</Label>
              <Input
                id="matrix-column-description"
                value={columnDescription}
                onChange={(event) => setColumnDescription(event.target.value)}
                placeholder="e.g. Reported n, by study arm"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
              <Button type="submit" disabled={!label.trim()}>{submitLabel}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddStudiesDialog({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (topic: string) => void;
}) {
  const [topic, setTopic] = useState("");
  useEffect(() => {
    if (open) setTopic("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add studies with Beeblio AI</DialogTitle>
          <DialogDescription>
            Beeblio AI will search the literature, save the citations, and add the studies to this matrix.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (topic.trim().length >= 2) onSubmit(topic.trim());
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="matrix-studies-topic">Topic</Label>
            <Input
              id="matrix-studies-topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="e.g. gamification effects on student engagement"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={topic.trim().length < 2}>
              <PencilSparkles />Find Studies
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Replaces the shell's default raw-file download: the matrix exports as JSON
// by default, with the rendered formats alongside (mirrors the markdown
// editor's download menu).
function MatrixDownloadMenu({
  readOnly,
  onDownloadJson,
  onDownloadMarkdown,
  onDownloadCsv,
  onCopyMarkdown,
  onSaveMarkdownTable,
}: {
  readOnly: boolean;
  onDownloadJson: () => void;
  onDownloadMarkdown: () => void;
  onDownloadCsv: () => void;
  onCopyMarkdown: () => void;
  onSaveMarkdownTable: () => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Choose a download format">
              <Download />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Download Table</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52 min-w-52">
        <DropdownMenuItem onSelect={onDownloadJson}><FileJson />JSON</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDownloadMarkdown}><FileText />Markdown Table</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDownloadCsv}><FileSpreadsheet />CSV</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCopyMarkdown}><Copy />Copy as Markdown</DropdownMenuItem>
        {!readOnly ? (
          <DropdownMenuItem onSelect={onSaveMarkdownTable}><Save />Save to Folder</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MatrixRowView({
  row,
  columns,
  readOnly,
  showUnlinked,
  onRemove,
  dragging,
  dropSide,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onSetCell,
  onOpen,
}: {
  row: ResolvedMatrixRow;
  columns: LiteratureMatrix["columns"];
  readOnly: boolean;
  showUnlinked: boolean;
  onRemove: () => void;
  dragging: boolean;
  dropSide?: "before" | "after";
  onDragStart: React.DragEventHandler<HTMLButtonElement>;
  onDragOver: React.DragEventHandler<HTMLTableRowElement>;
  onDrop: React.DragEventHandler<HTMLTableRowElement>;
  onDragEnd: React.DragEventHandler<HTMLButtonElement>;
  onSetCell: (columnId: string, value: string) => void;
  onOpen: () => void;
}) {
  return (
    <tr
      className={cn("group/row cursor-pointer hover:bg-muted/30", dragging && "opacity-50")}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a, input, textarea, select, [role=button]")) return;
        onOpen();
      }}
    >
      <th className={cn(
        "sticky left-0 z-10 min-w-56 max-w-72 border-b border-r bg-card px-2 py-0 text-left align-top font-normal group-hover/row:bg-muted/80",
        dropSide === "before" && "border-t-2 border-t-primary",
        dropSide === "after" && "border-b-2 border-b-primary",
      )}>
        <div className="flex items-start gap-1 py-2 pr-1">
          {!readOnly ? (
            <div className="flex shrink-0 flex-col items-center">
              <button
                type="button"
                draggable
                className="flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
                aria-label={`Drag to reorder ${row.title}`}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              >
                <GripVertical className="size-3.5" />
              </button>
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100"
                aria-label={`Remove ${row.title} from the matrix`}
                onClick={onRemove}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="line-clamp-3 text-left text-xs font-medium leading-[1.45] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpen}
            >
              {row.title}
            </button>
            <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-muted-foreground">
              <span className="truncate font-mono" title={row.citationKey}>{row.citationKey}</span>
              {showUnlinked && !row.linked ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                      <TriangleAlert className="size-3" />unlinked
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64 text-xs">
                    This citation key is not in {PROJECT_BIBLIOGRAPHY_PATH} — showing the snapshot saved with the row.
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          </div>
          {row.link ? (
            <a
              href={row.link}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open the source for ${row.title}`}
              title={row.link}
            >
              <ArrowUpRight className="size-3.5" />
            </a>
          ) : null}
        </div>
      </th>
      {columns.map((column) => (
        <td key={column.id} className="min-w-44 max-w-72 border-b border-r p-0 align-top">
          {readOnly ? (
            <div className={cn("min-h-[2.25rem] break-words px-2 py-2 text-xs leading-[1.45]", column.kind === "derived" && "text-muted-foreground")}>
              {row.values[column.id] || <span className="text-muted-foreground/50">—</span>}
            </div>
          ) : (
            <MatrixCellInput
              ariaLabel={`${row.title}, ${matrixColumnLabel(column)}`}
              value={row.values[column.id] ?? ""}
              placeholder={column.kind === "derived" ? "From references.bib" : "—"}
              onChange={(value) => onSetCell(column.id, value)}
            />
          )}
        </td>
      ))}
    </tr>
  );
}

// Editable matrix cell: a textarea that auto-grows with its content so text
// wraps within the column instead of stretching the table or scrolling.
function MatrixCellInput({
  ariaLabel,
  value,
  placeholder,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className="block min-h-[2.25rem] w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-2 py-2 text-xs leading-[1.45] outline-none focus:bg-primary/5 focus:ring-2 focus:ring-inset focus:ring-primary"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
