import { integerEnv } from "@/lib/env-config";
import type {
  LiteratureItem,
  LiteratureMetrics,
  LiteratureProviderStatus,
  LiteratureSource,
  LiteratureSourceSelection,
} from "./types";
import { appSetting } from "@/lib/app-settings";
import type { SettingName } from "@/lib/app-settings-registry";

export type UnsignedLiteratureItem = Omit<LiteratureItem, "saveToken">;

type ProviderResult = {
  source: LiteratureSource;
  items: UnsignedLiteratureItem[];
  status: LiteratureProviderStatus;
};

type ProviderPage = {
  items: UnsignedLiteratureItem[];
  hasMore: boolean;
};


const PROVIDER_TIMEOUT_MS = integerEnv("LITERATURE_PROVIDER_TIMEOUT_MS", 12_000, 1_000);
const MAX_MERGED_RESULTS = integerEnv("LITERATURE_MAX_MERGED_RESULTS", 30, 1);
const MAX_PAGE = integerEnv("LITERATURE_MAX_PAGE", 50, 1);

class ProviderRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Provider request failed with status ${status}`);
    this.status = status;
  }
}

function env(name: SettingName) {
  return appSetting(name);
}

function addOptionalParameter(url: URL, name: string, value?: string) {
  if (value) url.searchParams.set(name, value);
}

async function fetchJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new ProviderRequestError(response.status);
  return response.json() as Promise<T>;
}

function normalizeDoi(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return normalized.startsWith("10.") && normalized.includes("/") ? normalized : undefined;
}

function normalizeUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Several scholarly APIs still return legacy HTTP links for services that
    // support HTTPS. Prefer the encrypted form for browser links and downloads.
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return undefined;
  }
}

function pdfDownloadPriority(value: string) {
  const hostname = new URL(value).hostname.toLocaleLowerCase();
  const repositoryHints = [
    "archive.org",
    "arxiv.org",
    "biorxiv.org",
    "core.ac.uk",
    "eprints",
    "europepmc.org",
    "figshare.com",
    "hal.science",
    "medrxiv.org",
    "ncbi.nlm.nih.gov",
    "osf.io",
    "pmc-oa-opendata.s3.amazonaws.com",
    "repository",
    "zenodo.org",
  ];
  return repositoryHints.some((hint) => hostname.includes(hint)) ? 0 : 1;
}

function orderedPdfUrls(values: unknown[]) {
  return [...new Set(values
    .map(normalizeUrl)
    .filter((value): value is string => Boolean(value)))]
    .sort((left, right) => pdfDownloadPriority(left) - pdfDownloadPriority(right))
    .slice(0, 30);
}

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function keywordList(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const keywords = [...new Set(values.map((value) => text(value)).filter(Boolean))].slice(0, 10);
  return keywords.length ? keywords : undefined;
}

function yearFrom(value: unknown) {
  if (typeof value === "number" && value >= 1000 && value <= 9999) return value;
  const match = typeof value === "string" ? value.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/) : null;
  return match ? Number(match[1]) : undefined;
}

function fallbackUrl(doi: string | undefined, candidate: unknown, source: LiteratureSource, id: string) {
  if (doi) return `https://doi.org/${doi}`;
  return normalizeUrl(candidate) ||
    (source === "pubmed" ? `https://pubmed.ncbi.nlm.nih.gov/${id}/` : "https://openalex.org");
}

async function resolvePmcPdfUrl(pmcid: string) {
  try {
    const url = new URL("https://pmc-oa-opendata.s3.amazonaws.com/");
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", `${pmcid}.`);
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const xml = await response.text();
    const keys = [...xml.matchAll(/<Key>([^<]+\.pdf)<\/Key>/g)]
      .map((match) => match[1])
      .filter((key) => {
        const parts = key.split("/");
        return parts.length === 2 && parts[1] === `${parts[0]}.pdf`;
      })
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    const key = keys[0];
    if (!key) return undefined;
    return `https://pmc-oa-opendata.s3.amazonaws.com/${key.split("/").map(encodeURIComponent).join("/")}`;
  } catch {
    return undefined;
  }
}

