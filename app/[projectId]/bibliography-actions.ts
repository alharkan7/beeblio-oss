"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { integerEnv } from "@/lib/env-config";
import { joinBibtexAuthors, parseBibtexEntries, type BibtexEntryUpdate } from "@/lib/bibtex";
import { appendBibtexUpdates, appendManualEntries, normalizedDoi } from "@/lib/bibliography-store";
import { BIB_IMPORTS_DIRECTORY, PROJECT_BIBLIOGRAPHY_PATH, REFERENCES_DIRECTORY } from "@/lib/project-bibliography";
import { searchLiteratureProviders } from "@/lib/literature/search";
import {
  createAgentWorkspaceDirectory,
  deleteAgentWorkspacePath,
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
  writeAgentWorkspaceFile,
} from "@/lib/workspace-files";
import { getOwnedProject } from "./actions";
import { appSetting } from "@/lib/app-settings";

const entrySchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  type: z.string().trim().min(1).max(50).default("article"),
  key: z.string().trim().max(200).optional(),
  title: z.string().trim().min(1).max(2_000),
  authors: z.string().trim().max(10_000).optional(),
  year: z.string().trim().max(20).optional(),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  container: z.string().trim().max(2_000).optional(),
  publisher: z.string().trim().max(2_000).optional(),
  volume: z.string().trim().max(100).optional(),
  issue: z.string().trim().max(100).optional(),
  pages: z.string().trim().max(100).optional(),
  doi: z.string().trim().max(500).optional(),
  url: z.string().trim().max(4_000).optional(),
  abstract: z.string().trim().max(20_000).optional(),
  keywords: z.string().trim().max(2_000).optional(),
  note: z.string().trim().max(10_000).optional(),
  file: z.string().trim().max(1_000).optional(),
  month: z.string().trim().max(50).optional(),
  editor: z.string().trim().max(10_000).optional(),
  edition: z.string().trim().max(100).optional(),
  series: z.string().trim().max(500).optional(),
  address: z.string().trim().max(500).optional(),
  school: z.string().trim().max(500).optional(),
  institution: z.string().trim().max(500).optional(),
  organization: z.string().trim().max(500).optional(),
  howpublished: z.string().trim().max(1_000).optional(),
  urldate: z.string().trim().max(50).optional(),
});

type EntryInput = z.infer<typeof entrySchema>;
type CrossrefWork = {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  issued?: { "date-parts"?: unknown };
  published?: { "date-parts"?: unknown };
  "container-title"?: string[];
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  URL?: string;
  abstract?: string;
  subject?: string[];
  type?: string;
};

async function requireProject(projectId: string) {
  const user = await requireUser();
  if (!await getOwnedProject(user, projectId)) throw new Error("Project not found.");
  return user;
}

async function readBibliography(userId: string, projectId: string) {
  await createAgentWorkspaceDirectory(userId, projectId, REFERENCES_DIRECTORY);
  const files = await listAgentWorkspaceFiles(userId, projectId, REFERENCES_DIRECTORY);
  if (!files.some((file) => file.name === path.posix.basename(PROJECT_BIBLIOGRAPHY_PATH))) return "";
  return (await readAgentWorkspaceFile(userId, projectId, PROJECT_BIBLIOGRAPHY_PATH)).text();
}

const MONTH_ABBREVIATIONS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthFromPublicationDate(value?: string) {
  const match = value?.match(/^\d{4}-(\d{2})/);
  const month = match ? Number(match[1]) : undefined;
  return month && month >= 1 && month <= 12 ? MONTH_ABBREVIATIONS[month - 1] : "";
}

