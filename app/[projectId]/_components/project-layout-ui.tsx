"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  ClipboardList,
  Code2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Files,
  FolderOpen,
  Info,
  Loader2,
  PenTool,
  Plus,
  Search,
  ShieldCheck,
  Table2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Brand } from "@/app/_components/brand";
import { ConversationLoading } from "@/app/_components/conversation-loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isUntitledDraftPath,
  nextUntitledNumber,
  normalizeRootFileName,
  untitledDraftFile,
  untitledDraftKind,
  untitledDraftTabLabel,
  type UntitledDraftKind,
} from "@/lib/untitled-draft";
import { cn } from "@/lib/utils";
import type { KnowledgeDocumentDTO } from "@/lib/knowledge";
import {
  ADD_FILE_TO_CHAT_EVENT,
  ADD_SELECTION_TO_CHAT_EVENT,
  AGENT_PANEL_OPENED_EVENT,
  NEW_CONVERSATION_EVENT,
  ASK_AGENT_EVENT,
  OPEN_WORKSPACE_FILE_EVENT,
  OPEN_WORKSPACE_FOLDER_EVENT,
  SELECTION_MAX_CHARS,
  type OpenWorkspaceFileDetail,
  type OpenWorkspaceFolderDetail,
} from "@/lib/chat-context";
import { OPEN_LITERATURE_SEARCH_EVENT, type OpenLiteratureSearchDetail } from "@/lib/literature/types";
import { PROJECT_BIBLIOGRAPHY_PATH } from "@/lib/project-bibliography";
import { isMarkdownFilePath } from "@/lib/project-settings";
import { WORKSPACE_CHANGED_EVENT, type WorkspaceChangedDetail } from "@/lib/workspace-change";
import {
  dispatchWorkspaceMutation,
  WORKSPACE_MUTATION_EVENT,
  type WorkspaceMutation,
} from "@/lib/workspace-mutations";
import { useIsMobile } from "@/hooks/use-mobile";
import { saveFile, type FileEntry } from "../file-actions";
import type { SkillSummary } from "../skill-actions";
import { uploadWorkspaceFile } from "@/lib/workspace-upload";
import { FileNameInput, splitFileName } from "./file-name-input";
import { FileExplorer } from "./file-explorer";
import { announceFormCreated, createFormInFormsFolder, FORMS_DIRECTORY } from "./form-creation";
import { KnowledgePanel } from "./knowledge-panel";
import { FileViewer } from "./file-viewer";
import { writeCachedText } from "./editors/text-content-cache";
import { createMatrixFile } from "../matrix-actions";
import { MatrixTargetsProvider } from "./matrix-targets-context";
import { ANALYSIS_DIRECTORY } from "@/lib/research-workspace";
import { clearCachedBibliography, writeCachedBibliography } from "./editors/bibliography-cache";
import { clearTextDraft, moveTextDraftKey, readTextDraft } from "./editors/text-draft-cache";
import { LiteraturePanel } from "./literature-panel";
import { ProjectSwitcher, type SwitcherProject } from "./project-switcher";
import { QuickOpenDialog } from "./quick-open-dialog";
import {
  ResearchArtifactBrowser,
  type ResearchArtifactView,
} from "./research-artifact-browser";
import { activities, rememberRailActivity, SKILLS_RAIL_ITEM, type Activity } from "./rail-activity";
import { ChatHistory } from "./chat-history";
import { SkillsPanel } from "./skills-panel";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { DocumentReviewPanel } from "./document-review-panel";
import {
  WorkspaceContext,
  type WorkspaceEditorRegistration,
  type WorkspaceSelection,
  type WorkspaceSelectionProvider,
  type WorkspaceUnsavedFile,
} from "./workspace-context";

interface ProjectLayoutUIProps {
  projectId: string;
  projectName: string;
  initialActivity?: Activity;
  initialFiles: FileEntry[];
  initialRootTreeChildren: Record<string, FileEntry[]>;
  initialAllFiles?: FileEntry[];
  initialKnowledgeDocuments?: KnowledgeDocumentDTO[];
  initialSwitcherProjects?: SwitcherProject[];
  /** User-scoped skill list (server-resolved) so the Skills panel opens populated. */
  initialSkills?: SkillSummary[];
  initialSessions: Array<{ id: string; title: string | null }>;
  /** File opened when the page loads without a ?file= param (server-resolved). */
  defaultFilePath?: string;
  /** Server-read text of the default file, seeding the client cache so its first open renders without a round trip. */
  defaultFileContent?: string;
  userMenu?: ReactNode;
  children: ReactNode;
}

// Deep links (?file=) and chat/agent file mentions fabricate a tab entry with
// no metadata; the server-rendered listings already know these files, so the
// real entry — name and byte size included — stands in when one exists.
function entryForPath(
  path: string,
  fallbackName: string,
  files: FileEntry[],
  rootTreeChildren: Record<string, FileEntry[]>,
): FileEntry {
  const known = files.find((file) => file.path === path)
    ?? Object.values(rootTreeChildren).flat().find((file) => file.path === path);
  return known ?? { name: fallbackName, path, isDir: false, size: 0 };
}

const customFileTypes = [
  { extension: "txt", label: "Plain text (.txt)", content: "" },
  { extension: "md", label: "Markdown (.md)", content: "" },
  { extension: "csv", label: "CSV table (.csv)", content: "" },
  { extension: "json", label: "JSON (.json)", content: "{}\n" },
  { extension: "ipynb", label: "Jupyter notebook (.ipynb)", content: '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n' },
  { extension: "tex", label: "LaTeX (.tex)", content: "\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n" },
  { extension: "bib", label: "BibTeX (.bib)", content: "" },
  { extension: "html", label: "HTML (.html)", content: '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Untitled</title></head>\n<body>\n</body>\n</html>\n' },
  { extension: "js", label: "JavaScript (.js)", content: "" },
  { extension: "ts", label: "TypeScript (.ts)", content: "" },
  { extension: "py", label: "Python (.py)", content: "" },
  { extension: "css", label: "CSS (.css)", content: "" },
  { extension: "yaml", label: "YAML (.yaml)", content: "" },
  { extension: "sql", label: "SQL (.sql)", content: "" },
] as const;

type CustomFileExtension = (typeof customFileTypes)[number]["extension"];