function openAlexAbstract(index: unknown) {
  if (!index || typeof index !== "object" || Array.isArray(index)) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number" && position >= 0 && position < 10_000) words[position] = word;
    }
  }
  return text(words.filter(Boolean).join(" ")) || undefined;
}

type OpenAlexLocation = {
  is_oa?: boolean;
  landing_page_url?: string;
  pdf_url?: string;
  source?: { display_name?: string };
};

type OpenAlexWork = {
  id?: string;
  doi?: string;
  title?: string;
  publication_year?: number;
  publication_date?: string;
  authorships?: { author?: { display_name?: string }; raw_author_name?: string }[];
  primary_location?: OpenAlexLocation;
  best_oa_location?: OpenAlexLocation | null;
  locations?: OpenAlexLocation[];
  open_access?: { is_oa?: boolean };
  cited_by_count?: number;
  abstract_inverted_index?: unknown;
  keywords?: { display_name?: string }[];
  ids?: { pmid?: string; pmcid?: string };
  type?: string;
  referenced_works_count?: number;
  referenced_works?: string[];
};

async function searchOpenAlex(
  query: string,
  limit: number,
  openAccessOnly: boolean,
  page: number,
): Promise<ProviderPage> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(limit));
  url.searchParams.set("page", String(page));
  addOptionalParameter(url, "api_key", env("OPENALEX_API_KEY"));
  addOptionalParameter(url, "mailto", env("OPENALEX_EMAIL"));
  if (openAccessOnly) url.searchParams.set("filter", "open_access.is_oa:true");

  const body = await fetchJson<{ meta?: { count?: number }; results?: OpenAlexWork[] }>(url);
  const items: UnsignedLiteratureItem[] = (body.results || []).flatMap((work) => {
    const title = text(work.title);
    const rawId = text(work.id);
    const id = rawId.split("/").at(-1) || rawId;
    if (!title || !id) return [];
    const doi = normalizeDoi(work.doi);
    const oaLocation = work.best_oa_location;
    const browserPdfUrl = normalizeUrl(oaLocation?.pdf_url);
    const pdfUrls = orderedPdfUrls([
      oaLocation?.pdf_url,
      work.primary_location?.is_oa ? work.primary_location.pdf_url : undefined,
      ...(work.locations || [])
        .filter((location) => location.is_oa)
        .map((location) => location.pdf_url),
    ]);
    const pdfUrl = pdfUrls[0];
    const openAccessUrl = browserPdfUrl || normalizeUrl(oaLocation?.landing_page_url);
    const pmidUrl = normalizeUrl(work.ids?.pmid);
    const pmcidUrl = normalizeUrl(work.ids?.pmcid);
    return [{
      id: `openalex:${id}`,
      title,
      authors: (work.authorships || [])
        .map((authorship) => text(authorship.author?.display_name))
        .filter(Boolean),
      year: yearFrom(work.publication_year),
      publicationDate: text(work.publication_date) || undefined,
      venue: text(work.primary_location?.source?.display_name) || undefined,
      abstract: openAlexAbstract(work.abstract_inverted_index),
      keywords: keywordList(work.keywords?.map((keyword) => text(keyword.display_name))),
      doi,
      pmid: pmidUrl?.split("/").filter(Boolean).at(-1),
      pmcid: pmcidUrl?.split("/").filter(Boolean).at(-1)?.toUpperCase(),
      url: fallbackUrl(doi, work.primary_location?.landing_page_url || work.id, "openalex", id),
      openAccessUrl,
      pdfUrl,
      pdfUrls: pdfUrls.length > 0 ? pdfUrls : undefined,
      isOpenAccess: Boolean(work.open_access?.is_oa || openAccessUrl),
      citationCount: positiveInteger(work.cited_by_count),
      sources: ["openalex"],
    }];
  });
  const resolvedItems = await Promise.all(items.map(async (item) => {
    if (!item.pmcid) return item;
    const pmcPdfUrl = await resolvePmcPdfUrl(item.pmcid);
    if (!pmcPdfUrl) return item;
    const pdfUrls = orderedPdfUrls([pmcPdfUrl, ...(item.pdfUrls || []), item.pdfUrl]);
    return { ...item, pdfUrl: pdfUrls[0], pdfUrls };
  }));
  const count = positiveInteger(body.meta?.count);
  return {
    items: resolvedItems,
    hasMore: count !== undefined ? page * limit < count : (body.results || []).length === limit,
  };
}

