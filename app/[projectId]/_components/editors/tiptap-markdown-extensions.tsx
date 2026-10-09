"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Extension, Mark, mergeAttributes, type JSONContent, type MarkdownParseHelpers, type MarkdownRendererHelpers, type MarkdownToken, type RenderContext } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import Paragraph from "@tiptap/extension-paragraph";
import { Subscript as SubscriptExtension } from "@tiptap/extension-subscript";
import { Superscript as SuperscriptExtension } from "@tiptap/extension-superscript";
import { TextStyle } from "@tiptap/extension-text-style";
import { common, createLowlight } from "lowlight";
import {
  Node, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps,
} from "@tiptap/react";
import {
  AlignJustify, ArrowUpRight, BookOpen, Building2, Calendar, ChevronDown, FileText,
  Globe, GraduationCap, LockOpen, Newspaper, Parentheses, Pencil, Quote, Users,
} from "lucide-react";

import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SELECTION_ANCHOR_MAX_CHARS, SELECTION_MAX_CHARS, type SelectionRange } from "@/lib/chat-context";
import { cn } from "@/lib/utils";
import { citationKeys, formatCitation, supportsNarrativeCitation, type CitationMode, type CitationReference, type CitationStyle } from "@/lib/citations";
import type { LiteratureMetrics } from "@/lib/literature/types";
import { citationModeFromSuffix, CITATION_TOKEN_SUFFIX_SOURCE } from "@/lib/markdown-bibliography";
import type { FileEntry } from "../../file-actions";
import { resolveMarkdownImageSource, resolveShareImageSource } from "./markdown-image-path";

const EMPTY_PARAGRAPH_MARKDOWN = "&nbsp;";
const syntaxHighlighter = createLowlight(common);

// `loading` is true while references.bib is still being fetched: citation
// nodes then render a neutral skeleton instead of "(missing reference)",
// which is reserved for keys that are definitively absent once loaded.
// `fetchMetrics` looks up live citation count / open-access status by DOI for
// the details popover; it is omitted where the backend cannot be called
// (public share views).
export const CitationContext = createContext<{ references: Map<string, CitationReference>; style: CitationStyle; order: string[]; loading: boolean; onEditReference?: (id: string) => void; onViewReference?: (id: string) => void; fetchMetrics?: (dois: string[]) => Promise<LiteratureMetrics[]> }>({ references: new Map(), style: "apa", order: [], loading: false });

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"]);
export const DIAGRAM_EXTENSIONS = new Set([".mmd", ".mermaid"]);

export const fileExtension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

const isImageFile = (entry: FileEntry) => IMAGE_EXTENSIONS.has(fileExtension(entry.name));
export const isDiagramFile = (entry: FileEntry) => DIAGRAM_EXTENSIONS.has(fileExtension(entry.name));
export const isVisualFile = (entry: FileEntry) => isImageFile(entry) || isDiagramFile(entry);

export const UPLOADABLE_VISUAL_ACCEPT = [...IMAGE_EXTENSIONS, ...DIAGRAM_EXTENSIONS].join(",");
export const isUploadableVisualName = (name: string) =>
  IMAGE_EXTENSIONS.has(fileExtension(name)) || DIAGRAM_EXTENSIONS.has(fileExtension(name));

export const MarkdownParagraph = Paragraph.extend({
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers, context: RenderContext) {
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) {
      const previous = Array.isArray(context.previousNode?.content) ? context.previousNode.content : [];
      return context.previousNode?.type === "paragraph" && previous.length === 0 ? EMPTY_PARAGRAPH_MARKDOWN : "";
    }
    const rendered = helpers.renderChildren(content);
    const alignment = safeAlignment(node.attrs?.textAlign);
    return alignment && alignment !== "left"
      ? `<p style="text-align: ${alignment}">${rendered}</p>`
      : rendered;
  },
});

export const MarkdownHeading = Heading.extend({
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
    const rendered = helpers.renderChildren(node.content ?? []);
    const alignment = safeAlignment(node.attrs?.textAlign);
    return alignment && alignment !== "left"
      ? `<h${level} style="text-align: ${alignment}">${rendered}</h${level}>`
      : `${"#".repeat(level)} ${rendered}`;
  },
});

export const MarkdownTextStyle = TextStyle.extend({
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    const styles = textStyleDeclarations(node.attrs);
    const rendered = helpers.renderChildren(node);
    return styles.length > 0 ? `<span style="${styles.join("; ")}">${rendered}</span>` : rendered;
  },
});

