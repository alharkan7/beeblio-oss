"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowDown01,
  ArrowUp01,
  ArrowLeft,
  ArrowUpDown,
  BookOpen,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileJson,
  FileVideo,
  FileSpreadsheet,
  FileText,
  FileType2,
  Folder,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  MoreVertical,
  NotebookTabs,
  PenTool,
  Plus,
  Presentation,
  RotateCw,
  Search,
  SquareCheckBig,
  Table2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isAudioFileName, isVideoFileName } from "@/lib/media-files";
import { affectsProtectedWorkspacePath } from "@/lib/protected-workspace";
import {
  getWorkspaceDragPaths,
  setWorkspaceDragData,
  WORKSPACE_PATHS_DRAG_TYPE,
} from "@/lib/workspace-drag";
import {
  applyMutationToFolderListing,
  cachedFolderListing,
  dispatchWorkspaceMutation,
  pathBasename,
  rememberFolderListing,
  removedFolderRoot,
  WORKSPACE_MUTATION_EVENT,
  type WorkspaceMutation,
} from "@/lib/workspace-mutations";
import {
  createDirectory,
  deleteFiles,
  duplicateFiles,
  getRootTree,
  listAllFiles,
  listFiles,
  movePath,
} from "../file-actions";
import type { FileEntry } from "../file-actions";
import { PendingUploadRow } from "./pending-upload-row";
import { editorLoadsTextContent } from "./editors/registry";
import { prefetchTextFile } from "./editors/text-content-cache";
import { isPendingUpload, usePendingUploads } from "./use-pending-uploads";
import { WorkspaceFileActions } from "./workspace-file-actions";
import { announceFormCreated, createFormInFormsFolder, FORMS_DIRECTORY } from "./form-creation";
import { errorDetail } from "@/lib/error-detail";

// The chat (agent-chat.tsx) dispatches this when an agent turn completes, so the
// panel re-lists and picks up any file changes the agent made.
const REFRESH_EVENT = "beeblio:workspace-changed";

const EMPTY_FOLDER_GUIDANCE: Record<string, { title: string; description: string }> = {
  "1-References": {
    title: "Add reference material",
    description: "Upload papers, codebooks, bibliographies, or supporting documents.",
  },
  "2-Data": {
    title: "Add project data",
    description: "Original and derived datasets belong here; originals remain unchanged.",
  },
  "3-Analysis": {
    title: "No analysis artifacts yet",
    description: "Scripts, results, figures, and analytical tables appear here.",
  },
  "4-Reports": {
    title: "No reports yet",
    description: "Draft and final research deliverables appear here.",
  },
};

type SortOption = "name-asc" | "name-desc" | "type-asc" | "type-desc";

const SEARCH_RESULTS_LIMIT = 200;

// Parent folder of an entry relative to the project root, e.g.
// "2-Data/results" for "2-Data/results/figure.png"; "" for root entries.
function parentDirectoryOf(file: FileEntry) {
  return file.path.length > file.name.length
    ? file.path.slice(0, file.path.length - file.name.length - 1)
    : "";
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase() : "";
}

function fileTypeOf(file: FileEntry) {
  return file.isDir ? "folder" : extensionOf(file.name) || "file";
}

