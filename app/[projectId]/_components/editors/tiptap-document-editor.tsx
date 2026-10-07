"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Mathematics } from "@tiptap/extension-mathematics";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { Markdown } from "@tiptap/markdown";
import { DOMSerializer, type Node as ProsemirrorNode } from "@tiptap/pm/model";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { toast } from "sonner";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  DOCUMENT_REVIEW_ANCHOR_EVENT,
  type DocumentReviewAnchorDetail,
} from "@/lib/document-review";
import { citationKeys, formatCitation, formatCitationGroup, type CitationReference, type CitationStyle } from "@/lib/citations";
import { parseBibtexEntries, type BibtexEntry } from "@/lib/bibtex";
import {
  DEFAULT_DOCUMENT_SETTINGS,
  documentFontFamilyCss,
  type CompletionSettings,
  type DocumentDefaultSettings,
} from "@/lib/project-settings";
import { OPEN_LITERATURE_SEARCH_EVENT, type LiteratureItem, type OpenLiteratureSearchDetail } from "@/lib/literature/types";
import { OPEN_WORKSPACE_FILE_EVENT, type OpenWorkspaceFileDetail } from "@/lib/chat-context";
import { BIBLIOGRAPHY_MARKER, joinBibliographyMetadata, normalizeEscapedCitations, splitBibliographyMetadata } from "@/lib/markdown-bibliography";
import { ensureBlankLineAfterTables } from "@/lib/markdown-repair";
import { PROJECT_BIBLIOGRAPHY_PATH } from "@/lib/project-bibliography";
import { announceWorkspaceChange, WORKSPACE_CHANGED_EVENT, type WorkspaceChangedDetail } from "@/lib/workspace-change";
import { getWorkspaceDragPaths, WORKSPACE_PATHS_DRAG_TYPE } from "@/lib/workspace-drag";
import { usePublicView } from "@/app/share/[shareId]/_components/public-view-context";
import { getFileContent, listAllFiles, saveFile, type FileEntry } from "../../file-actions";
import { fetchLiteratureMetrics, saveLiteratureCitation, searchLiterature } from "../../literature-actions";
import { ReferenceSheet, type ReferenceDraft } from "../reference-sheet";
import { draftFromBibtexEntry, updateBibtexSourceWithDraft } from "../reference-bibtex";
import { useWorkspaceContext } from "../workspace-context";
import { AskBeeblio } from "./ask-beeblio";
import {
  SentenceSuggestionExtension,
  SentenceSuggestions,
  type ActiveSentenceSuggestion,
  type ProcessingSuggestion,
} from "./tiptap-sentence-suggestion";
import { writeCachedText } from "./text-content-cache";
import { readCachedBibliography, writeCachedBibliography } from "./bibliography-cache";
import {
  DocumentToolbar, EquationEditorDialog, FigureToolbar, GeneratedBibliography, ImagePickerDialog,
  LinkEditorDialog, MentionSearchMenu, TableBubbleMenu, type EquationDraft, type LinkDraft,
} from "./tiptap-editor-chrome";
import {
  resolveMarkdownImageSource,
  resolveShareImageSource,
  resolveWorkspaceAssetPath,
  workspacePathRelativeToDocument,
} from "./markdown-image-path";
import {
  CitationContext, CitationNode, DIAGRAM_EXTENSIONS, DiffAddition, DiffDeletion, Frontmatter, IMAGE_EXTENSIONS, ImportantCallout,
  MarkdownCodeBlock, MarkdownHeading, MarkdownParagraph, MarkdownSubscript, MarkdownSuperscript,
  MarkdownTextStyle, MentionSearchHighlight, documentSelectionAt, fileExtension, isVisualFile, workspaceImage,
} from "./tiptap-markdown-extensions";
import { errorDetail } from "@/lib/error-detail";

const LITERATURE_MENTION_RESULT_LIMIT = 5;

type DocumentMapHeading = {
  level: number;
  pos: number;
  text: string;
};

// GFM tables absorb any non-blank line after them as a row, and agent-written
// markdown is often tight (no blank line after tables). Repairing before the
// parse keeps prose paragraphs out of tables, both in the display and in the
// markdown the editor re-emits on the next user edit.
function splitBibliographyMetadataWithRepair(markdown: string) {
  const metadata = splitBibliographyMetadata(markdown);
  return { ...metadata, body: normalizeEscapedCitations(ensureBlankLineAfterTables(metadata.body).repaired) };
}