export const MarkdownSubscript = SubscriptExtension.extend({
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    return `<sub>${helpers.renderChildren(node.content ?? [])}</sub>`;
  },
});

export const MarkdownSuperscript = SuperscriptExtension.extend({
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    return `<sup>${helpers.renderChildren(node.content ?? [])}</sup>`;
  },
});

export const DiffAddition = Mark.create({
  name: "diffAddition",
  parseHTML() {
    return [
      { tag: "ins" },
      { tag: "span.beeblio-diff-ins" },
      { tag: "span[data-diff='addition']" },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["ins", mergeAttributes(HTMLAttributes, { class: "beeblio-diff-ins" }), 0];
  },
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    return `<ins class="beeblio-diff-ins">${helpers.renderChildren(node)}</ins>`;
  },
});

export const DiffDeletion = Mark.create({
  name: "diffDeletion",
  parseHTML() {
    return [
      { tag: "del" },
      { tag: "span.beeblio-diff-del" },
      { tag: "span[data-diff='deletion']" },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["del", mergeAttributes(HTMLAttributes, { class: "beeblio-diff-del" }), 0];
  },
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    return `<del class="beeblio-diff-del">${helpers.renderChildren(node)}</del>`;
  },
});

export const MarkdownCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MarkdownCodeBlockView);
  },
}).configure({ lowlight: syntaxHighlighter, enableTabIndentation: true, tabSize: 2 });

export const Frontmatter = Node.create({
  name: "frontmatter",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML() {
    return [{ tag: "pre[data-frontmatter]" }];
  },
  renderHTML() {
    return [
      "pre",
      {
        "aria-hidden": "true",
        "data-frontmatter": "true",
        hidden: "",
        style: "display: none",
      },
      ["code", 0],
    ];
  },
  markdownTokenName: "frontmatter",
  markdownTokenizer: {
    name: "frontmatter",
    level: "block",
    start: "---",
    tokenize(source) {
      const match = /^---[\t ]*\n([\s\S]*?)\n---(?:[\t ]*\n|$)/.exec(source);
      if (!match) return;
      return { type: "frontmatter", raw: match[0], text: match[1] } as MarkdownToken;
    },
  },
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const value = typeof token.text === "string" ? token.text : "";
    return helpers.createNode("frontmatter", undefined, value ? [helpers.createTextNode(value)] : []);
  },
  renderMarkdown(node: JSONContent) {
    return `---\n${plainText(node)}\n---`;
  },
});

export const ImportantCallout = Node.create({
  name: "importantCallout",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML() {
    return [{
      tag: 'blockquote[data-callout="important"]',
      contentElement: "[data-callout-content]",
    }];
  },
  renderHTML() {
    return [
      "blockquote",
      {
        "data-callout": "important",
        role: "note",
      },
      ["div", { "data-callout-title": "", contenteditable: "false" }, "Important"],
      ["div", { "data-callout-content": "" }, 0],
    ];
  },
  markdownTokenName: "importantCallout",
  markdownTokenizer: {
    name: "importantCallout",
    level: "block",
    start(source) {
      const index = source.search(/^ {0,3}>[\t ]?\[!IMPORTANT\][\t ]*$/im);
      return index;
    },
    tokenize(source, _tokens, lexer) {
      const match = /^ {0,3}>[\t ]?\[!IMPORTANT\][\t ]*(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/i.exec(source);
      if (!match) return;

      const body = match[1]
        .replace(/^ {0,3}>[\t ]?/gm, "")
        .replace(/\n$/, "");

      return {
        type: "importantCallout",
        raw: match[0],
        tokens: lexer.blockTokens(body ? `${body}\n` : ""),
      } as MarkdownToken;
    },
  },
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const content = helpers.parseChildren(token.tokens ?? []);
    return helpers.createNode(
      "importantCallout",
      undefined,
      content.length > 0 ? content : [helpers.createNode("paragraph")],
    );
  },
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers) {
    const body = helpers.renderChildren(node.content ?? []).trimEnd();
    const quotedBody = body
      .split("\n")
      .map((line) => line ? `> ${line}` : ">")
      .join("\n");

    return quotedBody
      ? `> [!IMPORTANT]\n${quotedBody}`
      : "> [!IMPORTANT]";
  },
});

