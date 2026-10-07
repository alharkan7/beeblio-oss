import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useState,
} from "react";
import {
  Command,
  ArrowUp,
  FileIcon,
  Folder,
  Loader2,
  Paperclip,
  Pencil,
  Square,
  Quote,
  ScreenShare,
  Wrench,
  X,
} from "lucide-react";

import { toast } from "sonner";

import {
  captureScreenshot,
  PromptInput,
  type PromptInputMessage,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileEntry } from "@/app/[projectId]/file-actions";
import type { SkillSummary } from "@/app/[projectId]/skill-actions";
import type {
  ChatFileContext,
  ChatSelectionContext,
} from "@/lib/chat-context";
import { cn } from "@/lib/utils";

type ComposerStatus = "ready" | "submitted" | "streaming" | "error";

export function AgentChatComposer({
  draft,
  draftInputRef,
  uploadInputRef,
  mentionedFiles,
  mentionedSkills,
  attachedSelections,
  mentionQuery,
  mentionResults,
  skillQuery,
  groupedSkillResults,
  activeMentionIndex,
  isUploading,
  showViewingContext,
  activeFilePath,
  detachedMentionedFiles,
  hasVisibleContext,
  hasWorkspaceSelection,
  selectionShortcutLabel,
  submitStatus,
  submitDisabled,
  canSteer,
  heldMessage,
  heldSteerAvailable,
  heldDisabled,
  onHeldSubmit,
  onHeldEdit,
  onHeldDiscard,
  onSubmit,
  onStop,
  onUpload,
  onDraftChange,
  onDraftSelectionChange,
  onDeleteInlineMention,
  onMentionQueryChange,
  onSkillQueryChange,
  onActiveMentionIndexChange,
  onAddMention,
  onAddSkillMention,
  onOpenMention,
  onRemoveMention,
  onRemoveSkill,
  onRemoveSelection,
  onAddWorkspaceSelection,
}: {
  readonly draft: string;
  readonly draftInputRef: RefObject<HTMLTextAreaElement | null>;
  readonly uploadInputRef: RefObject<HTMLInputElement | null>;
  readonly mentionedFiles: ChatFileContext[];
  readonly mentionedSkills: string[];
  readonly attachedSelections: ChatSelectionContext[];
  readonly mentionQuery?: string;
  readonly mentionResults: FileEntry[];
  readonly skillQuery?: string;
  readonly groupedSkillResults: {
    custom: SkillSummary[];
    system: Array<{ slug: string; name: string }>;
  };
  readonly activeMentionIndex: number;
  readonly isUploading: boolean;
  readonly showViewingContext: boolean;
  readonly activeFilePath?: string;
  readonly detachedMentionedFiles: ChatFileContext[];
  readonly hasVisibleContext: boolean;
  readonly hasWorkspaceSelection: boolean;
  readonly selectionShortcutLabel: string;
  readonly submitStatus: ComposerStatus;
  readonly submitDisabled: boolean;
  readonly canSteer: boolean;
  readonly heldMessage: { text: string; fileCount: number; skillCount: number; selectionCount: number } | null;
  readonly heldSteerAvailable: boolean;
  readonly heldDisabled: boolean;
  readonly onHeldSubmit: () => void;
  readonly onHeldEdit: () => void;
  readonly onHeldDiscard: () => void;
  readonly onSubmit: (message: PromptInputMessage) => void;
  readonly onStop: () => void;
  readonly onUpload: (files: FileList | File[] | null) => void | Promise<void>;
  readonly onDraftChange: (value: string, cursor: number | null) => void;
  readonly onDraftSelectionChange: (cursor: number | null) => void;
  readonly onDeleteInlineMention: (
    direction: "backward" | "forward",
    selectionStart: number,
    selectionEnd: number,
  ) => boolean;
  readonly onMentionQueryChange: (query?: string) => void;
  readonly onSkillQueryChange: (query?: string) => void;
  readonly onActiveMentionIndexChange: (
    next: number | ((current: number) => number),
  ) => void;
  readonly onAddMention: (file: FileEntry) => void;
  readonly onAddSkillMention: (
    skill: Pick<SkillSummary, "slug" | "name">,
  ) => void;
  /** Opens a mentioned file as a tab, or reveals a mentioned folder in the
   *  File Explorer, when its chip is clicked. */
  readonly onOpenMention: (file: ChatFileContext) => void;
  readonly onRemoveMention: (path: string) => void;
  readonly onRemoveSkill: (slug: string) => void;
  readonly onRemoveSelection: (index: number) => void;
  readonly onAddWorkspaceSelection: () => void;
}) {
  const skillResults = [
    ...groupedSkillResults.custom,
    ...groupedSkillResults.system,
  ];

  return (
    <div className="relative">
      {mentionQuery !== undefined ? (
        <div
          id="workspace-mention-list"
          role="listbox"
          aria-label="Workspace files and folders"
          className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-lg border bg-popover p-1 shadow-lg"
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Files &amp; folders
          </div>
          {mentionResults.length ? (
            mentionResults.map((file, index) => (
              <button
                id={`workspace-mention-${index}`}
                role="option"
                aria-selected={index === activeMentionIndex}
                key={file.path}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent",
                  index === activeMentionIndex && "bg-accent text-accent-foreground",
                )}
                onMouseEnter={() => onActiveMentionIndexChange(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onAddMention(file)}
              >
                {file.isDir ? (
                  <Folder className="size-3.5 shrink-0 text-blue-500" />
                ) : (
                  <FileIcon className="size-3.5 shrink-0 text-primary" />
                )}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{file.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {file.isDir ? `${file.path}/` : file.path}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No matching files or folders
            </p>
          )}
        </div>
      ) : null}

      {skillQuery !== undefined ? (
        <div
          id="skill-mention-list"
          role="listbox"
          aria-label="Available skills"
          className="absolute bottom-full left-0 z-50 mb-2 max-h-80 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
        >
          {groupedSkillResults.custom.length ? (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Custom Skills
              </div>
              {groupedSkillResults.custom.map((skill, index) => (
                <SkillOption
                  active={index === activeMentionIndex}
                  index={index}
                  key={skill.slug}
                  skill={skill}
                  onActivate={onActiveMentionIndexChange}
                  onSelect={onAddSkillMention}
                />
              ))}
            </>
          ) : null}
          {groupedSkillResults.system.length ? (
            <>
              <div
                className={cn(
                  "px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
                  groupedSkillResults.custom.length && "mt-1 border-t pt-2",
                )}
              >
                System Skills
              </div>
              {groupedSkillResults.system.map((skill, systemIndex) => {
                const index = groupedSkillResults.custom.length + systemIndex;
                return (
                  <SkillOption
                    active={index === activeMentionIndex}
                    index={index}
                    key={skill.slug}
                    skill={skill}
                    onActivate={onActiveMentionIndexChange}
                    onSelect={onAddSkillMention}
                  />
                );
              })}
            </>
          ) : null}
          {!skillResults.length ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No matching skills
            </p>
          ) : null}
          <p className="border-t px-2 pb-1 pt-2 text-[10px] text-muted-foreground">
            Create agent skills in the Skills panel
          </p>
        </div>
      ) : null}

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void onUpload(event.currentTarget.files)}
      />
      {heldMessage ? (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-words text-xs">{heldMessage.text || "Follow-up with attached context"}</p>
            {heldMessage.fileCount + heldMessage.skillCount + heldMessage.selectionCount > 0 ? (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {heldMessage.fileCount} files · {heldMessage.skillCount} skills · {heldMessage.selectionCount} selections
              </p>
            ) : null}
          </div>
          <button type="button" aria-label="Edit held message" title="Edit" onClick={onHeldEdit} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"><Pencil className="size-3.5" /></button>
          <button type="button" aria-label="Discard held message" title="Discard" onClick={onHeldDiscard} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"><X className="size-3.5" /></button>
          <button type="button" disabled={heldDisabled} onClick={onHeldSubmit} className="inline-flex items-center gap-1 self-start rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"><ArrowUp className="size-3" />{heldSteerAvailable ? "Steer" : "Send"}</button>
        </div>
      ) : null}
      <PromptInput
        data-tour="composer"
        accept="application/x-beeblio-workspace-upload"
        className="rounded-xl border-border bg-card shadow-sm"
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void onUpload(event.dataTransfer.files);
        }}
        onSubmit={onSubmit}
      >
        {hasVisibleContext ? (
          <PromptInputHeader className="border-b px-2.5 py-2">
            {showViewingContext && activeFilePath ? (
              <ContextChip label={activeFilePath} prefix="Viewing" />
            ) : null}
            {detachedMentionedFiles.map((file) => (
              <ContextChip
                key={file.path}
                label={file.path}
                isDir={file.isDir}
                prefix={file.kind === "upload" ? "Uploaded" : undefined}
                onOpen={() => onOpenMention(file)}
                onRemove={() => onRemoveMention(file.path)}
              />
            ))}
            {mentionedSkills.map((slug) => (
              <ContextChip
                key={slug}
                label={`/${slug}`}
                prefix="Skill"
                onRemove={() => onRemoveSkill(slug)}
              />
            ))}
            {attachedSelections.map((selection, index) => (
              <ContextChip
                key={selectionIdentity(selection)}
                label={
                  selection.kind === "insertion"
                    ? selection.filePath
                    : `${selection.filePath} · ${(selection.text ?? "").length} characters`
                }
                prefix={selection.kind === "insertion" ? "Insert at" : "Selection"}
                onRemove={() => onRemoveSelection(index)}
              />
            ))}
          </PromptInputHeader>
        ) : null}
        <InlineMentionTextarea
          inputRef={draftInputRef}
          mentions={mentionedFiles}
          skillMentions={mentionedSkills}
          className="min-h-20 text-sm md:text-sm"
          placeholder="Use @file to attach context or /skill to run a skill"
          aria-activedescendant={
            mentionQuery !== undefined && mentionResults.length
              ? `workspace-mention-${activeMentionIndex}`
              : skillQuery !== undefined && skillResults.length
                ? `skill-mention-${activeMentionIndex}`
                : undefined
          }
          aria-controls={
            mentionQuery !== undefined
              ? "workspace-mention-list"
              : skillQuery !== undefined
                ? "skill-mention-list"
                : undefined
          }
          aria-expanded={mentionQuery !== undefined || skillQuery !== undefined}
          aria-haspopup="listbox"
          value={draft}
          onChange={(event) =>
            onDraftChange(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            )
          }
          onSelect={(event) =>
            onDraftSelectionChange(event.currentTarget.selectionStart)
          }
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            event.preventDefault();
            void onUpload(files);
          }}
          onKeyDown={(event) => {
            if (
              (event.key === "Backspace" || event.key === "Delete") &&
              onDeleteInlineMention(
                event.key === "Backspace" ? "backward" : "forward",
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              )
            ) {
              event.preventDefault();
              return;
            }
            if (mentionQuery === undefined && skillQuery === undefined) return;
            const results =
              skillQuery !== undefined ? skillResults : mentionResults;
            if (event.key === "Escape") {
              event.preventDefault();
              onMentionQueryChange(undefined);
              onSkillQueryChange(undefined);
            } else if (event.key === "ArrowDown" && results.length) {
              event.preventDefault();
              onActiveMentionIndexChange(
                (current) => (current + 1) % results.length,
              );
            } else if (event.key === "ArrowUp" && results.length) {
              event.preventDefault();
              onActiveMentionIndexChange(
                (current) => (current - 1 + results.length) % results.length,
              );
            } else if (
              (event.key === "Enter" || event.key === "Tab") &&
              results[activeMentionIndex]
            ) {
              event.preventDefault();
              if (skillQuery !== undefined) {
                onAddSkillMention(
                  results[activeMentionIndex] as Pick<
                    SkillSummary,
                    "slug" | "name"
                  >,
                );
              } else {
                onAddMention(results[activeMentionIndex] as FileEntry);
              }
            }
          }}
        />
        <PromptInputFooter>
          <PromptInputTools>
            <Tooltip>
              <TooltipTrigger asChild>
                <PromptInputButton
                  type="button"
                  disabled={isUploading}
                  onClick={() => uploadInputRef.current?.click()}
                >
                  {isUploading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Paperclip />
                  )}
                </PromptInputButton>
              </TooltipTrigger>
              <TooltipContent>Upload &amp; mention</TooltipContent>
            </Tooltip>
            <ScreenshotButton disabled={isUploading} onCapture={onUpload} />
            {hasWorkspaceSelection ? (
              <button
                type="button"
                aria-keyshortcuts="Control+L Meta+L"
                onClick={onAddWorkspaceSelection}
                className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/15"
                title={`Add selection to context (${selectionShortcutLabel})`}
              >
                <Quote className="size-3" />
                Add Selection
                <kbd
                  aria-hidden="true"
                  className="ml-1 flex items-center gap-0.5 text-[11px] font-medium leading-none opacity-70"
                >
                  {selectionShortcutLabel === "⌘ L" ? (
                    <>
                      <Command className="size-3 stroke-[2.25]" />
                      <span>L</span>
                    </>
                  ) : (
                    selectionShortcutLabel
                  )}
                </kbd>
              </button>
            ) : null}
          </PromptInputTools>
          {canSteer && (draft.trim().length > 0 || mentionedFiles.length > 0 || attachedSelections.length > 0) ? (
            <>
              <PromptInputButton aria-label="Stop response" className="absolute right-12 bottom-2.5" onClick={onStop} type="button" variant="outline"><Square className="size-3 fill-current" /></PromptInputButton>
              <PromptInputSubmit aria-label="Hold follow-up" disabled={submitDisabled} status="ready" />
            </>
          ) : (
            <PromptInputSubmit disabled={submitDisabled} onStop={onStop} status={submitStatus} />
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function SkillOption({
  active,
  index,
  skill,
  onActivate,
  onSelect,
}: {
  active: boolean;
  index: number;
  skill: Pick<SkillSummary, "slug" | "name">;
  onActivate: (index: number) => void;
  onSelect: (skill: Pick<SkillSummary, "slug" | "name">) => void;
}) {
  return (
    <button
      id={`skill-mention-${index}`}
      role="option"
      aria-selected={active}
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent",
        active && "bg-accent text-accent-foreground",
      )}
      onMouseEnter={() => onActivate(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(skill)}
    >
      <Wrench className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 truncate font-medium">
        {skill.name || skill.slug}
      </span>
    </button>
  );
}

function ContextChip({
  label,
  prefix,
  isDir,
  onOpen,
  onRemove,
}: {
  label: string;
  prefix?: string;
  isDir?: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  return (
    <span
      className={cn(
        "flex max-w-full items-center gap-1 rounded-md border bg-muted/60 px-1.5 py-1 text-[10px] text-muted-foreground",
        onOpen && "cursor-pointer transition-colors hover:border-primary/35 hover:bg-muted",
      )}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      {prefix ? (
        <span className="font-medium text-foreground">{prefix}</span>
      ) : isDir ? (
        <Folder className="size-3 shrink-0 text-blue-500" />
      ) : (
        <FileIcon className="size-3 shrink-0" />
      )}
      <span className="max-w-52 truncate font-mono">{label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="rounded p-0.5 hover:bg-muted"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X className="size-2.5" />
        </button>
      ) : null}
    </span>
  );
}

function InlineMentionTextarea({
  inputRef,
  mentions,
  skillMentions,
  className,
  onChange,
  onKeyDown,
  placeholder,
  ...props
}: Parameters<typeof PromptInputTextarea>[0] & {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  mentions: ChatFileContext[];
  skillMentions?: string[];
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const value = typeof props.value === "string" ? props.value : "";

  return (
    <div className="relative w-full min-w-0">
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-3 text-foreground",
          className,
        )}
      >
        <div style={{ transform: `translateY(-${scrollTop}px)` }}>
          {!value && placeholder ? (
            <span className="text-muted-foreground">
              {placeholder.split(/(@file|\/skill)/).map((part, index) =>
                part === "@file" || part === "/skill" ? (
                  <span key={index} className="text-primary/70">
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
            </span>
          ) : (
            <HighlightedMentions
              text={value}
              mentions={mentions}
              skillMentions={skillMentions}
            />
          )}
          {value.endsWith("\n") ? "\u00a0" : null}
        </div>
      </div>
      <PromptInputTextarea
        {...props}
        placeholder={placeholder}
        ref={inputRef}
        className={cn(
          "relative w-full caret-foreground text-transparent selection:bg-primary/25 selection:text-transparent placeholder:text-transparent",
          className,
        )}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange?.(event)}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) =>
          onKeyDown?.(event)
        }
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      />
    </div>
  );
}