function plainText(value = "") {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Shared dedupe/append/keying lives in lib/bibliography-store.ts, alongside
// the agent's bibliography tools.

async function appendEntries(userId: string, projectId: string, incoming: BibtexEntryUpdate[]) {
  const current = await readBibliography(userId, projectId);
  const result = appendBibtexUpdates(current, incoming);
  const added = result.added.filter((entry) => !entry.alreadyExisted).length;
  if (added > 0) {
    await writeAgentWorkspaceFile(userId, projectId, PROJECT_BIBLIOGRAPHY_PATH, result.content);
  }
  revalidatePath(`/${projectId}`);
  return { added, skipped: result.added.length - added, bibliographyContent: result.content };
}

export async function addBibliographyEntry(input: unknown) {
  const parsed = entrySchema.safeParse(input);
  if (!parsed.success) return { success: false as const, error: "Complete at least the title and entry type." };
  try {
    const user = await requireProject(parsed.data.projectId);
    const { projectId, ...entry } = parsed.data;
    const current = await readBibliography(user.id, projectId);
    const result = appendManualEntries(current, [entry]);
    const added = result.added.filter((candidate) => !candidate.alreadyExisted).length;
    if (added > 0) {
      await writeAgentWorkspaceFile(user.id, projectId, PROJECT_BIBLIOGRAPHY_PATH, result.content);
    }
    revalidatePath(`/${projectId}`);
    return { success: true as const, added, skipped: result.added.length - added, bibliographyContent: result.content };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Reference could not be added." };
  }
}

export async function lookupBibliographyDoi(projectId: string, value: string) {
  try {
    await requireProject(projectId);
    const doi = normalizedDoi(value);
    if (!/^10\.\d{4,9}\/.+/.test(doi)) throw new Error("Enter a valid DOI, such as 10.1000/example.");
    const result = await searchLiteratureProviders({
      query: doi,
      source: "all",
      openAccessOnly: false,
      perSource: 8,
      page: 1,
    });
    const item = result.items.find((candidate) => normalizedDoi(candidate.doi) === doi);
    if (!item) throw new Error("No exact DOI match was found in the literature providers.");
    return {
      success: true as const,
      reference: {
        type: "article",
        key: "",
        title: item.title,
        authors: joinBibtexAuthors(item.authors),
        year: item.year ? String(item.year) : "",
        container: item.venue || "",
        publisher: "",
        volume: "",
        issue: "",
        pages: "",
        doi,
        url: item.url || `https://doi.org/${doi}`,
        abstract: item.abstract || "",
        keywords: (item.keywords || []).join(", "),
        note: "",
        file: "",
        month: monthFromPublicationDate(item.publicationDate),
        editor: "",
        edition: "",
        series: "",
        address: "",
        school: "",
        institution: "",
        organization: "",
        howpublished: "",
        urldate: new Date().toISOString().slice(0, 10),
      },
      sources: item.sources,
    };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "DOI lookup failed." };
  }
}

export async function importBibliographyFile(projectId: string, workspacePath: string) {
  try {
    const user = await requireProject(projectId);
    if (!workspacePath.startsWith(`${BIB_IMPORTS_DIRECTORY}/`) || !workspacePath.toLocaleLowerCase().endsWith(".bib")) throw new Error("Choose a BibTeX (.bib) file.");
    const response = await readAgentWorkspaceFile(user.id, projectId, workspacePath);
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > integerEnv("MAX_BIB_IMPORT_BYTES", 10_000_000, 1)) throw new Error("The BibTeX file exceeds the 10 MB limit.");
    const source = await response.text();
    await deleteAgentWorkspacePath(user.id, projectId, workspacePath).catch(() => undefined);
    const entries = parseBibtexEntries(source).map(({ type, key, fields }) => ({ type, key, fields }));
    if (!entries.length) throw new Error("No valid BibTeX entries were found.");
    const result = { success: true as const, ...(await appendEntries(user.id, projectId, entries)) };
    return result;
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "BibTeX import failed." };
  }
}

function crossrefDateParts(work: CrossrefWork) {
  const parts = work.issued?.["date-parts"] || work.published?.["date-parts"];
  return Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0] as unknown[] : [];
}

function yearOf(work: CrossrefWork) {
  const year = crossrefDateParts(work)[0];
  return typeof year === "number" ? String(year) : "";
}

function monthOf(work: CrossrefWork) {
  const month = crossrefDateParts(work)[1];
  return typeof month === "number" && month >= 1 && month <= 12 ? MONTH_ABBREVIATIONS[month - 1] : "";
}

function workInput(work: CrossrefWork): Omit<EntryInput, "projectId"> {
  return {
    type: work.type === "book" ? "book" : work.type === "proceedings-article" ? "inproceedings" : "article",
    title: work.title?.[0] || "Untitled paper",
    authors: joinBibtexAuthors((work.author || []).map((author) => author.name || [author.family, author.given].filter(Boolean).join(", "))),
    year: yearOf(work),
    container: work["container-title"]?.[0] || "",
    publisher: work.publisher || "",
    volume: work.volume || "",
    issue: work.issue || "",
    pages: work.page || "",
    doi: work.DOI || "",
    url: work.URL || "",
    abstract: plainText(work.abstract || ""),
    keywords: (work.subject || []).join(", "),
    month: monthOf(work),
  };
}

async function crossrefLookup(doi: string | undefined, query: string) {
  const url = doi
    ? new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    : new URL("https://api.crossref.org/works");
  if (!doi) { url.searchParams.set("query.bibliographic", query.slice(0, 1_000)); url.searchParams.set("rows", "1"); }
  const mailto = appSetting("CROSSREF_MAILTO");
  if (mailto) url.searchParams.set("mailto", mailto);
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": `Beeblio/0.0${mailto ? ` (mailto:${mailto})` : ""}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Crossref returned HTTP ${response.status}.`);
  const body = await response.json() as { message?: CrossrefWork | { items?: CrossrefWork[] } };
  return doi ? body.message as CrossrefWork : (body.message as { items?: CrossrefWork[] })?.items?.[0];
}

function titleAgreement(title: string, pdfHeader: string) {
  const ignored = new Set(["and", "the", "for", "from", "with", "that", "this", "into", "using"]);
  const tokens = title.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length >= 3 && !ignored.has(token)) || [];
  if (!tokens.length) return 0;
  const haystack = new Set(pdfHeader.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  return tokens.filter((token) => haystack.has(token)).length / tokens.length;
}

