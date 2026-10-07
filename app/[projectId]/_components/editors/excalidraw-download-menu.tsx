"use client";

import { useState } from "react";
import { Download, FileImage, Loader2, PenTool } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { parseExcalidrawScene } from "./excalidraw-scene";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { errorDetail } from "@/lib/error-detail";

type DownloadFormat = "excalidraw" | "png" | "jpg";

export function ExcalidrawDownloadMenu({ filename, sceneJson }: { filename: string; sceneJson: string }) {
  const [downloading, setDownloading] = useState<DownloadFormat | null>(null);
  const stem = filename.replace(/\.(excalidraw\.json|excalidraw|json)$/i, "");

  const download = async (format: DownloadFormat) => {
    setDownloading(format);
    try {
      const parsed = parseExcalidrawScene(sceneJson);
      if ("error" in parsed) throw new Error(parsed.error);

      if (format === "excalidraw") {
        downloadBlob(new Blob([sceneJson], { type: "application/json;charset=utf-8" }), `${stem}.excalidraw`);
        return;
      }

      // The export API wants the non-deleted subset of restored elements.
      const elements = parsed.scene.elements.filter(
        (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
      );
      if (elements.length === 0) {
        toast.message("The drawing is empty");
        return;
      }
      const { exportToBlob } = await import("@excalidraw/utils");
      const blob = await exportToBlob({
        data: { elements, appState: parsed.scene.appState, files: parsed.scene.files },
        config: format === "png"
          // canvasBackgroundColor: false renders a transparent background.
          ? { mimeType: "image/png", canvasBackgroundColor: false, padding: 16 }
          // JPEG has no alpha; fall back to white instead of the scene's canvas color only when unset.
          : {
              mimeType: "image/jpeg",
              quality: 0.92,
              padding: 16,
              canvasBackgroundColor: (parsed.scene.appState.viewBackgroundColor as string) || "#ffffff",
            },
      });
      downloadBlob(blob, `${stem}.${format}`);
    } catch (error) {
      toast.error(errorDetail(error, "Unable to export the drawing"));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" disabled={downloading !== null} aria-label="Choose an export format">
              {downloading ? <Loader2 className="animate-spin" /> : <Download />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44 min-w-44">
        <DropdownMenuItem onSelect={() => void download("excalidraw")}><PenTool />Excalidraw</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download("png")}><FileImage />PNG (Transparent)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download("jpg")}><FileImage />JPG</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
