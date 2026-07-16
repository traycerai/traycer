import { toast } from "sonner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatRunSettings,
  ChatRunStatus,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { RestoreResultEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/schemas";
import type { AuthProfile } from "@/stores/auth/auth-store";
import type { ChatMessageEditing } from "@/components/chat/chat-message";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  ChatSessionState,
  PendingChatAction,
} from "@/stores/chats/chat-session-store";
import { isTransientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import type { PendingInterviewView } from "./chat-tile-types";

/**
 * Fallback harness id used when the inline-edit settings do not carry a
 * resolved harness. This occurs only while the composer settings are being
 * initialised (before the first snapshot resolves the harness from the
 * persisted chat settings or the epic/global run-settings seed). The value
 * "claude" matches the host's default harness so the slash-command provider
 * in the inline editor loads the right set of slash commands in the brief
 * window before the real harness is known.
 */
const DEFAULT_SLASH_PROVIDER_ID = "claude";

export interface InlineEditState {
  readonly targetMessageId: string;
  readonly originalMessage: ChatMessageModel;
  readonly initialContent: JsonContent;
  readonly currentContent: JsonContent;
  readonly dirty: boolean;
  readonly pendingClientActionId: string | null;
  readonly pendingMessageId: string | null;
}

export interface ChatTileUiState {
  readonly editingQueueItemId: string | null;
  readonly confirmingDeleteMessageId: string | null;
  readonly inlineEdit: InlineEditState | null;
  readonly revertOnEditOpen: boolean;
}

export type ChatTileUiAction =
  | {
      readonly type: "setEditingQueueItemId";
      readonly editingQueueItemId: string | null;
    }
  | {
      readonly type: "setConfirmingDeleteMessageId";
      readonly confirmingDeleteMessageId: string | null;
    }
  | {
      readonly type: "beginInlineEdit";
      readonly targetMessageId: string;
      readonly originalMessage: ChatMessageModel;
      readonly initialContent: JsonContent;
    }
  | {
      readonly type: "updateInlineEditContent";
      readonly content: JsonContent;
    }
  | {
      readonly type: "markInlineEditPending";
      readonly targetMessageId: string;
      readonly clientActionId: string;
      readonly messageId: string;
    }
  | {
      readonly type: "clearInlineEdit";
    }
  | {
      readonly type: "setRevertOnEditOpen";
      readonly open: boolean;
    };

export function createInitialChatTileUiState(): ChatTileUiState {
  return {
    editingQueueItemId: null,
    confirmingDeleteMessageId: null,
    inlineEdit: null,
    revertOnEditOpen: false,
  };
}

export function chatTileUiReducer(
  state: ChatTileUiState,
  action: ChatTileUiAction,
): ChatTileUiState {
  switch (action.type) {
    case "setEditingQueueItemId":
      return {
        ...state,
        editingQueueItemId: action.editingQueueItemId,
      };
    case "setConfirmingDeleteMessageId":
      return {
        ...state,
        confirmingDeleteMessageId: action.confirmingDeleteMessageId,
      };
    case "beginInlineEdit":
      return {
        ...state,
        inlineEdit: {
          targetMessageId: action.targetMessageId,
          originalMessage: action.originalMessage,
          initialContent: action.initialContent,
          currentContent: action.initialContent,
          dirty: false,
          pendingClientActionId: null,
          pendingMessageId: null,
        },
        confirmingDeleteMessageId: null,
      };
    case "updateInlineEditContent":
      if (state.inlineEdit === null) return state;
      if (state.inlineEdit.pendingClientActionId !== null) return state;
      return {
        ...state,
        inlineEdit: {
          ...state.inlineEdit,
          currentContent: action.content,
          dirty: true,
          pendingClientActionId: null,
          pendingMessageId: null,
        },
      };
    case "markInlineEditPending":
      if (state.inlineEdit?.targetMessageId !== action.targetMessageId) {
        return state;
      }
      return {
        ...state,
        inlineEdit: {
          ...state.inlineEdit,
          pendingClientActionId: action.clientActionId,
          pendingMessageId: action.messageId,
        },
      };
    case "clearInlineEdit":
      return {
        ...state,
        inlineEdit: null,
      };
    case "setRevertOnEditOpen":
      return {
        ...state,
        revertOnEditOpen: action.open,
      };
  }
}

// ── Pure session helpers (no React dependency) ────────────────────────────────

/**
 * The composer's turn-status prop shape - a strict subset of
 * `ChatActiveTurn["status"]` (which also carries terminal values like
 * `"completed"`/`"errored"` that never apply here). Narrower than that wider
 * type so callers like `useRenderedMessages`'s `runStatus: ChatRunStatus`
 * input can consume it directly (`"running"`/`"stopping"` overlap exactly;
 * `null` maps to `"idle"`).
 */
export type ComposerTurnStatus = "running" | "stopping" | null;

/**
 * Maps the host-owned chat `runStatus` onto the composer's turn-status prop
 * shape. `running` shows the stop button, `stopping` shows the "Stopping"
 * affordance, `idle` returns the composer to its send state.
 */
export function composerTurnStatus(
  runStatus: ChatRunStatus,
): ComposerTurnStatus {
  if (runStatus === "running") return "running";
  if (runStatus === "stopping") return "stopping";
  return null;
}

/**
 * Narrows {@link composerTurnStatus} to the question every turn-scoped
 * consumer actually needs - the composer's Stop/Send toggle, restore/revert
 * gating, and the per-row "Working…"/"Stopping…" indicator: is there a turn
 * genuinely active or activating right now? `runStatus` also reads "running"
 * while a queued item is pending or visible background work outlives the
 * turn (Bash `run_in_background` / a subagent / Monitor) - neither of which
 * corresponds to an active turn. Background work already has its own
 * "stop all background" control, so rather than show a Stop button that
 * would fail, block a restore that isn't actually unsafe, or duplicate the
 * row indicator after the real turn already settled, this falls back to
 * `null` - exactly as if the chat were idle.
 *
 * Two layers, in priority order:
 *  1. `state.turnInProgress`, when present - the host's own
 *     `isTurnInProgress()`, sent verbatim. Exact, no known gaps.
 *  2. A local approximation, for an older host that predates the field:
 *     `activeTurn !== null` covers a genuinely running (or stopping) turn
 *     directly. When it's null but `runStatus` still reads "running",
 *     process of elimination against the queue/background signals is the
 *     only way to tell a pre-turn "activating" window (active) apart from a
 *     queue-only or background-only one (not active) - both look identical
 *     on the wire otherwise. Known gap: if a turn is still activating AND
 *     another item is queued behind it, the queue signal is also "runnable",
 *     so this can't distinguish that from a queue-only state and will
 *     (narrowly, incorrectly) fall back to `null` during that brief pre-turn
 *     window. Layer 1 closes this gap whenever the host supports it.
 */
export function resolvedTurnStatus(
  state: Pick<
    ChatSessionState,
    "activeTurn" | "queue" | "backgroundItems" | "turnInProgress"
  >,
  turnStatus: ComposerTurnStatus,
): ComposerTurnStatus {
  if (turnStatus === null) return null;
  if (state.turnInProgress !== undefined) {
    return state.turnInProgress ? turnStatus : null;
  }
  if (state.activeTurn !== null) return turnStatus;
  const isQueueRunnable =
    state.queue.status !== "paused" && state.queue.items.length > 0;
  const hasVisibleBackgroundWork = (state.backgroundItems?.length ?? 0) > 0;
  return isQueueRunnable || hasVisibleBackgroundWork ? null : turnStatus;
}

/**
 * Tri-state activity for the chat's progress indicators (sidebar tree, tab
 * icons): is the agent actually processing, or is only background work
 * (Bash `run_in_background` / a subagent / Monitor / a scheduled wakeup)
 * keeping the chat non-idle? `runStatus` alone can't tell the two apart, and
 * showing the same spinner for both left users unable to see whether the
 * agent was really running.
 *
 * `"turn"` wins whenever a genuine turn is active or activating (the host's
 * `turnInProgress`, via {@link resolvedTurnStatus}) — background work running
 * alongside a turn is subsumed by it. A runnable queue also reads `"turn"`:
 * the next prompt is imminent, and the momentary turn-boundary gaps while a
 * queue drains must not flicker the indicator through the background style.
 */
export type ChatActivityIndicator = "turn" | "background" | null;

export function chatActivityIndicator(
  state: Pick<
    ChatSessionState,
    "runStatus" | "activeTurn" | "queue" | "backgroundItems" | "turnInProgress"
  >,
): ChatActivityIndicator {
  const turnStatus = composerTurnStatus(state.runStatus);
  if (turnStatus === null) return null;
  if (resolvedTurnStatus(state, turnStatus) !== null) return "turn";
  const isQueueRunnable =
    state.queue.status !== "paused" && state.queue.items.length > 0;
  return isQueueRunnable ? "turn" : "background";
}

export function normalizeInlineEditForSession(
  inlineEdit: InlineEditState | null,
  state: Pick<
    ChatSessionState,
    "messages" | "pendingActions" | "acceptedActions"
  >,
): InlineEditState | null {
  if (inlineEdit === null) return null;
  if (
    inlineEdit.pendingMessageId !== null &&
    state.messages.some(
      (message) =>
        message.role === "user" &&
        message.messageId === inlineEdit.pendingMessageId,
    )
  ) {
    return null;
  }
  if (inlineEdit.pendingClientActionId === null) return inlineEdit;
  if (Object.hasOwn(state.pendingActions, inlineEdit.pendingClientActionId)) {
    return inlineEdit;
  }
  if (Object.hasOwn(state.acceptedActions, inlineEdit.pendingClientActionId)) {
    return null;
  }
  return {
    ...inlineEdit,
    pendingClientActionId: null,
    pendingMessageId: null,
  };
}

export function canModifyChatMessages(input: {
  readonly canAct: boolean;
  readonly state: Pick<
    ChatSessionState,
    | "runStatus"
    | "activeTurn"
    | "queue"
    | "pendingUserMessages"
    | "pendingActions"
  >;
}): boolean {
  if (!input.canAct) return false;
  // `runStatus` is the host-owned source of truth for an in-progress run and
  // covers windows `activeTurn` misses - the pre-turn `turnActivating` phase
  // (provider/worktree setup) and stop-during-activation both report a non-idle
  // `runStatus` while `activeTurn` is still null. Gate on it so edit/delete stay
  // disabled for the whole run, matching the composer's `runStatus`-driven UX.
  if (input.state.runStatus !== "idle") return false;
  if (input.state.activeTurn !== null) return false;
  if (input.state.queue.items.length > 0) return false;
  if (input.state.pendingUserMessages.length > 0) return false;
  return !Object.values(input.state.pendingActions).some(
    isPendingSendOrHistoryMutation,
  );
}

export function shouldGenerateChatTitleForSubmittedMessage(input: {
  readonly chat: ChatSessionState["chat"];
  readonly messages: ChatSessionState["messages"];
  readonly pendingUserMessages: ChatSessionState["pendingUserMessages"];
  readonly content: JsonContent;
}): boolean {
  if (input.chat?.isTitleEditedByUser === true) return false;
  const text = extractPlainTextFromComposerJSONContent(input.content).trim();
  if (text.length === 0) return false;
  if (input.pendingUserMessages.length > 0) return false;
  return !input.messages.some((message) => message.role === "user");
}

export function showRestoreResultToast(
  results: ReadonlyArray<RestoreResultEntry>,
): void {
  const counts = restoreResultCounts(results);
  const title = `${counts.restored} restored, ${counts.skipped} skipped, ${counts.failed} failed`;
  const details = restoreResultDetails(results);
  if (details === null) {
    toast.success(title);
    return;
  }
  const options = {
    description: "Some files were skipped or failed.",
    action: {
      label: "Show details",
      onClick: () => {
        toast.info("Restore details", { description: details });
      },
    },
  };
  if (counts.failed > 0) {
    reportableWarningToast(title, options, {
      title: "File restore incomplete",
      message: null,
      code: null,
      source: "File restore",
    });
    return;
  }
  toast.success(title, options);
}

interface RestoreResultCounts {
  readonly restored: number;
  readonly skipped: number;
  readonly failed: number;
}

function restoreResultCounts(
  results: ReadonlyArray<RestoreResultEntry>,
): RestoreResultCounts {
  return results.reduce<RestoreResultCounts>(
    (counts, result) => ({
      restored: counts.restored + (result.status === "restored" ? 1 : 0),
      skipped: counts.skipped + (result.status === "skipped" ? 1 : 0),
      failed: counts.failed + (result.status === "failed" ? 1 : 0),
    }),
    { restored: 0, skipped: 0, failed: 0 },
  );
}

function restoreResultDetails(
  results: ReadonlyArray<RestoreResultEntry>,
): string | null {
  const details = results.flatMap((result) =>
    result.status === "restored"
      ? []
      : [
          `${result.status}: ${result.filePath}${result.reason === null ? "" : ` (${result.reason})`}`,
        ],
  );
  if (details.length === 0) return null;
  return details.join("\n");
}

export function userMessageSenderForProfile(
  profile: AuthProfile | null,
): UserMessageSender | null {
  if (profile === null) return null;
  return {
    type: "user",
    userId: profile.userId,
  };
}

export function plainTextPromptContent(prompt: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: prompt.length === 0 ? [] : [{ type: "text", text: prompt }],
      },
    ],
  };
}

