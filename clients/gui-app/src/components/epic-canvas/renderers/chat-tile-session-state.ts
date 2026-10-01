import { toast } from "sonner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatPendingInterviewState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { InterviewAnswerability } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { RestoreResultEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  Message,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import type { AuthProfile } from "@/stores/auth/auth-store";
import type { ChatMessageEditing } from "@/components/chat/chat-message";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  isWindowedTranscript,
  type ChatSessionState,
  type PendingChatAction,
} from "@/stores/chats/chat-session-store";
import { userRowPresence } from "@/stores/chats/transcript-window";
import {
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import { isTransientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { reportableWarningToast } from "@/lib/reportable-error-toast";
import type {
  PendingInterviewView,
  UnanswerableInterviewView,
} from "./chat-tile-types";

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
  /**
   * Identity of one editing SESSION, minted by `beginInlineEdit`.
   *
   * `targetMessageId` cannot stand in for it: cancelling an edit of message M
   * and reopening M is a new session with the same target, and an async submit
   * preparation left over from the first one would otherwise recognise the
   * second as its own and send it - with the first session's revert choices and
   * without the user ever pressing send again. Minted at the dispatch site
   * rather than in the reducer, so a double-invoked reducer cannot mint two.
   */
  readonly sessionId: string;
  readonly targetMessageId: string;
  readonly originalMessage: ChatMessageModel;
  readonly initialContent: JsonContent;
  readonly currentContent: JsonContent;
  /**
   * Which version of `currentContent` this is, counted from 0 at
   * `beginInlineEdit` and minted at the DISPATCH site like `sessionId`.
   *
   * It exists because a React update that has been queued but not yet committed
   * is invisible to everything outside React - including an awaited image
   * preparation deciding what to send. The send publishes the revision it
   * actually sent, and `markInlineEditPending` refuses to mark a different one,
   * so an acknowledgement can never close an editor over content that was never
   * put on the wire.
   */
  readonly revision: number;
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
      readonly sessionId: string;
      readonly targetMessageId: string;
      readonly originalMessage: ChatMessageModel;
      readonly initialContent: JsonContent;
    }
  | {
      readonly type: "updateInlineEditContent";
      readonly content: JsonContent;
      readonly revision: number;
    }
  | {
      readonly type: "markInlineEditPending";
      readonly targetMessageId: string;
      readonly clientActionId: string;
      readonly messageId: string;
      /** The `revision` whose content this send actually carried. */
      readonly sentRevision: number;
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
          sessionId: action.sessionId,
          targetMessageId: action.targetMessageId,
          originalMessage: action.originalMessage,
          initialContent: action.initialContent,
          currentContent: action.initialContent,
          revision: 0,
          dirty: false,
          pendingClientActionId: null,
          pendingMessageId: null,
        },
        confirmingDeleteMessageId: null,
      };
    case "updateInlineEditContent":
      if (state.inlineEdit === null) return state;
      // Deliberately NOT gated on `pendingClientActionId`. These ids are the
      // RAW record of a send, and a rejected dispatch is settled by the
      // projection (`projectInlineEditAgainstState`) rather than by an action -
      // so after a rejection the raw state still names the failed send while
      // the editor the user is looking at has been reopened. Refusing here
      // froze that editor for good: the correction never reached the reducer,
      // the retry's own mark was refused as a revision mismatch, and its
      // acknowledgement then closed an editor still tracking the first attempt.
      //
      // Freezing during a LIVE send is the hook's job and is done from the live
      // record (`inlineEditSendOutstanding`), which reads the projection - the
      // same state that reopens the editor - so it lifts exactly when the
      // editor does.
      return {
        ...state,
        inlineEdit: {
          ...state.inlineEdit,
          currentContent: action.content,
          revision: action.revision,
          dirty: true,
          pendingClientActionId: null,
          pendingMessageId: null,
        },
      };
    case "markInlineEditPending":
      if (state.inlineEdit?.targetMessageId !== action.targetMessageId) {
        return state;
      }
      // The mark has to describe the content that was SENT. A send prepared
      // asynchronously can be overtaken by an edit the user made while it was
      // in flight, and marking THAT one pending hands it to an acknowledgement
      // which closes the editor - discarding, with no trace, text the user can
      // still see. Refusing leaves the newer edit open and dirty, which is what
      // it is: unsent.
      if (state.inlineEdit.revision !== action.sentRevision) return state;
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

export {
  chatActivityIndicator,
  composerTurnStatus,
  resolvedTurnStatus,
  type ChatActivityIndicator,
  type ComposerTurnStatus,
} from "@/stores/chats/chat-run-activity";