export const CitationNode = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: "" },
      pendingSuggestionId: { default: "", renderHTML: () => ({}) },
      mode: {
        default: "default",
        parseHTML: (element) => (element as HTMLElement).dataset.citationMode ?? "default",
        renderHTML: (attributes) => attributes.mode === "narrative" ? { "data-citation-mode": "narrative" } : {},
      },
      fontFamily: {
        default: "",
        parseHTML: (element) => (element as HTMLElement).dataset.fontFamily ?? "",
        renderHTML: (attributes) => (attributes.fontFamily ? { "data-font-family": attributes.fontFamily } : {}),
      },
      fontSize: {
        default: "",
        parseHTML: (element) => (element as HTMLElement).dataset.fontSize ?? "",
        renderHTML: (attributes) => (attributes.fontSize ? { "data-font-size": attributes.fontSize } : {}),
      },
    };
  },
  parseHTML() { return [{ tag: "span[data-citation-id]", getAttrs: (element) => ({ id: (element as HTMLElement).dataset.citationId }) }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-citation-id": node.attrs.id })];
  },
  markdownTokenName: "citation",
  markdownTokenizer: {
    name: "citation",
    level: "inline",
    start: "[@",
    tokenize(source) {
      const match = CITATION_TOKEN_SOURCE.exec(source);
      if (!match) return undefined;
      const params = citationFontParams(match[2] ?? "");
      return { type: "citation", raw: match[0], id: match[1], mode: citationModeFromSuffix(match[2] ?? ""), fontFamily: params.font, fontSize: params.size } as MarkdownToken;
    },
  },
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    return helpers.createNode("citation", {
      id: String(token.id || ""),
      mode: token.mode === "narrative" ? "narrative" : "default",
      fontFamily: String(token.fontFamily || ""),
      fontSize: String(token.fontSize || ""),
    });
  },
  renderMarkdown(node: JSONContent) {
    return citationMarkdownText(node.attrs);
  },
  // Surfaces the [@key] token wherever ProseMirror needs plain text for an
  // inline atom: `textBetween` consumers (selection serialization, clipboard
  // plain-text copy) would otherwise drop citations entirely.
  extendNodeSchema() {
    return {
      leafText: (node: ProsemirrorNode) => citationMarkdownText(node.attrs),
    };
  },
  addNodeView() { return ReactNodeViewRenderer(CitationNodeView); },
  addProseMirrorPlugins() {
    return [citationFontSyncPlugin()];
  },
});

/** Parses `font=Georgia|size=24px` (with surrounding braces) into its params. */
function citationFontParams(suffix: string) {
  const params: { font?: string; size?: string } = {};
  for (const part of suffix.replace(/^\{/, "").replace(/\}$/, "").split("|")) {
    const [key, ...value] = part.split("=");
    if (key === "font" || key === "size") params[key] = value.join("=");
  }
  return params;
}

/** The `[@key]{params}` source form of a citation — the single builder used by
 *  markdown serialization and leafText so both always agree byte-for-byte. */
function citationMarkdownText(attrs: Record<string, unknown> | undefined) {
  const id = String(attrs?.id || "");
  const params = [
    attrs?.mode === "narrative" ? "mode=narrative" : "",
    attrs?.fontFamily ? `font=${String(attrs.fontFamily)}` : "",
    attrs?.fontSize ? `size=${String(attrs.fontSize)}` : "",
  ].filter(Boolean).join("|");
  return params ? `[@${id}]{${params}}` : `[@${id}]`;
}

export type DocumentSelectionExtract = {
  /** Source-faithful text of the selection (markdown for rich documents). */
  text: string;
  range: SelectionRange;
  /** Neighboring source text used to locate the passage in the file. */
  before?: string;
  after?: string;
};

/** The source form of a selected atom node, matching how the file itself
 *  represents it (citation keys, image markdown, fenced code source). */
function nodeSelectionText(node: ProsemirrorNode): string {
  if (node.type.name === "citation") return citationMarkdownText(node.attrs);
  if (node.type.name === "image") {
    const alt = String(node.attrs.alt || "").replaceAll("]", "\\]");
    const source = String(node.attrs.markdownSource || node.attrs.src || "");
    return `![${alt}](${source})`;
  }
  if (node.type.name === "codeBlock") {
    return ["```" + String(node.attrs.language ?? "").toLowerCase(), node.textContent, "```"].join("\n");
  }
  return node.textContent;
}

