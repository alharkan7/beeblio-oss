"use client";

import { useEffect, useState } from "react";
import JSZip from "jszip";
import { Eye, Pencil } from "lucide-react";
import { toast } from "sonner";

import { uploadWorkspaceFile } from "@/lib/workspace-upload";
import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import { OfficePdfPreview } from "./office-pdf-preview";
import type { WorkspaceEditorProps } from "./types";
import { errorDetail } from "@/lib/error-detail";

export function DocxEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const [archive, setArchive] = useState<JSZip>();
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [original, setOriginal] = useState<string[]>([]);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`Unable to fetch document (${response.status})`);
        const buffer = await response.arrayBuffer();
        const zip = await JSZip.loadAsync(buffer);
        const xml = await zip.file("word/document.xml")?.async("text");
        if (!xml) throw new Error("The DOCX document body is missing.");
        const values = docxParagraphs(xml);
        if (cancelled) return;
        setArchive(zip); setParagraphs(values); setOriginal(values);
      } catch (cause) { if (!cancelled) setError(errorDetail(cause, "Unable to open DOCX.")); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [sourceUrl]);

  const save = async () => {
    if (!archive) return;
    setSaving(true);
    try {
      const fileEntry = archive.file("word/document.xml");
      const xml = await fileEntry?.async("text");
      if (!xml) throw new Error("Document XML is missing");
      archive.file("word/document.xml", updateDocxParagraphs(xml, paragraphs));
      const bytes = await archive.generateAsync({ type: "uint8array" });
      const result = await uploadWorkspaceFile(projectId, file.path.split("/").slice(0, -1).join("/"), new File(
        [new Uint8Array(bytes).buffer], file.name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ), { overwrite: true });
      if (!result.success) throw new Error(result.error);
      setOriginal([...paragraphs]);
      setPreviewVersion((value) => value + 1);
      toast.success("Document saved"); onSaved?.();
    } catch { toast.error("Failed to save document"); }
    finally { setSaving(false); }
  };

  const dirty = paragraphs.join("\n") !== original.join("\n");

  return <EditorShell path={file.path} sourceUrl={sourceUrl} dirty={dirty} viewModes={[{
    value: mode,
    onChange: (value) => setMode(value as "preview" | "edit"),
    options: [
      { value: "preview", label: "Preview", icon: Eye },
      { value: "edit", label: "Quick edit", icon: Pencil, title: "Quick text edits may not preserve advanced document formatting" },
    ],
  }]} save={{ onClick: save, saving }}>
    {loading ? <EditorLoading /> : error ? <EditorError message={error} /> : mode === "preview" ? <div key="preview" className="h-full"><OfficePdfPreview projectId={projectId} filePath={file.path} version={previewVersion} /></div> : <div key="edit" className="h-full overflow-auto bg-neutral-200 p-6 dark:bg-neutral-900"><article className="mx-auto min-h-[1056px] max-w-[816px] bg-white px-20 py-20 text-[15px] leading-7 text-neutral-950 shadow-sm">{paragraphs.map((paragraph, index) => <p key={index} contentEditable suppressContentEditableWarning onBlur={(event) => setParagraphs((current) => current.map((value, item) => item === index ? event.currentTarget.textContent ?? "" : value))} className="min-h-7 whitespace-pre-wrap rounded-sm outline-none focus:bg-amber-50/60 focus:ring-1 focus:ring-amber-300">{paragraph}</p>)}</article></div>}
  </EditorShell>;
}

function docxParagraphs(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(document.getElementsByTagName("w:p")).map((paragraph) => Array.from(paragraph.getElementsByTagName("w:t")).map((text) => text.textContent ?? "").join(""));
}

function updateDocxParagraphs(xml: string, values: string[]) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  Array.from(document.getElementsByTagName("w:p")).forEach((paragraph, index) => {
    const textNodes = Array.from(paragraph.getElementsByTagName("w:t"));
    if (textNodes[0]) textNodes[0].textContent = values[index] ?? "";
    textNodes.slice(1).forEach((node) => { node.textContent = ""; });
  });
  return new XMLSerializer().serializeToString(document);
}
