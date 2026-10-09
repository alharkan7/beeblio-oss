"use server";

import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getAiTaskConfig } from "@/lib/local-ai-settings";
import { generateText } from "ai";
import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { parseBibtexEntries, type BibtexEntry } from "@/lib/bibtex";
import { appendLiteratureItem } from "@/lib/bibliography-store";
import { cleanBibtexText } from "@/lib/citations";
import { integerEnv } from "@/lib/env-config";
import { fileStem } from "@/lib/literature/citation-identity";
import type { LiteratureItem } from "@/lib/literature/types";
import { literatureItemSchema, verifySaveToken } from "@/lib/literature/save-token";
import { CITATION_TOKEN_REGEX } from "@/lib/markdown-bibliography";
import { evidenceScore, rankByEvidence } from "@/lib/sentence-suggestion-ranking";
import {
  DEFAULT_COMPLETION_SETTINGS,
  parseProjectSettings,
  type CompletionSettings,
} from "@/lib/project-settings";
import { PROJECT_BIBLIOGRAPHY_PATH, REFERENCES_DIRECTORY } from "@/lib/project-bibliography";
import {
  AgentWorkspaceError,
  createAgentWorkspaceDirectory,
  readAgentWorkspaceFile,
  writeAgentWorkspaceFile,
} from "@/lib/workspace-files";
import { getOwnedProject } from "./actions";
import { searchLiterature } from "./literature-actions";

const suggestionInputSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  before: z.string().max(2_500),
  after: z.string().max(600),
  docTitle: z.string().max(200).optional(),
  blockKind: z.enum(["paragraph", "heading"]).default("paragraph"),
  citedKeys: z.array(z.string().max(200)).max(300).default([]),
  avoidSentence: z.string().max(700).optional(),
});

export type SentenceSuggestionResult =
  | {
    sentence: string;
    /** System generations consume Beeblio credits; BYOK generations do not. */
    modelSource: "system" | "byok";
    citationKey?: string;
    pendingItem?: LiteratureItem;
    /**
     * Library entries the sentence cites that are not in references.bib yet
     * (only when the chosen library is a different file); the client copies
     * them into references.bib on accept so the citation resolves inline.
     */
    pendingEntries?: Array<{ key: string; bibtex: string }>;
  }
  | { error: string };

const suggestedReferencesSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  items: z.array(z.object({ key: z.string().min(1).max(200), item: literatureItemSchema })).max(4),
  entries: z.array(z.object({ key: z.string().min(1).max(200), bibtex: z.string().min(1).max(30_000) })).max(4),
});

/** Save all references for an accepted suggestion in one local file write. */
export async function saveSuggestedReferences(input: unknown): Promise<{ success: true; bibliographyContent: string; keys: Record<string, string> } | { success: false; error: string }> {
  const parsed = suggestedReferencesSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "The suggested references are invalid." };
  const { projectId, items, entries } = parsed.data;
  try {
    const user = await requireUser();
    if (!await getOwnedProject(user, projectId)) return { success: false, error: "Project not found." };
    for (const { item } of items) {
      if (!verifySaveToken(projectId, item)) return { success: false, error: "A search result expired. Request a new suggestion." };
    }
    let source = "";
    let exists = true;
    try {
      source = await (await readAgentWorkspaceFile(user.id, projectId, PROJECT_BIBLIOGRAPHY_PATH)).text();
    } catch (error) {
      if (error instanceof AgentWorkspaceError && error.status === 404) exists = false;
      else throw error;
    }
    const keys: Record<string, string> = {};
    for (const { key, item } of items) {
      const result = appendLiteratureItem(source, item);
      source = result.content;
      keys[key] = result.citationKey;
    }
    const known = new Set(parseBibtexEntries(source).map((entry) => entry.key));
    for (const { key, bibtex } of entries) {
      const parsedEntries = parseBibtexEntries(bibtex);
      if (parsedEntries.length !== 1 || parsedEntries[0].key !== key) return { success: false, error: "A suggested library entry is invalid." };
      keys[key] = key;
      if (known.has(key)) continue;
      source = `${source}${source && !source.endsWith("\n\n") ? source.endsWith("\n") ? "\n" : "\n\n" : ""}${bibtex.trim()}\n`;
      known.add(key);
    }
    if (!exists) await createAgentWorkspaceDirectory(user.id, projectId, REFERENCES_DIRECTORY);
    await writeAgentWorkspaceFile(user.id, projectId, PROJECT_BIBLIOGRAPHY_PATH, source);
    return { success: true, bibliographyContent: source, keys };
  } catch (error) {
    console.error("[sentence-suggestion] citation save failed", error);
    return { success: false, error: "The suggested citation could not be saved." };
  }
}

