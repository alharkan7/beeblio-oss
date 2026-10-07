"use client";

import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessagePart,
} from "eve/react";
import {
  BookOpen,
  CheckCircleIcon,
  ChevronDown,
  CircleIcon,
  FileIcon,
  Folder,
  ImageIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  ScrollText,
  Wrench,
  XCircleIcon,
  SquareArrowOutUpRight
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ComponentProps, type ReactNode, useState } from "react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolActivity,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolStatus,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  getChatSelections,
  openWorkspaceEntry,
  parseChatMessage,
  type ChatContext,
} from "@/lib/chat-context";
import { describeToolCall } from "@/lib/tool-labels";
import { rewriteWorkspaceSchemeLinks } from "@/lib/markdown-workspace-links";
import { workspaceFilePath, blockedUrlWorkspacePath } from "@/lib/workspace-file-path";
import { isWorkspaceDirectory } from "@/lib/workspace-entry-index";
import { errorDetail } from "@/lib/error-detail";

export type AgentInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

export type Verbosity = "compact" | "full";
export type ToolCallVerbosity = Verbosity;
export type ReasoningVerbosity = Verbosity;

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

const agentMessageComponents = {
  inlineCode: WorkspaceFileMention,
  span: BlockedWorkspaceLink,
};

export function AgentMessage({
  canRespond,
  isLive,
  isStreaming,
  message,
  turnDuration,
  onInputResponses,
  reasoningVerbosity,
  toolCallVerbosity,
}: {
  readonly canRespond: boolean;
  /** False once the turn that owns this message can no longer deliver events
   *  (turn cancelled or failed, stream lost, agent idle). Transient part
   *  states are then presented as settled instead of animating forever. */
  readonly isLive: boolean;
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  readonly turnDuration?: number;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly reasoningVerbosity: ReasoningVerbosity;
  readonly toolCallVerbosity: ToolCallVerbosity;
}) {
  const activeTextIndex = message.parts.at(-1)?.type === "text"
    ? message.parts.length - 1
    : -1;
  const knowledgeCitations = knowledgeCitationsFromParts(message.parts);
  const activityIsSettled = !isLive && message.role === "assistant";
  const renderedParts: ReactNode[] = [];
  let activityParts: { part: EveMessagePart; index: number }[] = [];
  const flushActivity = () => {
    if (activityParts.length === 0) return;
    const parts = activityParts;
    activityParts = [];
    const content = parts.map(({ part, index }) => (
      <AgentMessagePart
        canRespond={canRespond}
        isLive={isLive}
        key={partKey(part, index)}
        onInputResponses={onInputResponses}
        part={part}
        reasoningVerbosity={reasoningVerbosity}
        showCaret={false}
        toolCallVerbosity={toolCallVerbosity}
      />
    ));
    renderedParts.push(activityIsSettled ? (
      <Collapsible className="not-prose group/activity mb-3" key={`activity:${parts[0].index}`}>
        <CollapsibleTrigger className="flex min-h-7 items-center gap-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ChevronDown aria-hidden="true" className="size-3.5 -rotate-90 transition-transform group-data-[state=open]/activity:rotate-0" />
          <span>{turnDuration
            ? `${parts.some(({ part }) => part.type === "dynamic-tool") ? "Worked" : "Thought"} for ${formatActivityDuration(turnDuration)}`
            : parts.some(({ part }) => part.type === "dynamic-tool") ? "Work details" : "Thought details"}</span>
          <span className="text-muted-foreground/70">· {parts.length} {parts.length === 1 ? "step" : "steps"}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="ml-1 border-l border-border/70 pl-4 pt-2">
          {content}
        </CollapsibleContent>
      </Collapsible>
    ) : (
      <div key={`activity:${parts[0].index}`}>{content}</div>
    ));
  };
  message.parts.forEach((part, index) => {
    if (isActivityPart(part)) {
      activityParts.push({ part, index });
      return;
    }
    if (part.type === "step-start") return;
    flushActivity();
    renderedParts.push(
      <AgentMessagePart
        canRespond={canRespond}
        isLive={isLive}
        key={partKey(part, index)}
        onInputResponses={onInputResponses}
        part={part}
        reasoningVerbosity={reasoningVerbosity}
        showCaret={isStreaming && message.role === "assistant" && index === activeTextIndex}
        toolCallVerbosity={toolCallVerbosity}
      />,
    );
  });
  flushActivity();

  if (isCompactionCheckpointMessage(message)) {
    return <CompactionCheckpointDivider />;
  }

  return (
    <Message
      data-message-failed={message.metadata?.status === "failed" ? "true" : undefined}
      from={message.role}
    >
      <MessageContent>
        {renderedParts}
        {message.role === "assistant" && knowledgeCitations.length > 0 ? (
          <KnowledgeCitations citations={knowledgeCitations} />
        ) : null}
      </MessageContent>
    </Message>
  );
}

