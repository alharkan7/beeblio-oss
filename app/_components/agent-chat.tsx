"use client";

import type {
  ClientSessionState,
  MessageStreamEvent,
} from "eve/client";
import { useEveAgent } from "eve/react";
import {
  AlertCircleIcon,
  Pencil,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  ADD_FILE_TO_CHAT_EVENT,
  ADD_SELECTION_TO_CHAT_EVENT,
  ASK_AGENT_EVENT,
  OPEN_WORKSPACE_FILE_EVENT,
  NEW_CONVERSATION_EVENT,
  SKILLS_CHANGED_EVENT,
  openWorkspaceEntry,
  serializeChatMessage,
  type AskAgentDetail,
  type ChatFileContext,
  type ChatInteractionContext,
  type ChatSelectionContext,
} from "@/lib/chat-context";
import { rememberWorkspaceEntries } from "@/lib/workspace-entry-index";
import {
  applyMutationToFlatListing,
  WORKSPACE_MUTATION_EVENT,
  type WorkspaceMutation,
} from "@/lib/workspace-mutations";
import { resizeImageForAgent } from "@/lib/client-image-resize";
import { SYSTEM_SKILL_SUMMARIES } from "@/lib/skill-markdown";
type SuggestedPrompt = { label: string; prompt: string };
import { listAllFiles, type FileEntry } from "@/app/[projectId]/file-actions";
import { uploadWorkspaceFile } from "@/lib/workspace-upload";
import { listSkills, type SkillSummary } from "@/app/[projectId]/skill-actions";
import { useWorkspaceContext } from "@/app/[projectId]/_components/workspace-context";
import type { ReasoningVerbosity, ToolCallVerbosity } from "./agent-message";
import {
  AgentChatComposer,
  containsMention,
  containsSkillMention,
  fileMentionToken,
  normalizeInlineFileMentions,
  normalizeInlineSkillMentions,
  selectionIdentity,
  skillMentionToken,
} from "./agent-chat-composer";
import { AgentMessageList } from "./agent-message-list";
import { ConversationLoading } from "./conversation-loading";
import { errorDetail } from "@/lib/error-detail";

const transitionEventCache = new Map<string, readonly MessageStreamEvent[]>();

// Grace period for a cancelled turn to deliver its terminal stream events
// (turn.cancelled + session.waiting) before the watchdog below unwedges the
// UI by aborting the local turn transport.
const CANCEL_SETTLE_TIMEOUT_MS = 10_000;

type AgentStatus = ReturnType<typeof useEveAgent>["status"];
type CancellationState = "idle" | "requested" | "cancelling";
type HeldChatMessage = {
  serialized: string;
  preview: string;
  mentions: ChatFileContext[];
  skills: string[];
  selections: ChatSelectionContext[];
  inlineSnapshot: { path: string; content: string } | null;
};

export function AgentChat({
  projectId,
  sessionId,
  initialState,
  initialEvents,
  toolCallVerbosity = "compact",
  reasoningVerbosity = "compact",
  suggestedPrompts,
  includeSystemSkills = false,
}: {
  projectId?: string;
  sessionId?: string;
  initialState?: ClientSessionState;
  initialEvents?: readonly MessageStreamEvent[];
  toolCallVerbosity?: ToolCallVerbosity;
  reasoningVerbosity?: ReasoningVerbosity;
  suggestedPrompts?: readonly SuggestedPrompt[];
  includeSystemSkills?: boolean;
}) {
  // Seed events for instant render: the in-memory transition cache for a
  // same-session navigation, else the persisted event snapshot. Whatever
  // prefix this misses, the hook's `resume` catch-up replays from the durable
  // stream, so rendering never waits on a replay the way the pre-0.55
  // hand-rolled client did.
  const [historyEvents, setHistoryEvents] = useState<
    readonly MessageStreamEvent[]
  >(() => {
    const cacheKey = sessionId && projectId ? `${projectId}:${sessionId}` : undefined;
    const cached = cacheKey ? transitionEventCache.get(cacheKey) : undefined;
    return cached ?? initialEvents ?? [];
  });

  // A chat that starts on the "new chat" route persists its session in place:
  // the URL becomes /projectId/sessionId via history.replaceState, without a
  // navigation, so this component (keyed `${projectId}:new` by the page) keeps
  // running. A later real navigation back to /projectId re-renders the page
  // with the same key, so React reconciles instead of remounting — reset here
  // so the user gets a fresh chat instead of the just-persisted one.
  const pathname = usePathname();
  const router = useRouter();
  const [resetCount, setResetCount] = useState(0);
  const [startedFreshConversation, setStartedFreshConversation] = useState(false);
  const prevPathnameRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const startFreshConversation = () => {
      setStartedFreshConversation(true);
      setHistoryEvents([]);
      setResetCount((count) => count + 1);
    };
    window.addEventListener(NEW_CONVERSATION_EVENT, startFreshConversation);
    return () => window.removeEventListener(NEW_CONVERSATION_EVENT, startFreshConversation);
  }, []);

  useEffect(() => {
    if (!startedFreshConversation) return;
    const restoreRouteOnBack = () => {
      setStartedFreshConversation(false);
      setHistoryEvents(initialEvents ?? []);
      setResetCount((count) => count + 1);
      router.refresh();
    };
    window.addEventListener("popstate", restoreRouteOnBack);
    return () => window.removeEventListener("popstate", restoreRouteOnBack);
  }, [startedFreshConversation, initialEvents, router]);

  useEffect(() => {
    const prev = prevPathnameRef.current;
    prevPathnameRef.current = pathname;
    if (prev === undefined || prev === pathname || sessionId !== undefined || startedFreshConversation || !projectId) {
      return;
    }
    if (prev.startsWith(`/${projectId}/`) && pathname === `/${projectId}`) {
      setHistoryEvents([]);
      setResetCount((count) => count + 1);
    }
  }, [pathname, projectId, sessionId, startedFreshConversation]);

  // Drop the consumed cache entry once it has been seeded into state; the
  // running chat below keeps its own entries current (see handleEvent).
  useEffect(() => {
    if (sessionId && projectId) {
      transitionEventCache.delete(`${projectId}:${sessionId}`);
    }
  }, [projectId, sessionId]);

  return (
    <AgentChatInner
      historyEvents={historyEvents}
      key={resetCount}
      initialState={startedFreshConversation ? undefined : initialState}
      projectId={projectId}
      sessionId={startedFreshConversation ? undefined : sessionId}
      toolCallVerbosity={toolCallVerbosity}
      reasoningVerbosity={reasoningVerbosity}
      suggestedPrompts={suggestedPrompts}
      includeSystemSkills={includeSystemSkills}
    />
  );
}

