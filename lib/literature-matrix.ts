// Literature matrix (.matrix) files: structured comparison tables where each
// row is a paper keyed by its references.bib citation key and each column is
// either a derived bibliography field (resolved from references.bib at render
// time) or a stored custom comparison column. Pure TypeScript with no runtime
// imports so the same code runs in the web app (editor, server actions) and
// the agent runtime (update_matrix tool).

import { ANALYSIS_DIRECTORY } from "./research-workspace.ts";

export const MATRIX_EXTENSION = "matrix";
export const DEFAULT_MATRIX_NAME = "literature-matrix.matrix";
export const DEFAULT_MATRIX_PATH = `${ANALYSIS_DIRECTORY}/${DEFAULT_MATRIX_NAME}`;

export const DERIVED_COLUMN_SOURCES = [
  "year",
  "authors",
  "venue",
  "publisher",
  "doi",
  "type",
] as const;

export type DerivedColumnSource = (typeof DERIVED_COLUMN_SOURCES)[number];

export type DerivedColumn = {
  kind: "derived";
  id: DerivedColumnSource;
  source: DerivedColumnSource;
};

export type CustomColumnOrigin = "seed" | "user" | "agent";

export type CustomColumn = {
  kind: "custom";
  id: string;
  label: string;
  description?: string;
  origin?: CustomColumnOrigin;
};

export type MatrixColumn = DerivedColumn | CustomColumn;

export type MatrixRowSnapshot = {
  title?: string;
  authors?: string;
  year?: number;
  venue?: string;
};

export type MatrixRow = {
  citationKey: string;
  doi?: string;
  snapshot: MatrixRowSnapshot;
  cells: Record<string, string>;
};

export type LiteratureMatrix = {
  version: 1;
  columns: MatrixColumn[];
  rows: MatrixRow[];
};

export type MatrixCitationEntry = {
  citationKey: string;
  doi?: string;
  title?: string;
  authors?: string;
  year?: number;
  venue?: string;
};