const CATALOG_MAX_ENTRIES = 16;
const CATALOG_TITLE_MAX_CHARS = 120;
const CATALOG_ABSTRACT_MAX_CHARS = 220;
const SENTENCE_MAX_CHARS = 600;
const CITATION_TOKEN = CITATION_TOKEN_REGEX;

type CatalogEntry = { key: string; label: string; evidence: string };

async function readWorkspaceFile(userId: string, projectId: string, workspacePath: string) {
  const normalized = path.posix.normalize(workspacePath);
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("../") || normalized === "..") return "";
  try {
    return await (await readAgentWorkspaceFile(userId, projectId, normalized)).text();
  } catch (error) {
    if (error instanceof AgentWorkspaceError && error.status === 404) return "";
    throw error;
  }
}

const libraryCache = new Map<string, { etag: string; source: string; entries: BibtexEntry[] }>();
async function readLibrary(userId: string, projectId: string, workspacePath: string) {
  const normalized = path.posix.normalize(workspacePath);
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("../") || normalized === "..") return { source: "", entries: [] as BibtexEntry[] };
  const cacheKey = `${userId}\0${projectId}\0${normalized}`;
  const cached = libraryCache.get(cacheKey);
  try {
    const response = await readAgentWorkspaceFile(userId, projectId, normalized, cached ? { ifNoneMatch: cached.etag } : undefined);
    if (response.status === 304 && cached) return cached;
    const source = await response.text();
    const value = { etag: response.headers.get("etag") ?? "", source, entries: parseBibtexEntries(source) };
    if (value.etag) {
      libraryCache.delete(cacheKey);
      libraryCache.set(cacheKey, value);
      if (libraryCache.size > 64) libraryCache.delete(libraryCache.keys().next().value as string);
    }
    return value;
  } catch (error) {
    if (error instanceof AgentWorkspaceError && error.status === 404) {
      libraryCache.delete(cacheKey);
      return { source: "", entries: [] as BibtexEntry[] };
    }
    throw error;
  }
}

function firstAuthorFamily(authorField: string) {
  const first = cleanBibtexText(authorField).split(/\s+and\s+/i)[0] ?? "";
  if (first.includes(",")) return cleanBibtexText(first.split(",")[0]);
  const parts = cleanBibtexText(first).split(/\s+/).filter(Boolean);
  return parts.at(-1) ?? "";
}

// Active quality filters: inclusive publication year range and minimum
// citation count, or null when that bound does not apply.
type CompletionFilterBounds = { minYear: number | null; maxYear: number | null; minCitations: number | null };

function completionBounds(filters: CompletionSettings["filters"]): CompletionFilterBounds {
  return {
    minYear: filters.year === "last5"
      ? new Date().getFullYear() - 4
      : filters.year === "custom" ? filters.customMinYear ?? null : null,
    maxYear: filters.year === "custom" ? filters.customMaxYear ?? null : null,
    minCitations: filters.citations === "all" ? null : Number(filters.citations),
  };
}

function yearPasses(year: number | null | undefined, bounds: CompletionFilterBounds) {
  if (bounds.minYear !== null && (year === null || year === undefined || year < bounds.minYear)) return false;
  if (bounds.maxYear !== null && (year === null || year === undefined || year > bounds.maxYear)) return false;
  return true;
}