function HighlightedMentions({
  text,
  mentions,
  skillMentions,
}: {
  text: string;
  mentions: ChatFileContext[];
  skillMentions?: string[];
}) {
  const fileMentionsByToken = new Map(
    mentions.map((mention) => [fileMentionToken(mention.path), mention]),
  );
  const skillTokens = (skillMentions ?? []).map((slug) =>
    skillMentionToken(slug),
  );
  const tokens = [...fileMentionsByToken.keys(), ...skillTokens].sort(
    (a, b) => b.length - a.length,
  );
  if (!tokens.length) return text;

  const pattern = new RegExp(
    `(${tokens.map(escapeRegExp).join("|")})(?=\\s|$)`,
    "g",
  );
  return text.split(pattern).map((part, index) => {
    const file = fileMentionsByToken.get(part);
    return file || skillTokens.includes(part) ? (
      <mark
        className="rounded-[2px] bg-primary/15 text-primary"
        key={`${index}:${part}`}
        title={file?.path}
      >
        {file ? (
          <>
            <span className="relative inline-block text-transparent">
              {"\u2003"}
              {file.isDir ? (
                <Folder className="absolute left-[0.5em] top-1/2 size-[0.72em] -translate-x-1/2 -translate-y-1/2 text-primary" />
              ) : (
                <FileIcon className="absolute left-[0.5em] top-1/2 size-[0.72em] -translate-x-1/2 -translate-y-1/2 text-primary" />
              )}
            </span>
            {part.slice(1)}
          </>
        ) : (
          <>
            <span className="relative inline-block text-transparent">
              {"\u2003/"}
              <Wrench className="absolute left-[0.5em] top-1/2 size-[0.72em] -translate-x-1/2 -translate-y-1/2 text-primary" />
            </span>
            {part.slice(2)}
          </>
        )}
      </mark>
    ) : (
      part
    );
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function selectionIdentity(selection: ChatSelectionContext) {
  return `${selection.filePath}:${selection.kind ?? "passage"}:${selection.text ?? selection.before ?? ""}`;
}

export function containsMention(text: string, path: string) {
  return text.includes(fileMentionToken(path));
}

function fileName(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

export function fileMentionToken(path: string) {
  return `\u2003${fileName(path)}`;
}

export function skillMentionToken(slug: string) {
  return `\u2003/${slug}`;
}

export function normalizeInlineFileMentions(
  text: string,
  mentions: ChatFileContext[],
) {
  return mentions.reduce(
    (current, mention) =>
      current.replaceAll(fileMentionToken(mention.path), fileName(mention.path)),
    text,
  );
}

export function normalizeInlineSkillMentions(text: string, slugs: string[]) {
  return slugs.reduce(
    (current, slug) => current.replaceAll(skillMentionToken(slug), `/${slug}`),
    text,
  );
}

export function containsSkillMention(text: string, slug: string) {
  return new RegExp(`/${escapeRegExp(slug)}(?=\\s|$)`).test(text);
}

/**
 * Attaches a screenshot the same way as "Upload & mention". Shown only in the
 * desktop app, which has its own screen picker (desktop/src/screen-capture.ts);
 * in a browser, people can paste or drop a screenshot instead.
 */
function ScreenshotButton({ disabled, onCapture }: { disabled: boolean; onCapture: (files: File[]) => void | Promise<void> }) {
  const [available, setAvailable] = useState(false);
  const [capturing, setCapturing] = useState(false);
  // Checked after mount: the server render cannot know whether this is the desktop app.
  useEffect(() => setAvailable(Boolean(window.beeblioDesktop && navigator.mediaDevices?.getDisplayMedia)), []);
  if (!available) return null;

  const capture = async () => {
    setCapturing(true);
    try {
      const file = await captureScreenshot();
      if (file) await onCapture([file]);
    } catch (error) {
      // A cancelled picker: browsers report NotAllowedError, Electron AbortError.
      const cancelled = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
      if (!cancelled) toast.error("The screenshot could not be taken. Try again.");
    } finally {
      setCapturing(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PromptInputButton type="button" aria-label="Take screenshot" disabled={disabled || capturing} onClick={() => void capture()}>
          {capturing ? <Loader2 className="animate-spin" /> : <ScreenShare />}
        </PromptInputButton>
      </TooltipTrigger>
      <TooltipContent>Take screenshot</TooltipContent>
    </Tooltip>
  );
}