/**
 * Whether the transcript contains this user row AT ALL - hydrated or not.
 *
 * `state.messages` cannot answer it on the windowed line. It is a bounded,
 * evictable slice, so "the replacement row is not there" conflates "the edit
 * never landed" with "the reader has scrolled away from it", and the second is
 * the ordinary steady state for an edit made a few turns ago.
 *
 * The SKELETON can: it is one entry per row for the whole chat, and a user
 * row's id is its message id. Scanned rather than indexed because this runs
 * only while an inline edit is outstanding - a rare, short-lived state - so the
 * cost is paid in a case that barely occurs, and building a per-render index of
 * a 20k-row skeleton to answer one membership question would not be.
 *
 * A sparse skeleton (chunks still streaming) can answer `false` for a row that
 * exists. That degrades to the pre-existing behaviour rather than to a new
 * failure: the action-ledger checks below still hold in the near term, and the
 * answer becomes durable as soon as the skeleton completes.
 */
function transcriptHasUserRow(
  state: Pick<ChatSessionState, "messages" | "transcriptWindow">,
  messageId: string,
): boolean {
  if (
    state.messages.some(
      (message) => message.role === "user" && message.messageId === messageId,
    )
  ) {
    return true;
  }
  return state.transcriptWindow.skeleton.some(
    (entry) => entry !== undefined && entry.rowId === messageId,
  );
}

export function normalizeInlineEditForSession(
  inlineEdit: InlineEditState | null,
  state: Pick<
    ChatSessionState,
    "messages" | "pendingActions" | "acceptedActions" | "transcriptWindow"
  >,
): InlineEditState | null {
  if (inlineEdit === null) return null;
  // The DURABLE success signal, and the reason it is not `state.messages`.
  //
  // An accepted edit settles twice over: its replacement row is persisted, and
  // its accepted-action entry is recorded. Both of those are transient in
  // `state` - the row is evictable once the reader scrolls past it, and the
  // accepted entry is pruned - so once both have gone this function fell
  // through to the last branch, which KEEPS the edit alive with its ids
  // cleared. `displayedMessages` then re-appended the stale `originalMessage`
  // as an unplaced row and other message actions stayed locked, for an edit
  // that succeeded and was rendered correctly minutes earlier.
  //
  // The last branch is still right for what it was written for - a REJECTED
  // dispatch, which must return the composer to an editable state - and that
  // is precisely why the success case has to be answered from something that
  // does not expire.
  if (
    inlineEdit.pendingMessageId !== null &&
    transcriptHasUserRow(state, inlineEdit.pendingMessageId)
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
    | "backgroundItems"
    | "turnInProgress"
    | "pendingUserMessages"
    | "pendingActions"
  >;
}): boolean {
  if (!input.canAct) return false;
  // Narrowed via `resolvedTurnStatus`, not the raw `runStatus`: the raw value
  // also reads "running" while visible background work outlives the settled
  // turn (Bash `run_in_background` / a subagent / Monitor), which would keep
  // edit/delete hidden indefinitely with no turn to wait for - the composer
  // and restore gating already read the narrowed value for the same reason.
  // The narrowed signal still covers the windows `activeTurn` misses: the
  // pre-turn `turnActivating` phase (provider/worktree setup) and
  // stop-during-activation both keep the host's `turnInProgress` true until
  // the run truly unwinds.
  if (
    resolvedTurnStatus(
      input.state,
      composerTurnStatus(input.state.runStatus),
    ) !== null
  ) {
    return false;
  }
  if (input.state.activeTurn !== null) return false;
  // Queued items do NOT gate history mutation: they carry only
  // content/sender/settings, survive the rewrite untouched, and later send
  // against the new head (the host dropped its QUEUE_NOT_EMPTY guard for the
  // same reason). In-flight sends below still gate - those are actions whose
  // target head is already on the wire.
  if (input.state.pendingUserMessages.length > 0) return false;
  return !Object.values(input.state.pendingActions).some(
    isPendingSendOrHistoryMutation,
  );
}

/**
 * Is this send the FIRST thing a person has said in this chat, and therefore
 * the one a generated title should come from?
 *
 * The transcript half of that question cannot be answered from `messages` on
 * the windowed line: it holds what is HYDRATED, so a chat long enough to have
 * been windowed can present no user row and re-trigger title generation on a
 * chat that has had a title for weeks. The SKELETON describes every row, which
 * is what a whole-transcript question needs.
 *
 * Both sources are consulted rather than one replacing the other. The hydrated
 * rows are checked first because they are authoritative and always available -
 * including on the legacy line, where there is no skeleton at all - and the
 * skeleton then answers the case they cannot.
 *
 * `unknown` (a skeleton still streaming) is folded into "do not generate",
 * deliberately. The two failures are not symmetric: re-titling an established
 * chat rewrites something the user has been reading for weeks, while a missed
 * title needs `rowCount > 0` on a mid-stream skeleton - which a genuinely new
 * chat, whose `rowCount` is 0, never has.
 */
