"use client";

import { useState } from "react";
import { Download, FileCode2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CompletionSettings, DocumentDefaultSettings } from "@/lib/project-settings";
import { downloadMarkdownDocument, type MarkdownDownloadFormat } from "./markdown-document-converter";
import { MarkdownTiptapEditor } from "./tiptap-document-editor";
import { errorDetail } from "@/lib/error-detail";

export function MarkdownDownloadMenu({
  projectId,
  filePath,
  filename,
  markdown,
}: {
  projectId: string;
  filePath: string;
  filename: string;
  markdown: string;
}) {
  const [downloading, setDownloading] = useState<MarkdownDownloadFormat | null>(null);

  const download = async (format: MarkdownDownloadFormat) => {
    setDownloading(format);
    try {
      await downloadMarkdownDocument({ format, filename, markdown, projectId, filePath });
    } catch (error) {
      toast.error(errorDetail(error, "Unable to download document"));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" disabled={downloading !== null} aria-label="Choose a download format">
              {downloading ? <Loader2 className="animate-spin" /> : <Download />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-45 min-w-45">
        <DropdownMenuItem onSelect={() => void download("docx")}><FileText />DOCX</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void download("docx-mendeley")}
          title="Citations and bibliography become editable Mendeley Cite controls in Word"
        >
          <FileText />DOCX (Mendeley)
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void download("docx-live")}
          title="Citations and the bibliography become Zotero fields that refresh and restyle in Word"
        >
          <FileText />DOCX (Zotero)
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void download("latex")}
          title="A zip with the .tex source, references.bib, and rendered figures — compiles with pdflatex/BibTeX or uploads to Overleaf"
        >
          <FileCode2 />LaTeX
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download("markdown")}><FileText />Markdown</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MarkdownWysiwyg({
  projectId,
  filePath,
  markdown,
  onChange,
  editable,
  completion = null,
  documentDefaults,
}: {
  projectId: string;
  filePath: string;
  markdown: string;
  originalMarkdown?: string;
  onChange: (markdown: string) => void;
  editable?: boolean;
  completion?: CompletionSettings | null;
  documentDefaults?: DocumentDefaultSettings;
}) {
  return (
    <MarkdownTiptapEditor
      projectId={projectId}
      filePath={filePath}
      markdown={markdown}
      onChange={onChange}
      editable={editable}
      completion={completion}
      documentDefaults={documentDefaults}
    />
  );
}