function selectionMarkdown(editor: Editor, from: number, to: number): string {
  const manager = editor.markdown;
  if (manager) {
    try {
      const content = editor.state.doc.slice(from, to).content.toJSON() as JSONContent[];
      if (Array.isArray(content) && content.length > 0) {
        return manager.serialize({ type: "doc", content });
      }
    } catch {
      // A serializer hiccup must not lose the selection; fall back to plain text.
    }
  }
  return editor.state.doc.textBetween(from, to, "\n\n");
}

// Anchor text is a plain-text extract (citations keep their [@key] via
// leafText) — it exists to locate the passage, not to byte-match the file.
function nearestBlockAnchor(doc: ProsemirrorNode, index: number, step: 1 | -1) {
  for (let i = index + step; i >= 0 && i < doc.childCount; i += step) {
    const text = doc.child(i).textContent.trim();
    if (text) return step < 0 ? text.slice(-SELECTION_ANCHOR_MAX_CHARS) : text.slice(0, SELECTION_ANCHOR_MAX_CHARS);
  }
  return undefined;
}

function selectionAnchors(doc: ProsemirrorNode, from: number, to: number): { before?: string; after?: string } {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  let before: string | undefined;
  let after: string | undefined;
  if ($from.parentOffset > 0 && $from.parent.isTextblock) {
    before = $from.parent.textBetween(0, $from.parentOffset, "\n").trim().slice(-SELECTION_ANCHOR_MAX_CHARS) || undefined;
  } else {
    before = nearestBlockAnchor(doc, $from.index(0), -1);
  }
  if ($to.parentOffset < $to.parent.content.size && $to.parent.isTextblock) {
    after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, "\n").trim().slice(0, SELECTION_ANCHOR_MAX_CHARS) || undefined;
  } else if ($to.depth === 0) {
    after = nearestBlockAnchor(doc, $to.index(), 1);
  } else {
    after = nearestBlockAnchor(doc, $to.index(0) + 1, 1);
  }
  return { before: before || undefined, after: after || undefined };
}

/** Serializes a document range as source-faithful text: markdown for passage
 *  selections (so [@key] citations, marks, and structure survive), or the
 *  node's file representation when the range covers exactly one atom (a
 *  citation, image, Mermaid block). Returns null when the range has nothing
 *  meaningful to hand over. */
export function documentSelectionAt(editor: Editor, from: number, to: number): DocumentSelectionExtract | null {
  if (editor.isDestroyed) return null;
  const { doc } = editor.state;
  const node = doc.nodeAt(from);
  // Only atoms (citation, image, …) and code blocks have a node-level source
  // form; covering one must not bypass markdown serialization for ordinary
  // blocks like a select-all landing on the document's first paragraph.
  if (node && !node.isText && (node.isLeaf || node.type.name === "codeBlock") && from + node.nodeSize === to) {
    const text = nodeSelectionText(node).trim();
    if (text) {
      return { text: text.slice(0, SELECTION_MAX_CHARS), range: { from, to }, ...selectionAnchors(doc, from, to) };
    }
  }
  const text = selectionMarkdown(editor, from, to).trim();
  if (!text) return null;
  return { text: text.slice(0, SELECTION_MAX_CHARS), range: { from, to }, ...selectionAnchors(doc, from, to) };
}

const CITATION_TOKEN_SOURCE = new RegExp(String.raw`^\[@([A-Za-z0-9_:.-]+(?:\s*;\s*@[A-Za-z0-9_:.-]+)*)\](${CITATION_TOKEN_SUFFIX_SOURCE})`);

// The markdown serializer closes text-style marks around inline atoms, so a
// citation's font family/size would be dropped on the next markdown
// round-trip (reload, mode switch, AI edit). This plugin mirrors the
// textStyle mark's font attributes onto the citation node itself, where they
// persist as the [@key]{font=…|size=…} suffix.
function citationFontSyncPlugin() {
  return new Plugin({
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const tr = newState.tr;
      let changed = false;
      newState.doc.descendants((node, pos) => {
        if (node.type.name !== "citation") return;
        const textStyle = node.marks.find((mark) => mark.type.name === "textStyle");
        const fontFamily = String(textStyle?.attrs.fontFamily ?? "");
        const fontSize = String(textStyle?.attrs.fontSize ?? "");
        if (node.attrs.fontFamily === fontFamily && node.attrs.fontSize === fontSize) return;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, fontFamily, fontSize });
        changed = true;
      });
      return changed ? tr : null;
    },
  });
}

