"use client";

import { useEffect, useState } from "react";
import type { Workbook, Worksheet } from "exceljs";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { uploadWorkspaceFile } from "@/lib/workspace-upload";
import { DataGrid, type GridRows } from "./data-grid";
import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import type { WorkspaceEditorProps } from "./types";
import { errorDetail } from "@/lib/error-detail";

export function XlsxEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const [workbook, setWorkbook] = useState<Workbook>();
  const [sheetName, setSheetName] = useState("");
  const [rows, setRows] = useState<GridRows>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const [ExcelJS, response] = await Promise.all([import("exceljs"), fetch(sourceUrl)]);
        if (!response.ok) throw new Error(`Unable to fetch workbook (${response.status})`);
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(await response.arrayBuffer());
        if (cancelled) return;
        const first = book.worksheets[0];
        if (!first) throw new Error("The workbook has no worksheets.");
        setWorkbook(book);
        setSheetName(first.name);
        setRows(worksheetRows(first));
      } catch (cause) {
        if (!cancelled) setError(errorDetail(cause, "Unable to read workbook."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceUrl]);

  const selectSheet = (name: string) => {
    const sheet = workbook?.getWorksheet(name);
    if (!sheet) return;
    setSheetName(name);
    setRows(worksheetRows(sheet));
  };

  const changeRows = (next: GridRows) => {
    const sheet = workbook?.getWorksheet(sheetName);
    if (!sheet) return;
    applyChangedRows(sheet, rows, next);
    setRows(next);
    setDirty(true);
  };

  const save = async () => {
    if (!workbook) return;
    setSaving(true);
    try {
      const buffer = await workbook.xlsx.writeBuffer();
      const result = await uploadWorkspaceFile(projectId, file.path.split("/").slice(0, -1).join("/"), new File(
        [buffer], file.name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      ), { overwrite: true });
      if (!result.success) throw new Error(result.error);
      setDirty(false);
      toast.success("Workbook saved");
      onSaved?.();
    } catch {
      toast.error("Failed to save workbook");
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorShell path={file.path} sourceUrl={sourceUrl} dirty={dirty} actions={<Select value={sheetName} onValueChange={selectSheet} disabled={!workbook}><SelectTrigger size="sm" className="max-w-44"><SelectValue placeholder="Sheet" /></SelectTrigger><SelectContent>{workbook?.worksheets.map((sheet) => <SelectItem key={sheet.id} value={sheet.name}>{sheet.name}</SelectItem>)}</SelectContent></Select>} save={{ onClick: save, saving }}>
      {loading ? <EditorLoading /> : error ? <EditorError message={error} /> : <DataGrid rows={rows} onChange={changeRows} />}
    </EditorShell>
  );
}

function worksheetRows(sheet: Worksheet): GridRows {
  const rows: GridRows = [];
  const rowCount = Math.max(sheet.actualRowCount, 1);
  const columnCount = Math.max(sheet.actualColumnCount, 1);
  for (let row = 1; row <= rowCount; row++) {
    const values: string[] = [];
    for (let column = 1; column <= columnCount; column++) {
      const cell = sheet.getCell(row, column);
      const value = cell.value;
      values.push(value && typeof value === "object" && "formula" in value ? `=${String(value.formula)}` : cell.text);
    }
    rows.push(values);
  }
  return rows;
}

function applyChangedRows(sheet: Worksheet, previous: GridRows, next: GridRows) {
  next.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (previous[rowIndex]?.[columnIndex] !== value) {
      sheet.getCell(rowIndex + 1, columnIndex + 1).value = value.startsWith("=")
        ? { formula: value.slice(1) }
        : value;
    }
  }));
}
