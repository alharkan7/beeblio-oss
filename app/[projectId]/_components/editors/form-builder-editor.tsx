"use client";

import { useEffect, useMemo, useState } from "react";
import { Code2, Eye, ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";

import { Brand } from "@/app/_components/brand";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { generateFormHtml } from "@/lib/forms/generate";
import { parseFormHtml } from "@/lib/forms/parse";
import {
  BLOCK_TYPES,
  BLOCK_TYPE_META,
  createBlock,
  isQuestionBlock,
  parseFormDefinition,
  type BlockType,
  type FormBlock,
  type FormDefinition,
} from "@/lib/forms/schema";
import { cn } from "@/lib/utils";

import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import { SourceCodeEditor } from "./source-code-editor";
import type { WorkspaceEditorProps } from "./types";
import { useTextFile } from "./use-text-file";
import { BlockCard } from "./form-builder/block-card";
import { BLOCK_TYPE_ICONS } from "./form-builder/block-type-icons";
import { BARE_FIELD, FLAT_FIELD } from "./form-builder/styles";
import { errorDetail } from "@/lib/error-detail";

type ViewMode = "build" | "preview" | "source";

const QUESTION_TYPES = BLOCK_TYPES.filter(
  (type) => type !== "section" && type !== "statement",
) as BlockType[];
const LAYOUT_TYPES: BlockType[] = ["section", "statement"];

/**
 * Visual builder for Beeblio form files (*.form.html). The editing state is a
 * parsed FormDefinition; every edit immediately regenerates the whole HTML
 * into the text draft (so dirty-tracking, save, discard, and source view work
 * exactly like every other text editor). Source edits are re-parsed when
 * switching back to Build. Validation runs at save time, so in-progress
 * typing (trailing spaces, cleared options) never fights the user.
 */
export function FormBuilderEditor({ projectId, file, sourceUrl, onSaved }: WorkspaceEditorProps) {
  const text = useTextFile(projectId, file.path, onSaved);
  const [mode, setMode] = useState<ViewMode>("build");
  const [definition, setDefinition] = useState<FormDefinition | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);

  // Sync the builder state from the saved content whenever it changes: file
  // load, save, discard, and background reloads after agent edits.
  useEffect(() => {
    if (text.loading) return;
    try {
      setDefinition(parseFormHtml(text.content));
      setDefinitionError(null);
    } catch (error) {
      setDefinition(null);
      setDefinitionError(
        errorDetail(error, "The embedded form definition is invalid."),
      );
    }
  }, [text.content, text.loading]);

  // A file that cannot be parsed has no Build mode; drop the user into source.
  useEffect(() => {
    if (definitionError && !text.loading) setMode("source");
  }, [definitionError, text.loading]);

  const applyDefinition = (next: FormDefinition) => {
    setDefinition(next);
    setDefinitionError(null);
    text.setDraft(generateFormHtml(next));
  };

  const updateDefinition = (updater: (current: FormDefinition) => FormDefinition) => {
    if (!definition) return;
    applyDefinition(updater(definition));
  };

  // Normalizing variants (duplicate, palette add) run the whole definition
  // through the canonicalizer so ids stay unique; typing edits do not.
  const updateDefinitionNormalized = (updater: (current: FormDefinition) => FormDefinition) => {
    if (!definition) return;
    try {
      applyDefinition(parseFormDefinition(updater(definition)));
    } catch (error) {
      toast.error("That change is not valid yet", {
        description: errorDetail(error),
      });
    }
  };

  const switchMode = (next: ViewMode) => {
    if (next === "build" && mode !== "build" && text.dirty) {
      try {
        applyDefinition(parseFormHtml(text.draft));
      } catch (error) {
        toast.error("Fix the form definition before switching to Build", {
          description: errorDetail(error),
        });
        return;
      }
    }
    setMode(next);
  };

  const syncDefinitionFromContent = () => {
    try {
      setDefinition(parseFormHtml(text.content));
      setDefinitionError(null);
    } catch (error) {
      setDefinition(null);
      setDefinitionError(
        errorDetail(error, "The embedded form definition is invalid."),
      );
    }
  };

  const handleDiscard = () => {
    text.discard();
    // The draft reverts to the saved content; the builder must follow it.
    syncDefinitionFromContent();
  };

  const save = async () => {
    if (!definition) {
      await text.save();
      return;
    }
    try {
      const normalized = parseFormDefinition(definition);
      const html = generateFormHtml(normalized);
      const saved = await text.save(html);
      if (saved) setDefinition(normalized);
    } catch (error) {
      toast.error("The form has invalid content", {
        description: errorDetail(error, "Resolve the highlighted problems and try again."),
      });
    }
  };

  const addBlock = (type: BlockType) => {
    updateDefinitionNormalized((current) => {
      const takenIds = new Set(current.blocks.map((block) => block.id));
      return { ...current, blocks: [...current.blocks, createBlock(type, takenIds)] };
    });
  };

  const paletteItem = (type: BlockType) => {
    const Icon = BLOCK_TYPE_ICONS[type];
    return (
      <DropdownMenuItem key={type} className="items-start" onClick={() => addBlock(type)}>
        <Icon className="mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span className="text-sm">{BLOCK_TYPE_META[type].label}</span>
          <span className="text-[11px] text-muted-foreground">
            {BLOCK_TYPE_META[type].description}
          </span>
        </span>
      </DropdownMenuItem>
    );
  };

  const updateBlock = (next: FormBlock) =>
    updateDefinition((current) => ({
      ...current,
      blocks: current.blocks.map((block) => (block.id === next.id ? next : block)),
    }));

  const deleteBlock = (id: string) =>
    updateDefinition((current) => ({
      ...current,
      blocks: current.blocks.filter((block) => block.id !== id),
    }));

  const moveBlock = (id: string, direction: -1 | 1) =>
    updateDefinition((current) => {
      const index = current.blocks.findIndex((block) => block.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.blocks.length) return current;
      const blocks = [...current.blocks];
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      return { ...current, blocks };
    });

  const duplicateBlock = (id: string) =>
    updateDefinitionNormalized((current) => {
      const index = current.blocks.findIndex((block) => block.id === id);
      if (index < 0) return current;
      const blocks = [...current.blocks];
      // The copy keeps the same id; the normalization pass re-slugs it to a
      // unique id and copies every field verbatim.
      blocks.splice(index + 1, 0, { ...current.blocks[index] });
      return { ...current, blocks };
    });

  const questionCount = useMemo(
    () => definition?.blocks.filter(isQuestionBlock).length ?? 0,
    [definition],
  );
  // Numbering skips section/statement blocks, like the rendered form.
  const questionNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    let number = 0;
    for (const block of definition?.blocks ?? []) {
      if (isQuestionBlock(block)) {
        number += 1;
        numbers.set(block.id, number);
      }
    }
    return numbers;
  }, [definition]);

  return (
    <EditorShell
      path={file.path}
      sourceUrl={sourceUrl}
      dirty={text.dirty}
      status={
        <span className="text-xs text-muted-foreground mr-2">
          Form · {questionCount} Question{questionCount === 1 ? "" : "s"}
        </span>
      }
      viewModes={[{
        value: mode,
        onChange: (value) => switchMode(value as ViewMode),
        options: [
          { value: "build", label: "Build", icon: ListChecks, title: "Edit the form visually" },
          { value: "preview", label: "Preview", icon: Eye, title: "Preview the form as respondents see it" },
          { value: "source", label: "HTML source", icon: Code2, title: "Edit the raw HTML source" },
        ],
      }]}
      discard={{ onDiscard: handleDiscard, disabled: text.saving }}
      save={{ onClick: () => void save(), saving: text.saving }}
      review={text.review}
    >
      {text.loading ? (
        <EditorLoading name={file.name} size={file.size} />
      ) : text.error ? (
        <EditorError message={text.error} />
      ) : mode === "source" ? (
        <div className="flex h-full min-h-0 flex-col">
          {definitionError ? (
            <div className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {definitionError} — edit the JSON definition inside the{" "}
              <code className="rounded bg-muted px-1">beeblio-form-definition</code> script block,
              or fix it in Build mode.
            </div>
          ) : null}
          <SourceCodeEditor value={text.draft} extension="html" onChange={text.setDraft} />
        </div>
      ) : mode === "preview" ? (
        <div className="h-full min-h-0 overflow-auto bg-background p-4">
          <iframe
            title={`Preview of ${file.name}`}
            sandbox="allow-scripts allow-forms allow-popups"
            srcDoc={text.draft}
            className="mx-auto block h-full min-h-[640px] w-full max-w-3xl rounded-lg border bg-white shadow-sm"
          />
        </div>
      ) : definition ? (
        <div className="h-full min-h-0 overflow-y-auto bg-background">
          <div className="mx-auto w-full max-w-[760px] space-y-3.5 px-4 pb-16 pt-6">
            <div className="rounded-xl border bg-card px-4 py-4 shadow-sm sm:px-6 sm:py-5">
              <Input
                value={definition.title}
                onChange={(event) =>
                  updateDefinition((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Form title"
                aria-label="Form title"
                className={cn(BARE_FIELD, "text-2xl font-semibold tracking-tight md:text-2xl")}
              />
              <Textarea
                value={definition.description ?? ""}
                onChange={(event) =>
                  updateDefinition((current) => ({
                    ...current,
                    description: event.target.value || undefined,
                  }))
                }
                placeholder="Form description (optional)"
                aria-label="Form description"
                className={cn(
                  BARE_FIELD,
                  "min-h-8 text-[15px] text-muted-foreground md:text-[15px]",
                )}
              />
              <div className="mt-3 space-y-1 border-t pt-3">
                <span className="block text-xs text-muted-foreground">Confirmation message</span>
                <Input
                  value={definition.settings?.confirmationMessage ?? ""}
                  onChange={(event) =>
                    updateDefinition((current) => ({
                      ...current,
                      settings: {
                        ...current.settings,
                        confirmationMessage: event.target.value || undefined,
                      },
                    }))
                  }
                  placeholder="Shown after submitting (optional)"
                  aria-label="Confirmation message"
                  className={cn(FLAT_FIELD, "h-8 text-sm")}
                />
              </div>
            </div>

            {definition.blocks.map((block, index) => (
              <BlockCard
                key={block.id}
                block={block}
                questionNumber={questionNumbers.get(block.id) ?? null}
                isFirst={index === 0}
                isLast={index === definition.blocks.length - 1}
                onChange={updateBlock}
                onDelete={() => deleteBlock(block.id)}
                onMove={(direction) => moveBlock(block.id, direction)}
                onDuplicate={() => duplicateBlock(block.id)}
              />
            ))}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-full border-dashed">
                  <Plus className="size-4" />
                  Add Question or Section
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
                <DropdownMenuLabel>Questions</DropdownMenuLabel>
                {QUESTION_TYPES.map(paletteItem)}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Layout</DropdownMenuLabel>
                {LAYOUT_TYPES.map(paletteItem)}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
              <Brand href="/" />
              <p className="max-w-xs text-right text-[11px] leading-5 text-muted-foreground">
                Share this file to collect responses.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
            <p className="text-sm font-medium">This form file could not be opened in the builder</p>
            <p className="mt-1 text-xs text-muted-foreground">{definitionError}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setMode("source")}>
              <Code2 className="size-4" />
              Edit HTML source
            </Button>
          </div>
        </div>
      )}
    </EditorShell>
  );
}