function AgentChatInner({
  historyEvents,
  initialState,
  projectId,
  sessionId,
  toolCallVerbosity,
  reasoningVerbosity,
  suggestedPrompts,
  includeSystemSkills,
}: {
  historyEvents: readonly MessageStreamEvent[];
  initialState?: ClientSessionState;
  projectId?: string;
  sessionId?: string;
  toolCallVerbosity: ToolCallVerbosity;
  reasoningVerbosity: ReasoningVerbosity;
  suggestedPrompts?: readonly SuggestedPrompt[];
  includeSystemSkills: boolean;
}) {
  const workspace = useWorkspaceContext();
  const eventLogRef = useRef<MessageStreamEvent[]>([...historyEvents]);
  const pendingInlineSnapshotRef = useRef<{ path: string; content: string } | null>(null);
  const pendingEditorWritesRef = useRef(new Map<string, string>());
  const changedWorkspaceTurnsRef = useRef(new Set<string>());
  // Set once this instance persists its session in place (new chat → named
  // URL without a navigation). Later turns PUT state against this id because
  // the sessionId prop stays undefined for the lifetime of this instance.
  const persistedSessionIdRef = useRef<string | undefined>(undefined);
  // The app row is created before dispatch, then linked to the Eve session as
  // soon as Eve accepts the turn. Avoid repeating that initial cursor write on
  // every streamed event.
  const persistedEveSessionIdRef = useRef(initialState?.sessionId);
  // Aborting this signal ends the active turn's local transport (the stream
  // read and any pending request), settling the hook in ready without
  // touching the server-side session. Used to unwedge the UI when a
  // cancelled turn's terminal events never arrive.
  const turnAbortRef = useRef<AbortController | undefined>(undefined);
  const [cancellationError, setCancellationError] = useState<string>();
  const [streamError, setStreamError] = useState<string | undefined>(() =>
    latestStreamError(historyEvents),
  );
  const [cancellationState, setCancellationState] = useState<CancellationState>("idle");
  const persistCurrentSessionState = useCallback(
    (cursor: ClientSessionState | undefined, force = false) => {
      const appSessionId = sessionId ?? persistedSessionIdRef.current;
      if (!appSessionId || !cursor?.sessionId) return;
      if (!force && persistedEveSessionIdRef.current === cursor.sessionId) return;

      persistedEveSessionIdRef.current = cursor.sessionId;
      let payload = JSON.stringify({
        sessionId: appSessionId,
        state: cursor,
        ...(force ? { events: eventLogRef.current } : {}),
      });

      // Vercel serverless functions enforce a 4.5 MB platform request body limit.
      // If the event snapshot exceeds 3.5 MB, drop the optional events payload so
      // the critical session cursor/state always persists without a 413 error.
      // Eve's server-side durable stream will replay any missing history on demand.
      if (payload.length > 3_500_000) {
        payload = JSON.stringify({
          sessionId: appSessionId,
          state: cursor,
        });
      }

      void fetch("/api/sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
        // The initial cursor is tiny and should survive navigation. Final event
        // snapshots can exceed the browser's 64 KB keepalive body limit.
        keepalive: !force && payload.length < 60_000,
      }).then((res) => {
        if (!res.ok) {
          console.warn("Session persistence responded with status:", res.status);
        } else {
          window.dispatchEvent(new CustomEvent("beeblio:session-created"));
        }
      }).catch((error) => {
        // Allow a later cursor advance to retry an interrupted initial link.
        if (!force) persistedEveSessionIdRef.current = undefined;
        console.error("Session persistence error:", error);
      });
    },
    [sessionId],
  );

  const prepareConversation = useCallback(() => {
    if (sessionId) return sessionId;
    if (persistedSessionIdRef.current) return persistedSessionIdRef.current;
    if (!projectId) return undefined;

    const appSessionId = crypto.randomUUID();
    persistedSessionIdRef.current = appSessionId;
    const fileQuery = workspace.activeFile
      ? `?file=${encodeURIComponent(workspace.activeFile.path)}`
      : "";
    // The Eve proxy registers this id before forwarding the turn upstream.
    // Updating locally avoids a separate blocking session-creation round trip.
    window.history.replaceState(null, "", `/${projectId}/${appSessionId}${fileQuery}`);
    return appSessionId;
  }, [
    projectId,
    sessionId,
    workspace.activeFile,
  ]);

  // Compaction runs as a silent model call mid-turn (no message deltas), so
  // without this flag the stream looks stalled while it summarizes.
  const [isCompacting, setIsCompacting] = useState(false);

  const handleEvent = useCallback(
    (event: MessageStreamEvent) => {
      eventLogRef.current.push(event);
      const appSessionId = sessionId ?? persistedSessionIdRef.current;
      if (projectId && appSessionId) {
        transitionEventCache.set(
          `${projectId}:${appSessionId}`,
          [...eventLogRef.current],
        );
      }
      if (event.type === "compaction.requested") {
        setIsCompacting(true);
      } else if (event.type === "actions.requested") {
        for (const action of event.data.actions) {
          if (action.kind === "tool-call" && OPAQUE_WORKSPACE_TOOLS.has(action.toolName)) {
            changedWorkspaceTurnsRef.current.add(event.data.turnId);
          }
          if (action.kind !== "tool-call" || !WORKSPACE_MUTATING_TOOLS.has(action.toolName)) continue;
          const path = workspaceRelativeToolPath({ path: action.input.filePath });
          if (!path) continue;
          pendingEditorWritesRef.current.set(action.callId, path);
          window.dispatchEvent(new CustomEvent("beeblio:agent-file-edit", {
            detail: { projectId, path, callId: action.callId, editing: true },
          }));
        }
      } else if (
        event.type === "compaction.completed" ||
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled" ||
        event.type === "session.waiting"
      ) {
        setIsCompacting(false);
      }
      if (
        event.type === "action.result" &&
        event.data.status === "completed" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.toolName === "open_file"
      ) {
        const output = event.data.result.output;
        if (isOpenFileOutput(output)) {
          window.dispatchEvent(
            new CustomEvent(OPEN_WORKSPACE_FILE_EVENT, {
              detail: { name: output.name, path: output.path },
            }),
          );
        }
      }
      if (
        event.type === "action.result" &&
        event.data.status === "completed" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.toolName === "add_to_knowledge"
      ) {
        window.dispatchEvent(new CustomEvent("beeblio:knowledge-changed"));
      }
      if (
        event.type === "action.result" &&
        event.data.result.kind === "tool-result"
      ) {
        const callId = event.data.result.callId;
        const path = pendingEditorWritesRef.current.get(callId);
        if (path) {
          pendingEditorWritesRef.current.delete(callId);
          window.dispatchEvent(new CustomEvent("beeblio:agent-file-edit", {
            detail: { projectId, path, callId, editing: false },
          }));
        }
      }
      if (
        event.type === "action.result" &&
        event.data.status === "completed" &&
        event.data.result.kind === "tool-result" &&
        !event.data.result.isError &&
        WORKSPACE_MUTATING_TOOLS.has(event.data.result.toolName)
      ) {
        const changed = workspaceToolChanged(event.data.result.toolName, event.data.result.output);
        if (changed) changedWorkspaceTurnsRef.current.add(event.data.turnId);
        const snapshot = pendingInlineSnapshotRef.current;
        const writtenPath = workspaceRelativeToolPath(event.data.result.output);
        if (changed && writtenPath) {
          const matchingSnapshot = snapshot?.path === writtenPath ? snapshot : undefined;
          if (matchingSnapshot) pendingInlineSnapshotRef.current = null;
          window.dispatchEvent(new CustomEvent("beeblio:reload-workspace-file", {
            detail: {
              path: writtenPath,
              replaceIfDraftEquals: matchingSnapshot?.content,
            },
          }));
        }
      }
      if (event.type === "turn.failed" || event.type === "session.failed") {
        setStreamError(event.data.message || "The agent could not complete this request.");
      }
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "session.failed") {
        if (event.type === "session.failed") {
          if (changedWorkspaceTurnsRef.current.size > 0) {
            window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
            changedWorkspaceTurnsRef.current.clear();
          }
        } else if (changedWorkspaceTurnsRef.current.delete(event.data.turnId)) {
          window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
        }
        for (const [callId, path] of pendingEditorWritesRef.current) {
          window.dispatchEvent(new CustomEvent("beeblio:agent-file-edit", {
            detail: { projectId, path, callId, editing: false },
          }));
        }
        pendingEditorWritesRef.current.clear();
      }
      if (event.type === "turn.started") {
        setStreamError(undefined);
      }
    },
    [projectId, sessionId],
  );

  const eveSessionId = initialState?.sessionId;
  const agent = useEveAgent({
    host: "",
    // Tag every request with the project slug so direct GCS tools and
    // the local sandbox resolves the correct project folder.
    headers: projectId ? { "x-project-slug": projectId } : undefined,
    // Seed the hook with the cached/snapshotted history so resumed sessions
    // render their past messages instantly. `resume` replays the durable
    // stream from exactly the seeded prefix (streamIndex = seeded length),
    // follows an in-flight turn, and settles without waiting on a live-stream
    // idle timeout — this replaces the pre-0.55 hand-rolled replay loop.
    initialEvents: historyEvents,
    ...(eveSessionId
      ? {
          initialSession: {
            sessionId: eveSessionId,
            streamIndex: historyEvents.length,
          },
          resume: true,
        }
      : {}),
    onEvent: handleEvent,
    // The cursor advances as events are consumed: this links the app session
    // row to the Eve session on the first event (so a navigation can
    // reconnect to an in-flight first turn) and keeps the persisted cursor
    // current for every later turn.
    onSessionChange: (cursor) => persistCurrentSessionState(cursor),
  });

  const prevStatusRef = useRef<AgentStatus>(agent.status);
  const heldAutoSendArmedRef = useRef(false);
  useEffect(() => {
    const previous = prevStatusRef.current;
    prevStatusRef.current = agent.status;
    const wasBusy = previous === "submitted" || previous === "streaming";
    const isBusyNow = agent.status === "submitted" || agent.status === "streaming";
    if (isBusyNow) return;
    if (agent.status === "resuming") {
      if (heldMessageRef.current) heldAutoSendArmedRef.current = true;
      return;
    }
    const held = heldMessageRef.current;
    if (!held) return;
    const armed = wasBusy || heldAutoSendArmedRef.current;
    heldAutoSendArmedRef.current = false;
    if (!armed) return;
    if (agent.status === "error") {
      setHeldMessage(null);
      setDraft(held.preview);
      setMentionedFiles(held.mentions);
      setMentionedSkills(held.skills);
      setAttachedSelections(held.selections);
      return;
    }
    setHeldMessage(null);
    void dispatchRef.current({ serialized: held.serialized, steer: false, inlineSnapshot: held.inlineSnapshot, restore: held, restageOnFailure: true }).catch(() => undefined);
  }, [agent.status]);

  // A cancellation is fulfilled once the stream delivers the turn's terminal
  // events and the status leaves the busy states; the lingering cancellation
  // state (which pins the composer to its stopping spinner) must clear too.
  useEffect(() => {
    const isBusyNow = agent.status === "submitted" || agent.status === "streaming";
    if (cancellationState === "idle" || isBusyNow) return;
    setCancellationState("idle");
  }, [agent.status, cancellationState]);

  // Watchdog for a cancel whose terminal events never arrive: eve reconnects
  // an active turn's stream indefinitely, which would keep the working cues
  // animating and the composer stuck stopping forever. Once the server has
  // had ample time to settle the cancelled turn, abort the local transport
  // so the hook lands in ready.
  useEffect(() => {
    const isBusyNow = agent.status === "submitted" || agent.status === "streaming";
    if (cancellationState === "idle" || !isBusyNow) return;
    const timer = window.setTimeout(() => {
      turnAbortRef.current?.abort();
    }, CANCEL_SETTLE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [agent.status, cancellationState]);

  useEffect(() => {
    if (agent.status === "ready" && agent.session) {
      const effectiveSessionId = sessionId ?? persistedSessionIdRef.current;
      if (effectiveSessionId) {
        // Keep the persisted cursor and the instant-render transition cache in
        // sync after every turn of a session that was created in place.
        if (projectId) {
          transitionEventCache.set(
            `${projectId}:${effectiveSessionId}`,
            [...eventLogRef.current],
          );
        }
        persistCurrentSessionState(agent.session, true);
      }
    }
  }, [agent.status, agent.session, sessionId, projectId, persistCurrentSessionState]);

  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isResuming = agent.status === "resuming";
  const isEmpty = agent.data.messages.length === 0;
  const errorMessage = cancellationError ?? streamError ?? agent.error?.message;
  // The storage turn gate also answers 402; distinguish it from credit shortage.
  // The composer's status prop speaks the AI SDK ChatStatus vocabulary, which
  // has no "resuming"; show the spinner for it and rely on submitDisabled.
  const submitStatus = isBusy && cancellationState !== "idle" || isResuming
    ? "submitted"
    : agent.status;
  // While a tool call's arguments stream (write_file composing a whole
  // document, say), eve emits no events at all — the tool row only exists
  // once `actions.requested` fires with the complete input, so the stream
  // falls silent right after the last text delta and the caret looks stuck.
  // Treat a text stream that has been silent past a threshold as ongoing
  // work and keep the working indicator up.
  const lastStreamEvent = agent.events.at(-1);
  const textStreamStalled = useStalledEvent(
    isBusy && lastStreamEvent?.type === "message.appended" ? lastStreamEvent : undefined,
    1500,
  );
  const prepareTurn = () => {
    setCancellationError(undefined);
    setStreamError(undefined);
    setCancellationState("idle");
    turnAbortRef.current = new AbortController();
  };

  const requestCancellation = () => {
    if (!isBusy || cancellationState !== "idle") {
      return;
    }

    setCancellationError(undefined);
    setCancellationState("requested");

    // The hook resolves the active turn itself — it waits for the response to
    // identify the turn when necessary and guards the request against
    // targeting a later turn — so the pre-0.55 turnId bookkeeping is gone.
    void agent.cancel()
      .then(() => setCancellationState("cancelling"))
      .catch((error: unknown) => {
        setCancellationError(toErrorMessage(error));
        setCancellationState("idle");
      });
  };

  const [draft, setDraft] = useState("");
  const [mentionedFiles, setMentionedFiles] = useState<ChatFileContext[]>([]);
  const [mentionedSkills, setMentionedSkills] = useState<string[]>([]);
  const [attachedSelections, setAttachedSelections] = useState<ChatSelectionContext[]>([]);
  const [heldMessage, setHeldMessage] = useState<HeldChatMessage | null>(null);
  const heldMessageRef = useRef<HeldChatMessage | null>(null);
  heldMessageRef.current = heldMessage;
  const [selectionShortcutLabel, setSelectionShortcutLabel] = useState("Ctrl+L");
  // Bumped on every accepted send so the message list scrolls the new user
  // message into view even when the user had scrolled up (see AgentMessageList).
  const [sendScrollSignal, setSendScrollSignal] = useState(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[]>(() => workspace.initialFiles ?? []);
  const workspaceMutationRevision = useRef(0);
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string>();
  const [skillQuery, setSkillQuery] = useState<string>();
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLTextAreaElement>(null);
  const draftCursorRef = useRef(0);

  // Inserts `@path` or `/skill` at the caret. When replaceActiveQuery is set,
  // the trailing partial query ("@apa", "/apa") under the caret is replaced
  // instead of inserting at the caret position.
  const insertToken = useCallback(
    (sigil: "@" | "/", value: string, replaceActiveQuery: boolean) => {
      const token = sigil === "@" ? fileMentionToken(value) : skillMentionToken(value);
      // Read the textarea directly while its selection is still intact. The
      // cached caret can lag behind mouse/keyboard selection changes that do
      // not emit an input event, which used to insert a chosen mention at an
      // unrelated position in the draft.
      const liveCursor = replaceActiveQuery
        ? draftInputRef.current?.selectionStart
        : undefined;
      const requestedCursor = liveCursor ?? draftCursorRef.current;
      setDraft((current) => {
        const cursor = Math.min(requestedCursor, current.length);
        const beforeCursor = current.slice(0, cursor);
        const escapedSigil = sigil === "@" ? "@" : "/";
        const query = replaceActiveQuery
          ? beforeCursor.match(new RegExp(`(?:^|\\s)\\${escapedSigil}[^\\s${escapedSigil}]*$`))
          : null;
        const start = query ? cursor - query[0].trimStart().length : cursor;
        const needsLeadingSpace = start > 0 && !/\s/.test(current[start - 1] ?? "");
        const needsTrailingSpace = cursor === current.length || !/\s/.test(current[cursor] ?? "");
        const inserted = `${needsLeadingSpace ? " " : ""}${token}${needsTrailingSpace ? " " : ""}`;
        const next = `${current.slice(0, start)}${inserted}${current.slice(cursor)}`;
        const nextCursor = start + inserted.length;
        draftCursorRef.current = nextCursor;
        requestAnimationFrame(() => {
          draftInputRef.current?.focus();
          draftInputRef.current?.setSelectionRange(nextCursor, nextCursor);
        });
        return next;
      });
    },
    [],
  );

  const insertMention = useCallback(
    (path: string, replaceActiveQuery: boolean) => insertToken("@", path, replaceActiveQuery),
    [insertToken],
  );

  useEffect(() => {
    const addExplorerFile = (event: Event) => {
      const file = (event as CustomEvent<FileEntry>).detail;
      if (!file) return;
      setMentionedFiles((current) =>
        current.some((item) => item.path === file.path)
          ? current
          : [...current, { path: file.path, kind: "mention", isDir: file.isDir || undefined }],
      );
      draftCursorRef.current = Number.MAX_SAFE_INTEGER;
      insertMention(file.path, false);
      setMentionQuery(undefined);
    };
    window.addEventListener(ADD_FILE_TO_CHAT_EVENT, addExplorerFile);
    return () => window.removeEventListener(ADD_FILE_TO_CHAT_EVENT, addExplorerFile);
  }, [insertMention]);

  const refreshWorkspaceFiles = useCallback(() => {
    if (!projectId) return;
    const revision = workspaceMutationRevision.current;
    void listAllFiles(projectId)
      .then((entries) => {
        if (revision !== workspaceMutationRevision.current) return;
        // Mention chips parsed from assistant markdown have no kind info;
        // they read dir-ness from this index (see workspace-entry-index).
        rememberWorkspaceEntries(entries);
        setWorkspaceFiles(entries);
      })
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    const handleMutation = (event: Event) => {
      const mutation = (event as CustomEvent<WorkspaceMutation>).detail;
      workspaceMutationRevision.current += 1;
      setWorkspaceFiles((current) => applyMutationToFlatListing(current, mutation));
    };
    window.addEventListener(WORKSPACE_MUTATION_EVENT, handleMutation);
    return () => window.removeEventListener(WORKSPACE_MUTATION_EVENT, handleMutation);
  }, []);

  useEffect(() => {
    rememberWorkspaceEntries(workspaceFiles);
  }, [workspaceFiles]);

  useEffect(() => {
    if (workspace.initialFiles) rememberWorkspaceEntries(workspace.initialFiles);
    else refreshWorkspaceFiles();
    window.addEventListener("beeblio:workspace-changed", refreshWorkspaceFiles);
    return () => window.removeEventListener("beeblio:workspace-changed", refreshWorkspaceFiles);
  }, [refreshWorkspaceFiles, workspace.initialFiles]);

  // User-defined skills are user-scoped (available in every project) and only
  // change through the Skills panel, which announces itself via the event.
  useEffect(() => {
    const loadSkills = () => {
      void listSkills().then(setAvailableSkills).catch(() => undefined);
    };
    loadSkills();
    window.addEventListener(SKILLS_CHANGED_EVENT, loadSkills);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, loadSkills);
  }, []);

  const mentionResults = useMemo(() => {
    if (mentionQuery === undefined) return [];
    const query = mentionQuery.toLocaleLowerCase();
    return workspaceFiles
      .filter((file) =>
        !mentionedFiles.some((mentioned) => mentioned.path === file.path) &&
        file.name.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) => {
        const aName = a.name.toLocaleLowerCase();
        const bName = b.name.toLocaleLowerCase();
        const aStartsWithQuery = aName.startsWith(query);
        const bStartsWithQuery = bName.startsWith(query);
        if (aStartsWithQuery !== bStartsWithQuery) return aStartsWithQuery ? -1 : 1;
        return aName.localeCompare(bName);
      })
      .slice(0, 8);
  }, [mentionQuery, workspaceFiles, mentionedFiles]);

  const groupedSkillResults = useMemo(() => {
    if (skillQuery === undefined) return { custom: [], system: [] };
    const query = skillQuery.toLocaleLowerCase();
    const matchesQuery = (skill: { slug: string; name: string }) =>
      skill.slug.toLocaleLowerCase().includes(query) ||
      skill.name.toLocaleLowerCase().includes(query);
    const custom = availableSkills
      .filter((skill) => !skill.invalidReason)
      .filter((skill) => !mentionedSkills.includes(skill.slug))
      .filter(matchesQuery);
    const system = includeSystemSkills
      ? SYSTEM_SKILL_SUMMARIES
          .filter((skill) => !mentionedSkills.includes(skill.slug))
          .filter(matchesQuery)
      : [];
    return { custom, system };
  }, [skillQuery, availableSkills, mentionedSkills, includeSystemSkills]);
  const skillResults = [
    ...groupedSkillResults.custom,
    ...groupedSkillResults.system,
  ];

  useEffect(() => {
    setActiveMentionIndex(0);
  }, [mentionQuery, skillQuery]);

  // The skill list shares activeMentionIndex with the file list, so clamp
  // against whichever list is currently open (the other reports length 0 and
  // would reset the highlight to the first row on every arrow press).
  const activeResultCount =
    skillQuery !== undefined ? skillResults.length : mentionResults.length;

  useEffect(() => {
    if (activeResultCount === 0) setActiveMentionIndex(0);
    else if (activeMentionIndex >= activeResultCount) {
      setActiveMentionIndex(activeResultCount - 1);
    }
  }, [activeMentionIndex, activeResultCount]);

  // Arrow-key navigation moves the highlight without a pointer; keep the
  // highlighted row scrolled into view in lists that overflow (the skill list).
  useEffect(() => {
    if (mentionQuery === undefined && skillQuery === undefined) return;
    const listId =
      mentionQuery !== undefined ? "workspace-mention-list" : "skill-mention-list";
    document
      .getElementById(listId)
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeMentionIndex, mentionQuery, skillQuery]);

  const addMention = (file: FileEntry, kind: ChatFileContext["kind"] = "mention") => {
    setMentionedFiles((current) =>
      current.some((item) => item.path === file.path)
        ? current
        : [...current, { path: file.path, kind, isDir: file.isDir || undefined }],
    );
    insertMention(file.path, true);
    setMentionQuery(undefined);
  };

  const addSkillMention = (skill: Pick<SkillSummary, "slug" | "name">) => {
    setMentionedSkills((current) =>
      current.includes(skill.slug) ? current : [...current, skill.slug],
    );
    insertToken("/", skill.slug, true);
    setSkillQuery(undefined);
  };

  const handleDraftChange = (value: string, cursor: number | null) => {
    setDraft(value);
    setMentionedFiles((current) =>
      current.filter((mention) => containsMention(value, mention.path)),
    );
    setMentionedSkills((current) =>
      current.filter((slug) => containsSkillMention(value, slug)),
    );
    draftCursorRef.current = cursor ?? value.length;
    const beforeCursor = value.slice(0, cursor ?? value.length);
    const fileMatch = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    setMentionQuery(fileMatch?.[1]);
    const skillMatch = beforeCursor.match(/(?:^|\s)\/([^\s/]*)$/);
    setSkillQuery(skillMatch?.[1]);
  };

  const handleDraftSelectionChange = (cursor: number | null) => {
    if (cursor !== null) draftCursorRef.current = cursor;
  };

  const deleteInlineMention = (
    direction: "backward" | "forward",
    selectionStart: number,
    selectionEnd: number,
  ) => {
    // Leave range deletion to the browser. Atomic deletion applies when the
    // caret is touching, or has moved inside, a mention entity.
    if (selectionStart !== selectionEnd) return false;

    const tokens = [
      ...mentionedFiles.map((file) => fileMentionToken(file.path)),
      ...mentionedSkills.map(skillMentionToken),
    ];
    const ranges = tokens.flatMap((token) => {
      const matches: Array<{ start: number; end: number }> = [];
      let start = draft.indexOf(token);
      while (start !== -1) {
        const end = start + token.length;
        if (end === draft.length || /\s/.test(draft[end] ?? "")) {
          matches.push({ start, end });
        }
        start = draft.indexOf(token, start + token.length);
      }
      return matches;
    });

    const range = ranges.find(({ start, end }) =>
      direction === "backward"
        ? (selectionStart > start && selectionStart <= end) ||
          (selectionStart === end + 1 && draft[end] === " ")
        : selectionStart >= start && selectionStart < end,
    );
    if (!range) return false;

    // Consume the separator after a mention when Backspace is pressed from
    // the normal post-insertion caret position.
    const end = draft[range.end] === " " ? range.end + 1 : range.end;
    const next = `${draft.slice(0, range.start)}${draft.slice(end)}`;
    setDraft(next);
    setMentionedFiles((current) =>
      current.filter((mention) => containsMention(next, mention.path)),
    );
    setMentionedSkills((current) =>
      current.filter((slug) => containsSkillMention(next, slug)),
    );
    setMentionQuery(undefined);
    setSkillQuery(undefined);
    draftCursorRef.current = range.start;
    requestAnimationFrame(() => {
      draftInputRef.current?.focus();
      draftInputRef.current?.setSelectionRange(range.start, range.start);
    });
    return true;
  };

  const addWorkspaceSelection = useCallback(() => {
    const selection = workspace.selection;
    if (!selection) return false;

    setAttachedSelections((current) =>
      current.some((attached) => selectionIdentity(attached) === selectionIdentity(selection))
        ? current
        : [...current, selection],
    );
    workspace.clearSelection();
    return true;
  }, [workspace]);

  useEffect(() => {
    setSelectionShortcutLabel(
      /Macintosh|Mac OS X/.test(navigator.userAgent) ? "⌘ L" : "Ctrl+L",
    );
  }, []);

  useEffect(() => {
    const addSelectionWithShortcut = (event: globalThis.KeyboardEvent) => {
      const isAddSelectionShortcut =
        event.key?.toLowerCase() === "l" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      if (!isAddSelectionShortcut || event.repeat || !workspace.selection) return;

      event.preventDefault();
      event.stopPropagation();
      if (addWorkspaceSelection()) {
        window.dispatchEvent(new CustomEvent(ADD_SELECTION_TO_CHAT_EVENT));
      }
    };

    window.addEventListener("keydown", addSelectionWithShortcut, true);
    return () => window.removeEventListener("keydown", addSelectionWithShortcut, true);
  }, [addWorkspaceSelection, workspace.selection]);

  const handleUpload = async (files: FileList | File[] | null) => {
    if (!projectId || !files?.length) return;
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const upload = await resizeImageForAgent(file);
        const result = await uploadWorkspaceFile(projectId, "", upload);
        if (!result.success) throw new Error(result.error);
        addMention(result.file, "upload");
      }
      window.dispatchEvent(new CustomEvent("beeblio:workspace-changed"));
    } catch (error) {
      toast.error("File upload failed", {
        description: errorDetail(error),
      });
    } finally {
      setIsUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const submitMessage = async (
    message: PromptInputMessage,
    overrides?: {
      selections?: ChatSelectionContext[];
      mentions?: ChatFileContext[];
      interaction?: ChatInteractionContext;
      includeCurrentContent?: boolean;
    },
  ) => {
    const activeMentions = overrides?.mentions ?? mentionedFiles;
    const text = normalizeInlineSkillMentions(
      normalizeInlineFileMentions(message.text, activeMentions),
      mentionedSkills,
    ).trim();
    const submittedSelections = overrides?.selections ?? attachedSelections;
    const currentEditorContent = workspace.activeFile && overrides?.includeCurrentContent
      ? workspace.getCurrentContent()
      : null;
    const activeFileContext: ChatFileContext | undefined = workspace.activeFile
      ? {
          path: workspace.activeFile.path,
          kind: "active",
          ...(currentEditorContent !== null
            ? { unsavedContent: currentEditorContent }
            : workspace.unsavedFile?.path === workspace.activeFile.path
              ? { unsavedContent: workspace.getUnsavedContent() ?? undefined }
              : {}),
        }
      : undefined;
    // An explicitly mentioned active file should render as an inline mention,
    // while still carrying the authoritative unsaved editor snapshot. Merge
    // that duplicate instead of letting the earlier `active` entry hide the
    // later `mention` entry during path-based deduplication.
    const files: ChatFileContext[] = [
      ...activeMentions.map((mention) =>
        mention.path === activeFileContext?.path
          ? { ...activeFileContext, ...mention }
          : mention,
      ),
      ...(activeFileContext &&
      !activeMentions.some(
        (mention) => mention.path === activeFileContext.path,
      )
        ? [activeFileContext]
        : []),
    ];
    if ((text.length === 0 && files.length === 0 && submittedSelections.length === 0) || isResuming || isUploading || cancellationState !== "idle") return;

    const submittedMentions = activeMentions;
    const submittedSkills = mentionedSkills;
    const serializedMessage = serializeChatMessage(text, {
      files,
      skills: mentionedSkills.length > 0 ? mentionedSkills : undefined,
      selections: submittedSelections,
      interaction: overrides?.interaction,
    });
    const inlineSnapshot = currentEditorContent !== null && overrides?.interaction?.targetFilePath
      ? { path: overrides.interaction.targetFilePath, content: currentEditorContent }
      : null;
    const restore = { preview: text, mentions: submittedMentions, skills: submittedSkills, selections: submittedSelections };
    if (isBusy) {
      setHeldMessage({ serialized: serializedMessage, ...restore, inlineSnapshot });
      clearComposerState();
      return;
    }
    await dispatchSerializedMessage({ serialized: serializedMessage, steer: false, inlineSnapshot, restore, restageOnFailure: false });
  };

  const clearComposerState = () => {
    setDraft("");
    setMentionedFiles([]);
    setMentionedSkills([]);
    setAttachedSelections([]);
    workspace.clearSelection();
  };

  const dispatchSerializedMessage = async (input: {
    serialized: string;
    steer: boolean;
    inlineSnapshot: HeldChatMessage["inlineSnapshot"];
    restore: Omit<HeldChatMessage, "serialized" | "inlineSnapshot">;
    restageOnFailure: boolean;
  }) => {
    const appSessionId = prepareConversation();
    prepareTurn();
    setSendScrollSignal((signal) => signal + 1);
    clearComposerState();
    pendingInlineSnapshotRef.current = input.inlineSnapshot;
    const steerNow = input.steer && (agent.status === "submitted" || agent.status === "streaming");
    try {
      await agent.send(input.serialized, {
        ...(steerNow ? { turnPolicy: "steer" as const } : {}),
        headers: {
          "x-beeblio-request-id": crypto.randomUUID(),
          ...(sessionId ? {} : { "x-beeblio-app-session-id": appSessionId ?? "" }),
        },
        signal: turnAbortRef.current?.signal,
      });
    } catch (error) {
      pendingInlineSnapshotRef.current = null;
      if (input.restageOnFailure) {
        setHeldMessage({ serialized: input.serialized, ...input.restore, inlineSnapshot: input.inlineSnapshot });
      } else {
        setDraft(input.restore.preview);
        setMentionedFiles(input.restore.mentions);
        setMentionedSkills(input.restore.skills);
        setAttachedSelections(input.restore.selections);
      }
      throw error;
    }
  };

  const dispatchRef = useRef(dispatchSerializedMessage);
  dispatchRef.current = dispatchSerializedMessage;

  const submitHeldMessage = () => {
    const held = heldMessageRef.current;
    if (!held || isResuming || isUploading || cancellationState !== "idle") return;
    setHeldMessage(null);
    void dispatchRef.current({
      serialized: held.serialized,
      steer: isBusy,
      inlineSnapshot: held.inlineSnapshot,
      restore: held,
      restageOnFailure: true,
    }).catch(() => undefined);
  };

  const editHeldMessage = () => {
    const held = heldMessageRef.current;
    if (!held) return;
    setHeldMessage(null);
    setDraft(held.preview);
    setMentionedFiles(held.mentions);
    setMentionedSkills(held.skills);
    setAttachedSelections(held.selections);
    draftInputRef.current?.focus();
  };

  // Shared send path: the unsaved-file gate plus context overrides for callers
  // (the "Ask Beeblio" event) that attach a passage or file mention in the same
  // tick they submit, before state has caught up.
  const submitWithOptions = async (
    message: PromptInputMessage,
    overrides?: {
      selections?: ChatSelectionContext[];
      mentions?: ChatFileContext[];
      interaction?: ChatInteractionContext;
      includeCurrentContent?: boolean;
    },
  ) => {
    await submitMessage(message, overrides);
  };

  const handleSubmit = (message: PromptInputMessage) => submitWithOptions(message);

  // The editor's floating "Ask Beeblio" box dispatches ASK_AGENT_EVENT: attach
  // its passage and/or file mentions and send the instruction through the
  // normal composer pipeline. When the agent is already busy, the composed
  // message stays in the input for the user to send when the turn finishes.
  const handleAskAgent = (event: Event) => {
    const detail = (event as CustomEvent<AskAgentDetail>).detail;
    const text = detail?.text?.trim() ?? "";
    if (!text) return;
    if (isBusy || isResuming || isUploading) {
      event.preventDefault();
      return;
    }
    detail.onAccepted?.();
    const selection = detail.selection;
    const selections = selection &&
        !attachedSelections.some((attached) => selectionIdentity(attached) === selectionIdentity(selection))
      ? [...attachedSelections, selection]
      : attachedSelections;
    if (selections !== attachedSelections) setAttachedSelections(selections);
    const detailFiles = detail.files ?? [];
    const mentions = detailFiles.length > 0
      ? [
          ...mentionedFiles.filter((mention) => !detailFiles.some((file) => file.path === mention.path)),
          ...detailFiles,
        ]
      : mentionedFiles;
    if (mentions !== mentionedFiles) setMentionedFiles(mentions);
    handleDraftChange(text, text.length);
    void submitWithOptions(
      { text, files: [] },
      {
        selections,
        mentions,
        interaction: detail.interaction,
        // Editor events can make the document dirty in the same tick. Read the
        // registered editor directly instead of waiting for React dirty state.
        includeCurrentContent: true,
      },
    ).catch(() => detail.onRejected?.());
  };
  const handleAskAgentRef = useRef(handleAskAgent);
  handleAskAgentRef.current = handleAskAgent;

  useEffect(() => {
    const onAsk = (event: Event) => handleAskAgentRef.current(event);
    window.addEventListener(ASK_AGENT_EVENT, onAsk);
    return () => window.removeEventListener(ASK_AGENT_EVENT, onAsk);
  }, []);

  const hasManualAttachment =
    mentionedFiles.length > 0 || attachedSelections.length > 0;
  const showViewingContext = Boolean(workspace.activeFile) && !hasManualAttachment;
  const detachedMentionedFiles = mentionedFiles.filter(
    (file) => !containsMention(draft, file.path),
  );
  const hasVisibleComposerContext =
    showViewingContext ||
    detachedMentionedFiles.length > 0 ||
    mentionedSkills.length > 0 ||
    attachedSelections.length > 0;

  return (
    <main className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      {errorMessage ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 sm:px-6">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Request failed</p>
              <p className="mt-0.5 text-muted-foreground">{errorMessage}</p>
            </div>
          </div>
        </div>
      ) : null}

      {isEmpty ? (
        isResuming ? (
          // Catch-up has not delivered the first replayed message yet and the
          // snapshot was empty; show the loading state instead of a misleading
          // "Start a Conversation" screen.
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <ConversationLoading />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="mb-3 flex size-9 items-center justify-center rounded-xl border bg-card text-primary"><Pencil className="size-4" /></div>
            <p className="text-sm font-medium">Start a Conversation</p>
            {suggestedPrompts?.length ? (
              <div className="mt-4 flex w-full max-w-sm flex-wrap justify-center gap-2" aria-label="Suggested questions">
                {suggestedPrompts.map((suggestion) => (
                  <Button
                    key={suggestion.prompt}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-auto min-h-8 whitespace-normal rounded-full px-3 py-1.5 text-left text-[11px] leading-4"
                    disabled={isBusy || isResuming || isUploading}
                    onClick={() => void handleSubmit({ text: suggestion.prompt, files: [] })}
                  >
                    {suggestion.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        )
      ) : (
        <AgentMessageList
          messages={agent.data.messages}
          status={agent.status}
          lastEvent={lastStreamEvent}
          events={agent.events}
          textStreamStalled={textStreamStalled}
          isCompacting={isCompacting}
          isInitialTurn={
            !sessionId &&
            historyEvents.length === 0 &&
            agent.data.messages.filter((message) => message.role === "user").length <= 1
          }
          toolCallVerbosity={toolCallVerbosity}
          reasoningVerbosity={reasoningVerbosity}
          sendScrollSignal={sendScrollSignal}
          onInputResponses={(inputResponses) => {
            prepareTurn();
            return agent.respond(inputResponses, {
              headers: {
                "x-beeblio-request-id": crypto.randomUUID(),
                                    },
              signal: turnAbortRef.current?.signal,
            }).catch((error) => {
                      throw error;
            });
          }}
        />
      )}

      <div className="w-full shrink-0 bg-background/95 p-2 backdrop-blur-sm sm:px-2 sm:pb-2">
        <AgentChatComposer
          draft={draft}
          draftInputRef={draftInputRef}
          uploadInputRef={uploadInputRef}
          mentionedFiles={mentionedFiles}
          mentionedSkills={mentionedSkills}
          attachedSelections={attachedSelections}
          mentionQuery={mentionQuery}
          mentionResults={mentionResults}
          skillQuery={skillQuery}
          groupedSkillResults={groupedSkillResults}
          activeMentionIndex={activeMentionIndex}
          isUploading={isUploading}
          showViewingContext={showViewingContext}
          activeFilePath={workspace.activeFile?.path}
          detachedMentionedFiles={detachedMentionedFiles}
          hasVisibleContext={hasVisibleComposerContext}
          hasWorkspaceSelection={Boolean(workspace.selection)}
          selectionShortcutLabel={selectionShortcutLabel}
          submitStatus={submitStatus}
          submitDisabled={isUploading || isResuming}
          canSteer={isBusy && cancellationState === "idle"}
          heldMessage={heldMessage ? { text: heldMessage.preview, fileCount: heldMessage.mentions.length, skillCount: heldMessage.skills.length, selectionCount: heldMessage.selections.length } : null}
          heldSteerAvailable={isBusy}
          heldDisabled={cancellationState !== "idle" || isResuming || isUploading}
          onHeldSubmit={submitHeldMessage}
          onHeldEdit={editHeldMessage}
          onHeldDiscard={() => setHeldMessage(null)}
          onSubmit={handleSubmit}
          onStop={requestCancellation}
          onUpload={handleUpload}
          onDraftChange={handleDraftChange}
          onDraftSelectionChange={handleDraftSelectionChange}
          onDeleteInlineMention={deleteInlineMention}
          onMentionQueryChange={setMentionQuery}
          onSkillQueryChange={setSkillQuery}
          onActiveMentionIndexChange={setActiveMentionIndex}
          onAddMention={addMention}
          onAddSkillMention={addSkillMention}
          onOpenMention={openWorkspaceEntry}
          onRemoveMention={(path) => setMentionedFiles((current) => current.filter((item) => item.path !== path))}
          onRemoveSkill={(slug) => setMentionedSkills((current) => current.filter((item) => item !== slug))}
          onRemoveSelection={(index) => setAttachedSelections((current) => current.filter((_, selectionIndex) => selectionIndex !== index))}
          onAddWorkspaceSelection={() => { void addWorkspaceSelection(); }}
        />
      </div>


    </main>
  );
}

function useStalledEvent(
  event: MessageStreamEvent | undefined,
  thresholdMs: number,
): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!event) {
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), thresholdMs);
    return () => window.clearTimeout(timer);
  }, [event, thresholdMs]);
  return stalled;
}