export function shouldGenerateChatTitleForSubmittedMessage(input: {
  readonly chat: ChatSessionState["chat"];
  readonly messages: ChatSessionState["messages"];
  readonly pendingUserMessages: ChatSessionState["pendingUserMessages"];
  readonly transcriptWindow: ChatSessionState["transcriptWindow"];
  readonly transcriptDerived: ChatSessionState["transcriptDerived"];
  readonly content: JsonContent;
}): boolean {
  if (input.chat?.isTitleEditedByUser === true) return false;
  const text = extractPlainTextFromComposerJSONContent(input.content).trim();
  if (text.length === 0) return false;
  if (input.pendingUserMessages.length > 0) return false;
  if (input.messages.some((message) => message.role === "user")) return false;
  if (!isWindowedTranscript(input)) return true;
  return userRowPresence(input.transcriptWindow) === "absent";
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

/**
 * The chat's most recent completed-turn fork boundary, or `null` when none
 * exists yet — the agent has never replied, or its only assistant rows are
 * still live. This selects an explicit reply boundary; latest-checkpoint
 * forks instead let the destination host choose from its available history.
 */
export function latestForkableAssistantMessageId(
  messages: ReadonlyArray<ChatMessageModel>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const messageId = forkableAssistantMessageId(messages[index]);
    if (messageId !== null) return messageId;
  }
  return null;
}

/**
 * The same boundary, brought forward past one the host already named.
 *
 * The windowed line reads that boundary off `chatTranscriptDerived`, which the
 * host recomputes per SNAPSHOT - while the UI shows a completed turn from a
 * LIVE `turnStateChanged` frame. Between the two there is a window in which the
 * boundary still names the PREVIOUS turn, so a fork silently omits the turn the
 * user just watched finish. Two clocks, and only one of them ticks live.
 *
 * The repair is local because the evidence is local: the turn that just
 * completed is in the live tail this client is holding. So the scan looks only
 * at what follows `known` in display order and answers `null` otherwise - it
 * can move the boundary FORWARD and never backward, which is what makes it safe
 * to prefer over the host's value. `known: null` means the host has no boundary
 * at all, so any forkable row here is newer than nothing.
 *
 * `null` when `known` is not in `messages`: that is a boundary outside the
 * hydrated window, and nothing here can order against it. It is also not the
 * failing case - a turn completing live sits immediately after the one the last
 * snapshot named, and the tail carrying it carries both.
 */
export function forkableAssistantMessageIdAfter(
  messages: ReadonlyArray<ChatMessageModel>,
  known: string | null,
): string | null {
  const knownIndex =
    known === null
      ? -1
      : messages.findIndex((message) => message.persistentMessageId === known);
  if (knownIndex === -1 && known !== null) return null;
  for (let index = messages.length - 1; index > knownIndex; index--) {
    const messageId = forkableAssistantMessageId(messages[index]);
    if (messageId !== null) return messageId;
  }
  return null;
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
  readonly fallbackToGlobalMentionRoots: boolean;
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
      inlineEditHasDraftContent(editing),
    slashProviderId: input.editSettings?.harnessId ?? DEFAULT_SLASH_PROVIDER_ID,
    mentionRoots: input.mentionRoots,
    fallbackToGlobalMentionRoots: input.fallbackToGlobalMentionRoots,
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
        questions: segment.questions,
        assistantMessageId: forkableInterviewAssistantMessageId(message),
      };
    }
  }
  return null;
}

// Stable identity for the (overwhelmingly common) "nothing is stuck" answer.
// `findUnanswerableInterviews` runs off `renderedMessages`, which changes on
// every streaming token, so returning a fresh `[]` would churn the composer
// memo chain on every token - the exact regression
// chat-tile-composer-rerender.test.tsx pins.
const NO_UNANSWERABLE_INTERVIEWS: ReadonlyArray<UnanswerableInterviewView> = [];