export function MarkdownTiptapEditor({
  projectId,
  filePath,
  markdown,
  onChange,
  editable = true,
  completion = null,
  documentDefaults = DEFAULT_DOCUMENT_SETTINGS,
}: {
  projectId: string;
  filePath: string;
  markdown: string;
  onChange: (markdown: string) => void;
  editable?: boolean;
  /** Project sentence-completion settings; null keeps suggestions off. */
  completion?: CompletionSettings | null;
  /** Project-level rendering defaults; inline/document settings still win. */
  documentDefaults?: DocumentDefaultSettings;
}) {
  const [initialMetadata] = useState(() => splitBibliographyMetadataWithRepair(markdown));
  const [mode, setMode] = useState<"visual" | "source">("visual");
  const [equationDraft, setEquationDraft] = useState<EquationDraft | null>(null);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const publicView = usePublicView();
  const bibliographyCacheKey = publicView.shareId ? `share:${publicView.shareId}` : `project:${projectId}`;
  const initialBibliography = useMemo(() => readCachedBibliography(bibliographyCacheKey), [bibliographyCacheKey]);
  const [references, setReferences] = useState<CitationReference[]>(() => initialBibliography?.references ?? []);
  const [referencesError, setReferencesError] = useState(false);
  const [referencesLoaded, setReferencesLoaded] = useState(Boolean(initialBibliography));
  const hasStoredCitationStyle = BIBLIOGRAPHY_MARKER.test(markdown);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>(
    hasStoredCitationStyle ? initialMetadata.style : documentDefaults.citationStyle,
  );
  const [bibliographyTitle, setBibliographyTitle] = useState(initialMetadata.title);
  const [bibliographyFont, setBibliographyFont] = useState(initialMetadata.font);
  const [citationOrder, setCitationOrder] = useState<string[]>([]);
  const [mentionSearch, setMentionSearch] = useState<{ query: string; from: number; to: number; left: number; top: number; mode: "mention" | "citation" } | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const [literatureMention, setLiteratureMention] = useState<{
    results: LiteratureItem[];
    searching: boolean;
    error?: string;
    searchedQuery: string | null;
    citingId?: string;
  }>({ results: [], searching: false, searchedQuery: null });
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[] | null>(null);
  const [workspaceFilesError, setWorkspaceFilesError] = useState(false);
  const [workspaceFigureDragOver, setWorkspaceFigureDragOver] = useState(false);
  const [editingReference, setEditingReference] = useState<BibtexEntry | null>(null);
  const [viewingReference, setViewingReference] = useState<BibtexEntry | null>(null);
  const [savingReference, setSavingReference] = useState(false);
  const onChangeRef = useRef(onChange);
  const editorRef = useRef<Editor | null>(null);
  const visualScrollerRef = useRef<HTMLDivElement | null>(null);
  // The editor instance must survive re-paths (untitled Save As, renames,
  // moves) with its content and undo history intact. TipTap recreates the
  // editor whenever the `extensions` deps change, and the editorProps handlers
  // are captured once at creation — so everything passed into `useEditor` must
  // resolve the document path through this ref instead of the render-time
  // `filePath` prop.
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const resolveImageSrc = (source: string) =>
    publicView.shareId
      ? resolveShareImageSource(publicView.shareId, filePathRef.current, source)
      : resolveMarkdownImageSource(projectId, filePathRef.current, source);
  // Markdown links that reference another workspace file (for example
  // ../2-Data/survey.csv) are document-relative: resolved against the page URL
  // they lose the project segment, so they are opened through the workspace
  // (in-page tab, or the project's ?file= link in a new tab) instead of the
  // browser. Returns the workspace-root-relative path, or null for web URLs,
  // anchors like "#section", and public share views.
  const workspaceFileLinkPath = (href: string) => {
    if (publicView.shareId) return null;
    if (!href.split(/[?#]/, 1)[0]) return null;
    const resolved = resolveWorkspaceAssetPath(filePathRef.current, href);
    return resolved ? resolved.path : null;
  };
  const workspaceFileLinkHref = (path: string) =>
    `${window.location.pathname}?file=${encodeURIComponent(path)}`;
  const lastEmittedMarkdownRef = useRef(markdown);
  const bodyMarkdownRef = useRef(initialMetadata.body);
  const citationOrderRef = useRef<string[]>([]);
  const mentionSearchRef = useRef(mentionSearch);
  // The @-run start the user escaped from, so typing on does not reopen the
  // menu until the caret leaves and returns to it.
  const mentionDismissedFromRef = useRef<number | null>(null);
  const slashDismissedFromRef = useRef<number | null>(null);
  const citationResultsRef = useRef<CitationReference[]>([]);
  const fileResultsRef = useRef<FileEntry[]>([]);
  const literatureMentionRef = useRef(literatureMention);
  const literatureMentionOptionsRef = useRef({ enabled: false, items: [] as LiteratureItem[], showingResults: false });
  const activeMentionRef = useRef(activeMention);
  const bibliographyTitleRef = useRef(bibliographyTitle);
  const citationStyleRef = useRef(citationStyle);
  const hasIndividualCitationStyleRef = useRef(hasStoredCitationStyle);
  const bibliographyFontRef = useRef(bibliographyFont);
  // Jenni-style sentence suggestions: the extension reads the active ghost
  // through a ref (options stay stable across renders), while the controller
  // component registers the accept/dismiss handlers.
  const activeSuggestionRef = useRef<ActiveSentenceSuggestion | null>(null);
  const processingSuggestionRef = useRef<ProcessingSuggestion>(null);
  const acceptSuggestionRef = useRef<() => void>(() => {});
  const dismissSuggestionRef = useRef<() => void>(() => {});
  onChangeRef.current = onChange;
  mentionSearchRef.current = mentionSearch;
  activeMentionRef.current = activeMention;
  bibliographyTitleRef.current = bibliographyTitle;
  citationStyleRef.current = citationStyle;
  bibliographyFontRef.current = bibliographyFont;

  // The request id keeps a stale fetch (e.g. started before the project
  // changed, or the pre-save copy) from clobbering a newer result.
  const referencesRequestId = useRef(0);
  // The raw references.bib text behind `references`, so the citation popover's
  // edit flow can locate and rewrite the entry the user clicked.
  const bibliographySourceRef = useRef<string | null>(initialBibliography?.source ?? null);
  const loadReferences = useCallback(() => {
    const request = ++referencesRequestId.current;
    // The share endpoint returns only entries cited by this document.
    const sourcePromise = publicView.shareId
      ? fetch(`/api/share/${encodeURIComponent(publicView.shareId)}/${PROJECT_BIBLIOGRAPHY_PATH}`, { cache: "no-store" })
          .then((response) => {
            if (!response.ok) throw new Error("Unable to load shared bibliography");
            return response.text();
          })
      : getFileContent(projectId, PROJECT_BIBLIOGRAPHY_PATH).then((source) => {
          if (source === null) throw new Error("Unable to load bibliography");
          return source;
        });
    return sourcePromise
      .then((source) => {
        if (request !== referencesRequestId.current) return;
        bibliographySourceRef.current = source;
        setReferences(writeCachedBibliography(bibliographyCacheKey, source).references);
        setReferencesError(false);
        setReferencesLoaded(true);
      })
      .catch(() => {
        if (request !== referencesRequestId.current) return;
        // Keep the last good bibliography visible when revalidation fails.
        setReferencesError(true);
        setReferencesLoaded(bibliographySourceRef.current !== null);
      });
  }, [projectId, bibliographyCacheKey, publicView.shareId]);

  useEffect(() => {
    const cached = readCachedBibliography(bibliographyCacheKey);
    bibliographySourceRef.current = cached?.source ?? null;
    setReferences(cached?.references ?? []);
    setReferencesLoaded(Boolean(cached));
    setReferencesError(false);
    void loadReferences();
    return () => { referencesRequestId.current += 1; };
  }, [bibliographyCacheKey, loadReferences]);

  // The bibliography renders inside this editor but lives in a different
  // file, so the agent (or any external writer) can change it while the
  // document stays mounted. A workspace tool writing references.bib emits a
  // per-file reload event; the turn-end workspace-changed event is the
  // catch-all for writes that emit no reload (e.g. bash appends). Refreshing
  // only swaps the references state — citations and the bibliography section
  // re-render from it — so unsaved document edits are untouched.
  useEffect(() => {
    if (publicView.shareId) return;
    const reloadBibliography = (event: Event) => {
      if (event.type === "beeblio:reload-workspace-file") {
        const detail = (event as CustomEvent<{ path?: string }>).detail;
        if (detail?.path !== PROJECT_BIBLIOGRAPHY_PATH) return;
      } else {
        const files = (event as CustomEvent<WorkspaceChangedDetail>).detail?.files;
        const changed = files?.find((file) => file.path === PROJECT_BIBLIOGRAPHY_PATH);
        if (changed) {
          referencesRequestId.current += 1;
          const cached = writeCachedBibliography(bibliographyCacheKey, changed.content);
          bibliographySourceRef.current = cached.source;
          setReferences(cached.references);
          setReferencesError(false);
          setReferencesLoaded(true);
          return;
        }
        if (files?.length) return;
      }
      void loadReferences();
    };
    window.addEventListener("beeblio:reload-workspace-file", reloadBibliography);
    window.addEventListener(WORKSPACE_CHANGED_EVENT, reloadBibliography);
    return () => {
      window.removeEventListener("beeblio:reload-workspace-file", reloadBibliography);
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, reloadBibliography);
    };
  }, [bibliographyCacheKey, loadReferences, publicView.shareId]);

  const referenceMap = useMemo(() => new Map(references.map((reference) => [reference.id, reference])), [references]);
  const referenceMapRef = useRef(referenceMap);
  referenceMapRef.current = referenceMap;
  const citationResults = useMemo(() => {
    const query = mentionSearch?.query.trim().toLowerCase() || "";
    return references.filter((reference) => !query || [reference.id, reference.title, reference.authors, reference.year].some((value) => value.toLowerCase().includes(query))).slice(0, 8);
  }, [mentionSearch?.query, references]);
  citationResultsRef.current = citationResults;

  const openReferenceEditor = (id: string) => {
    const source = bibliographySourceRef.current;
    if (source === null) return;
    const entry = parseBibtexEntries(source).find((candidate) => candidate.key === id);
    if (entry) setEditingReference(entry);
  };

  const openReferenceViewer = (id: string) => {
    const source = bibliographySourceRef.current;
    if (source === null) return;
    const entry = parseBibtexEntries(source).find((candidate) => candidate.key === id);
    if (entry) setViewingReference(entry);
  };

  // Renaming a citation key in references.bib would orphan every [@key] in the
  // document, so the cited nodes are moved to the new key in the same save.
  const renameCitationsInDocument = (fromKey: string, toKey: string) => {
    const current = editorRef.current;
    if (!current || current.isDestroyed) return;
    const { state } = current;
    const tr = state.tr;
    let changed = false;
    state.doc.descendants((node, pos) => {
      if (node.type.name === "citation" && citationKeys(String(node.attrs.id || "")).includes(fromKey)) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: citationKeys(String(node.attrs.id || "")).map((id) => id === fromKey ? toKey : id).join("; @") });
        changed = true;
      }
    });
    if (!changed) return;
    try {
      // The dispatch runs the normal onUpdate pipeline, which re-emits markdown.
      current.view.dispatch(tr);
    } catch {
      // The visual editor's view can be gone (source mode); the bibliography
      // is already saved, so the document simply keeps the old citation key.
    }
  };

  const saveReferenceDraft = async (draft: ReferenceDraft) => {
    const entry = editingReference;
    const source = bibliographySourceRef.current;
    if (!entry || source === null) return false;
    if (!draft.key.trim() || !draft.type.trim()) {
      toast.error("Citation key and type are required.");
      return false;
    }
    if (draft.key !== entry.key && parseBibtexEntries(source).some((candidate) => candidate.key === draft.key)) {
      toast.error("That citation key is already in use.");
      return false;
    }
    setSavingReference(true);
    try {
      const next = updateBibtexSourceWithDraft(source, entry, draft);
      await saveFile(projectId, PROJECT_BIBLIOGRAPHY_PATH, next);
      writeCachedText(PROJECT_BIBLIOGRAPHY_PATH, next);
      bibliographySourceRef.current = next;
      if (draft.key !== entry.key) renameCitationsInDocument(entry.key, draft.key);
      await loadReferences();
      setEditingReference(null);
      setViewingReference(null);
      announceWorkspaceChange([{ path: PROJECT_BIBLIOGRAPHY_PATH, content: next }]);
      toast.success("Reference saved", { description: `Updated ${draft.key} in ${PROJECT_BIBLIOGRAPHY_PATH}.` });
      return true;
    } catch (error) {
      toast.error("Could not save the reference", { description: errorDetail(error) });
      return false;
    } finally {
      setSavingReference(false);
    }
  };

  // Accepted sentence suggestions may cite entries from a library file other
  // than references.bib; those entries are copied into references.bib so the
  // document's citations and bibliography resolve.
  const appendCatalogEntries = async (entries: Array<{ key: string; bibtex: string }>) => {
    let source = bibliographySourceRef.current;
    if (source === null) {
      await loadReferences();
      source = bibliographySourceRef.current;
      if (source === null) throw new Error("The bibliography could not be loaded.");
    }
    const existing = new Set(parseBibtexEntries(source).map((entry) => entry.key));
    const additions = entries
      .map((entry) => entry.bibtex.trim())
      .filter((bibtex, index) => {
        const key = parseBibtexEntries(bibtex)[0]?.key ?? entries[index].key;
        return key ? !existing.has(key) : false;
      });
    if (!additions.length) return;
    const separator = source.length > 0 && !source.endsWith("\n\n")
      ? source.endsWith("\n") ? "\n" : "\n\n"
      : "";
    const next = `${source}${separator}${additions.join("\n\n")}\n`;
    await saveFile(projectId, PROJECT_BIBLIOGRAPHY_PATH, next);
    writeCachedText(PROJECT_BIBLIOGRAPHY_PATH, next);
    bibliographySourceRef.current = next;
    await loadReferences();
    window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
  };

  // File embeds for the "@" menu: fetched the first time the menu opens and
  // re-fetched on every reopen so newly uploaded figures appear. Previously
  // fetched entries stay visible while a reopen refresh is in flight. Skipped
  // on public share views, where the listing endpoint would redirect to login.
  const mentionOpen = mentionSearch !== null;
  useEffect(() => {
    if (!mentionOpen || mentionSearch?.mode === "citation" || publicView.shareId) return;
    let cancelled = false;
    listAllFiles(projectId)
      .then((entries) => { if (!cancelled) { setWorkspaceFiles(entries); setWorkspaceFilesError(false); } })
      .catch(() => { if (!cancelled) { setWorkspaceFiles((current) => current ?? []); setWorkspaceFilesError(true); } });
    return () => { cancelled = true; };
  }, [mentionOpen, mentionSearch?.mode, projectId, publicView.shareId]);

  const fileResults = useMemo(() => {
    const query = mentionSearch?.query.trim().toLowerCase() || "";
    const embeddable = (workspaceFiles ?? [])
      .filter((entry) => !entry.isDir && isVisualFile(entry))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return embeddable
      .filter((entry) => !query || entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query))
      .slice(0, 8);
  }, [mentionSearch?.query, workspaceFiles]);
  fileResultsRef.current = fileResults;

  // Live literature search tier of the "@" menu. It only renders once the
  // query is long enough for the search action (min 2 chars) and never on
  // public share views; results are shown solely for the query that fetched
  // them, so continuing to type falls back to the action row alone.
  const trimmedMentionQuery = mentionSearch?.query.trim() ?? "";
  const literatureMentionEnabled = trimmedMentionQuery.length >= 2 && !publicView.shareId;
  const literatureMentionMatchesQuery = literatureMention.searchedQuery === trimmedMentionQuery;
  const literatureMentionItems = useMemo(() => (
    literatureMentionEnabled && literatureMentionMatchesQuery
      ? literatureMention.results.slice(0, LITERATURE_MENTION_RESULT_LIMIT)
      : []
  ), [literatureMentionEnabled, literatureMentionMatchesQuery, literatureMention.results]);
  literatureMentionRef.current = literatureMention;
  literatureMentionOptionsRef.current = {
    enabled: literatureMentionEnabled,
    items: literatureMentionItems,
    // A completed, successful search for the current query swaps the section
    // from its "Search Literature" action form to its "Literature Matching"
    // results form (results, or the empty state — never the action row).
    showingResults: literatureMentionEnabled && literatureMentionMatchesQuery &&
      !literatureMention.searching && !literatureMention.error,
  };

  const emitMarkdown = (body = bodyMarkdownRef.current, title = bibliographyTitle, style = citationStyle, ids = citationOrderRef.current, font = bibliographyFontRef.current) => {
    bodyMarkdownRef.current = body;
    const nextMarkdown = joinBibliographyMetadata(body, title, style, ids.length > 0, font);
    lastEmittedMarkdownRef.current = nextMarkdown;
    onChangeRef.current(nextMarkdown);
  };

  // The mention query may span several words (literature searches like
  // "@use of ai in higher education", file names like "figure 1.png",
  // multi-word reference titles), so spaces — including a trailing space
  // mid-thought — keep the menu open; Escape or a character outside the query
  // alphabet (comma, parenthesis, …) dismisses it. Unicode letters count as
  // query characters because literature titles and author names are not
  // ASCII-only, and the query is optional so a bare "@" still opens the menu.
  const updateMentionSearch = (current: Editor) => {
    const { $from, empty } = current.state.selection;
    if (!empty || !$from.parent.isTextblock) { setMentionSearch(null); mentionDismissedFromRef.current = null; return; }
    const text = $from.parent.textBetween(0, $from.parentOffset, "\n", "\0");
    const match = /(?:^|\s)@((?:[\p{L}\p{N}_:.'’-]+(?:\s+[\p{L}\p{N}_:.'’-]+)*)?\s*)$/u.exec(text);
    if (!match) { setMentionSearch(null); mentionDismissedFromRef.current = null; return; }
    const query = match[1] ?? "";
    const from = current.state.selection.from - query.length - 1;
    if (mentionDismissedFromRef.current === from) { setMentionSearch(null); return; }
    const coordinates = current.view.coordsAtPos(current.state.selection.from);
    setMentionSearch({ query, from, to: current.state.selection.from, left: coordinates.left, top: coordinates.bottom + 6, mode: "mention" });
    setActiveMention(0);
  };

  const insertCitation = (reference: CitationReference) => {
    const search = mentionSearchRef.current;
    const current = editorRef.current;
    if (!current || !search) return;
    if (search.mode === "citation") {
      current.chain().focus().setTextSelection(search.to).insertContent([{ type: "text", text: " " }, { type: "citation", attrs: { id: reference.id } }]).run();
    } else {
      current.chain().focus().deleteRange({ from: search.from, to: search.to }).insertContent([{ type: "citation", attrs: { id: reference.id } }, { type: "text", text: " " }]).run();
    }
    setMentionSearch(null);
  };

  const insertFileMention = async (entry: FileEntry) => {
    const search = mentionSearchRef.current;
    const current = editorRef.current;
    if (!current || !search) return;
    setMentionSearch(null);
    if (IMAGE_EXTENSIONS.has(fileExtension(entry.path))) {
      const source = workspacePathRelativeToDocument(filePath, entry.path);
      current.chain().focus().deleteRange({ from: search.from, to: search.to }).insertContent({
        type: "image",
        attrs: {
          src: resolveImageSrc(source),
          markdownSource: source,
          alt: entry.name.replace(/\.[^.]+$/, ""),
        },
      }).run();
      return;
    }
    try {
      const source = await getFileContent(projectId, entry.path);
      if (source === null) throw new Error("Diagram file is empty or unreadable.");
      current.chain().focus().deleteRange({ from: search.from, to: search.to }).insertContent({
        type: "codeBlock",
        attrs: { language: "mermaid" },
        content: source ? [{ type: "text", text: source }] : [],
      }).run();
    } catch (error) {
      toast.error(`Unable to insert ${entry.name}`, {
        description: errorDetail(error),
      });
    }
  };
  const insertFileMentionRef = useRef(insertFileMention);
  insertFileMentionRef.current = insertFileMention;

  const runLiteratureMentionSearch = async () => {
    const search = mentionSearchRef.current;
    const query = search?.query.trim() ?? "";
    const current = literatureMentionRef.current;
    if (!search || query.length < 2 || publicView.shareId) return;
    if (current.searching || current.citingId) return;
    setLiteratureMention({ results: [], searching: true, searchedQuery: query });
    try {
      const response = await searchLiterature({ projectId, query, source: "all", openAccessOnly: false, page: 1 });
      // Drop responses that outlived their query: the menu may have closed or
      // the user kept typing while the providers answered.
      if (mentionSearchRef.current?.query.trim() !== query) return;
      setLiteratureMention({ results: response.items, searching: false, searchedQuery: query });
    } catch (error) {
      if (mentionSearchRef.current?.query.trim() !== query) return;
      setLiteratureMention({
        results: [],
        searching: false,
        searchedQuery: query,
        error: errorDetail(error, "Literature search failed."),
      });
    }
  };

  // A web result must exist in references.bib before it can be cited, so this
  // saves first, reloads the bibliography so the citation resolves inline, and
  // only then replaces the "@query" text with the citation node.
  const insertLiteratureCitation = async (item: LiteratureItem) => {
    const search = mentionSearchRef.current;
    const current = editorRef.current;
    if (!search || !current || literatureMentionRef.current.citingId) return;
    setLiteratureMention((state) => ({ ...state, citingId: item.id }));
    try {
      const result = await saveLiteratureCitation({ projectId, item });
      if (!result.success || !result.citationKey) {
        toast.error("Could not save the citation", { description: result.error });
        setLiteratureMention((state) => ({ ...state, citingId: undefined }));
        return;
      }
      await loadReferences();
      if (mentionSearchRef.current !== search) {
        // The mention moved while saving; inserting at the stale range would
        // eat unrelated text, so keep the saved reference and bail out.
        setLiteratureMention({ results: [], searching: false, searchedQuery: null });
        toast.success(result.alreadyExisted ? "Citation already in your library" : "Citation saved to your library", {
          description: "The text changed while saving, so nothing was inserted — cite it again with @.",
        });
        return;
      }
      if (search.mode === "citation") {
        current.chain().focus().setTextSelection(search.to).insertContent([{ type: "text", text: " " }, { type: "citation", attrs: { id: result.citationKey } }]).run();
      } else {
        current.chain().focus().deleteRange({ from: search.from, to: search.to }).insertContent([{ type: "citation", attrs: { id: result.citationKey } }, { type: "text", text: " " }]).run();
      }
      setMentionSearch(null);
      setLiteratureMention({ results: [], searching: false, searchedQuery: null });
      announceWorkspaceChange([{ path: PROJECT_BIBLIOGRAPHY_PATH, content: result.bibliographyContent }]);
      toast.success(result.alreadyExisted ? "Citation already in your library" : "Citation saved to your library", { description: result.citationPath });
    } catch (error) {
      toast.error("Could not insert the citation", { description: errorDetail(error) });
      setLiteratureMention((state) => ({ ...state, citingId: undefined }));
    }
  };

  const closeMentionSearch = useCallback(() => {
    if (mentionSearchRef.current) {
      mentionDismissedFromRef.current = mentionSearchRef.current.from;
      setMentionSearch(null);
      const current = editorRef.current;
      if (current && !current.isDestroyed) {
        current.view.dispatch(current.state.tr);
      }
    }
  }, []);

  const openLiteraturePanelForMention = () => {
    const query = mentionSearchRef.current?.query.trim() ?? "";
    mentionDismissedFromRef.current = mentionSearchRef.current?.from ?? null;
    setMentionSearch(null);
    const current = editorRef.current;
    if (current && !current.isDestroyed) {
      current.view.dispatch(current.state.tr);
    }
    if (query) window.dispatchEvent(new CustomEvent<OpenLiteratureSearchDetail>(OPEN_LITERATURE_SEARCH_EVENT, { detail: { query } }));
  };

  const runLiteratureMentionSearchRef = useRef(runLiteratureMentionSearch);
  runLiteratureMentionSearchRef.current = runLiteratureMentionSearch;
  const insertLiteratureCitationRef = useRef(insertLiteratureCitation);
  insertLiteratureCitationRef.current = insertLiteratureCitation;
  const openLiteraturePanelForMentionRef = useRef(openLiteraturePanelForMention);
  openLiteraturePanelForMentionRef.current = openLiteraturePanelForMention;

  const openLinkDialog = () => {
    const current = editorRef.current;
    if (!current) return;
    mentionDismissedFromRef.current = mentionSearchRef.current?.from ?? null;
    setMentionSearch(null);
    if (!current.isDestroyed) {
      current.view.dispatch(current.state.tr);
    }
    if (current.isActive("link")) {
      // Select the whole link so its text can be edited or replaced from the dialog.
      current.chain().extendMarkRange("link").run();
      const { from, to } = current.state.selection;
      setLinkDraft({ mode: "edit", href: String(current.getAttributes("link").href ?? ""), text: current.state.doc.textBetween(from, to, " ") });
    } else {
      const { from, to, empty } = current.state.selection;
      setLinkDraft({ mode: "create", href: "", text: empty ? "" : current.state.doc.textBetween(from, to, " ") });
    }
  };

  const saveLink = (href: string, text: string) => {
    const current = editorRef.current;
    if (!current || !linkDraft) return;
    const trimmedHref = href.trim();
    const trimmedText = text.trim();
    if (!trimmedHref) {
      current.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const chain = current.chain().focus();
    if (trimmedText && trimmedText !== linkDraft.text) {
      chain.insertContent({ type: "text", text: trimmedText, marks: [{ type: "link", attrs: { href: trimmedHref } }] }).run();
    } else if (!linkDraft.text) {
      chain.insertContent({ type: "text", text: trimmedHref, marks: [{ type: "link", attrs: { href: trimmedHref } }] }).run();
    } else {
      chain.setLink({ href: trimmedHref }).run();
    }
  };

  const removeLink = () => {
    editorRef.current?.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkDraft(null);
  };

  const insertImage = (source: string, alt: string) => {
    const current = editorRef.current;
    if (!current) return;
    const resolved = resolveImageSrc(source);
    current.chain().focus().insertContent({ type: "image", attrs: { src: resolved, markdownSource: source, alt } }).run();
  };

  const insertMermaid = (source: string) => {
    editorRef.current?.chain().focus().insertContent({
      type: "codeBlock",
      attrs: { language: "mermaid" },
      content: source ? [{ type: "text", text: source }] : [],
    }).run();
  };

  const insertDroppedWorkspaceFigure = async (path: string, position: number) => {
    const current = editorRef.current;
    if (!current) return;
    const extension = fileExtension(path);
    const alt = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";

    if (IMAGE_EXTENSIONS.has(extension)) {
      const source = workspacePathRelativeToDocument(filePathRef.current, path);
      current.chain().focus().insertContentAt(position, {
        type: "image",
        attrs: {
          src: resolveImageSrc(source),
          markdownSource: source,
          alt,
        },
      }).run();
      return;
    }

    if (DIAGRAM_EXTENSIONS.has(extension)) {
      try {
        const source = await getFileContent(projectId, path);
        if (source === null) throw new Error("Diagram file is empty or unreadable.");
        editorRef.current?.chain().focus().insertContentAt(position, {
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: source ? [{ type: "text", text: source }] : [],
        }).run();
      } catch (error) {
        toast.error(`Unable to insert ${path.split("/").at(-1) ?? "diagram"}`, {
          description: errorDetail(error),
        });
      }
    }
  };
  const extensions = useMemo(() => [
    StarterKit.configure({
      paragraph: false,
      heading: false,
      codeBlock: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    DiffAddition,
    DiffDeletion,
    MarkdownParagraph,
    MarkdownHeading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
    MarkdownCodeBlock,
    MarkdownTextStyle,
    MarkdownSubscript,
    MarkdownSuperscript,
    TextStyleKit.configure({ textStyle: false }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    workspaceImage(projectId, () => filePathRef.current, publicView.shareId),
    Mathematics.configure({
      inlineOptions: {
        onClick: (node, pos) => setEquationDraft({ kind: "inline", latex: String(node.attrs.latex ?? ""), pos }),
      },
      blockOptions: {
        onClick: (node, pos) => setEquationDraft({ kind: "block", latex: String(node.attrs.latex ?? ""), pos }),
      },
      katexOptions: { throwOnError: false, strict: false },
    }),
    Frontmatter,
    ImportantCallout,
    CitationNode,
    MentionSearchHighlight.configure({
      getDismissedFrom: () => mentionDismissedFromRef.current,
      getSlashDismissedFrom: () => slashDismissedFromRef.current,
      isEnabled: () => editable,
    }),
    SentenceSuggestionExtension.configure({
      getActive: () => activeSuggestionRef.current,
      getProcessing: () => processingSuggestionRef.current,
      onAccept: () => acceptSuggestionRef.current(),
      onDismiss: () => dismissSuggestionRef.current(),
    }),
    Placeholder.configure({ placeholder: "Start writing…" }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    // `filePath` is deliberately absent: TipTap rebuilds the editor when these
    // deps change, which would reset it to the mount-time content on a re-path
    // (untitled Save As, rename, move) and blank the user's document.
  ], [projectId, publicView.shareId, editable]);

  const editor = useEditor({
    extensions,
    content: initialMetadata.body,
    contentType: "markdown",
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => {
      const ids = citationIds(current);
      citationOrderRef.current = ids;
      setCitationOrder(ids);
      emitMarkdown(current.getMarkdown(), bibliographyTitleRef.current, citationStyleRef.current, ids);
      updateMentionSearch(current);
    },
    onSelectionUpdate: ({ editor: current }) => updateMentionSearch(current),
    editorProps: {
      attributes: { class: "beeblio-tiptap-page" },
      handleDOMEvents: {
        copy: (view, event) => {
          const clipboard = (event as ClipboardEvent).clipboardData;
          const { from, to } = view.state.selection;
          if (!clipboard || from === to) return false;
          let hasCitation = false;
          view.state.doc.nodesBetween(from, to, (node) => {
            if (node.type.name === "citation") hasCitation = true;
          });
          if (!hasCitation) return false;

          const display = (node: ProsemirrorNode) => {
            const id = String(node.attrs.id || "");
            const keys = citationKeys(id);
            if (keys.length > 1) return formatCitationGroup(keys, referenceMapRef.current, citationStyleRef.current, citationOrderRef.current);
            const reference = referenceMapRef.current.get(id);
            if (!reference) return `[@${id}]`;
            const index = citationOrderRef.current.indexOf(id);
            return formatCitation(reference, citationStyleRef.current, Math.max(1, index + 1), node.attrs.mode === "narrative" ? "narrative" : "default");
          };
          const slice = view.state.selection.content();
          const plain = slice.content.textBetween(0, slice.content.size, "\n", (node) =>
            node.type.name === "citation" ? display(node) : node.type.name === "hardBreak" ? "\n" : node.type.spec.leafText?.(node) || "",
          );
          const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content, { document: view.dom.ownerDocument });
          const container = view.dom.ownerDocument.createElement("div");
          container.appendChild(fragment);
          container.querySelectorAll<HTMLElement>("[data-citation-id]").forEach((element) => {
            const id = element.dataset.citationId || "";
            const node = view.state.schema.nodes.citation.create({ id, mode: element.dataset.citationMode || "default" });
            element.textContent = display(node);
          });
          clipboard.setData("text/plain", plain);
          clipboard.setData("text/html", container.innerHTML);
          event.preventDefault();
          return true;
        },
        dragover: (_view, event) => {
          if (!event.dataTransfer?.types.includes(WORKSPACE_PATHS_DRAG_TYPE)) return false;
          const hasFigure = getWorkspaceDragPaths(event.dataTransfer).some((candidate) =>
            IMAGE_EXTENSIONS.has(fileExtension(candidate)) || DIAGRAM_EXTENSIONS.has(fileExtension(candidate))
          );
          if (!hasFigure) return false;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setWorkspaceFigureDragOver(true);
          return true;
        },
        dragleave: (view, event) => {
          if (event.relatedTarget instanceof globalThis.Node && view.dom.contains(event.relatedTarget)) return false;
          setWorkspaceFigureDragOver(false);
          return false;
        },
        auxclick: (_view, event) => {
          // Middle-click opens the same new-tab target as Ctrl/Cmd + click;
          // the browser's default would resolve the document-relative href
          // without the project segment.
          if (event.button !== 1) return false;
          const anchor = event.target instanceof Element ? event.target.closest("a") : null;
          const href = anchor?.getAttribute("href");
          const workspacePath = href ? workspaceFileLinkPath(href) : null;
          if (!workspacePath) return false;
          event.preventDefault();
          window.open(workspaceFileLinkHref(workspacePath), "_blank", "noopener,noreferrer");
          return true;
        },
      },
      handleDrop: (view, event) => {
        if (!event.dataTransfer) return false;
        const paths = getWorkspaceDragPaths(event.dataTransfer);
        const path = paths.find((candidate) =>
          IMAGE_EXTENSIONS.has(fileExtension(candidate)) || DIAGRAM_EXTENSIONS.has(fileExtension(candidate))
        );
        if (!path) return false;
        const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!coordinates) return false;
        event.preventDefault();
        setWorkspaceFigureDragOver(false);
        void insertDroppedWorkspaceFigure(path, coordinates.pos);
        return true;
      },
      handleClick: (_view, _pos, event) => {
        if (event.button !== 0) return false;
        const anchor = event.target instanceof Element ? event.target.closest("a") : null;
        const href = anchor?.getAttribute("href");
        if (!href) return false;
        const workspacePath = workspaceFileLinkPath(href);
        if (event.metaKey || event.ctrlKey) {
          // Ctrl/Cmd + click opens it in a new tab.
          window.open(workspacePath ? workspaceFileLinkHref(workspacePath) : href, "_blank", "noopener,noreferrer");
          return true;
        }
        if (workspacePath) {
          // Plain click on a workspace file link opens it as a tab in this page.
          window.dispatchEvent(new CustomEvent<OpenWorkspaceFileDetail>(OPEN_WORKSPACE_FILE_EVENT, {
            detail: { name: workspacePath.split("/").at(-1) || workspacePath, path: workspacePath },
          }));
          return true;
        }
        // Plain click on any other link keeps the caret in it for editing.
        return false;
      },
      handleKeyDown: (view, event) => {
        if (event.key === "Backspace" || event.key === "Delete") {
          const selection = view.state.selection as typeof view.state.selection & {
            isColSelection?: () => boolean;
            isRowSelection?: () => boolean;
          };
          if (selection && typeof selection.isColSelection === "function" && selection.isColSelection()) {
            event.preventDefault();
            editorRef.current?.chain().focus().deleteColumn().run();
            return true;
          }
          if (selection && typeof selection.isRowSelection === "function" && selection.isRowSelection()) {
            event.preventDefault();
            editorRef.current?.chain().focus().deleteRow().run();
            return true;
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === "k") {
          event.preventDefault();
          openLinkDialog();
          return true;
        }
        const search = mentionSearchRef.current;
        if (!search) return false;
        const citations = citationResultsRef.current;
        const files = fileResultsRef.current;
        const literature = literatureMentionOptionsRef.current;
        const literatureActionIndex = literature.enabled && !literature.showingResults ? 0 : -1;
        const literatureItemsStart = 0;
        const literatureMoreIndex = literature.showingResults && literature.items.length > 0
          ? literature.items.length
          : -1;
        const literatureOptionCount = literature.enabled
          ? literature.showingResults
            ? literature.items.length + (literature.items.length > 0 ? 1 : 0)
            : 1
          : 0;
        const citationsStart = literatureOptionCount;
        const filesStart = citationsStart + citations.length;
        const lastIndex = filesStart + files.length - 1;
        if (event.key === "Escape") {
          // Back out of the literature results before closing the menu.
          if (literature.showingResults) {
            setLiteratureMention({ results: [], searching: false, searchedQuery: null });
            setActiveMention(0);
            return true;
          }
          mentionDismissedFromRef.current = search.from;
          setMentionSearch(null);
          view.dispatch(view.state.tr);
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (lastIndex < 0) return true;
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setActiveMention((value) => Math.max(0, Math.min(lastIndex, value + direction)));
          return true;
        }
        if (event.key === "Enter") {
          const active = activeMentionRef.current;
          if (active === literatureActionIndex) {
            void runLiteratureMentionSearchRef.current();
          } else if (literature.showingResults && active >= literatureItemsStart && active < literature.items.length) {
            const item = literature.items[active - literatureItemsStart];
            if (!item) return false;
            void insertLiteratureCitationRef.current(item);
          } else if (active === literatureMoreIndex) {
            openLiteraturePanelForMentionRef.current();
          } else if (active >= citationsStart && active < filesStart) {
            const citation = citations[active - citationsStart];
            if (citation) insertCitation(citation);
            else return false;
          } else if (active >= filesStart && active <= lastIndex) {
            const file = files[active - filesStart];
            if (!file) return false;
            void insertFileMentionRef.current(file);
          } else {
            return false;
          }
          return true;
        }
        return false;
      },
    },
  }, [extensions]);
  editorRef.current = editor;

  // Answers the layout's selection capture with source-faithful text from the
  // document model (markdown with [@key] citations) instead of the rendered
  // DOM. Positions come from the live DOM selection via posAtDOM rather than
  // editor.state.selection: document-level selectionchange listeners run in
  // registration order, so state may not have flushed yet when this is called.
  // The DOM-anchor check keeps selections made elsewhere (generated
  // bibliography, chat composer) from reading a stale editor selection.
  const selectionProviderId = useId();
  const { registerSelectionProvider, unregisterSelectionProvider } = useWorkspaceContext();
  useEffect(() => {
    if (!editor || publicView.shareId) return;
    registerSelectionProvider({
      id: selectionProviderId,
      path: filePath,
      getSelection: () => {
        if (mode !== "visual") return null;
        const dom = window.getSelection();
        const anchor = dom?.anchorNode;
        const focus = dom?.focusNode;
        if (!dom || !anchor || !focus) return null;
        if (!(editor.view.dom === anchor || editor.view.dom.contains(anchor))) return null;
        if (!(editor.view.dom === focus || editor.view.dom.contains(focus))) return null;
        try {
          const anchorPos = editor.view.posAtDOM(anchor, dom.anchorOffset);
          const focusPos = editor.view.posAtDOM(focus, dom.focusOffset);
          const from = Math.min(anchorPos, focusPos);
          const to = Math.max(anchorPos, focusPos);
          // Some browsers report a node selection over an inline widget from
          // inside the widget, which maps both endpoints onto the atom's start
          // position. Snap an expanded DOM selection back over the whole atom.
          if (from === to && !dom.isCollapsed) {
            const node = editor.state.doc.nodeAt(from);
            if (node && node.isLeaf && !node.isText) {
              return documentSelectionAt(editor, from, from + node.nodeSize);
            }
          }
          return documentSelectionAt(editor, from, to);
        } catch {
          return null;
        }
      },
    });
    return () => unregisterSelectionProvider(selectionProviderId);
  }, [editor, filePath, mode, publicView.shareId, registerSelectionProvider, selectionProviderId, unregisterSelectionProvider]);

  useEffect(() => {
    if (!editor) return;
    const ids = citationIds(editor);
    citationOrderRef.current = ids;
    setCitationOrder(ids);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    let clearHighlight: number | undefined;
    const revealReviewAnchor = (event: Event) => {
      const detail = (event as CustomEvent<DocumentReviewAnchorDetail>).detail;
      if (detail?.filePath !== filePath || !detail.quote) return;
      setMode("visual");
      window.setTimeout(() => {
        if (editor.isDestroyed) return;
        const needle = reviewAnchorText(detail.quote);
        const blocks = Array.from(editor.view.dom.children).filter((node): node is HTMLElement => node instanceof HTMLElement);
        const target = blocks.find((block) => reviewAnchorText(block.textContent ?? "").includes(needle));
        editor.view.dom.querySelectorAll(".beeblio-review-anchor").forEach((node) => node.classList.remove("beeblio-review-anchor"));
        if (!target || !needle) {
          toast.message("The reviewed passage could not be located in the current document.");
          return;
        }
        target.classList.add("beeblio-review-anchor");
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        window.clearTimeout(clearHighlight);
        clearHighlight = window.setTimeout(() => target.classList.remove("beeblio-review-anchor"), 3_000);
      }, 0);
    };
    window.addEventListener(DOCUMENT_REVIEW_ANCHOR_EVENT, revealReviewAnchor);
    return () => {
      window.removeEventListener(DOCUMENT_REVIEW_ANCHOR_EVENT, revealReviewAnchor);
      window.clearTimeout(clearHighlight);
    };
  }, [editor, filePath]);

  useEffect(() => {
    if (hasIndividualCitationStyleRef.current) return;
    setCitationStyle(documentDefaults.citationStyle);
  }, [documentDefaults.citationStyle]);

  // The parent changes `markdown` for both local edits and AI edits. Local
  // edits already live in Tiptap, so only replace its document when the value
  // did not originate from this editor. This keeps the editor shell, toolbar,
  // and selected editing mode mounted while the AI version arrives.
  // A recreated instance (useEditor rebuilds it when the extensions deps
  // change) starts from the mount-time content, so it is re-populated from the
  // live markdown even when that matches the last emitted value — otherwise
  // the recreation alone would blank the document.
  const syncedEditorRef = useRef<Editor | null>(null);
  useEffect(() => {
    if (!editor) return;
    const editorRecreated = syncedEditorRef.current !== editor;
    syncedEditorRef.current = editor;
    if (!editorRecreated && markdown === lastEmittedMarkdownRef.current) return;

    const metadata = splitBibliographyMetadataWithRepair(markdown);
    lastEmittedMarkdownRef.current = markdown;
    bodyMarkdownRef.current = metadata.body;
    setBibliographyTitle(metadata.title);
    if (BIBLIOGRAPHY_MARKER.test(markdown)) {
      hasIndividualCitationStyleRef.current = true;
      setCitationStyle(metadata.style);
    } else if (!hasIndividualCitationStyleRef.current) {
      setCitationStyle(documentDefaults.citationStyle);
    }
    setBibliographyFont(metadata.font);
    setMentionSearch(null);

    setTimeout(() => {
      editor.commands.setContent(metadata.body, { contentType: "markdown", emitUpdate: false });
      const ids = citationIds(editor);
      citationOrderRef.current = ids;
      setCitationOrder(ids);
    }, 0);
  }, [editor, markdown, documentDefaults.citationStyle]);

  const showVisualEditor = () => {
    const metadata = splitBibliographyMetadataWithRepair(markdown);
    bodyMarkdownRef.current = metadata.body;
    setBibliographyTitle(metadata.title);
    if (BIBLIOGRAPHY_MARKER.test(markdown)) {
      hasIndividualCitationStyleRef.current = true;
      setCitationStyle(metadata.style);
    } else if (!hasIndividualCitationStyleRef.current) {
      setCitationStyle(documentDefaults.citationStyle);
    }
    setBibliographyFont(metadata.font);

    setTimeout(() => {
      editor?.commands.setContent(metadata.body, { contentType: "markdown", emitUpdate: false });
      if (editor) {
        const ids = citationIds(editor);
        citationOrderRef.current = ids;
        setCitationOrder(ids);
      }
    }, 0);
    setMode("visual");
  };

  const updateSourceMarkdown = (value: string) => {
    lastEmittedMarkdownRef.current = value;
    onChangeRef.current(value);
  };

  return (
    <div className="beeblio-tiptap-editor flex h-full min-h-0 flex-col">
      {editable ? (
        <DocumentToolbar
          editor={editor}
          mode={mode}
          onModeChange={(next) => next === "visual" ? showVisualEditor() : setMode("source")}
          onRequestInsertImage={() => setImageDialogOpen(true)}
          onInsertEquation={(kind) => setEquationDraft({ kind, latex: "" })}
          onEditLink={openLinkDialog}
          citationStyle={citationStyle}
          onCitationStyleChange={(style) => { hasIndividualCitationStyleRef.current = true; setCitationStyle(style); emitMarkdown(bodyMarkdownRef.current, bibliographyTitle, style); }}
          showMarkdownMode
        />
      ) : null}
      {mode === "source" ? (
        <textarea
          value={markdown}
          onChange={(event) => updateSourceMarkdown(event.target.value)}
          spellCheck={false}
          aria-label="Markdown source"
          className="min-h-0 flex-1 resize-none bg-card p-4 font-mono text-[13px] leading-6 text-foreground outline-none sm:p-6"
        />
      ) : (
        <div className="relative min-h-0 flex-1 bg-muted/60">
          <div ref={visualScrollerRef} className="h-full overflow-auto px-1 py-2 sm:px-4 sm:py-6">
            <CitationContext.Provider value={{ references: referenceMap, style: citationStyle, order: citationOrder, loading: !referencesLoaded, onEditReference: publicView.shareId ? undefined : openReferenceEditor, onViewReference: publicView.shareId ? undefined : openReferenceViewer, fetchMetrics: publicView.shareId ? undefined : fetchLiteratureMetrics }}>
              <div
                className={cn(
                  "beeblio-tiptap-document-surface relative transition-[box-shadow]",
                  workspaceFigureDragOver && "ring-2 ring-primary ring-offset-2 ring-offset-muted",
                )}
                style={{
                  fontFamily: documentFontFamilyCss(documentDefaults.fontFamily),
                  fontSize: documentDefaults.fontSize || undefined,
                }}
              >
                {workspaceFigureDragOver ? (
                  <div className="pointer-events-none absolute inset-x-4 top-4 z-20 rounded-lg border border-primary/40 bg-background/95 px-3 py-2 text-center text-xs font-medium text-primary shadow-sm">
                    Drop to insert figure
                  </div>
                ) : null}
                <EditorContent editor={editor} />
                {citationOrder.length ? <GeneratedBibliography references={references} citationOrder={citationOrder} style={citationStyle} title={bibliographyTitle} font={bibliographyFont} defaultFont={{ family: documentDefaults.fontFamily, size: documentDefaults.fontSize }} loading={!referencesLoaded} onTitleChange={(title) => { setBibliographyTitle(title); emitMarkdown(bodyMarkdownRef.current, title); }} onFontChange={(font) => { setBibliographyFont(font); emitMarkdown(bodyMarkdownRef.current, bibliographyTitle, citationStyle, citationOrderRef.current, font); }} /> : null}
                {!publicView.shareId ? (
                  <AskBeeblio
                    editor={editor}
                    filePath={filePath}
                    disabled={mentionSearch !== null}
                    getSlashDismissedFrom={() => slashDismissedFromRef.current}
                    onSlashDismissedFromChange={(from) => { slashDismissedFromRef.current = from; }}
                    onRequestCitation={(selection) => {
                      setLiteratureMention({ results: [], searching: false, searchedQuery: null });
                      setActiveMention(0);
                      setMentionSearch({ ...selection, query: "", mode: "citation" });
                    }}
                  />
                ) : null}
              </div>
            </CitationContext.Provider>
          </div>
          {editor ? <DocumentMap editor={editor} scrollerRef={visualScrollerRef} /> : null}
        </div>
      )}
      {mentionSearch ? (
        <MentionSearchMenu
          projectId={projectId}
          search={mentionSearch}
          citations={citationResults}
          files={fileResults}
          literature={{
            enabled: literatureMentionEnabled,
            query: trimmedMentionQuery,
            items: literatureMentionItems,
            searching: literatureMention.searching,
            error: literatureMentionMatchesQuery ? literatureMention.error : undefined,
            searched: literatureMentionMatchesQuery && !literatureMention.searching,
            citingId: literatureMention.citingId,
          }}
          activeIndex={activeMention}
          citationsLoading={!referencesLoaded}
          citationsError={referencesError}
          filesLoading={workspaceFiles === null && !publicView.shareId}
          filesError={workspaceFilesError}
          onActiveIndexChange={setActiveMention}
          onSelectCitation={insertCitation}
          onSelectFile={(entry) => void insertFileMention(entry)}
          onRunLiteratureSearch={() => void runLiteratureMentionSearch()}
          onSelectLiterature={(item) => void insertLiteratureCitation(item)}
          onOpenLiteraturePanel={openLiteraturePanelForMention}
          citationOnly={mentionSearch.mode === "citation"}
          onQueryChange={(query) => {
            setMentionSearch((current) => current ? { ...current, query } : current);
            setLiteratureMention({ results: [], searching: false, searchedQuery: null });
            setActiveMention(0);
          }}
          onClose={closeMentionSearch}
        />
      ) : null}
      {mode === "visual" && editor ? <FigureToolbar editor={editor} /> : null}
      {mode === "visual" && editor ? <TableBubbleMenu editor={editor} /> : null}
      {editable && !publicView.shareId ? (
        <SentenceSuggestions
          editor={editor}
          projectId={projectId}
          enabled={mode === "visual" && !!completion?.enabled}
          disabled={mentionSearch !== null}
          style={citationStyle}
          settingsVersion={completion ? JSON.stringify(completion) : ""}
          referenceMap={referenceMap}
          citationOrder={citationOrder}
          onAddPendingReferences={(pending) => setReferences((current) => {
            const known = new Set(current.map((reference) => reference.id));
            return [...current, ...pending.filter((reference) => !known.has(reference.id))];
          })}
          onReferencesChanged={loadReferences}
          onSaveCatalogEntries={appendCatalogEntries}
          activeRef={activeSuggestionRef}
          processingRef={processingSuggestionRef}
          acceptRef={acceptSuggestionRef}
          dismissRef={dismissSuggestionRef}
        />
      ) : null}
      {linkDraft ? (
        <LinkEditorDialog
          key={`${linkDraft.mode}:${linkDraft.href}:${linkDraft.text}`}
          draft={linkDraft}
          onClose={() => setLinkDraft(null)}
          onRemove={linkDraft.mode === "edit" ? removeLink : undefined}
          onSave={(href, text) => {
            saveLink(href, text);
            setLinkDraft(null);
          }}
        />
      ) : null}
      {imageDialogOpen ? (
        <ImagePickerDialog
          projectId={projectId}
          filePath={filePath}
          onClose={() => setImageDialogOpen(false)}
          onInsertImage={(source, alt) => {
            insertImage(source, alt);
            setImageDialogOpen(false);
          }}
          onInsertMermaid={(source) => {
            insertMermaid(source);
            setImageDialogOpen(false);
          }}
        />
      ) : null}
      {equationDraft ? (
        <EquationEditorDialog
          projectId={projectId}
          key={`${equationDraft.kind}:${equationDraft.pos ?? "new"}:${equationDraft.latex}`}
          draft={equationDraft}
          canUseAi={!publicView.shareId}
          onClose={() => setEquationDraft(null)}
          onDelete={equationDraft.pos === undefined ? undefined : () => {
            if (equationDraft.kind === "block") editor?.commands.deleteBlockMath({ pos: equationDraft.pos });
            else editor?.commands.deleteInlineMath({ pos: equationDraft.pos });
            setEquationDraft(null);
          }}
          onSave={(latex) => {
            if (!editor) return;
            if (equationDraft.pos === undefined) {
              if (equationDraft.kind === "block") editor.chain().focus().insertBlockMath({ latex }).run();
              else editor.chain().focus().insertInlineMath({ latex }).run();
            } else if (equationDraft.kind === "block") {
              editor.chain().setNodeSelection(equationDraft.pos).updateBlockMath({ latex, pos: equationDraft.pos }).focus().run();
            } else {
              editor.chain().setNodeSelection(equationDraft.pos).updateInlineMath({ latex, pos: equationDraft.pos }).focus().run();
            }
            setEquationDraft(null);
          }}
        />
      ) : null}
      <ReferenceSheet
        open={Boolean(editingReference || viewingReference)}
        onOpenChange={(open) => {
          if (!open && !savingReference) {
            setEditingReference(null);
            setViewingReference(null);
          }
        }}
        mode={editingReference ? "edit" : "preview"}
        projectId={projectId}
        initialDraft={editingReference ? draftFromBibtexEntry(editingReference) : undefined}
        reference={viewingReference ? draftFromBibtexEntry(viewingReference) : undefined}
        requireKey
        saving={savingReference}
        onCancelEdit={() => setEditingReference(null)}
          onEdit={viewingReference && !publicView.shareId ? () => {
            setEditingReference(viewingReference);
          } : undefined}
        onSave={saveReferenceDraft}
      />
    </div>
  );
}

function reviewAnchorText(value: string) {
  return value
    .replace(/\[@[^\]]+\](?:\{[^}\n]+\})?/g, "")
    .replace(/[*_~`#>]+/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function DocumentMap({
  editor,
  scrollerRef,
}: {
  editor: Editor;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [headings, setHeadings] = useState<DocumentMapHeading[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);

  useEffect(() => {
    const updateHeadings = () => {
      const next: DocumentMapHeading[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "heading") return;
        next.push({
          level: Number(node.attrs.level) || 1,
          pos,
          text: node.textContent.trim() || "Untitled section",
        });
      });
      setHeadings(next);
    };

    updateHeadings();
    editor.on("transaction", updateHeadings);
    return () => {
      editor.off("transaction", updateHeadings);
    };
  }, [editor]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || headings.length === 0) {
      setActivePos(null);
      return;
    }

    const updateActiveHeading = () => {
      const readingLine = scroller.getBoundingClientRect().top + Math.min(160, scroller.clientHeight * 0.28);
      let current = headings[0]?.pos ?? null;
      for (const heading of headings) {
        const element = editor.view.nodeDOM(heading.pos);
        if (!(element instanceof HTMLElement)) continue;
        if (element.getBoundingClientRect().top <= readingLine) current = heading.pos;
        else break;
      }
      setActivePos(current);
    };

    updateActiveHeading();
    scroller.addEventListener("scroll", updateActiveHeading, { passive: true });
    window.addEventListener("resize", updateActiveHeading);
    return () => {
      scroller.removeEventListener("scroll", updateActiveHeading);
      window.removeEventListener("resize", updateActiveHeading);
    };
  }, [editor, headings, scrollerRef]);

  if (headings.length === 0) return null;

  const goToHeading = (heading: DocumentMapHeading) => {
    const element = editor.view.nodeDOM(heading.pos);
    if (!(element instanceof HTMLElement)) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => editor.commands.setTextSelection(heading.pos + 1), 350);
  };

  return (
    <nav
      aria-label="Document outline"
      className="group/map absolute left-0 top-1/2 z-30 hidden max-h-[80%] w-16 -translate-y-1/2 overflow-y-auto py-6 pl-3 lg:block"
    >
      <div className="flex w-10 flex-col items-start gap-0.5 transition-[gap] duration-200 ease-out group-hover/map:gap-1.5">
        {headings.map((heading) => {
          const active = heading.pos === activePos;
          const width = Math.max(9, 34 - (heading.level - 1) * 5);
          return (
            <Tooltip key={`${heading.pos}:${heading.text}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Go to ${heading.text}`}
                  aria-current={active ? "location" : undefined}
                  onClick={() => goToHeading(heading)}
                  className="group/item flex h-1.5 w-full items-center rounded-full outline-none transition-[height] duration-200 ease-out group-hover/map:h-2.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span
                    className={cn(
                      "h-0.5 origin-left scale-x-50 rounded-full bg-muted-foreground/40 transition-[transform,background-color] duration-200 ease-out group-hover/map:scale-x-100 group-hover/item:bg-foreground/75",
                      active && "h-[3px] bg-primary",
                    )}
                    style={{ width }}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8} className="max-w-72">{heading.text}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </nav>
  );
}

function citationIds(editor: Editor) {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "citation") {
      for (const id of citationKeys(String(node.attrs.id || ""))) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  });
  return ids;
}
