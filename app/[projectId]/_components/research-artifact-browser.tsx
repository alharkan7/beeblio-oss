"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Braces,
  ClipboardList,
  Database,
  FileCode2,
  FileAudio,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  LibraryBig, BookOpenText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Table2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DEFAULT_MATRIX_PATH, MATRIX_EXTENSION } from "@/lib/literature-matrix";
import { isAudioFileName, isVideoFileName } from "@/lib/media-files";
import { FORMS_DIRECTORY, responsesPathFor } from "@/lib/forms/schema";
import {
  acceptsArtifactFile,
  ARTIFACT_UPLOAD_CONFIG,
  artifactFileExtension,
  FIGURE_DIAGRAM_EXTENSIONS,
  FIGURE_IMAGE_EXTENSIONS,
  isFigureFileName,
} from "@/lib/research-artifact-files";
import {
  ANALYSIS_DIRECTORY,
  DATA_DIRECTORY,
  isInsideWorkspaceDirectory,
  REFERENCES_DIRECTORY,
  REPORTS_DIRECTORY,
} from "@/lib/research-workspace";
import { PROJECT_BIBLIOGRAPHY_PATH, BIB_IMPORTS_DIRECTORY } from "@/lib/project-bibliography";
import { cn } from "@/lib/utils";
import {
  applyMutationToFlatListing,
  dispatchWorkspaceMutation,
  seedFolderListingsFromFlatListing,
  WORKSPACE_MUTATION_EVENT,
  type WorkspaceMutation,
} from "@/lib/workspace-mutations";
import { setWorkspaceDragData, WORKSPACE_PATHS_DRAG_TYPE } from "@/lib/workspace-drag";
import { listAllFiles, type FileEntry } from "../file-actions";
import { createMatrixFile } from "../matrix-actions";
import { PendingUploadRow } from "./pending-upload-row";
import { usePendingUploads } from "./use-pending-uploads";
import { announceFormCreated, createFormInFormsFolder } from "./form-creation";
import { fileUrl } from "./file-viewer";
import { editorLoadsTextContent } from "./editors/registry";
import { prefetchTextFile } from "./editors/text-content-cache";
import { WorkspaceFileActions } from "./workspace-file-actions";
import { MatrixTargetDialog, useMatrixAdd } from "./matrix-add";
import { BibliographyAddMenu } from "./bibliography-add-menu";
import { errorDetail } from "@/lib/error-detail";

export type ResearchArtifactView = "references" | "data" | "analysis" | "reports" | "figures";

// Hover warmth: text-backed artifacts pull their content into the cache so
// the click opens without the server-action round trip. Non-text artifacts
// (figures, media) don't read that cache and are skipped by the guard.
function warmArtifact(projectId: string, file: FileEntry) {
  if (editorLoadsTextContent(file.name)) prefetchTextFile(projectId, file.path);
}

function isFormFile(file: FileEntry) {
  return file.name.toLowerCase().endsWith(".form.html");
}

function isResponsesFile(file: FileEntry) {
  return file.name.toLowerCase().endsWith(".responses.csv");
}

// Workspace folders carry a numeric sort prefix ("2-Data"); copy refers to
// them by their plain names.
function directoryLabel(directory: string) {
  return directory.replace(/^\d+-/, "");
}

const VIEW_DETAILS = {
  references: {
    title: "My Library",
    description: `Files in ${directoryLabel(REFERENCES_DIRECTORY)} Folder`,
    emptyTitle: "No Reference Files Yet",
    emptyDescription: `Saved papers, bibliography files, and supplementary material in ${directoryLabel(REFERENCES_DIRECTORY)} appear here.`,
    icon: BookOpenText,
  },
  data: {
    title: "Data",
    description: `Files in ${directoryLabel(DATA_DIRECTORY)} Folder`,
    emptyTitle: "No Data Files Yet",
    emptyDescription: `Add datasets and related material to ${directoryLabel(DATA_DIRECTORY)}, or create a survey form to collect data.`,
    icon: Database,
  },
  analysis: {
    title: "Analysis",
    description: `Files in ${directoryLabel(ANALYSIS_DIRECTORY)} Folder`,
    emptyTitle: "No Analysis Files Yet",
    emptyDescription: `Scripts, outputs, dashboards, and results in ${directoryLabel(ANALYSIS_DIRECTORY)} appear here.`,
    icon: Braces,
  },
  reports: {
    title: "Reports",
    description: `Files in ${directoryLabel(REPORTS_DIRECTORY)} Folder`,
    emptyTitle: "No Reports Yet",
    emptyDescription: `Drafts and final deliverables in ${directoryLabel(REPORTS_DIRECTORY)} appear here.`,
    icon: FileText,
  },
  figures: {
    title: "Figures",
    description: "Files in Analysis & Reports",
    emptyTitle: "No Figures Yet",
    emptyDescription: "Charts, diagrams, images, and visualizations from Analysis and Reports appear here.",
    icon: BarChart3,
  },
} satisfies Record<ResearchArtifactView, {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  icon: typeof Database;
}>;

const HTML_EXTENSIONS = new Set(["htm", "html"]);

const extensionOf = artifactFileExtension;

function isFigure(file: FileEntry) { return isFigureFileName(file.name); }