function isPendingSendOrHistoryMutation(action: PendingChatAction): boolean {
  return (
    action.action === "send" ||
    action.action === "deleteMessageSuffix" ||
    action.action === "editUserMessage"
  );
}

export function editablePersistentMessageId(
  message: ChatMessageModel,
): string | null {
  if (message.role !== "user") return null;
  if (message.persistentMessageId === null) return null;
  if (message.structuredContent === null) return null;
  return message.persistentMessageId;
}

export function forkableAssistantMessageId(
  message: ChatMessageModel,
): string | null {
  if (message.role !== "assistant") return null;
  if (message.completedAt === null) return null;
  if (message.runState !== null) return null;
  if (message.persistentMessageId === null) return null;
  if (isTransientLiveAssistantMessageId(message.persistentMessageId)) {
    return null;
  }
  return message.persistentMessageId;
}

// Fork boundary for a message containing a pending or resolved interview.
// Unlike `forkableAssistantMessageId` it does NOT require the turn to be
// finished (`completedAt`/`runState`) — question-level fork actions remain
// available while the assistant resumes after an answer. Still requires a
// stable, non-transient persistent id, since a transient live id is not a
// durable fork boundary.
export function forkableInterviewAssistantMessageId(
  message: ChatMessageModel,
): string | null {
  if (message.role !== "assistant") return null;
  if (message.persistentMessageId === null) return null;
  if (isTransientLiveAssistantMessageId(message.persistentMessageId)) {
    return null;
  }
  return message.persistentMessageId;
}