function entryPassesFilters(entry: BibtexEntry, bounds: CompletionFilterBounds) {
  if (!yearPasses(Number.parseInt(cleanBibtexText(entry.fields.year), 10) || null, bounds)) return false;
  if (bounds.minCitations !== null) {
    const count = Number.parseInt(cleanBibtexText(entry.fields.citationcount), 10);
    if (!Number.isFinite(count) || count < bounds.minCitations) return false;
  }
  return true;
}

function itemPassesFilters(item: LiteratureItem, bounds: CompletionFilterBounds) {
  if (!yearPasses(item.year ?? null, bounds)) return false;
  if (bounds.minCitations !== null && (item.citationCount ?? -1) < bounds.minCitations) return false;
  return true;
}

function buildCatalog(entries: BibtexEntry[], citedKeys: string[], before: string) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const ordered: BibtexEntry[] = [];
  for (const key of [...citedKeys].reverse()) {
    const entry = byKey.get(key);
    if (entry && !ordered.includes(entry)) ordered.push(entry);
    if (ordered.length >= 4) break;
  }
  const rest = rankByEvidence(entries.filter((entry) => !ordered.includes(entry)), before.slice(-600), (entry) => ({
    title: cleanBibtexText(entry.fields.title),
    abstract: cleanBibtexText(entry.fields.abstract ?? ""),
  }));
  return [...ordered, ...rest].slice(0, CATALOG_MAX_ENTRIES).map((entry): CatalogEntry => ({
    key: entry.key,
    label: [cleanBibtexText(entry.fields.year), firstAuthorFamily(entry.fields.author), cleanBibtexText(entry.fields.title).slice(0, CATALOG_TITLE_MAX_CHARS)].filter(Boolean).join(" | "),
    evidence: cleanBibtexText(entry.fields.abstract ?? "").slice(0, CATALOG_ABSTRACT_MAX_CHARS),
  }));
}

// LLMs wrap JSON in fences or prose despite instructions; peel to the first
// {...} block and fall back to a direct string scan for the sentence field.
function parseModelJson(completion: string): { sentence: string; searchQuery: string } {
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(completion.trim());
  const body = (fenced ? fenced[1] : completion.trim()).slice(0, 4_000);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        return {
          sentence: typeof parsed.sentence === "string" ? parsed.sentence : "",
          searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : "",
        };
      }
    } catch {
      // fall through to the regex path
    }
  }
  const match = /"sentence"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  const queryMatch = /"searchQuery"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  if (!match) return { sentence: "", searchQuery: "" };
  const unquote = (value: string) => {
    try {
      return JSON.parse(`"${value}"`) as string;
    } catch {
      return value;
    }
  };
  return {
    sentence: unquote(match[1]),
    searchQuery: queryMatch ? unquote(queryMatch[1]) : "",
  };
}

function normalizeSentence(value: string) {
  return value
    .replace(/^["'“”\s]+|["'“”\s]+$/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, SENTENCE_MAX_CHARS);
}

// Fix spacing around citation tokens that were dropped or rewritten.
function tidyCitations(sentence: string) {
  return sentence
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/ {2,}/g, " ")
    .replace(/\[\s*@/g, "[@")
    .replace(/\]\s*\]/g, "]")
    .trim();
}