export const MentionSearchHighlight = Extension.create<{
  getDismissedFrom: () => number | null;
  getSlashDismissedFrom?: () => number | null;
  isEnabled?: () => boolean;
}>({
  name: "mentionSearchHighlight",
  addOptions() {
    return {
      getDismissedFrom: () => null,
      getSlashDismissedFrom: () => null,
      isEnabled: () => true,
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mentionSearchHighlight"),
        props: {
          decorations: (state) => {
            if (this.options.isEnabled && !this.options.isEnabled()) {
              return DecorationSet.empty;
            }
            const { $from, empty } = state.selection;
            if (!empty || !$from.parent.isTextblock) {
              return DecorationSet.empty;
            }
            const text = $from.parent.textBetween(0, $from.parentOffset, "\n", "\0");
            const mentionMatch = /(?:^|\s)@((?:[\p{L}\p{N}_:.'’-]+(?:\s+[\p{L}\p{N}_:.'’-]+)*)?\s*)$/u.exec(text);
            const slashMatch = /^\/([^\n]*)$/.exec(text);
            const match = mentionMatch ?? slashMatch;
            if (!match) {
              return DecorationSet.empty;
            }
            const query = match[1] ?? "";
            const from = state.selection.from - query.length - 1;
            const dismissedFrom = mentionMatch
              ? this.options.getDismissedFrom()
              : this.options.getSlashDismissedFrom?.();
            if (dismissedFrom === from) {
              return DecorationSet.empty;
            }
            const to = state.selection.from;
            if (from < 0 || to > state.doc.content.size || from >= to) {
              return DecorationSet.empty;
            }
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, {
                class: "beeblio-mention-query",
                style: "outline: none !important; border: none !important; box-shadow: none !important;",
              }),
            ]);
          },
        },
      }),
    ];
  },
});

