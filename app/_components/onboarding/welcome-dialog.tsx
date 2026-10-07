"use client";

import { useState } from "react";
import { ArrowRight, BookOpenText, CircleCheck, FolderPlus, Loader2, Sparkles, Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SETTINGS, type SettingName } from "@/lib/app-settings-registry";
import { cn } from "@/lib/utils";
import { completeOnboarding } from "@/app/onboarding-actions";
import { SettingField, useSettingsForm } from "../app-settings-dialog";
import { CreateProjectForm } from "../create-project-form";

type Step = "welcome" | "connect" | "project";
const STEPS: readonly Step[] = ["welcome", "connect", "project"];

/** What the agent cannot run without; the context window is asked for only if OpenRouter could not fill it in. */
const SETUP_FIELDS: readonly SettingName[] = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL_ID", "OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS"];

const FEATURES = [
  { Icon: Sparkles, title: "An assistant that works in your files", body: "It searches, analyses, and writes inside your project folder." },
  { Icon: BookOpenText, title: "Literature in one place", body: "Find papers, keep references, and build a literature matrix next to your drafts." },
  { Icon: Table2, title: "Data, reports, and figures", body: "Edit documents, spreadsheets, notebooks, and LaTeX without switching apps." },
] as const;

/**
 * First-run welcome on the projects page: what Beeblio is, connecting a model
 * (the same fields and checks as Settings), and the first project, whose
 * workspace then starts the tour. Shown until it is finished or skipped once.
 */
export function WelcomeDialog({
  open,
  onOpenChange,
  hasProjects,
  onSetupChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasProjects: boolean;
  /** Lets the account menu clear its "Finish setup" hint. */
  onSetupChange?: (missingRequired: string[]) => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  /** Once connected the fields are folded away; "Change" brings them back. */
  const [editingSetup, setEditingSetup] = useState(false);
  const form = useSettingsForm(open, (snapshot) => onSetupChange?.(snapshot.missingRequired));
  const { snapshot } = form;
  const connected = snapshot ? snapshot.missingRequired.length === 0 : false;

  const close = (outcome: "done" | "skipped") => {
    // Skipping the welcome skips the tour too; finishing it leaves the tour for the first project.
    void completeOnboarding("welcome", outcome).catch(() => {});
    if (outcome === "skipped") void completeOnboarding("tour", "skipped").catch(() => {});
    onOpenChange(false);
    setStep("welcome");
    setEditingSetup(false);
  };

  const goTo = (next: Step) => {
    // Reaching the last step counts as done, since creating a project leaves this page.
    if (next === "project") void completeOnboarding("welcome", "done").catch(() => {});
    setStep(next);
  };

  const saveSetup = async () => {
    const patch = Object.fromEntries(Object.entries(form.changes).filter(([name]) => SETUP_FIELDS.includes(name as SettingName)));
    // Stays on this step either way: on success it shows "Connected", or asks for the context window if OpenRouter could not be reached.
    if (Object.keys(patch).length) await form.apply(patch, "save", "Model connected");
  };

  const setupSettings = SETTINGS.filter((setting) => {
    if (!SETUP_FIELDS.includes(setting.name as SettingName)) return false;
    if (setting.name !== "OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS") return true;
    // Only asked for when a model is saved and its context window could not be looked up.
    return Boolean(snapshot?.settings.OPENROUTER_MODEL_ID?.source) && !snapshot?.settings.OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS?.source;
  });
  const setupChanged = Object.keys(form.changes).some((name) => SETUP_FIELDS.includes(name as SettingName));

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close(step === "project" ? "done" : "skipped"))}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => event.preventDefault()}
        // A stray click beside the dialog should not skip the whole walkthrough; Esc and Skip do.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <StepDots step={step} />
        {step === "welcome" ? (
          <>
            <DialogHeader className="items-start text-left">
              <img src="/beeblio-mark.svg" alt="" className="mb-2 size-10" />
              <DialogTitle className="text-xl">Welcome to Beeblio</DialogTitle>
              <DialogDescription>A research workspace with an AI assistant. Here is what you can do with it.</DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-3">
              {FEATURES.map(({ Icon, title, body }) => (
                <li key={title} className="flex gap-3 rounded-xl border bg-card p-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{title}</span>
                    <span className="block text-xs text-muted-foreground">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => close("skipped")}>Skip</Button>
              <Button type="button" onClick={() => goTo("connect")} autoFocus>Get started<ArrowRight /></Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "connect" ? (
          <>
            <DialogHeader className="text-left">
              <DialogTitle className="text-xl">Connect a model</DialogTitle>
              <DialogDescription>
                Beeblio uses models from OpenRouter, paid with your own key. Pick any model there; its context window is filled in for you.
              </DialogDescription>
            </DialogHeader>
            {!snapshot && !form.error ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
            {snapshot && connected && !setupChanged ? (
              <p className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300" role="status">
                <CircleCheck className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">Connected to {snapshot.settings.OPENROUTER_MODEL_ID?.value ?? "OpenRouter"}. You can change this later in Settings.</span>
                {!editingSetup ? <button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={() => setEditingSetup(true)}>Change</button> : null}
              </p>
            ) : null}
            {snapshot && (!connected || editingSetup || setupChanged) ? (
              <form
                className="flex flex-col gap-3 rounded-lg border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSetup();
                }}
                noValidate
              >
                {setupSettings.map((setting) => <SettingField key={setting.name} setting={setting} {...form.fieldProps} />)}
                {form.error && !form.error.field ? <p className="text-xs text-destructive" role="alert">{form.error.message}</p> : null}
                {setupChanged ? (
                  <Button type="submit" size="sm" className="self-end" disabled={form.busy}>
                    {form.pending === "save" ? <Loader2 className="animate-spin" /> : null}
                    Check and save
                  </Button>
                ) : null}
              </form>
            ) : form.error ? <p className="text-xs text-destructive" role="alert">{form.error.message}</p> : null}
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep("welcome")} disabled={form.busy}>Back</Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                {!connected ? <Button type="button" variant="outline" onClick={() => goTo("project")} disabled={form.busy}>Set up later</Button> : null}
                <Button type="button" onClick={() => goTo("project")} disabled={!connected || setupChanged || form.busy}>Continue<ArrowRight /></Button>
              </div>
            </DialogFooter>
          </>
        ) : null}

        {step === "project" ? (
          <>
            <DialogHeader className="text-left">
              <DialogTitle className="text-xl">{hasProjects ? "Open a project" : "Create your first project"}</DialogTitle>
              <DialogDescription>
                {hasProjects
                  ? "Open any of your projects; a short tour of the workspace starts there."
                  : "A project is a folder on your computer. Beeblio adds its research folders without replacing your files, and a short tour of the workspace starts when it opens."}
              </DialogDescription>
            </DialogHeader>
            {!connected ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300" role="status">
                The assistant needs a model before it can answer. Use <span className="font-medium">Finish setup</span> in the account menu when you are ready.
              </p>
            ) : null}
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep("connect")}>Back</Button>
              {hasProjects ? (
                <Button type="button" onClick={() => close("done")} autoFocus>Go to my projects</Button>
              ) : (
                <CreateProjectForm customTrigger={<Button type="button" autoFocus><FolderPlus />Link a project folder</Button>} />
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StepDots({ step }: { step: Step }) {
  const current = STEPS.indexOf(step);
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${current + 1} of ${STEPS.length}`} role="img">
      {STEPS.map((candidate, index) => (
        <span key={candidate} className={cn("h-1.5 rounded-full transition-all", index === current ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30")} />
      ))}
    </div>
  );
}
