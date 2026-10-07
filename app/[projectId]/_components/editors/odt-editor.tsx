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

export function OdtEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const [archive, setArchive] = useState<JSZip>();
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [original, setOriginal] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`Unable to fetch document (${response.status})`);
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        const xml = await zip.file("content.xml")?.async("text");
        if (!xml) throw new Error("The OpenDocument content is missing.");
        const values = odtParagraphs(xml);
        if (!cancelled) { setArchive(zip); setParagraphs(values); setOriginal(values); }
      } catch (cause) { if (!cancelled) setError(errorDetail(cause, "Unable to open ODT.")); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [sourceUrl]);

  const save = async () => {
    if (!archive) return;
    setSaving(true);
    try {
      const xml = await archive.file("content.xml")?.async("text");
      if (!xml) throw new Error("OpenDocument content is missing");
      archive.file("content.xml", updateOdtParagraphs(xml, paragraphs));
      const bytes = await archive.generateAsync({ type: "uint8array", mimeType: "application/vnd.oasis.opendocument.text" });
      const result = await uploadWorkspaceFile(projectId, file.path.split("/").slice(0, -1).join("/"), new File(
        [new Uint8Array(bytes).buffer], file.name, { type: "application/vnd.oasis.opendocument.text" },
      ), { overwrite: true });
      if (!result.success) throw new Error(result.error);
      setOriginal([...paragraphs]); setPreviewVersion((value) => value + 1); toast.success("Document saved"); onSaved?.();
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

function odtParagraphs(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return odtTextNodes(document).map((node) => node.textContent ?? "");
}

function updateOdtParagraphs(xml: string, values: string[]) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  odtTextNodes(document).forEach((node, index) => { node.textContent = values[index] ?? ""; });
  return new XMLSerializer().serializeToString(document);
}

function odtTextNodes(document: Document) {
  return Array.from(document.getElementsByTagName("*")).filter((node) => node.localName === "p" || node.localName === "h");
}
