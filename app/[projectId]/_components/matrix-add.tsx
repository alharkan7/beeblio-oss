"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Plus, Table2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { OPEN_WORKSPACE_FILE_EVENT } from "@/lib/chat-context";
import type { MatrixCitationEntry } from "@/lib/literature-matrix";
import type { LiteratureItem } from "@/lib/literature/types";
import { PROJECT_BIBLIOGRAPHY_PATH } from "@/lib/project-bibliography";
import { cn } from "@/lib/utils";
import { announceWorkspaceChange, type WorkspaceChangedFile } from "@/lib/workspace-change";
import { dispatchWorkspaceMutation } from "@/lib/workspace-mutations";
import {
  addCitationsToMatrix,
  addLiteratureItemsToMatrix,
  addPdfToMatrix,
  createMatrixFile,
  type MatrixFileSummary,
} from "../matrix-actions";
import { useMatrixTargets } from "./matrix-targets-context";
import { matrixPathsForRequest, rememberMatrixCommit } from "./matrix-membership-cache";
import { errorDetail } from "@/lib/error-detail";

export type MatrixAddRequest =
  | { kind: "literature"; items: LiteratureItem[] }
  | { kind: "citations"; entries: MatrixCitationEntry[] }
  | { kind: "pdf"; path: string };

/**
 * Shared add-to-matrix flow for the literature search panel and the
 * bibliography editor. With zero or one matrix everything goes straight to the
 * default matrix; once several matrices exist the caller renders
 * {@link MatrixTargetDialog} so the user picks the target.
 */
export function useMatrixAdd(
  projectId: string,
  /** Notified with the committed request so callers can update local state
   * without waiting for the post-save badge sync. */
  onCommitSuccess?: (request: MatrixAddRequest) => void,
  enabled = true,
) {
  const targets = useMatrixTargets();
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<MatrixAddRequest>();
  const [memberPaths, setMemberPaths] = useState<string[]>();
  const [savingPath, setSavingPath] = useState<string>();

  const commit = useCallback(async (request: MatrixAddRequest, matrixPath?: string) => {
    if (!enabled) return;
    setSavingPath(matrixPath);
    setSaving(true);
    // A selected matrix already shows progress in the picker. Only the
    // direct-to-default PDF path needs a separate visible progress cue.
    const loadingToast = request.kind === "pdf" && matrixPath === undefined
      ? toast.loading("Adding PDF to matrix…")
      : undefined;
    try {
      const result = request.kind === "literature"
        ? await addLiteratureItemsToMatrix({ projectId, items: request.items, matrixPath })
        : request.kind === "citations"
          ? await addCitationsToMatrix({ projectId, entries: request.entries, matrixPath })
          : await addPdfToMatrix({ projectId, pdfPath: request.path, matrixPath });
      if (!result.success) {
        toast.error("Could not add to the matrix", { id: loadingToast, description: result.error });
        return;
      }
      const changedFiles: WorkspaceChangedFile[] = [
        { path: result.matrixPath, content: result.matrixContent },
      ];
      if ("bibliographyContent" in result && typeof result.bibliographyContent === "string") {
        changedFiles.push({ path: PROJECT_BIBLIOGRAPHY_PATH, content: result.bibliographyContent });
      }
      announceWorkspaceChange(changedFiles);
      rememberMatrixCommit(
        projectId,
        request.kind,
        request.kind === "literature" ? request.items.map((item) => item.id)
          : request.kind === "citations" ? request.entries.map((entry) => entry.citationKey)
          : [request.path],
        result.matrixPath,
      );
      setMemberPaths((current) => [...new Set([...(current ?? []), result.matrixPath])]);
      onCommitSuccess?.(request);
      const name = result.matrixPath.split("/").at(-1) || result.matrixPath;
      if (result.addedCount === 0) {
        toast.message("Already in the matrix", {
          id: loadingToast,
          description: result.matrixPath,
          action: {
            label: "Open",
            onClick: () => window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE_EVENT, { detail: { name, path: result.matrixPath } })),
          },
        });
      } else {
        toast.success(
          `Added ${result.addedCount} ${result.addedCount === 1 ? "study" : "studies"}${result.duplicateCount ? ` · ${result.duplicateCount} already present` : ""}`,
          {
            id: loadingToast,
            description: result.matrixPath,
            action: {
              label: "Open",
              onClick: () => window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE_EVENT, { detail: { name, path: result.matrixPath } })),
            },
          },
        );
      }
    } catch (error) {
      toast.error("Could not add to the matrix", {
        id: loadingToast,
        description: errorDetail(error),
      });
    } finally {
      setSaving(false);
      setSavingPath(undefined);
      setPending(undefined);
    }
  }, [onCommitSuccess, projectId, enabled]);

  // Once the target list resolves, a pending request for a single-matrix
  // project commits immediately to the default; several targets keep the
  // picker open until the user chooses.
  useEffect(() => {
    if (!pending || !targets) return;
    if (targets.length <= 1) {
      const request = pending;
      setPending(undefined);
      void commit(request);
    }
  }, [commit, pending, targets]);

  // Read known membership immediately. The search's existing saved-state
  // request seeds this cache; confirmed writes update it before the dialog
  // closes. Never queue a membership action ahead of the write.
  useEffect(() => {
    if (!pending || !targets || targets.length <= 1) {
      setMemberPaths(undefined);
      return;
    }
    const ids = pending.kind === "literature"
      ? pending.items.map((item) => item.id)
      : pending.kind === "citations"
        ? pending.entries.map((entry) => entry.citationKey)
        : [pending.path];
    setMemberPaths(matrixPathsForRequest(projectId, pending.kind, ids));
  }, [pending, projectId, targets]);

  const add = useCallback((request: MatrixAddRequest) => {
    if (!enabled) return;
    setPending(request);
  }, [enabled]);

  const pick = useCallback((matrixPath?: string) => {
    if (!pending) return;
    void commit(pending, matrixPath);
  }, [commit, pending]);

  const cancel = useCallback(() => setPending(undefined), []);

  return {
    targets,
    saving,
    savingPath,
    pending,
    pickerOpen: pending !== undefined && (targets?.length ?? 0) > 1,
    memberPaths,
    add,
    pick,
    cancel,
  };
}

