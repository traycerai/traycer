import { toast } from "sonner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunStatus } from "@traycer/protocol/host/agent/gui/subscribe";
import type { RestoreResultEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/schemas";
import type { AuthProfile } from "@/stores/auth/auth-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  ChatSessionState,
  PendingChatAction,
} from "@/stores/chats/chat-session-store";
import { isTransientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type { PendingInterviewView } from "./chat-tile-types";

/**
 * An in-progress message edit. The edit surface is the BOTTOM COMPOSER (the
 * message content is loaded into it as the draft, mirroring queue-item
 * editing), so this state only carries the routing target: which persisted
 * message the next composer submit replaces. `originalMessage` keeps the
 * edited row renderable if it drops out of the rendered list mid-edit.
 */
export interface InlineEditState {
  readonly targetMessageId: string;
  readonly originalMessage: ChatMessageModel;
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
      // The composer hosts BOTH edit modes (queue item and message), so
      // entering queue-edit mode must end an open message edit - the two
      // would otherwise fight over the same draft.
      return {
        ...state,
        editingQueueItemId: action.editingQueueItemId,
        inlineEdit:
          action.editingQueueItemId === null ? state.inlineEdit : null,
      };
    case "setConfirmingDeleteMessageId":
      return {
        ...state,
        confirmingDeleteMessageId: action.confirmingDeleteMessageId,
      };
    case "beginInlineEdit":
      // Symmetric exclusivity: starting a message edit ends queue-edit mode.
      return {
        ...state,
        inlineEdit: {
          targetMessageId: action.targetMessageId,
          originalMessage: action.originalMessage,
        },
        editingQueueItemId: null,
        confirmingDeleteMessageId: null,
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

export function canModifyChatMessages(input: {
  readonly canAct: boolean;
  /**
   * Worktree setup for this chat is provisioning (creating / setting-up),
   * derived from the setup card events - see {@link setupRowsInFlight}. During
   * this window the host-owned `runStatus`/pending flags stay non-idle for the
   * whole (slow) setup, which would otherwise keep edit disabled. Once the user
   * stops (the host settles the turn → `activeTurn === null`) we allow editing
   * the setup-triggering message so it can be fixed and re-run, even though the
   * setup script is still running. Gated on `activeTurn === null` so a genuine
   * agent turn (activeTurn set, e.g. before stop or after setup) stays blocked.
   */
  readonly setupInFlight: boolean;
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
  if (input.setupInFlight) return input.state.activeTurn === null;
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
    toast.warning(title, options);
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
      };
    }
  }
  return null;
}