function isActivityPart(part: EveMessagePart): boolean {
  if (part.type === "reasoning") return true;
  if (part.type !== "dynamic-tool") return false;
  // Requests that need a person must remain visible outside the disclosure.
  return !part.toolMetadata?.eve?.inputRequest;
}

function formatActivityDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

type KnowledgeCitation = {
  readonly citationKey?: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly pageNumber?: number;
};

function knowledgeCitationsFromParts(parts: readonly EveMessagePart[]): KnowledgeCitation[] {
  const citations = new Map<string, KnowledgeCitation>();
  for (const part of parts) {
    if (part.type !== "dynamic-tool" || part.toolName !== "search_knowledge" || part.state !== "output-available") continue;
    const output = knowledgeToolOutput(part.output);
    if (!output) continue;
    for (const citation of output.citations) {
      if (!citation || typeof citation !== "object") continue;
      const candidate = citation as Record<string, unknown>;
      if (typeof candidate.filePath !== "string" || !candidate.filePath.trim()) continue;
      const filePath = candidate.filePath.replace(/^\/workspace\//, "");
      const fileName = typeof candidate.fileName === "string" && candidate.fileName.trim()
        ? candidate.fileName
        : filePath.slice(filePath.lastIndexOf("/") + 1);
      const pageNumber = typeof candidate.pageNumber === "number" ? candidate.pageNumber : undefined;
      const citationKey = typeof candidate.citationKey === "string" && candidate.citationKey.trim()
        ? candidate.citationKey
        : undefined;
      const current = citations.get(filePath);
      if (!current || (current.pageNumber === undefined && pageNumber !== undefined)) {
        citations.set(filePath, { fileName, filePath, ...(pageNumber !== undefined ? { pageNumber } : {}), ...(citationKey ? { citationKey } : {}) });
      }
    }
  }
  return [...citations.values()];
}

function knowledgeToolOutput(output: unknown): { citations: unknown[] } | null {
  let value = output;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const citations = (value as Record<string, unknown>).citations;
  return Array.isArray(citations) ? { citations } : null;
}

function KnowledgeCitations({ citations }: { readonly citations: readonly KnowledgeCitation[] }) {
  return (
    <Collapsible className="mt-2 rounded-md border border-border/70 bg-muted/25">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <BookOpen aria-hidden="true" className="size-3.5" />
        <span>{citations.length} Knowledge {citations.length === 1 ? "Source" : "Sources"}</span>
        <ChevronDown aria-hidden="true" className="ml-auto size-3.5 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 border-t px-2 py-2">
          {citations.map((citation) => (
            <WorkspaceMentionChip
              className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              filePath={citation.filePath}
              key={citation.filePath}
            >
              <FileIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{citation.fileName}</span>
              {citation.citationKey ? <span className="shrink-0 font-mono text-muted-foreground">[@{citation.citationKey}]</span> : null}
              {citation.pageNumber !== undefined ? <span className="shrink-0 text-muted-foreground">p. {citation.pageNumber}</span> : null}
            </WorkspaceMentionChip>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// eve writes this user message into durable history at every compaction
// checkpoint; render it as a divider instead of a mystery user bubble on
// reload. The assistant summary that follows it renders as a normal message.
const COMPACTION_CHECKPOINT_MARKER = "Summary of our conversation so far:";

function isCompactionCheckpointMessage(message: EveMessage): boolean {
  return (
    message.role === "user" &&
    message.parts.some(
      (part) => part.type === "text" && part.text.trim() === COMPACTION_CHECKPOINT_MARKER,
    )
  );
}

function CompactionCheckpointDivider() {
  return (
    <div
      className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground"
      role="separator"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5">
        <ScrollText aria-hidden="true" className="size-3 shrink-0" />
        Earlier conversation summarized
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

function AgentMessagePart({
  canRespond,
  isLive,
  onInputResponses,
  part,
  showCaret,
  reasoningVerbosity,
  toolCallVerbosity,
}: {
  readonly canRespond: boolean;
  readonly isLive: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveMessagePart;
  readonly showCaret: boolean;
  readonly reasoningVerbosity: ReasoningVerbosity;
  readonly toolCallVerbosity: ToolCallVerbosity;
}) {
  switch (part.type) {
    case "step-start":
      return null;
    case "text":
      if (part.text.startsWith("<workspace_context>")) {
        const parsed = parseChatMessage(part.text);
        return (
          <>
            {parsed.context ? <MessageContext context={parsed.context} text={parsed.text} /> : null}
            {parsed.text ? (
              parsed.context ? (
                <InlineMentionMessage context={parsed.context} text={parsed.text} />
              ) : (
                <AgentMessageResponse>{parsed.text}</AgentMessageResponse>
              )
            ) : null}
          </>
        );
      }
      return (
        <AgentMessageResponse
          caret="block"
          className="agent-chat-markdown"
          isAnimating={showCaret}
          mode={showCaret ? "streaming" : "static"}
        >
          {part.text}
        </AgentMessageResponse>
      );
    case "reasoning":
      return (
        <Reasoning
          compact={reasoningVerbosity === "compact"}
          defaultOpen={false}
          isStreaming={part.state === "streaming" && isLive}
        >
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "file":
      return <AttachmentPart part={part} />;
    case "authorization":
      return <AuthorizationPrompt part={part} />;
    case "dynamic-tool": {
      return (
        <DynamicToolPart
          canRespond={canRespond}
          isLive={isLive}
          part={part}
          toolCallVerbosity={toolCallVerbosity}
          onInputResponses={onInputResponses}
        />
      );
    }
  }
}

function DynamicToolPart({
  canRespond,
  isLive,
  onInputResponses,
  part,
  toolCallVerbosity,
}: {
  readonly canRespond: boolean;
  readonly isLive: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveDynamicToolPart;
  readonly toolCallVerbosity: ToolCallVerbosity;
}) {
  const { label, detail, icon } = describeToolCall(part);
  const writingPreview = part.toolName === "write_file" && isLive &&
    (part.state === "input-streaming" || part.state === "input-available")
    ? writeFilePreview(part)
    : undefined;
  const writingDetail = writingPreview?.fileName ?? detail;
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  const isPartial = part.state === "output-available" && part.partial === true;
  const toolState = isLive
    ? isPartial ? "input-available" : part.state
    : isPartial ? "stopped" : settledToolState(part.state);
  const statusLabel = undefined;
  const lifecycleLabel = label;

  if (toolCallVerbosity === "compact" && inputRequest && part.toolName === "ask_question") {
    return (
      <div className="mb-2 space-y-2">
        <ToolActivity
          detail={detail}
          icon={icon}
          state={toolState}
          statusLabel={part.toolMetadata?.eve?.inputResponse ? "Answered" : "Awaiting response"}
          title="Question"
          toolName={part.toolName}
        />
        <InputRequestActions
          canRespond={canRespond}
          part={part}
          onInputResponses={onInputResponses}
        />
      </div>
    );
  }
  if (toolCallVerbosity === "compact" && part.toolName === "todo") {
    const todos = todoItemsFromPart(part);
    if (todos) {
      return (
        <CompactTodoTool
          icon={icon}
          state={toolState}
          todos={todos}
        />
      );
    }
  }
  if (toolCallVerbosity === "compact" && !inputRequest) {
    return (
      <div className="mb-2">
        <ToolActivity
          detail={writingDetail}
          icon={icon}
          state={toolState}
          statusLabel={statusLabel}
          title={lifecycleLabel}
          toolName={part.toolName}
        />
        {writingPreview?.content ? <WritingPreview content={writingPreview.content} /> : null}
      </div>
    );
  }
  return (
    <Tool
      defaultOpen={
        part.state === "approval-requested" ||
        part.state === "approval-responded" ||
        part.state === "output-error"
      }
    >
      <ToolHeader
        detail={writingDetail}
        icon={icon}
        state={toolState}
        statusLabel={statusLabel}
        title={lifecycleLabel}
        toolName={part.toolName}
        type="dynamic-tool"
      />
      {writingPreview?.content ? <WritingPreview content={writingPreview.content} /> : null}
      <ToolContent>
        <ToolInput input={part.input} />
        <InputRequestActions
          canRespond={canRespond}
          part={part}
          onInputResponses={onInputResponses}
        />
        <ToolOutput
          errorText={part.errorText}
          label={isPartial ? "Progress" : undefined}
          output={part.output}
        />
      </ToolContent>
    </Tool>
  );
}

type TodoStatus = "cancelled" | "completed" | "in_progress" | "pending";

type TodoItem = {
  readonly content: string;
  readonly status: TodoStatus;
};

const TODO_STATUSES = new Set<TodoStatus>([
  "cancelled",
  "completed",
  "in_progress",
  "pending",
]);

function todoItemsFromPart(part: EveDynamicToolPart): readonly TodoItem[] | undefined {
  for (const candidate of [part.input, parseJsonObject(part.output)]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const todos = (candidate as Record<string, unknown>).todos;
    if (!Array.isArray(todos)) continue;

    const parsed: TodoItem[] = [];
    for (const todo of todos) {
      if (!todo || typeof todo !== "object" || Array.isArray(todo)) return undefined;
      const { content, status } = todo as Record<string, unknown>;
      if (
        typeof content !== "string" ||
        typeof status !== "string" ||
        !TODO_STATUSES.has(status as TodoStatus)
      ) {
        return undefined;
      }
      parsed.push({ content, status: status as TodoStatus });
    }
    return parsed;
  }
  return undefined;
}

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function writeFilePreview(part: EveDynamicToolPart): { fileName?: string; content?: string } {
  if (part.state === "input-available") {
    const input = part.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const fields = input as Record<string, unknown>;
    return {
      fileName: typeof fields.filePath === "string" ? fields.filePath.split("/").pop() : undefined,
      content: typeof fields.content === "string" ? fields.content : undefined,
    };
  }
  if (part.state !== "input-streaming") return {};
  const filePath = streamedJsonString(part.inputText, "filePath");
  return {
    fileName: filePath?.split("/").pop(),
    content: streamedJsonString(part.inputText, "content"),
  };
}

function streamedJsonString(inputText: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(inputText);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let end = start;
  let escaped = false;
  for (; end < inputText.length; end += 1) {
    const char = inputText[end];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      break;
    }
  }
  let raw = inputText.slice(start, end);
  // A stream can end inside an escape sequence or a Unicode code point.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      raw = raw.slice(0, -1);
    }
  }
  return undefined;
}

function WritingPreview({ content }: { readonly content: string }) {
  const excerpt = content.length > 1200 ? `…${content.slice(-1200)}` : content;
  return (
    <div className="ml-6 max-w-full rounded-md border border-border/70 bg-muted/30 px-3 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Live draft · {content.length.toLocaleString()} characters
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-foreground/80">
        {excerpt}
      </pre>
    </div>
  );
}

function CompactTodoTool({
  icon,
  state,
  todos,
}: {
  readonly icon?: typeof CheckCircleIcon;
  readonly state: ToolStatus;
  readonly todos: readonly TodoItem[];
}) {
  const completed = todos.filter(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  ).length;
  const detail = `${completed}/${todos.length}`;

  return (
    <Tool>
      <ToolHeader
        compact
        detail={detail}
        icon={icon}
        state={state}
        title="Update Tasks"
        toolName="todo"
        type="dynamic-tool"
      />
      <ToolContent className="space-y-0">
        <ul aria-label="Agent tasks" className="space-y-2" role="list">
          {todos.map((todo, index) => (
            <li
              className="flex items-start gap-2 text-xs leading-5 text-foreground/85"
              key={`${index}:${todo.content}`}
            >
              <TodoStatusIcon status={todo.status} />
              <span
                className={cn(
                  "min-w-0",
                  todo.status === "completed" && "text-muted-foreground line-through",
                  todo.status === "cancelled" && "text-muted-foreground line-through",
                )}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      </ToolContent>
    </Tool>
  );
}

function TodoStatusIcon({ status }: { readonly status: TodoStatus }) {
  if (status === "completed") {
    return <CheckCircleIcon aria-label="Completed" className="mt-0.5 size-4 shrink-0 text-primary" />;
  }
  if (status === "cancelled") {
    return <XCircleIcon aria-label="Cancelled" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
  }
  if (status === "in_progress") {
    return <LoaderCircleIcon aria-label="In progress" className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />;
  }
  return <CircleIcon aria-label="Pending" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

// eve's client reducer only settles in-flight part states when the terminal
// event actually arrives, and even then incompletely: turn.cancelled leaves
// tools that already started (input-available) untouched and turn.failed
// settles nothing at all. Once the owning turn is no longer live, present the
// interrupted tool as stopped instead of an endlessly spinning "Running" row.
function settledToolState(state: EveDynamicToolPart["state"]): ToolStatus {
  return state === "input-streaming" || state === "input-available"
    ? "stopped"
    : state;
}

function MessageContext({ context, text }: { context: ChatContext; text: string }) {
  const selections = getChatSelections(context);
  const detachedFiles = context.files.filter(
    (file) => file.kind === "active" || !containsFileMention(text, file.path),
  );
  const detachedSkills = (context.skills ?? []).filter(
    (skill) => !containsSkillMention(text, skill),
  );

  if (detachedSkills.length === 0 && detachedFiles.length === 0 && selections.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex max-w-full flex-wrap gap-1.5">
      {detachedSkills.map((skill) => (
        <span key={skill} title={skill} className="flex max-w-full items-center gap-1 rounded-md border bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
          <Wrench className="size-3 shrink-0 text-primary" />
          <span className="font-medium text-foreground">Skill</span>
          <span className="max-w-52 truncate font-mono">/{skill}</span>
        </span>
      ))}
      {detachedFiles.map((file) => (
        <WorkspaceMentionChip
          key={`${file.kind}:${file.path}`}
          className="flex max-w-full items-center gap-1 rounded-md border bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/35 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          filePath={file.path}
          isDir={file.isDir}
        >
          {file.isDir ? <Folder className="size-3 shrink-0 text-blue-500" /> : <FileIcon className="size-3 shrink-0" />}
          <span className="font-medium text-foreground">
            {file.kind === "active" ? "Viewing" : file.kind === "upload" ? "Uploaded" : "Mentioned"}
          </span>
          <span className="max-w-52 truncate font-mono">{file.isDir ? `${file.path}/` : file.path}</span>
        </WorkspaceMentionChip>
      ))}
      {selections.map((selection, index) => (
        <span
          key={`${selection.filePath}:${selection.kind ?? "passage"}:${selection.text ?? selection.before ?? ""}:${index}`}
          title={selection.kind === "insertion"
            ? [selection.before, selection.after].filter(Boolean).join(" … ")
            : selection.text}
          className="flex max-w-full items-center gap-1 rounded-md border bg-background/70 px-2 py-1 text-[10px] text-muted-foreground"
        >
          <span className="font-medium text-foreground">{selection.kind === "insertion" ? "Insert at" : "Selection"}</span>
          <span className="max-w-48 truncate font-mono">{selection.filePath}</span>
          {/* {selection.kind === "insertion" ? null : <span>· {(selection.text ?? "").length} chars</span>} */}
        </span>
      ))}
    </div>
  );
}

function InlineMentionMessage({ context, text }: { context: ChatContext; text: string }) {
  const inlineFiles = context.files
    .filter((file) => file.kind !== "active" && containsFileMention(text, file.path))
    .sort((a, b) => b.path.length - a.path.length);
  const inlineSkills = (context.skills ?? []).filter((skill) =>
    containsSkillMention(text, skill),
  );

  if (inlineFiles.length === 0 && inlineSkills.length === 0) {
    return <AgentMessageResponse>{text}</AgentMessageResponse>;
  }

  const filesByToken = new Map(
    inlineFiles.flatMap((file) => [
      [`@${file.path}`, file] as const,
      [fileName(file.path), file] as const,
    ]),
  );
  const skillsByToken = new Map(
    inlineSkills.map((skill) => [`/${skill}`, skill] as [string, string]),
  );
  const tokens = [...filesByToken.keys(), ...skillsByToken.keys()].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = new RegExp(
    `(${tokens.map((token) => token.startsWith("@")
      ? escapeRegExp(token)
      : `(?<!\\S)${escapeRegExp(token)}`).join("|")})(?=\\s|$)`,
    "g",
  );

  return (
    <p className="agent-chat-markdown whitespace-pre-wrap">
      {text.split(pattern).map((part, index) => {
        const file = filesByToken.get(part);
        if (file) {
          const label = fileName(file.path);
          return (
            <WorkspaceMentionChip
              className="mx-0.5 inline-flex max-w-48 translate-y-px items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 font-medium text-primary-foreground ring-1 ring-inset ring-primary-foreground/20 transition-colors hover:bg-primary-foreground/25 hover:ring-primary-foreground/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              filePath={file.path}
              isDir={file.isDir}
              key={`${index}:${file.path}`}
            >
              {file.isDir ? <Folder className="size-3 shrink-0" /> : <FileIcon className="size-3 shrink-0" />}
              <span className="truncate">{label}</span>
            </WorkspaceMentionChip>
          );
        }
        const skill = skillsByToken.get(part);
        if (skill === undefined) return part;
        return (
          <span
            className="mx-0.5 inline-flex max-w-48 translate-y-px items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 font-medium text-primary-foreground ring-1 ring-inset ring-primary-foreground/20"
            key={`${index}:${skill}`}
            title={`Skill: /${skill}`}
          >
            <Wrench className="size-3 shrink-0" />
            <span className="truncate">{skill}</span>
          </span>
        );
      })}
    </p>
  );
}

function AgentMessageResponse(props: ComponentProps<typeof MessageResponse>) {
  const { children, ...rest } = props;
  return (
    <MessageResponse
      {...rest}
      className={cn("agent-chat-markdown", props.className)}
      components={agentMessageComponents}
    >
      {typeof children === "string" ? rewriteWorkspaceSchemeLinks(children) : children}
    </MessageResponse>
  );
}

// Interactive wrapper for file/folder mention chips in messages. Files link
// to the ?file= param (so modifier-clicks still navigate) and open a tab
// in-place via the workspace-file event; folders reveal in the File Explorer
// instead of opening an editor tab.
function WorkspaceMentionChip({
  children,
  className,
  filePath,
  isDir,
}: {
  children: ReactNode;
  className?: string;
  filePath: string;
  isDir?: boolean;
}) {
  const pathname = usePathname();
  const label = fileName(filePath);

  if (isDir) {
    return (
      <button
        aria-label={`Show ${label} in Files`}
        className={cn("workspace-mention-chip", className)}
        onClick={() => openWorkspaceEntry({ path: filePath, isDir: true })}
        title={`Show in Files: ${filePath}/`}
        type="button"
      >
        {children}
      </button>
    );
  }

  return (
    <Link
      aria-label={`Open ${label}`}
      className={cn("workspace-mention-chip", className)}
      href={`${pathname}?file=${encodeURIComponent(filePath)}`}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        openWorkspaceEntry({ path: filePath });
      }}
      scroll={false}
      style={{ textDecoration: "none" }}
      title={`/workspace/${filePath}`}
    >
      {children}
    </Link>
  );
}

function WorkspaceFileChip({
  children,
  filePath,
  isDir,
}: {
  children: ReactNode;
  filePath: string;
  isDir?: boolean;
}) {
  // Chips parsed from assistant markdown carry no kind info; resolve the
  // dir-ness from the workspace listing the chat keeps indexed.
  const resolvedIsDir = isDir ?? isWorkspaceDirectory(filePath);
  return (
    <WorkspaceMentionChip
      className="mx-0.5 inline-flex max-w-56 translate-y-px items-center gap-1 rounded-md border border-border/70 bg-muted/70 px-1.5 py-0.5 align-baseline font-sans text-[0.85em] font-medium text-foreground no-underline shadow-xs transition-colors hover:border-primary/35 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      filePath={filePath}
      isDir={resolvedIsDir}
    >
      {resolvedIsDir ? (
        <Folder aria-hidden="true" className="size-3 shrink-0 text-blue-500" />
      ) : (
        <FileIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{children}</span>
    </WorkspaceMentionChip>
  );
}

function WorkspaceFileMention({
  children,
  node: _node,
  ...props
}: ComponentProps<"code"> & { node?: unknown }) {
  const text = String(children ?? "");
  const filePath = workspaceFilePath(text);

  if (!filePath) {
    return <code {...props}>{children}</code>;
  }

  return <WorkspaceFileChip filePath={filePath}>{fileName(filePath)}</WorkspaceFileChip>;
}

// rehype-harden (Streamdown's link safety) replaces unparsable link hrefs —
// which includes the bare relative file paths agents write — with a span
// titled "Blocked URL: <href>" and an appended " [blocked]" text marker.
// Those hrefs are file mentions, so rescue them into workspace file chips.
const BLOCKED_URL_TITLE_PREFIX = "Blocked URL: ";

function BlockedWorkspaceLink({
  children,
  node: _node,
  title,
  ...props
}: ComponentProps<"span"> & { node?: unknown }) {
  const url = typeof title === "string" && title.startsWith(BLOCKED_URL_TITLE_PREFIX)
    ? title.slice(BLOCKED_URL_TITLE_PREFIX.length)
    : null;
  const filePath = url === null ? null : blockedUrlWorkspacePath(url);

  if (!filePath) {
    return <span title={title} {...props}>{children}</span>;
  }

  const content = withoutBlockedIndicator(children);
  return <WorkspaceFileChip filePath={filePath}>{content ?? fileName(filePath)}</WorkspaceFileChip>;
}

function withoutBlockedIndicator(children: ReactNode): ReactNode | undefined {
  if (children === " [blocked]") {
    return undefined;
  }
  if (Array.isArray(children) && children.at(-1) === " [blocked]") {
    const stripped = children.slice(0, -1);
    return stripped.length === 1 ? stripped[0] : stripped;
  }
  return children;
}

function containsFileMention(text: string, path: string) {
  return new RegExp(
    `(?:@${escapeRegExp(path)}|(?:^|\\s)${escapeRegExp(fileName(path))})(?=\\s|$)`,
  ).test(text);
}

function containsSkillMention(text: string, slug: string) {
  return new RegExp(`(?:^|\\s)/${escapeRegExp(slug)}(?=\\s|$)`).test(text);
}

function fileName(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function AttachmentPart({ part }: { readonly part: EveFilePart }) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const body = (
    <span className="flex max-w-sm items-center gap-3 rounded-md border bg-background/60 p-2 text-sm">
      {isImage ? (
        <img alt={label} className="size-12 shrink-0 rounded-sm object-cover" src={part.url} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail ? <span className="block truncate text-muted-foreground">{detail}</span> : null}
      </span>
      {part.url ? <SquareArrowOutUpRight className="size-4 shrink-0 text-muted-foreground" /> : null}
    </span>
  );

  return part.url ? (
    <a href={part.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  ) : (
    body
  );
}

function AuthorizationPrompt({ part }: { readonly part: EveAuthorizationPart }) {
  const isAuthorized = part.state === "completed" && part.outcome === "authorized";
  const isCompleted = part.state === "completed";
  const Icon = isAuthorized ? CheckCircleIcon : isCompleted ? XCircleIcon : KeyRoundIcon;
  const instructions = part.authorization?.instructions;
  const shouldShowInstructions = instructions !== undefined && instructions !== part.description;

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border p-3",
        isAuthorized
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isCompleted
            ? "border-destructive/30 bg-destructive/5"
            : "border-blue-500/30 bg-blue-500/5",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            isAuthorized
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : isCompleted
                ? "bg-destructive/10 text-destructive"
                : "bg-blue-500/10 text-blue-700 dark:text-blue-300",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-sm">{authorizationTitle(part)}</p>
          <p className="text-muted-foreground text-sm">{authorizationDescription(part)}</p>
          {shouldShowInstructions ? (
            <p className="text-muted-foreground text-sm">{instructions}</p>
          ) : null}
          {part.state === "required" && part.authorization?.userCode ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Code</span>
              <code className="rounded-md bg-background px-2 py-1 font-mono">
                {part.authorization.userCode}
              </code>
            </div>
          ) : null}
          {part.state === "required" && part.authorization?.url ? (
            <Button asChild size="sm">
              <a href={part.authorization.url} rel="noreferrer" target="_blank">
                <SquareArrowOutUpRight className="size-4" />
                Sign in with {part.displayName}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function authorizationTitle(part: EveAuthorizationPart): string {
  if (part.state === "required") {
    return `Connect ${part.displayName}`;
  }
  if (part.outcome === "authorized") {
    return `${part.displayName} connected`;
  }
  return `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}`;
}

function authorizationDescription(part: EveAuthorizationPart): string {
  if (part.state === "required") {
    return part.description;
  }
  if (part.outcome === "authorized") {
    return `${part.displayName} connected.`;
  }
  const tail = part.reason !== undefined ? ` (${part.reason})` : "";
  return `${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}${tail}.`;
}

function formatAuthorizationOutcome(outcome: NonNullable<EveAuthorizationPart["outcome"]>): string {
  switch (outcome) {
    case "authorized":
      return "authorized";
    case "declined":
      return "declined";
    case "failed":
      return "failed";
    case "timed-out":
      return "timed out";
  }
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined) {
    return undefined;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function InputRequestActions({
  canRespond,
  onInputResponses,
  part,
}: {
  readonly canRespond: boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveDynamicToolPart;
}) {
  const [freeform, setFreeform] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (!inputRequest) {
    return null;
  }

  const inputResponse = part.toolMetadata?.eve?.inputResponse;
  const selectedOption = inputRequest.options?.find(
    (option) => option.id === inputResponse?.optionId,
  );
  const showFreeform =
    inputRequest.allowFreeform === true ||
    inputRequest.display === "text" ||
    (inputRequest.options?.length ?? 0) === 0;

  const submitFreeform = async () => {
    const text = freeform.trim();
    if (!text || submitting || !canRespond) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await onInputResponses([{ requestId: inputRequest.requestId, text }]);
    } catch (error) {
      setSubmitError(errorDetail(error, "Could not send response"));
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
      <AgentMessageResponse className="text-sm text-muted-foreground">
        {inputRequest.prompt}
      </AgentMessageResponse>
      {inputResponse ? (
        <p className="font-medium text-sm">
          Responded: {selectedOption?.label ?? inputResponse.text ?? inputResponse.optionId}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {inputRequest.options?.map((option) => (
            <Button
              disabled={!canRespond || submitting}
              key={option.id}
              onClick={() => {
                void onInputResponses([
                  {
                    optionId: option.id,
                    requestId: inputRequest.requestId,
                  },
                ]);
              }}
              size="sm"
              type="button"
              variant={option.style === "danger" ? "destructive" : "default"}
            >
              {option.label}
            </Button>
            ))}
          </div>
          {showFreeform ? (
            <div className="space-y-2">
              <label className="sr-only" htmlFor={`input-request-${inputRequest.requestId}`}>
                Your response
              </label>
              <textarea
                className="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canRespond || submitting}
                id={`input-request-${inputRequest.requestId}`}
                onChange={(event) => setFreeform(event.target.value)}
                placeholder="Type your response…"
                value={freeform}
              />
              <div className="flex items-center justify-between gap-3">
                {submitError ? <p className="text-xs text-destructive">{submitError}</p> : <span />}
                <Button
                  disabled={!canRespond || submitting || freeform.trim().length === 0}
                  onClick={() => void submitFreeform()}
                  size="sm"
                  type="button"
                >
                  {submitting ? "Sending…" : "Send response"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "authorization":
      return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
    case "dynamic-tool":
      return part.toolCallId;
    default:
      return `${part.type}:${index}`;
  }
}