export function FileExplorer({
  projectId,
  initialFiles,
  initialRootTreeChildren,
  activeFilePath,
  onOpenFile,
  revealFolderRequest,
  onRevealFolderConsumed,
}: {
  projectId: string;
  initialFiles: FileEntry[];
  initialRootTreeChildren: Record<string, FileEntry[]>;
  activeFilePath?: string;
  onOpenFile: (file: FileEntry, pinned?: boolean) => void;
  /** Folder path a chat mention chip asked to reveal, handed down by the layout. */
  revealFolderRequest?: { path: string } | null;
  onRevealFolderConsumed?: () => void;
}) {
  const [cwd, setCwd] = useState(""); // project-relative path of the current folder
  const [files, setFiles] = useState<FileEntry[]>(initialFiles);
  const [rootTreeChildren, setRootTreeChildren] = useState<Record<string, FileEntry[]>>(
    initialRootTreeChildren,
  );
  const [isDragging, setIsDragging] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [allFiles, setAllFiles] = useState<FileEntry[] | null>(null);
  const [allFilesLoading, setAllFilesLoading] = useState(false);
  const [sortOption, setSortOption] = useState<SortOption>("name-asc");
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [draggedPaths, setDraggedPaths] = useState<Set<string>>(() => new Set());
  const [dropTargetPath, setDropTargetPath] = useState<string>();
  const [movingToFolderPath, setMovingToFolderPath] = useState<string>();
  const [isDownloadingSelection, setIsDownloadingSelection] = useState(false);
  const [isDuplicatingSelection, setIsDuplicatingSelection] = useState(false);
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [movePickerPath, setMovePickerPath] = useState("");
  const [movePickerFolders, setMovePickerFolders] = useState<FileEntry[]>([]);
  const [movePickerItems, setMovePickerItems] = useState<FileEntry[]>([]);
  const [isLoadingMoveFolders, setIsLoadingMoveFolders] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  const { pendingUploads, uploadFiles } = usePendingUploads(projectId);
  const folderCacheRef = useRef<Map<string, FileEntry[]>>(
    new Map([["", initialFiles], ...Object.entries(initialRootTreeChildren)]),
  );
  const folderRequestsRef = useRef<Map<string, Promise<FileEntry[]>>>(new Map());
  cwdRef.current = cwd;

  const exitMultiSelectMode = () => {
    setMultiSelectMode(false);
    setSelectedPaths(new Set());
  };

  const [deleteSelectionOpen, setDeleteSelectionOpen] = useState(false);
  const [deleteSelectionPending, setDeleteSelectionPending] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFormOpen, setNewFormOpen] = useState(false);
  const [newFormName, setNewFormName] = useState("");
  const [newFormPending, setNewFormPending] = useState(false);
  const [protectedWorkspaceDialogOpen, setProtectedWorkspaceDialogOpen] = useState(false);

  const showProtectedWorkspaceDialog = () => {
    setProtectedWorkspaceDialogOpen(true);
  };

  const requestFolder = (folderPath: string) => {
    const pendingRequest = folderRequestsRef.current.get(folderPath);
    if (pendingRequest) return pendingRequest;

    const request = listFiles(projectId, folderPath)
      .then((entries) => {
        folderCacheRef.current.set(folderPath, entries);
        rememberFolderListing(folderPath, entries);
        return entries;
      })
      .finally(() => {
        folderRequestsRef.current.delete(folderPath);
      });
    folderRequestsRef.current.set(folderPath, request);
    return request;
  };

  const refreshFiles = async (targetCwd?: string, showIndicator = true) => {
    const c = targetCwd ?? cwdRef.current;
    if (showIndicator) setIsRefreshing(true);
    try {
      if (c === "") {
        const tree = await getRootTree(projectId);
        folderCacheRef.current.set("", tree.entries);
        rememberFolderListing("", tree.entries);
        for (const [folderPath, entries] of Object.entries(tree.children)) {
          folderCacheRef.current.set(folderPath, entries);
          rememberFolderListing(folderPath, entries);
        }
        setRootTreeChildren(tree.children);
        if (cwdRef.current === "") setFiles(tree.entries);
        return;
      }
      const entries = await requestFolder(c);
      if (cwdRef.current === c) setFiles(entries);
    } catch {
      // best-effort; listFiles already swallows most errors
    } finally {
      if (showIndicator && cwdRef.current === c) setIsRefreshing(false);
    }
  };

  const navigateTo = (folderPath: string) => {
    const cachedFiles = folderCacheRef.current.get(folderPath);
    cwdRef.current = folderPath;
    // Navigating replaces the search results with the folder's contents.
    closeSearch();
    setCwd(folderPath);
    setSelectedPaths(new Set());
    if (cachedFiles) {
      setFiles(cachedFiles);
      setIsRefreshing(false);
    }
    void refreshFiles(folderPath, !cachedFiles);
  };

  const prefetchFolder = (folderPath: string) => {
    if (folderCacheRef.current.has(folderPath)) return;
    void requestFolder(folderPath).catch(() => undefined);
  };

  // Warm a hovered file's text into the content cache so the eventual open
  // renders synchronously; binary editors don't read that cache, so their
  // bytes are left to their own viewers.
  const prefetchFile = (file: FileEntry) => {
    if (file.isDir || !editorLoadsTextContent(file.name)) return;
    prefetchTextFile(projectId, file.path);
  };

  // Folder mention chips in the chat ask the layout to reveal a path here. The
  // request arrives via props (not an event) because this panel may have just
  // mounted when the activity switched to "files" and would have missed it.
  useEffect(() => {
    if (!revealFolderRequest) return;
    navigateTo(revealFolderRequest.path);
    onRevealFolderConsumed?.();
    // navigateTo only touches setters and refs; tracking it (and the consume
    // callback) would re-run the reveal on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealFolderRequest]);

  // Live refresh after agent turns + a safety refresh when the tab regains focus.
  useEffect(() => {
    const handler = () => void refreshFiles();
    window.addEventListener(REFRESH_EVENT, handler);
    window.addEventListener("focus", handler);
    return () => {
      window.removeEventListener(REFRESH_EVENT, handler);
      window.removeEventListener("focus", handler);
    };
  // The refresh handler reads current refs; reattaching it on every render is unnecessary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Seed the shared folder cache (the move dialogs read it) with the listings
  // this panel starts with.
  useEffect(() => {
    rememberFolderListing("", initialFiles);
    for (const [folderPath, entries] of Object.entries(initialRootTreeChildren)) {
      rememberFolderListing(folderPath, entries);
    }
  }, [initialFiles, initialRootTreeChildren]);

  // Actions with a known outcome (rename, move, delete, duplicate, upload)
  // broadcast mutations; apply them locally so rows — and the paths later
  // actions use, like a drag right after a rename — update immediately. The
  // refresh listener above reconciles against the server in the background.
  useEffect(() => {
    const handler = (event: Event) => {
      const mutation = (event as CustomEvent<WorkspaceMutation>).detail;
      setFiles((current) => applyMutationToFolderListing(current, cwdRef.current, mutation));
      setRootTreeChildren((current) => {
        const next: Record<string, FileEntry[]> = {};
        for (const [folderPath, entries] of Object.entries(current)) {
          next[folderPath] = applyMutationToFolderListing(entries, folderPath, mutation);
        }
        return next;
      });
      for (const [folderPath, entries] of folderCacheRef.current) {
        folderCacheRef.current.set(
          folderPath,
          applyMutationToFolderListing(entries, folderPath, mutation),
        );
      }
      const removedRoot = removedFolderRoot(mutation);
      if (removedRoot !== undefined) {
        for (const folderPath of folderCacheRef.current.keys()) {
          if (folderPath === removedRoot || folderPath.startsWith(`${removedRoot}/`)) {
            folderCacheRef.current.delete(folderPath);
          }
        }
      }
    };
    window.addEventListener(WORKSPACE_MUTATION_EVENT, handler);
    return () => window.removeEventListener(WORKSPACE_MUTATION_EVENT, handler);
  }, []);

  useEffect(() => {
    if (isSearchOpen) searchInputRef.current?.focus();
  }, [isSearchOpen]);

  // Search matches against the whole workspace, not just the current folder, so
  // fetch the full recursive listing every time the search opens; previously
  // fetched entries stay visible while a refresh is in flight.
  useEffect(() => {
    if (!isSearchOpen) return;
    let cancelled = false;
    setAllFilesLoading(true);
    listAllFiles(projectId)
      .then((entries) => {
        if (!cancelled) setAllFiles(entries);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAllFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSearchOpen, projectId]);

  // Opening a file from the results keeps the search open; it is dismissed
  // only by Escape or a pointer press outside this panel. Portaled overlays
  // (row action menus, dialogs) count as inside, so interacting with them
  // does not unmount their owner row mid-click.
  useEffect(() => {
    if (!isSearchOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSearch();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest(
          "[role=menu], [role=dialog], [role=alertdialog], [data-radix-popper-content-wrapper]",
        )
      ) {
        return;
      }
      closeSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isSearchOpen]);

  useEffect(() => {
    if (!multiSelectMode) return;
    const exitMultiSelect = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMultiSelectMode(false);
      setSelectedPaths(new Set());
    };
    window.addEventListener("keydown", exitMultiSelect);
    return () => window.removeEventListener("keydown", exitMultiSelect);
  }, [multiSelectMode]);

  const enterFolder = (folder: FileEntry) => {
    navigateTo(folder.path);
  };

  const goTo = (rel: string) => {
    navigateTo(rel);
  };

  // Dropped or picked files become grayed pending rows right away; the
  // outcomes below only carry the toasts. The button stays usable, so more
  // files can be queued while earlier ones upload.
  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement> | globalThis.File | globalThis.File[],
  ) => {
    const selected = e instanceof window.File
      ? [e]
      : Array.isArray(e)
        ? e
        : e.target?.files && e.target.files.length > 0
          ? Array.from(e.target.files)
          : [];
    if (selected.length === 0) return;

    try {
      const outcomes = await uploadFiles(cwdRef.current, selected);
      for (const outcome of outcomes) {
        if (outcome.ok) continue;
        toast.error(
          outcome.storageLimit ? "Storage limit reached" : `Failed to upload ${outcome.name}`,
          {
            description: outcome.storageLimit
              ? `${outcome.error} Manage files in the explorer or view your plan on the Usage page.`
              : outcome.error.slice(0, 200),
          },
        );
      }
      const succeeded = outcomes.filter((outcome) => outcome.ok);
      if (succeeded.length === 1) toast.success(`${succeeded[0].name} uploaded successfully`);
      else if (succeeded.length > 1) toast.success(`${succeeded.length} files uploaded successfully`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes(WORKSPACE_PATHS_DRAG_TYPE)) return;
    setIsDragging(true);
  };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.types.includes(WORKSPACE_PATHS_DRAG_TYPE)) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFileUpload(Array.from(e.dataTransfer.files));
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await createDirectory(projectId, cwdRef.current, name);
      dispatchWorkspaceMutation({
        kind: "create",
        entry: {
          name,
          path: [cwdRef.current, name].filter(Boolean).join("/"),
          isDir: true,
          size: 0,
        },
      });
      toast.success(`${name} created`);
      setNewFolderOpen(false);
      setNewFolderName("");
      await refreshFiles();
    } catch (error) {
      toast.error("Failed to create folder", {
        description: errorDetail(error),
      });
    }
  };

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
      await refreshFiles(undefined, false);
      onOpenFile(file, true);
    } catch (error) {
      toast.error("Failed to create form", {
        description: errorDetail(error),
      });
    } finally {
      setNewFormPending(false);
    }
  };

  const handleMoveToFolder = async (sourcePaths: string[], folder: FileEntry) => {
    const affectsProtectedWorkspace = sourcePaths.some((sourcePath) => {
      const name = sourcePath.split("/").at(-1);
      const destination = [folder.path, name].filter(Boolean).join("/");
      return affectsProtectedWorkspacePath(sourcePath) || affectsProtectedWorkspacePath(destination);
    });
    if (affectsProtectedWorkspace) {
      showProtectedWorkspaceDialog();
      setDraggedPaths(new Set());
      setDropTargetPath(undefined);
      return false;
    }

    const movablePaths = sourcePaths.filter(
      (sourcePath) => sourcePath !== folder.path && !folder.path.startsWith(`${sourcePath}/`),
    );
    if (movablePaths.length === 0) return false;
    setMovingToFolderPath(folder.path);
    // Drag sources come from listed rows, so their entries (icon, size, kind)
    // are recoverable from the folder cache for the optimistic update.
    const entryByPath = new Map<string, FileEntry>();
    for (const entries of folderCacheRef.current.values()) {
      for (const entry of entries) entryByPath.set(entry.path, entry);
    }
    try {
      for (const sourcePath of movablePaths) {
        const name = sourcePath.split("/").at(-1);
        if (name) {
          const destination = [folder.path, name].filter(Boolean).join("/");
          await movePath(projectId, sourcePath, destination);
          dispatchWorkspaceMutation({
            kind: "move",
            from: sourcePath,
            to: destination,
            entry: {
              ...(entryByPath.get(sourcePath) ?? { name, isDir: false, size: 0 }),
              path: destination,
            },
          });
        }
      }
      toast.success(
        movablePaths.length === 1
          ? `${movablePaths[0].split("/").at(-1)} moved to ${folder.name}`
          : `${movablePaths.length} items moved to ${folder.name}`,
      );
      if (multiSelectMode) exitMultiSelectMode();
      await refreshFiles(undefined, false);
      return true;
    } catch (error) {
      toast.error("Failed to move item", {
        description: errorDetail(error),
      });
      return false;
    } finally {
      setMovingToFolderPath(undefined);
      setDraggedPaths(new Set());
      setDropTargetPath(undefined);
    }
  };

  const openMovePicker = (items: FileEntry[]) => {
    if (items.some((item) => affectsProtectedWorkspacePath(item.path))) {
      showProtectedWorkspaceDialog();
      return;
    }
    setMovePickerItems(items);
    setMovePickerOpen(true);
    void browseMovePicker("");
  };

  const browseMovePicker = async (folderPath: string) => {
    setMovePickerPath(folderPath);
    // Cached listings (seeded by this panel's own fetches and the shared
    // mutation cache) make revisited folders instant; misses fetch as before.
    const cached = cachedFolderListing(folderPath);
    if (cached) {
      setMovePickerFolders(cached.filter((entry) => entry.isDir));
      return;
    }
    setIsLoadingMoveFolders(true);
    try {
      const entries = await listFiles(projectId, folderPath);
      rememberFolderListing(folderPath, entries);
      setMovePickerFolders(entries.filter((entry) => entry.isDir));
    } finally {
      setIsLoadingMoveFolders(false);
    }
  };

  const movePickerSelection = async () => {
    const destination: FileEntry = {
      name: movePickerPath.split("/").at(-1) || "Files",
      path: movePickerPath,
      isDir: true,
      size: 0,
    };
    const moved = await handleMoveToFolder(
      movePickerItems.map((item) => item.path),
      destination,
    );
    if (moved) setMovePickerOpen(false);
  };

  const allowFolderDrop = (event: React.DragEvent, folderPath: string) => {
    if (
      draggedPaths.size === 0 ||
      draggedPaths.has(folderPath) ||
      [...draggedPaths].some((sourcePath) => folderPath.startsWith(`${sourcePath}/`))
    ) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetPath(folderPath);
  };

  const dropOnFolder = (event: React.DragEvent, folder: FileEntry) => {
    if (!event.dataTransfer.types.includes(WORKSPACE_PATHS_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const sourcePaths = getWorkspaceDragPaths(event.dataTransfer);
      if (sourcePaths.length > 0) void handleMoveToFolder(sourcePaths, folder);
    } catch {
      setDraggedPaths(new Set());
      setDropTargetPath(undefined);
    }
  };

  const downloadSelection = async () => {
    const items = selectedItems.map(({ path, isDir }) => ({ path, isDir }));
    if (items.length === 0) return;
    setIsDownloadingSelection(true);
    try {
      const response = await fetch(`/api/workspace/${encodeURIComponent(projectId)}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!response.ok) throw new Error(await response.text());
      const body = await response.json() as { url?: string };
      if (!body.url) throw new Error("Archive download URL was not returned");
      const link = document.createElement("a");
      link.href = body.url;
      link.download = "selected-files.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      exitMultiSelectMode();
    } catch (error) {
      toast.error("Failed to download selection", {
        description: errorDetail(error),
      });
    } finally {
      setIsDownloadingSelection(false);
    }
  };

  const duplicateSelection = async (items: FileEntry[]) => {
    if (items.length === 0 || items.some((item) => item.isDir)) return;
    setIsDuplicatingSelection(true);
    try {
      const destinations = await duplicateFiles(projectId, items.map((item) => item.path));
      destinations.forEach((destination, index) => {
        const source = items[index];
        if (source) {
          dispatchWorkspaceMutation({
            kind: "create",
            entry: { ...source, name: pathBasename(destination), path: destination },
          });
        }
      });
      toast.success(items.length === 1 ? `${items[0].name} duplicated` : `${items.length} files duplicated`);
      exitMultiSelectMode();
      await refreshFiles(undefined, false);
    } catch (error) {
      toast.error(items.length === 1 ? "Failed to duplicate file" : "Failed to duplicate files", {
        description: errorDetail(error),
      });
    } finally {
      setIsDuplicatingSelection(false);
    }
  };

  const toggleSelection = (path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const closeSearch = () => {
    setIsSearchOpen(false);
    setQuery("");
  };

  const handleDeleteSelection = async () => {
    const paths = [...selectedPaths];
    if (paths.length === 0) return;
    if (paths.some(affectsProtectedWorkspacePath)) {
      setDeleteSelectionOpen(false);
      showProtectedWorkspaceDialog();
      return;
    }
    setDeleteSelectionPending(true);
    try {
      await deleteFiles(projectId, paths);
      toast.success(`${paths.length} ${paths.length === 1 ? "item" : "items"} deleted`);
      setDeleteSelectionOpen(false);
      exitMultiSelectMode();
      await refreshFiles(undefined, false);
    } catch (error) {
      toast.error("Failed to delete selected items", {
        description: errorDetail(error),
      });
    } finally {
      setDeleteSelectionPending(false);
    }
  };

  const openEntry = (file: FileEntry, pinned = false) => {
    cancelPendingSearchOpen();
    if (file.isDir) {
      enterFolder(file);
      return;
    }
    // Opening a file deliberately leaves the search open so the user can keep
    // working through the results.
    onOpenFile(file, pinned);
  };

  // The search stays open while results are clicked, so a clicked row stays
  // mounted; this short-lived fallback still delivers the open if the row's
  // click is ever swallowed, and is cancelled by the click itself, a drag, or
  // a cancelled press.
  const pendingSearchOpenRef = useRef<{ timer: number } | null>(null);

  const cancelPendingSearchOpen = () => {
    const pending = pendingSearchOpenRef.current;
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingSearchOpenRef.current = null;
    }
  };

  const scheduleSearchOpen = (file: FileEntry) => {
    cancelPendingSearchOpen();
    pendingSearchOpenRef.current = {
      timer: window.setTimeout(() => {
        pendingSearchOpenRef.current = null;
        openEntry(file);
      }, 250),
    };
  };

  const getFileIcon = (file: FileEntry) => {
    if (file.isDir) return <Folder className="h-4 w-4 text-blue-500" />;
    if (file.name.toLowerCase().endsWith(".form.html"))
      return <ClipboardList className="h-4 w-4 text-violet-500" />;
    if (file.name.toLowerCase().endsWith(".excalidraw") || file.name.toLowerCase().endsWith(".excalidraw.json"))
      return <PenTool className="h-4 w-4 text-purple-500" />;
    const ext = extensionOf(file.name);
    if (["png", "jpg", "jpeg", "svg", "gif", "webp", "bmp", "avif"].includes(ext))
      return <ImageIcon className="h-4 w-4 text-fuchsia-500" />;
    if (["csv", "xls", "xlsx"].includes(ext))
      return <FileSpreadsheet className="h-4 w-4 text-emerald-600" />;
    if (["ppt", "pptx", "odp"].includes(ext))
      return <Presentation className="h-4 w-4 text-orange-500" />;
    if (["doc", "docx", "odt", "rtf"].includes(ext))
      return <FileType2 className="h-4 w-4 text-blue-600" />;
    if (ext === "pdf") return <FileText className="h-4 w-4 text-red-500" />;
    if (isAudioFileName(file.name)) return <FileAudio className="h-4 w-4 text-indigo-500" />;
    if (isVideoFileName(file.name)) return <FileVideo className="h-4 w-4 text-rose-500" />;
    if (["json", "jsonl", "ndjson"].includes(ext))
      return <FileJson className="h-4 w-4 text-amber-500" />;
    if (ext === "matrix") return <Table2 className="h-4 w-4 text-teal-600" />;
    if (ext === "ipynb") return <NotebookTabs className="h-4 w-4 text-orange-600" />;
    if (["bib", "ris"].includes(ext)) return <BookOpen className="h-4 w-4 text-violet-500" />;
    if (["zip", "tar", "gz", "rar", "7z"].includes(ext))
      return <FileArchive className="h-4 w-4 text-amber-700" />;
    if (["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "yaml", "yml", "xml", "css", "sh", "bash", "sql", "ini", "toml", "env", "html", "htm", "tex"].includes(ext))
      return <FileCode2 className="h-4 w-4 text-cyan-600" />;
    if (["txt", "md", "markdown", "mmd", "mermaid", "log"].includes(ext))
      return <FileText className="h-4 w-4 text-slate-500" />;
    return <File className="h-4 w-4" />;
  };

  const segments = cwd.split("/").filter(Boolean);
  const parentPath = segments.slice(0, -1).join("/");
  const isSearching = query.trim().length > 0;
  // Pending uploads join the listing as grayed stand-in rows the moment a file
  // is dropped or picked. Browse mode shows the ones for the current folder;
  // search spans the workspace, so all of them ride along.
  const listingSource = useMemo(() => {
    const base = isSearching ? (allFiles ?? files) : files;
    const pending = isSearching
      ? pendingUploads
      : pendingUploads.filter((entry) => entry.folder === cwd);
    return pending.length > 0 ? [...base, ...pending] : base;
  }, [files, allFiles, isSearching, pendingUploads, cwd]);
  const { visibleFiles, matchCount } = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = listingSource
      .filter((file) => file.name.toLocaleLowerCase().includes(normalizedQuery))
      .sort((a, b) => {
        const [field, direction] = sortOption.split("-") as ["name" | "type", "asc" | "desc"];
        const aValue = field === "type" ? fileTypeOf(a) : a.name;
        const bValue = field === "type" ? fileTypeOf(b) : b.name;
        const comparison = aValue.localeCompare(bValue, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        const nameComparison = a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        const ordered = comparison || nameComparison;
        return direction === "asc" ? ordered : -ordered;
      });
    return {
      visibleFiles: isSearching ? matches.slice(0, SEARCH_RESULTS_LIMIT) : matches,
      matchCount: matches.length,
    };
  }, [listingSource, isSearching, query, sortOption]);
  const selectedItems = listingSource.filter((file) => selectedPaths.has(file.path));
  const canDuplicateSelection =
    selectedItems.length > 0 &&
    selectedItems.length === selectedPaths.size &&
    selectedItems.every((file) => !file.isDir);
  const movePickerSegments = movePickerPath.split("/").filter(Boolean);
  const invalidMoveDestination = movePickerItems.some(
    (item) => item.path === movePickerPath || movePickerPath.startsWith(`${item.path}/`),
  );
  const emptyFolderGuidance = EMPTY_FOLDER_GUIDANCE[cwd] ?? {
    title: cwd ? "This folder is empty" : "Add your first research artifact",
    description: cwd
      ? "Upload a file here or ask Beeblio to create an artifact."
      : "Add a paper, dataset, image, or notes file to begin.",
  };

  return (
    <>
      <div
        ref={panelRef}
        className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Toolbar: sort + new folder + selection actions + search + refresh */}
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <div
            className={cn(
              "flex items-center gap-1 overflow-hidden transition-[width,opacity] duration-200 ease-out",
              isSearchOpen
                ? "pointer-events-none w-0 opacity-0"
                : multiSelectMode ? "w-[156px] opacity-100" : "w-[124px] opacity-100",
            )}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label="Sort files"
                  title="Sort"
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-32">
                <DropdownMenuRadioGroup
                  value={sortOption}
                  onValueChange={(value) => setSortOption(value as SortOption)}
                >
                  <DropdownMenuRadioItem value="name-asc">
                    <ArrowDownAZ /> Name (A-Z)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name-desc">
                    <ArrowUpAZ /> Name (Z-A)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="type-asc">
                    <ArrowDown01 /> Type (A-Z)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="type-desc">
                    <ArrowUp01 /> Type (Z-A)
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => setNewFolderOpen(true)}
              aria-label="New folder"
              title="New folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => setNewFormOpen(true)}
              aria-label="New form"
              title="New survey form"
            >
              <ClipboardList className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={multiSelectMode ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => {
                setMultiSelectMode((current) => !current);
                setSelectedPaths(new Set());
              }}
              aria-label={multiSelectMode ? "Exit multi-select" : "Select multiple items"}
              aria-pressed={multiSelectMode}
              title="Select"
            >
              <SquareCheckBig className="h-3.5 w-3.5" />
            </Button>
            {multiSelectMode ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label="Selected item actions"
                    title="Actions"
                  >
                    {isDownloadingSelection || isDuplicatingSelection || deleteSelectionPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <MoreVertical className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={selectedPaths.size === 0}
                    onClick={() => openMovePicker(selectedItems)}
                  >
                    <FolderInput /> Move to…
                  </DropdownMenuItem>
                  {canDuplicateSelection ? (
                    <DropdownMenuItem
                      disabled={isDuplicatingSelection}
                      onClick={() => void duplicateSelection(selectedItems)}
                    >
                      <Copy /> Duplicate
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    disabled={selectedPaths.size === 0 || isDownloadingSelection || isDuplicatingSelection}
                    onClick={() => void downloadSelection()}
                  >
                    <Download /> Download
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    disabled={selectedPaths.size === 0}
                    onSelect={() => {
                      if (selectedItems.some((item) => affectsProtectedWorkspacePath(item.path))) {
                        showProtectedWorkspaceDialog();
                      } else {
                        setDeleteSelectionOpen(true);
                      }
                    }}
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>

          <div
            className={cn(
              "relative ml-auto h-7 overflow-hidden transition-[width,flex-grow] duration-200 ease-out",
              isSearchOpen ? "min-w-0 flex-1" : "w-7 shrink-0",
            )}
          >
            {isSearchOpen ? (
              <>
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search all files"
                  aria-label="Search all files"
                  className="h-7 rounded-lg pl-7 pr-2 text-xs md:text-xs"
                />
                {allFilesLoading ? (
                  <Loader2 className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 animate-spin text-muted-foreground" />
                ) : null}
              </>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setIsSearchOpen(true)}
                aria-label="Search all files"
                title="Search"
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => void refreshFiles()}
            disabled={isRefreshing}
            aria-label="Refresh files"
            title="Refresh"
          >
            {isRefreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {segments.length > 0 ? (
          <div className="relative h-8 shrink-0 border-b text-xs">
            <div className="flex h-full items-center gap-1 overflow-x-auto px-2 pr-14">
              <button
                className={cn(
                  "shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  dropTargetPath === "" && "bg-primary/10 text-primary ring-1 ring-primary/30",
                )}
                onClick={() => goTo("")}
                onDragOver={(event) => allowFolderDrop(event, "")}
                onDragLeave={() => {
                  if (dropTargetPath === "") setDropTargetPath(undefined);
                }}
                onDrop={(event) => dropOnFolder(event, {
                  name: "Files",
                  path: "",
                  isDir: true,
                  size: 0,
                })}
              >
                <span className="flex items-center gap-1">
                  Project
                  {movingToFolderPath === "" ? <Loader2 className="size-3 animate-spin" /> : null}
                </span>
              </button>
              {segments.map((seg, i) => {
                const rel = segments.slice(0, i + 1).join("/");
                return (
                  <span key={rel} className="flex shrink-0 items-center gap-1">
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <button
                      className={cn(
                        "max-w-40 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                        dropTargetPath === rel && "bg-primary/10 text-primary ring-1 ring-primary/30",
                      )}
                      onClick={() => goTo(rel)}
                      onDragOver={(event) => allowFolderDrop(event, rel)}
                      onDragLeave={() => {
                        if (dropTargetPath === rel) setDropTargetPath(undefined);
                      }}
                      onDrop={(event) => dropOnFolder(event, {
                        name: seg,
                        path: rel,
                        isDir: true,
                        size: 0,
                      })}
                      title={seg}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate">{seg}</span>
                        {movingToFolderPath === rel ? <Loader2 className="size-3 shrink-0 animate-spin" /> : null}
                      </span>
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="absolute inset-y-0 right-0 z-10 flex items-center border-l bg-sidebar">
              <button
                className="flex h-full items-center gap-1 px-1.5 font-medium transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => goTo(parentPath)}
                aria-label="Back to parent folder"
                title="Back to parent folder"
              >
                <ArrowLeft className="size-3.5" />
                Back
              </button>
            </div>
          </div>
        ) : null}

        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/20 backdrop-blur-sm rounded-lg m-2 border-2 border-primary border-dashed">
            <p className="font-semibold text-primary">Drop to Upload</p>
          </div>
        )}

        <div className="min-h-0 w-full max-w-full flex-1 overflow-x-hidden overflow-y-auto p-2">
          <div className="flex w-full min-w-0 max-w-full flex-col gap-0.5 overflow-hidden">
            {!isSearching && visibleFiles.length === 0 ? (
              <div
                className="flex h-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed bg-card/60 px-4 text-center transition-colors hover:border-primary/40 hover:bg-card"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="text-sm font-medium text-foreground">{emptyFolderGuidance.title}</span>
                <span className="mt-1 max-w-52 text-xs leading-5 text-muted-foreground">
                  {emptyFolderGuidance.description}
                </span>
              </div>
            ) : null}

            {isSearching && visibleFiles.length === 0 ? (
              <div className="flex h-24 items-center justify-center px-4 text-center text-xs text-muted-foreground">
                {allFilesLoading && !allFiles ? "Searching…" : `No files match “${query.trim()}”`}
              </div>
            ) : null}

            {visibleFiles.map((file) => {
              if (isPendingUpload(file)) {
                return (
                  <PendingUploadRow
                    key={`pending:${file.pendingId}`}
                    icon={getFileIcon(file)}
                    name={file.name}
                  />
                );
              }
              return (
              <Fragment key={file.path}>
              <div
                draggable
                className={cn(
                  "group relative flex w-full min-w-0 max-w-full cursor-pointer items-center rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60",
                  activeFilePath === file.path && "bg-accent text-accent-foreground",
                  selectedPaths.has(file.path) && "bg-primary/10 text-foreground",
                  dropTargetPath === file.path && "bg-primary/10 ring-1 ring-inset ring-primary/40",
                  draggedPaths.has(file.path) && "opacity-45",
                )}
                onClick={() => {
                  if (multiSelectMode) {
                    toggleSelection(file.path);
                    if (isSearching) searchInputRef.current?.focus();
                  }
                  else openEntry(file);
                }}
                onDoubleClick={() => {
                  if (!multiSelectMode && !file.isDir) openEntry(file, true);
                }}
                onPointerEnter={() => {
                  if (file.isDir) prefetchFolder(file.path);
                  else prefetchFile(file);
                }}
                onPointerDown={(event) => {
                  if (file.isDir) prefetchFolder(file.path);
                  else prefetchFile(file);
                  if (isSearching && !multiSelectMode) {
                    const pressedOnControl = (event.target as Element | null)?.closest(
                      "button, input, a",
                    );
                    if (!pressedOnControl) scheduleSearchOpen(file);
                  }
                }}
                onPointerCancel={cancelPendingSearchOpen}
                onFocus={() => {
                  if (file.isDir) prefetchFolder(file.path);
                  else prefetchFile(file);
                }}
                onDragStart={(event) => {
                  cancelPendingSearchOpen();
                  const paths = multiSelectMode && selectedPaths.has(file.path)
                    ? [...selectedPaths]
                    : [file.path];
                  setWorkspaceDragData(event.dataTransfer, paths);
                  setDraggedPaths(new Set(paths));
                }}
                onDragEnd={() => {
                  if (isSearching) closeSearch();
                  setDraggedPaths(new Set());
                  setDropTargetPath(undefined);
                }}
                onDragOver={(event) => {
                  if (file.isDir) allowFolderDrop(event, file.path);
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  if (dropTargetPath === file.path) setDropTargetPath(undefined);
                }}
                onDrop={(event) => {
                  if (!file.isDir) return;
                  dropOnFolder(event, file);
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  {multiSelectMode ? (
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(file.path)}
                      onChange={() => toggleSelection(file.path)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select ${file.name}`}
                      className="size-3.5 shrink-0 cursor-pointer accent-primary"
                    />
                  ) : null}
                  <div className="shrink-0 text-muted-foreground">{getFileIcon(file)}</div>
                  <TruncatedFileName name={file.name} />
                  {isSearching && parentDirectoryOf(file) ? (
                    <span
                      className={cn(
                        "max-w-36 shrink-0 truncate text-[10px] text-muted-foreground",
                        !multiSelectMode && "mr-7",
                      )}
                      title={parentDirectoryOf(file)}
                    >
                      {parentDirectoryOf(file)}
                    </span>
                  ) : null}
                </div>

                {!multiSelectMode ? (
                  <WorkspaceFileActions
                    projectId={projectId}
                    file={file}
                    className={cn(
                      "absolute right-1 z-10 rounded-md bg-sidebar/90 backdrop-blur-sm transition-opacity",
                      movingToFolderPath === file.path
                        ? "opacity-100"
                        : "opacity-65 group-focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100",
                    )}
                  />
                ) : null}
              </div>
              {!isSearching && cwd === "" && file.isDir ? (
                rootTreeChildren[file.path] ? (
                  rootTreeChildren[file.path].filter((child) => child.isDir).map((child) => (
                    <button
                      key={child.path}
                      type="button"
                      className={cn(
                        "group ml-5 flex min-w-0 items-center gap-2 rounded-md border-l border-border/70 py-1.5 pl-3 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                        dropTargetPath === child.path && "bg-primary/10 text-primary ring-1 ring-inset ring-primary/40",
                      )}
                      onClick={() => enterFolder(child)}
                      onPointerEnter={() => prefetchFolder(child.path)}
                      onFocus={() => prefetchFolder(child.path)}
                      onDragOver={(event) => allowFolderDrop(event, child.path)}
                      onDragLeave={() => {
                        if (dropTargetPath === child.path) setDropTargetPath(undefined);
                      }}
                      onDrop={(event) => dropOnFolder(event, child)}
                    >
                      <Folder className="size-3.5 shrink-0 text-blue-500/80" />
                      <span className="min-w-0 flex-1 truncate">{child.name}</span>
                      <ChevronRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                    </button>
                  ))
                ) : (
                  <div className="ml-5 flex h-7 items-center gap-2 border-l border-border/70 pl-3 text-[11px] text-muted-foreground/70">
                    <Loader2 className="size-3 animate-spin" /> Loading folders
                  </div>
                )
              ) : null}
              </Fragment>
              );
            })}

            {isSearching && matchCount > visibleFiles.length ? (
              <div className="flex items-center justify-center px-2 py-1.5 text-[10px] text-muted-foreground">
                Showing first {visibleFiles.length} of {matchCount} matches
              </div>
            ) : null}

            {!isSearching && files.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus className="mr-2 h-4 w-4" />
                Upload File
              </Button>
            )}
          </div>
        </div>
        <input type="file" multiple ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
      </div>

      <Dialog open={movePickerOpen} onOpenChange={setMovePickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to…</DialogTitle>
            <DialogDescription>
              Choose a destination for {movePickerItems.length === 1
                ? movePickerItems[0]?.name
                : `${movePickerItems.length} items`}.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden rounded-xl border">
            <div className="flex h-9 items-center gap-1 overflow-x-auto border-b px-2 text-xs">
              <button
                className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void browseMovePicker("")}
              >
                Files
              </button>
              {movePickerSegments.map((segment, index) => {
                const destination = movePickerSegments.slice(0, index + 1).join("/");
                return (
                  <span key={destination} className="flex min-w-0 items-center gap-1">
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    <button
                      className="max-w-32 truncate rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => void browseMovePicker(destination)}
                    >
                      {segment}
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="max-h-64 min-h-32 overflow-y-auto p-1.5">
              {isLoadingMoveFolders ? (
                <div className="flex h-28 items-center justify-center">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : movePickerFolders.length > 0 ? (
                movePickerFolders.map((folder) => {
                  const unavailable = movePickerItems.some(
                    (item) => folder.path === item.path || folder.path.startsWith(`${item.path}/`),
                  );
                  return (
                    <button
                      key={folder.path}
                      disabled={unavailable}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => void browseMovePicker(folder.path)}
                    >
                      <Folder className="size-4 text-blue-500" />
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    </button>
                  );
                })
              ) : (
                <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">
                  No subfolders
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMovePickerOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void movePickerSelection()}
              disabled={invalidMoveDestination || movingToFolderPath !== undefined}
            >
              {movingToFolderPath !== undefined ? (
                <Loader2 className="animate-spin" />
              ) : (
                <FolderInput />
              )}
              Move Here
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) setNewFolderName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
            <DialogDescription>Create a folder in the current location.</DialogDescription>
          </DialogHeader>
          <Input
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void handleCreateFolder()}
            placeholder="Folder name"
            aria-label="Folder name"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreateFolder()} disabled={!newFolderName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              Creates a form in {FORMS_DIRECTORY} that you can build visually and share
              publicly. Responses are saved to a CSV file next to it.
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

      <AlertDialog
        open={deleteSelectionOpen}
        onOpenChange={(open) => {
          if (!deleteSelectionPending) setDeleteSelectionOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected items?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {selectedPaths.size} selected {selectedPaths.size === 1 ? "item" : "items"}
              {selectedItems.some((item) => item.isDir) ? ", including everything inside the selected folders," : ""} from this project.
              This action cannot be undone from the app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSelectionPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleteSelectionPending}
              onClick={() => void handleDeleteSelection()}
            >
              {deleteSelectionPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete {selectedPaths.size} {selectedPaths.size === 1 ? "Item" : "Items"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={protectedWorkspaceDialogOpen}
        onOpenChange={setProtectedWorkspaceDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Protected Research Workspace</AlertDialogTitle>
            <AlertDialogDescription>
              This is a system folder, including the <b>references.bib</b>. You cannot rename, move or delete it. You still can manage all the contents inside and outside of this folder.
            </AlertDialogDescription>
            {/* <AlertDialogDescription>
              Beeblio keeps <span className="font-medium text-foreground">1-References, 2-Data,
              3-Analysis, and 4-Reports</span> in place so research views remain reliable. You can
              freely manage their contents, but the four folders cannot be moved, renamed, or
              deleted. <span className="font-medium text-foreground">{PROJECT_BIBLIOGRAPHY_NAME}</span>{" "}
              also stays protected as the project bibliography database.
            </AlertDialogDescription> */}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button onClick={() => setProtectedWorkspaceDialogOpen(false)}>Got it</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TruncatedFileName({ name }: { name: string }) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const checkTruncation = () => {
    const element = nameRef.current;
    setIsTruncated(Boolean(element && element.scrollWidth > element.clientWidth));
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          ref={nameRef}
          className="min-w-0 flex-1 truncate text-sm"
          onMouseEnter={checkTruncation}
          onFocus={checkTruncation}
        >
          {name}
        </span>
      </TooltipTrigger>
      {isTruncated ? <TooltipContent side="right">{name}</TooltipContent> : null}
    </Tooltip>
  );
}
