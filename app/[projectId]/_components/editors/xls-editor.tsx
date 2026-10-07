"use client";

import { useEffect, useState } from "react";
import { read, utils, write, type WorkBook } from "xlsx";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { uploadWorkspaceFile } from "@/lib/workspace-upload";
import { DataGrid, type GridRows } from "./data-grid";
import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import type { WorkspaceEditorProps } from "./types";
import { errorDetail } from "@/lib/error-detail";

export function XlsEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const [workbook, setWorkbook] = useState<WorkBook>();
  const [sheetName, setSheetName] = useState("");
  const [rows, setRows] = useState<GridRows>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void fetch(sourceUrl).then(async (response) => { if (!response.ok) throw new Error(`Unable to fetch workbook (${response.status})`); return response.arrayBuffer(); }).then((buffer) => {
      const book = read(buffer, { type: "array", cellDates: true });
      const first = book.SheetNames[0];
      if (!first) throw new Error("The workbook has no worksheets.");
      if (!cancelled) { setWorkbook(book); setSheetName(first); setRows(sheetRows(book, first)); }
    }).catch((cause) => { if (!cancelled) setError(errorDetail(cause, "Unable to read XLS workbook.")); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceUrl]);
  const selectSheet = (name: string) => { if (workbook) { setSheetName(name); setRows(sheetRows(workbook, name)); } };
  const changeRows = (next: GridRows) => {
    if (workbook) applyChangedRows(workbook.Sheets[sheetName], rows, next);
    setRows(next);
    setDirty(true);
  };
  const save = async () => { if (!workbook) return; setSaving(true); try { const bytes = write(workbook, { type: "array", bookType: "xls" }) as ArrayBuffer; const result = await uploadWorkspaceFile(projectId, file.path.split("/").slice(0, -1).join("/"), new File([bytes], file.name, { type: "application/vnd.ms-excel" }), { overwrite: true }); if (!result.success) throw new Error(result.error); setDirty(false); toast.success("Workbook saved"); onSaved?.(); } catch { toast.error("Failed to save workbook"); } finally { setSaving(false); } };
  return <EditorShell path={file.path} sourceUrl={sourceUrl} dirty={dirty} actions={<Select value={sheetName} onValueChange={selectSheet}><SelectTrigger size="sm" className="max-w-44"><SelectValue placeholder="Sheet" /></SelectTrigger><SelectContent>{workbook?.SheetNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select>} save={{ onClick: save, saving }}>
    {loading ? <EditorLoading /> : error ? <EditorError message={error} /> : <DataGrid rows={rows} onChange={changeRows} />}
  </EditorShell>;
}

function sheetRows(workbook: WorkBook, name: string): GridRows {
  const sheet = workbook.Sheets[name];
  const range = utils.decode_range(sheet["!ref"] || "A1");
  const rows: GridRows = [];
  for (let row = range.s.r; row <= range.e.r; row++) {
    const values: string[] = [];
    for (let column = range.s.c; column <= range.e.c; column++) {
      const cell = sheet[utils.encode_cell({ r: row, c: column })];
      values.push(cell?.f ? `=${cell.f}` : cell ? String(cell.w ?? cell.v ?? "") : "");
    }
    rows.push(values);
  }
  return rows.length ? rows : [[""]];
}

function applyChangedRows(sheet: WorkBook["Sheets"][string], previous: GridRows, next: GridRows) {
  next.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (previous[rowIndex]?.[columnIndex] === value) return;
    const address = utils.encode_cell({ r: rowIndex, c: columnIndex });
    if (value.startsWith("=")) sheet[address] = { t: "n", f: value.slice(1) };
    else sheet[address] = { t: "s", v: value };
  }));
  sheet["!ref"] = utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, next.length - 1), c: Math.max(0, Math.max(...next.map((row) => row.length)) - 1) } });
}
