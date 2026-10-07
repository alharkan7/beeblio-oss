"use client";

import { useId, useState } from "react";
import { Check, Copy, Globe, Share2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setFilePublic } from "../../share-actions";
import { useShareStatus } from "../share-status-context";

export function ShareButton({ projectId, filePath }: { projectId: string; filePath: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Share file">
              <Share2 className="size-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Share this File</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80 p-4" align="end">
        <h4 className="mb-4 font-medium leading-none">Share File</h4>
        <ShareFileControls projectId={projectId} filePath={filePath} />
      </PopoverContent>
    </Popover>
  );
}

/** Shared by the editor popover and the file action menu. */
export function ShareFileControls({ projectId, filePath }: { projectId: string; filePath: string }) {
  const toggleId = useId();
  const { files, publicOrigin, loaded, error, refresh, setFileStatus } = useShareStatus();
  const shareId = files.get(filePath) ?? null;
  const [pendingChecked, setPendingChecked] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const isPublic = pendingChecked ?? Boolean(shareId);
  const linkOrigin = publicOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const shareUrl = shareId && linkOrigin ? `${linkOrigin}/share/${shareId}` : "";
  const localLink = linkOrigin ? ["localhost", "127.0.0.1", "[::1]"].includes(new URL(linkOrigin).hostname) : false;

  const handleToggle = async (checked: boolean) => {
    setPendingChecked(checked);
    try {
      const id = await setFilePublic(projectId, filePath, checked);
      setFileStatus(filePath, id);
      toast.success(checked ? "File is now public" : "File is now private");
    } catch {
      toast.error("Failed to update sharing status");
    } finally {
      setPendingChecked(null);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("Link copied to clipboard");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy link");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 rounded-lg border p-3">
        <div className="flex items-center gap-3">
          <Globe className="size-5 text-muted-foreground" />
          <div>
            <Label htmlFor={toggleId} className="text-sm font-medium">Public link</Label>
            <p className="text-xs text-muted-foreground">Anyone with the link can view</p>
          </div>
        </div>
        <Switch id={toggleId} checked={isPublic} onCheckedChange={handleToggle} disabled={!loaded || pendingChecked !== null} />
      </div>
      {!loaded && !error ? <p className="text-xs text-muted-foreground">Loading share status…</p> : null}
      {error ? <Button size="sm" variant="outline" onClick={() => void refresh()}>Retry loading share status</Button> : null}
      {isPublic && shareUrl ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input value={shareUrl} readOnly className="h-8 flex-1" />
            <Button size="sm" variant="secondary" className="shrink-0" onClick={() => void handleCopy()}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              <span className="sr-only">Copy</span>
            </Button>
          </div>
          {localLink ? <p className="text-xs text-amber-700 dark:text-amber-400">This localhost link only works on this computer. Set a public tunnel origin in Settings → Sharing to share it with others.</p> : null}
        </div>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">Public sharing requires a reachable HTTPS URL. When using a tunnel, set its address in Settings → Sharing.</p>
    </div>
  );
}