const MAX_COLUMNS = 64;
const MAX_ROWS = 500;
const MAX_LABEL_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_TEXT_LENGTH = 20_000;
const COLUMN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function invalid(reason: string): never {
  throw new Error(`Invalid matrix file: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maximum);
}

function parseColumns(value: unknown): MatrixColumn[] {
  if (!Array.isArray(value)) invalid("columns must be an array");
  if (value.length > MAX_COLUMNS) invalid(`more than ${MAX_COLUMNS} columns`);
  return value.map((entry, index): MatrixColumn => {
    if (!isRecord(entry)) invalid(`column ${index + 1} is not an object`);
    if (entry.kind === "derived") {
      if (
        typeof entry.source !== "string" ||
        !DERIVED_COLUMN_SOURCES.includes(entry.source as DerivedColumnSource)
      ) {
        invalid(`column ${index + 1} has an unknown derived source`);
      }
      const source = entry.source as DerivedColumnSource;
      return { kind: "derived", id: source, source };
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!COLUMN_ID_PATTERN.test(id)) {
      invalid(`column ${index + 1} has an invalid id ("${id}")`);
    }
    if (DERIVED_COLUMN_SOURCES.includes(id as DerivedColumnSource)) {
      invalid(`column ${index + 1} id "${id}" collides with a derived source`);
    }
    const label = trimmedString(entry.label, MAX_LABEL_LENGTH);
    if (!label) invalid(`column "${id}" is missing a label`);
    const description = trimmedString(entry.description, MAX_DESCRIPTION_LENGTH);
    const origin =
      entry.origin === "seed" || entry.origin === "user" || entry.origin === "agent"
        ? entry.origin
        : undefined;
    const column: CustomColumn = { kind: "custom", id, label };
    if (description) column.description = description;
    if (origin) column.origin = origin;
    return column;
  });
}

function parseRows(value: unknown): MatrixRow[] {
  if (!Array.isArray(value)) invalid("rows must be an array");
  if (value.length > MAX_ROWS) invalid(`more than ${MAX_ROWS} rows`);
  return value.map((entry, index): MatrixRow => {
    if (!isRecord(entry)) invalid(`row ${index + 1} is not an object`);
    const citationKey = trimmedString(entry.citationKey, 300);
    if (!citationKey) invalid(`row ${index + 1} is missing a citationKey`);
    const snapshotValue = isRecord(entry.snapshot) ? entry.snapshot : {};
    const yearValue = snapshotValue.year;
    const year =
      typeof yearValue === "number" && Number.isInteger(yearValue) && yearValue >= 1500 && yearValue <= 2200
        ? yearValue
        : undefined;
    const cellsValue = isRecord(entry.cells) ? entry.cells : {};
    const cells: Record<string, string> = {};
    for (const [columnId, cell] of Object.entries(cellsValue)) {
      if (typeof cell !== "string") continue;
      // Keep cell keys that do not map to a current column so a round-trip
      // never silently drops data (e.g. after a manual source edit).
      cells[columnId] = cell.slice(0, MAX_TEXT_LENGTH);
    }
    const row: MatrixRow = {
      citationKey,
      snapshot: {
        title: trimmedString(snapshotValue.title, 2_000),
        authors: trimmedString(snapshotValue.authors, 2_000),
        year,
        venue: trimmedString(snapshotValue.venue, 1_000),
      },
      cells,
    };
    const doi = trimmedString(entry.doi, 500);
    if (doi) row.doi = doi;
    return row;
  });
}

export function parseMatrix(source: string): LiteratureMatrix {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid("not valid JSON");
  }
  if (!isRecord(parsed)) invalid("root is not an object");
  if (parsed.version !== 1) invalid(`unsupported version ${String(parsed.version)}`);
  const columns = parseColumns(parsed.columns);
  const rows = parseRows(parsed.rows);
  return { version: 1, columns, rows };
}

export function serializeMatrix(matrix: LiteratureMatrix): string {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

export function createSeedMatrix(): LiteratureMatrix {
  return {
    version: 1,
    columns: [
      { kind: "derived", id: "year", source: "year" },
      { kind: "derived", id: "authors", source: "authors" },
      { kind: "derived", id: "venue", source: "venue" },
      {
        kind: "custom",
        id: "method",
        label: "Method",
        description: "Research design and data collection method",
        origin: "seed",
      },
      {
        kind: "custom",
        id: "findings",
        label: "Key Findings",
        description: "Main result in one sentence",
        origin: "seed",
      },
    ],
    rows: [],
  };
}

export function generateColumnId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = Math.random().toString(36).slice(2, 8);
    if (taken.has(id)) continue;
    if (DERIVED_COLUMN_SOURCES.includes(id as DerivedColumnSource)) continue;
    return id;
  }
  invalid("could not generate a unique column id");
}

export function findMatrixRow(
  rows: MatrixRow[],
  by: { citationKey?: string; doi?: string },
): MatrixRow | undefined {
  const key = by.citationKey?.trim();
  const doi = by.doi?.trim().toLocaleLowerCase();
  if (!key && !doi) return undefined;
  return rows.find((row) =>
    (key && row.citationKey === key) ||
    (doi && row.doi && row.doi.toLocaleLowerCase() === doi),
  );
}

export function addMatrixPapers(
  matrix: LiteratureMatrix,
  papers: MatrixCitationEntry[],
): { matrix: LiteratureMatrix; added: MatrixCitationEntry[]; duplicates: MatrixCitationEntry[] } {
  const rows = [...matrix.rows];
  const added: MatrixCitationEntry[] = [];
  const duplicates: MatrixCitationEntry[] = [];
  for (const paper of papers) {
    const citationKey = paper.citationKey.trim();
    if (!citationKey) throw new Error("A paper is missing its citation key.");
    if (findMatrixRow(rows, { citationKey, doi: paper.doi })) {
      duplicates.push(paper);
      continue;
    }
    const row: MatrixRow = {
      citationKey,
      snapshot: {
        title: paper.title?.trim().slice(0, 2_000),
        authors: paper.authors?.trim().slice(0, 2_000),
        year: typeof paper.year === "number" && Number.isInteger(paper.year) ? paper.year : undefined,
        venue: paper.venue?.trim().slice(0, 1_000),
      },
      cells: {},
    };
    const doi = paper.doi?.trim();
    if (doi) row.doi = doi;
    rows.push(row);
    added.push(paper);
  }
  return { matrix: { ...matrix, rows }, added, duplicates };
}

export function addMatrixColumn(
  matrix: LiteratureMatrix,
  input: { label: string; description?: string; origin?: CustomColumnOrigin; position?: number },
): { matrix: LiteratureMatrix; column: CustomColumn } {
  const label = input.label.trim().slice(0, MAX_LABEL_LENGTH);
  if (!label) throw new Error("The column label cannot be empty.");
  const description = input.description?.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const column: CustomColumn = { kind: "custom", id: generateColumnId(matrix.columns.map(({ id }) => id)), label };
  if (description) column.description = description;
  if (input.origin) column.origin = input.origin;
  const columns = [...matrix.columns];
  const position = input.position === undefined ? columns.length : Math.max(0, Math.min(input.position, columns.length));
  columns.splice(position, 0, column);
  return { matrix: { ...matrix, columns }, column };
}

export type MatrixCellUpdate = { citationKey: string; columnId: string; value: string };

export function setMatrixCells(
  matrix: LiteratureMatrix,
  updates: MatrixCellUpdate[],
): {
  matrix: LiteratureMatrix;
  applied: number;
  unknownRows: string[];
  unknownColumns: string[];
  derivedColumns: string[];
} {
  const rows = matrix.rows.map((row) => ({ ...row, cells: { ...row.cells } }));
  const appliedMap = new Map<number, Map<string, string>>();
  const unknownRows = new Set<string>();
  const unknownColumns = new Set<string>();
  const derivedColumns = new Set<string>();

  for (const update of updates) {
    const citationKey = update.citationKey.trim();
    const columnId = update.columnId.trim();
    const rowIndex = rows.findIndex((row) => row.citationKey === citationKey);
    if (rowIndex === -1) {
      unknownRows.add(citationKey);
      continue;
    }
    const column = matrix.columns.find((candidate) => candidate.id === columnId);
    if (!column) {
      unknownColumns.add(columnId);
      continue;
    }
    if (column.kind === "derived") {
      derivedColumns.add(columnId);
      continue;
    }
    const value = update.value.slice(0, MAX_TEXT_LENGTH);
    rows[rowIndex].cells[columnId] = value;
    const byRow = appliedMap.get(rowIndex) ?? new Map<string, string>();
    byRow.set(columnId, value);
    appliedMap.set(rowIndex, byRow);
  }

  return {
    matrix: { ...matrix, rows },
    applied: [...appliedMap.values()].reduce((count, cells) => count + cells.size, 0),
    unknownRows: [...unknownRows],
    unknownColumns: [...unknownColumns],
    derivedColumns: [...derivedColumns],
  };
}

export function removeMatrixRows(
  matrix: LiteratureMatrix,
  citationKeys: string[],
): { matrix: LiteratureMatrix; removed: string[] } {
  const remove = new Set(citationKeys.map((key) => key.trim()).filter(Boolean));
  const removed = matrix.rows.filter((row) => remove.has(row.citationKey)).map((row) => row.citationKey);
  return {
    matrix: { ...matrix, rows: matrix.rows.filter((row) => !remove.has(row.citationKey)) },
    removed,
  };
}

export function removeMatrixColumn(
  matrix: LiteratureMatrix,
  columnId: string,
): { matrix: LiteratureMatrix } {
  const removedColumn = matrix.columns.find((column) => column.id === columnId);
  const columns = matrix.columns.filter((column) => column.id !== columnId);
  if (columns.length === matrix.columns.length) {
    throw new Error(`Column "${columnId}" does not exist.`);
  }
  // Hiding a bibliography field should preserve edits if it is shown again.
  if (removedColumn?.kind === "derived") {
    return { matrix: { ...matrix, columns } };
  }
  const rows = matrix.rows.map((row) => {
    if (!(columnId in row.cells)) return row;
    const cells = { ...row.cells };
    delete cells[columnId];
    return { ...row, cells };
  });
  return { matrix: { ...matrix, columns, rows } };
}

// ---------------------------------------------------------------------------
// Rendering helpers shared by the editor and the export actions.
// ---------------------------------------------------------------------------

/** Bibliography fields for one citation, extracted from references.bib. */
export type CitationLookup = {
  title?: string;
  authors?: string;
  year?: string;
  venue?: string;
  publisher?: string;
  doi?: string;
  pmid?: string;
  url?: string;
  type?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
  keywords?: string;
  note?: string;
  file?: string;
  month?: string;
  editor?: string;
  edition?: string;
  series?: string;
  address?: string;
  school?: string;
  institution?: string;
  organization?: string;
  howpublished?: string;
  urldate?: string;
  citationCount?: number;
  isOpenAccess?: boolean;
};

export type ResolvedMatrixRow = {
  citationKey: string;
  title: string;
  linked: boolean;
  /** Preferred source link: DOI resolver URL, else the citation's URL. */
  link?: string;
  values: Record<string, string>;
};

function derivedValue(
  row: MatrixRow,
  source: DerivedColumnSource,
  citation: CitationLookup | undefined,
): string {
  if (!citation) {
    if (source === "year") return row.snapshot.year ? String(row.snapshot.year) : "";
    if (source === "authors") return row.snapshot.authors ?? "";
    if (source === "venue") return row.snapshot.venue ?? "";
    return "";
  }
  if (source === "year") return citation.year ?? (row.snapshot.year ? String(row.snapshot.year) : "");
  if (source === "authors") return citation.authors ?? row.snapshot.authors ?? "";
  if (source === "venue") return citation.venue ?? row.snapshot.venue ?? "";
  if (source === "publisher") return citation.publisher ?? "";
  if (source === "doi") return citation.doi ?? row.doi ?? "";
  if (source === "type") return citation.type ?? "";
  return "";
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sourceLink(row: MatrixRow, citation: CitationLookup | undefined): string | undefined {
  const doi = (citation?.doi || row.doi || "").trim();
  if (doi) {
    const normalized = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
    return `https://doi.org/${normalized}`;
  }
  return safeHttpUrl(citation?.url);
}