export function inlineEditLocksMessageActions(
  inlineEdit: InlineEditState | null,
  persistentMessageId: string,
): boolean {
  if (inlineEdit === null) return false;
  if (inlineEdit.targetMessageId === persistentMessageId) return false;
  return inlineEdit.dirty || inlineEdit.pendingClientActionId !== null;
}

export function inlineEditForPersistentMessage(
  inlineEdit: InlineEditState | null,
  persistentMessageId: string,
): InlineEditState | null {
  if (inlineEdit === null) return null;
  if (inlineEdit.targetMessageId !== persistentMessageId) return null;
  return inlineEdit;
}

export function inlineEditIsPending(
  inlineEdit: InlineEditState | null,
): boolean {
  return inlineEdit !== null && inlineEdit.pendingClientActionId !== null;
}

function inlineEditHasDraftContent(inlineEdit: InlineEditState): boolean {
  return (
    extractPlainTextFromComposerJSONContent(inlineEdit.currentContent).trim()
      .length > 0 || containsImageAtoms(inlineEdit.currentContent)
  );
}

export function chatMessageEditingForInlineEdit(input: {
  readonly editing: InlineEditState | null;
  readonly canModifyMessages: boolean;
  readonly editSettings: ChatRunSettings | null;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly currentEpicId: string;
  readonly onSnapshot: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): ChatMessageEditing | null {
  if (input.editing === null) return null;
  const editing = input.editing;
  const pending = inlineEditIsPending(editing);
  return {
    initialContent: editing.initialContent,
    currentContent: editing.currentContent,
    pending,
    canSubmit:
      input.canModifyMessages &&
      input.editSettings !== null &&
      editing.dirty &&
      inlineEditHasDraftContent(editing),
    slashProviderId: input.editSettings?.harnessId ?? DEFAULT_SLASH_PROVIDER_ID,
    mentionRoots: input.mentionRoots,
    currentEpicId: input.currentEpicId,
    onSnapshot: input.onSnapshot,
    onSubmit: input.onSubmit,
    onCancel: input.onCancel,
  };
}

export function chatTileCanAct(
  connectionStatus: string,
  canAct: boolean,
  profileAvailable: boolean,
): boolean {
  return connectionStatus === "open" && canAct && profileAvailable;
}

export function findPendingInterview(
  messages: ReadonlyArray<ChatMessageModel>,
  isHostPending: (blockId: string) => boolean,
): PendingInterviewView | null {
  // Walk from newest to oldest on BOTH axes. When a single assistant turn
  // contains multiple AskUserQuestion calls in sequence, the latest one is
  // the one currently awaiting input - older ones may still be visible as
  // "streaming" briefly while their resolution event is in flight.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (let j = message.segments.length - 1; j >= 0; j -= 1) {
      const segment = message.segments[j];
      if (segment.kind !== "interview") continue;
      if (segment.status !== "streaming") continue;
      if (!isHostPending(segment.id)) continue;
      return {
        blockId: segment.id,
        toolName: segment.toolName,
        title: segment.title,
        description: segment.description,
        questions: segment.questions,
        assistantMessageId: forkableInterviewAssistantMessageId(message),
      };
    }
  }
  return null;
}