function CitationNodeView({ node, selected, updateAttributes }: NodeViewProps) {
  const [open, setOpen] = useState(false);
  const { references, style, order, loading, onEditReference, onViewReference, fetchMetrics } = useContext(CitationContext);
  const id = String(node.attrs.id || "");
  const ids = citationKeys(id);
  const number = Math.max(1, order.indexOf(id) + 1);
  const reference = references.get(ids[0]);
  const mode: CitationMode = node.attrs.mode === "narrative" ? "narrative" : "default";
  const narrativeAvailable = supportsNarrativeCitation(style);
  // Attrs are the persisted source (they survive the markdown round-trip);
  // the textStyle mark covers the moment between the user picking a font and
  // the sync plugin copying it onto the node.
  const textStyle = node.marks.find((mark) => mark.type.name === "textStyle");
  const fontStyle = {
    fontFamily: String(node.attrs.fontFamily || textStyle?.attrs.fontFamily || "") || undefined,
    fontSize: String(node.attrs.fontSize || textStyle?.attrs.fontSize || "") || undefined,
  };
  if (loading) {
    return (
      <NodeViewWrapper as="span">
        <span
          className={cn("beeblio-citation is-loading", selected && "is-selected")}
          style={fontStyle}
          title={`@${id}`}
          contentEditable={false}
        >
          <span className="beeblio-citation-skeleton animate-pulse" style={{ width: citationSkeletonWidth(style, id) }} />
        </span>
      </NodeViewWrapper>
    );
  }
  if (ids.length > 1) {
    const bracket = style === "ieee" ? ["[", "]"] : ["(", ")"];
    return (
      <NodeViewWrapper as="span">
        <span contentEditable={false} style={fontStyle}>
          {bracket[0]}
          {ids.map((key, index) => (
            <span key={`${key}-${index}`}>
              {index > 0 ? "; " : null}
              <CitationGroupItem
                id={key}
                reference={references.get(key)}
                style={style}
                number={Math.max(1, order.indexOf(key) + 1)}
                onEdit={onEditReference}
                onView={onViewReference}
                fetchMetrics={fetchMetrics}
              />
            </span>
          ))}
          {bracket[1]}
        </span>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper as="span">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <span
            className={cn("beeblio-citation cursor-pointer", selected && "is-selected", !reference && "is-missing")}
            style={fontStyle}
            title={reference ? `@${id}: ${reference.title}` : `Missing reference: @${id}`}
            contentEditable={false}
          >
            {formatCitation(reference, style, number, narrativeAvailable ? mode : "default")}
          </span>
        </PopoverTrigger>
        {reference ? (
          <CitationDetailsPopover
            reference={reference}
            citationId={ids[0]}
            open={open}
            mode={mode}
            narrativeAvailable={narrativeAvailable}
            onModeChange={(nextMode) => updateAttributes({ mode: nextMode })}
            onEdit={onEditReference}
            onView={onViewReference}
            fetchMetrics={fetchMetrics}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </Popover>
    </NodeViewWrapper>
  );
}

function CitationGroupItem({ id, reference, style, number, onEdit, onView, fetchMetrics }: {
  id: string;
  reference?: CitationReference;
  style: CitationStyle;
  number: number;
  onEdit?: (id: string) => void;
  onView?: (id: string) => void;
  fetchMetrics?: (dois: string[]) => Promise<LiteratureMetrics[]>;
}) {
  const [open, setOpen] = useState(false);
  const label = reference ? formatCitation(reference, style, number).slice(1, -1) : `@${id}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          className={cn("beeblio-citation cursor-pointer", open && "is-selected", !reference && "is-missing")}
          title={reference ? `@${id}: ${reference.title}` : `Missing reference: @${id}`}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {label}
        </span>
      </PopoverTrigger>
      {reference ? (
        <CitationDetailsPopover
          reference={reference}
          citationId={id}
          open={open}
          mode="default"
          narrativeAvailable={false}
          onModeChange={() => {}}
          onEdit={onEdit}
          onView={onView}
          fetchMetrics={fetchMetrics}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Popover>
  );
}

// The placeholder approximates the rendered width so the line doesn't reflow
// much when the real citation arrives: numeric styles collapse to a tiny pill,
// author–date styles track the key length.
function citationSkeletonWidth(style: CitationStyle, id: string) {
  if (style === "ieee" || style === "vancouver") return "1.9rem";
  return `clamp(3rem, ${Math.min(Math.max(id.length, 5), 18) * 0.45}rem, 8rem)`;
}

// Live metrics are shared across citation popovers (keyed by normalized DOI),
// so reopening a popover — or opening another citation of the same work —
// serves the earlier lookup instead of hitting the provider again.
const CITATION_METRICS_CACHE_TTL_MS = 10 * 60 * 1_000;
const citationMetricsCache = new Map<string, { metrics: LiteratureMetrics; expiresAt: number }>();

function normalizedCitationDoi(value: string) {
  return value
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase() || undefined;
}

/** The click-through details of one cited reference, anchored to its inline citation. */
function CitationDetailsPopover({ reference, citationId, open, mode, narrativeAvailable, onModeChange, onEdit, onView, fetchMetrics, onClose }: {
  reference: CitationReference;
  citationId: string;
  /** The popover's open state; live metrics are only fetched while open. */
  open: boolean;
  mode: CitationMode;
  narrativeAvailable: boolean;
  onModeChange: (mode: CitationMode) => void;
  onEdit?: (id: string) => void;
  onView?: (id: string) => void;
  fetchMetrics?: (dois: string[]) => Promise<LiteratureMetrics[]>;
  onClose: () => void;
}) {
  const [liveMetrics, setLiveMetrics] = useState<LiteratureMetrics | undefined>();
  const [metricsLoading, setMetricsLoading] = useState(false);
  const TypeIcon = citationTypeIcon(reference.type);
  const link = citationDetailLink(reference);
  const abstractIsLong = reference.abstract.length > 220;
  const metricsDoi = normalizedCitationDoi(reference.doi);
  // This component mounts for every citation node in the document, so the
  // lookup must wait for `open`. Live values override the bibliography's
  // saved ones (they also refresh a count that has gone stale on disk).
  useEffect(() => {
    setLiveMetrics(undefined);
    setMetricsLoading(false);
    if (!open || !fetchMetrics || !metricsDoi) return;
    const cached = citationMetricsCache.get(metricsDoi);
    if (cached && cached.expiresAt > Date.now()) {
      setLiveMetrics(cached.metrics);
      return;
    }
    let cancelled = false;
    setMetricsLoading(true);
    void fetchMetrics([metricsDoi])
      .then((results) => {
        const metrics = results.find((item) => item.doi === metricsDoi && (item.citationCount !== undefined || item.isOpenAccess !== undefined));
        if (metrics && !cancelled) {
          citationMetricsCache.set(metricsDoi, { metrics, expiresAt: Date.now() + CITATION_METRICS_CACHE_TTL_MS });
          setLiveMetrics(metrics);
        }
      })
      .catch(() => {
        // Live metrics are decorative; a failed lookup leaves the saved values.
      })
      .finally(() => {
        if (!cancelled) setMetricsLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, metricsDoi, fetchMetrics]);
  const citationCount = liveMetrics?.citationCount ?? reference.citationCount;
  const isOpenAccess = liveMetrics?.isOpenAccess ?? reference.isOpenAccess;
  return (
    <PopoverContent
      align="start"
      className={cn("max-h-(--radix-popover-content-available-height) w-80 gap-0 overflow-y-auto p-0", onView && "cursor-pointer")}
      aria-label={`Details for citation ${citationId}`}
      onClick={(e) => {
        if ((e.target as Element).closest("button, a, [role='button']")) return;
        if (onView) {
          onView(citationId);
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-3">
        <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px] font-medium capitalize">
          <TypeIcon className="size-3" />
          {reference.type || "reference"}
        </Badge>
        {citationCount !== undefined ? (
          <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground" title={`Cited ${citationCount.toLocaleString()} times`}>
            <Quote className="size-3" />
            {citationCount.toLocaleString()}
          </span>
        ) : metricsLoading ? (
          <span className="h-3 w-7 animate-pulse rounded-sm bg-muted" aria-hidden />
        ) : null}
        {isOpenAccess ? (
          <Badge variant="outline" className="ml-auto h-5 gap-1 border-emerald-500/30 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-400">
            <LockOpen className="size-3" />
            Open
          </Badge>
        ) : null}
      </div>
      <div className="px-3 pb-2.5 pt-2">
        <h3 className="text-xs font-semibold leading-[1.45]">{reference.title || `@${citationId}`}</h3>
        {reference.authors ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{reference.authors}</p> : null}
        {reference.container || reference.publisher || reference.year ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {reference.container ? (
              <span className="flex min-w-0 max-w-full items-center gap-1" title="Journal or book title">
                {citationTypeIcon(reference.type) === Newspaper
                  ? <Newspaper className="size-3 shrink-0" />
                  : <BookOpen className="size-3 shrink-0" />}
                <span className="min-w-0 truncate italic">{reference.container}</span>
              </span>
            ) : null}
            {reference.publisher ? (
              <span className="flex min-w-0 max-w-full items-center gap-1" title="Publisher">
                <Building2 className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{reference.publisher}</span>
              </span>
            ) : null}
            {reference.year ? (
              <span className="flex items-center gap-1" title="Year">
                <Calendar className="size-3 shrink-0" />
                {reference.year}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {reference.abstract ? (
        <div className="border-t px-3 py-2.5">
          {/* The popover only previews the abstract; "Show more" opens the
              reference sheet (like any plain click on the popover) where the
              full text lives. */}
          <p className="whitespace-pre-wrap text-[11px] leading-[1.5] text-foreground/80 line-clamp-4">{reference.abstract}</p>
          {abstractIsLong && onView ? (
            <button
              type="button"
              className="mt-1.5 flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => { onView(citationId); onClose(); }}
            >
              Show more
              <ChevronDown className="size-3" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 border-t px-2.5 py-2">
        {narrativeAvailable ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className="text-muted-foreground hover:text-foreground"
            title={`Switch to ${mode === "default" ? "Narrative" : "Default"}`}
            aria-label={`Citation display: ${mode}. Switch to ${mode === "default" ? "Narrative" : "Default"}`}
            onClick={() => onModeChange(mode === "default" ? "narrative" : "default")}
          >
            {mode === "default" ? <AlignJustify /> : <Parentheses />}
            {mode === "default" ? "In-Line" : "Default"}
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {link ? (
            <Button asChild size="xs" variant="ghost" className="text-muted-foreground hover:text-foreground">
              <a href={link} target="_blank" rel="noreferrer">Open<ArrowUpRight /></a>
            </Button>
          ) : null}
          {onEdit ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            title="Edit reference"
            aria-label="Edit reference"
            onClick={() => { onEdit(citationId); onClose(); }}
          >
            <Pencil />Edit
          </Button>
          ) : null}
        </div>
      </div>
    </PopoverContent>
  );
}

function citationTypeIcon(type: string) {
  const normalized = type.toLowerCase();
  if (normalized.includes("book")) return BookOpen;
  if (normalized.includes("inproceedings") || normalized.includes("conference")) return Users;
  if (normalized.includes("thesis")) return GraduationCap;
  if (normalized.includes("article") || normalized.includes("journal")) return Newspaper;
  if (normalized.includes("online") || normalized.includes("web") || normalized.includes("electronic")) return Globe;
  return FileText;
}

function citationDetailLink(reference: CitationReference) {
  const doi = reference.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
  const candidate = doi ? `https://doi.org/${doi}` : reference.url;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The document path is read through a getter so the extension can stay in the
 * `useEditor` deps across re-paths (untitled Save As, renames, moves): a new
 * path must not rebuild the extensions array, or TipTap recreates the editor
 * from its mount-time content and blanks the document.
 */
export function workspaceImage(projectId: string, getFilePath: () => string, shareId: string | null) {
  const resolveSource = (source: string) => {
    const filePath = getFilePath();
    return shareId
      ? resolveShareImageSource(shareId, filePath, source)
      : resolveMarkdownImageSource(projectId, filePath, source);
  };
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        markdownSource: { default: null, rendered: false },
      };
    },
    parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
      const markdownSource = typeof token.href === "string" ? token.href : "";
      return helpers.createNode("image", {
        src: resolveSource(markdownSource),
        markdownSource,
        title: typeof token.title === "string" ? token.title : null,
        alt: typeof token.text === "string" ? token.text : "",
      });
    },
    renderMarkdown(node: JSONContent) {
      const source = String(node.attrs?.markdownSource || node.attrs?.src || "");
      const alt = String(node.attrs?.alt || "").replaceAll("]", "\\]");
      const title = String(node.attrs?.title || "").replaceAll('"', '\\"');
      return title ? `![${alt}](${source} "${title}")` : `![${alt}](${source})`;
    },
  }).configure({
    allowBase64: false,
    resize: {
      enabled: true,
      directions: ["top-left", "top-right", "bottom-left", "bottom-right"],
      minWidth: 80,
      minHeight: 50,
      alwaysPreserveAspectRatio: true,
    },
  });
}