export function resolveMatrixRow(
  row: MatrixRow,
  columns: MatrixColumn[],
  citation: CitationLookup | undefined,
): ResolvedMatrixRow {
  const values: Record<string, string> = {};
  for (const column of columns) {
    // A value stored against a derived column id is a user override from the
    // matrix table; without one, derived columns resolve from the
    // bibliography (then the row snapshot).
    values[column.id] =
      column.kind === "derived"
        ? column.id in row.cells
          ? row.cells[column.id]
          : derivedValue(row, column.source, citation)
        : row.cells[column.id] ?? "";
  }
  const link = sourceLink(row, citation);
  return {
    citationKey: row.citationKey,
    title: citation?.title || row.snapshot.title || row.citationKey,
    linked: Boolean(citation),
    ...(link ? { link } : {}),
    values,
  };
}

export function matrixColumnLabel(column: MatrixColumn): string {
  if (column.kind === "custom") return column.label;
  const labels: Record<DerivedColumnSource, string> = {
    year: "Year",
    authors: "Authors",
    venue: "Venue",
    publisher: "Publisher",
    doi: "DOI",
    type: "Type",
  };
  return labels[column.source];
}

export function matrixToMarkdown(columns: MatrixColumn[], rows: ResolvedMatrixRow[]): string {
  const escape = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const header = `| Study | ${columns.map((column) => escape(matrixColumnLabel(column))).join(" | ")} |`;
  const divider = `| --- | ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) =>
    `| ${escape(row.title)} | ${columns.map((column) => escape(row.values[column.id] ?? "")).join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

function csvCell(value: string): string {
  const normalized = value.replaceAll('"', '""').replaceAll(/\r?\n/g, " ");
  return /[",\n]/.test(normalized) ? `"${normalized}"` : normalized;
}

export function matrixToCsv(columns: MatrixColumn[], rows: ResolvedMatrixRow[]): string {
  const header = ["Study", ...columns.map(matrixColumnLabel)].map(csvCell).join(",");
  const body = rows.map((row) =>
    [row.title, ...columns.map((column) => row.values[column.id] ?? "")].map(csvCell).join(","),
  );
  return [header, ...body].join("\n");
}
