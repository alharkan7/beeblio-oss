"use client";

import { useEffect, useRef } from "react";
import { Extension, type JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { toast } from "sonner";
import { PROJECT_BIBLIOGRAPHY_PATH } from "@/lib/project-bibliography";
import { announceWorkspaceChange } from "@/lib/workspace-change";

import { parseBibtexEntries } from "@/lib/bibtex";
import { formatCitation, referenceFromEntry, type CitationReference, type CitationStyle } from "@/lib/citations";
import type { LiteratureItem } from "@/lib/literature/types";
import { CITATION_TOKEN_REGEX } from "@/lib/markdown-bibliography";
import { isNearSentenceRepeat } from "@/lib/sentence-suggestion-repeat";
import { generateSentenceSuggestion, saveSuggestedReferences, type SentenceSuggestionResult } from "../../sentence-suggestion-actions";

export type SuggestionSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; key: string; display: string };

/** A suggestion request in flight; the seq keeps a superseded request's cleanup from clearing a newer cue. */
export type ProcessingSuggestion = { pos: number; seq: number } | null;

// The "working" caret cue: a taller-than-normal bar right of the caret that
// pulses while the model writes, so the wait reads as activity.
function buildProcessingDom() {
  const bar = document.createElement("span");
  bar.className = "beeblio-suggestion-processing";
  bar.contentEditable = "false";
  return bar;
}

export type ActiveSentenceSuggestion = {
  /** Instance id; changes whenever a different suggestion is shown. */
  id: number;
  /** ProseMirror position the sentence continues; also where accept inserts. */
  pos: number;
  segments: SuggestionSegment[];
  /**
   * Search results cited by the sentence that are not in references.bib yet,
   * with the citation key the server resolved for them (it owns the identity
   * hash, so the client cannot recompute it).
   */
  pendingItems: Array<{ key: string; item: LiteratureItem }>;
  /**
   * Entries from a chosen library file that the sentence cites but that are
   * missing from references.bib; accepted ones are copied over.
   */
  pendingEntries: Array<{ key: string; bibtex: string; reference: CitationReference }>;
};

// How long the caret must rest before a suggestion is requested, and how much
// surrounding text rides along as context.
const TRIGGER_IDLE_MS = 900;
const CONTEXT_BEFORE_CHARS = 1_500;
const CONTEXT_AFTER_CHARS = 400;
const CACHE_MAX_ENTRIES = 24;
const CACHE_TTL_MS = 5 * 60_000;
const CITATION_TOKEN = CITATION_TOKEN_REGEX;
// A caret may only receive suggestions at narrative boundaries: end of the
// block, or right after sentence-final punctuation (with optional closing
// quotes/brackets and whitespace). Mid-sentence and mid-word carets never
// trigger — inserting there breaks the flow of the existing text.
const SENTENCE_BOUNDARY_TAIL = /[.?!…]["'\u2019\u201D»)\]]*\s*$/u;

// Builds the greyed-out ghost: plain text segments plus citation chips that
// already preview in the document's current citation style. The "Tab" chip is
// absolutely positioned above the ghost start and accepts on click.
function buildGhostDom(active: ActiveSentenceSuggestion, onAccept: () => void) {
  const wrap = document.createElement("span");
  wrap.className = "beeblio-suggestion-ghost";
  wrap.contentEditable = "false";
  for (const segment of active.segments) {
    if (segment.kind === "text") {
      wrap.appendChild(document.createTextNode(segment.text));
    } else {
      const citation = document.createElement("span");
      citation.className = "beeblio-suggestion-citation";
      citation.textContent = segment.display;
      wrap.appendChild(citation);
    }
  }
  const chip = document.createElement("span");
  chip.className = "beeblio-suggestion-chip";
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", "Accept suggested sentence");
  const key = document.createElement("kbd");
  key.textContent = "Tab";
  chip.appendChild(key);
  chip.appendChild(document.createTextNode(" to Accept"));
  chip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onAccept();
  });
  wrap.appendChild(chip);
  return wrap;
}