async function extractPdfHeader(bytes: Uint8Array) {
  // PDF.js disables real workers under Node and otherwise resolves its fake
  // worker relative to Next's generated server chunk. Importing the worker
  // explicitly registers WorkerMessageHandler on globalThis before the main
  // module creates PDFWorker, avoiding that chunk-relative lookup.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: bytes, useWorkerFetch: false });
  const document = await loadingTask.promise;
  const metadata = await document.getMetadata().catch(() => undefined);
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 2); pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent();
    pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
  }
  await loadingTask.destroy();
  const text = pages.join(" ").replace(/\s+/g, " ").trim();
  const info = metadata?.info as { Title?: string; Author?: string } | undefined;
  return { text, title: info?.Title?.trim() || "", author: info?.Author?.trim() || "" };
}

/**
 * Shared matching core of the PDF flows: reads a PDF stored in References,
 * pulls its header text, and matches the work on Crossref — by the DOI found
 * in the PDF text when present, otherwise a bibliographic query with a title
 * agreement check. Throws with a user-facing message when no reliable match
 * exists.
 */
async function matchPaperWork(userId: string, projectId: string, workspacePath: string) {
  if (!workspacePath.startsWith(`${REFERENCES_DIRECTORY}/`) ||
    workspacePath.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    !workspacePath.toLocaleLowerCase().endsWith(".pdf")) throw new Error("Choose a PDF paper.");
  const fileResponse = await readAgentWorkspaceFile(userId, projectId, workspacePath);
  const size = Number(fileResponse.headers.get("content-length") ?? 0);
  if (size > integerEnv("MAX_PAPER_IMPORT_BYTES", 50_000_000, 1)) throw new Error("The PDF exceeds the 50 MB limit.");
  // PDF.js may transfer/detach the TypedArray it receives. Keep the original
  // bytes exclusively for workspace storage and parse a disposable copy.
  const pdfBuffer = Buffer.from(await fileResponse.arrayBuffer());
  const header = await extractPdfHeader(Uint8Array.from(pdfBuffer));
  const doi = header.text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]?.replace(/[).,;]+$/, "");
  const safeName = path.posix.basename(workspacePath);
  const query = [header.title, header.author, header.text.slice(0, 1_500), path.parse(safeName).name].filter(Boolean).join(" ");
  const work = await crossrefLookup(doi, query);
  if (!work?.title?.[0]) throw new Error("No reliable bibliographic metadata could be matched. Try manual entry instead.");
  if (!doi && titleAgreement(work.title[0], `${header.title} ${header.text.slice(0, 4_000)}`) < 0.6) {
    throw new Error("The closest metadata result did not match the PDF title closely enough. Try manual entry instead.");
  }
  return { work, title: work.title[0], doi };
}

export async function importPaperCitation(projectId: string, workspacePath: string) {
  try {
    const user = await requireProject(projectId);
    const { work, title, doi } = await matchPaperWork(user.id, projectId, workspacePath);
    const current = await readBibliography(user.id, projectId);
    // JabRef/Zotero file-attachment convention (<path>:PDF): lets reference
    // managers and the agent resolve the entry back to the stored PDF.
    const result = appendManualEntries(current, [{
      ...workInput(work),
      file: `${workspacePath}:PDF`,
    }]);
    const added = result.added.filter((candidate) => !candidate.alreadyExisted).length;
    if (added > 0) {
      await writeAgentWorkspaceFile(user.id, projectId, PROJECT_BIBLIOGRAPHY_PATH, result.content);
    }
    revalidatePath(`/${projectId}`);
    return {
      success: true as const,
      added,
      skipped: result.added.length - added,
      bibliographyContent: result.content,
      title,
      matchedBy: doi ? "DOI" : "Crossref title search",
    };
  } catch (error) {
    console.error("[paper-bibliography-import] failed", error);
    return { success: false as const, error: error instanceof Error ? error.message : "Paper metadata could not be extracted." };
  }
}

/**
 * The Add Reference form's PDF import: matches the work exactly like the
 * Library drop (matchPaperWork) but returns the fields for the form instead
 * of appending to references.bib — the user reviews and saves them like a
 * manual entry.
 */
export async function extractPaperReference(projectId: string, workspacePath: string) {
  try {
    const user = await requireProject(projectId);
    const { work, doi } = await matchPaperWork(user.id, projectId, workspacePath);
    const input = workInput(work);
    return {
      success: true as const,
      reference: {
        ...input,
        key: "",
        doi: input.doi || doi || "",
        file: `${workspacePath}:PDF`,
        note: "",
        editor: "",
        edition: "",
        series: "",
        address: "",
        school: "",
        institution: "",
        organization: "",
        howpublished: "",
        urldate: new Date().toISOString().slice(0, 10),
      },
      matchedBy: doi ? "DOI" : "Crossref title search",
    };
  } catch (error) {
    console.error("[paper-bibliography-extract] failed", error);
    return { success: false as const, error: error instanceof Error ? error.message : "Paper metadata could not be extracted." };
  }
}
