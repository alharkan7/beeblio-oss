"use client";

import {
  ArrowLeft,
  Code,
  FormInput,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
  PencilSparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SKILLS_CHANGED_EVENT } from "@/lib/chat-context";
import {
  cachedSkillMarkdown,
  cachedSkills,
  forgetSkill,
  rememberSkillMarkdown,
  rememberSkills,
} from "@/lib/skills-cache";
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  validateSkillDraft,
} from "@/lib/skill-markdown";
import { createSkill, deleteSkill, getSkill, listSkills, saveSkill, type SkillSummary } from "../skill-actions";
import { errorDetail } from "@/lib/error-detail";

type EditorMode = "form" | "markdown";

type SkillEditor = {
  slug: string;
  isNew: boolean;
  mode: EditorMode;
  name: string;
  description: string;
  instructions: string;
  markdown: string;
  invalidReason?: string;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
};

export function SkillsPanel({ initialSkills }: { initialSkills?: SkillSummary[] }) {
  // The module cache outlives this panel's mounts, so prefer it over the
  // server-rendered seed (which is a snapshot from page load).
  const [skills, setSkills] = useState<SkillSummary[] | null>(
    () => cachedSkills() ?? initialSkills ?? null,
  );
  const [editor, setEditor] = useState<SkillEditor>();
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary>();
  const [deletePending, setDeletePending] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // Set after a successful save; shown briefly next to the editor title as an
  // inline success cue alongside the toast.
  const [savedFlashAt, setSavedFlashAt] = useState<number>();

  useEffect(() => {
    if (savedFlashAt === undefined) return;
    const timer = window.setTimeout(() => setSavedFlashAt(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [savedFlashAt]);

  // Set when the list has never loaded. Shown in place of the empty state,
  // which would otherwise invite creating a skill the agent cannot save.
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const hasList = useRef(skills !== null);

  const refreshSkills = useCallback(async () => {
    try {
      const list = await listSkills();
      rememberSkills(list);
      setSkills(list);
      hasList.current = true;
      setLoadFailed(false);
    } catch (error) {
      // Background refreshes run on every window focus, so a toast here
      // would repeat for as long as the agent is unreachable. A list already
      // on screen (cache or seed) stays as it is.
      console.error("[skills] refresh failed", error);
      if (!hasList.current) setLoadFailed(true);
    }
  }, []);

  const retryLoad = async () => {
    setRetrying(true);
    await refreshSkills();
    setRetrying(false);
  };

  // Reconcile against the server in the background on mount and when the tab
  // regains focus, so cached content paints instantly and staleness is brief.
  useEffect(() => {
    void refreshSkills();
    const handleFocus = () => void refreshSkills();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshSkills]);

  const notifySkillsChanged = () => {
    window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT));
  };

  const openSkill = async (summary: SkillSummary) => {
    setSavedFlashAt(undefined);
    // A previously opened skill's body lives in the module cache, so reopening
    // it skips the loading state entirely; the fetch below reconciles in the
    // background but never clobbers edits made in the meantime.
    const cachedMarkdown = cachedSkillMarkdown(summary.slug);
    const base: SkillEditor = {
      slug: summary.slug,
      isNew: false,
      mode: summary.invalidReason ? "markdown" : "form",
      name: summary.name,
      description: summary.description,
      instructions: "",
      markdown: "",
      invalidReason: summary.invalidReason,
      dirty: false,
      loading: cachedMarkdown === undefined,
      saving: false,
    };
    setEditor(
      cachedMarkdown === undefined
        ? base
        : hydratedEditor(base, { ...summary, markdown: cachedMarkdown }),
    );
    try {
      const skill = await getSkill(summary.slug);
      rememberSkillMarkdown(skill.slug, skill.markdown);
      setEditor((current) =>
        current && !current.dirty && !current.isNew && current.slug === skill.slug
          ? hydratedEditor(current, skill)
          : current,
      );
    } catch (error) {
      if (cachedMarkdown !== undefined) return;
      toast.error("Failed to open skill", {
        description: errorDetail(error),
      });
      setEditor(undefined);
    }
  };

  const newSkill = () => {
    setSavedFlashAt(undefined);
    setEditor({
      slug: "",
      isNew: true,
      mode: "form",
      name: "",
      description: "",
      instructions: "",
      markdown: "",
      dirty: false,
      loading: false,
      saving: false,
    });
  };

  const requestCloseEditor = () => {
    if (!editor) return;
    if (editor.dirty) {
      setDiscardOpen(true);
      return;
    }
    setEditor(undefined);
  };

  const switchMode = (mode: EditorMode) => {
    setEditor((current) => {
      if (!current || current.mode === mode || current.loading) return current;
      if (mode === "markdown") {
        const fields: Record<string, string> = current.name.trim() || current.slug
          ? { name: current.name.trim() || current.slug, description: current.description }
          : { description: current.description.trim() || "Describe when Beeblio should use this skill." };
        return {
          ...current,
          mode,
          markdown: serializeSkillMarkdown(fields, current.instructions),
        };
      }
      try {
        const parsed = parseSkillMarkdown(current.markdown);
        return {
          ...current,
          mode,
          name: parsed.name || current.slug,
          description: parsed.description,
          instructions: parsed.body.replace(/^\s*\n/, ""),
          invalidReason: undefined,
        };
      } catch (error) {
        toast.error("Fix the markdown first", {
          description: errorDetail(error),
        });
        return current;
      }
    });
  };

  const saveEditor = async () => {
    if (!editor || editor.saving || editor.loading) return;

    let markdown: string;
    if (editor.mode === "form") {
      const problem = validateSkillDraft({
        name: editor.name,
        description: editor.description,
        instructions: editor.instructions,
      });
      if (problem) {
        toast.error(problem);
        return;
      }
      markdown = serializeSkillMarkdown(
        { name: editor.name.trim(), description: editor.description.trim() },
        editor.instructions,
      );
    } else {
      markdown = editor.markdown;
      try {
        parseSkillMarkdown(markdown);
      } catch (error) {
        toast.error("Fix the markdown first", {
          description: errorDetail(error),
        });
        return;
      }
    }

    setEditor((current) => (current ? { ...current, saving: true } : current));
    try {
      const saved = editor.isNew
        ? await createSkill({
            name: editor.mode === "form" ? editor.name : deriveName(markdown, editor.slug),
            description: editor.mode === "form" ? editor.description : "",
            instructions: editor.mode === "form" ? editor.instructions : "",
            ...(editor.mode === "markdown" ? { markdown } : {}),
          })
        : await saveSkill(editor.slug, markdown);

      toast.success(`Skill "${saved.name || saved.slug}" saved`);
      setSavedFlashAt(Date.now());
      rememberSkillMarkdown(saved.slug, markdown);
      notifySkillsChanged();
      await refreshSkills();
      setEditor((current) =>
        current
          ? {
              ...current,
              slug: saved.slug,
              isNew: false,
              markdown: editor.mode === "form" ? markdown : current.markdown,
              name: editor.mode === "form" ? current.name : saved.name,
              description: editor.mode === "form" ? current.description : saved.description,
              invalidReason: undefined,
              dirty: false,
              saving: false,
            }
          : current,
      );
    } catch (error) {
      toast.error("Failed to save skill", {
        description: errorDetail(error),
      });
      setEditor((current) => (current ? { ...current, saving: false } : current));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    try {
      await deleteSkill(deleteTarget.slug);
      toast.success(`Skill "${deleteTarget.name || deleteTarget.slug}" deleted`);
      forgetSkill(deleteTarget.slug);
      if (editor?.slug === deleteTarget.slug) setEditor(undefined);
      notifySkillsChanged();
      await refreshSkills();
    } catch (error) {
      toast.error("Failed to delete skill", {
        description: errorDetail(error),
      });
    } finally {
      setDeletePending(false);
      setDeleteTarget(undefined);
    }
  };

  if (editor) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={requestCloseEditor}
            aria-label="Back to skills"
            title="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={editor.slug}>
            {editor.isNew ? "New Skill" : editor.name || editor.slug}
          </span>
          {/* {savedFlashAt !== undefined ? (
            <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400" role="status">
              <Check className="size-3" />
              Saved
            </span>
          ) : null} */}
          <div className="flex shrink-0 items-center rounded-md border px-2 py-1">
            <button
              type="button"
              disabled={editor.loading}
              title="Form view"
              aria-label="Form view"
              className={cn(
                "rounded p-1 transition-colors disabled:opacity-40",
                editor.mode === "form"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => switchMode("form")}
            >
              <FormInput className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={editor.loading}
              title="Markdown view"
              aria-label="Markdown view"
              className={cn(
                "rounded p-1 transition-colors disabled:opacity-40",
                editor.mode === "markdown"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => switchMode("markdown")}
            >
              <Code className="size-3.5" />
            </button>
          </div>
        </div>

        {editor.loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : editor.mode === "form" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-name" className="text-xs">Name</Label>
                <Input
                  id="skill-name"
                  value={editor.name}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, name: event.target.value, dirty: true } : current,
                    )
                  }
                  placeholder="e.g. APA Stats Reporting"
                  className="h-8 text-xs"
                />
                {/* {!editor.isNew ? (
                  <p className="text-[10px] text-muted-foreground">
                    Mention in chat as <code className="font-mono">/{editor.slug}</code> (renaming keeps this id)
                  </p>
                ) : null} */}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-description" className="text-xs">
                  When to Use
                </Label>
                <Textarea
                  id="skill-description"
                  value={editor.description}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? { ...current, description: event.target.value, dirty: true }
                        : current,
                    )
                  }
                  placeholder="Use when reporting statistical results in APA style."
                  className="min-h-16 text-xs"
                />
                {/* <p className="text-[10px] text-muted-foreground">
                  Beeblio sees this line every conversation and loads the skill when a request matches it.
                </p> */}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="skill-instructions" className="text-xs">Instructions</Label>
                <Textarea
                  id="skill-instructions"
                  value={editor.instructions}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? { ...current, instructions: event.target.value, dirty: true }
                        : current,
                    )
                  }
                  placeholder="Write the procedure Beeblio should follow, step by step…"
                  className="min-h-64 font-mono text-xs"
                />
              </div>
              <Button onClick={() => void saveEditor()} disabled={editor.saving} size="sm">
                {editor.saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {editor.isNew ? "Create Skill" : "Save Changes"}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Learn more:{" "}
                <a
                  href="https://agentskills.io/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  agentskills.io
                </a>
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-3">
            {editor.invalidReason ? (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{editor.invalidReason} Fix it here, then save.</span>
              </div>
            ) : null}
            <Textarea
              value={editor.markdown}
              onChange={(event) =>
                setEditor((current) =>
                  current
                    ? { ...current, markdown: event.target.value, dirty: true }
                    : current,
                )
              }
              aria-label="SKILL.md contents"
              spellCheck={false}
              className="min-h-0 flex-1 resize-none font-mono text-xs"
              placeholder={"---\nname: My Skill\ndescription: Use when…\n---\n\nInstructions…"}
            />
            <Button onClick={() => void saveEditor()} disabled={editor.saving} size="sm" className="mt-3">
              {editor.saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {editor.isNew ? "Create Skill" : "Save Changes"}
            </Button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Learn more:{" "}
              <a
                href="https://agentskills.io/"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                agentskills.io
              </a>
            </p>
          </div>
        )}

        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard Unsaved Changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Your edits to this skill have not been saved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep Editing</AlertDialogCancel>
              <Button variant="destructive" onClick={() => { setDiscardOpen(false); setEditor(undefined); }}>
                Discard
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">Agent Skills</span>
        <Button
          variant="default"
          size="icon"
          className="h-7 w-7"
          // onClick={() => notifyUpcomingFeature("Skill creation")}
          onClick={newSkill}
          aria-label="New skill"
          title="New Skill"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {skills === null && loadFailed ? (
          <div className="flex h-36 flex-col items-center justify-center rounded-xl border border-dashed px-4 text-center" role="alert">
            <TriangleAlert className="mb-2 size-5 text-amber-600 dark:text-amber-400" />
            <span className="text-sm font-medium text-foreground">Skills could not be loaded</span>
            <span className="mt-1 max-w-52 text-xs leading-5 text-muted-foreground">
              The agent is not responding. It may still be starting.
            </span>
            <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void retryLoad()} disabled={retrying}>
              {retrying ? <Loader2 className="animate-spin" /> : null}
              Try again
            </Button>
          </div>
        ) : skills === null ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : skills.length === 0 ? (
          <button
            type="button"
            className="flex h-36 w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed bg-card/60 px-4 text-center transition-colors hover:border-primary/40 hover:bg-card"
            // onClick={() => notifyUpcomingFeature("Skill creation")}
            onClick={newSkill}
          >
            <PencilSparkles className="mb-2 size-5 text-primary" />
            <span className="text-sm font-medium text-foreground">Create Your Agent Skill</span>
            <span className="mt-1 max-w-52 text-xs leading-5 text-muted-foreground">
              Teach Beeblio a reusable procedure you invoke in chat with /skill-name.
            </span>
          </button>
        ) : (
          <div className="flex flex-col gap-0.5">
            {skills.map((skill) => (
              <div
                key={skill.slug}
                className="group flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 transition-colors hover:bg-muted/60"
                onClick={() => void openSkill(skill)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") void openSkill(skill);
                }}
              >
                <PencilSparkles
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    skill.invalidReason ? "text-amber-500" : "text-primary",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {skill.name || skill.slug}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground line-clamp-2">
                    {skill.invalidReason ? "Invalid SKILL.md — open to fix" : skill.description}
                  </span>
                  <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground/70">
                    /{skill.slug}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  // In the flex flow (not absolutely positioned) so it never
                  // covers the row text; always visible on touch devices,
                  // hover/focus-revealed only where a pointer can hover.
                  className={cn(
                    "-mr-1 mt-0.5 size-6 shrink-0 self-start transition-opacity",
                    "focus-visible:opacity-100 group-focus-visible:opacity-100",
                    "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteTarget(skill);
                  }}
                  aria-label={`Delete ${skill.name || skill.slug}`}
                  title="Delete"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="mt-3 w-full" onClick={newSkill}>
              <Plus className="mr-2 h-4 w-4" />
              New Skill
            </Button>
          </div>
        )}
      </div>

      <Dialog open={deleteTarget !== undefined} onOpenChange={(open) => { if (!open && !deletePending) setDeleteTarget(undefined); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete skill?</DialogTitle>
            <DialogDescription>
              This permanently removes <span className="font-medium text-foreground">{deleteTarget ? `/${deleteTarget.slug}` : ""}</span> and its SKILL.md. The action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(undefined)} disabled={deletePending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deletePending}>
              {deletePending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Fill the form from the file so editing round-trips: without this, reopening
// a skill shows name/description but a blank Instructions box (the body only
// lived in `markdown`). Unparseable markdown falls back to raw editing mode.
function hydratedEditor(
  current: SkillEditor,
  skill: SkillSummary & { markdown: string },
): SkillEditor {
  try {
    const parsed = parseSkillMarkdown(skill.markdown);
    return {
      ...current,
      name: parsed.name || skill.name || skill.slug,
      description: parsed.description,
      instructions: parsed.body.replace(/^\s*\n/, ""),
      markdown: skill.markdown,
      invalidReason: undefined,
      loading: false,
    };
  } catch {
    return {
      ...current,
      name: skill.name,
      description: skill.description,
      markdown: skill.markdown,
      invalidReason: skill.invalidReason,
      mode: "markdown",
      loading: false,
    };
  }
}

function deriveName(markdown: string, fallback: string): string {
  try {
    return parseSkillMarkdown(markdown).name || fallback || "skill";
  } catch {
    return fallback || "skill";
  }
}