export function MatrixTargetDialog({
  projectId,
  open,
  targets,
  saving,
  savingPath,
  memberPaths,
  onCancel,
  onPick,
}: {
  projectId: string;
  open: boolean;
  targets: MatrixFileSummary[] | undefined;
  saving: boolean;
  savingPath?: string;
  /** Matrices that already contain every pending study. */
  memberPaths?: string[];
  onCancel: () => void;
  onPick: (matrixPath?: string) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const createAndPick = async () => {
    setCreating(true);
    try {
      const result = await createMatrixFile({ projectId, name });
      if (!result.success) {
        toast.error("Could not create the matrix", { description: result.error });
        return;
      }
      dispatchWorkspaceMutation({
        kind: "create",
        entry: {
          path: result.matrixPath,
          name: result.matrixPath.split("/").at(-1) || result.matrixPath,
          isDir: false,
          size: 0,
        },
      });
      onPick(result.matrixPath);
    } catch (error) {
      toast.error("Could not create the matrix", {
        description: errorDetail(error),
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving && !creating) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Matrix</DialogTitle>
          {/* <DialogDescription>
            Your project has several literature matrices. Pick the target, or create a new one. Studies marked “Added” are already in that matrix.
          </DialogDescription> */}
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          {(targets ?? []).map((target) => {
            const added = memberPaths?.includes(target.path);
            return (
              <Button
                key={target.path}
                type="button"
                variant="outline"
                className="h-auto w-full justify-start px-3 py-2.5"
                disabled={saving || creating}
                onClick={() => onPick(target.path)}
              >
                <Table2 className="size-4 shrink-0 text-primary" />
                <span className="ml-1 min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium">{target.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{target.path}</span>
                </span>
                {target.isDefault ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-primary">Default</span>
                ) : null}
                {saving && savingPath === target.path ? (
                  <span role="status" className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />Adding…
                  </span>
                ) : added ? (
                  <span className="flex shrink-0 items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-700 dark:text-emerald-400">
                    <Check className="size-3" />Added
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
        <form
          className={cn("flex flex-col gap-2 border-t pt-3", (targets?.length ?? 0) > 0 ? "mt-3" : "mt-1")}
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void createAndPick();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Create New Matrix?"
              aria-label="New Matrix Name"
              className="h-8 text-xs"
              disabled={saving || creating}
            />
            <Button type="submit" size="sm" className="h-8 shrink-0" disabled={saving || creating || !name.trim()}>
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
              Create
            </Button>
          </div>
        </form>
        {/* <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving || creating}>Cancel</Button>
        </DialogFooter> */}
      </DialogContent>
    </Dialog>
  );
}