// Models frequently drop the final period — especially when the sentence ends
// with a citation token — so repair it deterministically: a trailing comma or
// semicolon becomes a period, and a sentence without terminal punctuation
// (optionally behind closing quotes/brackets) gets one appended after the
// citation token.
function ensureTerminalPunctuation(sentence: string) {
  const repaired = sentence
    .replace(/[,;]$/, ".")
    // The swap above (or the model itself) can leave doubled trailing periods.
    .replace(/\.+$/, ".");
  return /[.?!…:]["'”’»)\]]*$/u.test(repaired) ? repaired : `${repaired}.`;
}

// Bibtex keys in this app are long ("wang-2016-security-privacy-…-66caaf02"),
// and lite models routinely truncate or mistype them. Before treating a key as
// unknown, try to resolve it back to a catalog key (exact, then normalized
// prefix/containment) so a near-miss citation survives instead of being
// stripped from the sentence.
const NORMALIZED_KEY_MIN_CHARS = 8;

function normalizeKey(key: string) {
  return key.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveKey(key: string, catalogKeys: string[]): string | undefined {
  if (catalogKeys.includes(key)) return key;
  const target = normalizeKey(key);
  if (target.length < NORMALIZED_KEY_MIN_CHARS) return undefined;
  let prefixMatch: string | undefined;
  let containsMatch: string | undefined;
  for (const candidate of catalogKeys) {
    const normalized = normalizeKey(candidate);
    if (normalized.length < NORMALIZED_KEY_MIN_CHARS) continue;
    if (!prefixMatch && (normalized.startsWith(target) || target.startsWith(normalized))) {
      prefixMatch = candidate;
      break;
    }
    if (!containsMatch && (normalized.includes(target) || target.includes(normalized))) {
      containsMatch = candidate;
    }
  }
  return prefixMatch ?? containsMatch;
}

function pickBestResult(items: LiteratureItem[], claim: string) {
  const ranked = rankByEvidence(items, claim, (item) => ({ title: item.title, abstract: item.abstract }));
  const best = ranked[0];
  return best && evidenceScore(claim, best.title, best.abstract) >= 6 ? best : undefined;
}

function buildSystemPrompt(blockKind: "paragraph" | "heading", options: { literatureDb: boolean; hasCatalog: boolean }) {
  if (blockKind === "heading") {
    return [
      "You continue an academic document one heading at a time.",
      'Respond with ONLY a JSON object: {"sentence": string, "searchQuery": string}.',
      'The caret sits inside a heading: "sentence" is a short continuation of that heading (a few words, no verb sentence, no citation tokens, no ending period) and "searchQuery" is "".',
      "Match the language, tone, and terminology of the surrounding text; do not repeat what is already written.",
    ].join(" ");
  }
  const lines = [
    "You continue an academic document one sentence at a time, writing assistant style.",
    'Respond with ONLY a JSON object: {"sentence": string, "searchQuery": string}.',
    '"sentence" is exactly ONE sentence continuing the text at the caret: no leading or trailing whitespace, no quotes, no markdown, no lists, no newlines.',
  ];
  if (options.hasCatalog || options.literatureDb) {
    lines.push("Cite only when the supplied source evidence directly supports the specific claim you write. A title alone is not proof. Mirror the evidence wording for study findings: when evidence says associated, correlated, reported, or observed, use those terms rather than claiming it helped, improved, increased, reduced, mitigated, or caused an outcome. Do not add a mechanism, population, intervention, or outcome absent from the evidence.");
    lines.push('The sentence always ends with terminal punctuation — when it ends with a citation token, the period comes AFTER the token, like "…tasks [@key]."');
  }
  if (options.hasCatalog) {
    lines.push("Copy citation keys EXACTLY, character for character, from the reference catalog — never invent, abbreviate, or guess a key.");
  }
  if (options.literatureDb) {
    lines.push('If the claim needs a source the catalog does not cover, write [@SEARCH] instead of a key and set "searchQuery" to a concise English literature search query (max 12 words); otherwise "searchQuery" is "".');
  } else if (options.hasCatalog) {
    lines.push('The reference catalog is the only citable source: never write [@SEARCH] and never invent keys; when no catalog key fits the claim, write the sentence without a citation and set "searchQuery" to "".');
  } else {
    lines.push('No citation sources are available: write the sentence with no citation tokens at all and set "searchQuery" to "".');
  }
  if (options.hasCatalog || options.literatureDb) {
    lines.push("Add a new idea rather than paraphrasing the sentence before the caret. If no source supports a new claim, write a narrow transition without a citation or request a search. Do not invent findings or numbers. Keep searchQuery empty unless using [@SEARCH].");
  }
  lines.push("Match the language, tone, and terminology of the surrounding text; do not repeat what is already written.");
  return lines.join(" ");
}

function buildUserPrompt(input: {
  before: string;
  after: string;
  docTitle?: string;
  catalog: CatalogEntry[];
  literatureDb: boolean;
  avoidSentence?: string;
}) {
  const parts: string[] = [];
  if (input.docTitle) parts.push(`Document title: ${input.docTitle}`);
  parts.push(`Text before the caret:\n"""\n${input.before.trim() || "(nothing — the caret is at the start of the document)"}\n"""`);
  parts.push(`Text after the caret:\n"""\n${input.after.trim() || "(nothing — the caret is at the end of the document)"}\n"""`);
  if (input.avoidSentence) {
    parts.push(`The writer just accepted this AI sentence: "${input.avoidSentence}". Continue with a different idea. Do not restate or paraphrase it, even with a different citation.`);
  }
  if (input.catalog.length) {
    parts.push(`Reference catalog (year | first author | title | available evidence). To cite an entry, copy its key EXACTLY into [@key]:\n${input.catalog.map((entry) => `- ${entry.key} — ${entry.label}${entry.evidence ? ` | Evidence: ${entry.evidence}` : " | No abstract available"}`).join("\n")}`);
  } else if (input.literatureDb) {
    parts.push("Reference catalog: (empty — the sentence needs a source, cite [@SEARCH] and provide a searchQuery)");
  } else {
    parts.push("Reference catalog: (no citation sources available)");
  }
  return parts.join("\n\n");
}

export async function generateSentenceSuggestion(input: unknown): Promise<SentenceSuggestionResult> {
  const parsed = suggestionInputSchema.safeParse(input);
  if (!parsed.success) return { error: "The sentence suggestion request is invalid." };
  const { projectId, before, after, docTitle, blockKind, citedKeys, avoidSentence } = parsed.data;

  const user = await requireUser();
  const project = await getOwnedProject(user, projectId);
  if (!project) return { error: "Project not found." };

  const completionSettings = parseProjectSettings(project.settings).completion ?? DEFAULT_COMPLETION_SETTINGS;
  const { modelId, apiKey } = await getAiTaskConfig("sentenceSuggestion");
  if (!modelId || !apiKey) return { error: "Sentence suggestions are not configured." };
  const bounds = completionBounds(completionSettings.filters);

  const libraryPath = completionSettings.sources.library ? completionSettings.sources.libraryPath : null;
  const library = libraryPath ? await readLibrary(user.id, projectId, libraryPath) : { source: "", entries: [] as BibtexEntry[] };
  const librarySource = library.source;
  const libraryEntries = library.entries.filter((entry) => entryPassesFilters(entry, bounds));
  const catalog = buildCatalog(libraryEntries, citedKeys, before);

  let modelOutput: string;
  try {
    const openrouter = createOpenRouter({ apiKey });
    const generate = async () => generateText({
          model: openrouter(modelId),
          system: buildSystemPrompt(blockKind, {
            literatureDb: completionSettings.sources.literatureDb,
            hasCatalog: catalog.length > 0,
          }),
          prompt: buildUserPrompt({ before, after, docTitle, catalog, literatureDb: completionSettings.sources.literatureDb, avoidSentence }),
          maxOutputTokens: 300,
          temperature: 0.5,
          timeout: integerEnv("SENTENCE_SUGGESTION_TIMEOUT_MS", 12_000, 1_000),
        });
    modelOutput = (await generate()).text;
  } catch (error) {
    console.error("[sentence-suggestion] generation failed", error);
    return { error: "Sentence generation failed. Try again in a moment." };
  }

  const model = parseModelJson(modelOutput);
  let sentence = normalizeSentence(model.sentence);
  if (!sentence) return { error: "The model returned an empty sentence." };

  const catalogKeys = catalog.map((entry) => entry.key);
  const catalogKeySet = new Set(catalogKeys);
  sentence = sentence.replace(/\[([A-Za-z0-9_:.-]+)\]/g, (token, key: string) => catalogKeySet.has(key) ? `[@${key}]` : token);
  // Repair near-miss keys first (truncated or mistyped long keys); whatever
  // still does not resolve is treated as a deliberate search request.
  const unknown: string[] = [];
  for (const token of new Set([...sentence.matchAll(CITATION_TOKEN)].map((match) => match[1]))) {
    const resolved = resolveKey(token, catalogKeys);
    if (resolved) {
      sentence = sentence.replaceAll(`[@${token}]`, `[@${resolved}]`);
    } else {
      unknown.push(token);
    }
  }
  // The model asked for a source but forgot the query: the sentence itself
  // states the claim, so it (minus its citation tokens) stands in as the query.
  const fallbackQuery = sentence.replace(CITATION_TOKEN, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const searchQuery = (model.searchQuery.trim() || (unknown.length ? fallbackQuery : "")).slice(0, 200);

  let pendingItem: LiteratureItem | undefined;
  let citationKey: string | undefined;

  if (unknown.length > 0 && completionSettings.sources.literatureDb && searchQuery.length >= 2) {
    try {
      const results = await searchLiterature({ projectId, query: searchQuery, source: "all", openAccessOnly: false, page: 1 });
      const best = pickBestResult(results.items.filter((item) => itemPassesFilters(item, bounds)), sentence.replace(CITATION_TOKEN, " "));
      if (best) {
        const stem = fileStem(best);
        sentence = sentence.replaceAll(`[@${unknown[0]}]`, `[@${stem}]`);
        for (const key of unknown.slice(1)) sentence = sentence.replaceAll(`[@${key}]`, "");
        if (!catalogKeySet.has(stem)) {
          pendingItem = best;
          citationKey = stem;
        }
      } else {
        console.warn(`[sentence-suggestion] no literature results for "${searchQuery}" — citation dropped`);
        for (const key of unknown) sentence = sentence.replaceAll(`[@${key}]`, "");
      }
    } catch (error) {
      console.warn(`[sentence-suggestion] literature search for "${searchQuery}" failed: ${error instanceof Error ? error.message : error} — citation dropped`);
      for (const key of unknown) sentence = sentence.replaceAll(`[@${key}]`, "");
    }
  } else if (unknown.length > 0) {
    console.warn(`[sentence-suggestion] unresolvable citation key(s) dropped: ${unknown.join(", ").slice(0, 100)}`);
    for (const key of unknown) sentence = sentence.replaceAll(`[@${key}]`, "");
  }

  sentence = tidyCitations(sentence);
  if (!sentence) return { error: "The model returned an empty sentence." };
  // Headings are explicitly period-free; every paragraph sentence ends
  // terminated no matter how the model formatted it.
  if (blockKind === "paragraph") sentence = ensureTerminalPunctuation(sentence);

  // Cited keys that live in a chosen library but not in the document's
  // references.bib travel with the response so the client can copy the raw
  // entries over on accept.
  const pendingEntries: Array<{ key: string; bibtex: string }> = [];
  if (libraryPath && libraryPath !== PROJECT_BIBLIOGRAPHY_PATH && [...sentence.matchAll(CITATION_TOKEN)].some((match) => catalogKeySet.has(match[1]))) {
    const referencesKeys = new Set(parseBibtexEntries(await readWorkspaceFile(user.id, projectId, PROJECT_BIBLIOGRAPHY_PATH)).map((entry) => entry.key));
    const entryByKey = new Map(libraryEntries.map((entry) => [entry.key, entry]));
    const seen = new Set<string>();
    for (const match of sentence.matchAll(CITATION_TOKEN)) {
      const key = match[1];
      if (seen.has(key) || referencesKeys.has(key)) continue;
      const entry = entryByKey.get(key);
      if (entry) {
        seen.add(key);
        pendingEntries.push({ key, bibtex: librarySource.slice(entry.start, entry.end).trim() });
      }
    }
  }

  return { sentence, modelSource: "system" as const, citationKey, pendingItem, pendingEntries: pendingEntries.length ? pendingEntries : undefined };
}