export const SentenceSuggestionExtension = Extension.create<{
  getActive: () => ActiveSentenceSuggestion | null;
  getProcessing: () => ProcessingSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
}>({
  name: "sentenceSuggestion",
  addOptions() {
    return {
      getActive: () => null,
      getProcessing: () => null,
      onAccept: () => {},
      onDismiss: () => {},
    };
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (!this.options.getActive()) return false;
        this.options.onAccept();
        return true;
      },
      Escape: () => {
        if (!this.options.getActive()) return false;
        this.options.onDismiss();
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("sentenceSuggestion"),
        props: {
          // Recomputed on every state change so the ghost vanishes the moment
          // the caret leaves its position, even before React state updates.
          decorations: (state) => {
            const active = options.getActive();
            if (active && state.selection.empty && state.selection.from === active.pos
              && active.pos >= 0 && active.pos <= state.doc.content.size) {
              return DecorationSet.create(state.doc, [
                // The key embeds the instance id: ProseMirror reuses widget DOM
                // across decoration updates with the same key and position, so a
                // fresh suggestion at an unchanged position must differ.
                Decoration.widget(active.pos, () => buildGhostDom(active, options.onAccept), {
                  side: 1,
                  key: `sentence-suggestion-${active.id}`,
                  stopEvent: () => true,
                  ignoreSelection: true,
                }),
              ]);
            }
            const processing = options.getProcessing();
            if (processing && state.selection.empty && state.selection.from === processing.pos
              && processing.pos >= 0 && processing.pos <= state.doc.content.size) {
              return DecorationSet.create(state.doc, [
                Decoration.widget(processing.pos, buildProcessingDom, {
                  side: 1,
                  key: `sentence-suggestion-processing-${processing.seq}`,
                  stopEvent: () => true,
                  ignoreSelection: true,
                }),
              ]);
            }
            return DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

function referenceFromLiteratureItem(key: string, item: LiteratureItem): CitationReference {
  return {
    id: key,
    type: "article",
    title: item.title,
    authors: item.authors.join(" and "),
    year: item.year ? String(item.year) : "",
    container: item.venue ?? "",
    publisher: "",
    volume: "",
    issue: "",
    pages: "",
    doi: item.doi ?? "",
    url: item.url ?? "",
    abstract: item.abstract ?? "",
    citationCount: item.citationCount,
    isOpenAccess: item.isOpenAccess,
  };
}

/**
 * Drives Jenni-style sentence suggestions for the document editor: watches the
 * caret, requests one continuation sentence after a short idle delay, renders
 * it through {@link SentenceSuggestionExtension}, and owns the accept flow
 * (insert text, save pending references to references.bib). Renders nothing.
 */
export function SentenceSuggestions({
  editor,
  projectId,
  enabled,
  disabled,
  style,
  settingsVersion,
  referenceMap,
  citationOrder,
  onAddPendingReferences,
  onReferencesChanged,
  activeRef,
  processingRef,
  acceptRef,
  dismissRef,
}: {
  editor: Editor | null;
  projectId: string;
  /** Only in the editable, non-share visual editor with completion enabled. */
  enabled: boolean;
  /** Suppressed while another caret popup (the "@" menu) is open. */
  disabled: boolean;
  style: CitationStyle;
  /** Changes whenever completion settings change; busts the local cache. */
  settingsVersion: string;
  referenceMap: Map<string, CitationReference>;
  citationOrder: string[];
  onAddPendingReferences: (references: CitationReference[]) => void;
  onReferencesChanged: () => Promise<void> | void;
  /** Shared with the extension so decorations can read the active suggestion. */
  activeRef: { current: ActiveSentenceSuggestion | null };
  /** Shared with the extension so decorations can render the working cue. */
  processingRef: { current: ProcessingSuggestion };
  acceptRef: { current: () => void };
  dismissRef: { current: () => void };
}) {
  const cacheRef = useRef(new Map<string, { result: Extract<SentenceSuggestionResult, { sentence: string }>; storedAt: number }>());
  const shownKeyRef = useRef<string | null>(null);
  const dismissedKeyRef = useRef<string | null>(null);
  const failedKeyRef = useRef<string | null>(null);
  const lastAcceptedRef = useRef<string | null>(null);
  const suggestionIdRef = useRef(0);
  const inFlightRef = useRef<{ key: string; seq: number } | null>(null);
  const requestSeqRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const evaluateRef = useRef<() => void>(() => {});
  const acceptHandlerRef = useRef<() => void>(() => {});
  const dismissHandlerRef = useRef<() => void>(() => {});
  const propsRef = useRef({ editor, projectId, enabled, disabled, style, referenceMap, citationOrder, onAddPendingReferences, onReferencesChanged });
  propsRef.current = { editor, projectId, enabled, disabled, style, referenceMap, citationOrder, onAddPendingReferences, onReferencesChanged };

  const clearTimer = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };

  const clearActive = () => {
    const current = editor ?? propsRef.current.editor;
    if (!activeRef.current) return;
    activeRef.current = null;
    shownKeyRef.current = null;
    if (current && !current.isDestroyed) current.view.dispatch(current.state.tr);
  };

  const show = (active: ActiveSentenceSuggestion, key: string) => {
    active.id = ++suggestionIdRef.current;
    activeRef.current = active;
    shownKeyRef.current = key;
    const current = editor ?? propsRef.current.editor;
    if (current && !current.isDestroyed) current.view.dispatch(current.state.tr);
  };

  const setProcessing = (value: ProcessingSuggestion) => {
    processingRef.current = value;
    const current = editor ?? propsRef.current.editor;
    if (current && !current.isDestroyed) current.view.dispatch(current.state.tr);
  };

  // Turns a server result into displayable segments: citation tokens resolve
  // against the loaded bibliography first, then pending search results, and
  // preview in the document's current citation style.
  const buildActive = (result: Extract<SentenceSuggestionResult, { sentence: string }>, pos: number): ActiveSentenceSuggestion | null => {
    const { style: citationStyle, referenceMap: references, citationOrder: order } = propsRef.current;
    const parts: Array<{ kind: "text"; text: string } | { kind: "citation"; key: string }> = [];
    let last = 0;
    for (const match of result.sentence.matchAll(CITATION_TOKEN)) {
      if (match.index > last) parts.push({ kind: "text", text: result.sentence.slice(last, match.index) });
      parts.push({ kind: "citation", key: match[1] });
      last = match.index + match[0].length;
    }
    if (last < result.sentence.length) parts.push({ kind: "text", text: result.sentence.slice(last) });

    const pendingByKey = new Map<string, { item?: LiteratureItem; entry?: { key: string; bibtex: string; reference: CitationReference } }>();
    if (result.pendingItem && result.citationKey) {
      pendingByKey.set(result.citationKey, { item: result.pendingItem });
    }
    for (const pending of result.pendingEntries ?? []) {
      const entry = parseBibtexEntries(pending.bibtex)[0];
      if (entry) pendingByKey.set(pending.key, { entry: { key: pending.key, bibtex: pending.bibtex, reference: referenceFromEntry(entry) } });
    }
    let nextNumber = order.length + 1;
    const segments: SuggestionSegment[] = [];
    const pendingItems: Array<{ key: string; item: LiteratureItem }> = [];
    const pendingEntries: Array<{ key: string; bibtex: string; reference: CitationReference }> = [];
    for (const part of parts) {
      if (part.kind === "citation") {
        const pending = pendingByKey.get(part.key);
        const reference = references.get(part.key)
          ?? (pending?.item ? referenceFromLiteratureItem(part.key, pending.item) : undefined)
          ?? pending?.entry?.reference;
        const number = order.includes(part.key) ? order.indexOf(part.key) + 1 : nextNumber++;
        segments.push({ kind: "citation", key: part.key, display: formatCitation(reference, citationStyle, number) });
        if (pending?.item) pendingItems.push({ key: part.key, item: pending.item });
        if (pending?.entry) pendingEntries.push(pending.entry);
      } else if (part.text) {
        segments.push({ kind: "text", text: part.text });
      }
    }
    if (!segments.length) return null;
    // The id is a placeholder until show() stamps the instance counter.
    return { id: 0, pos, segments, pendingItems, pendingEntries };
  };

  const fetchSuggestion = async (key: string, pos: number, before: string, after: string, blockKind: "paragraph" | "heading") => {
    const current = propsRef.current;
    const doc = current.editor?.state.doc;
    let docTitle: string | undefined;
    doc?.forEach((child: ProseMirrorNode) => {
      if (!docTitle && child.type.name === "heading" && child.textContent.trim()) {
        docTitle = child.textContent.trim().slice(0, 120);
      }
    });
    const seq = ++requestSeqRef.current;
    inFlightRef.current = { key, seq };
    setProcessing({ pos, seq });
    try {
      const response = await generateSentenceSuggestion({
        projectId: current.projectId,
        before,
        after,
        docTitle,
        blockKind,
        citedKeys: current.citationOrder.slice(0, 300),
        avoidSentence: lastAcceptedRef.current ?? undefined,
      });
      if (seq !== requestSeqRef.current) return;
      if ("error" in response && response.error) {
        failedKeyRef.current = key;
        toast.error("Could not suggest a sentence", { description: response.error });
        return;
      }
      const success = response as Extract<SentenceSuggestionResult, { sentence: string }>;
      if (!success.sentence) {
        failedKeyRef.current = key;
        return;
      }
      if (lastAcceptedRef.current && isNearSentenceRepeat(success.sentence, lastAcceptedRef.current)) {
        dismissedKeyRef.current = key;
        return;
      }
      if (success.modelSource === "system") {
        }
      cacheRef.current.set(key, { result: success, storedAt: Date.now() });
      while (cacheRef.current.size > CACHE_MAX_ENTRIES) {
        cacheRef.current.delete(cacheRef.current.keys().next().value as string);
      }
      const live = propsRef.current.editor;
      const selection = live?.state.selection;
      if (!live || live.isDestroyed || !selection?.empty || selection.from !== pos || !live.isFocused) return;
      const active = buildActive(success, pos);
      if (active) show(active, key);
    } catch (error) {
      if (seq === requestSeqRef.current) {
        failedKeyRef.current = key;
        toast.error("Could not suggest a sentence", {
          description: error instanceof Error ? error.message : "Try again after editing the document.",
        });
      }
    } finally {
      if (inFlightRef.current?.seq === seq) inFlightRef.current = null;
      if (processingRef.current?.seq === seq) setProcessing(null);
    }
  };

  const evaluate = () => {
    const { editor: current, enabled: isEnabled, disabled: isDisabled } = propsRef.current;
    if (!isEnabled || isDisabled || !current || current.isDestroyed || !current.isFocused) return;
    const selection = current.state.selection;
    if (!selection.empty) return;
    const parent = selection.$from.parent;
    const parentType = parent.type.name;
    if (parentType !== "paragraph" && parentType !== "heading") return;
    if (current.view.composing) return;

    // Narrative-boundary gate: suggest at the end of the block (including an
    // empty one) or right after sentence-final punctuation. Carets with prose
    // ahead of them anywhere else — mid-sentence or mid-word — never trigger.
    const beforeInBlock = parent.textBetween(0, selection.$from.parentOffset, "", " ");
    const afterInBlock = parent.textBetween(selection.$from.parentOffset, parent.content.size, "", " ");
    if (afterInBlock.length > 0 && !SENTENCE_BOUNDARY_TAIL.test(beforeInBlock)) return;

    const doc = current.state.doc;
    const pos = selection.from;
    // Citations keep their [@key] markdown form in the context so the model
    // sees what the passage already cites; other leaves become a space.
    const leafText = (node: ProseMirrorNode) => node.type.name === "citation" ? `[@${node.attrs.id}]` : " ";
    const before = doc.textBetween(Math.max(0, pos - CONTEXT_BEFORE_CHARS), pos, "\n\n", leafText);
    const after = doc.textBetween(pos, Math.min(doc.content.size, pos + CONTEXT_AFTER_CHARS), "\n\n", leafText);
    const key = `${parentType}\u0000${before}\u0001${after}`;

    if (dismissedKeyRef.current === key) return;
    if (failedKeyRef.current === key) return;
    if (activeRef.current && shownKeyRef.current === key) return;
    const cached = cacheRef.current.get(key);
    if (cached) {
      if (Date.now() - cached.storedAt < CACHE_TTL_MS) {
        const active = buildActive(cached.result, pos);
        if (active) show(active, key);
        return;
      }
      cacheRef.current.delete(key);
    }
    if (inFlightRef.current?.key === key) return;
    void fetchSuggestion(key, pos, before, after, parentType as "paragraph" | "heading");
  };

  const scheduleEvaluate = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => evaluateRef.current(), TRIGGER_IDLE_MS);
  };

  const dismiss = () => {
    const key = shownKeyRef.current;
    clearActive();
    dismissedKeyRef.current = key;
  };

  const accept = () => {
    const active = activeRef.current;
    const current = propsRef.current.editor;
    if (!active || !current || current.isDestroyed) return;
    const selection = current.state.selection;
    if (!selection.empty || selection.from !== active.pos) {
      clearActive();
      return;
    }

    // Insert as real nodes: text segments plus citation nodes, with a leading
    // space when the caret sits at the end of existing prose.
    const $pos = current.state.doc.resolve(active.pos);
    const beforeText = $pos.parent.textBetween(0, $pos.parentOffset, "\n", "\0");
    const needsSpace = beforeText.length > 0 && !/\s$/.test(beforeText);
    const pendingItems = [...new Map(active.pendingItems.map((item) => [item.key, item])).values()];
    const pendingEntries = [...new Map(active.pendingEntries.map((entry) => [entry.key, entry])).values()];
    const pendingKeys = new Set([...pendingItems.map((item) => item.key), ...pendingEntries.map((entry) => entry.key)]);
    const marker = pendingKeys.size ? `suggestion-${++suggestionIdRef.current}` : "";
    const content: JSONContent[] = [];
    for (const segment of active.segments) {
      if (segment.kind === "text") content.push({ type: "text", text: segment.text });
      else content.push({ type: "citation", attrs: { id: segment.key, pendingSuggestionId: pendingKeys.has(segment.key) ? marker : "" } });
    }
    if (needsSpace) {
      if (content[0]?.type === "text") content[0] = { type: "text", text: ` ${String(content[0].text ?? "")}` };
      else content.unshift({ type: "text", text: " " });
    }

    clearActive();
    if (pendingKeys.size) propsRef.current.onAddPendingReferences([
      ...pendingItems.map(({ key, item }) => referenceFromLiteratureItem(key, item)),
      ...pendingEntries.map((entry) => entry.reference),
    ]);
    if (!current.chain().focus().insertContentAt(active.pos, content).run()) {
      if (pendingKeys.size) void propsRef.current.onReferencesChanged();
      return;
    }
    const docAfterInsert = current.state.doc;
    const insertedSize = content.reduce((size, node) => size + (node.type === "text" ? String(node.text ?? "").length : 1), 0);
    lastAcceptedRef.current = active.segments.map((segment) => segment.kind === "text" ? segment.text : " ").join("");
    if (!pendingKeys.size) return;

    const settleCitations = (keys: Record<string, string> | null) => {
      if (current.isDestroyed) return;
      const doc = current.state.doc;
      if (!keys && doc === docAfterInsert) {
        current.view.dispatch(current.state.tr.delete(active.pos, active.pos + insertedSize));
        return;
      }
      const marked: Array<{ pos: number; node: ProseMirrorNode }> = [];
      doc.descendants((node, pos) => {
        if (node.type.name === "citation" && node.attrs.pendingSuggestionId === marker) marked.push({ pos, node });
      });
      if (!marked.length) return;
      // Most saves keep the generated key. The marker is transient and absent
      // from markdown, so avoid an extra document edit (and autosave) then.
      if (keys && marked.every(({ node }) => (keys[String(node.attrs.id)] ?? node.attrs.id) === node.attrs.id)) return;
      const tr = current.state.tr;
      for (const { pos, node } of marked.reverse()) {
        if (keys) {
          const savedKey = keys[String(node.attrs.id)] ?? node.attrs.id;
          if (savedKey !== node.attrs.id) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: savedKey, pendingSuggestionId: "" });
        }
        else {
          const before = pos > 0 ? doc.textBetween(pos - 1, pos) : "";
          const after = doc.textBetween(pos + node.nodeSize, Math.min(doc.content.size, pos + node.nodeSize + 1));
          tr.delete(before === " " && /^[.,;:!?]/.test(after) ? pos - 1 : pos, pos + node.nodeSize);
        }
      }
      current.view.dispatch(tr);
    };
    void (async () => {
      try {
        const result = await saveSuggestedReferences({ projectId: propsRef.current.projectId, items: pendingItems, entries: pendingEntries.map(({ key, bibtex }) => ({ key, bibtex })) });
        if (!result.success) throw new Error(result.error);
        settleCitations(result.keys);
        announceWorkspaceChange([{ path: PROJECT_BIBLIOGRAPHY_PATH, content: result.bibliographyContent }]);
      } catch (error) {
        settleCitations(null);
        void propsRef.current.onReferencesChanged();
        toast.error("Could not save the suggested citation", { description: error instanceof Error ? error.message : undefined });
      }
    })();
  };

  acceptHandlerRef.current = accept;
  dismissHandlerRef.current = dismiss;
  acceptRef.current = () => acceptHandlerRef.current();
  dismissRef.current = () => dismissHandlerRef.current();
  evaluateRef.current = evaluate;

  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) {
        // Any edit invalidates the ghost, its dismissal, and the shown key.
        dismissedKeyRef.current = null;
        failedKeyRef.current = null;
        lastAcceptedRef.current = null;
        if (activeRef.current) clearActive();
        // The editing transaction itself recomputes decorations, so the cue
        // disappears without another dispatch.
        processingRef.current = null;
      } else if (activeRef.current) {
        const selection = editor.state.selection;
        if (!selection.empty || selection.from !== activeRef.current.pos) clearActive();
      }
      scheduleEvaluate();
    };
    const onFocus = () => scheduleEvaluate();
    const onBlur = () => {
      clearTimer();
      if (activeRef.current) clearActive();
      if (processingRef.current) setProcessing(null);
    };
    editor.on("transaction", onTransaction);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("transaction", onTransaction);
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
      clearTimer();
      if (activeRef.current) clearActive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Disabled or read-only contexts drop everything, including in-flight work.
  useEffect(() => {
    if (enabled && !disabled) {
      scheduleEvaluate();
      return;
    }
    clearTimer();
    if (activeRef.current) clearActive();
    if (processingRef.current) setProcessing(null);
    lastAcceptedRef.current = null;
    requestSeqRef.current++;
    inFlightRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, disabled]);

  // A style switch re-renders every citation preview, so drop the stale ghost.
  useEffect(() => {
    if (activeRef.current) clearActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);

  // A settings change (toggle, sources, filters) invalidates everything the
  // old configuration produced.
  useEffect(() => {
    cacheRef.current.clear();
    requestSeqRef.current++;
    inFlightRef.current = null;
    if (processingRef.current) setProcessing(null);
    dismissedKeyRef.current = null;
    failedKeyRef.current = null;
    lastAcceptedRef.current = null;
    if (activeRef.current) clearActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsVersion]);

  useEffect(() => {
    const clearCache = () => cacheRef.current.clear();
    window.addEventListener("beeblio:workspace-changed", clearCache);
    return () => window.removeEventListener("beeblio:workspace-changed", clearCache);
  }, []);

  return null;
}