function crossrefDate(item: { published?: { "date-parts"?: unknown }; issued?: { "date-parts"?: unknown } }) {
  const parts = item.published?.["date-parts"] || item.issued?.["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return {};
  const [year, month, day] = parts[0] as unknown[];
  const validYear = yearFrom(year);
  if (!validYear) return {};
  const publicationDate = [validYear, month, day]
    .filter((part) => typeof part === "number")
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
    .join("-");
  return { year: validYear, publicationDate };
}

async function searchCrossref(query: string, limit: number, page: number): Promise<ProviderPage> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", String(limit));
  url.searchParams.set("offset", String((page - 1) * limit));
  addOptionalParameter(url, "mailto", env("CROSSREF_MAILTO"));
  const headers = new Headers({ accept: "application/json" });
  const mailto = env("CROSSREF_MAILTO");
  headers.set("user-agent", `Beeblio/0.0${mailto ? ` (mailto:${mailto})` : ""}`);

  type CrossrefItem = {
    DOI?: string;
    title?: string[];
    author?: { given?: string; family?: string; name?: string }[];
    published?: { "date-parts"?: unknown };
    issued?: { "date-parts"?: unknown };
    "container-title"?: string[];
    abstract?: string;
    subject?: string[];
    URL?: string;
    "is-referenced-by-count"?: number;
  };
  const body = await fetchJson<{ message?: { items?: CrossrefItem[]; "total-results"?: number } }>(url, { headers });
  const items: UnsignedLiteratureItem[] = (body.message?.items || []).flatMap((item) => {
    const title = text(item.title?.[0]);
    const doi = normalizeDoi(item.DOI);
    if (!title || !doi) return [];
    const { year, publicationDate } = crossrefDate(item);
    return [{
      id: `crossref:${doi}`,
      title,
      authors: (item.author || []).map((author) =>
        text(author.name || [author.given, author.family].filter(Boolean).join(" ")),
      ).filter(Boolean),
      year,
      publicationDate,
      venue: text(item["container-title"]?.[0]) || undefined,
      abstract: text(item.abstract?.replace(/<[^>]*>/g, " ")) || undefined,
      keywords: keywordList(item.subject),
      doi,
      url: fallbackUrl(doi, item.URL, "crossref", doi),
      isOpenAccess: false,
      citationCount: positiveInteger(item["is-referenced-by-count"]),
      sources: ["crossref"],
    }];
  });
  const total = positiveInteger(body.message?.["total-results"]);
  return {
    items,
    hasMore: total !== undefined ? page * limit < total : (body.message?.items || []).length === limit,
  };
}