export function ProjectLayoutUI({
  projectId,
  projectName,
  initialActivity,
  initialFiles,
  initialRootTreeChildren,
  initialAllFiles,
  initialKnowledgeDocuments,
  initialSwitcherProjects,
  initialSkills,
  initialSessions,
  defaultFilePath,
  defaultFileContent,
  userMenu,
  children,
}: ProjectLayoutUIProps) {
  const isMobile = useIsMobile();
  useEffect(() => {
    const updateBibliographyCache = (event: Event) => {
      const file = (event as CustomEvent<WorkspaceChangedDetail>).detail?.files
        ?.find((candidate) => candidate.path === PROJECT_BIBLIOGRAPHY_PATH);
      if (file) writeCachedBibliography(`project:${projectId}`, file.content);
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, updateBibliographyCache);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, updateBibliographyCache);
      // Project slugs are scoped to an owner. Do not carry one owner's
      // references into a later visit to another owner's same-slug project.
      clearCachedBibliography(`project:${projectId}`);
    };
  }, [projectId]);
  const pathname = usePathname();
  const router = useRouter();
  // A conversation URL starts with its chat visible. Keep this visit's
  // landing state stable as navigation changes within the workspace.
  const [landedOnConversation] = useState(() => pathname.split("/").filter(Boolean).length > 1);
  const [activity, setActivity] = useState<Activity>(initialActivity ?? "literature");
  const [literatureSearchRequest, setLiteratureSearchRequest] = useState<{ query: string } | null>(null);
  const [folderRevealRequest, setFolderRevealRequest] = useState<{ path: string } | null>(null);
  const [railExpanded, setRailExpanded] = useState(false);
  const [railTooltipActivity, setRailTooltipActivity] = useState<Activity>();
  const [conversationHistoryOpen, setConversationHistoryOpen] = useState(false);
  const [conversationQuery, setConversationQuery] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(landedOnConversation);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Tooltip for the Shortcuts rail item: it is not an Activity, so it tracks
  // its own hover/focus instead of riding railTooltipActivity.
  const [shortcutsTooltipOpen, setShortcutsTooltipOpen] = useState(false);
  const [openFiles, setOpenFiles] = useState<FileEntry[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>();
  const [previewFilePath, setPreviewFilePath] = useState<string>();
  const [tabsRestored, setTabsRestored] = useState(false);
  // The workspace-mutation listener runs outside React's update cycle; these
  // refs mirror the tab state so it reads fresh values without a stale
  // closure, and never performs the URL rewrite inside a state updater.
  const openFilesRef = useRef<FileEntry[]>([]);
  const activeFilePathRef = useRef<string | undefined>(undefined);
  const previewFilePathRef = useRef<string | undefined>(undefined);
  // Identity of each open editor instance: the path the tab opened under.
  // Renames, moves, and untitled-draft saves re-path a tab but keep its key,
  // so FileViewer keeps the mounted editor (and its unsaved edits) instead of
  // reloading the file from the new path.
  const openFileKeysRef = useRef(new Map<string, string>());
  const activeFileKey = activeFilePath
    ? openFileKeysRef.current.get(activeFilePath) ?? activeFilePath
    : undefined;
  useEffect(() => {
    openFilesRef.current = openFiles;
    activeFilePathRef.current = activeFilePath;
    previewFilePathRef.current = previewFilePath;
  }, [openFiles, activeFilePath, previewFilePath]);
  const [draggedFilePath, setDraggedFilePath] = useState<string>();
  const [selection, setSelection] = useState<WorkspaceSelection>();
  const [pendingConversationPath, setPendingConversationPath] = useState<string>();
  const [mobileAgentHeight, setMobileAgentHeight] = useState(0);
  const [unsavedFile, setUnsavedFile] = useState<WorkspaceUnsavedFile>();
  const [attentionTabPath, setAttentionTabPath] = useState<string>();
  const [closeTabAttempt, setCloseTabAttempt] = useState<string>();
  const attentionTimerRef = useRef<number>(undefined);
  const fileTabsRef = useRef<HTMLDivElement>(null);
  const agentSheetDragRef = useRef<{ startHeight: number; startY: number } | null>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const editorRegistrationRef = useRef<WorkspaceEditorRegistration | undefined>(undefined);
  const selectionProviderRef = useRef<WorkspaceSelectionProvider | undefined>(undefined);
  const saveAsResolverRef = useRef<((saved: boolean) => void) | null>(null);
  const [saveAs, setSaveAs] = useState<{
    draftPath: string;
    content: string;
    defaultName: string;
    kind: UntitledDraftKind;
  }>();
  const [saveAsName, setSaveAsName] = useState("");
  const [saveAsError, setSaveAsError] = useState<string>();
  const [saveAsSaving, setSaveAsSaving] = useState(false);
  const [newArtifactKind, setNewArtifactKind] = useState<"form" | "matrix">();
  const [newArtifactName, setNewArtifactName] = useState("");
  const [newArtifactError, setNewArtifactError] = useState<string>();
  const [newArtifactPending, setNewArtifactPending] = useState(false);
  const [newCustomOpen, setNewCustomOpen] = useState(false);
  const [newCustomName, setNewCustomName] = useState("");
  const [newCustomExtension, setNewCustomExtension] = useState<CustomFileExtension>("txt");
  const [newCustomError, setNewCustomError] = useState<string>();
  const [newCustomPending, setNewCustomPending] = useState(false);

  useEffect(() => {
    const openQuickOpen = (event: globalThis.KeyboardEvent) => {
      const isQuickOpenShortcut =
        event.key?.toLowerCase() === "p" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      if (!isQuickOpenShortcut || event.repeat) return;

      event.preventDefault();
      event.stopPropagation();
      setQuickOpen((current) => !current);
    };

    window.addEventListener("keydown", openQuickOpen, true);
    return () => window.removeEventListener("keydown", openQuickOpen, true);
  }, []);

  const registerEditor = useCallback((registration: WorkspaceEditorRegistration) => {
    editorRegistrationRef.current = registration;
    setUnsavedFile(registration.dirty ? { path: registration.path } : undefined);
    if (registration.dirty && previewFilePathRef.current === registration.path) {
      previewFilePathRef.current = undefined;
      setPreviewFilePath(undefined);
    }
  }, []);

  const pinFile = useCallback((path: string) => {
    if (previewFilePathRef.current !== path) return;
    previewFilePathRef.current = undefined;
    setPreviewFilePath(undefined);
  }, []);

  const unregisterEditor = useCallback((id: string) => {
    if (editorRegistrationRef.current?.id !== id) return;
    editorRegistrationRef.current = undefined;
    setUnsavedFile(undefined);
  }, []);

  // Rich editors answer "what is selected" from their document model, so the
  // attached passage matches the file source instead of the rendered DOM.
  const registerSelectionProvider = useCallback((provider: WorkspaceSelectionProvider) => {
    selectionProviderRef.current = provider;
  }, []);

  const unregisterSelectionProvider = useCallback((id: string) => {
    if (selectionProviderRef.current?.id !== id) return;
    selectionProviderRef.current = undefined;
  }, []);

  const saveUnsavedFile = useCallback(async () => {
    const registration = editorRegistrationRef.current;
    if (!registration?.dirty) return true;
    return registration.save();
  }, []);

  const discardUnsavedFile = useCallback(() => {
    const registration = editorRegistrationRef.current;
    if (!registration?.dirty) return true;
    if (isUntitledDraftPath(registration.path)) {
      setOpenFiles((current) => {
        const index = current.findIndex((file) => file.path === registration.path);
        const next = current.filter((file) => file.path !== registration.path);
        setActiveFilePath((active) => {
          if (active !== registration.path) return active;
          return next[Math.min(Math.max(index, 0), Math.max(next.length - 1, 0))]?.path;
        });
        return next;
      });
      return true;
    }
    registration.discard();
    return true;
  }, []);

  const getUnsavedContent = useCallback(() => {
    const registration = editorRegistrationRef.current;
    if (!registration?.dirty) return null;
    return registration.getContent();
  }, []);

  const getCurrentContent = useCallback(() => {
    return editorRegistrationRef.current?.getContent() ?? null;
  }, []);

  useEffect(() => {
    if (pendingConversationPath && pathname === pendingConversationPath) {
      setPendingConversationPath(undefined);
    }
  }, [pathname, pendingConversationPath]);

  useEffect(() => {
    if (isMobile) {
      setNavigationOpen(false);
      setAgentOpen(landedOnConversation);
      setReviewOpen(false);
      setMobileAgentHeight(Math.round(window.innerHeight * 0.72));
    }
  }, [isMobile, landedOnConversation]);

  useEffect(() => {
    setRailExpanded(window.localStorage.getItem("beeblio:workspace-rail-expanded") === "true");
  }, []);

  // The workspace is a full-screen application shell: scrolling happens inside
  // its panels, never the document. Locking <body> stops mobile browsers from
  // panning into blank space when an element (e.g. an off-screen panel)
  // temporarily extends past an edge.
  useEffect(() => {
    document.body.classList.add("workspace-fullscreen");
    return () => document.body.classList.remove("workspace-fullscreen");
  }, []);

  useEffect(() => {
    const openChatForContext = () => {
      setAgentOpen(true);
      setReviewOpen(false);
      if (isMobile) setNavigationOpen(false);
      window.dispatchEvent(new CustomEvent(AGENT_PANEL_OPENED_EVENT));
    };
    window.addEventListener(ADD_FILE_TO_CHAT_EVENT, openChatForContext);
    window.addEventListener(ADD_SELECTION_TO_CHAT_EVENT, openChatForContext);
    window.addEventListener(ASK_AGENT_EVENT, openChatForContext);
    return () => {
      window.removeEventListener(ADD_FILE_TO_CHAT_EVENT, openChatForContext);
      window.removeEventListener(ADD_SELECTION_TO_CHAT_EVENT, openChatForContext);
      window.removeEventListener(ASK_AGENT_EVENT, openChatForContext);
    };
  }, [isMobile]);

  useEffect(() => {
    const openAgentFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenWorkspaceFileDetail>).detail;
      if (!detail?.path || !detail.name) return;
      openFile(entryForPath(detail.path, detail.name, initialFiles, initialRootTreeChildren));
    };
    window.addEventListener(OPEN_WORKSPACE_FILE_EVENT, openAgentFile);
    return () => window.removeEventListener(OPEN_WORKSPACE_FILE_EVENT, openAgentFile);
  });

  // The editor's "@" menu hands off deep literature searches ("More results")
  // to the rail: open the Literature panel and hand it the query. State goes
  // through props rather than a second event because the panel mounts only
  // after this switches the activity, so it would miss a directly dispatched
  // event.
  useEffect(() => {
    const openLiteratureSearch = (event: Event) => {
      const detail = (event as CustomEvent<OpenLiteratureSearchDetail>).detail;
      if (!detail?.query) return;
      rememberRailActivity(projectId, "literature");
      setActivity("literature");
      setNavigationOpen(true);
      setLiteratureSearchRequest({ query: detail.query });
    };
    window.addEventListener(OPEN_LITERATURE_SEARCH_EVENT, openLiteratureSearch);
    return () => window.removeEventListener(OPEN_LITERATURE_SEARCH_EVENT, openLiteratureSearch);
  }, [projectId]);

  // Folder mention chips in the chat reveal the folder in the File Explorer
  // rather than opening an editor tab. Like the literature handoff above, the
  // request reaches the explorer through props because it mounts only after
  // this switches the activity to "files".
  useEffect(() => {
    const revealWorkspaceFolder = (event: Event) => {
      const detail = (event as CustomEvent<OpenWorkspaceFolderDetail>).detail;
      if (!detail?.path) return;
      rememberRailActivity(projectId, "files");
      setActivity("files");
      setNavigationOpen(true);
      setFolderRevealRequest({ path: detail.path });
    };
    window.addEventListener(OPEN_WORKSPACE_FOLDER_EVENT, revealWorkspaceFolder);
    return () => window.removeEventListener(OPEN_WORKSPACE_FOLDER_EVENT, revealWorkspaceFolder);
  }, [projectId]);

  useEffect(() => {
    const filePath = new URLSearchParams(window.location.search).get("file") || undefined;
    const storageKey = `beeblio:${projectId}:open-files`;
    let savedPaths: string[] = [];
    let savedActivePath: string | undefined;
    let hasSavedTabs = false;
    try {
      const parsed: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null");
      if (parsed && typeof parsed === "object" && "paths" in parsed && Array.isArray(parsed.paths)) {
        hasSavedTabs = true;
        savedPaths = [...new Set(parsed.paths.filter((path): path is string => typeof path === "string" && path.length > 0))];
        if ("activePath" in parsed && typeof parsed.activePath === "string") savedActivePath = parsed.activePath;
      }
    } catch {
      // Storage can be disabled, or contain data from an older version.
    }
    const activePath = filePath && !isUntitledDraftPath(filePath)
      ? filePath
      : savedActivePath ?? savedPaths.at(-1) ?? (hasSavedTabs ? undefined : defaultFilePath);
    const paths = [...savedPaths];
    if (activePath && !paths.includes(activePath)) paths.push(activePath);
    if (activePath && activePath === defaultFilePath && defaultFileContent !== undefined) {
      writeCachedText(activePath, defaultFileContent);
    }
    const files = paths.map((path) => entryForPath(
      path,
      isUntitledDraftPath(path) ? untitledDraftTabLabel(path) : path.split("/").at(-1) || path,
      initialFiles,
      initialRootTreeChildren,
    ));
    openFilesRef.current = files;
    activeFilePathRef.current = activePath;
    setOpenFiles(files);
    setActiveFilePath(activePath);
    setTabsRestored(true);
    if (activePath) setFileInUrl(activePath);
  // Seed the initial server-selected tab once; later file changes use the tab actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tabsRestored) return;
    try {
      window.sessionStorage.setItem(
        `beeblio:${projectId}:open-files`,
        JSON.stringify({ paths: openFiles.map((file) => file.path), activePath: activeFilePath }),
      );
    } catch {
      // Browsers with blocked or full storage still keep tabs for this visit.
    }
  }, [projectId, openFiles, activeFilePath, tabsRestored]);

  const setFileInUrl = (filePath?: string) => {
    const url = new URL(window.location.href);
    if (filePath && !isUntitledDraftPath(filePath)) url.searchParams.set("file", filePath);
    else url.searchParams.delete("file");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  // Renames, moves, and deletes broadcast their outcome; keep open tabs, the
  // active file, and its URL param pointing at the paths that exist now, so a
  // renamed tab saves under its new name instead of resurrecting the old file.
  useEffect(() => {
    const handler = (event: Event) => {
      const mutation = (event as CustomEvent<WorkspaceMutation>).detail;
      if (mutation.kind === "move") {
        for (const open of openFilesRef.current) {
          const repathed = open.path === mutation.from
            ? mutation.to
            : open.path.startsWith(`${mutation.from}/`)
              ? mutation.to + open.path.slice(mutation.from.length)
              : null;
          if (repathed === null) continue;
          openFileKeysRef.current.set(
            repathed,
            openFileKeysRef.current.get(open.path) ?? open.path,
          );
          openFileKeysRef.current.delete(open.path);
          moveTextDraftKey(projectId, open.path, repathed);
        }
        setOpenFiles((current) => current.map((file) => {
          if (file.path === mutation.from) {
            return { ...file, name: mutation.entry.name, path: mutation.to };
          }
          if (file.path.startsWith(`${mutation.from}/`)) {
            return { ...file, path: mutation.to + file.path.slice(mutation.from.length) };
          }
          return file;
        }));
        const active = activeFilePathRef.current;
        const preview = previewFilePathRef.current;
        if (preview === mutation.from) {
          previewFilePathRef.current = mutation.to;
          setPreviewFilePath(mutation.to);
        } else if (preview?.startsWith(`${mutation.from}/`)) {
          const moved = mutation.to + preview.slice(mutation.from.length);
          previewFilePathRef.current = moved;
          setPreviewFilePath(moved);
        }
        if (active === mutation.from) {
          setActiveFilePath(mutation.to);
          setFileInUrl(mutation.to);
        } else if (active?.startsWith(`${mutation.from}/`)) {
          const moved = mutation.to + active.slice(mutation.from.length);
          setActiveFilePath(moved);
          setFileInUrl(moved);
        }
        return;
      }
      if (mutation.kind === "delete") {
        for (const key of [...openFileKeysRef.current.keys()]) {
          if (key === mutation.path || key.startsWith(`${mutation.path}/`)) {
            openFileKeysRef.current.delete(key);
            clearTextDraft(projectId, key);
          }
        }
        const index = openFilesRef.current.findIndex(
          (file) => file.path === mutation.path || file.path.startsWith(`${mutation.path}/`),
        );
        if (index === -1) return;
        const next = openFilesRef.current.filter(
          (file) => file.path !== mutation.path && !file.path.startsWith(`${mutation.path}/`),
        );
        const preview = previewFilePathRef.current;
        if (preview === mutation.path || preview?.startsWith(`${mutation.path}/`)) {
          previewFilePathRef.current = undefined;
          setPreviewFilePath(undefined);
        }
        setOpenFiles(next);
        const active = activeFilePathRef.current;
        if (active === mutation.path || active?.startsWith(`${mutation.path}/`)) {
          // Deleting the viewed file closes its tab; land on a neighbor like
          // closing a tab does, rather than an empty editor area.
          const replacement = next[Math.min(index, next.length - 1)]?.path;
          setActiveFilePath(replacement);
          setFileInUrl(replacement);
        }
      }
    };
    window.addEventListener(WORKSPACE_MUTATION_EVENT, handler);
    return () => window.removeEventListener(WORKSPACE_MUTATION_EVENT, handler);
  }, [projectId]);

  const createUntitledDraft = (kind: UntitledDraftKind) => {
    const draft = untitledDraftFile(nextUntitledNumber(openFiles.map((file) => file.path), kind), kind);
    const file: FileEntry = { ...draft, isDir: false, size: 0 };
    setOpenFiles((current) => [...current, file]);
    setActiveFilePath(file.path);
    setFileInUrl(undefined);
    if (isMobile) setNavigationOpen(false);
  };

  const closeSaveAsDialog = (saved: boolean) => {
    saveAsResolverRef.current?.(saved);
    saveAsResolverRef.current = null;
    setSaveAs(undefined);
    setSaveAsError(undefined);
    setSaveAsSaving(false);
  };

  const saveUntitledDraft = useCallback((draftPath: string, content: string) => {
    const draft = openFiles.find((file) => file.path === draftPath);
    const defaultName = draft?.name ?? "Untitled-1.md";
    saveAsResolverRef.current?.(false);
    setSaveAs({ draftPath, content, defaultName, kind: untitledDraftKind(draftPath) });
    // The dialog locks the file suffix; the editable field carries the stem.
    setSaveAsName(splitFileName(defaultName).stem);
    setSaveAsError(undefined);
    return new Promise<boolean>((resolve) => {
      saveAsResolverRef.current = resolve;
    });
  }, [openFiles]);

  const confirmSaveAs = async () => {
    if (!saveAs) return;
    const extension = saveAs.kind === "excalidraw" ? "excalidraw" : "md";
    const normalized = normalizeRootFileName(`${saveAsName.trim()}.${extension}`, saveAs.kind);
    if ("error" in normalized) {
      setSaveAsError(normalized.error);
      return;
    }

    setSaveAsSaving(true);
    const file = new File(
      [saveAs.content],
      normalized.name,
      { type: saveAs.kind === "excalidraw" ? "application/json" : "text/markdown" },
    );
    try {
      const result = await uploadWorkspaceFile(projectId, "", file);
      if (!result.success) {
        setSaveAsError(result.error);
        setSaveAsSaving(false);
        return;
      }

      dispatchWorkspaceMutation({ kind: "create", entry: result.file });
      // Saving a draft re-paths the tab onto the real file; carry the editor
      // key so the mounted editor (and its undo history) survives the save.
      openFileKeysRef.current.set(
        result.file.path,
        openFileKeysRef.current.get(saveAs.draftPath) ?? saveAs.draftPath,
      );
      openFileKeysRef.current.delete(saveAs.draftPath);
      setOpenFiles((current) =>
        current.map((entry) => (entry.path === saveAs.draftPath ? result.file : entry)),
      );
      setActiveFilePath(result.file.path);
      setFileInUrl(result.file.path);
      window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
      toast.success(`${result.file.name} saved`);
      closeSaveAsDialog(true);
    } catch (error) {
      setSaveAsError(error instanceof Error ? error.message : "Failed to save");
      setSaveAsSaving(false);
    }
  };

  const openFile = (file: FileEntry, pinned = true) => {
    const alreadyOpen = openFilesRef.current.some((item) => item.path === file.path);
    if (alreadyOpen) {
      if (pinned && previewFilePathRef.current === file.path) {
        previewFilePathRef.current = undefined;
        setPreviewFilePath(undefined);
      }
      setActiveFilePath(file.path);
      setFileInUrl(file.path);
      if (isMobile) setNavigationOpen(false);
      return;
    }

    const replacedPreview = !pinned ? previewFilePathRef.current : undefined;
    setOpenFiles((current) =>
      replacedPreview
        ? current.map((item) => item.path === replacedPreview ? file : item)
        : [...current, file],
    );
    if (!pinned) {
      if (replacedPreview) openFileKeysRef.current.delete(replacedPreview);
      previewFilePathRef.current = file.path;
      setPreviewFilePath(file.path);
    }
    setActiveFilePath(file.path);
    setFileInUrl(file.path);
    if (isMobile) setNavigationOpen(false);
  };

  const previewFile = (file: FileEntry, pinned = false) => openFile(file, pinned);

  const createArtifact = async () => {
    const name = newArtifactName.trim();
    if (!newArtifactKind || !name || newArtifactPending) return;
    setNewArtifactPending(true);
    setNewArtifactError(undefined);
    try {
      let file: FileEntry;
      if (newArtifactKind === "form") {
        file = await createFormInFormsFolder(projectId, name);
        announceFormCreated();
      } else {
        const result = await createMatrixFile({ projectId, name });
        if (!result.success) {
          setNewArtifactError(result.error);
          return;
        }
        file = {
          name: result.matrixPath.split("/").at(-1) || result.matrixPath,
          path: result.matrixPath,
          isDir: false,
          size: 0,
        };
        dispatchWorkspaceMutation({ kind: "create", entry: file });
        window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
      }
      setNewArtifactKind(undefined);
      setNewArtifactName("");
      openFile(file);
    } catch (error) {
      setNewArtifactError(error instanceof Error ? error.message : "Could not create the file.");
    } finally {
      setNewArtifactPending(false);
    }
  };

  const createCustomFile = async () => {
    if (newCustomPending) return;
    const raw = newCustomName.trim();
    const suffix = `.${newCustomExtension}`;
    const stem = raw.toLowerCase().endsWith(suffix) ? raw.slice(0, -suffix.length).trim() : raw;
    if (!stem || stem === "." || stem === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(stem)) {
      setNewCustomError("Enter a valid file name without a folder path.");
      return;
    }
    setNewCustomPending(true);
    setNewCustomError(undefined);
    const type = customFileTypes.find((item) => item.extension === newCustomExtension)!;
    const file = new File([type.content], `${stem}${suffix}`, { type: "text/plain" });
    try {
      const result = await uploadWorkspaceFile(projectId, "", file);
      if (!result.success) {
        setNewCustomError(result.error);
        return;
      }
      dispatchWorkspaceMutation({ kind: "create", entry: result.file });
      window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
      window.dispatchEvent(new Event("beeblio:storage-changed"));
      setNewCustomOpen(false);
      setNewCustomName("");
      openFile(result.file);
    } catch (error) {
      setNewCustomError(error instanceof Error ? error.message : "Could not create the file.");
    } finally {
      setNewCustomPending(false);
    }
  };

  // Instant first paint for Quick Open: the server-rendered listing stands in
  // until the dialog's own refresh completes.
  const quickOpenSeedFiles = useMemo(
    () => [...initialFiles, ...Object.values(initialRootTreeChildren).flat()],
    [initialFiles, initialRootTreeChildren],
  );

  const closeFile = (filePath: string) => {
    // The mounted registration covers the active tab; the draft store also
    // covers background tabs, whose unsaved work outlives their editor.
    if (unsavedFile?.path === filePath || readTextDraft(projectId, filePath) !== undefined) {
      setCloseTabAttempt(filePath);
      return;
    }
    closeFileForce(filePath);
  };

  const closeFileForce = (filePath: string) => {
    const index = openFiles.findIndex((file) => file.path === filePath);
    const next = openFiles.filter((file) => file.path !== filePath);
    setOpenFiles(next);
    clearTextDraft(projectId, filePath);
    if (previewFilePathRef.current === filePath) {
      previewFilePathRef.current = undefined;
      setPreviewFilePath(undefined);
    }
    if (activeFilePath === filePath) {
      const replacement = next[Math.min(index, next.length - 1)];
      setActiveFilePath(replacement?.path);
      setFileInUrl(replacement?.path);
    }
  };

  // Save/discard for the Unsaved Changes dialog, path-aware: the active tab
  // goes through its mounted editor registration; a background tab's draft
  // lives only in the store, so it is saved straight to the workspace.
  const saveDirtyTab = async (filePath: string) => {
    const registration = editorRegistrationRef.current;
    if (registration?.path === filePath) {
      const saved = await saveUnsavedFile();
      if (saved) clearTextDraft(projectId, filePath);
      return saved;
    }
    const stored = readTextDraft(projectId, filePath);
    if (stored === undefined) return true;
    // A background untitled tab needs the Save As flow; its editor is not
    // mounted, so the draft entry is cleared here rather than by the editor.
    if (isUntitledDraftPath(filePath)) {
      const saved = await saveUntitledDraft(filePath, stored);
      if (saved) clearTextDraft(projectId, filePath);
      return saved;
    }
    try {
      await saveFile(projectId, filePath, stored);
      writeCachedText(filePath, stored);
      clearTextDraft(projectId, filePath);
      toast.success("Saved");
      return true;
    } catch {
      toast.error("Failed to save");
      return false;
    }
  };

  const discardDirtyTab = (filePath: string) => {
    const registration = editorRegistrationRef.current;
    if (registration?.path === filePath) {
      discardUnsavedFile();
      return;
    }
    clearTextDraft(projectId, filePath);
  };

  const startFileTabDrag = (event: DragEvent<HTMLButtonElement>, filePath: string) => {
    setDraggedFilePath(filePath);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", filePath);
  };

  const moveFileTab = (event: DragEvent<HTMLButtonElement>, targetPath: string) => {
    if (!draggedFilePath) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (draggedFilePath === targetPath) return;

    const targetBounds = event.currentTarget.getBoundingClientRect();
    const insertAfterTarget = event.clientX >= targetBounds.left + targetBounds.width / 2;

    setOpenFiles((current) => {
      const draggedFile = current.find((file) => file.path === draggedFilePath);
      if (!draggedFile) return current;

      const reordered = current.filter((file) => file.path !== draggedFilePath);
      const targetIndex = reordered.findIndex((file) => file.path === targetPath);
      if (targetIndex === -1) return current;

      const insertionIndex = targetIndex + (insertAfterTarget ? 1 : 0);
      reordered.splice(insertionIndex, 0, draggedFile);
      return reordered;
    });
  };

  const finishFileTabDrag = () => setDraggedFilePath(undefined);

  const activeFile = openFiles.find((file) => file.path === activeFilePath);
  const workspaceContext = useMemo(
    () => ({
      initialFiles: initialAllFiles,
      activeFile,
      selection,
      unsavedFile,
      clearSelection: () => setSelection(undefined),
      pinFile,
      registerEditor,
      unregisterEditor,
      registerSelectionProvider,
      unregisterSelectionProvider,
      saveUnsavedFile,
      discardUnsavedFile,
      getUnsavedContent,
      getCurrentContent,
      saveUntitledDraft,
    }),
    [activeFile, initialAllFiles, discardUnsavedFile, getCurrentContent, getUnsavedContent, pinFile, registerEditor, registerSelectionProvider, saveUntitledDraft, saveUnsavedFile, selection, unregisterEditor, unregisterSelectionProvider, unsavedFile],
  );

  // One capture pipeline for every selection surface: a rich editor's document
  // model first (source-faithful text, [@key] citations, range), then the
  // rendered DOM as a labeled fallback for viewers, previews, and generated
  // sections where no document model exists.
  useEffect(() => {
    const captureSelection = () => {
      const selected = window.getSelection();
      const anchor = selected?.anchorNode;
      if (!anchor || !activeFile || !editorAreaRef.current?.contains(anchor)) return;
      const provider = selectionProviderRef.current;
      if (provider && provider.path === activeFile.path) {
        const fromEditor = provider.getSelection();
        if (fromEditor && fromEditor.text.trim()) {
          setSelection({ filePath: activeFile.path, ...fromEditor, source: "document" });
          return;
        }
      }
      const text = selected?.toString().trim();
      if (!text) return;
      setSelection({ filePath: activeFile.path, text: text.slice(0, SELECTION_MAX_CHARS), source: "rendered" });
    };
    document.addEventListener("selectionchange", captureSelection);
    return () => document.removeEventListener("selectionchange", captureSelection);
  }, [activeFile]);

  useEffect(() => setSelection(undefined), [activeFilePath]);
  useEffect(() => {
    if (!activeFilePath || !isMarkdownFilePath(activeFilePath)) setReviewOpen(false);
  }, [activeFilePath]);

  const captureTextControlSelection = (event: SyntheticEvent<HTMLDivElement>) => {
    const control = event.target;
    if (!(control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement) || !activeFile) return;
    const start = control.selectionStart;
    const end = control.selectionEnd;
    if (start === null || end === null || start === end) return;
    const text = control.value.slice(start, end).trim();
    // Control values (grid cells, form fields) are UI text, not file bytes.
    if (text) setSelection({ filePath: activeFile.path, text: text.slice(0, SELECTION_MAX_CHARS), source: "rendered" });
  };
  const newConversationHref = `/${projectId}${activeFilePath && !isUntitledDraftPath(activeFilePath) ? `?file=${encodeURIComponent(activeFilePath)}` : ""}`;
  const openNewConversation = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setConversationHistoryOpen(false);
    setAgentOpen(true);
    setReviewOpen(false);
    if (window.location.pathname !== `/${projectId}`) {
      setPendingConversationPath(undefined);
      window.dispatchEvent(new CustomEvent(NEW_CONVERSATION_EVENT));
      window.history.pushState(null, "", newConversationHref);
    }
  };

  // When an action opens a file that is already open, point the user at the
  // existing tab instead of appearing to do nothing.
  const cueFileTab = (filePath: string) => {
    window.clearTimeout(attentionTimerRef.current);
    setAttentionTabPath(undefined);
    requestAnimationFrame(() => setAttentionTabPath(filePath));
    attentionTimerRef.current = window.setTimeout(() => setAttentionTabPath(undefined), 2_700);
  };

  useEffect(() => () => window.clearTimeout(attentionTimerRef.current), []);

  useEffect(() => {
    if (!attentionTabPath) return;
    const tab = fileTabsRef.current?.querySelector<HTMLButtonElement>(`[data-path="${attentionTabPath}"]`);
    tab?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [attentionTabPath]);

  // Panels that intentionally re-open a centerpiece file (e.g. the Literature
  // panel's Library tab activating references.bib) cue the existing tab.
  const openFileWithCue = (file: FileEntry, pinned?: boolean) => {
    const alreadyOpen = openFiles.some((open) => open.path === file.path);
    openFile(file, pinned);
    if (alreadyOpen) cueFileTab(file.path);
  };

  const selectActivity = (next: Activity) => {
    if (isMobile) {
      if (activity === next && navigationOpen) {
        setNavigationOpen(false);
        return;
      }
      rememberRailActivity(projectId, next);
      setActivity(next);
      setNavigationOpen(true);
      return;
    }

    if (activity === next) {
      if (!railExpanded && !navigationOpen) {
        setNavigationOpen(true);
      } else if (!railExpanded && navigationOpen) {
        setRailExpanded(true);
        window.localStorage.setItem("beeblio:workspace-rail-expanded", "true");
      } else if (railExpanded && navigationOpen) {
        setNavigationOpen(false);
      } else if (railExpanded && !navigationOpen) {
        setRailExpanded(false);
        window.localStorage.setItem("beeblio:workspace-rail-expanded", "false");
      }
    } else {
      rememberRailActivity(projectId, next);
      setActivity(next);
      setNavigationOpen(true);
    }
  };

  const openConversation = (sessionId: string) => {
    setAgentOpen(true);
    setReviewOpen(false);
    setConversationHistoryOpen(false);
    window.dispatchEvent(new CustomEvent(AGENT_PANEL_OPENED_EVENT));
    const destination = `/${projectId}/${sessionId}`;
    if (pathname !== destination) {
      setPendingConversationPath(destination);
    }
    if (isMobile) setNavigationOpen(false);
  };

  const openAgentPanel = () => {
    setAgentOpen(true);
    setReviewOpen(false);
    if (isMobile) setNavigationOpen(false);
    window.dispatchEvent(new CustomEvent(AGENT_PANEL_OPENED_EVENT));
  };

  const openReviewPanel = () => {
    setReviewOpen(true);
    setAgentOpen(false);
    if (isMobile) setNavigationOpen(false);
  };

  const resizeMobileAgent = (height: number) => {
    const maximum = Math.max(280, window.innerHeight - 16);
    setMobileAgentHeight(Math.min(maximum, Math.max(240, height)));
  };

  const startAgentSheetResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!isMobile) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    agentSheetDragRef.current = {
      startHeight: mobileAgentHeight || Math.round(window.innerHeight * 0.72),
      startY: event.clientY,
    };
  };

  const moveAgentSheetResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = agentSheetDragRef.current;
    if (!drag) return;
    resizeMobileAgent(drag.startHeight + drag.startY - event.clientY);
  };

  const stopAgentSheetResize = () => {
    agentSheetDragRef.current = null;
  };

  const resizeAgentSheetWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = mobileAgentHeight || Math.round(window.innerHeight * 0.72);
    resizeMobileAgent(current + (event.key === "ArrowUp" ? 32 : -32));
  };

  const handleConversationDeleted = (sessionId: string) => {
    if (pathname !== `/${projectId}/${sessionId}`) return;
    setPendingConversationPath(`/${projectId}`);
    router.replace(newConversationHref);
  };

  return (
    <MatrixTargetsProvider projectId={projectId} initialFiles={initialAllFiles}>
    <WorkspaceContext.Provider value={workspaceContext}>
      <div className="relative flex h-screen w-full overflow-hidden bg-background text-foreground supports-[height:100dvh]:h-dvh">
        <aside
          data-expanded={!isMobile && railExpanded}
          className={cn(
            "workspace-rail z-50 flex shrink-0 flex-col border-r bg-sidebar pt-2 transition-[width] duration-200",
            isMobile || !railExpanded ? "w-12 items-center" : "w-44 items-stretch",
            isMobile
              ? "pb-[max(2.5rem,calc(0.5rem+env(safe-area-inset-bottom)))]"
              : "pb-2",
          )}
        >
          <Brand
            href="/workspace"
            compact={isMobile || !railExpanded}
            className={cn("mb-3 h-9", isMobile || !railExpanded ? "" : "px-2")}
          />
          <nav className="flex w-full min-h-0 flex-1 flex-col gap-1 overflow-hidden px-1.5" aria-label="Workspace navigation">
            {activities.map(({ id, label, icon: Icon }) => {
              const active = activity === id && navigationOpen;
              return <Tooltip key={id} open={(isMobile || !railExpanded) && railTooltipActivity === id}>
                <TooltipTrigger asChild>
                  <Button
                    size={isMobile || !railExpanded ? "icon" : "sm"}
                    variant="ghost"
                    className={cn(
                      "relative h-9 rounded-lg text-muted-foreground",
                      isMobile || !railExpanded ? "w-9 px-0" : "w-full justify-start px-2.5",
                      active && "bg-accent text-accent-foreground",
                    )}
                    aria-label={label}
                    aria-pressed={active}
                    onPointerEnter={() => setRailTooltipActivity(id)}
                    onPointerLeave={() => setRailTooltipActivity((current) => current === id ? undefined : current)}
                    onFocus={() => setRailTooltipActivity(id)}
                    onBlur={() => setRailTooltipActivity((current) => current === id ? undefined : current)}
                    onClick={() => selectActivity(id)}
                  >
                    {active ? <span className="absolute -left-1.5 h-5 w-0.5 rounded-r bg-primary" /> : null}
                    <Icon className="size-[17px]" />
                    {!isMobile && railExpanded ? <span className="truncate">{label}</span> : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>;
            })}
          </nav>
          <div className={cn("mt-auto flex w-full flex-col gap-1 border-t border-border/70 pt-2 pb-2", isMobile || !railExpanded ? "items-center" : "items-start px-1.5")}>
            {/* {!isMobile ? (
            <Tooltip open={!railExpanded && railUtilityTooltip === "navigation"}>
              <TooltipTrigger asChild>
                <Button
                  size={railExpanded ? "sm" : "icon"}
                  variant="ghost"
                  className={cn("h-9 gap-2 rounded-lg text-xs font-medium text-muted-foreground", railExpanded ? "w-full justify-start px-2.5" : "w-9 px-0")}
                  onPointerEnter={() => setRailUtilityTooltip("navigation")}
                  onPointerLeave={() => setRailUtilityTooltip(undefined)}
                  onFocus={() => setRailUtilityTooltip("navigation")}
                  onBlur={() => setRailUtilityTooltip(undefined)}
                  onClick={toggleRail}
                  aria-label={railExpanded ? "Collapse workspace navigation" : "Expand workspace navigation"}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center">
                    {railExpanded ? <ChevronLeft className="size-[17px]" /> : <ChevronRight className="size-[17px]" />}
                  </span>
                  {railExpanded ? <span>Collapse</span> : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand navigation</TooltipContent>
            </Tooltip>
          ) : null} */}
            {/* Opens the shortcut cheatsheet dialog; not an Activity panel, so
                it bypasses selectActivity and keeps its own tooltip state. */}
            <Tooltip open={shortcutsTooltipOpen && (isMobile || !railExpanded)}>
              <TooltipTrigger asChild>
                <Button
                  size={isMobile || !railExpanded ? "icon" : "sm"}
                  variant="ghost"
                  className={cn(
                    "relative h-9 gap-2 rounded-lg text-xs font-medium text-muted-foreground",
                    isMobile || !railExpanded ? "w-9 px-0" : "w-full justify-start px-2.5",
                  )}
                  aria-label="Shortcuts"
                  aria-haspopup="dialog"
                  onPointerEnter={() => setShortcutsTooltipOpen(true)}
                  onPointerLeave={() => setShortcutsTooltipOpen(false)}
                  onFocus={() => setShortcutsTooltipOpen(true)}
                  onBlur={() => setShortcutsTooltipOpen(false)}
                  onClick={() => {
                    setShortcutsTooltipOpen(false);
                    setShortcutsOpen(true);
                  }}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center">
                    <Info className="size-[17px]" />
                  </span>
                  {!isMobile && railExpanded ? <span className="truncate">Shortcuts</span> : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Shortcuts</TooltipContent>
            </Tooltip>
            {(() => {
              const { id, label, icon: Icon } = SKILLS_RAIL_ITEM;
              const active = activity === id && navigationOpen;
              // Same icon/label geometry as the Collapse and account buttons:
              // size-7 icon box, gap-2, text-xs font-medium, px-2.5 expanded.
              return <Tooltip key={id} open={(isMobile || !railExpanded) && railTooltipActivity === id}>
                <TooltipTrigger asChild>
                  <Button
                    size={isMobile || !railExpanded ? "icon" : "sm"}
                    variant="ghost"
                    className={cn(
                      "relative h-9 gap-2 rounded-lg text-xs font-medium text-muted-foreground",
                      isMobile || !railExpanded ? "w-9 px-0" : "w-full justify-start px-2.5",
                      active && "bg-accent text-accent-foreground",
                    )}
                    aria-label={label}
                    aria-pressed={active}
                    onPointerEnter={() => setRailTooltipActivity(id)}
                    onPointerLeave={() => setRailTooltipActivity((current) => current === id ? undefined : current)}
                    onFocus={() => setRailTooltipActivity(id)}
                    onBlur={() => setRailTooltipActivity((current) => current === id ? undefined : current)}
                    onClick={() => selectActivity(id)}
                  >
                    {active ? <span className="absolute -left-1.5 h-5 w-0.5 rounded-r bg-primary" /> : null}
                    <span className="flex size-7 shrink-0 items-center justify-center">
                      <Icon className="size-[17px]" />
                    </span>
                    {!isMobile && railExpanded ? <span className="truncate">{label}</span> : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>;
            })()}
            <div className={cn("mb-1 w-full border-t border-border/50", isMobile || !railExpanded ? "max-w-6" : "")} aria-hidden="true" />
            {userMenu ? (
              <div className={cn(isMobile || !railExpanded ? "w-9" : "w-full")}>
                {userMenu}
              </div>
            ) : null}
          </div>
        </aside>

        {isMobile && navigationOpen ? <button className="fixed inset-0 z-30 bg-black/20" aria-label="Close navigation" onClick={() => setNavigationOpen(false)} /> : null}

        <aside
          className={cn(
            "z-40 flex shrink-0 flex-col overflow-hidden border-r bg-sidebar transition-[width,transform] duration-200",
            isMobile ? "fixed inset-y-0 left-12 w-[min(82vw,320px)] shadow-xl" : navigationOpen ? "w-64" : "w-0 border-r-0",
            isMobile && !navigationOpen && "-translate-x-[110%]",
          )}
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <ProjectSwitcher projectId={projectId} projectName={projectName} initialProjects={initialSwitcherProjects} />
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setNavigationOpen(false)}
              aria-label="Hide navigation"
            >
              <ChevronLeft />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <NavigationContent
              activity={activity}
              projectId={projectId}
              projectName={projectName}
              initialFiles={initialFiles}
              initialRootTreeChildren={initialRootTreeChildren}
              initialAllFiles={initialAllFiles}
              initialKnowledgeDocuments={initialKnowledgeDocuments}
              initialSkills={initialSkills}
              activeFilePath={activeFilePath}
              onOpenFile={previewFile}
              onOpenFileWithCue={openFileWithCue}
              literatureSearchRequest={literatureSearchRequest}
              onLiteratureSearchConsumed={() => setLiteratureSearchRequest(null)}
              folderRevealRequest={folderRevealRequest}
              onFolderRevealConsumed={() => setFolderRevealRequest(null)}
            />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-12 shrink-0 items-end border-b bg-muted/45 pt-1.5">
            <div
              ref={fileTabsRef}
              aria-label="Open files"
              className="flex min-w-0 flex-1 self-stretch items-end overflow-x-auto overflow-y-hidden pt-1"
              onDragOver={(event) => {
                if (!draggedFilePath) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                if (!draggedFilePath) return;
                event.preventDefault();
                finishFileTabDrag();
              }}
              role="tablist"
            >
              {openFiles.map((file) => (
                <button
                  key={file.path}
                  data-path={file.path}
                  aria-selected={activeFilePath === file.path}
                  draggable
                  className={cn(
                    "group relative -mb-px -ml-px flex h-[calc(100%+1px)] min-w-32 max-w-52 cursor-default items-center gap-2 rounded-t-2xl border border-b-0 border-border/80 px-4 text-xs text-muted-foreground transition-[color,background-color,border-color,opacity,transform] first:ml-0",
                    "hover:border-primary/25 hover:bg-card/45 hover:text-foreground",
                    draggedFilePath === file.path && "z-20 scale-[0.98] cursor-grabbing opacity-55",
                    previewFilePath === file.path && "italic",
                    activeFilePath === file.path &&
                    "z-10 border-primary/40 bg-card text-foreground shadow-[0_-2px_10px_rgb(18_35_48/0.08)] hover:bg-card after:absolute after:-right-3 after:bottom-0 after:size-3 after:rounded-bl-xl after:bg-transparent after:shadow-[-4px_4px_0_4px_var(--card)] before:absolute before:-left-3 before:bottom-0 before:size-3 before:rounded-br-xl before:bg-transparent before:shadow-[4px_4px_0_4px_var(--card)]",
                    attentionTabPath === file.path && "tab-attention",
                  )}
                  onDragStart={(event) => startFileTabDrag(event, file.path)}
                  onDragOver={(event) => moveFileTab(event, file.path)}
                  onDrop={(event) => { event.preventDefault(); finishFileTabDrag(); }}
                  onDragEnd={finishFileTabDrag}
                  onClick={() => { setActiveFilePath(file.path); setFileInUrl(file.path); }}
                  onDoubleClick={() => {
                    if (previewFilePathRef.current !== file.path) return;
                    previewFilePathRef.current = undefined;
                    setPreviewFilePath(undefined);
                  }}
                  role="tab"
                  title={previewFilePath === file.path ? `${file.name} (Preview — double-click to keep open)` : file.name}
                >
                  <FileTabIcon name={file.name} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {isUntitledDraftPath(file.path) ? untitledDraftTabLabel(file.path) : file.name}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${file.name}`}
                    className="rounded-md p-0.5 opacity-45 transition-[opacity,background-color] hover:bg-muted hover:opacity-100 group-hover:opacity-75 group-focus-visible:opacity-100"
                    onClick={(event) => { event.stopPropagation(); closeFile(file.path); }}
                    onKeyDown={(event) => { if (event.key === "Enter") closeFile(file.path); }}
                  ><X className="size-3" /></span>
                </button>
              ))}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        className="mb-[5px] ml-1 mr-1 size-7 shrink-0 self-center rounded-full"
                        aria-label="New File"
                      >
                        <Plus className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>New File</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => createUntitledDraft("markdown")}>
                    <FileText />Document
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => createUntitledDraft("excalidraw")}>
                    <PenTool />Drawing
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setNewArtifactKind("form")}>
                    <ClipboardList />Survey Form
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setNewArtifactKind("matrix")}>
                    <Table2 />Literature Matrix
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setNewCustomOpen(true)}>
                    <Code2 />Custom
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="mb-[5px] size-8 shrink-0 self-center text-muted-foreground"
                  onClick={() => setQuickOpen(true)}
                  aria-label="Quick open files, library, or literature"
                  aria-keyshortcuts="Control+P Meta+P"
                >
                  <Search className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Quick Open (⌘P / Ctrl+P)</TooltipContent>
            </Tooltip>
            {activeFilePath && isMarkdownFilePath(activeFilePath) && !reviewOpen ? <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="mb-[5px] size-8 shrink-0 self-center text-muted-foreground"
                  // onClick={() => notifyUpcomingFeature("Document Review")}
                  onClick={openReviewPanel}
                  aria-label="Open document review"
                >
                  <ShieldCheck className="size-4.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Review Document</TooltipContent>
            </Tooltip> : null}
            {!agentOpen ? (
              <Button
                size="sm"
                className="mx-2 h-8 -translate-y-[3px] self-center gap-2 border border-[#b97827] bg-brand-warm px-2.5 text-[#15232c] shadow-none ring-1 ring-[#b97827]/20 hover:bg-[#eba14c] hover:text-[#15232c]"
                // onClick={
                //   AGENT_FEATURE_ENABLED
                //     ? openAgentPanel
                //     : () => notifyUpcomingFeature("Beeblio AI")
                // } 
                onClick={openAgentPanel}
                aria-label="Open Beeblio AI"
              >
                <img src="/beeblio-mark.svg" alt="" className="size-5 rounded-md" />
                <span className="font-semibold">Beeblio AI</span>
              </Button>
            ) : null}
          </div>

          <div ref={editorAreaRef} className={cn("min-h-0 flex-1 bg-card", attentionTabPath === activeFilePath && "editor-attention")} onSelect={captureTextControlSelection}>
            {activeFile ? (
              <FileViewer projectId={projectId} file={activeFile} instanceKey={activeFileKey} />
            ) : (
              <div className="flex h-full items-center justify-center bg-background p-8">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border bg-card text-muted-foreground"><FolderOpen className="size-5" /></div>
                  <h1 className="text-base font-semibold">Open a File to Begin</h1>
                  <p className="mt-1 text-sm text-muted-foreground">Choose a File from the File Explorer.</p>
                  {!(navigationOpen && activity === "files") ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-4"
                      onClick={() => {
                        rememberRailActivity(projectId, "files");
                        setActivity("files");
                        setNavigationOpen(true);
                      }}
                    >
                      <Files /> Browse Files
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <footer className="flex h-6 shrink-0 items-center justify-between border-t bg-sidebar px-2 text-[10px] text-muted-foreground">
            <span className="truncate">
              {activeFile
                ? isUntitledDraftPath(activeFile.path)
                  ? untitledDraftTabLabel(activeFile.path)
                  : activeFile.path
                : projectName}
            </span>
            <span>
              {activeFile
                ? isUntitledDraftPath(activeFile.path) ? "Unsaved" : "Workspace File"
                : "Ready"}
            </span>
          </footer>
        </main>

        {isMobile && (agentOpen || reviewOpen) ? (
          <button
            className="fixed inset-0 z-[55] bg-black/20"
            aria-label="Close AI panel"
            onClick={() => { setAgentOpen(false); setReviewOpen(false); }}
          />
        ) : null}
        <aside
          className={cn(
            "flex shrink-0 flex-col overflow-hidden bg-card",
            isMobile
              ? "fixed right-0 bottom-0 left-0 z-[60] rounded-t-2xl border border-b-0 shadow-2xl transition-transform duration-300 ease-out"
              : cn(
                "z-40 border-l transition-[width,transform] duration-200",
                agentOpen || reviewOpen ? "w-[380px]" : "w-0 border-l-0",
              ),
            isMobile && !agentOpen && !reviewOpen && "translate-y-[calc(100%+1rem)]",
          )}
          style={
            isMobile
              ? { height: mobileAgentHeight || "72dvh", maxHeight: "calc(100dvh - 1rem)" }
              : undefined
          }
        >
          {isMobile ? (
            <div
              role="separator"
              aria-label="Resize right panel"
              aria-orientation="horizontal"
              aria-valuenow={mobileAgentHeight || undefined}
              tabIndex={0}
              className="flex h-5 shrink-0 touch-none cursor-ns-resize items-center justify-center"
              onPointerDown={startAgentSheetResize}
              onPointerMove={moveAgentSheetResize}
              onPointerUp={stopAgentSheetResize}
              onPointerCancel={stopAgentSheetResize}
              onKeyDown={resizeAgentSheetWithKeyboard}
            >
              <span className="h-1 w-10 rounded-full bg-muted-foreground/35" />
            </div>
          ) : null}
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <div className="flex min-w-0 flex-1 items-center gap-2.5" aria-label={reviewOpen ? "Document review" : "Beeblio AI"}>
              {reviewOpen ? <span className="flex size-8 items-center justify-center rounded-lg bg-primary/8 text-primary"><ShieldCheck className="size-4.5" /></span> : <img src="/beeblio-mark.svg" alt="" className="size-7" />}
              <span className="text-sm font-semibold tracking-[-0.02em]">{reviewOpen ? "Document Review" : "Beeblio AI"}</span>
            </div>
            <Button size="icon-sm" variant="ghost"
              // onClick={
              //   AGENT_FEATURE_ENABLED
              //     ? () => {
              //         setAgentOpen(false);
              //         setReviewOpen(false);
              //       }
              //     : () => notifyUpcomingFeature()
              // } 
              onClick={() => {
                  setAgentOpen(false);
                  setReviewOpen(false);
                }}
              aria-label="Hide right panel">
              {isMobile ? <ChevronDown /> : <ChevronRight />}
            </Button>
          </div>
          {!reviewOpen ? (
            <ChatHistory
              projectId={projectId}
              initialSessions={initialSessions}
              open={conversationHistoryOpen}
              query={conversationQuery}
              newConversationHref={newConversationHref}
              onOpenChange={setConversationHistoryOpen}
              onQueryChange={setConversationQuery}
              onSelectConversation={openConversation}
              onDeleteConversation={handleConversationDeleted}
              onNewConversation={openNewConversation}
            />
          ) : null}
          <div className="min-h-0 flex-1">
            {reviewOpen ? (
              <DocumentReviewPanel
                projectId={projectId}
                filePath={activeFile?.path}
                content={activeFile ? getCurrentContent() : null}
              />
            ) : pendingConversationPath ? <ConversationLoading /> : children}
          </div>
        </aside>
      </div>
      <Dialog
        open={newCustomOpen}
        onOpenChange={(open) => {
          if (!open && newCustomPending) return;
          setNewCustomOpen(open);
          if (!open) {
            setNewCustomName("");
            setNewCustomError(undefined);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Custom File</DialogTitle>
            <DialogDescription>Choose a text-editable file type. The file will be created in the project root.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(event) => {
            event.preventDefault();
            void createCustomFile();
          }}>
            <FileNameInput
              value={newCustomName}
              onChange={(value) => {
                setNewCustomName(value);
                setNewCustomError(undefined);
              }}
              extension={`.${newCustomExtension}`}
              ariaLabel="File name"
              placeholder="File name"
              autoFocus
              disabled={newCustomPending}
            />
            <Select value={newCustomExtension} onValueChange={(value) => setNewCustomExtension(value as CustomFileExtension)} disabled={newCustomPending}>
              <SelectTrigger className="w-full" aria-label="File type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {customFileTypes.map((type) => <SelectItem key={type.extension} value={type.extension}>{type.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {newCustomError ? <p className="text-sm text-destructive">{newCustomError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={newCustomPending} onClick={() => {
                setNewCustomOpen(false);
                setNewCustomName("");
                setNewCustomError(undefined);
              }}>Cancel</Button>
              <Button type="submit" disabled={newCustomPending || !newCustomName.trim()}>
                {newCustomPending ? <Loader2 className="animate-spin" /> : null}
                Create File
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={newArtifactKind !== undefined}
        onOpenChange={(open) => {
          if (open || newArtifactPending) return;
          setNewArtifactKind(undefined);
          setNewArtifactName("");
          setNewArtifactError(undefined);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New {newArtifactKind === "form" ? "Survey Form" : "Literature Matrix"}</DialogTitle>
            <DialogDescription>
              {newArtifactKind === "form"
                ? `Create a form in ${FORMS_DIRECTORY}.`
                : `Create a comparison table in ${ANALYSIS_DIRECTORY}.`}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createArtifact();
            }}
          >
            <Input
              value={newArtifactName}
              onChange={(event) => setNewArtifactName(event.target.value)}
              placeholder={newArtifactKind === "form" ? "e.g. Course Evaluation" : "e.g. Systematic review screening"}
              aria-label={newArtifactKind === "form" ? "Form name" : "Matrix name"}
              autoFocus
              disabled={newArtifactPending}
            />
            {newArtifactError ? <p className="text-sm text-destructive">{newArtifactError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => {
                setNewArtifactKind(undefined);
                setNewArtifactName("");
                setNewArtifactError(undefined);
              }} disabled={newArtifactPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={newArtifactPending || !newArtifactName.trim()}>
                {newArtifactPending ? <Loader2 className="animate-spin" /> : null}
                Create {newArtifactKind === "form" ? "Form" : "Matrix"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={saveAs !== undefined}
        onOpenChange={(open) => {
          if (!open && !saveAsSaving) closeSaveAsDialog(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save File</DialogTitle>
            <DialogDescription>
              Name this file. It will be saved in the File Explorer.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirmSaveAs();
            }}
            className="flex flex-col gap-3"
          >
            <FileNameInput
              value={saveAsName}
              onChange={(next) => {
                setSaveAsName(next);
                setSaveAsError(undefined);
              }}
              extension={saveAs?.kind === "excalidraw" ? ".excalidraw" : ".md"}
              placeholder="Untitled-1"
              ariaLabel="File name"
              autoFocus
              disabled={saveAsSaving}
            />
            {saveAsError ? <p className="text-xs text-amber-600 dark:text-amber-400">{saveAsError}</p> : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => closeSaveAsDialog(false)}
                disabled={saveAsSaving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saveAsSaving || !saveAsName.trim()}>
                {saveAsSaving ? <Loader2 className="animate-spin" /> : null}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={closeTabAttempt !== undefined}
        onOpenChange={(open) => {
          if (!open) setCloseTabAttempt(undefined);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              Do you want to save the changes you made to this file?
              Your changes will be lost if you don&apos;t save them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row sm:justify-end gap-2">
            {/* <Button
              type="button"
              variant="ghost"
              onClick={() => setCloseTabAttempt(undefined)}
            >
              Cancel
            </Button> */}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const path = closeTabAttempt;
                setCloseTabAttempt(undefined);
                if (path) {
                  discardDirtyTab(path);
                  closeFileForce(path);
                }
              }}
            >
              Discard
            </Button>
            <Button
              type="button"
              onClick={async () => {
                if (!closeTabAttempt) return;
                const path = closeTabAttempt;
                setCloseTabAttempt(undefined);
                const saved = await saveDirtyTab(path);
                if (saved) closeFileForce(path);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <QuickOpenDialog
        projectId={projectId}
        open={quickOpen}
        onOpenChange={setQuickOpen}
        seedFiles={quickOpenSeedFiles}
        openFiles={openFiles}
        activeFilePath={activeFilePath}
        onOpenFile={openFile}
        onOpenFileWithCue={openFileWithCue}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </WorkspaceContext.Provider>
    </MatrixTargetsProvider>
  );
}

function NavigationContent({
  activity,
  projectId,
  projectName,
  initialFiles,
  initialRootTreeChildren,
  initialAllFiles,
  initialKnowledgeDocuments,
  initialSkills,
  activeFilePath,
  onOpenFile,
  onOpenFileWithCue,
  literatureSearchRequest,
  onLiteratureSearchConsumed,
  folderRevealRequest,
  onFolderRevealConsumed,
}: {
  activity: Activity;
  projectId: string;
  projectName: string;
  initialFiles: FileEntry[];
  initialRootTreeChildren: Record<string, FileEntry[]>;
  initialAllFiles?: FileEntry[];
  initialKnowledgeDocuments?: KnowledgeDocumentDTO[];
  initialSkills?: SkillSummary[];
  activeFilePath?: string;
  onOpenFile: (file: FileEntry, pinned?: boolean) => void;
  onOpenFileWithCue: (file: FileEntry) => void;
  literatureSearchRequest?: { query: string } | null;
  onLiteratureSearchConsumed?: () => void;
  folderRevealRequest?: { path: string } | null;
  onFolderRevealConsumed?: () => void;
}) {
  if (activity === "files") {
    return <FileExplorer projectId={projectId} initialFiles={initialFiles} initialRootTreeChildren={initialRootTreeChildren} activeFilePath={activeFilePath} onOpenFile={onOpenFile} revealFolderRequest={folderRevealRequest} onRevealFolderConsumed={onFolderRevealConsumed} />;
  }

  if (activity === "literature") {
    return (
      <LiteraturePanel
        projectId={projectId}
        initialFiles={initialFiles}
        initialRootTreeChildren={initialRootTreeChildren}
        initialAllFiles={initialAllFiles}
        activeFilePath={activeFilePath}
        onOpenFile={onOpenFile}
        onOpenFileWithCue={onOpenFileWithCue}
        searchRequest={literatureSearchRequest}
        onSearchRequestConsumed={onLiteratureSearchConsumed}
      />
    );
  }

  if (activity === "knowledge") {
    return <KnowledgePanel projectId={projectId} initialDocuments={initialKnowledgeDocuments} initialFiles={initialAllFiles} onOpenFile={onOpenFile} />;
  }

  if (activity === "skills") {
    return <SkillsPanel initialSkills={initialSkills} />;
  }

  if (["data", "analysis", "reports", "figures"].includes(activity)) {
    return (
      <ResearchArtifactBrowser
        view={activity as ResearchArtifactView}
        projectId={projectId}
        initialFiles={initialFiles}
        initialRootTreeChildren={initialRootTreeChildren}
        initialAllFiles={initialAllFiles}
        activeFilePath={activeFilePath}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div className="p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Project</p>
      <h2 className="mt-2 text-sm font-semibold">{projectName}</h2>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{projectId}</p>
    </div>
  );
}

function FileTabIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase();
  return <span className="w-4 shrink-0 text-[9px] font-semibold uppercase text-primary">{ext?.slice(0, 3) || "file"}</span>;
}