function workspaceRelativeToolPath(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || !("path" in output)) {
    return undefined;
  }
  const path = (output as { path?: unknown }).path;
  if (typeof path !== "string") return undefined;
  return path.replace(/^\/workspace\//, "").replace(/^\//, "");
}

// These tools can change workspace contents. Path reloads update open editors;
// a single turn-end refresh reconciles file lists after actual mutations.
const WORKSPACE_MUTATING_TOOLS = new Set([
  "write_file",
  "edit_document",
  "create_directory",
  "update_matrix",
  "update_bibliography",
  "update_excalidraw",
  "create_form",
  "convert_markdown_document",
  "copy_path",
  "fetch_demographic_data",
  "transcribe_audio",
  "fetch_openalex_works",
  "extract_audio",
]);

const OPAQUE_WORKSPACE_TOOLS = new Set(["fetch_openalex_works", "extract_audio"]);

function workspaceToolChanged(toolName: string, output: unknown): boolean {
  if (!output || typeof output !== "object") return true;
  if (toolName === "transcribe_audio") return "outputPath" in output;
  if (toolName === "create_directory" && "created" in output) return output.created !== false;
  if ((toolName === "edit_document" || toolName === "update_bibliography") && "changed" in output) return output.changed !== false;
  return true;
}

function latestStreamError(
  events: readonly MessageStreamEvent[],
): string | undefined {
  let error: string | undefined;
  for (const event of events) {
    if (event.type === "turn.started") {
      error = undefined;
    } else if (event.type === "turn.failed" || event.type === "session.failed") {
      error = event.data.message || "The agent could not complete this request.";
    }
  }
  return error;
}

function isOpenFileOutput(
  value: unknown,
): value is { action: "open_file"; name: string; path: string } {
  if (!value || typeof value !== "object") return false;
  const output = value as Record<string, unknown>;
  return (
    output.action === "open_file" &&
    typeof output.name === "string" &&
    typeof output.path === "string"
  );
}

function toErrorMessage(error: unknown) {
  return errorDetail(error, "Unable to cancel the response.");
}