async function searchPubMed(
  query: string,
  limit: number,
  openAccessOnly: boolean,
  page: number,
): Promise<ProviderPage> {
  const common = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    tool: "beeblio",
  });
  const apiKey = env("NCBI_API_KEY");
  const contactEmail = env("CROSSREF_MAILTO") || env("OPENALEX_EMAIL");
  if (apiKey) common.set("api_key", apiKey);
  if (contactEmail) common.set("email", contactEmail);

  const searchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  searchUrl.search = common.toString();
  searchUrl.searchParams.set("retmax", String(limit));
  searchUrl.searchParams.set("retstart", String((page - 1) * limit));
  searchUrl.searchParams.set("term", openAccessOnly ? `(${query}) AND free full text[sb]` : query);
  const search = await fetchJson<{ esearchresult?: { count?: string; idlist?: string[] } }>(searchUrl);
  const ids = search.esearchresult?.idlist || [];
  const total = Number(search.esearchresult?.count);
  const hasMore = Number.isFinite(total) ? page * limit < total : ids.length === limit;
  if (ids.length === 0) return { items: [], hasMore: false };

  const summaryUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  summaryUrl.search = common.toString();
  summaryUrl.searchParams.set("id", ids.join(","));
  type PubMedSummary = {
    uid?: string;
    title?: string;
    pubdate?: string;
    fulljournalname?: string;
    source?: string;
    authors?: { name?: string }[];
    articleids?: { idtype?: string; value?: string }[];
  };
  const summary = await fetchJson<{ result?: Record<string, PubMedSummary | string[]> }>(summaryUrl);
  const items: UnsignedLiteratureItem[] = ids.flatMap((id) => {
    const record = summary.result?.[id];
    if (!record || Array.isArray(record)) return [];
    const title = text(record.title);
    if (!title) return [];
    const articleIds = record.articleids || [];
    const doi = normalizeDoi(articleIds.find((value) => value.idtype === "doi")?.value);
    const pmcid = text(articleIds.find((value) => value.idtype === "pmc")?.value).toUpperCase() || undefined;
    return [{
      id: `pubmed:${id}`,
      title,
      authors: (record.authors || []).map((author) => text(author.name)).filter(Boolean),
      year: yearFrom(record.pubdate),
      publicationDate: text(record.pubdate) || undefined,
      venue: text(record.fulljournalname || record.source) || undefined,
      doi,
      pmid: id,
      pmcid,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      openAccessUrl: pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` : undefined,
      isOpenAccess: Boolean(pmcid),
      sources: ["pubmed"],
    }];
  });
  const resolvedItems = await Promise.all(items.map(async (item) => {
    const pdfUrl = item.pmcid ? await resolvePmcPdfUrl(item.pmcid) : undefined;
    return {
      ...item,
      pdfUrl,
      pdfUrls: pdfUrl ? [pdfUrl] : undefined,
    };
  }));
  return { items: resolvedItems, hasMore };
}

function providerMessage(error: unknown) {
  if (error instanceof ProviderRequestError) {
    if (error.status === 401 || error.status === 403) return "The provider rejected its configured credentials.";
    if (error.status === 429) return "The provider rate limit was reached. Try again shortly.";
    return `The provider returned HTTP ${error.status}.`;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "The provider timed out.";
  return "The provider could not be reached.";
}

async function runProvider(
  source: LiteratureSource,
  search: () => Promise<ProviderPage>,
): Promise<ProviderResult> {
  try {
    const result = await search();
    return {
      source,
      items: result.items,
      status: { source, ok: true, resultCount: result.items.length, hasMore: result.hasMore },
    };
  } catch (error) {
    console.warn(`[literature-search] ${source} failed`, error instanceof Error ? error.message : error);
    return {
      source,
      items: [],
      status: { source, ok: false, resultCount: 0, message: providerMessage(error) },
    };
  }
}

function normalizedTitleKey(title: string) {
  return title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// PubMed reports bare initials ("Matsuura Y") while OpenAlex and Crossref
// usually carry full given names. Score lists so richer names win when the
// lists are comparable, but a much longer initials-only list (more complete
// authorship) still wins: twice the multi-letter name words, plus one per
// author.
function authorListScore(authors: readonly string[]) {
  let detail = 0;
  for (const author of authors) detail += author.match(/\p{L}{2,}/gu)?.length ?? 0;
  return detail * 2 + authors.length;
}

function mergeItem(current: UnsignedLiteratureItem, candidate: UnsignedLiteratureItem): UnsignedLiteratureItem {
  const pdfUrls = orderedPdfUrls([
    ...(current.pdfUrls || []),
    current.pdfUrl,
    ...(candidate.pdfUrls || []),
    candidate.pdfUrl,
  ]);
  return {
    ...current,
    authors: authorListScore(candidate.authors) > authorListScore(current.authors)
      ? candidate.authors
      : current.authors,
    year: current.year || candidate.year,
    publicationDate: current.publicationDate || candidate.publicationDate,
    venue: current.venue || candidate.venue,
    abstract: (current.abstract?.length || 0) >= (candidate.abstract?.length || 0)
      ? current.abstract
      : candidate.abstract,
    keywords: keywordList([...(current.keywords || []), ...(candidate.keywords || [])]),
    doi: current.doi || candidate.doi,
    pmid: current.pmid || candidate.pmid,
    pmcid: current.pmcid || candidate.pmcid,
    openAccessUrl: current.openAccessUrl || candidate.openAccessUrl,
    pdfUrl: pdfUrls[0],
    pdfUrls: pdfUrls.length > 0 ? pdfUrls : undefined,
    isOpenAccess: current.isOpenAccess || candidate.isOpenAccess,
    citationCount: Math.max(current.citationCount || 0, candidate.citationCount || 0) || undefined,
    sources: [...new Set([...current.sources, ...candidate.sources])],
  };
}

function deduplicate(items: UnsignedLiteratureItem[]) {
  const merged = new Map<string, UnsignedLiteratureItem>();
  const doiKeys = new Map<string, string>();
  const titleKeys = new Map<string, string>();
  for (const item of items) {
    const titleKey = normalizedTitleKey(item.title);
    const existingKey = (item.doi && doiKeys.get(item.doi)) || titleKeys.get(titleKey);
    if (existingKey) {
      const current = merged.get(existingKey);
      if (current) merged.set(existingKey, mergeItem(current, item));
      continue;
    }
    const key = item.doi ? `doi:${item.doi}` : item.pmid ? `pmid:${item.pmid}` : `title:${titleKey}`;
    merged.set(key, item);
    if (item.doi) doiKeys.set(item.doi, key);
    titleKeys.set(titleKey, key);
  }
  return [...merged.values()];
}

function roundRobin(groups: UnsignedLiteratureItem[][]) {
  const result: UnsignedLiteratureItem[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (item) result.push(item);
    }
  }
  return result;
}

export async function searchLiteratureProviders(input: {
  query: string;
  source: LiteratureSourceSelection;
  openAccessOnly: boolean;
  perSource: number;
  page: number;
}) {
  const { query, source, openAccessOnly, perSource, page } = input;
  const providers: Record<LiteratureSource, () => Promise<ProviderPage>> = {
    openalex: () => searchOpenAlex(query, perSource, openAccessOnly, page),
    crossref: async () => {
      const result = await searchCrossref(query, perSource, page);
      return openAccessOnly ? { ...result, hasMore: false } : result;
    },
    pubmed: () => searchPubMed(query, perSource, openAccessOnly, page),
  };
  const selected = source === "all"
    ? (Object.keys(providers) as LiteratureSource[])
    : [source];
  const results = await Promise.all(selected.map((provider) =>
    runProvider(provider, providers[provider]),
  ));
  let items = deduplicate(roundRobin(results.map((result) => result.items)));
  if (openAccessOnly) items = items.filter((item) => item.isOpenAccess);
  return {
    items: items.slice(0, source === "all" ? MAX_MERGED_RESULTS : perSource),
    providers: results.map((result) => result.status),
    page,
    hasMore: page < MAX_PAGE && results.some((result) => result.status.hasMore),
  };
}

// ─── Single-work lookup ─────────────────────────────────────────────────────

/** A resolved scholarly record for one work, as served by OpenAlex. */
export type LiteratureWork = {
  openalexId: string;
  title: string;
  authors: string[];
  year?: number;
  publicationDate?: string;
  venue?: string;
  workType?: string;
  abstract?: string;
  keywords?: string[];
  doi?: string;
  pmid?: string;
  pmcid?: string;
  url: string;
  openAccessUrl?: string;
  pdfUrl?: string;
  pdfUrls?: string[];
  isOpenAccess: boolean;
  citationCount?: number;
  referencedWorksCount?: number;
};

/** One entry of a work's reference list, resolved through OpenAlex. */
export type LiteratureReference = {
  openalexId: string;
  doi?: string;
  title?: string;
  year?: number;
  citationCount?: number;
};

// Turns a user- or tool-supplied identifier into the external-id segment of
// `https://api.openalex.org/works/{segment}`. Accepts DOIs (bare, `doi:`- or
// `crossref:`-prefixed, or doi.org URLs), PMIDs (bare, `pubmed:`-prefixed, or
// pubmed.ncbi.nlm.nih.gov URLs), and OpenAlex IDs (bare `W...`, `openalex:`-
// prefixed, or openalex.org URLs) — the same forms search results carry.
function openAlexWorkSegment(paperId: string): string | undefined {
  const value = paperId.trim();
  if (!value) return undefined;

  const openalexPrefixed = value.match(/^openalex:\s*(w\d+)$/i);
  if (openalexPrefixed) return `W${openalexPrefixed[1].slice(1)}`;
  const pmidPrefixed = value.match(/^pubmed:\s*(\d{1,9})$/i);
  if (pmidPrefixed) return `pmid:${pmidPrefixed[1]}`;
  const doiPrefixed = value.match(/^(?:doi|crossref):\s*(.+)$/i);
  if (doiPrefixed) {
    const doi = normalizeDoi(doiPrefixed[1]);
    return doi ? `doi:${doi}` : undefined;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "pubmed.ncbi.nlm.nih.gov") {
      const pmid = url.pathname.match(/(\d{1,9})/)?.[1];
      return pmid ? `pmid:${pmid}` : undefined;
    }
    if (host === "openalex.org") {
      const id = url.pathname.match(/(w\d+)/i)?.[1];
      return id ? `W${id.slice(1)}` : undefined;
    }
  } catch {
    // Not a URL; fall through to the bare forms.
  }

  // normalizeDoi also strips doi.org URL prefixes and `doi:` markers.
  const doi = normalizeDoi(value);
  if (doi) return `doi:${doi}`;
  const bareOpenalex = value.match(/^(w\d+)$/i);
  if (bareOpenalex) return `W${bareOpenalex[1].slice(1)}`;
  if (/^\d{1,9}$/.test(value)) return `pmid:${value}`;
  return undefined;
}

const OPENALEX_WORK_SELECT = [
  "id",
  "doi",
  "title",
  "publication_year",
  "publication_date",
  "authorships",
  "primary_location",
  "best_oa_location",
  "locations",
  "open_access",
  "cited_by_count",
  "abstract_inverted_index",
  "ids",
  "keywords",
  "type",
  "referenced_works_count",
  "referenced_works",
].join(",");

const OPENALEX_BATCH_REFERENCE_LIMIT = 50;

// Fetches one work from OpenAlex by DOI, PMID, or OpenAlex ID and, on request,
// resolves its reference list to titles and years with a single batched call.
export async function lookupLiteratureWork(input: {
  paperId: string;
  includeReferences?: boolean;
  referenceLimit?: number;
}): Promise<{
  work: LiteratureWork;
  references: LiteratureReference[];
  referencesTruncated: boolean;
  referencesUnavailable: boolean;
}> {
  const segment = openAlexWorkSegment(input.paperId);
  if (!segment) {
    throw new Error(
      `Unsupported paper identifier: ${input.paperId}. Use a DOI, PMID, OpenAlex ID, or a doi.org, pubmed.ncbi.nlm.nih.gov, or openalex.org URL.`,
    );
  }
  const includeReferences = input.includeReferences ?? false;
  const referenceLimit = Math.min(
    Math.max(input.referenceLimit ?? 10, 1),
    OPENALEX_BATCH_REFERENCE_LIMIT,
  );

  const url = new URL(`https://api.openalex.org/works/${segment}`);
  url.searchParams.set("select", OPENALEX_WORK_SELECT);
  addOptionalParameter(url, "api_key", env("OPENALEX_API_KEY"));
  addOptionalParameter(url, "mailto", env("OPENALEX_EMAIL"));

  let body: OpenAlexWork;
  try {
    body = await fetchJson<OpenAlexWork>(url);
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) {
      throw new Error(`OpenAlex has no record for ${input.paperId}.`);
    }
    throw error;
  }

  const rawId = text(body.id);
  const openalexId = rawId.split("/").at(-1) || rawId;
  const title = text(body.title);
  if (!openalexId || !title) throw new Error("The OpenAlex record is missing an id or title.");
  const doi = normalizeDoi(body.doi);
  const oaLocation = body.best_oa_location;
  const pdfUrls = orderedPdfUrls([
    oaLocation?.pdf_url,
    body.primary_location?.is_oa ? body.primary_location.pdf_url : undefined,
    ...(body.locations || [])
      .filter((location) => location.is_oa)
      .map((location) => location.pdf_url),
  ]);
  const openAccessUrl = normalizeUrl(oaLocation?.pdf_url) || normalizeUrl(oaLocation?.landing_page_url);
  const pmidUrl = normalizeUrl(body.ids?.pmid);
  const pmcidUrl = normalizeUrl(body.ids?.pmcid);
  const work: LiteratureWork = {
    openalexId,
    title,
    authors: (body.authorships || [])
      .map((authorship) => text(authorship.raw_author_name || authorship.author?.display_name))
      .filter(Boolean),
    year: yearFrom(body.publication_year),
    publicationDate: text(body.publication_date) || undefined,
    venue: text(body.primary_location?.source?.display_name) || undefined,
    workType: text(body.type) || undefined,
    abstract: openAlexAbstract(body.abstract_inverted_index),
    keywords: keywordList(body.keywords?.map((keyword) => text(keyword.display_name))),
    doi,
    pmid: pmidUrl?.split("/").filter(Boolean).at(-1),
    pmcid: pmcidUrl?.split("/").filter(Boolean).at(-1)?.toUpperCase(),
    url: fallbackUrl(doi, body.primary_location?.landing_page_url || body.id, "openalex", openalexId),
    openAccessUrl,
    pdfUrl: pdfUrls[0],
    pdfUrls: pdfUrls.length > 0 ? pdfUrls : undefined,
    isOpenAccess: Boolean(body.open_access?.is_oa || openAccessUrl),
    citationCount: positiveInteger(body.cited_by_count),
    referencedWorksCount: positiveInteger(body.referenced_works_count),
  };

  const referencedIds = (body.referenced_works || [])
    .map((reference) => text(reference).split("/").at(-1))
    .filter((id): id is string => id !== undefined && /^W\d+$/.test(id));
  const referencesTruncated = referencedIds.length > referenceLimit;
  let references: LiteratureReference[] = [];
  let referencesUnavailable = false;
  const wanted = referencedIds.slice(0, referenceLimit);
  if (includeReferences && wanted.length > 0) {
    try {
      const batchUrl = new URL("https://api.openalex.org/works");
      batchUrl.searchParams.set("filter", `openalex_id:${wanted.join("|")}`);
      batchUrl.searchParams.set("per-page", String(wanted.length));
      batchUrl.searchParams.set("select", "id,doi,title,publication_year,cited_by_count");
      addOptionalParameter(batchUrl, "api_key", env("OPENALEX_API_KEY"));
      addOptionalParameter(batchUrl, "mailto", env("OPENALEX_EMAIL"));
      const batch = await fetchJson<{ results?: OpenAlexWork[] }>(batchUrl);
      references = (batch.results || []).map((result) => ({
        openalexId: text(result.id).split("/").at(-1) || text(result.id),
        doi: normalizeDoi(result.doi),
        title: text(result.title) || undefined,
        year: yearFrom(result.publication_year),
        citationCount: positiveInteger(result.cited_by_count),
      }));
    } catch (error) {
      console.warn("[literature-work] reference batch failed", error instanceof Error ? error.message : error);
      referencesUnavailable = true;
    }
  }

  return { work, references, referencesTruncated, referencesUnavailable };
}

// One GET per DOI against OpenAlex's single-work endpoint — much cheaper than
// a full search, and OpenAlex is the only provider that reports both the
// citation count and the open-access flag. A DOI it does not know (or a
// transient failure) yields an entry with no metrics rather than an error.
export async function lookupLiteratureMetrics(dois: string[]): Promise<LiteratureMetrics[]> {
  const normalized = [...new Set(dois.map(normalizeDoi).filter((doi): doi is string => Boolean(doi)))];
  return Promise.all(normalized.map(async (doi) => {
    const url = new URL(`https://api.openalex.org/works/doi:${doi}`);
    addOptionalParameter(url, "api_key", env("OPENALEX_API_KEY"));
    addOptionalParameter(url, "mailto", env("OPENALEX_EMAIL"));
    try {
      const body = await fetchJson<{ cited_by_count?: unknown; open_access?: { is_oa?: boolean } }>(url);
      return {
        doi,
        citationCount: positiveInteger(body.cited_by_count),
        isOpenAccess: Boolean(body.open_access?.is_oa),
      };
    } catch (error) {
      console.warn(`[literature-metrics] lookup failed for ${doi}`, error instanceof Error ? error.message : error);
      return { doi };
    }
  }));
}