/**
 * Host-pending interviews with no answerable card in this transcript.
 *
 * `findPendingInterview` renders a card only for a `streaming` interview block,
 * so a host-pending blockId whose block is already settled - or missing from
 * the transcript entirely - yields nothing to answer while the host keeps
 * rejecting sends. This is the disjoint complement of `findPendingInterview`
 * over the host's pending set: every id here has no streaming block, so the two
 * can never name the same block.
 *
 * There is no transient window to debounce ON THE LEGACY LINE. The host
 * broadcasts an interview's `blockDelta` before the `interviewRequested` frame
 * that makes it pending (chat-session-manager `handleRuntimeEvent`), and
 * hydration surfaces detached waits in the same snapshot that carries their
 * persisted blocks - so a pending id without a streaming block is genuinely
 * stuck, not mid-arrival.
 *
 * ## Why the windowed line needs `hostAnswerability`
 *
 * That whole argument rests on the transcript being WHOLE. Once `messages` is
 * the hydrated window, "no streaming block here" stops meaning "no streaming
 * block": the question can be perfectly answerable and merely cold - its row
 * past the inline tail, or a detached wait the eager range has not reached -
 * and this would offer to error out a question the user could have answered.
 * A block delta arriving for an EVICTED row is dropped rather than seated, so
 * even the flush-before-publish ordering above stops closing the gap.
 *
 * So on that line the host judges it, and the three states are distinct:
 *
 * - **an entry with an ordinal** - answerable, merely cold. Not listed here;
 *   the store hydrates that row and the card appears.
 * - **an entry with `ordinal: null`** - no row renders it. Genuinely stuck,
 *   listed, and dismissal is the right affordance.
 * - **no entry** - the host has not judged this id (it became pending after
 *   the snapshot). Not listed: an unjudged question is not evidence of one.
 *
 * @param hostAnswerability The host's judgement, or `null` on the legacy line -
 * where absence in `messages` IS the answer and no second opinion exists.
 */
export function findUnanswerableInterviews(
  messages: ReadonlyArray<ChatMessageModel>,
  hostPendingInterviews: ReadonlyArray<ChatPendingInterviewState>,
  hostAnswerability: ReadonlyArray<InterviewAnswerability> | null,
): ReadonlyArray<UnanswerableInterviewView> {
  if (hostPendingInterviews.length === 0) return NO_UNANSWERABLE_INTERVIEWS;
  const streamingBlockIds = new Set<string>();
  for (const message of messages) {
    for (const segment of message.segments) {
      if (segment.kind !== "interview") continue;
      if (segment.status !== "streaming") continue;
      streamingBlockIds.add(segment.id);
    }
  }
  // Only the ids the host judged UNRENDERABLE. Both other states - judged and
  // placeable, or not judged at all - fall outside this set, which is why the
  // check below is membership rather than a lookup with a default.
  const hostStuckBlockIds =
    hostAnswerability === null
      ? null
      : new Set(
          hostAnswerability
            .filter((entry) => entry.ordinal === null)
            .map((entry) => entry.blockId),
        );
  const unanswerable: UnanswerableInterviewView[] = [];
  for (const interview of hostPendingInterviews) {
    if (streamingBlockIds.has(interview.blockId)) continue;
    if (hostStuckBlockIds !== null && !hostStuckBlockIds.has(interview.blockId))
      continue;
    unanswerable.push({
      blockId: interview.blockId,
      requestedAt: interview.requestedAt,
    });
  }
  if (unanswerable.length === 0) return NO_UNANSWERABLE_INTERVIEWS;
  // Oldest first: the earliest dangling question is the one that has been
  // blocking the chat, so it reads first in the notice.
  unanswerable.sort((left, right) => left.requestedAt - right.requestedAt);
  return unanswerable;
}

/**
 * The context chip's usage number.
 *
 * `liveTurnUsage` takes precedence over the persisted value so the chip shows
 * live in-flight numbers during a turn and carries the final usage forward
 * across the gap between `turn.completed` and the next snapshot.
 *
 * The persisted half has two sources, one per line. On the windowed line
 * `messages` holds what is HYDRATED, not what exists, so the backwards scan
 * below terminates at the window's edge - and the chip would read blank on
 * exactly the chats long enough to have been windowed in the first place. The
 * host ships the whole-transcript fold for that reason.
 *
 * The gap-bridging argument survives the swap: the host memoizes `derived` on
 * the transcript view's identity and re-emits it from all the same
 * `broadcastSnapshot()` call sites, so `latestAssistantUsage` refreshes at
 * exactly the moments a legacy peer's `messages` array does.
 */
export function selectContextUsage(
  state: Pick<
    ChatSessionState,
    "liveTurnUsage" | "messages" | "transcriptDerived"
  >,
): TokenUsage | null {
  if (state.liveTurnUsage !== null) return state.liveTurnUsage;
  // Deliberately not `?? findLastAssistantUsage(...)`: `latestAssistantUsage:
  // null` is the real answer for a chat where no assistant row has reported
  // usage yet, and the chip's empty form is what that should render. Falling
  // through would put the O(history) scan back on every fresh chat, and let a
  // hydrated row contradict the host on a chat where the host can see further.
  if (isWindowedTranscript(state)) {
    return state.transcriptDerived.latestAssistantUsage;
  }
  return findLastAssistantUsage(state.messages);
}

function findLastAssistantUsage(
  messages: ReadonlyArray<Message>,
): TokenUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.usage !== null) {
      return message.usage;
    }
  }
  return null;
}