function MarkdownCodeBlockView({ node, selected, editor, getPos }: NodeViewProps) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const language = String(node.attrs.language ?? "").toLowerCase();

  if (language !== "mermaid") {
    return (
      <NodeViewWrapper className="beeblio-code-block">
        <div className="beeblio-code-header" contentEditable={false}>{language || "plain text"}</div>
        <pre><NodeViewContent as={"code" as "div"} className="beeblio-code-content" /></pre>
      </NodeViewWrapper>
    );
  }

  // The rendered preview is not editable, so clicking it would do nothing;
  // select the whole block instead so the "Ask Beeblio" affordance can anchor
  // to it. Clicks on the preview's own controls pass through untouched.
  const selectDiagramBlock = (event: React.MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("button, a, input, [role='button']")) return;
    const pos = getPos();
    if (typeof pos === "number") editor.chain().focus().setNodeSelection(pos).run();
  };

  return (
    <NodeViewWrapper className={cn("beeblio-mermaid-block", selected && "is-selected")}>
      <div
        className="beeblio-mermaid-preview"
        contentEditable={false}
        onClick={selectDiagramBlock}
        title="Click to select this diagram"
      >
        <MessageResponse>{["```mermaid", node.textContent, "```"].join("\n")}</MessageResponse>
      </div>
      <details
        className="beeblio-mermaid-source"
        open={sourceOpen}
        onToggle={(event) => setSourceOpen(event.currentTarget.open)}
      >
        <summary contentEditable={false}>Edit Mermaid source</summary>
        <pre><NodeViewContent as={"code" as "div"} className="beeblio-code-content" /></pre>
      </details>
    </NodeViewWrapper>
  );
}

function safeAlignment(value: unknown) {
  return typeof value === "string" && ["left", "center", "right", "justify"].includes(value) ? value : undefined;
}

function textStyleDeclarations(attributes: Record<string, unknown> | undefined) {
  if (!attributes) return [];
  const declarations: string[] = [];
  const fontFamily = safeCssValue(attributes.fontFamily);
  const fontSize = safeCssValue(attributes.fontSize);
  const color = safeCssValue(attributes.color);
  const backgroundColor = safeCssValue(attributes.backgroundColor);
  const lineHeight = safeCssValue(attributes.lineHeight);
  if (fontFamily) declarations.push(`font-family: ${fontFamily}`);
  if (fontSize) declarations.push(`font-size: ${fontSize}`);
  if (color) declarations.push(`color: ${color}`);
  if (backgroundColor) declarations.push(`background-color: ${backgroundColor}`);
  if (lineHeight) declarations.push(`line-height: ${lineHeight}`);
  return declarations;
}

function safeCssValue(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !/[;<>]/.test(trimmed) ? trimmed.replaceAll('"', "&quot;") : undefined;
}

function plainText(node: JSONContent): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(plainText).join("");
}
