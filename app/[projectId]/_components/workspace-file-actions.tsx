"use client";

import { useState } from "react";
import {
  BookMarked, ChevronRight, Copy, Download, Edit2, Folder, FolderInput, Loader2,
  MoreVertical, Paperclip, Share2, Table2, Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ADD_FILE_TO_CHAT_EVENT } from "@/lib/chat-context";
import { affectsProtectedWorkspacePath } from "@/lib/protected-workspace";
import { cn } from "@/lib/utils";
import {
  cachedFolderListing,
  dispatchWorkspaceMutation,
  pathBasename,
  pathParent,
  rememberFolderListing,
} from "@/lib/workspace-mutations";
import {
  destinationNameTaken,
  nameConflictMessage,
} from "@/lib/workspace-name-conflict";
import {
  deleteFile, duplicateFiles, listFiles, movePath, renameFile, type FileEntry,
} from "../file-actions";
import { FileNameInput, splitFileName } from "./file-name-input";
import { fileUrl } from "./file-viewer";
import { addFileToKnowledge } from "../knowledge-actions";
import { acceptsKnowledgeFile } from "@/lib/knowledge-files";
import { ShareFileControls } from "./editors/share-button";
import { errorDetail } from "@/lib/error-detail";

export function WorkspaceFileActions({
  projectId,
  file,
  className,
  onAddToMatrix,
}: {
  projectId: string;
  file: FileEntry;
  className?: string;
  onAddToMatrix?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveError, setMoveError] = useState<string>();
  // The rename field edits the stem only; the extension stays fixed so the
  // file's type can't change mid-rename.
  const renameExtension = splitFileName(file.name).extension;
  const [newName, setNewName] = useState(() => splitFileName(file.name).stem);
  const [folderPath, setFolderPath] = useState("");
  const [folders, setFolders] = useState<FileEntry[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);

  const changed = () => window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));

  const browse = async (path: string) => {
    setFolderPath(path);
    setMoveError(undefined);
    // Panels seed this cache with listings they already fetched, so folders
    // seen before open instantly instead of re-round-tripping the server.
    const cached = cachedFolderListing(path);
    if (cached) {
      setFolders(cached.filter((entry) => entry.isDir));
      return;
    }
    setLoadingFolders(true);
    try {
      const entries = await listFiles(projectId, path);
      rememberFolderListing(path, entries);
      setFolders(entries.filter((entry) => entry.isDir));
    } finally {
      setLoadingFolders(false);
    }
  };

  const download = async () => {
    setBusy(true);
    // The menu closes on click, so the busy spinner on the trigger is easy to
    // miss; a loading toast carries the cue for these longer-running actions.
    const loading = toast.loading(`Downloading ${file.name}…`);
    try {
      const response = file.isDir ? await fetch(`/api/workspace/${encodeURIComponent(projectId)}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ path: file.path, isDir: true }] }),
      }) : null;
      if (response && !response.ok) throw new Error(await response.text());
      const archive = response ? await response.json() as { url?: string } : null;
      if (response && !archive?.url) throw new Error("Archive download URL was not returned");
      const link = document.createElement("a");
      link.href = archive?.url ?? `${fileUrl(projectId, file.path)}?download=file`;
      link.download = file.isDir ? `${file.name}.zip` : file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.dismiss(loading);
    } catch (error) {
      toast.error("Failed to download", {
        id: loading,
        description: errorDetail(error),
      });
    } finally {
      setBusy(false);
    }
  };

  // Pre-checks the destination folder for a taken name so a conflict surfaces
  // inside the dialog instead of a toast after it closes; the server-side
  // check stays authoritative for anything that races this listing.
  const destinationTaken = async (parentPath: string, name: string) => {
    try {
      return destinationNameTaken(await listFiles(projectId, parentPath), name, file.path);
    } catch {
      return false;
    }
  };

  // Rename and move keep their dialogs open on failure and report inline, so
  // the user can fix the name or destination without reopening the dialog.
  // Every action broadcasts its known outcome so panels (and anything holding
  // these paths, like a pending drag) see the new path immediately.
  const move = async () => {
    const destination = [folderPath, file.name].filter(Boolean).join("/");
    setMoveError(undefined);
    setBusy(true);
    try {
      if (await destinationTaken(folderPath, file.name)) {
        setMoveError(nameConflictMessage(file.name));
        return;
      }
      await movePath(projectId, file.path, destination);
      dispatchWorkspaceMutation({
        kind: "move",
        from: file.path,
        to: destination,
        entry: { ...file, path: destination },
      });
      toast.success(`${file.name} moved to ${folderPath.split("/").at(-1) || "Files"}`);
      changed();
      setMoveOpen(false);
    } catch (error) {
      setMoveError(errorDetail(error, `Failed to move ${file.name}`));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const stem = newName.trim();
    if (!stem) return;
    const value = `${stem}${renameExtension}`;
    setRenameError(undefined);
    setBusy(true);
    try {
      const parentPath = pathParent(file.path);
      const destination = [parentPath, value].filter(Boolean).join("/");
      if (await destinationTaken(parentPath, value)) {
        setRenameError(`${nameConflictMessage(value)} Choose a different name.`);
        return;
      }
      await renameFile(projectId, file.path, value);
      dispatchWorkspaceMutation({
        kind: "move",
        from: file.path,
        to: destination,
        entry: { ...file, name: value, path: destination },
      });
      toast.success(`${file.name} renamed to ${value}`);
      changed();
      setRenameOpen(false);
    } catch (error) {
      setRenameError(errorDetail(error, `Failed to rename ${file.name}`));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setBusy(true);
    const loading = toast.loading(`Duplicating ${file.name}…`);
    try {
      const destinations = await duplicateFiles(projectId, [file.path]);
      for (const destination of destinations) {
        dispatchWorkspaceMutation({
          kind: "create",
          entry: { ...file, name: pathBasename(destination), path: destination },
        });
      }
      toast.success(`${file.name} duplicated`, { id: loading });
      changed();
    } catch (error) {
      toast.error("Failed to duplicate file", {
        id: loading,
        description: errorDetail(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const addToKnowledge = async () => {
    setBusy(true);
    const loading = toast.loading(`Adding ${file.name} to Knowledge…`);
    try {
      const result = await addFileToKnowledge(projectId, file.path);
      if (result.kind === "configuration_error") {
        toast.error("Failed to add to Knowledge", { id: loading, description: result.error });
      } else if (result.kind === "already_exists") {
        toast.info("Already in Knowledge", { id: loading, description: `${file.name} is already in this project's Knowledge.` });
      } else {
        toast.success(`${file.name} added to Knowledge`, { id: loading, description: "Processing in the background." });
        window.dispatchEvent(new CustomEvent("beeblio:knowledge-changed"));
      }
    } catch (error) {
      toast.error("Failed to add to Knowledge", { id: loading, description: errorDetail(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteFile(projectId, file.path);
      dispatchWorkspaceMutation({ kind: "delete", path: file.path });
      toast.success(`${file.name} deleted`);
      changed();
      setDeleteOpen(false);
    } catch (error) {
      toast.error(`Failed to delete ${file.name}`, {
        description: errorDetail(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const segments = folderPath.split("/").filter(Boolean);
  const invalidDestination = folderPath === file.path || folderPath.startsWith(`${file.path}/`) ||
    [folderPath, file.name].filter(Boolean).join("/") === file.path;

  return (
    <span className={cn("inline-flex", className)} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          className="inline-flex size-7 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
          aria-label={`File actions for ${file.name}`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreVertical className="size-4" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            // onClick={() => notifyUpcomingFeature("Add to Chat")}
          onClick={() => {
            window.dispatchEvent(new CustomEvent(ADD_FILE_TO_CHAT_EVENT, { detail: file }));
            toast.success(`${file.name} added to chat context`);
          }}
          ><Paperclip />Add to Chat</DropdownMenuItem>
          {!file.isDir && acceptsKnowledgeFile(file.name) ? <DropdownMenuItem
          //  onClick={() => notifyUpcomingFeature("Add to Knowledge")}
          onClick={() => void addToKnowledge()}
          ><BookMarked />Add to Knowledge</DropdownMenuItem> : null}
          {onAddToMatrix ? <DropdownMenuItem onSelect={onAddToMatrix}><Table2 />Add to Matrix</DropdownMenuItem> : null}
          <DropdownMenuItem onClick={() => {
            if (affectsProtectedWorkspacePath(file.path)) return toast.error("This workspace item is protected");
            setMoveError(undefined);
            setMoveOpen(true);
            void browse("");
          }}><FolderInput />Move to…</DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            if (affectsProtectedWorkspacePath(file.path)) return toast.error("This workspace item is protected");
            setNewName(splitFileName(file.name).stem);
            setRenameError(undefined);
            setRenameOpen(true);
          }}><Edit2 />Rename</DropdownMenuItem>
          {!file.isDir ? <DropdownMenuItem onClick={() => void duplicate()}><Copy />Duplicate</DropdownMenuItem> : null}
          <DropdownMenuItem onClick={() => void download()}><Download />Download</DropdownMenuItem>
          {!file.isDir ? <DropdownMenuItem onSelect={() => setShareOpen(true)}><Share2 />Share</DropdownMenuItem> : null}
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => {
            if (affectsProtectedWorkspacePath(file.path)) return toast.error("This workspace item is protected");
            setDeleteOpen(true);
          }}><Trash2 />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share {file.name}</DialogTitle>
            <DialogDescription>Anyone with the public link can view this file.</DialogDescription>
          </DialogHeader>
          <ShareFileControls projectId={projectId} filePath={file.path} />
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Move to…</DialogTitle><DialogDescription>Choose a destination for {file.name}.</DialogDescription></DialogHeader>
          <div className="overflow-hidden rounded-xl border">
            <div className="flex h-9 items-center gap-1 overflow-x-auto border-b px-2 text-xs">
              <button className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted" onClick={() => void browse("")}>Files</button>
              {segments.map((segment, index) => {
                const destination = segments.slice(0, index + 1).join("/");
                return <span key={destination} className="flex items-center gap-1"><ChevronRight className="size-3" /><button className="max-w-32 truncate rounded px-1.5 py-1 text-muted-foreground hover:bg-muted" onClick={() => void browse(destination)}>{segment}</button></span>;
              })}
            </div>
            <div className="max-h-64 min-h-32 overflow-y-auto p-1.5">
              {loadingFolders ? <div className="flex h-28 items-center justify-center"><Loader2 className="size-4 animate-spin" /></div> : folders.length ? folders.map((folder) => {
                const unavailable = folder.path === file.path || folder.path.startsWith(`${file.path}/`);
                return <button key={folder.path} disabled={unavailable} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted disabled:opacity-40" onClick={() => void browse(folder.path)}><Folder className="size-4 text-blue-500" /><span className="min-w-0 flex-1 truncate">{folder.name}</span><ChevronRight className="size-3.5" /></button>;
              }) : <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">No subfolders</div>}
            </div>
          </div>
          {moveError ? <p className="text-xs text-amber-600 dark:text-amber-400">{moveError}</p> : null}
          <DialogFooter><Button variant="ghost" onClick={() => setMoveOpen(false)}>Cancel</Button><Button disabled={busy || invalidDestination} onClick={() => void move()}>{busy ? <Loader2 className="animate-spin" /> : <FolderInput />}Move Here</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename</DialogTitle><DialogDescription>Enter a new name.</DialogDescription></DialogHeader>
          <FileNameInput
            value={newName}
            onChange={(next) => {
              setNewName(next);
              setRenameError(undefined);
            }}
            onEnter={() => void rename()}
            extension={renameExtension}
            ariaLabel="File name"
            autoFocus
          />
          {renameError ? <p className="text-xs text-amber-600 dark:text-amber-400">{renameError}</p> : null}
          <DialogFooter><Button variant="ghost" onClick={() => setRenameOpen(false)}>Cancel</Button><Button disabled={busy || !newName.trim()} onClick={() => void rename()}>{busy ? <Loader2 className="animate-spin" /> : null}Rename</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete {file.isDir ? "Folder" : "File"}?</AlertDialogTitle><AlertDialogDescription>This will permanently remove &quot;{file.name}&quot;{file.isDir ? " and everything inside it" : ""} from this project.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? <Loader2 className="animate-spin" /> : null}Delete {file.isDir ? "Folder" : "File"}</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