function belongsToView(file: FileEntry, view: ResearchArtifactView) {
  if (file.isDir) return false;
  if (view === "references") return isInsideWorkspaceDirectory(file.path, REFERENCES_DIRECTORY);
  if (view === "data") return isInsideWorkspaceDirectory(file.path, DATA_DIRECTORY);
  if (view === "analysis") return isInsideWorkspaceDirectory(file.path, ANALYSIS_DIRECTORY);
  if (view === "reports") return isInsideWorkspaceDirectory(file.path, REPORTS_DIRECTORY);
  return (
    isInsideWorkspaceDirectory(file.path, ANALYSIS_DIRECTORY) ||
    isInsideWorkspaceDirectory(file.path, REPORTS_DIRECTORY)
  ) && isFigure(file);
}

function uniqueEntries(entries: FileEntry[]) {
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

export function ResearchArtifactBrowser({
  view,
  projectId,
  initialFiles,
  initialRootTreeChildren,
  initialAllFiles,
  activeFilePath,
  onOpenFile,
}: {
  view: ResearchArtifactView;
  projectId: string;
  initialFiles: FileEntry[];
  initialRootTreeChildren: Record<string, FileEntry[]>;
  initialAllFiles?: FileEntry[];
  activeFilePath?: string;
  onOpenFile: (file: FileEntry, pinned?: boolean) => void;
}) {
  const initialEntries = useMemo(
    () => uniqueEntries(initialAllFiles ?? [
      ...initialFiles,
      ...Object.values(initialRootTreeChildren).flat(),
    ]),
    [initialAllFiles, initialFiles, initialRootTreeChildren],
  );
  const [entries, setEntries] = useState(initialEntries);
  const [query, setQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [bibliographyDrop, setBibliographyDrop] = useState<{ id: number; files: globalThis.File[] }>();
  const [newFormOpen, setNewFormOpen] = useState(false);
  const [newFormName, setNewFormName] = useState("");
  const [newFormPending, setNewFormPending] = useState(false);
  const [newMatrixOpen, setNewMatrixOpen] = useState(false);
  const [newMatrixName, setNewMatrixName] = useState("");
  const [newMatrixPending, setNewMatrixPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { pendingUploads, uploadFiles, addPendingUpload, removePendingUpload } =
    usePendingUploads(projectId);
  const details = VIEW_DETAILS[view];
  const ViewIcon = details.icon;
  const uploadConfig = view === "references" ? null : ARTIFACT_UPLOAD_CONFIG[view];

  const refresh = useCallback(async (showIndicator = true) => {
    if (showIndicator) setIsRefreshing(true);
    try {
      const listing = await listAllFiles(projectId);
      setEntries(listing);
      seedFolderListingsFromFlatListing(listing);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      if (showIndicator) setIsRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!initialAllFiles) void refresh(initialEntries.length === 0);
    const handleWorkspaceChanged = () => void refresh(false);
    window.addEventListener("beeblio:workspace-changed", handleWorkspaceChanged);
    window.addEventListener("focus", handleWorkspaceChanged);
    return () => {
      window.removeEventListener("beeblio:workspace-changed", handleWorkspaceChanged);
      window.removeEventListener("focus", handleWorkspaceChanged);
    };
  }, [initialAllFiles, initialEntries.length, refresh]);

  // Actions with a known outcome (rename, move, delete, duplicate, upload)
  // broadcast mutations; apply them to the flat listing immediately, with the
  // refresh above reconciling against the server in the background.
  useEffect(() => {
    const handleMutation = (event: Event) => {
      const mutation = (event as CustomEvent<WorkspaceMutation>).detail;
      setEntries((current) => applyMutationToFlatListing(current, mutation));
    };
    window.addEventListener(WORKSPACE_MUTATION_EVENT, handleMutation);
    return () => window.removeEventListener(WORKSPACE_MUTATION_EVENT, handleMutation);
  }, []);

  const files = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries
      .filter((entry) => belongsToView(entry, view))
      // Search matches what the rows display: filenames everywhere, plus the
      // folder within 1-References shown under each library row. Matching the
      // full path made queries like "analy" match everything in 3-Analysis
      // without the panel showing why.
      .filter((entry) => !normalizedQuery ||
        entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
        (view === "references" &&
          (relativePath(entry.path, REFERENCES_DIRECTORY)
            .toLocaleLowerCase()
            .includes(normalizedQuery) ||
          (entry.path === PROJECT_BIBLIOGRAPHY_PATH &&
            "project bibliography".includes(normalizedQuery)))))
      .sort((left, right) => {
        if (view === "references") {
          const leftIsBib = left.path === PROJECT_BIBLIOGRAPHY_PATH;
          const rightIsBib = right.path === PROJECT_BIBLIOGRAPHY_PATH;
          if (leftIsBib !== rightIsBib) return leftIsBib ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
  }, [entries, query, view]);

  const allViewFiles = useMemo(
    () => entries.filter((entry) => belongsToView(entry, view)),
    [entries, view],
  );

  // The Library also carries the literature matrices. They are ordinary
  // workspace files (.matrix, stored in 3-Analysis), so they derive from the
  // listing the panel already fetches — ordered like listMatrixFiles: the
  // default matrix first, then by name.
  const matrices = useMemo(() => {
    if (view !== "references") return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries
      .filter((entry) => !entry.isDir && entry.name.toLocaleLowerCase().endsWith(`.${MATRIX_EXTENSION}`))
      .filter((entry) => !normalizedQuery ||
        entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
        entry.path.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        const leftDefault = left.path === DEFAULT_MATRIX_PATH;
        const rightDefault = right.path === DEFAULT_MATRIX_PATH;
        if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [entries, query, view]);

  // Uploads in flight for this view's target directory, rendered as a pinned
  // "Uploading" section above the lists. The Library tab's additions ride
  // along too: PDFs land in References, BibTeX files stage in the hidden
  // imports folder while they merge into the bibliography.
  const pendingForView = useMemo(() => {
    if (uploadConfig) {
      return pendingUploads.filter((entry) => entry.folder === uploadConfig.directory);
    }
    if (view === "references") {
      return pendingUploads.filter(
        (entry) => entry.folder === REFERENCES_DIRECTORY || entry.folder === BIB_IMPORTS_DIRECTORY,
      );
    }
    return [];
  }, [pendingUploads, uploadConfig, view]);

  // Dropped or picked files become grayed pending rows (the "Uploading"
  // section below) right away; this wraps the shared pipeline with the view's
  // accept filter and toasts. The add button stays usable while uploads run.
  const handleUploadFiles = async (files: FileList | globalThis.File[]) => {
    if (!uploadConfig || view === "references") return;
    const selected = Array.from(files);
    const accepted = selected.filter((file) => acceptsArtifactFile(view, file.name));
    const rejected = selected.filter((file) => !acceptsArtifactFile(view, file.name));

    if (rejected.length) {
      toast.error(`${rejected.length} incompatible ${rejected.length === 1 ? "file" : "files"} skipped`, {
        description: `${details.title} accepts ${uploadConfig.formats}.`,
      });
    }
    if (!accepted.length) return;

    try {
      const outcomes = await uploadFiles(uploadConfig.directory, accepted);
      for (const outcome of outcomes) {
        if (outcome.ok) continue;
        toast.error(
          outcome.storageLimit
            ? `Storage limit reached — ${outcome.name} not uploaded`
            : `Unable to upload ${outcome.name}`,
          { description: outcome.error },
        );
      }
      const uploaded = outcomes.filter((outcome) => outcome.ok).length;
      if (uploaded) {
        toast.success(`${uploaded} ${uploaded === 1 ? "file" : "files"} added to ${details.title}`);
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const acceptsExternalDrop = Boolean(uploadConfig || view === "references");

  const handleCreateForm = async () => {
    const name = newFormName.trim();
    if (!name || newFormPending) return;
    setNewFormPending(true);
    try {
      const file = await createFormInFormsFolder(projectId, name);
      toast.success(`${file.name} created in ${FORMS_DIRECTORY}`);
      setNewFormOpen(false);
      setNewFormName("");
      announceFormCreated();
      await refresh(false);
      onOpenFile(file, true);
    } catch (error) {
      toast.error("Failed to create form", {
        description: errorDetail(error),
      });
    } finally {
      setNewFormPending(false);
    }
  };

  const handleCreateMatrix = async () => {
    const name = newMatrixName.trim();
    if (!name || newMatrixPending) return;
    setNewMatrixPending(true);
    try {
      const result = await createMatrixFile({ projectId, name });
      if (!result.success) {
        toast.error("Could not create the matrix", { description: result.error });
        return;
      }
      const file: FileEntry = {
        name: result.matrixPath.split("/").at(-1) || result.matrixPath,
        path: result.matrixPath,
        isDir: false,
        size: 0,
      };
      dispatchWorkspaceMutation({ kind: "create", entry: file });
      window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
      setNewMatrixOpen(false);
      setNewMatrixName("");
      onOpenFile(file, true);
    } catch (error) {
      toast.error("Could not create the matrix", {
        description: errorDetail(error),
      });
    } finally {
      setNewMatrixPending(false);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!acceptsExternalDrop || event.dataTransfer.types.includes(WORKSPACE_PATHS_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingUpload(true);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!acceptsExternalDrop || event.dataTransfer.types.includes(WORKSPACE_PATHS_DRAG_TYPE)) return;
    event.preventDefault();
    setIsDraggingUpload(false);
    if (!event.dataTransfer.files.length) return;
    if (view === "references") {
      const selected = Array.from(event.dataTransfer.files);
      const accepted = selected.filter((file) => /\.(?:bib|pdf)$/i.test(file.name));
      const rejected = selected.length - accepted.length;
      if (rejected) toast.error(`${rejected} incompatible ${rejected === 1 ? "file" : "files"} skipped`, { description: "Bibliography accepts PDF papers and BibTeX (.bib) files." });
      if (accepted.length) setBibliographyDrop({ id: Date.now(), files: accepted });
      return;
    }
    void handleUploadFiles(event.dataTransfer.files);
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDraggingUpload(false);
      }}
      onDrop={handleDrop}
    >
      <div className="shrink-0 border-b bg-card/55 p-3">
        <div className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ViewIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">{details.title}</h2>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground" aria-live="polite">
                {allViewFiles.length}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={details.description}>
              {details.description}
            </p>
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={isRefreshing}
            aria-label={`Refresh ${details.title.toLocaleLowerCase()}`}
            title="Refresh"
          >
            {isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${details.title}…`}
              aria-label={`Search ${details.title}`}
              className="h-8 rounded-lg pl-8 text-xs md:text-xs"
            />
          </div>
          {uploadConfig ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={uploadConfig.accept}
                className="hidden"
                onChange={(event) => {
                  if (event.target.files?.length) void handleUploadFiles(event.target.files);
                }}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="default"
                className="shrink-0 rounded-full"
                onClick={() => fileInputRef.current?.click()}
                aria-label={`Add files to ${details.title}`}
                title={`Add ${details.title.toLocaleLowerCase()} files`}
              >
                <Plus />
              </Button>
              {view === "data" ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="default"
                  className="shrink-0 rounded-full"
                  // onClick={() => notifyUpcomingFeature("Survey forms")}
                  onClick={() => setNewFormOpen(true)}
                  aria-label="Create a new survey form"
                  title="New survey form"
                >
                  <ClipboardList />
                </Button>
              ) : null}
            </>
          ) : view === "references" ? (
            <>
              <BibliographyAddMenu
                projectId={projectId}
                dropRequest={bibliographyDrop}
                addPendingUpload={addPendingUpload}
                removePendingUpload={removePendingUpload}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="default"
                className="shrink-0 rounded-full"
                onClick={() => setNewMatrixOpen(true)}
                aria-label="Create a new literature matrix"
                title="New literature matrix"
              >
                <Table2 />
              </Button>
            </>
          ) : null}
        </div>
        {loadError ? (
          <p className="mt-2 text-[10px] text-destructive" role="status">
            Couldn&apos;t refresh this view. Showing the last available files.
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {pendingForView.length > 0 ? (
          <section className="mb-3" aria-label="Uploads in progress">
            <p className="mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Uploading
            </p>
            <div className="overflow-hidden rounded-xl border border-dashed">
              {pendingForView.map((entry) => (
                <PendingUploadRow
                  key={`pending:${entry.pendingId}`}
                  icon={pendingUploadIcon(view, entry.name)}
                  name={entry.name}
                  detail={formatBytes(entry.size)}
                  className="rounded-none border-b border-border/60 px-2.5 py-2 last:border-b-0"
                />
              ))}
            </div>
          </section>
        ) : null}
        {isRefreshing && entries.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : files.length === 0 && matrices.length === 0 && pendingForView.length === 0 ? (
          <EmptyState
            icon={ViewIcon}
            title={query.trim() ? `No ${details.title.toLocaleLowerCase()} match your search` : details.emptyTitle}
            description={query.trim()
              ? view === "references" ? "Try a filename, folder, or matrix name." : "Try a different filename."
              : details.emptyDescription}
          />
        ) : view === "references" ? (
          <ReferencesList files={files} matrices={matrices} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} />
        ) : view === "figures" ? (
          <FigureGrid
            files={files}
            projectId={projectId}
            activeFilePath={activeFilePath}
            onOpenFile={onOpenFile}
          />
        ) : view === "data" ? (
          <DataList files={files} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} />
        ) : view === "analysis" ? (
          <AnalysisList files={files} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} />
        ) : (
          <ReportsList files={files} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} />
        )}
      </div>
      {isDraggingUpload && acceptsExternalDrop ? (
        <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 p-5 text-center shadow-sm backdrop-blur-sm">
          <div>
            <Plus className="mx-auto size-6 text-primary" />
            <p className="mt-2 text-xs font-semibold text-primary">Drop files into {details.title}</p>
            <p className="mt-1 max-w-52 text-[10px] leading-4 text-muted-foreground">{uploadConfig?.formats || "PDF papers and BibTeX (.bib) files"}</p>
          </div>
        </div>
      ) : null}

      <Dialog
        open={newFormOpen}
        onOpenChange={(open) => {
          setNewFormOpen(open);
          if (!open) setNewFormName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Survey Form</DialogTitle>
            <DialogDescription>
              {/* Creates a form in {FORMS_DIRECTORY} that you can build visually and share publicly. */}
              {/* Responses are saved to a CSV file next to it. */}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newFormName}
            onChange={(event) => setNewFormName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void handleCreateForm()}
            placeholder="Form name (e.g. Course Evaluation)"
            aria-label="Form name"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewFormOpen(false)} disabled={newFormPending}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreateForm()} disabled={!newFormName.trim() || newFormPending}>
              {newFormPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
              Create Form
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={newMatrixOpen}
        onOpenChange={(open) => {
          if (!open && newMatrixPending) return;
          setNewMatrixOpen(open);
          if (!open) setNewMatrixName("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Literature Matrix</DialogTitle>
            <DialogDescription>
              Creates an empty comparison table in {ANALYSIS_DIRECTORY}. Add studies from search results, your reference library, or Beeblio AI.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (newMatrixName.trim()) void handleCreateMatrix();
            }}
          >
            <Input
              value={newMatrixName}
              onChange={(event) => setNewMatrixName(event.target.value)}
              placeholder="e.g. Systematic review screening"
              aria-label="Matrix name"
              autoFocus
              disabled={newMatrixPending}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setNewMatrixOpen(false)} disabled={newMatrixPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={newMatrixPending || !newMatrixName.trim()}>
                {newMatrixPending ? <Loader2 className="animate-spin" /> : <Plus />}
                Create Matrix
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReferencesList({
  files,
  matrices,
  projectId,
  activeFilePath,
  onOpenFile,
}: ArtifactListProps & { matrices: FileEntry[] }) {
  const matrixAdd = useMatrixAdd(projectId);
  const addPdfToMatrix = useCallback((file: FileEntry) => {
    matrixAdd.add({ kind: "pdf", path: file.path });
  }, [matrixAdd.add]);
  // The bibliography database leads the list, matrices follow as a labeled
  // group, and the remaining reference files close it out. The "References"
  // label appears only when matrices are on screen, so matrix-free projects
  // keep the flat list they had before.
  const canonical = files.filter((file) => file.path === PROJECT_BIBLIOGRAPHY_PATH);
  const others = files
    .filter((file) => file.path !== PROJECT_BIBLIOGRAPHY_PATH)
    .sort((left, right) => {
      const leftType = extensionOf(left.name);
      const rightType = extensionOf(right.name);
      if (leftType !== rightType) {
        if (leftType === "pdf") return -1;
        if (rightType === "pdf") return 1;
        return leftType.localeCompare(rightType);
      }
      return left.name.localeCompare(right.name);
    });
  return (
    <div className="space-y-1">
      {canonical.map((file) => (
        <ReferenceRow key={file.path} file={file} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onAddPdfToMatrix={addPdfToMatrix} />
      ))}
      <MatricesGroup matrices={matrices} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} />
      {others.length ? matrices.length ? (
        <section>
          <p className="mb-1.5 px-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            References
          </p>
          <div className="space-y-1">
            {others.map((file) => (
              <ReferenceRow key={file.path} file={file} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onAddPdfToMatrix={addPdfToMatrix} />
            ))}
          </div>
        </section>
      ) : (
        others.map((file) => (
          <ReferenceRow key={file.path} file={file} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onAddPdfToMatrix={addPdfToMatrix} />
        ))
      ) : null}
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

function ReferenceRow({
  file,
  projectId,
  activeFilePath,
  onOpenFile,
  onAddPdfToMatrix,
}: {
  file: FileEntry;
  projectId: string;
  activeFilePath?: string;
  onOpenFile: (file: FileEntry, pinned?: boolean) => void;
  onAddPdfToMatrix: (file: FileEntry) => void;
}) {
  const isCanonical = file.path === PROJECT_BIBLIOGRAPHY_PATH;
  const extension = extensionOf(file.name);
  const ReferenceIcon = isCanonical
    ? BookOpenText
    : extension === "pdf"
      ? FileText
      : extension === "bib"
        ? LibraryBig
        : FileText;

  return (
    <div className="group relative min-w-0">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          activeFilePath === file.path && "border-primary/25 bg-accent",
        )}
        onClick={() => onOpenFile(file)}
        onDoubleClick={() => onOpenFile(file, true)}
        onPointerEnter={() => warmArtifact(projectId, file)}
        onFocus={() => warmArtifact(projectId, file)}
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
            isCanonical
              ? "bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
              : extension === "pdf"
                ? "bg-red-500/10 text-red-500"
              : "bg-primary/10 text-primary",
          )}
        >
          <ReferenceIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{file.name}</span>
          <span className="block truncate text-[10px] text-muted-foreground" title={file.path}>
            {relativePath(file.path, REFERENCES_DIRECTORY)}
          </span>
        </span>
        <span
          className={cn(
            "flex shrink-0 flex-col items-end gap-0.5 text-[9px] text-muted-foreground transition-transform",
            !isCanonical && "group-focus-within:-translate-x-8 [@media(hover:hover)]:group-hover:-translate-x-8 [@media(hover:none)]:-translate-x-8",
          )}
        >
          <span className="font-semibold uppercase">{extension || "file"}</span>
          <span className="tabular-nums">{formatBytes(file.size)}</span>
        </span>
      </button>
      {!isCanonical ? <ArtifactActions projectId={projectId} file={file} onAddToMatrix={extension === "pdf" ? () => onAddPdfToMatrix(file) : undefined} /> : null}
    </div>
  );
}

/**
 * Matrices group inside the Library panel: the .matrix comparison tables
 * (stored in 3-Analysis), listed right after the bibliography database.
 * Renders nothing while no matrix matches the search, the same way the Data
 * panel drops its Forms group.
 */
function MatricesGroup({
  matrices,
  projectId,
  activeFilePath,
  onOpenFile,
}: Omit<ArtifactListProps, "files"> & { matrices: FileEntry[] }) {
  if (matrices.length === 0) return null;
  return (
    <section>
      <p className="mb-1.5 px-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        Matrices
      </p>
      <div className="space-y-1">
        {matrices.map((matrix) => (
          <div key={matrix.path} className="group relative min-w-0">
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeFilePath === matrix.path && "border-primary/25 bg-accent",
              )}
              onClick={() => onOpenFile(matrix)}
              onDoubleClick={() => onOpenFile(matrix, true)}
              onPointerEnter={() => warmArtifact(projectId, matrix)}
              onFocus={() => warmArtifact(projectId, matrix)}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Table2 className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{matrix.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground" title={matrix.path}>{matrix.path}</span>
              </span>
              {matrix.path === DEFAULT_MATRIX_PATH ? (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-primary transition-transform group-focus-within:-translate-x-8 [@media(hover:hover)]:group-hover:-translate-x-8 [@media(hover:none)]:-translate-x-8">
                  Default
                </span>
              ) : null}
            </button>
            <ArtifactActions projectId={projectId} file={matrix} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Forms group inside the Data panel: each card pairs a form with its
 * collected responses CSV (a sub-row that appears once the first submission
 * lands). Renders nothing when there are no forms or response files.
 */
function FormsGroup({
  files,
  projectId,
  activeFilePath,
  onOpenFile,
}: ArtifactListProps) {
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const forms = files.filter(isFormFile);
  const pairedResponses = new Set(
    forms.map((form) => responsesPathFor(form.path)).filter((path) => byPath.has(path)),
  );
  const orphanResponses = files.filter(
    (file) => isResponsesFile(file) && !pairedResponses.has(file.path),
  );
  if (forms.length === 0 && orphanResponses.length === 0) return null;

  return (
    <section>
      <p className="mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        Forms
      </p>
      <div className="space-y-2">
      {forms.map((form) => {
        const responses = byPath.get(responsesPathFor(form.path));
        return (
          <div key={form.path} className="overflow-hidden rounded-xl border bg-card">
            <div className="group relative">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2.5 px-2.5 py-2 pr-10 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  activeFilePath === form.path && "bg-accent",
                )}
                onClick={() => onOpenFile(form)}
                onDoubleClick={() => onOpenFile(form, true)}
                onPointerEnter={() => warmArtifact(projectId, form)}
                onFocus={() => warmArtifact(projectId, form)}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
                  <ClipboardList className="size-4" />
                </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{form.name}</span>
                </button>
                <ArtifactActions projectId={projectId} file={form} />
            </div>
              {responses ? (
                <div className="group relative border-t">
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2.5 bg-muted/25 py-1.5 pl-4 pr-2.5 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      activeFilePath === responses.path && "bg-accent",
                    )}
                    onClick={() => onOpenFile(responses)}
                    onDoubleClick={() => onOpenFile(responses, true)}
                    onPointerEnter={() => warmArtifact(projectId, responses)}
                    onFocus={() => warmArtifact(projectId, responses)}
                  >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                    <FileSpreadsheet className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{responses.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">Collected Responses</span>
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground transition-transform group-focus-within:-translate-x-8 [@media(hover:hover)]:group-hover:-translate-x-8 [@media(hover:none)]:-translate-x-8">
                    {formatBytes(responses.size)}
                  </span>
                </button>
                <ArtifactActions projectId={projectId} file={responses} />
              </div>
            ) : null}
          </div>
        );
      })}
        {orphanResponses.map((responses) => (
          <div key={responses.path} className="group relative overflow-hidden rounded-xl border bg-card">
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                activeFilePath === responses.path && "bg-accent",
              )}
              onClick={() => onOpenFile(responses)}
              onDoubleClick={() => onOpenFile(responses, true)}
              onPointerEnter={() => warmArtifact(projectId, responses)}
              onFocus={() => warmArtifact(projectId, responses)}
            >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              <FileSpreadsheet className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{responses.name}</span>
              <span className="block truncate text-[10px] text-muted-foreground">Collected Responses</span>
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground transition-transform group-focus-within:-translate-x-8 [@media(hover:hover)]:group-hover:-translate-x-8 [@media(hover:none)]:-translate-x-8">
              {formatBytes(responses.size)}
            </span>
          </button>
          <ArtifactActions projectId={projectId} file={responses} />
        </div>
      ))}
      </div>
    </section>
  );
}

function DataList({
  files,
  projectId,
  activeFilePath,
  onOpenFile,
}: ArtifactListProps) {
  // Plain datasets first, then the forms group (forms paired with their
  // responses, plus orphaned response files if a form was deleted).
  const datasets = files.filter((file) => !isFormFile(file) && !isResponsesFile(file));
  return (
    <div className="space-y-4">
      {datasets.length > 0 ? (
        <section>
          <p className="mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Datasets
          </p>
          <div className="overflow-hidden rounded-xl border bg-card">
            {datasets.map((file) => {
              const extension = extensionOf(file.name);
              return (
                <div key={file.path} className="group relative border-b last:border-b-0">
                  <button
                    type="button"
                    className={cn(
                      "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      activeFilePath === file.path && "bg-accent",
                    )}
                    onClick={() => onOpenFile(file)}
                    onDoubleClick={() => onOpenFile(file, true)}
                    onPointerEnter={() => warmArtifact(projectId, file)}
                    onFocus={() => warmArtifact(projectId, file)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"><DataFileIcon extension={extension} name={file.name} /></span>
                      <span className="min-w-0 truncate text-xs font-medium">{file.name}</span>
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground transition-transform group-focus-within:-translate-x-8 [@media(hover:hover)]:group-hover:-translate-x-8 [@media(hover:none)]:-translate-x-8">{formatBytes(file.size)}</span>
                  </button>
                  <ArtifactActions projectId={projectId} file={file} />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <FormsGroup files={files} projectId={projectId} activeFilePath={activeFilePath} onOpenFile={onOpenFile} />
    </div>
  );
}

function AnalysisList({ files, projectId, activeFilePath, onOpenFile }: ArtifactListProps) {
  return (
    <div className="space-y-1">
      {files.map((file) => {
        const extension = extensionOf(file.name);
        return (
          <div key={file.path} className="group relative">
          <button type="button" className={cn("flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", activeFilePath === file.path && "border-primary/25 bg-accent")} onClick={() => onOpenFile(file)} onDoubleClick={() => onOpenFile(file, true)} onPointerEnter={() => warmArtifact(projectId, file)} onFocus={() => warmArtifact(projectId, file)}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-300">
              <AnalysisFileIcon extension={extension} name={file.name} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{file.name}</span>
              <span className="block text-[10px] tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
            </span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground transition-transform group-focus-within:-translate-x-8 [@media(hover:hover)]:group-hover:-translate-x-8 [@media(hover:none)]:-translate-x-8">
              {extension || "file"}
            </span>
          </button><ArtifactActions projectId={projectId} file={file} />
          </div>
        );
      })}
    </div>
  );
}

function ReportsList({ files, projectId, activeFilePath, onOpenFile }: ArtifactListProps) {
  return (
    <div className="space-y-2">
      {files.map((file) => {
        const extension = extensionOf(file.name);
        return (
          <div key={file.path} className="group relative">
          <button
            type="button"
            className={cn(
              "flex w-full items-stretch overflow-hidden rounded-xl border bg-card pr-9 text-left shadow-[0_4px_14px_-12px_rgb(18_35_48/0.5)] transition-[border-color,transform] hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activeFilePath === file.path && "border-primary/40 ring-1 ring-primary/15",
            )}
            onClick={() => onOpenFile(file)}
            onDoubleClick={() => onOpenFile(file, true)}
            onPointerEnter={() => warmArtifact(projectId, file)}
            onFocus={() => warmArtifact(projectId, file)}
          >
            <span className="flex w-10 shrink-0 items-center justify-center border-r bg-amber-500/8 text-amber-700 dark:text-amber-300">
              <FileText className="size-4" />
            </span>
            <span className="min-w-0 flex-1 px-2.5 py-2.5">
              <span className="block truncate text-xs font-medium">{file.name}</span>
              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="shrink-0 uppercase">{extension || "file"}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{formatBytes(file.size)}</span>
              </span>
            </span>
          </button><ArtifactActions projectId={projectId} file={file} />
          </div>
        );
      })}
    </div>
  );
}

function FigureGrid({
  files,
  projectId,
  activeFilePath,
  onOpenFile,
}: ArtifactListProps & { projectId: string }) {
  return (
    <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 overflow-hidden">
      {files.map((file) => {
        const extension = extensionOf(file.name);
        return (
          <div key={file.path} className="group relative min-w-0 max-w-full overflow-hidden">
          <button
            type="button"
            draggable
            className={cn(
              "group w-full min-w-0 max-w-full overflow-hidden rounded-xl border bg-card text-left transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activeFilePath === file.path && "border-primary/50 ring-1 ring-primary/20",
            )}
            aria-label={`Open ${file.name}`}
            onClick={() => onOpenFile(file)}
            onDoubleClick={() => onOpenFile(file, true)}
            onPointerEnter={() => warmArtifact(projectId, file)}
            onFocus={() => warmArtifact(projectId, file)}
            onDragStart={(event) => setWorkspaceDragData(event.dataTransfer, [file.path], "copy")}
          >
            <FigureThumbnail projectId={projectId} file={file} extension={extension} />
            <span className="block min-w-0 border-t px-2 py-2">
              <span className="block max-w-full truncate pr-8 text-[11px] font-medium" title={file.name}>{file.name}</span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[9px] text-muted-foreground">
                <span className="shrink-0">{figureLocation(file.path)}</span>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate uppercase">{extension}</span>
              </span>
            </span>
          </button><ArtifactActions projectId={projectId} file={file} className="right-1 top-auto bottom-3.5 translate-y-0" />
          </div>
        );
      })}
    </div>
  );
}

function FigureThumbnail({
  projectId,
  file,
  extension,
}: {
  projectId: string;
  file: FileEntry;
  extension: string;
}) {
  if (FIGURE_IMAGE_EXTENSIONS.has(extension)) {
    return (
      <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-[linear-gradient(45deg,var(--muted)_25%,transparent_25%),linear-gradient(-45deg,var(--muted)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--muted)_75%),linear-gradient(-45deg,transparent_75%,var(--muted)_75%)] bg-[length:14px_14px] bg-[position:0_0,0_7px,7px_-7px,-7px_0px]">
        {/* Workspace images are authenticated dynamic resources, so their dimensions are not known at build time. */}
        <img
          src={fileUrl(projectId, file.path)}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
        />
      </span>
    );
  }

  if (FIGURE_DIAGRAM_EXTENSIONS.has(extension)) {
    return <MermaidThumbnail projectId={projectId} file={file} />;
  }

  if (HTML_EXTENSIONS.has(extension)) {
    return (
      <span className="relative block aspect-[4/3] overflow-hidden bg-white">
        <iframe
          src={fileUrl(projectId, file.path)}
          title={`Thumbnail of ${file.name}`}
          sandbox=""
          loading="lazy"
          tabIndex={-1}
          className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50 border-0 bg-white"
        />
        <span className="absolute right-1.5 bottom-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[8px] font-semibold uppercase text-foreground shadow-sm">
          HTML
        </span>
      </span>
    );
  }

  return (
    <span className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-primary/5 text-muted-foreground">
      <FileJson className="size-7 text-primary/75" />
      <span className="text-[9px] font-semibold uppercase tracking-wider">
        Chart spec
      </span>
    </span>
  );
}

function MermaidThumbnail({ projectId, file }: { projectId: string; file: FileEntry }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const renderDiagram = async () => {
      setSvg(undefined);
      setFailed(false);

      try {
        const response = await fetch(fileUrl(projectId, file.path), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Unable to load diagram (${response.status})`);

        const source = await response.text();
        if (!source.trim()) throw new Error("Diagram is empty");

        const { createMermaidPlugin } = await import("@streamdown/mermaid");
        const renderer = createMermaidPlugin({
          config: {
            securityLevel: "strict",
            startOnLoad: false,
            suppressErrorRendering: true,
            theme: "neutral",
          },
        }).getMermaid();
        const renderId = `beeblio-figure-${Math.random().toString(36).slice(2)}`;
        const rendered = await renderer.render(renderId, source);
        if (!controller.signal.aborted) setSvg(rendered.svg);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };

    void renderDiagram();
    return () => controller.abort();
  }, [file.path, file.size, projectId]);

  if (svg) {
    return (
      <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-white p-2">
        <span
          className="flex size-full items-center justify-center [&_svg]:max-h-full [&_svg]:max-w-full"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </span>
    );
  }

  return (
    <span className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-primary/5 text-muted-foreground">
      {failed
        ? <BarChart3 className="size-7 text-primary/75" />
        : <Loader2 className="size-5 animate-spin text-primary/65" />}
      <span className="text-[9px] font-semibold uppercase tracking-wider">
        {failed ? "Preview unavailable" : "Rendering diagram"}
      </span>
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Database;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-4 py-8 text-center">
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <p className="mt-3 text-xs font-medium">{title}</p>
      <p className="mt-1 max-w-52 text-[11px] leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

type ArtifactListProps = {
  files: FileEntry[];
  projectId: string;
  activeFilePath?: string;
  onOpenFile: (file: FileEntry, pinned?: boolean) => void;
};

function ArtifactActions({ projectId, file, className, onAddToMatrix }: { projectId: string; file: FileEntry; className?: string; onAddToMatrix?: () => void }) {
  return <WorkspaceFileActions projectId={projectId} file={file} onAddToMatrix={onAddToMatrix} className={cn(
    "absolute right-1 top-1/2 z-10 -translate-y-1/2 opacity-70 transition-opacity group-focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100",
    className,
  )} />;
}

function DataFileIcon({ extension, name }: { extension: string; name: string }) {
  if (isAudioFileName(name)) return <FileAudio className="size-4" />;
  if (isVideoFileName(name)) return <FileVideo className="size-4" />;
  if (["csv", "tsv", "xls", "xlsx"].includes(extension)) return <FileSpreadsheet className="size-4" />;
  if (["json", "jsonl", "ndjson"].includes(extension)) return <FileJson className="size-4" />;
  return <Database className="size-4" />;
}

function AnalysisFileIcon({ extension, name }: { extension: string; name: string }) {
  if (isAudioFileName(name)) return <FileAudio className="size-4" />;
  if (isVideoFileName(name)) return <FileVideo className="size-4" />;
  if (["html", "htm", "svg", "png", "jpg", "jpeg", "webp"].includes(extension)) return <BarChart3 className="size-4" />;
  if (["json", "jsonl", "ndjson", "ipynb"].includes(extension)) return <FileJson className="size-4" />;
  if (extension === "matrix") return <Table2 className="size-4" />;
  return <FileCode2 className="size-4" />;
}

// Pending-upload rows borrow the icon of the row they will become.
function pendingUploadIcon(view: ResearchArtifactView, name: string) {
  const extension = extensionOf(name);
  if (view === "data") return <DataFileIcon extension={extension} name={name} />;
  if (view === "analysis") return <AnalysisFileIcon extension={extension} name={name} />;
  if (view === "figures") return <FileImage className="size-4" />;
  if (view === "references") {
    return extension === "bib" ? <LibraryBig className="size-4" /> : <FileText className="size-4 text-red-500" />;
  }
  return <FileText className="size-4" />;
}

function relativePath(filePath: string, root: string) {
  const relative = filePath.slice(root.length + 1);
  const parent = relative.split("/").slice(0, -1).join("/");
  return parent || root;
}

function figureLocation(filePath: string) {
  return filePath.startsWith(`${ANALYSIS_DIRECTORY}/`) ? "Analysis" : "Reports";
}

function formatBytes(size: number) {
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${(size / 1_000).toFixed(size < 10_000 ? 1 : 0)} KB`;
  return `${(size / 1_000_000).toFixed(size < 10_000_000 ? 1 : 0)} MB`;
}
