import {
  addAcceptedAction,
  confirmAcceptedSendByMessageId,
  noticeCarriesOnlyCopy,
  unrecoverableSendNotice,
  pruneAcceptedActions,
  withoutResolvedAcceptedQueueCancellations,
  reconcileQueueChange,
  reconcileSnapshotChange,
  reconcileTurnSettled,
  sweepStalePendingActions,
  SEND_RESTORED_NOTICE_CODE,
  turnSettledFromStatus,
  withoutPendingAction,
  deadSendAccountClauses,
  displacedRestorationNotice,
  EMPTY_DEAD_SEND_ACCOUNT,
  worktreeSweepFor,
  type DeadSendAccount,
  type WorktreeSweepAccount,
  type WorktreePartitionFn,
} from "@/stores/chats/chat-queue-reconciler";
import {
  appendOptimisticQueuedItem,
  mergeQueueWithOptimisticQueuedItems,
  optimisticQueuedItemId,
  removeOptimisticQueuedItemByClientActionId,
  removeOptimisticQueuedItemByMessageId,
} from "@/stores/chats/optimistic-queue";
import {
  BUDGET_PLANE_IDS,
  createGenerationGuard,
  guardHandler,
  type GenerationGuard,
  type RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import { NO_TRANSCRIPT_BASELINE } from "@/stores/chats/chat-announcements";
import { TRANSCRIPT_RANGE_MAX_BYTES } from "@traycer/protocol/persistence/chat-transcript/read-range";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";
import type {
  ChatAccumulatedFileChangeSummary,
  ChatIndexChange,
  ChatRangeResponse,
  ChatTranscriptDerived,
  InterviewAnswerability,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  createImageWitnessStore,
  type ImageWitnessStore,
} from "@/stores/chats/image-witness-store";
import { createRecoveryLedger } from "@/stores/chats/recovery-ledger";
import {
  applyIndexChange,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  appendLiveRecords,
  bodyInvalidatingOrdinals,
  emptyTranscriptWindow,
  evictTranscriptWindowToBudget,
  hydratedRecords,
  holdsActiveTurnAssistantMessage,
  hydratedRowContext,
  isActiveTurnStreamingEcho,
  isTailHydrated,
  mapWindowMessages,
  planTranscriptHydration,
  recordSharingOrdinals,
  streamWindowMessage,
  touchTranscriptRange,
  transcriptWindowChargedBytes,
  updateWindowMessage,
  TRANSCRIPT_WINDOW_MAX_BYTES,
  type OrdinalRange,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { ensureProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import {
  chatHolderId,
  chatSessionChargeBytes,
  chatWholeSetSliceBytes,
  evictChatWindowForAccountant,
  legacyTranscriptResidencyBytes,
  type ChatWholeSetSlices,
} from "@/stores/replica-memory/chat-window-budget";
import type {
  StreamFlushCoordinator,
  StreamFlushLease,
} from "@/stores/chats/stream-flush-coordinator";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import { useInterviewDraftStore } from "@/stores/composer/interview-draft-store";
import {
  chatStreamErrorNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  liveChatCompletionAcknowledgementMatches,
  liveChatCompletionAcknowledgements,
  type LiveChatCompletionAcknowledgementTransport,
} from "@/lib/notifications/live-chat-completion-acknowledgements";
import {
  readStagedWorktreeIntent,
  stagedDispatchDisplacement,
  stagedWorktreeIntentAwaitsDispatchFrom,
  stagedWorktreeIntentAwaitsDispatchOutcome,
  partitionSweptIntent,
  stagedWorktreeIntentIsSuspended,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { transientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import type {
  ChatStreamCallbacks,
  ChatStreamClient,
} from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createLegacyChatTranscriptAdapter,
  type LegacyChatTranscriptSnapshotEvent,
} from "@/stores/chats/legacy-chat-transcript-adapter";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import type { Attachment } from "@/lib/composer/types";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import { collectAnnotationImageHashes } from "@/lib/browser-view/annotation/browser-annotation-record";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { addWithFifoEviction } from "@/lib/bounded-set";
import type {
  RuntimeApprovalDecision,
  RuntimeEvent,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import { AUTH_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  accumulateTurnContent,
  finalizeStreamingActionBlocks,
  reopenStreamingSubagentBlocks,
  type FinalizedActionStatus,
} from "@traycer/protocol/host/agent/gui/agent-runtime-accumulator";
import {
  applyInterviewSettlement,
  type InterviewSettlementSource,
} from "@traycer/protocol/host/agent/gui/interview-settlement";
import type {
  HeldManagedCommandUpdate,
  ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import type {
  BackgroundItem,
  ChatAccess,
  ChatAccumulatedFileChange,
  ChatActiveTurn,
  ChatApprovalState,
  ChatErrorNotice,
  ChatFileEditApprovalState,
  ChatPendingInterviewState,
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatQueueDeliveryPolicy,
  ChatQueueState,
  ChatRunSettings,
  ChatRunStatus,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  WorktreeBinding,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { RestoreResultEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  PermissionMode,
  TokenUsage,
} from "@traycer/protocol/persistence/epic/foundation";
import type {
  Chat,
  ChatEvent,
  ContentBlock,
  ImageResolutionEntry,
  InterviewAnswer,
  Message,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import { latestAssistantAuthFailureTurnKey } from "@traycer/protocol/persistence/chat-transcript/provider-auth-failure";
import { v4 as uuidv4 } from "uuid";
import { create, type StoreApi, type UseBoundStore } from "zustand";

export type ChatStreamClientHandle = Pick<
  ChatStreamClient,
  | "sendAction"
  | "close"
  | "sameTurnSteeringProtocolSupported"
  // The two windowed READS.
  | "requestTranscriptRange"
  | "requestResnapshot"
> &
  Partial<
    Pick<ChatStreamClient, "interviewSettlementActionsProtocolSupported">
  >;

export type ChatStreamClientFactory = (
  epicId: string,
  chatId: string,
  callbacks: ChatStreamCallbacks,
) => ChatStreamClientHandle;

type ChatOwnerActionFrame = Exclude<
  ChatSubscribeClientFrame,
  { readonly kind: "ping" }
>;
type ChatActionAckFrame = Parameters<ChatStreamCallbacks["onActionAck"]>[0];
type ChatSnapshotFrame = Parameters<ChatStreamCallbacks["onSnapshot"]>[0];
type ChatWindowedSnapshotFrame = Parameters<
  ChatStreamCallbacks["onWindowedSnapshot"]
>[0];
/** The windowed snapshot fields a LATER frame can supersede. */
type DeferredWindowedSnapshotAux = Pick<
  ChatWindowedSnapshotFrame["snapshot"],
  | "queue"
  | "runStatus"
  | "activeTurn"
  | "turnInProgress"
  | "backgroundItems"
  | "pendingApprovals"
  | "pendingFileEditApprovals"
  | "pendingInterviews"
  | "worktreeBinding"
  | "missingWorktreePaths"
  | "managedCommands"
  | "heldUpdates"
>;

function deferredWindowedSnapshotAuxOf(
  snapshot: ChatWindowedSnapshotFrame["snapshot"],
): DeferredWindowedSnapshotAux {
  return {
    queue: snapshot.queue,
    runStatus: snapshot.runStatus,
    activeTurn: snapshot.activeTurn,
    turnInProgress: snapshot.turnInProgress,
    backgroundItems: snapshot.backgroundItems,
    pendingApprovals: snapshot.pendingApprovals,
    pendingFileEditApprovals: snapshot.pendingFileEditApprovals,
    pendingInterviews: snapshot.pendingInterviews,
    worktreeBinding: snapshot.worktreeBinding,
    missingWorktreePaths: snapshot.missingWorktreePaths,
    managedCommands: snapshot.managedCommands,
    heldUpdates: snapshot.heldUpdates,
  };
}
type ChatSessionSetState = StoreApi<ChatSessionState>["setState"];
type ChatSessionGetState = StoreApi<ChatSessionState>["getState"];
type SendActionInput = {
  readonly set: ChatSessionSetState;
  readonly get: ChatSessionGetState;
  readonly frame: ChatOwnerActionFrame;
  readonly pending: PendingChatActionSeed;
  readonly pendingUserMessage: PendingUserMessage | null;
};

/**
 * What a send hands back to the composer if it never lands - the pre-submit document plus the
 * annotation cards that left with it.
 */
export interface ChatSendRestore {
  readonly content: JsonContent;
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
}

export interface PendingUserMessage {
  readonly clientActionId: string;
  readonly messageId: string;
  readonly content: JsonContent;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly sender: UserMessageSender;
  readonly settings: ChatRunSettings;
  readonly timestamp: number;
  /**
   * Pre-submit composer document (no crop atoms) plus its annotation cards. Used when a settled turn
   * never recorded the send, so restore does not inline the wire image atoms or drop the records.
   */
  readonly restore: ChatSendRestore;
  /** The billing context this send was stamped with at dispatch. */
  readonly accountContext: AccountContext;
  /** The delivery the send was dispatched with. */
  readonly deliveryPolicy: ChatQueueDeliveryPolicy | null;
  /**
   * The staged worktree choice this send consumed at dispatch, carried here so it OUTLIVES the
   * accepted ack.
   */
  readonly restoreWorktreeIntent: WorktreeIntent | null;
}

/** The durable outbox tuple a retry may requeue. */
export interface InterviewDeliveryRetryIdentity {
  readonly blockId: string;
  readonly settlementId: string;
  readonly deliveryId: string;
  readonly generation: number;
}

export interface PendingChatAction {
  readonly clientActionId: string;
  readonly action: ChatOwnerActionFrame["kind"];
  /** Queue row targeted by a queue mutation; populated for queueCancel. */
  readonly queueItemId: string | null;
  // For `interviewAnswer` / `interviewError`, the interview block this action targets; `null` for
  // every other action.
  readonly interviewBlockId: string | null;
  /** Immutable retry identity; null for all non-delivery-retry actions. */
  readonly interviewDeliveryRetry: InterviewDeliveryRetryIdentity | null;
  readonly messageId: string | null;
  readonly restore: ChatSendRestore | null;
  readonly sender: UserMessageSender | null;
  readonly settings: ChatRunSettings | null;
  /** See {@link PendingUserMessage.accountContext}. */
  readonly accountContext: AccountContext | null;
  /** See {@link PendingUserMessage.deliveryPolicy}. */
  readonly deliveryPolicy: ChatQueueDeliveryPolicy | null;
  /** Workspace selection consumed when a send goes on the wire. */
  readonly restoreWorktreeIntent: WorktreeIntent | null;
  /** Render-only copy of the consumed worktree choice. */
  readonly displayWorktreeIntent: WorktreeIntent | null;
  /**
   * A live `messageAccepted` sighting retained across transcript-window
   * eviction until the action ack copies it to `AcceptedChatAction`.
   */
  readonly messageConfirmedByHost: boolean;
  /**
   * Staging revision immediately after the send consumes its selection. A
   * rejection restores only when the user has made no newer picker choice.
   */
  readonly createdAt: number;
  /** The connection epoch the action's frame was dispatched on (stamped by `sendAction`). */
  readonly connectionEpoch: number;
}

/**
 * A pending action as its creator builds it - `sendAction` stamps the
 * `connectionEpoch` centrally at dispatch time.
 */
export type PendingChatActionSeed = Omit<PendingChatAction, "connectionEpoch">;

export interface FailedSendRestorationState {
  readonly clientActionId: string;
  readonly content: JsonContent;
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
  readonly reason: string;
  /**
   * Whether the path that created this slot ALREADY said the reason on a surface the user can see.
   * Each restored prompt's account is spoken exactly once.
   */
  readonly stated: boolean;
  /** The same account, told for a prompt that could NOT reach the composer. */
  readonly displacedReason: string;
}

export interface LiveAssistantMessage {
  readonly turnId: string;
  readonly sender: Extract<Message, { readonly role: "assistant" }>["sender"];
  readonly blocks: ReadonlyArray<ContentBlock>;
  /** `ChatActiveTurn.startedAt` - set once at turn-start and never updated. */
  readonly startedAt: number;
  readonly blocksVersion: number;
  readonly imageResolutions: ReadonlyArray<{
    readonly messageId: string;
    readonly entry: ImageResolutionEntry;
  }>;
  /** Message owner of the currently streamed blocks' image resolutions. */
  readonly imageResolutionOwnerMessageId?: string | null;
  readonly imageResolutionsVersion: number;
  readonly timestamp: number;
  /**
   * Reasoning effort + service tier the turn is running with, mirrored from `ChatActiveTurn` so the
   * live row and its persisted `AssistantMessage` form carry the same per-turn run metadata.
   */
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
}

export interface SentChatMessageAction {
  readonly clientActionId: string;
  readonly messageId: string;
}

export interface EditUserMessageInput {
  readonly targetMessageId: string;
  readonly content: JsonContent;
  readonly sender: UserMessageSender;
  readonly settings: ChatRunSettings;
  readonly revertFileChanges: boolean;
  // When reverting, also revert the artifact changes in scope (the dialog's checked-by-default "Also
  // revert N artifacts" opt-out). Ignored when revertFileChanges is false.
  readonly revertArtifacts: boolean;
}

export interface AcceptedChatAction {
  readonly clientActionId: string;
  readonly action: ChatOwnerActionFrame["kind"];
  /** Carries an accepted queueCancel projection until host queue truth lands. */
  readonly queueItemId: string | null;
  // Carried over from the originating `PendingChatAction` so an accepted-but- unresolved interview
  // answer/skip keeps gating its card. `null` for every non-interview action.
  readonly interviewBlockId: string | null;
  readonly interviewDeliveryRetry: InterviewDeliveryRetryIdentity | null;
  readonly messageId: string | null;
  readonly acceptedAt: number;
  /**
   * Structured prompt content carried over from the originating `PendingChatAction` when the host
   * accepts a `send`.
   */
  readonly restore: ChatSendRestore | null;
  /** The rest of the recovery tuple, for `send` records only. */
  readonly sender: UserMessageSender | null;
  readonly settings: ChatRunSettings | null;
  readonly accountContext: AccountContext | null;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy | null;
  readonly restoreWorktreeIntent: WorktreeIntent | null;
  /** See {@link PendingChatAction.displayWorktreeIntent}. */
  readonly displayWorktreeIntent: WorktreeIntent | null;
  /** The connection this send was DISPATCHED on, carried across the accepted ack. */
  readonly connectionEpoch: number;
  /**
   * Whether the HOST has ever confirmed this send - reported it in the transcript, or parked in the
   * queue.
   */
  readonly confirmedByHost: boolean;
}

/** Discriminated restore-flow state. */
export type ChatRestoreSlot =
  | {
      readonly kind: "in-flight";
      readonly checkpointId: string;
      readonly restoringUserId: string;
      readonly restoringHostId: string;
      readonly startedAt: number;
      /** Connection epoch the `restoreStarted` frame arrived on. */
      readonly connectionEpoch: number;
    }
  | {
      readonly kind: "progressing";
      readonly checkpointId: string;
      readonly restoringUserId: string;
      readonly restoringHostId: string;
      readonly startedAt: number;
      readonly processedCount: number;
      readonly totalCount: number;
      /** See the `in-flight` variant. */
      readonly connectionEpoch: number;
    }
  | {
      readonly kind: "completed";
      readonly checkpointId: string;
      readonly finishedAt: number;
      readonly results: ReadonlyArray<RestoreResultEntry>;
    };

type MissingWorktreePathsUpdate =
  | ReadonlyArray<string>
  | ((current: ReadonlyArray<string>) => ReadonlyArray<string>);

/**
 * The chat record MINUS its transcript spine. `ChatSessionState` keeps the transcript in its own
 * `messages`/`events` fields, and the snapshot's `chat` carries the same arrays a second time.
 */
export type ChatSessionRecord = Omit<Chat, "messages" | "events">;

/** Drops the transcript arrays off a snapshot's chat record. */
function chatRecordWithoutTranscript(chat: Chat): ChatSessionRecord {
  const { messages: _messages, events: _events, ...record } = chat;
  return record;
}

export interface ChatSessionState {
  readonly epicId: string;
  readonly chatId: string;
  readonly connectionStatus: StreamConnectionStatus;
  /**
   * Set when the host terminates the `chat.subscribe` stream with a `fatalError` (e.g.
   * `CHAT_INVALID` / `CHAT_NOT_VISIBLE`, collapsed to code `UNAUTHORIZED` on the wire).
   */
  readonly fatalClose: FatalErrorDetails | null;
  readonly snapshotLoaded: boolean;
  /**
   * The connection whose authoritative snapshot established the CURRENT transcript, or
   * `NO_TRANSCRIPT_BASELINE` before the first one lands.
   */
  readonly transcriptBaselineEpoch: number;
  /**
   * Bumped whenever a range response seated rows the reader SCROLLED to. The third way transcript
   * data reaches this client, and the one `transcriptBaselineEpoch` cannot describe.
   */
  readonly transcriptHydrationSequence: number;
  /**
   * What each hydrated row renders WITH, by row id. The host projects a row against whole history; a
   * range serves that row's records alone.
   */
  readonly transcriptRowContext: Readonly<Record<string, TranscriptRowContext>>;
  readonly chat: ChatSessionRecord | null;
  readonly access: ChatAccess | null;
  readonly messages: ReadonlyArray<Message>;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly queue: ChatQueueState;
  /**
   * Host-owned chat run state (`idle | running | stopping`). The single source of truth the GUI
   * reads for its in-progress indicators (response row, composer stop button, sidebar/tab marker).
   */
  readonly runStatus: ChatRunStatus;
  readonly activeTurn: ChatActiveTurn | null;
  /**
   * Whether the tab's negotiated `chat.subscribe` protocol version understands the
   * `after_safe_point` explicit-steer delivery policy (host handshake minor >= 5).
   */
  readonly steerProtocolSupported: boolean;
  /** `chat.subscribe@1.7` support for detached interview delivery retries. */
  readonly interviewDeliveryRetryProtocolSupported: boolean;
  /** The host's own `isTurnInProgress()`: is a turn genuinely active or activating right now? */
  readonly turnInProgress: boolean | undefined;
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingInterviews: ReadonlyArray<ChatPendingInterviewState>;
  readonly accumulatedFileChanges: ReadonlyArray<ChatAccumulatedFileChange>;
  /** The transcript index and whichever bodies are hydrated, on the windowed line. */
  readonly transcriptWindow: TranscriptWindow;
  /**
   * Whole-transcript folds the host computed because a windowed client cannot: the pinned-todo
   * stack, the latest usage, the fork boundary, and the restorable setup interruption (whose event
   */
  readonly transcriptDerived: ChatTranscriptDerived | null;
  /**
   * How many files this chat has touched, per the windowed snapshot - what the accumulated-changes
   * panel paints its collapsed header from before any summary chunk lands.
   */
  readonly accumulatedFileChangeCount: number;
  /**
   * Rows rewritten while their span was EVICTED, so the rewrite was dropped. Provenance, not
   * content: the body itself is recovered by the next hydration.
   */
  readonly coldRewrittenMessageIds: ReadonlySet<string>;
  /** An ordinal a pending transcript JUMP needs hydrated, or `null`. */
  readonly jumpTargetOrdinal: number | null;
  /** The accumulated-change SUMMARIES, assembled from the chunk frames. */
  readonly accumulatedFileChangeSummaries: ReadonlyArray<ChatAccumulatedFileChangeSummary>;
  /** Whether any chunk of the CURRENT summary generation has been accepted. */
  readonly accumulatedSummaryGenerationSeated: boolean;
  /** Whether a replacement generation is being assembled off-screen right now. */
  readonly accumulatedSummaryAssemblyStarted: boolean;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  /**
   * The shells this chat created, whatever state they are in - not a subset of {@link
   * backgroundItems}, since a shell outlives the turn that started it.
   */
  readonly managedCommands: ReadonlyArray<ManagedCommand>;
  /** The subset of {@link managedCommands} whose last output a committed Stop fence is holding back. */
  readonly heldUpdates: ReadonlyArray<HeldManagedCommandUpdate>;
  /**
   * In-flight per-item background stops, keyed by `taskId` → the `clientActionId` of the stop frame
   * that was sent.
   */
  readonly pendingBackgroundStops: Readonly<Record<string, string>>;
  /**
   * The in-flight "Stop all" background request (its `clientActionId`), or null. Used only while the
   * stop-all frame is outstanding before its ack; the matching ack clears it.
   */
  readonly pendingBackgroundStopAll: {
    readonly clientActionId: string;
    readonly taskIds: ReadonlySet<string>;
  } | null;
  /**
   * The in-flight session-scoped background stop (the escalation for commands carrying
   * `individualStopUnavailable`), or null.
   */
  readonly pendingBackgroundSessionStop: {
    readonly clientActionId: string;
    readonly awaitingTurnEnd: boolean;
    readonly turnId: string | null;
  } | null;
  readonly restore: ChatRestoreSlot | null;
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly errorNotices: ReadonlyArray<ChatErrorNotice>;
  /** Notices the toast layer has actually SHOWN, by `clientActionId`. */
  readonly deliveredNoticeActionIds: ReadonlySet<string>;
  /** Block ids this session has already OPENED a subagent/workflow card for. */
  readonly openedSubagentCardBlockIds: ReadonlySet<string>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  readonly currentComposerSettings: ChatRunSettings | null;
  readonly liveAssistantMessage: LiveAssistantMessage | null;
  /**
   * Live token usage for the most recent turn, populated from `usage.updated` runtime events the
   * host emits during streaming and CARRIED through `turn.completed` (with the final event's usage
   */
  readonly liveTurnUsage: TokenUsage | null;
  /**
   * Local-only worktree binding projected from the host's SQLite layer. `null` until the host
   * decides a binding for this owner.
   */
  readonly worktreeBinding: WorktreeBinding | null;

  /**
   * `workspacePath`s of binding entries whose effective run directory is missing on disk, computed
   * host-side and carried on the snapshot + every `worktreeStateChanged` frame.
   */
  readonly missingWorktreePaths: ReadonlyArray<string>;

  /**
   * Overwrite {@link missingWorktreePaths} from an out-of-band fresh recompute - the chat tile's
   * on-focus / pane-activation `worktree.getBinding` re-query, which recomputes the missing set
   */
  refreshMissingWorktreePaths: (update: MissingWorktreePathsUpdate) => void;

  /**
   * Re-subscribe after a fatal close. Tears down the existing stream and opens a fresh
   * `chat.subscribe`, clearing `fatalClose` and `snapshotLoaded`.
   */
  /** See the implementation - names the ordinal a pending jump is waiting on. */
  requestTranscriptOrdinal: (ordinal: number | null) => void;
  retry: () => void;
  /**
   * Which ordinals the transcript viewport is currently showing, from the timeline's viewability
   * pass - the second obligation `planTranscriptHydration` folds in (the first is the tail).
   */
  reportVisibleTranscriptRange: (range: OrdinalRange | null) => void;
  sendMessage: (input: {
    readonly content: JsonContent;
    readonly sender: UserMessageSender;
    readonly settings: ChatRunSettings;
    readonly attachments: ReadonlyArray<Attachment>;
    readonly deliveryPolicy: ChatQueueDeliveryPolicy;
    readonly restore: ChatSendRestore;
  }) => SentChatMessageAction | null;
  /**
   * Sends the initial handoff message reusing its pre-minted ids (shared with the host turn-overlap
   * idempotency gate).
   */
  sendSeededUserMessage: (input: {
    readonly messageId: string;
    readonly clientActionId: string;
    readonly content: JsonContent;
    readonly sender: UserMessageSender;
    readonly settings: ChatRunSettings;
  }) => SentChatMessageAction | null;
  deleteMessageSuffix: (fromMessageId: string) => string | null;
  editUserMessage: (
    input: EditUserMessageInput,
  ) => SentChatMessageAction | null;
  revertFileChanges: (
    fromMessageId: string | null,
    filePaths: ReadonlyArray<string> | null,
    revertArtifacts: boolean,
  ) => string | null;
  stopTurn: () => string | null;
  stopBackgroundItem: (taskId: string) => string | null;
  stopAllBackgroundItems: () => string | null;
  stopBackgroundSession: () => string | null;
  pauseQueue: () => string | null;
  resumeQueue: () => string | null;
  queueEdit: (queueItemId: string, content: JsonContent) => string | null;
  queueCancel: (queueItemId: string) => string | null;
  queueReorder: (
    queueItemId: string,
    beforeQueueItemId: string | null,
  ) => string | null;
  queueSteerNow: (
    queueItemId: string,
    newSettings: ChatRunSettings | null,
  ) => string | null;
  queueAbortSteer: (queueItemId: string) => string | null;
  queueSettingsUpdate: (
    queueItemId: string,
    settings: ChatRunSettings,
  ) => string | null;
  updateActivePermissionMode: (permissionMode: PermissionMode) => string | null;
  /**
   * Narrow in-flight profile switch, parallel to `updateActivePermissionMode`: tells the host the
   * chat's CURRENT work should run on `profileId` (of `harnessId` - profile ids are harness-scoped).
   */
  updateActiveProfile: (
    harnessId: GuiHarnessId,
    profileId: string | null,
  ) => string | null;
  // Live-mirror: atomically re-stamp every non-transient pending queued item with the current
  // toolbar settings so the host's stored copy stays current for auto-send.
  restampQueuedItemSettings: (
    settings: ChatRunSettings,
    excludeQueueItemId: string | null,
  ) => void;
  approvalDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => string | null;
  fileEditApprovalDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => string | null;
  restoreCheckpoint: (
    checkpointId: string,
    revertArtifacts: boolean,
  ) => string | null;
  interviewAnswer: (
    blockId: string,
    answers: ReadonlyArray<InterviewAnswer>,
  ) => string | null;
  interviewSkip: (
    blockId: string,
    reason: string,
    draftAnswers: ReadonlyArray<InterviewAnswer> | undefined,
  ) => string | null;
  interviewDeliveryRetry: (
    identity: InterviewDeliveryRetryIdentity,
  ) => string | null;
  ackAcceptedAction: (clientActionId: string) => void;
  ackFailedSendRestoration: (clientActionId: string) => void;
  /**
   * Record that a notice reached the screen. Called by the toast layer, which
   * is the only thing that knows - see {@link ChatSessionState.deliveredNoticeActionIds}.
   */
  markNoticeDelivered: (clientActionId: string) => void;
  /**
   * Settle the restoration slot by STATING its prompt instead of handing it to the composer - see
   * {@link displacedRestorationNotice}.
   */
  stateFailedSendRestoration: (clientActionId: string) => void;
  takeSetupFailedRestoration: (messageId: string) => JsonContent | null;
  setCurrentComposerSettings: (settings: ChatRunSettings) => void;
  dispose: () => void;
}

export interface ChatSessionStoreOptions {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly userId: string | null;
  /**
   * Injected so this factory never touches `window`. Production passes
   * `createRendererRuntimeEnvironment()`; tests pass a fake.
   */
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: ChatStreamClientFactory;
  /** Decides when buffered `blockDelta` batches are folded into the store. */
  readonly streamFlushCoordinator: StreamFlushCoordinator;
  readonly onAuthError: (() => void) | null;
  /** Fired when the chat stream delivers a recoverable `code: "auth"` error frame */
  readonly onProviderAuthError: (() => void) | null;
}

/** Per-session tracker for error notices already surfaced as toasts. */
export interface DeliveredNoticeTracker {
  readonly notices: WeakSet<ChatErrorNotice>;
  readonly clientActionIds: Set<string>;
  /** Delivery state for notices the ring never evicts (see `noticeCarriesOnlyCopy`). */
  readonly retainedClientActionIds: Set<string>;
}

export interface ChatSessionStoreHandle {
  readonly epicId: string;
  readonly chatId: string;
  readonly userId: string | null;
  readonly store: UseBoundStore<StoreApi<ChatSessionState>>;
  readonly deliveredNotices: DeliveredNoticeTracker;
  /** Completed restores already surfaced as toasts. */
  readonly deliveredRestoreCompletionKeys: Set<string>;
  /** Per-surface visibility report feeding the stream-flush coordinator's tiered flush rate. */
  readonly setSurfaceVisibility: (surfaceId: string, visible: boolean) => void;
  readonly clearSurfaceVisibility: (surfaceId: string) => void;
  readonly dispose: () => void;
}

export function isChatRunInProgress(runStatus: ChatRunStatus): boolean {
  return runStatus === "running" || runStatus === "stopping";
}

/**
 * How long an unanswered range or resnapshot request is waited on before its dedup latch is
 * released and the plan re-issued.
 */
export const HYDRATION_REQUEST_TIMEOUT_MS = 30_000;

/** How many sent-and-unanswered range requests keep their staleness record. */
export { MAX_OUTSTANDING_HYDRATION_REQUESTS } from "@/stores/chats/recovery-ledger";

/**
 * How long a chunked delivery may go quiet before it is treated as stalled rather than slow.
 * Longer than {@link HYDRATION_REQUEST_TIMEOUT_MS} on purpose.
 */
export const STREAM_COMPLETION_TIMEOUT_MS = 45_000;

/** How many times a stalled stream may be restarted within one epoch. */
export const MAX_WATCHDOG_RESTREAMS_PER_EPOCH = 3;

const EMPTY_QUEUE: ChatQueueState = { status: "idle", items: [] };

function chatRunSettingsEqual(a: ChatRunSettings, b: ChatRunSettings): boolean {
  // Keyed by every `ChatRunSettings` field via `satisfies`: adding a field to the type forces an
  // entry here (compile error otherwise), so the comparison can't silently ignore a new field.
  const fieldsEqual = {
    harnessId: a.harnessId === b.harnessId,
    model: a.model === b.model,
    permissionMode: a.permissionMode === b.permissionMode,
    reasoningEffort: a.reasoningEffort === b.reasoningEffort,
    serviceTier: a.serviceTier === b.serviceTier,
    agentMode: a.agentMode === b.agentMode,
    // `??` guards a pre-profile queued item (the field is missing, not `null`, on an old serialized
    // `ChatRunSettings`) so it still compares equal to a fresh ambient commit instead of spuriously
    profileId: (a.profileId ?? null) === (b.profileId ?? null),
  } satisfies Record<keyof ChatRunSettings, boolean>;
  return Object.values(fieldsEqual).every((equal) => equal);
}

function nullableChatRunSettingsEqual(
  a: ChatRunSettings | null,
  b: ChatRunSettings | null,
): boolean {
  if (a === null || b === null) return a === b;
  return chatRunSettingsEqual(a, b);
}

export const ACCEPTED_CHAT_ACTION_RETENTION_MS = 5 * 60 * 1_000;
export const MAX_ACCEPTED_CHAT_ACTION_RECORDS = 64;
/** Cap the per-chat error-notice ring. */
export const MAX_ERROR_NOTICE_RECORDS = 32;
/** Cap the delivered-notice client-action-id tracker. */
export const MAX_DELIVERED_CLIENT_ACTION_IDS = MAX_ERROR_NOTICE_RECORDS * 4;

/** How many opened subagent/workflow card block ids a session remembers. */
export const MAX_OPENED_SUBAGENT_CARD_BLOCK_IDS = 256;
/** Bounds string-key retention while comfortably covering recent restores. */
export const MAX_DELIVERED_RESTORE_COMPLETIONS = 32;

/**
 * Append a reconciler's notice DELTA onto the store's ring. Returns the ring unchanged (same
 * reference) for an empty delta, so a pass with nothing to say never touches the slice.
 */
function appendErrorNoticeDelta(
  notices: ReadonlyArray<ChatErrorNotice>,
  delta: ReadonlyArray<ChatErrorNotice>,
  delivered: ReadonlySet<string>,
): ReadonlyArray<ChatErrorNotice> {
  return delta.reduce(
    (next, notice) => appendErrorNotice(next, notice, delivered),
    notices,
  );
}

function appendErrorNotice(
  notices: ReadonlyArray<ChatErrorNotice>,
  next: ChatErrorNotice,
  /** Ids the toast layer has already shown - see the `SEND_RESTORED` rule. */
  delivered: ReadonlySet<string>,
): ReadonlyArray<ChatErrorNotice> {
  // Before that change an eviction cost a pointer and the row still held the words; now it is the
  // whole loss, so these records are exempt below.
  if (noticeCarriesOnlyCopy(next)) {
    const alreadyStated = notices.some(
      (notice) =>
        noticeCarriesOnlyCopy(notice) &&
        notice.clientActionId === next.clientActionId,
    );
    // Never capped, and never counted against ordinary history below.
    return alreadyStated ? notices : [...notices, next];
  }
  // A `SEND_RESTORED` notice is replayable ON PURPOSE - it may arrive while the pane is unfocused,
  // and the qualifications it carries are the only warning that the restored prompt will resend
  if (
    next.code === SEND_RESTORED_NOTICE_CODE &&
    next.clientActionId !== null &&
    !delivered.has(next.clientActionId)
  ) {
    return [...notices, next];
  }
  // The cap applies to ORDINARY history only.
  const isProtected = (notice: ChatErrorNotice): boolean =>
    noticeCarriesOnlyCopy(notice) ||
    (notice.code === SEND_RESTORED_NOTICE_CODE &&
      notice.clientActionId !== null &&
      !delivered.has(notice.clientActionId));
  const ordinaryCount = notices.filter((notice) => !isProtected(notice)).length;
  if (ordinaryCount < MAX_ERROR_NOTICE_RECORDS) {
    return [...notices, next];
  }
  const evictable = notices.findIndex((notice) => !isProtected(notice));
  if (evictable === -1) return [...notices, next];
  return [
    ...notices.slice(0, evictable),
    ...notices.slice(evictable + 1),
    next,
  ];
}

/**
 * Re-stage the worktree intent a `send`/`editUserMessage` pending captured, unless the user has
 * staged a newer selection since (revision guard).
 */
/** The two fields a revision-guarded re-stage needs. */
export interface StagedWorktreeIntentSource {
  readonly restoreWorktreeIntent: WorktreeIntent | null;
  /** Whose hand-back this is. */
  readonly clientActionId: string;
}

/**
 * A swept action's claim on the staged pick. It carries the action id because a sweep hand-back is
 * a PICK hand-back for one specific action, and a pick may only go back to the action that took it
 */
interface SweptWorktreeClaimant extends StagedWorktreeIntentSource {
  readonly clientActionId: string;
}

/**
 * Keep the background-stop slices in lockstep with the running-only list: a task that has left it
 * has settled, so its Stop is no longer in flight.
 */
function backgroundStopSlices(
  state: ChatSessionState,
  nextBackgroundItems: ChatSessionState["backgroundItems"],
): Pick<
  ChatSessionState,
  "pendingBackgroundStops" | "pendingBackgroundStopAll"
> {
  return {
    pendingBackgroundStops: reconcileBackgroundStops(
      state.pendingBackgroundStops,
      nextBackgroundItems,
    ),
    pendingBackgroundStopAll: reconcileBackgroundStopAll(
      state.pendingBackgroundStopAll,
      nextBackgroundItems,
    ),
  };
}

/**
 * Decide the slot between claimants that a reconnect killed together. The restored PROMPT is
 * terminal, and terminal either way.
 */
/** The statement a rejected action earns. */
function rejectionNotice(input: {
  readonly frame: {
    readonly reason: string | null;
    readonly code: string | null;
    readonly clientActionId: string;
  };
  readonly pending: PendingChatAction | null;
  readonly displaced: boolean;
  /**
   * This send's account, gathered BEFORE the restore ran - `null` when the rejection is not a
   * restorable send.
   */
  readonly account: DeadSendAccount | null;
}): ChatErrorNotice {
  const reason = input.frame.reason ?? "Action rejected.";
  const pending = input.pending;
  if (
    input.displaced &&
    pending !== null &&
    pending.action === "send" &&
    pending.restore !== null
  ) {
    return unrecoverableSendNotice({
      clientActionId: input.frame.clientActionId,
      content: pending.restore.content,
      circumstance: `A message was not accepted (${reason.replace(/\.$/, "")})`,
      account: input.account ?? EMPTY_DEAD_SEND_ACCOUNT,
    });
  }
  // A rejected send that WINS the slot is restored, so it never reaches `unrecoverableSendNotice` -
  // this is the surface that speaks for it, and `handedBack` is true because its surviving binding
  return {
    code: input.frame.code ?? "ACTION_REJECTED",
    message: `${reason}${
      input.account === null || input.displaced
        ? ""
        : deadSendAccountClauses(input.account, true)
    }`,
    severity: "warning",
    clientActionId: input.frame.clientActionId,
  };
}

/**
 * This rejection's account, or `null` when the frame is not a restorable send and so has nothing
 * to say.
 */
function rejectionEvidence(
  pending: PendingChatAction | null,
  worktree: WorktreeSweepAccount,
  superseded: boolean,
  currentSettings: ChatRunSettings | null,
): DeadSendAccount | null {
  if (pending === null || pending.action !== "send") return null;
  if (pending.restore === null) return null;
  return {
    worktree: { ...worktree, superseded },
    sentSettings: pending.settings,
    currentSettings,
    sentAccountContext: pending.accountContext,
    currentAccountContext: useAccountContextStore.getState().accountContext,
    sentDeliveryPolicy: pending.deliveryPolicy,
  };
}

/** The slot a rejected SEND claims, or `null` when this rejection claims none. */
function rejectionRestoration(input: {
  readonly state: ChatSessionState;
  readonly pending: PendingChatAction | null;
  readonly frame: {
    readonly clientActionId: string;
    readonly reason: string | null;
  };
  readonly account: DeadSendAccount | null;
}): FailedSendRestorationState | null {
  const { state, pending, frame } = input;
  if (state.failedSendRestoration !== null) return null;
  if (pending?.action !== "send" || pending.restore === null) {
    return null;
  }
  return {
    clientActionId: frame.clientActionId,
    content: pending.restore.content,
    browserAnnotations: pending.restore.browserAnnotations,
    reason: `${frame.reason ?? "Message was not accepted."}${
      input.account === null ? "" : deadSendAccountClauses(input.account, true)
    }`,
    displacedReason: `${frame.reason ?? "Message was not accepted."}${
      input.account === null ? "" : deadSendAccountClauses(input.account, false)
    }`,
    // This path owns a notice and says it there, so the ack stays quiet.
    stated: true,
  };
}

/**
 * Drop the accepted records a settling pass - snapshot or live turn-state - just declared dead.
 * `Record` spread is additive, so a removal needs doing rather than expressing.
 */
function withoutSettledAcceptedActions(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  settled: ReadonlySet<string>,
): Readonly<Record<string, AcceptedChatAction>> {
  if (settled.size === 0) return acceptedActions;
  return Object.fromEntries(
    Object.entries(acceptedActions).filter(([id]) => !settled.has(id)),
  );
}

/** ...and the optimistic queue rows that were standing in for them. */
function queueWithoutSettledAcceptedSends(
  queue: ChatQueueState,
  settled: ReadonlySet<string>,
): ChatQueueState {
  if (settled.size === 0) return queue;
  return [...settled].reduce(
    (next, clientActionId) =>
      removeOptimisticQueuedItemByClientActionId(next, clientActionId),
    queue,
  );
}

/** Whether the restoration slot is already promised to a DIFFERENT action's prompt. */
function restorationSlotHeldByOther(
  restoration: FailedSendRestorationState | null,
  clientActionId: string,
): boolean {
  return restoration !== null && restoration.clientActionId !== clientActionId;
}

function restoreOneWorktreeIntent(
  restoredPrompt: StagedWorktreeIntentSource | null,
  sweptClaimants: ReadonlyArray<SweptWorktreeClaimant | undefined>,
  stagingKey: WorktreeStagingKey,
  /** Who the restoration slot is promised to right now. */
  restoration: FailedSendRestorationState | null,
): boolean {
  if (restoredPrompt !== null) {
    // Reported ONLY for the restored prompt.
    return restoreStagedWorktreeIntent(restoredPrompt, stagingKey);
    // A prompt that HAD a binding and did not get it back because a sweep ran mid-flight comes back
    // unbound through no decision of the user's - the one refusal worth saying out loud.
  }
  // OWNERSHIP, not merely "a consumption is outstanding".
  const owed = sweptClaimants.find(
    (claimant) =>
      claimant !== undefined &&
      !restorationSlotHeldByOther(restoration, claimant.clientActionId) &&
      claimant.restoreWorktreeIntent !== null &&
      stagedWorktreeIntentAwaitsDispatchFrom(
        stagingKey,
        claimant.clientActionId,
      ),
  );
  restoreStagedWorktreeIntent(owed ?? null, stagingKey);
  return false;
}

/** Put a consumed worktree pick back, unless the user has since said otherwise. */
function restoreStagedWorktreeIntent(
  source: StagedWorktreeIntentSource | null,
  stagingKey: WorktreeStagingKey,
): boolean {
  if (source === null || source.restoreWorktreeIntent === null) return false;
  if (!stagedWorktreeIntentAwaitsDispatchOutcome(stagingKey)) return false;
  // Tested against THIS intent, not the mark's entries - the mark describes whichever dispatch
  // consumed last, which need not be this one.
  const { survivors } = partitionSweptIntent(
    stagingKey,
    source.restoreWorktreeIntent,
  );
  if (survivors === null) return false;
  // A hand-back, NOT a user pick - so it may only clear its own dispatch's records.
  useWorktreeIntentStagingStore
    .getState()
    .restoreIntentForDispatch(stagingKey, survivors, source.clientActionId);
  return true;
}

const liveChatSessionStores = new Set<{
  getState: () => ChatSessionState;
}>();

function collectPendingAnnotationImageHashes(): ReadonlyArray<string> {
  const records: BrowserAnnotationRecord[] = [];
  for (const sessionStore of liveChatSessionStores) {
    const state = sessionStore.getState();
    for (const pending of Object.values(state.pendingActions)) {
      if (pending.restore !== null) {
        records.push(...pending.restore.browserAnnotations);
      }
    }
    for (const message of state.pendingUserMessages) {
      records.push(...message.restore.browserAnnotations);
    }
    if (state.failedSendRestoration !== null) {
      records.push(...state.failedSendRestoration.browserAnnotations);
    }
  }
  return collectAnnotationImageHashes(records);
}

registerExtraImageRootSource({
  hashes: collectPendingAnnotationImageHashes,
});

export function createChatSessionStore(
  options: ChatSessionStoreOptions,
): ChatSessionStoreHandle {
  return createChatSessionStoreWithNotificationDependencies(options, {
    completionAcknowledgements: liveChatCompletionAcknowledgements,
    appLocalNotifications: useAppLocalNotificationsStore,
  });
}

export interface ChatSessionNotificationDependencies {
  readonly completionAcknowledgements: LiveChatCompletionAcknowledgementTransport;
  readonly appLocalNotifications: Pick<
    typeof useAppLocalNotificationsStore,
    "getState"
  >;
}

/**
 * The six slices charged to the chat-windows plane alongside the transcript. THE OBLIGATION: every
 * write to one of these must be followed by a budget re-settle.
 */
function chatSlicesOf(state: ChatSessionState): ChatWholeSetSlices {
  return {
    queue: state.queue,
    pendingApprovals: state.pendingApprovals,
    pendingFileEditApprovals: state.pendingFileEditApprovals,
    pendingInterviews: state.pendingInterviews,
    backgroundItems: state.backgroundItems,
    managedCommands: state.managedCommands,
  };
}

export function createChatSessionStoreWithNotificationDependencies(
  options: ChatSessionStoreOptions,
  notificationDependencies: ChatSessionNotificationDependencies,
): ChatSessionStoreHandle {
  const notificationUserId = options.userId;
  const memory = ensureProcessMemoryRuntime(options.environment);
  const holderId = chatHolderId(options.hostId, options.epicId, options.chatId);
  let recencyStamp = 0;
  let disposed = false;
  let streamClient: ChatStreamClientHandle | null = null;
  // Assigned synchronously inside the `create()` initializer below, where the
  // delta buffer lives; read by the handle's surface-visibility rollup.
  let flushLease: StreamFlushLease | null = null;
  /**
   * The counter half of this store's stream guard - shared, so the check that keeps a superseded
   * socket's frames out of the live store exists once rather than once per plane.
   */
  const streamGenerations = createGenerationGuard();
  /**
   * What every stream handler is actually guarded on: a live store AND a current generation.
   * `disposed` is deliberately kept as its own conjunct rather than argued redundant.
   */
  const streamGuard: GenerationGuard = {
    current: () => streamGenerations.current(),
    next: () => streamGenerations.next(),
    isCurrent: (candidate) =>
      !disposed && streamGenerations.isCurrent(candidate),
  };
  let fatalCloseNotificationGeneration: number | null = null;
  // `activeTurn` is cleared as soon as a stream fatally closes.
  let fatalCloseTurnId: string | null = null;
  let unsubscribeLiveCompletionAcknowledgements = (): void => undefined;
  // Bumped whenever the connection the pendings were dispatched on is gone: a transport
  // `reconnecting`/`closed` status, or a stream-client replacement (`retry`).
  let connectionEpoch = 0;
  const surfaceVisibility = new Map<string, boolean>();

  const pushSurfaceVisibility = (): void => {
    if (flushLease === null) return;
    const visible =
      surfaceVisibility.size === 0 ||
      Array.from(surfaceVisibility.values()).some((value) => value);
    flushLease.setVisible(visible);
  };

  // This chat's staging slot, and the question both reconcile passes have to be able to ask about
  // it.
  const ownerStagingKey: WorktreeStagingKey = {
    surface: "owner",
    hostId: options.hostId,
    epicId: options.epicId,
    ownerKind: "chat",
    ownerId: options.chatId,
  };
  /**
   * The staging revision each restored prompt's hand-back left behind, so a later displacement can
   * take that pick back WITHOUT touching one anybody else owns.
   */
  const stagingRevisionByRestoredAction = new Map<string, number>();
  const recordStagedRevisionFor = (
    source: StagedWorktreeIntentSource | null,
    handedBack: boolean,
  ): void => {
    // ONLY on a write, and only AFTER it.
    if (!handedBack || source === null) return;
    stagingRevisionByRestoredAction.set(
      source.clientActionId,
      useWorktreeIntentStagingStore.getState().revisionByKey[
        worktreeStagingKeyString(ownerStagingKey)
      ] ?? 0,
    );
  };
  const worktreePartition: WorktreePartitionFn = (intent) =>
    partitionSweptIntent(ownerStagingKey, intent);

  const canSendAction = (get: () => ChatSessionState): boolean => {
    if (disposed) return false;
    if (streamClient === null) return false;
    const state = get();
    return state.connectionStatus === "open" && state.access?.canAct === true;
  };

  const sendAction = (input: SendActionInput): string | null => {
    if (!canSendAction(input.get)) return null;
    const client = streamClient;
    if (client === null) return null;
    const nextPendingUser = input.pendingUserMessage;
    const pending: PendingChatAction = { ...input.pending, connectionEpoch };
    input.set((state) => ({
      pendingActions: {
        ...state.pendingActions,
        [pending.clientActionId]: pending,
      },
      // Dedupe by `messageId` so a real send for an already-seeded optimistic
      // message replaces the seed in place instead of rendering it twice.
      pendingUserMessages:
        nextPendingUser === null
          ? state.pendingUserMessages
          : [
              ...state.pendingUserMessages.filter(
                (message) => message.messageId !== nextPendingUser.messageId,
              ),
              nextPendingUser,
            ],
    }));
    client.sendAction(input.frame);
    return input.pending.clientActionId;
  };

  // Phase two of the session-scoped background stop: the actual frame.
  const sendBackgroundSessionStopFrame = (input: {
    readonly set: SendActionInput["set"];
    readonly get: SendActionInput["get"];
  }): string | null => {
    const clientActionId = uuidv4();
    const frame: ChatOwnerActionFrame = {
      kind: "stopBackgroundSession",
      hasBinaryPayload: false,
      epicId: options.epicId,
      chatId: options.chatId,
      clientActionId,
    };
    const sent = sendAction({
      set: input.set,
      get: input.get,
      frame,
      pending: basicPending(clientActionId, "stopBackgroundSession"),
      pendingUserMessage: null,
    });
    input.set(() => ({
      pendingBackgroundSessionStop:
        sent === null
          ? null
          : { clientActionId: sent, awaitingTurnEnd: false, turnId: null },
    }));
    return sent;
  };

  // The graceful downgrade for a confirmed session stop whose gated command settled on its own: stop
  // the remaining rows individually so wakeups stay scheduled (the confirmation's count excluded
  const stopRemainingItemsIndividually = (
    get: ChatSessionGetState,
    items: readonly BackgroundItem[],
  ): void => {
    for (const item of items) {
      if (item.kind === "wakeup") continue;
      get().stopBackgroundItem(item.taskId);
    }
  };

  // Deliberately state-based rather than edge-based: called after every turn-state, action-ack AND
  // snapshot reduction, so a phase-one turn stop that races the turn's natural end (its `stop`
  const maybeDispatchPendingBackgroundSessionStop = (
    set: ChatSessionSetState,
    get: ChatSessionGetState,
  ): void => {
    const state = get();
    let pending = state.pendingBackgroundSessionStop;
    if (pending === null || !pending.awaitingTurnEnd) return;
    const activeTurnId = state.activeTurn?.turnId ?? null;
    if (pending.turnId === null && activeTurnId !== null) {
      // Confirmed during the request-to-turn activation window, before the turn had an id. Latch the
      // first id observed so a LATER turn still reads as different and cancels the escalation.
      pending = { ...pending, turnId: activeTurnId };
      const latched = pending;
      set(() => ({ pendingBackgroundSessionStop: latched }));
    }
    if (
      pending.turnId !== null &&
      activeTurnId !== null &&
      activeTurnId !== pending.turnId
    ) {
      // A different turn than the one the user confirmed against is running (a queued turn started
      // meanwhile, possibly while disconnected).
      set(() => ({ pendingBackgroundSessionStop: null }));
      return;
    }
    const turnActive = state.turnInProgress ?? state.activeTurn !== null;
    if (turnActive) return;
    const items = state.backgroundItems ?? [];
    if (items.length === 0) {
      // Everything settled with the turn - the session stop has nothing left
      // to do.
      set(() => ({ pendingBackgroundSessionStop: null }));
      return;
    }
    if (
      !items.some(
        (item) =>
          item.kind === "command" && item.individualStopUnavailable !== null,
      )
    ) {
      // The gated command settled on its own while the turn wound down, so the reason for killing the
      // provider session is gone.
      set(() => ({ pendingBackgroundSessionStop: null }));
      stopRemainingItemsIndividually(get, items);
      return;
    }
    sendBackgroundSessionStopFrame({ set, get });
  };

  const closeStreamClient = (): void => {
    if (streamClient === null) return;
    const client = streamClient;
    streamClient = null;
    streamGuard.next();
    // A replaced client is a new connection - the old one's `closed` status
    // event is suppressed by the generation guard, so bump here too.
    connectionEpoch += 1;
    client.close();
  };

  const store = create<ChatSessionState>()((set, get) => {
    // `blockDelta` coalescing. Deltas accumulate here and are folded into a single `set()` per
    // coordinator tick (one animation frame in production) instead of one `set()` per token.
    let bufferedDeltas: RuntimeEvent[] = [];

    // `providers.list` nudge driven by the DURABLE auth-failure signal: an error block tagged `code:
    // "auth"` persisted on the latest assistant row (a trailing user row - e.g.
    let nudgedAuthErrorTurnId: string | null = null;

    /** Act on the whole-transcript answer, whichever line produced it. */
    const nudgeProviderAuthFailure = (turnKey: string | null): void => {
      if (options.onProviderAuthError === null) return;
      if (turnKey === null) return;
      if (nudgedAuthErrorTurnId === turnKey) return;
      nudgedAuthErrorTurnId = turnKey;
      options.onProviderAuthError();
    };

    const applyBufferedDeltas = (): void => {
      if (bufferedDeltas.length === 0) return;
      // HELD, not dropped, while a windowed snapshot waits for its tail.
      if (deferredWindowedSnapshot !== null) return;
      const batch = bufferedDeltas;
      bufferedDeltas = [];
      if (disposed) return;
      set((state) => {
        // Fold the batch through the same reducer used for a single delta, threading the accumulated state
        // so later deltas see earlier ones.
        let merged: ChatSessionState = state;
        for (const event of batch) {
          const partial = applyBlockDelta(merged, event, imageWitnesses);
          if (partial === merged || Object.keys(partial).length === 0) {
            continue;
          }
          merged = { ...merged, ...partial };
        }
        const pendingActions = withoutSupersededInterviewDeliveryRetryActions(
          merged.pendingActions,
          merged.messages,
          merged.liveAssistantMessage,
          null,
        );
        const acceptedActions = withoutSupersededInterviewDeliveryRetryActions(
          merged.acceptedActions,
          merged.messages,
          merged.liveAssistantMessage,
          null,
        );
        return pendingActions === merged.pendingActions &&
          acceptedActions === merged.acceptedActions
          ? merged
          : { ...merged, pendingActions, acceptedActions };
      });
      evictWindowAfterInPlaceGrowth();
      // A streaming turn is under-read for its duration: block deltas defer measurement, and
      // `evictChatWindowForAccountant` settles before deciding.
      recencyStamp = memory.stampChatRecency();
    };

    /** Run the fresh tier's eviction after an in-place rewrite grew it. */
    function evictWindowAfterInPlaceGrowth(): void {
      if (disposed) return;
      const state = get();
      if (!isWindowedTranscript(state)) return;
      if (state.transcriptWindow.hydratedBytes <= TRANSCRIPT_WINDOW_MAX_BYTES) {
        return;
      }
      const evicted = evictTranscriptWindowToBudget(
        state.transcriptWindow,
        TRANSCRIPT_WINDOW_MAX_BYTES,
        visibleTranscriptRange,
        requiredHydrationOrdinalsOf(state),
      );
      if (evicted === state.transcriptWindow) return;
      publishWindowedTranscript(evicted, null);
    }

    const lease = options.streamFlushCoordinator.register({
      flush: applyBufferedDeltas,
      hasPending: () => bufferedDeltas.length > 0,
    });
    flushLease = lease;

    const clearBufferedDeltas = (): void => {
      bufferedDeltas = [];
    };

    // Synchronous pre-frame flush used by consuming frames. The coordinator's
    // armed tick then no-ops for this store (`hasPending` is false).
    const flushBlockDeltas = (): void => {
      applyBufferedDeltas();
    };

    /** The authoritative-snapshot fold, shared by BOTH lines. */
    const applyAuthoritativeSnapshot = (
      frame: ChatSnapshotFrame,
      extra: Partial<ChatSessionState> | null,
      authFailureTurnKey: string | null,
    ): void => {
      if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
        return;
      }
      nudgeProviderAuthFailure(authFailureTurnKey);
      flushBlockDeltas();
      // Pendings dispatched on an earlier connection never see their ack, so the snapshot drops them
      // (below).
      const sweep = sweepStalePendingActions(
        get().pendingActions,
        connectionEpoch,
      );
      // Every swept id came from this same `pendingActions` snapshot, so the lookup is always present.
      const sweptPendings = get().pendingActions;
      const sweptWorktreeIntents = [...sweep.sweptActionIds].map(
        (sweptId) => sweptPendings[sweptId],
      );
      let restoredWorktreeIntentForSnapshot: StagedWorktreeIntentSource | null =
        null;
      set((state) => {
        const previousTurnId = snapshotPreviousTurnId(
          state.activeTurn,
          state.liveAssistantMessage,
          frame.snapshot.activeTurn,
        );
        const messages = messagesForTurnStateChange(
          frame.snapshot.chat.messages,
          {
            previousTurnId,
            nextTurnId: frame.snapshot.activeTurn?.turnId ?? null,
          },
        );
        // A changed persisted tuple is an authoritative host-side update (for example `agent.configure`)
        // and must replace the live picker.
        const authoritativeSettingsChanged =
          state.chat === null ||
          !nullableChatRunSettingsEqual(
            state.chat.settings,
            frame.snapshot.chat.settings,
          );
        // What a RESEND would run under after this snapshot lands. The drift statement compares against
        // this, not the persisted tuple: a local pick the user just made is what the composer will send.
        const nextComposerSettings = authoritativeSettingsChanged
          ? frame.snapshot.chat.settings
          : state.currentComposerSettings;
        const now = Date.now();
        const pending = reconcileSnapshotChange({
          pendingActions: sweep.pendingActions,
          pendingUserMessages: state.pendingUserMessages,
          messages,
          queue: frame.snapshot.queue,
          failedSendRestoration: state.failedSendRestoration,
          connectionEpoch,
          currentSettings: nextComposerSettings,
          currentAccountContext:
            useAccountContextStore.getState().accountContext,
          worktreePartition,
          acceptedActions: state.acceptedActions,
          nowMs: now,
        });
        // `reconcileSnapshotChange` only settles sends still awaiting their ack.
        const settled = reconcileTurnSettled(
          turnSettledFromStatus(
            frame.snapshot.turnInProgress,
            frame.snapshot.runStatus,
          ),
          {
            pendingActions: pending.pendingActions,
            pendingUserMessages: pending.pendingUserMessages,
            messages,
            queue: frame.snapshot.queue,
            failedSendRestoration: pending.failedSendRestoration,
            currentSettings: nextComposerSettings,
            currentAccountContext:
              useAccountContextStore.getState().accountContext,
            worktreePartition,
            acceptedActions: state.acceptedActions,
          },
        );
        restoredWorktreeIntentForSnapshot =
          settled.restoredWorktreeIntent ?? pending.restoredWorktreeIntent;
        const pendingActions = withoutSupersededInterviewDeliveryRetryActions(
          pending.pendingActions,
          messages,
          state.liveAssistantMessage,
          null,
        );
        const acceptedActions = withoutSupersededInterviewDeliveryRetryActions(
          pruneAcceptedActions(
            {
              ...withoutSettledAcceptedActions(
                state.acceptedActions,
                // BOTH passes retire records: the snapshot pass for sends it
                // settled itself, the settled pass for rows it recovered.
                new Set([
                  ...pending.settledAcceptedActionIds,
                  ...settled.settledAcceptedActionIds,
                ]),
              ),
              // Confirmation stamps first, then this pass's own additions - an id cannot be in both, but
              // ordering the merge makes that independent of whether it ever could be.
              ...pending.confirmedAcceptedActions,
              ...pending.acceptedActions,
            },
            now,
          ),
          messages,
          state.liveAssistantMessage,
          connectionEpoch,
        );
        return {
          chat: chatRecordWithoutTranscript(frame.snapshot.chat),
          currentComposerSettings: nextComposerSettings,
          access: frame.snapshot.access,
          messages,
          events: frame.snapshot.chat.events,
          queue: mergeQueueWithOptimisticQueuedItems(
            frame.snapshot.queue,
            queueWithoutSettledAcceptedSends(
              state.queue,
              pending.settledAcceptedActionIds,
            ),
            new Set(Object.keys(pending.pendingActions)),
          ),
          runStatus: frame.snapshot.runStatus,
          activeTurn: frame.snapshot.activeTurn,
          turnInProgress: frame.snapshot.turnInProgress,
          pendingApprovals: frame.snapshot.pendingApprovals,
          pendingFileEditApprovals: frame.snapshot.pendingFileEditApprovals,
          pendingInterviews: frame.snapshot.pendingInterviews,
          accumulatedFileChanges: frame.snapshot.accumulatedFileChanges,
          backgroundItems: frame.snapshot.backgroundItems,
          managedCommands: frame.snapshot.managedCommands,
          heldUpdates: frame.snapshot.heldUpdates,
          // Drop per-item stops whose task has left the running-only list (its terminal landed) and clear
          // the stop-all flag once nothing is left running, so settled rows never stay disabled.
          pendingBackgroundStops: reconcileBackgroundStops(
            withoutBackgroundStopsForActions(
              state.pendingBackgroundStops,
              sweep.sweptActionIds,
            ),
            frame.snapshot.backgroundItems,
          ),
          pendingBackgroundStopAll:
            state.pendingBackgroundStopAll !== null &&
            sweep.sweptActionIds.has(
              state.pendingBackgroundStopAll.clientActionId,
            )
              ? null
              : reconcileBackgroundStopAll(
                  state.pendingBackgroundStopAll,
                  frame.snapshot.backgroundItems,
                ),
          // A session stop whose in-flight frame died with the connection (either phase) was just swept -
          // drop it so Stop all re-enables.
          pendingBackgroundSessionStop:
            state.pendingBackgroundSessionStop !== null &&
            sweep.sweptActionIds.has(
              state.pendingBackgroundSessionStop.clientActionId,
            )
              ? null
              : state.pendingBackgroundSessionStop,
          pendingActions,
          acceptedActions,
          pendingUserMessages: settled.pendingUserMessages,
          failedSendRestoration: settled.failedSendRestoration,
          // Statements both reconcile passes owe the user: a send whose restoration lost the single-slot
          // race on reconnect, and a stranded send the settled pass dropped without the slot.
          errorNotices: appendErrorNoticeDelta(
            state.errorNotices,
            [...pending.appendedErrorNotices, ...settled.appendedErrorNotices],
            state.deliveredNoticeActionIds,
          ),
          restore: sweepStaleRestoreSlot(state.restore, connectionEpoch),
          snapshotLoaded: true,
          // Stamped with the CONNECTION, not a per-snapshot counter: a reconnect's backfill re-baselines
          // transcript consumers, while a steady-state refresh on this same connection does not.
          transcriptBaselineEpoch: connectionEpoch,
          worktreeBinding: frame.snapshot.worktreeBinding,
          missingWorktreePaths: frame.snapshot.missingWorktreePaths,
          liveAssistantMessage: liveAssistantForTurnStateFrame({
            current: state.liveAssistantMessage,
            previousTurnId,
            activeTurn: frame.snapshot.activeTurn,
            messages,
          }),
          // Snapshot is authoritative - the assistant message's persisted `usage` field now carries any
          // final state.
          liveTurnUsage: null,
          // Last, on purpose: the caller's atomically-co-published state (see
          // the function doc) wins over anything the fold computed.
          ...extra,
        };
      });
      // A prompt handed back to the composer takes its staged worktree with it, or the resubmit silently
      // runs against the chat's previous binding.
      const handedBackForSnapshot = restoreOneWorktreeIntent(
        restoredWorktreeIntentForSnapshot,
        sweptWorktreeIntents,
        {
          surface: "owner",
          hostId: options.hostId,
          epicId: options.epicId,
          ownerKind: "chat",
          ownerId: options.chatId,
        },
        // Read AFTER the reconcile `set`, so this is who holds the slot now - this pass's own restored
        // prompt, or an earlier pass's still waiting to be consumed.
        get().failedSendRestoration,
      );
      recordStagedRevisionFor(
        restoredWorktreeIntentForSnapshot,
        handedBackForSnapshot,
      );
      // A deferred session stop that survived the sweep (its turn stop was accepted before the
      // connection dropped) may never see another turn-state frame - the turn could have settled while
      maybeDispatchPendingBackgroundSessionStop(set, get);
      // This snapshot is authoritative for which interviews are still pending, so any stored draft whose
      // block has left the set is an orphan (its interview resolved, possibly while this window was
      useInterviewDraftStore
        .getState()
        .pruneChatDrafts(
          options.chatId,
          new Set(
            frame.snapshot.pendingInterviews.map(
              (interview) => interview.blockId,
            ),
          ),
        );
    };

    // ─── The windowed line (`chat.subscribe@1.8`) ───────────────────────────

    /**
     * A windowed snapshot whose TAIL had no bodies, held until it does. The wait-for-tail rule lives
     * here.
     */
    let deferredWindowedSnapshot: ChatWindowedSnapshotFrame | null = null;

    /** The held snapshot's AUX state, advanced by every frame that arrives while it waits. */
    let deferredWindowedSnapshotAux: DeferredWindowedSnapshotAux | null = null;

    const advanceDeferredSnapshotAux = (
      update: (
        aux: DeferredWindowedSnapshotAux,
      ) => Partial<DeferredWindowedSnapshotAux>,
    ): void => {
      if (deferredWindowedSnapshotAux === null) return;
      deferredWindowedSnapshotAux = {
        ...deferredWindowedSnapshotAux,
        ...update(deferredWindowedSnapshotAux),
      };
    };

    const forgetDeferredWindowedSnapshot = (): void => {
      deferredWindowedSnapshot = null;
      deferredWindowedSnapshotAux = null;
    };

    /** Whether this session negotiated the windowed line. */
    let windowedLine = false;

    /**
     * The witnessed image-resolution write stream - the directional evidence the settled arm's image
     * tiebreak compares (see {@link ImageWitnessStore}).
     */
    let imageWitnesses = createImageWitnessStore();

    /**
     * The ordinal range the transcript viewport is showing, as last reported by {@link
     * ChatSessionState.reportVisibleTranscriptRange}.
     */
    let visibleTranscriptRange: OrdinalRange | null = null;

    /** What a request that has been SENT and not yet answered still promises. */
    // The ledger those questions now live on - range obligations, resnapshot dedup,
    // skeleton-completion, and the summary-assembly trust state, one record per fact.
    const recovery = createRecoveryLedger();

    /** The summary re-stream this client is currently assembling. */
    let accumulatedSummaryGeneration = -1;
    /**
     * The replacement summary generation being assembled, unpublished. `null` when no chunk of the
     * current generation has arrived yet.
     */
    let assemblingSummaries:
      | readonly ChatAccumulatedFileChangeSummary[]
      | null = null;

    /**
     * The range request currently in flight, so a stream of identical viewport reports does not
     * re-send the same ask while the host is answering it.
     */
    let inFlightHydrationRequest: {
      readonly requestId: string;
      readonly epoch: number;
      readonly range: OrdinalRange;
    } | null = null;

    let resnapshotRequestTimer: number | null = null;

    const clearResnapshotRequestTimer = (): void => {
      if (resnapshotRequestTimer === null) return;
      window.clearTimeout(resnapshotRequestTimer);
      resnapshotRequestTimer = null;
    };

    /** Ask for a `resnapshot`, at most one per epoch - and not forever. */
    const requestResnapshotOnceForEpoch = (epoch: number): void => {
      const client = streamClient;
      if (client === null) return;
      if (!recovery.openResnapshot(epoch)) return;
      clearResnapshotRequestTimer();
      resnapshotRequestTimer = window.setTimeout(() => {
        resnapshotRequestTimer = null;
        if (disposed || !recovery.hasOpenResnapshot(epoch)) return;
        recovery.releaseResnapshot(epoch);
        requestPlannedHydration();
        // `requestPlannedHydration` retries only what it can SEE, and it looks at the transcript: an
        // invalidated window re-asks here, and a planned range covers a visible gap.
        armStreamCompletionWatchdog({
          readCompleteness: true,
          restartDeadline: true,
        });
      }, HYDRATION_REQUEST_TIMEOUT_MS);
      client.requestResnapshot();
    };

    /** Ask the host to start the accumulated-summary stream over. */
    const requestSummaryRestream = (): void => {
      requestResnapshotOnceForEpoch(get().transcriptWindow.epoch);
    };

    /** The ONE derivation of both summary trust flags, from the ledger's summary-assembly entry. */
    const summaryTrustState = (): {
      readonly accumulatedSummaryGenerationSeated: boolean;
      readonly accumulatedSummaryAssemblyStarted: boolean;
    } => {
      const trust = recovery.summaryTrust();
      return {
        accumulatedSummaryGenerationSeated: trust.seated,
        accumulatedSummaryAssemblyStarted: trust.started,
      };
    };

    let streamCompletionTimer: number | null = null;
    let watchdogRestreamsForEpoch: { epoch: number; count: number } | null =
      null;

    const clearStreamCompletionWatchdog = (): void => {
      if (streamCompletionTimer === null) return;
      window.clearTimeout(streamCompletionTimer);
      streamCompletionTimer = null;
    };

    /**
     * Is a chunked delivery still missing part of what it promised? Read off the TOTALS the snapshot
     * states, and deliberately not off whether a chunk was ever received.
     */
    const chunkedDeliveryIncomplete = (): boolean => {
      const state = get();
      if (!state.transcriptWindow.skeletonComplete) return true;
      // A rebuild is in flight and its replacement stream has not landed.
      if (
        !state.accumulatedSummaryGenerationSeated &&
        (state.accumulatedSummaryAssemblyStarted ||
          state.accumulatedFileChangeCount > 0)
      ) {
        return true;
      }
      return (
        state.accumulatedFileChangeSummaries.length !==
        state.accumulatedFileChangeCount
      );
    };

    /** Notice a chunked delivery that STOPPED rather than finished. */
    const armStreamCompletionWatchdog = (input: {
      /** Whether to read completeness before arming. */
      readonly readCompleteness: boolean;
      /** Whether this caller is DELIVERY PROGRESS, and so entitled to restart the idle clock. */
      readonly restartDeadline: boolean;
    }): void => {
      // Teardown first, and it always CLEARS - the guard below must never be
      // able to leave a timer running on a disposed store.
      if (disposed || !windowedLine) {
        clearStreamCompletionWatchdog();
        return;
      }
      // A non-progress arm with a deadline already running is a no-op: the timer in flight is the one
      // measuring this stall, and replacing it with an identical one that starts now is the postponement
      if (!input.restartDeadline && streamCompletionTimer !== null) return;
      clearStreamCompletionWatchdog();
      if (input.readCompleteness && !chunkedDeliveryIncomplete()) {
        // Completed: the next stall starts from a clean budget.
        watchdogRestreamsForEpoch = null;
        return;
      }
      const epoch = get().transcriptWindow.epoch;
      streamCompletionTimer = window.setTimeout(() => {
        streamCompletionTimer = null;
        if (disposed || !windowedLine) return;
        // A stream belonging to a coordinate space this client has left says
        // nothing about the one it is in now.
        if (get().transcriptWindow.epoch !== epoch) return;
        if (!chunkedDeliveryIncomplete()) return;
        const spent =
          watchdogRestreamsForEpoch?.epoch === epoch
            ? watchdogRestreamsForEpoch.count
            : 0;
        if (spent >= MAX_WATCHDOG_RESTREAMS_PER_EPOCH) {
          recovery.abandonEpochRecovery(epoch);
          return;
        }
        watchdogRestreamsForEpoch = { epoch, count: spent + 1 };
        requestResnapshotOnceForEpoch(epoch);
      }, STREAM_COMPLETION_TIMEOUT_MS);
    };

    let hydrationRequestTimer: number | null = null;

    /** Release the slot an unanswered range request is holding. */
    const clearInFlightHydration = (): void => {
      inFlightHydrationRequest = null;
      if (hydrationRequestTimer === null) return;
      window.clearTimeout(hydrationRequestTimer);
      hydrationRequestTimer = null;
    };

    const requestPlannedHydration = (): void => {
      const client = streamClient;
      if (client === null) return;
      const state = get();
      // NOT named `window`: the timeout below is armed off the global one, and
      // a local of that name would shadow it.
      const transcriptWindow = state.transcriptWindow;
      if (transcriptWindow.invalidated) {
        // A void index cannot be repaired by a range: every ordinal it would
        // name belongs to a coordinate space this client has left.
        requestResnapshotOnceForEpoch(transcriptWindow.epoch);
        return;
      }
      const next = planTranscriptHydration(
        transcriptWindow,
        visibleTranscriptRange,
        requiredHydrationOrdinalsOf(state),
      );
      if (next === null) return;
      const inFlight = inFlightHydrationRequest;
      if (
        inFlight !== null &&
        inFlight.epoch === transcriptWindow.epoch &&
        inFlight.range.fromOrdinal === next.fromOrdinal &&
        inFlight.range.toOrdinal === next.toOrdinal
      ) {
        return;
      }
      const requestId = uuidv4();
      // Clears the previous request's timeout as well as its slot: replanning over an outstanding
      // request abandons it, and its deadline with it.
      clearInFlightHydration();
      inFlightHydrationRequest = {
        requestId,
        epoch: transcriptWindow.epoch,
        range: next,
      };
      const { capEvicted } = recovery.openRange({
        requestId,
        epoch: transcriptWindow.epoch,
        range: next,
      });
      hydrationRequestTimer = window.setTimeout(() => {
        hydrationRequestTimer = null;
        // Only the request this timeout was armed for. Anything else already
        // replaced the slot - and took the deadline with it.
        if (disposed || inFlightHydrationRequest?.requestId !== requestId) {
          return;
        }
        // Releases the dedup slot so the plan can be re-asked. `requestId` keeps its ledger entry: this is
        // a request that has waited too long, not one whose answer has been ruled out.
        inFlightHydrationRequest = null;
        requestPlannedHydration();
      }, HYDRATION_REQUEST_TIMEOUT_MS);
      client.requestTranscriptRange({
        requestId,
        epoch: transcriptWindow.epoch,
        fromOrdinal: next.fromOrdinal,
        // The two bounds mean different things and the conversion is here.
        toOrdinal: next.toOrdinal - 1,
        // The host clamps this to its own ceiling regardless, so asking for the full frame budget is
        // asking for "as much as one frame holds" rather than a number this side has to keep in step.
        maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
      });
      // The cap binding is a SUPERSEDE-AND-REPLAN, never silent trust: the evicted oldest entries are
      // replaced by one NEW wider request covering their rows, whose own entry carries the obligation.
      if (capEvicted.length > 0) {
        const evictedFrom = Math.min(
          ...capEvicted.map((entry) => entry.range.fromOrdinal),
        );
        const evictedTo = Math.max(
          ...capEvicted.map((entry) => entry.range.toOrdinal),
        );
        const widerRequestId = uuidv4();
        recovery.openRange({
          requestId: widerRequestId,
          epoch: transcriptWindow.epoch,
          range: { fromOrdinal: evictedFrom, toOrdinal: evictedTo },
        });
        client.requestTranscriptRange({
          requestId: widerRequestId,
          epoch: transcriptWindow.epoch,
          fromOrdinal: evictedFrom,
          toOrdinal: evictedTo - 1,
          maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
        });
      }
    };

    /** Record that a delta invalidated bodies a range request is still waiting for. */
    const supersedeInFlightHydration = (input: {
      readonly epoch: number;
      readonly changes: readonly ChatIndexChange[];
    }): void => {
      if (!recovery.hasOpenRanges()) return;
      const bodyInvalidated = bodyInvalidatingOrdinals(input.changes);
      // Against the window as the requests were framed against it - this runs before the fold, and an
      // `updated` never renumbers a row, so the turn a widened ordinal belongs to is the same either
      const invalidated =
        bodyInvalidated === "all"
          ? bodyInvalidated
          : recordSharingOrdinals(get().transcriptWindow, bodyInvalidated);
      recovery.markRangesSuperseded({ epoch: input.epoch, invalidated });
    };

    /** Should this `range` response be thrown away rather than seated? */
    const rangeResponseIsStale = (response: ChatRangeResponse): boolean =>
      recovery.rangeAnswerIsStale({
        requestId: response.requestId,
        fromOrdinal: response.fromOrdinal,
        servedCount: response.rowIds.length,
      });

    /**
     * {@link ChatSessionState.reportVisibleTranscriptRange}'s implementation; hoisted beside the
     * planner it drives rather than defined inline in the state object two thousand lines below.
     */
    const applyVisibleTranscriptRange = (range: OrdinalRange | null): void => {
      const unchanged =
        (range === null && visibleTranscriptRange === null) ||
        (range !== null &&
          visibleTranscriptRange !== null &&
          range.fromOrdinal === visibleTranscriptRange.fromOrdinal &&
          range.toOrdinal === visibleTranscriptRange.toOrdinal);
      visibleTranscriptRange = range;
      // Off the windowed line the value is recorded (the line can be negotiated by a later reconnect)
      // but nothing here could mean anything yet.
      if (unchanged || !windowedLine || disposed) return;
      // Warm the LRU for what the reader is looking at BEFORE planning.
      const window = get().transcriptWindow;
      const touched = touchTranscriptRange(window, range);
      if (touched !== window) set({ transcriptWindow: touched });
      // What `null` does only CLEAR is the standing obligation - there is
      // nothing to fetch for "no placed row visible".
      if (range === null) return;
      requestPlannedHydration();
    };

    /**
     * Re-point `messages`/`events` at what the window now holds. The steady-state path for every
     * windowed frame that changes hydration without being authoritative about anything else.
     */
    const commitChatWindowBudget = (window: TranscriptWindow): void => {
      recencyStamp = memory.stampChatRecency();
      memory.chatWindows.settle(
        memory.accountant,
        holderId,
        chatSessionChargeBytes(window, chatSlicesOf(get())),
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.chatWindows);
    };

    const legacyTranscriptChargeBytes = (state: ChatSessionState): number =>
      legacyTranscriptResidencyBytes(state.messages, state.events) +
      chatWholeSetSliceBytes(chatSlicesOf(state));

    const commitLegacyTranscriptBudget = (): void => {
      recencyStamp = memory.stampChatRecency();
      memory.chatWindows.settle(
        memory.accountant,
        holderId,
        legacyTranscriptChargeBytes(get()),
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.chatWindows);
    };

    /** Re-settle after a WHOLE-SET slice moved while the transcript did not. */
    const commitWholeSetSliceBudget = (): void => {
      if (disposed) return;
      const state = get();
      memory.chatWindows.settle(
        memory.accountant,
        holderId,
        windowedLine
          ? chatSessionChargeBytes(state.transcriptWindow, chatSlicesOf(state))
          : legacyTranscriptChargeBytes(state),
      );
      memory.accountant.reconcile(BUDGET_PLANE_IDS.chatWindows);
    };

    const publishWindowedTranscript = (
      window: TranscriptWindow,
      // How the rows got here, when that is something a consumer has to know.
      provenance: Pick<ChatSessionState, "transcriptHydrationSequence"> | null,
    ): void => {
      const records = hydratedRecords(window);
      set({
        transcriptWindow: window,
        messages: records.messages,
        events: records.events,
        transcriptRowContext: records.rowContext,
        ...(provenance ?? {}),
      });
      commitChatWindowBudget(window);
    };

    memory.chatWindows.attach({
      holderId,
      touchedAt: () => recencyStamp,
      evict: (overBytes) => {
        const state = get();
        if (!windowedLine) {
          const transcriptBytes = legacyTranscriptResidencyBytes(
            state.messages,
            state.events,
          );
          // No ordinal/range exists on the legacy line, so this transcript is
          // the sole recoverable copy rather than an evictable window.
          memory.chatWindows.settle(
            memory.accountant,
            holderId,
            transcriptBytes + chatWholeSetSliceBytes(chatSlicesOf(state)),
          );
          return {
            reclaimedBytes: 0,
            protectedBytesByKind:
              transcriptBytes === 0
                ? []
                : [{ kind: "sole-copy", bytes: transcriptBytes }],
          };
        }
        const current = transcriptWindowChargedBytes(state.transcriptWindow);
        const { window, outcome } = evictChatWindowForAccountant(
          state.transcriptWindow,
          Math.max(0, current - overBytes),
          visibleTranscriptRange,
          requiredHydrationOrdinalsOf(state),
        );
        if (window !== state.transcriptWindow) {
          publishWindowedTranscript(window, null);
        }
        memory.chatWindows.settle(
          memory.accountant,
          holderId,
          chatSessionChargeBytes(window, chatSlicesOf(get())),
        );
        return outcome;
      },
    });

    /**
     * Route a record that arrived with no ordinal into the window. The append half of "state.messages
     * is DERIVED on this line".
     */
    const takeLiveRecords = (input: {
      readonly messages: readonly Message[];
      readonly events: readonly ChatEvent[];
    }): void => {
      publishWindowedTranscript(
        appendLiveRecords(get().transcriptWindow, input),
        null,
      );
    };

    /**
     * Settle an interview, on whichever line this session is on. The shared path for
     * `onInterviewAnswered` and `onInterviewErrored`, which differ only in the projection they build.
     */
    const interviewLifecycleTranscript = (
      state: ChatSessionState,
      projection: InterviewLifecycleProjection,
    ): {
      readonly patch: Pick<
        ChatSessionState,
        "messages" | "liveAssistantMessage" | "transcriptWindow"
      >;
      readonly resolvedPendingOwner: boolean;
      readonly matchedOwner: boolean;
    } => {
      const lifecycle = withInterviewLifecycleState(
        state.messages,
        state.liveAssistantMessage,
        projection,
      );
      const rewrittenId = lifecycle.rewrittenMessageId;
      const settled =
        rewrittenId === null || !isWindowedTranscript(state)
          ? undefined
          : lifecycle.messages.find(
              (message) => message.messageId === rewrittenId,
            );
      if (rewrittenId === null || settled === undefined) {
        return {
          patch: {
            messages: lifecycle.messages,
            liveAssistantMessage: lifecycle.liveAssistantMessage,
            transcriptWindow: state.transcriptWindow,
          },
          resolvedPendingOwner: lifecycle.resolvedPendingOwner,
          matchedOwner: lifecycle.matchedOwner,
        };
      }
      const applied = updateWindowMessage(
        state.transcriptWindow,
        rewrittenId,
        () => settled,
        imageWitnesses,
      );
      return {
        patch: {
          // `held: false` means the row left the window between the fold above and here.
          messages: applied.held
            ? hydratedRecords(applied.window).messages
            : state.messages,
          liveAssistantMessage: lifecycle.liveAssistantMessage,
          transcriptWindow: applied.window,
        },
        resolvedPendingOwner: lifecycle.resolvedPendingOwner,
        matchedOwner: lifecycle.matchedOwner,
      };
    };

    /** The windowed snapshot as the shared fold expects it. */
    const adaptWindowedSnapshot = (
      frame: ChatWindowedSnapshotFrame,
      window: TranscriptWindow,
      // The frame's aux as of NOW rather than as of when it was sent - see {@link
      // deferredWindowedSnapshotAux}.
      aux: DeferredWindowedSnapshotAux | null,
    ): ChatSnapshotFrame => {
      const records = hydratedRecords(window);
      const current = aux ?? deferredWindowedSnapshotAuxOf(frame.snapshot);
      return {
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId: frame.epicId,
        chatId: frame.chatId,
        snapshot: {
          chat: {
            ...frame.snapshot.chat,
            messages: [...records.messages],
            events: [...records.events],
          },
          access: frame.snapshot.access,
          queue: current.queue,
          runStatus: current.runStatus,
          activeTurn: current.activeTurn,
          pendingApprovals: current.pendingApprovals,
          pendingInterviews: current.pendingInterviews,
          worktreeBinding: current.worktreeBinding,
          missingWorktreePaths: current.missingWorktreePaths,
          pendingFileEditApprovals: current.pendingFileEditApprovals,
          accumulatedFileChanges: [],
          backgroundItems: current.backgroundItems,
          managedCommands: current.managedCommands,
          heldUpdates: current.heldUpdates,
          turnInProgress: current.turnInProgress,
        },
      };
    };

    /**
     * Runs the shared fold if the tail is in, or holds the frame until it is. The one place the
     * wait-for-tail rule is enforced.
     */
    const applyOrDeferWindowedSnapshot = (
      frame: ChatWindowedSnapshotFrame,
      window: TranscriptWindow,
      aux: Partial<ChatSessionState>,
    ): void => {
      if (!isTailHydrated(window)) {
        const records = hydratedRecords(window);
        set({
          ...aux,
          messages: records.messages,
          events: records.events,
          transcriptRowContext: records.rowContext,
        });
        // Re-entry with the frame already held keeps the supersessions collected since it arrived; a NEW
        // snapshot replaces both, because its own aux is the newer authority for everything it carries.
        if (frame !== deferredWindowedSnapshot) {
          deferredWindowedSnapshot = frame;
          deferredWindowedSnapshotAux = deferredWindowedSnapshotAuxOf(
            frame.snapshot,
          );
        }
        return;
      }
      const superseded =
        frame === deferredWindowedSnapshot ? deferredWindowedSnapshotAux : null;
      forgetDeferredWindowedSnapshot();
      // The adapted snapshot's records ARE `hydratedRecords(window)`, so its context has to ride the
      // same apply.
      applyAuthoritativeSnapshot(
        adaptWindowedSnapshot(frame, window, superseded),
        {
          ...aux,
          transcriptRowContext: hydratedRowContext(window),
        },
        // The HOST's answer, not a scan of the adapted frame: those records are the hydrated subset, and a
        // failure several user rows back is exactly the shape that falls outside the inline tail.
        frame.snapshot.derived.latestAssistantAuthFailureTurnKey,
      );
    };

    const applyLegacyTranscriptEvent = (
      event: LegacyChatTranscriptSnapshotEvent,
    ): void => {
      const { frame } = event;
      if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
        return;
      }
      if (!windowedLine) {
        // The legacy line's `messages` IS the transcript, so the scan is the whole-transcript answer here
        // and needs no host help.
        applyAuthoritativeSnapshot(
          frame,
          null,
          latestAssistantAuthFailureTurnKey(frame.snapshot.chat.messages),
        );
        commitLegacyTranscriptBudget();
        return;
      }
      // A LEGACY snapshot on a session that had negotiated `1.8`: the reconnect renegotiated onto an
      // older line (a host rolled back below `1.8`, or a fallback route to an older peer).
      windowedLine = false;
      clearInFlightHydration();
      clearStreamCompletionWatchdog();
      // Not merely unawaited: this line no longer HAS ordinals, so an answer still in the air describes
      // a coordinate space nothing here can read.
      recovery.dropAll();
      clearResnapshotRequestTimer();
      forgetDeferredWindowedSnapshot();
      // The buffer belongs to the windowed line too. Left behind, the flag below and it disagree at the
      // one site whose own comment demands a blank slate for a later re-upgrade.
      assemblingSummaries = null;
      imageWitnesses = createImageWitnessStore();
      applyAuthoritativeSnapshot(
        frame,
        {
          transcriptWindow: emptyTranscriptWindow(),
          transcriptDerived: null,
          // The rest of the windowed line's aux state, back to its initial values: nothing reads either once
          // `transcriptDerived` is null, but a LATER re-upgrade must start from the same blank state a fresh
          accumulatedFileChangeCount: 0,
          coldRewrittenMessageIds: EMPTY_COLD_REWRITTEN_IDS,
          jumpTargetOrdinal: null,
          accumulatedFileChangeSummaries: [],
          accumulatedSummaryGenerationSeated: false,
          accumulatedSummaryAssemblyStarted: false,
        },
        // A downgrade frame is a LEGACY snapshot - full records - so the
        // scan is again the whole-transcript answer.
        latestAssistantAuthFailureTurnKey(frame.snapshot.chat.messages),
      );
      commitLegacyTranscriptBudget();
    };

    const legacyTranscriptAdapter = createLegacyChatTranscriptAdapter();
    legacyTranscriptAdapter.attach({
      environment: options.environment,
      emit: applyLegacyTranscriptEvent,
      // Pre-windowed chat has no cursor and therefore no resume outcome.
      reportResume: () => {},
      // The multiplexed `ChatStreamClient` owns connection status; this decode
      // arm receives only the legacy snapshot callback.
      reportStatus: () => {},
      // No epoch/cursor exists on this line from which an authority-side replacement could be inferred.
      requestReplacement: () => {},
    });

    const callbacks: ChatStreamCallbacks = {
      onSnapshot: (frame) => {
        // The adapter emits synchronously. Keeping the callback itself free of projection writes is the
        // proof that the legacy arm is behind the runtime seam rather than a parallel store mutation path.
        legacyTranscriptAdapter.ingestSnapshot(frame);
      },
      onWorktreeStateChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set({
          worktreeBinding: frame.worktreeBinding,
          missingWorktreePaths: frame.missingWorktreePaths,
        });
        advanceDeferredSnapshotAux(() => ({
          worktreeBinding: frame.worktreeBinding,
          missingWorktreePaths: frame.missingWorktreePaths,
        }));
      },
      onManagedCommandsChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // The frame carries the whole set, so a dropped one can never strand a
        // stale row - the next frame replaces everything either way.
        set({ managedCommands: frame.managedCommands });
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux(() => ({
          managedCommands: frame.managedCommands,
        }));
      },
      onHeldUpdatesChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // Whole set, same as the command list above: a hold clearing is the ABSENCE of a row, so a delta
        // shape would need a removal frame the host has no reason to send.
        set({ heldUpdates: frame.heldUpdates });
        advanceDeferredSnapshotAux(() => ({ heldUpdates: frame.heldUpdates }));
      },
      // ─── The windowed line (`chat.subscribe@1.8`) ──────────────────────── Live: `chatSubscribeV18`
      // is registered, so two `1.8`-capable peers negotiate onto this handler.
      onWindowedSnapshot: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        windowedLine = true;
        // NEITHER the dedup slot nor the ledger is cleared here, and both decisions are deferred to below
        // for the same reason.
        const epochBeforeSnapshot = get().transcriptWindow.epoch;
        // The resnapshot entry deliberately does NOT close here.
        flushBlockDeltas();
        // Budgeted here as well as in `onRange`, because seating a tail is the OTHER way this window
        // grows: `insertSpan` has exactly two callers (`applyWindowedSnapshot` and `applyRangeResponse`)
        const windowBeforeSnapshot = get().transcriptWindow;
        const seated = applyWindowedSnapshot(
          windowBeforeSnapshot,
          {
            epoch: frame.snapshot.transcriptEpoch,
            rowCount: frame.snapshot.rowCount,
            indexRevision: frame.snapshot.indexRevision,
            tail: frame.snapshot.tail,
          },
          // The STORE's active turn, not the frame's: the held-copy preference is about the client's current
          // delta-rewrite state, and a completion snapshot whose frame already settled the turn must still
          get().activeTurn?.turnId ?? null,
          imageWitnesses,
        );
        // The fold returns its input BY IDENTITY when it refuses the frame (a stale-epoch snapshot with a
        // concrete revision, a same-epoch straggler), and every acceptance mints a new window - so
        const snapshotAccepted = seated !== windowBeforeSnapshot;
        const window = evictTranscriptWindowToBudget(
          seated,
          TRANSCRIPT_WINDOW_MAX_BYTES,
          visibleTranscriptRange,
          pendingInterviewOrdinals(
            frame.snapshot.derived.interviewAnswerability,
            frame.snapshot.pendingInterviews,
          ),
        );
        // NOW the boundary decision, with the applied window in hand - the fold runs FIRST, deliberately,
        // so everything below reads post-fold authority.
        const rebased = window.epoch !== epochBeforeSnapshot;
        if (
          snapshotAccepted &&
          (frame.snapshot.indexRevision === null ||
            rebased ||
            window.invalidated)
        ) {
          clearInFlightHydration();
          recovery.authorityBoundary({
            epoch: window.epoch,
            announcesRebuild: frame.snapshot.indexRevision === null,
          });
          imageWitnesses.invalidateAll();
        }
        if (window.skeletonComplete) {
          recovery.skeletonCompleted(window.epoch);
        }
        // The rebuild boundary for the summary generation tracker.
        if (frame.snapshot.indexRevision === null) {
          accumulatedSummaryGeneration = -1;
          assemblingSummaries = null;
          recovery.resetSummaryStream();
          // The retained array is now the PREVIOUS generation's, so it vouches for nothing until a
          // replacement chunk lands - including when its length already equals the authoritative count.
          set(summaryTrustState());
        }
        applyOrDeferWindowedSnapshot(frame, window, {
          transcriptWindow: window,
          transcriptDerived: frame.snapshot.derived,
          accumulatedFileChangeCount: frame.snapshot.accumulatedFileChangeCount,
          // A rebase replaces the coordinate space, so a pending "this row was rewritten while cold" note is
          // about rows that no longer exist under these ordinals.
          ...(rebased
            ? { coldRewrittenMessageIds: EMPTY_COLD_REWRITTEN_IDS }
            : {}),
          // Deliberately NOT resetting `accumulatedFileChangeSummaries` here.
        });
        commitChatWindowBudget(window);
        // An aux-only re-broadcast - a queue change, an approval - clears the resnapshot latch and
        // `invalidated` while sending no chunks at all (see the comment just above).
        armStreamCompletionWatchdog({
          readCompleteness: false,
          // A rebuild is a fresh stream starting, so it restarts the clock; an aux-only re-broadcast carries
          // no chunk and must not.
          restartDeadline: frame.snapshot.indexRevision === null || rebased,
        });
        requestPlannedHydration();
      },
      onSkeletonChunk: (frame) => {
        if (
          disposed ||
          !windowedLine ||
          !matchesChat(options, frame.epicId, frame.chatId)
        ) {
          return;
        }
        // Can DROP bodies, not just add entries: this is where a tail seated
        // with no ids to check against finally meets the rows it claimed.
        const window = applySkeletonChunk(get().transcriptWindow, frame.chunk);
        // The rebuild's guaranteed close: `skeletonComplete` is what
        // discharges the skeleton-completion entry the announcement opened.
        if (window.skeletonComplete) {
          recovery.skeletonCompleted(window.epoch);
        }
        publishWindowedTranscript(window, null);
        // Re-arms while the skeleton is still short, disarms once it covers `rowCount`. A stream that
        // simply stops after a non-final chunk is otherwise indistinguishable from one still in progress.
        armStreamCompletionWatchdog({
          readCompleteness: true,
          restartDeadline: true,
        });
        requestPlannedHydration();
      },
      onIndexChanged: (frame) => {
        // Same downgrade guard as `onSkeletonChunk`.
        if (
          disposed ||
          !windowedLine ||
          !matchesChat(options, frame.epicId, frame.chatId)
        ) {
          return;
        }
        const activeTurnId = get().activeTurn?.turnId ?? null;
        // The streaming turn's own index echo supersedes nothing: the deltas that produced it have already
        // rewritten the held records, so an answer in flight for that turn's rows is not stale.
        const streamingEcho =
          isActiveTurnStreamingEcho(frame.changes, activeTurnId) &&
          (!recovery.hasOpenRanges() ||
            holdsActiveTurnAssistantMessage(
              get().transcriptWindow,
              activeTurnId,
            ));
        // Folded FIRST, but not published yet - the two orderings this has to satisfy pull in opposite
        // directions and this is what satisfies both.
        const beforeFold = get().transcriptWindow;
        const window = applyIndexChange(beforeFold, {
          epoch: frame.epoch,
          rowCount: frame.rowCount,
          indexRevision: frame.indexRevision,
          changes: frame.changes,
          activeTurnId,
        });
        if (!streamingEcho && window !== beforeFold) {
          supersedeInFlightHydration({
            epoch: frame.epoch,
            changes: frame.changes,
          });
        }
        publishWindowedTranscript(window, null);
        // Covers the `reindexed` case too: `requestPlannedHydration` sends a
        // `resnapshot` rather than a range when the window is invalidated.
        requestPlannedHydration();
      },
      onRange: (frame) => {
        // Same downgrade guard as `onSkeletonChunk`.
        if (
          disposed ||
          !windowedLine ||
          !matchesChat(options, frame.epicId, frame.chatId)
        ) {
          return;
        }
        const tracked = inFlightHydrationRequest;
        const stale = rangeResponseIsStale(frame.range);
        // This request is answered: it can neither be superseded nor seat
        // anything again, whichever way the staleness check just went.
        recovery.closeRange(frame.range.requestId);
        // Clear the slot ONLY for the request this response actually answers.
        if (tracked !== null && tracked.requestId === frame.range.requestId) {
          clearInFlightHydration();
        }
        if (stale) {
          // Seat nothing.
          requestPlannedHydration();
          return;
        }
        const window = evictTranscriptWindowToBudget(
          applyRangeResponse(
            get().transcriptWindow,
            frame.range,
            get().activeTurn?.turnId ?? null,
            imageWitnesses,
          ),
          TRANSCRIPT_WINDOW_MAX_BYTES,
          // What the reader is looking at is never evicted - see the function's own doc for the
          // oversized-row re-fetch loop this forecloses.
          visibleTranscriptRange,
          // And the row a pending question lives on, which is re-planned with
          // no viewport to scroll away from and would loop hardest of all.
          requiredHydrationOrdinalsOf(get()),
        );
        // Rides the same `set` as the rows it describes, so no consumer can
        // observe the rows without the fact that a range delivered them.
        const hydrated = {
          transcriptHydrationSequence: get().transcriptHydrationSequence + 1,
        };
        const deferred = deferredWindowedSnapshot;
        if (deferred === null) {
          publishWindowedTranscript(window, hydrated);
        } else {
          // The tail this response was asked for may have arrived. The fold publishes `messages`/`events`
          // itself - with the window riding the same `set` - so it replaces the steady-state publish above.
          applyOrDeferWindowedSnapshot(deferred, window, {
            transcriptWindow: window,
            ...hydrated,
          });
          // Whatever arrived while the snapshot was held.
          if (deferredWindowedSnapshot === null) flushBlockDeltas();
          commitChatWindowBudget(window);
        }
        requestPlannedHydration();
      },
      onAccumulatedChanges: (frame) => {
        if (
          disposed ||
          !windowedLine ||
          !matchesChat(options, frame.epicId, frame.chatId)
        ) {
          return;
        }
        if (frame.chunk.epoch !== get().transcriptWindow.epoch) return;
        recovery.observeSummaryChunk(frame.chunk.generation);
        // Chunks are contiguous and in order from `fromIndex`, so a chunk starting at 0 begins a fresh set
        // and any other extends the one being assembled.
        if (frame.chunk.generation !== accumulatedSummaryGeneration) {
          if (frame.chunk.fromIndex !== 0) {
            // The chunk itself cannot seat - its predecessors were dropped - but the generation WAS observed
            // above, so the trust flags already read the replacement stream as running.
            set(summaryTrustState());
            requestSummaryRestream();
            return;
          }
          accumulatedSummaryGeneration = frame.chunk.generation;
          // A fresh generation assembles OFF-SCREEN. Publishing its first chunk immediately repainted the
          // panel with a partial replacement
          assemblingSummaries = [];
          set(summaryTrustState());
        }
        // A chunk starting PAST the end is a chunk whose predecessor was dropped.
        const assembled =
          assemblingSummaries ?? get().accumulatedFileChangeSummaries;
        if (frame.chunk.fromIndex > assembled.length) {
          // The observation above re-opened the entry, so a late gap chunk
          // after a seated final publishes the un-seat it proves.
          set(summaryTrustState());
          requestSummaryRestream();
          return;
        }
        const summaries = [
          ...assembled.slice(0, frame.chunk.fromIndex),
          ...frame.chunk.summaries,
        ];
        assemblingSummaries = summaries;
        // Published only once whole. Until then the previous set keeps the panel honest, and the watchdog
        // - armed below off the un-seated flag - is what recovers a replacement stream that stops short.
        if (frame.chunk.isFinal) {
          recovery.closeSummaryAssembly(frame.chunk.generation);
          set({
            accumulatedFileChangeSummaries: summaries,
            ...summaryTrustState(),
          });
        } else if (get().accumulatedSummaryGenerationSeated) {
          // The observation at the top re-opened the entry; this publishes it.
          set(summaryTrustState());
        }
        // The gap check above only fires when a LATER chunk exposes the hole, so it cannot see the stream
        // simply stopping.
        armStreamCompletionWatchdog({
          readCompleteness: true,
          restartDeadline: true,
        });
      },
      onActionAck: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        const rejectedPending =
          frame.status === "rejected"
            ? pendingActionForId(get().pendingActions, frame.clientActionId)
            : null;
        const rejectionStagingKey: WorktreeStagingKey = {
          surface: "owner",
          hostId: options.hostId,
          epicId: options.epicId,
          ownerKind: "chat",
          ownerId: options.chatId,
        };
        const rejectionOwnsSlot =
          rejectedPending !== null &&
          stagedWorktreeIntentAwaitsDispatchFrom(
            rejectionStagingKey,
            rejectedPending.clientActionId,
          );
        const rejectionSweep = worktreeSweepFor(
          rejectedPending?.restoreWorktreeIntent ?? null,
          worktreePartition,
          false,
        );
        const worktreeGoneForRejection = rejectionSweep.swept !== null;
        // Only the dispatch that TOOK the slot may put its pick back.
        if (
          rejectedPending !== null &&
          rejectionOwnsSlot &&
          !restorationSlotHeldByOther(
            get().failedSendRestoration,
            rejectedPending.clientActionId,
          )
        ) {
          // Third re-stage site. Same rule as the two reconcile paths: capture only what the hand-back
          // actually left, so a later displacement can take back its own write and nothing else.
          recordStagedRevisionFor(
            rejectedPending,
            restoreStagedWorktreeIntent(rejectedPending, rejectionStagingKey),
          );
        }
        // Third surface, same rule.
        const worktreeSupersededForRejection =
          rejectedPending !== null &&
          rejectedPending.restoreWorktreeIntent !== null &&
          !rejectionOwnsSlot &&
          !worktreeGoneForRejection &&
          stagedWorktreeIntentAwaitsDispatchOutcome(rejectionStagingKey);
        // One account, both surfaces. Built from evidence already in hand so
        // nothing below can read a record the restore has since cleared.
        const rejectionAccountForFrame = rejectionEvidence(
          rejectedPending,
          rejectionSweep,
          worktreeSupersededForRejection,
          get().currentComposerSettings,
        );
        set((state) => {
          const pending = pendingActionForId(
            state.pendingActions,
            frame.clientActionId,
          );
          const nextPending = withoutPendingAction(
            state.pendingActions,
            frame.clientActionId,
          );
          const nextPendingUsers =
            frame.status === "accepted" && pending?.action === "send"
              ? state.pendingUserMessages
              : state.pendingUserMessages.filter(
                  (message) => message.clientActionId !== frame.clientActionId,
                );
          const backgroundStopAck = reconcileBackgroundStopAck(state, frame);
          const nextSessionStop = reconcileSessionStopAck(
            state.pendingBackgroundSessionStop,
            frame,
            state.turnInProgress ?? state.activeTurn !== null,
          );
          if (frame.status === "accepted") {
            if (pending === null) {
              return {
                pendingActions: nextPending,
                pendingUserMessages: nextPendingUsers,
                pendingBackgroundStops: backgroundStopAck.pendingStops,
                pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
                pendingBackgroundSessionStop: nextSessionStop,
              };
            }
            return {
              pendingActions: nextPending,
              acceptedActions: addAcceptedAction(
                state.acceptedActions,
                pending,
                Date.now(),
                {
                  // An ack confirms the host RECEIVED the frame, nothing about whether the message exists - that
                  // rule stands.
                  confirmedByHost:
                    pending.messageConfirmedByHost ||
                    (pending.messageId !== null &&
                      messageExists(state.messages, pending.messageId)),
                  messageConfirmedByHost:
                    pending.messageConfirmedByHost ||
                    (pending.messageId !== null &&
                      messageExists(state.messages, pending.messageId)),
                },
              ),
              pendingUserMessages: nextPendingUsers,
              pendingBackgroundStops: backgroundStopAck.pendingStops,
              pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
              pendingBackgroundSessionStop: nextSessionStop,
            };
          }
          return {
            pendingActions: nextPending,
            pendingUserMessages: nextPendingUsers,
            pendingBackgroundStops: backgroundStopAck.pendingStops,
            pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
            pendingBackgroundSessionStop: nextSessionStop,
            queue: removeOptimisticQueuedItemByClientActionId(
              state.queue,
              frame.clientActionId,
            ),
            // Single slot, first writer wins until `ackFailedSendRestoration` clears it - the same rule
            // `reconcileSnapshotChange` and the settled-turn pass already follow.
            failedSendRestoration:
              rejectionRestoration({
                state,
                pending,
                frame,
                account: rejectionAccountForFrame,
              }) ?? state.failedSendRestoration,
            errorNotices: appendErrorNotice(
              state.errorNotices,
              rejectionNotice({
                frame,
                pending,
                // Displaced: the slot was already taken when this rejection
                // landed, so first-writer-wins gave this prompt nothing.
                displaced: state.failedSendRestoration !== null,
                account: rejectionAccountForFrame,
              }),
              state.deliveredNoticeActionIds,
            ),
          };
        });
        // `queue` is one of the six, and this handler removes an optimistic item from it.
        commitWholeSetSliceBudget();
        maybeDispatchPendingBackgroundSessionStop(set, get);
      },
      onMessageAccepted: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        flushBlockDeltas();
        set((state) => {
          const pendingUserMessages = state.pendingUserMessages.filter(
            (message) => message.messageId !== frame.message.messageId,
          );
          // The fifth confirmation door.
          const acceptedActions = confirmAcceptedSendByMessageId(
            state.acceptedActions,
            frame.message.messageId,
          );
          const pendingActions = releasePendingWorktreeIntentDisplayByMessageId(
            state.pendingActions,
            frame.message.messageId,
          );
          // On the windowed line the record goes into the WINDOW instead (see `takeLiveRecords`), and
          // `messages` is republished from there - so the existence check moves with it, because
          if (
            windowedLine ||
            messageExists(state.messages, frame.message.messageId)
          ) {
            return {
              acceptedActions,
              pendingActions,
              pendingUserMessages,
              queue: removeOptimisticQueuedItemByMessageId(
                state.queue,
                frame.message.messageId,
              ),
            };
          }
          return {
            acceptedActions,
            pendingActions,
            messages: [...state.messages, frame.message],
            pendingUserMessages,
            queue: removeOptimisticQueuedItemByMessageId(
              state.queue,
              frame.message.messageId,
            ),
          };
        });
        if (windowedLine) {
          takeLiveRecords({ messages: [frame.message], events: [] });
          return;
        }
        // THE LEGACY ARM'S SETTLE.
        commitLegacyTranscriptBudget();
      },
      onQueueChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => {
          const now = Date.now();
          const patch = reconcileQueueChange({
            pendingActions: state.pendingActions,
            pendingUserMessages: state.pendingUserMessages,
            queue: frame.queue,
            acceptedActions: state.acceptedActions,
            nowMs: now,
          });
          return {
            queue: mergeQueueWithOptimisticQueuedItems(
              frame.queue,
              state.queue,
              new Set(Object.keys(patch.pendingActions)),
            ),
            pendingActions: patch.pendingActions,
            acceptedActions: withoutResolvedAcceptedQueueCancellations(
              pruneAcceptedActions(
                {
                  ...state.acceptedActions,
                  // Confirmation stamps for records that were already accepted
                  // when this frame arrived, then this pass's own transitions.
                  ...patch.confirmedAcceptedActions,
                  ...patch.acceptedActions,
                },
                now,
              ),
              frame.queue,
            ),
            pendingUserMessages: patch.pendingUserMessages,
          };
        });
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux(() => ({ queue: frame.queue }));
      },
      onTurnStateChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // Captured for the re-stage after the set - a restored prompt must
        // take its staged worktree back with it (see the snapshot handler).
        let restoredWorktreeIntentForTurnState: StagedWorktreeIntentSource | null =
          null;
        // Materializes the live row into `messages`; flush first so the turn's
        // final buffered deltas are captured before it freezes.
        flushBlockDeltas();
        set((state) => {
          // Resolved ONCE and reused: the same two ids drove four separate `?.turnId ?? null` reads, which
          // is both noise and four extra branches in an updater already at the complexity budget.
          const previousTurnId = state.activeTurn?.turnId ?? null;
          const nextTurnId = frame.activeTurn?.turnId ?? null;
          const materialized = materializedLiveAssistant(
            state.messages,
            state.liveAssistantMessage,
            {
              previousActiveTurnId: previousTurnId,
              nextActiveTurnId: nextTurnId,
            },
          );
          // The frozen row goes into the WINDOW on the windowed line, not into the published array.
          const windowed = isWindowedTranscript(state);
          const seated =
            materialized === null || !windowed
              ? state.transcriptWindow
              : appendLiveRecords(state.transcriptWindow, {
                  messages: [materialized],
                  events: [],
                });
          // The steer-restart remap is the SAME rule one step on: it renames a `turnId` across every row
          // carrying it, and on this line those rows live in the window too.
          const remap = turnRemapFor({ previousTurnId, nextTurnId });
          const nextWindow =
            remap === null || !windowed
              ? seated
              : mapWindowMessages(seated, remap, imageWitnesses);
          const nextMessages = turnStateMessages({
            windowed,
            previousMessages: state.messages,
            previousWindow: state.transcriptWindow,
            nextWindow,
            materialized,
            turnIds: { previousTurnId, nextTurnId },
          });
          // Clear liveTurnUsage on any turn transition (turnId changes or activeTurn settles to null).
          const turnIdChanged = previousTurnId !== nextTurnId;
          const nextBackgroundItems =
            frame.backgroundItems ?? state.backgroundItems;
          const settledPatch = reconcileTurnSettled(
            turnSettledFromStatus(frame.turnInProgress, frame.runStatus),
            {
              pendingActions: state.pendingActions,
              pendingUserMessages: state.pendingUserMessages,
              messages: nextMessages,
              queue: state.queue,
              failedSendRestoration: state.failedSendRestoration,
              currentSettings: state.currentComposerSettings,
              currentAccountContext:
                useAccountContextStore.getState().accountContext,
              worktreePartition,
              acceptedActions: state.acceptedActions,
            },
          );
          restoredWorktreeIntentForTurnState =
            settledPatch.restoredWorktreeIntent;
          return {
            // Taken FIELD BY FIELD, never spread.
            pendingUserMessages: settledPatch.pendingUserMessages,
            failedSendRestoration: settledPatch.failedSendRestoration,
            // Left unretired, the unconfirmed record survived the live settle and the next snapshot recovered
            // the same send a second time.
            acceptedActions: withoutSettledAcceptedActions(
              state.acceptedActions,
              settledPatch.settledAcceptedActionIds,
            ),
            errorNotices: appendErrorNoticeDelta(
              state.errorNotices,
              settledPatch.appendedErrorNotices,
              state.deliveredNoticeActionIds,
            ),
            messages: nextMessages,
            // Same object when nothing above touched it, so the windowed subscribers that compare by identity
            // see no change on the ordinary turn transition.
            transcriptWindow: nextWindow,
            runStatus: frame.runStatus,
            activeTurn: frame.activeTurn,
            turnInProgress: frame.turnInProgress ?? state.turnInProgress,
            backgroundItems: nextBackgroundItems,
            // Keep background-stop pending state in lockstep with the running-only list: a task that has left
            // the list settled, so its Stop is no longer in flight.
            ...backgroundStopSlices(state, nextBackgroundItems),
            liveAssistantMessage: liveAssistantForTurnStateFrame({
              current: state.liveAssistantMessage,
              previousTurnId,
              activeTurn: frame.activeTurn,
              messages: nextMessages,
            }),
            ...(turnIdChanged ? { liveTurnUsage: null } : {}),
          };
        });
        // The other path that grows the window without seating a range: `appendLiveRecords` adds the
        // materialized row and `mapWindowMessages` rewrites every record carrying the remapped turn.
        evictWindowAfterInPlaceGrowth();
        // ...and the eviction guard is NOT the re-settle.
        commitWholeSetSliceBudget();
        // Routed through the shared decider rather than calling `restoreStagedWorktreeIntent` directly, so
        // the swept-claimant rule is applied here too.
        const handedBackForTurnState = restoreOneWorktreeIntent(
          restoredWorktreeIntentForTurnState,
          [],
          {
            surface: "owner",
            hostId: options.hostId,
            epicId: options.epicId,
            ownerKind: "chat",
            ownerId: options.chatId,
          },
          get().failedSendRestoration,
        );
        recordStagedRevisionFor(
          restoredWorktreeIntentForTurnState,
          handedBackForTurnState,
        );
        maybeDispatchPendingBackgroundSessionStop(set, get);
        // Same `??` fallbacks as the updater above, against the deferred snapshot's own baseline rather
        // than the store's: an older host omits both fields, and "omitted" means "unchanged", not
        advanceDeferredSnapshotAux((held) => ({
          runStatus: frame.runStatus,
          activeTurn: frame.activeTurn,
          turnInProgress: frame.turnInProgress ?? held.turnInProgress,
          backgroundItems: frame.backgroundItems ?? held.backgroundItems,
        }));
      },
      onBlockDelta: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // The chat stream is the only source that can prove a success happened after a renderer-local
        // transport failure.
        if (
          frame.event.type === "turn.completed" &&
          get().activeTurn?.turnId === frame.event.turnId &&
          notificationUserId !== null &&
          notificationDependencies.appLocalNotifications.getState()
            .activeUserId === notificationUserId
        ) {
          const observedAt = Date.now();
          notificationDependencies.appLocalNotifications
            .getState()
            .markEntityAsRead(
              options.hostId,
              { epicId: options.epicId, chatId: options.chatId },
              observedAt,
            );
          // Every renderer has its own app-local Zustand store. Broadcast the same live, causally-qualified
          // proof so a sibling window whose stream died can acknowledge its copy of the earlier failure too.
          notificationDependencies.completionAcknowledgements.publish({
            userId: notificationUserId,
            originHostId: options.hostId,
            epicId: options.epicId,
            chatId: options.chatId,
            turnId: frame.event.turnId,
            observedAt,
          });
        }
        bufferedDeltas.push(frame.event);
        lease.requestFlush();
        // The `code: "auth"` error frame is the one live push that flips the re-auth banner on
        // mid-session.
        if (
          frame.event.type === "error" &&
          frame.event.code === AUTH_ERROR_CODE
        ) {
          // Nudge `providers.list` to refetch (and read the host's poisoned `unauthenticated`) so the banner
          // mounts + send blocks.
          if (options.onProviderAuthError !== null) {
            nudgedAuthErrorTurnId = get().activeTurn?.turnId ?? null;
            options.onProviderAuthError();
          }
        }
      },
      onApprovalRequested: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => ({
          pendingApprovals: upsertApproval(
            state.pendingApprovals,
            frame.approval,
          ),
        }));
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux((held) => ({
          pendingApprovals: [
            ...upsertApproval(held.pendingApprovals, frame.approval),
          ],
        }));
      },
      onApprovalResolved: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => ({
          pendingApprovals: state.pendingApprovals.filter(
            (approval) => approval.approvalId !== frame.approvalId,
          ),
        }));
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux((held) => ({
          pendingApprovals: held.pendingApprovals.filter(
            (approval) => approval.approvalId !== frame.approvalId,
          ),
        }));
      },
      onFileEditApprovalRequested: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => ({
          pendingFileEditApprovals: upsertFileEditApproval(
            state.pendingFileEditApprovals,
            frame.approval,
          ),
        }));
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux((held) => ({
          pendingFileEditApprovals: [
            ...upsertFileEditApproval(
              held.pendingFileEditApprovals,
              frame.approval,
            ),
          ],
        }));
      },
      onFileEditApprovalResolved: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => ({
          pendingFileEditApprovals: state.pendingFileEditApprovals.filter(
            (approval) => approval.approvalId !== frame.approvalId,
          ),
        }));
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux((held) => ({
          pendingFileEditApprovals: held.pendingFileEditApprovals.filter(
            (approval) => approval.approvalId !== frame.approvalId,
          ),
        }));
      },
      onInterviewRequested: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // Consuming frame: the host emits this interview's `blockDelta` first, but that delta is still
        // buffered until the next coordinator tick.
        flushBlockDeltas();
        set((state) => ({
          pendingInterviews: upsertPendingInterview(state.pendingInterviews, {
            blockId: frame.blockId,
            requestedAt: frame.requestedAt,
          }),
        }));
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux((held) => ({
          pendingInterviews: [
            ...upsertPendingInterview(held.pendingInterviews, {
              blockId: frame.blockId,
              requestedAt: frame.requestedAt,
            }),
          ],
        }));
      },
      onInterviewAnswered: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        const state = get();
        const lifecycle = interviewLifecycleTranscript(state, {
          kind: "answered",
          blockId: frame.blockId,
          settlementId: frame.settlementId,
          settlementSource: frame.settlementSource,
          resolvedAt: frame.resolvedAt,
          answers: frame.answers,
          reason: null,
          outcome: "answered",
          draftAnswers: [],
          delivery: frame.delivery,
        });
        const resolvedPendingOwner =
          lifecycle.resolvedPendingOwner ||
          (!lifecycle.matchedOwner &&
            state.pendingInterviews.some(
              (interview) => interview.blockId === frame.blockId,
            ));
        const { messages, liveAssistantMessage } = lifecycle.patch;
        set({
          ...lifecycle.patch,
          pendingInterviews: resolvedPendingOwner
            ? withoutPendingInterview(state.pendingInterviews, frame.blockId)
            : state.pendingInterviews,
          pendingActions: resolvedPendingOwner
            ? withoutInterviewActionsForBlock(
                state.pendingActions,
                frame.blockId,
              )
            : state.pendingActions,
          acceptedActions: withoutSupersededInterviewDeliveryRetryActions(
            resolvedPendingOwner
              ? withoutInterviewActionsForBlock(
                  state.acceptedActions,
                  frame.blockId,
                )
              : state.acceptedActions,
            messages,
            liveAssistantMessage,
            null,
          ),
        });
        // Unconditional, unlike the store write above. `resolvedPendingOwner` asks whether the STORE still
        // listed this interview; a deferred snapshot is a different list and may still carry it.
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux((held) => ({
          pendingInterviews: [
            ...withoutPendingInterview(held.pendingInterviews, frame.blockId),
          ],
        }));
        if (resolvedPendingOwner) {
          useInterviewDraftStore
            .getState()
            .clearDraft(frame.chatId, frame.blockId);
        }
      },
      onInterviewErrored: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        const state = get();
        const lifecycle = interviewLifecycleTranscript(state, {
          kind: "errored",
          blockId: frame.blockId,
          settlementId: frame.settlementId,
          settlementSource: frame.settlementSource,
          resolvedAt: frame.resolvedAt,
          answers: [],
          reason: frame.reason,
          outcome: frame.outcome,
          draftAnswers: frame.draftAnswers,
          delivery: frame.delivery,
        });
        const resolvedPendingOwner =
          lifecycle.resolvedPendingOwner ||
          (!lifecycle.matchedOwner &&
            state.pendingInterviews.some(
              (interview) => interview.blockId === frame.blockId,
            ));
        const { messages, liveAssistantMessage } = lifecycle.patch;
        set({
          ...lifecycle.patch,
          pendingInterviews: resolvedPendingOwner
            ? withoutPendingInterview(state.pendingInterviews, frame.blockId)
            : state.pendingInterviews,
          pendingActions: resolvedPendingOwner
            ? withoutInterviewActionsForBlock(
                state.pendingActions,
                frame.blockId,
              )
            : state.pendingActions,
          acceptedActions: withoutSupersededInterviewDeliveryRetryActions(
            resolvedPendingOwner
              ? withoutInterviewActionsForBlock(
                  state.acceptedActions,
                  frame.blockId,
                )
              : state.acceptedActions,
            messages,
            liveAssistantMessage,
            null,
          ),
        });
        // Unconditional, unlike the store write above. `resolvedPendingOwner` asks whether the STORE still
        // listed this interview; a deferred snapshot is a different list and may still carry it.
        commitWholeSetSliceBudget();
        advanceDeferredSnapshotAux((held) => ({
          pendingInterviews: [
            ...withoutPendingInterview(held.pendingInterviews, frame.blockId),
          ],
        }));
        if (resolvedPendingOwner) {
          useInterviewDraftStore
            .getState()
            .clearDraft(frame.chatId, frame.blockId);
        }
      },
      onEventAppended: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        if (windowedLine) {
          takeLiveRecords({ messages: [], events: [frame.event] });
          return;
        }
        set((state) => ({
          events: eventExists(state.events, frame.event.eventId)
            ? state.events
            : [...state.events, frame.event],
        }));
        // Same asymmetry as `onMessageAccepted`, and the same remedy: the early return above settles
        // through `takeLiveRecords`, this arm did not settle at all.
        commitLegacyTranscriptBudget();
      },
      onRestoreStarted: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set({
          restore: {
            kind: "in-flight",
            checkpointId: frame.checkpointId,
            restoringUserId: frame.restoringUserId,
            restoringHostId: frame.restoringHostId,
            startedAt: frame.startedAt,
            connectionEpoch,
          },
        });
      },
      onRestoreProgress: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => {
          const prev = state.restore;
          // Progress frames only refine the matching in-flight/progress entry. Late-arriving progress for a
          // previous checkpoint or for a flow that already completed is ignored.
          if (
            prev === null ||
            prev.kind === "completed" ||
            prev.checkpointId !== frame.checkpointId
          ) {
            return state;
          }
          return {
            restore: {
              kind: "progressing",
              checkpointId: prev.checkpointId,
              restoringUserId: prev.restoringUserId,
              restoringHostId: prev.restoringHostId,
              startedAt: prev.startedAt,
              processedCount: frame.processedCount,
              totalCount: frame.totalCount,
              // A progress frame is live proof the restore is still running on THIS connection - refresh the
              // stamp so the next snapshot does not clear an actively-progressing slot.
              connectionEpoch,
            },
          };
        });
      },
      onRestoreCompleted: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set({
          restore: {
            kind: "completed",
            checkpointId: frame.checkpointId,
            finishedAt: frame.finishedAt,
            results: [...frame.results],
          },
        });
      },
      onErrorNotice: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => ({
          errorNotices: appendErrorNotice(
            state.errorNotices,
            frame.notice,
            state.deliveredNoticeActionIds,
          ),
        }));
      },
      onConnectionStatus: (status, reason) => {
        if (disposed) return;
        if (status === "reconnecting" || status === "closed") {
          // Frames dispatched on the lost connection can no longer be answered. Only stamps get older here -
          // nothing is cancelled until an authoritative post-reconnect snapshot arrives.
          connectionEpoch += 1;
        }
        set((state) => {
          // Capture a fatal close so the tile can show the host's reason (e.g. CHAT_INVALID) instead of
          // spinning forever.
          const resolveFatalClose = () => {
            if (status !== "closed") return null;
            if (reason?.kind === "fatalError") return reason.details;
            return state.fatalClose;
          };
          // The negotiated `chat.subscribe` version is stable per connection and available once the
          // handshake completes (status `open`).
          const resolveSteerProtocolSupported = () => {
            if (status === "open") {
              return streamClient?.sameTurnSteeringProtocolSupported() ?? false;
            }
            return false;
          };
          const resolveInterviewDeliveryRetryProtocolSupported = () => {
            if (status === "open") {
              return (
                streamClient?.interviewSettlementActionsProtocolSupported?.() ??
                false
              );
            }
            return false;
          };
          return {
            connectionStatus: status,
            runStatus: status === "closed" ? "idle" : state.runStatus,
            activeTurn: status === "closed" ? null : state.activeTurn,
            steerProtocolSupported: resolveSteerProtocolSupported(),
            interviewDeliveryRetryProtocolSupported:
              resolveInterviewDeliveryRetryProtocolSupported(),
            fatalClose: resolveFatalClose(),
          };
        });
        if (
          isUnauthorizedClose(status, reason) &&
          options.onAuthError !== null
        ) {
          options.onAuthError();
        }
      },
    };

    /**
     * The stream-facing callbacks: every frame this store accepts, each inert once its generation is
     * retired.
     */
    const makeCallbacks = (streamGeneration: number): ChatStreamCallbacks => {
      const guarded = <TArgs extends unknown[]>(
        handler: (...args: TArgs) => void,
      ): ((...args: TArgs) => void) =>
        guardHandler(streamGuard, streamGeneration, handler);
      return {
        onSnapshot: (frame) => {
          if (!streamGuard.isCurrent(streamGeneration)) return;
          callbacks.onSnapshot(frame);
          const activeTurnId = get().activeTurn?.turnId ?? null;
          if (activeTurnId !== null && activeTurnId !== fatalCloseTurnId) {
            fatalCloseTurnId = null;
          }
        },
        onWorktreeStateChanged: guarded(callbacks.onWorktreeStateChanged),
        onManagedCommandsChanged: guarded(callbacks.onManagedCommandsChanged),
        onHeldUpdatesChanged: guarded(callbacks.onHeldUpdatesChanged),
        // Guarded like every frame above rather than passed through: whatever binds these must not apply a
        // hydration response from a stream generation this store has already replaced.
        onWindowedSnapshot: guarded(callbacks.onWindowedSnapshot),
        onSkeletonChunk: guarded(callbacks.onSkeletonChunk),
        onIndexChanged: guarded(callbacks.onIndexChanged),
        onRange: guarded(callbacks.onRange),
        onAccumulatedChanges: guarded(callbacks.onAccumulatedChanges),
        onActionAck: guarded(callbacks.onActionAck),
        onMessageAccepted: guarded(callbacks.onMessageAccepted),
        onQueueChanged: guarded(callbacks.onQueueChanged),
        onTurnStateChanged: (frame) => {
          if (!streamGuard.isCurrent(streamGeneration)) return;
          callbacks.onTurnStateChanged(frame);
          const activeTurnId = get().activeTurn?.turnId ?? null;
          if (activeTurnId !== null && activeTurnId !== fatalCloseTurnId) {
            fatalCloseTurnId = null;
          }
        },
        onBlockDelta: guarded(callbacks.onBlockDelta),
        onApprovalRequested: guarded(callbacks.onApprovalRequested),
        onApprovalResolved: guarded(callbacks.onApprovalResolved),
        onFileEditApprovalRequested: guarded(
          callbacks.onFileEditApprovalRequested,
        ),
        onFileEditApprovalResolved: guarded(
          callbacks.onFileEditApprovalResolved,
        ),
        onInterviewRequested: guarded(callbacks.onInterviewRequested),
        onInterviewAnswered: guarded(callbacks.onInterviewAnswered),
        onInterviewErrored: guarded(callbacks.onInterviewErrored),
        onEventAppended: guarded(callbacks.onEventAppended),
        onRestoreStarted: guarded(callbacks.onRestoreStarted),
        onRestoreProgress: guarded(callbacks.onRestoreProgress),
        onRestoreCompleted: guarded(callbacks.onRestoreCompleted),
        onErrorNotice: guarded(callbacks.onErrorNotice),
        onConnectionStatus: (status, reason) => {
          if (!streamGuard.isCurrent(streamGeneration)) return;
          // A RETRYABLE fatalError is the transport saying "not now" - the client is already reconnecting on
          // its own backoff and the user needs to do nothing.
          if (
            status === "closed" &&
            reason?.kind === "fatalError" &&
            reason.details.retryable !== true &&
            fatalCloseNotificationGeneration !== streamGeneration
          ) {
            fatalCloseNotificationGeneration = streamGeneration;
            fatalCloseTurnId = get().activeTurn?.turnId ?? null;
            notificationDependencies.appLocalNotifications
              .getState()
              .upsertRecurringFailure(
                chatStreamErrorNotification({
                  hostId: options.hostId,
                  epicId: options.epicId,
                  chatId: options.chatId,
                  details: reason.details,
                }),
              );
          }
          callbacks.onConnectionStatus(status, reason);
        },
      };
    };

    const createStreamClient = (): ChatStreamClientHandle => {
      const streamGeneration = streamGuard.next();
      return options.streamClientFactory(
        options.epicId,
        options.chatId,
        makeCallbacks(streamGeneration),
      );
    };

    try {
      streamClient = createStreamClient();
    } catch (cause) {
      // The flush-coordinator lease is registered above, before the first stream is built. If the factory
      // throws (e.g.
      lease.unregister();
      // The budget holder is attached before the factory runs, and the same reasoning applies to it: no
      // handle is returned, so `dispose()` - which holds this exact pair - is unreachable for this id.
      memory.chatWindows.detach(holderId);
      memory.accountant.release(BUDGET_PLANE_IDS.chatWindows, holderId);
      throw cause;
    }

    return {
      epicId: options.epicId,
      chatId: options.chatId,
      connectionStatus: "connecting",
      fatalClose: null,
      snapshotLoaded: false,
      transcriptBaselineEpoch: NO_TRANSCRIPT_BASELINE,
      transcriptHydrationSequence: 0,
      transcriptRowContext: {},
      chat: null,
      access: null,
      messages: [],
      events: [],
      queue: EMPTY_QUEUE,
      runStatus: "idle",
      activeTurn: null,
      steerProtocolSupported: false,
      interviewDeliveryRetryProtocolSupported: false,
      turnInProgress: undefined,
      pendingApprovals: [],
      pendingFileEditApprovals: [],
      pendingInterviews: [],
      accumulatedFileChanges: [],
      transcriptWindow: emptyTranscriptWindow(),
      transcriptDerived: null,
      accumulatedFileChangeCount: 0,
      coldRewrittenMessageIds: EMPTY_COLD_REWRITTEN_IDS,
      jumpTargetOrdinal: null,
      accumulatedFileChangeSummaries: [],
      accumulatedSummaryGenerationSeated: false,
      accumulatedSummaryAssemblyStarted: false,
      backgroundItems: undefined,
      managedCommands: [],
      heldUpdates: [],
      pendingBackgroundStops: {},
      pendingBackgroundStopAll: null,
      pendingBackgroundSessionStop: null,
      restore: null,
      pendingActions: {},
      acceptedActions: {},
      pendingUserMessages: [],
      errorNotices: [],
      deliveredNoticeActionIds: new Set<string>(),
      openedSubagentCardBlockIds: new Set<string>(),
      failedSendRestoration: null,
      currentComposerSettings: null,
      liveAssistantMessage: null,
      liveTurnUsage: null,
      worktreeBinding: null,
      missingWorktreePaths: [],

      reportVisibleTranscriptRange: (range) => {
        if (disposed) return;
        applyVisibleTranscriptRange(range);
      },

      /**
       * Name (or clear) the ordinal a pending transcript jump is waiting on. Called by the surface
       * holding the jump request when its target is not in the hydrated set.
       */
      requestTranscriptOrdinal: (ordinal: number | null) => {
        if (get().jumpTargetOrdinal === ordinal) return;
        set({ jumpTargetOrdinal: ordinal });
        if (ordinal !== null) requestPlannedHydration();
      },
      retry: () => {
        if (disposed) return;
        closeStreamClient();
        clearBufferedDeltas();
        const prior = get();
        set({
          connectionStatus: "connecting",
          steerProtocolSupported: false,
          interviewDeliveryRetryProtocolSupported: false,
          fatalClose: null,
          snapshotLoaded: false,
        });
        try {
          streamClient = createStreamClient();
        } catch (cause) {
          // The replacement factory can throw (durable-transport wiring throws on a failed subscription).
          set({
            connectionStatus: "closed",
            fatalClose: prior.fatalClose,
            snapshotLoaded: prior.snapshotLoaded,
          });
          throw cause;
        }
      },
      refreshMissingWorktreePaths: (update) => {
        if (disposed) return;
        // Skip the write (and the re-render) when the on-focus recompute matches
        // what the stream already gave us - the common steady-state case.
        const current = get().missingWorktreePaths;
        const next = [
          ...(typeof update === "function" ? update(current) : update),
        ];
        if (
          current.length === next.length &&
          current.every((value, index) => value === next[index])
        ) {
          return;
        }
        set({ missingWorktreePaths: next });
      },
      sendMessage: (input) => {
        const clientActionId = uuidv4();
        const messageId = uuidv4();
        // A worktree staged mid-chat ("Create new worktree") rides on this send; the host creates it at
        // turn-start before gating on setup.
        const stagedKey: WorktreeStagingKey = {
          surface: "owner",
          hostId: options.hostId,
          epicId: options.epicId,
          ownerKind: "chat",
          ownerId: options.chatId,
        };
        if (stagedWorktreeIntentIsSuspended(stagedKey)) return null;
        const worktreeIntent = readStagedWorktreeIntent(stagedKey);
        const browserAnnotations = input.attachments.filter(
          (attachment): attachment is BrowserAnnotationRecord =>
            attachment.kind === "browser-annotation",
        );
        const frame: ChatOwnerActionFrame = {
          kind: "send",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          messageId,
          content: input.content,
          sender: input.sender,
          settings: input.settings,
          accountContext: useAccountContextStore.getState().accountContext,
          deliveryPolicy: input.deliveryPolicy,
          worktreeIntent,
          browserAnnotations,
        };
        // Consume before dispatch so the pending action captures precisely the revision it may later
        // restore. A synchronous action rejection cannot race ahead of this transition.
        const stagingStore = useWorktreeIntentStagingStore.getState();
        // Unconditional: a dispatch is this slot's current state whether or not it took a pick.
        const displaced = stagedDispatchDisplacement(stagedKey);
        stagingStore.consumeForDispatch(stagedKey, clientActionId);
        // Captured once, before dispatch, and reused for the optimistic echo below - a queued send (this
        // false) gets NO optimistic transcript row today.
        const rendersAsPendingUserMessage =
          shouldRenderSendAsPendingUserMessage(get());
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: {
            clientActionId,
            action: "send",
            queueItemId: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId,
            restore: input.restore,
            sender: input.sender,
            settings: input.settings,
            accountContext: frame.accountContext,
            restoreWorktreeIntent: worktreeIntent,
            displayWorktreeIntent: worktreeIntent,
            messageConfirmedByHost: false,
            deliveryPolicy: frame.deliveryPolicy,
            createdAt: Date.now(),
          },
          // Echo the user message optimistically so it paints INSTANTLY on send - including a
          // worktree-creating send.
          pendingUserMessage: rendersAsPendingUserMessage
            ? {
                clientActionId,
                messageId,
                content: input.content,
                attachments: input.attachments,
                sender: input.sender,
                settings: input.settings,
                timestamp: Date.now(),
                restore: input.restore,
                accountContext: frame.accountContext,
                deliveryPolicy: frame.deliveryPolicy,
                restoreWorktreeIntent: worktreeIntent,
              }
            : null,
        });
        if (sentClientActionId === null) {
          // This send never reached the wire, so the slot goes back exactly as it was found - the pick AND
          // everything the consume displaced. An unconditional consume needs an unconditional rollback.
          stagingStore.rollBackDispatch(stagedKey, {
            intent: worktreeIntent,
            displaced,
          });
          return null;
        }
        const optimisticQueuedItem = optimisticQueuedItemForSend({
          state: get(),
          clientActionId,
          messageId,
          content: input.content,
          sender: input.sender,
          settings: input.settings,
        });
        if (optimisticQueuedItem !== null) {
          set((state) => ({
            queue: appendOptimisticQueuedItem(
              state.queue,
              optimisticQueuedItem,
            ),
          }));
          commitWholeSetSliceBudget();
        }
        // Consume the staged worktree once it's on the wire so a later send doesn't re-create it (the
        // frame carries it across transport retries).
        if (worktreeIntent !== null) {
          useWorktreeIntentMemoryStore
            .getState()
            .setEpicIntent(
              options.epicId,
              options.hostId,
              worktreeIntent,
              Date.now(),
            );
          get().refreshMissingWorktreePaths([]);
        }
        return { clientActionId: sentClientActionId, messageId };
      },

      setCurrentComposerSettings: (settings) => {
        set((state) => {
          if (
            state.currentComposerSettings !== null &&
            chatRunSettingsEqual(state.currentComposerSettings, settings)
          ) {
            return state;
          }
          return { currentComposerSettings: settings };
        });
      },
      sendSeededUserMessage: (input) => {
        // Sends the first message using the handoff's PRE-MINTED ids (shared with the optimistic seed and
        // the host's turn-overlap idempotency gate), so the seed reconciles cleanly and the host never
        const frame: ChatOwnerActionFrame = {
          kind: "send",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId: input.clientActionId,
          messageId: input.messageId,
          content: input.content,
          sender: input.sender,
          settings: input.settings,
          // Account context is GLOBAL, not per-chat: read the live selection at
          // dispatch as a sibling of the per-chat `settings`.
          accountContext: useAccountContextStore.getState().accountContext,
          deliveryPolicy: "auto",
          // The landing handoff carries its worktree intent via `epic.create`,
          // not the send frame.
          worktreeIntent: null,
          browserAnnotations: [],
        };
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: {
            clientActionId: input.clientActionId,
            action: "send",
            queueItemId: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId: input.messageId,
            restore: { content: input.content, browserAnnotations: [] },
            sender: input.sender,
            settings: input.settings,
            restoreWorktreeIntent: null,
            displayWorktreeIntent: null,
            messageConfirmedByHost: false,
            // The DISPATCHED context, not a default.
            accountContext: frame.accountContext,
            deliveryPolicy: frame.deliveryPolicy,
            createdAt: Date.now(),
          },
          pendingUserMessage: {
            clientActionId: input.clientActionId,
            messageId: input.messageId,
            content: input.content,
            attachments: buildAttachmentsFromJSONContent(input.content),
            sender: input.sender,
            settings: input.settings,
            accountContext: frame.accountContext,
            deliveryPolicy: frame.deliveryPolicy,
            timestamp: Date.now(),
            restore: { content: input.content, browserAnnotations: [] },
            // The landing handoff's worktree rides `epic.create`, not this
            // send, so there is no staged slot for it to give back.
            restoreWorktreeIntent: null,
          },
        });
        if (sentClientActionId === null) return null;
        return {
          clientActionId: sentClientActionId,
          messageId: input.messageId,
        };
      },
      deleteMessageSuffix: (fromMessageId) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "deleteMessageSuffix",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          fromMessageId,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "deleteMessageSuffix"),
          pendingUserMessage: null,
        });
      },
      editUserMessage: (input) => {
        const clientActionId = uuidv4();
        const messageId = uuidv4();
        const stagedKey: WorktreeStagingKey = {
          surface: "owner",
          hostId: options.hostId,
          epicId: options.epicId,
          ownerKind: "chat",
          ownerId: options.chatId,
        };
        if (stagedWorktreeIntentIsSuspended(stagedKey)) return null;
        const worktreeIntent = readStagedWorktreeIntent(stagedKey);
        const frame: ChatOwnerActionFrame = {
          kind: "editUserMessage",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          targetMessageId: input.targetMessageId,
          messageId,
          content: input.content,
          sender: input.sender,
          settings: input.settings,
          accountContext: useAccountContextStore.getState().accountContext,
          worktreeIntent,
          revertFileChanges: input.revertFileChanges,
          revertArtifacts: input.revertArtifacts,
        };
        // Consume before dispatch, exactly like `sendMessage`: the pending action captures the staging
        // revision it may later restore, so a rejected edit (e.g.
        const stagingStore = useWorktreeIntentStagingStore.getState();
        // Unconditional: a dispatch is this slot's current state whether or not it took a pick.
        const displaced = stagedDispatchDisplacement(stagedKey);
        stagingStore.consumeForDispatch(stagedKey, clientActionId);
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: {
            clientActionId,
            action: "editUserMessage",
            queueItemId: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId,
            restore: null,
            sender: null,
            settings: null,
            restoreWorktreeIntent: worktreeIntent,
            displayWorktreeIntent: worktreeIntent,
            messageConfirmedByHost: false,
            accountContext: null,
            deliveryPolicy: null,
            createdAt: Date.now(),
          },
          pendingUserMessage: null,
        });
        if (sentClientActionId === null) {
          // Same rule as `sendMessage`: a refused dispatch restores everything
          // it displaced, not just the pick.
          stagingStore.rollBackDispatch(stagedKey, {
            intent: worktreeIntent,
            displaced,
          });
          return null;
        }
        if (worktreeIntent !== null) {
          useWorktreeIntentMemoryStore
            .getState()
            .setEpicIntent(
              options.epicId,
              options.hostId,
              worktreeIntent,
              Date.now(),
            );
          get().refreshMissingWorktreePaths([]);
        }
        return { clientActionId: sentClientActionId, messageId };
      },
      revertFileChanges: (fromMessageId, filePaths, revertArtifacts) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "revertFileChanges",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          fromMessageId,
          filePaths: filePaths === null ? null : [...filePaths],
          revertArtifacts,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "revertFileChanges"),
          pendingUserMessage: null,
        });
      },
      stopTurn: () => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "stop",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          turnId: get().activeTurn?.turnId ?? null,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: {
            clientActionId,
            action: "stop",
            queueItemId: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId: null,
            restore: null,
            sender: null,
            settings: null,
            restoreWorktreeIntent: null,
            displayWorktreeIntent: null,
            messageConfirmedByHost: false,
            accountContext: null,
            deliveryPolicy: null,
            createdAt: Date.now(),
          },
          pendingUserMessage: null,
        });
      },
      stopBackgroundItem: (taskId) => {
        const state = get();
        const items = state.backgroundItems;
        // Unsupported by this provider (sentinel), a stop-all already in flight, this task already
        // stopping, or the task no longer in the host's running-only list: no-op, so no duplicate stop
        if (items === undefined) return null;
        if (state.pendingBackgroundStopAll !== null) return null;
        if (Object.hasOwn(state.pendingBackgroundStops, taskId)) return null;
        if (!items.some((item) => item.taskId === taskId)) return null;
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "stopBackgroundItem",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          taskId,
        };
        const sent = sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "stopBackgroundItem"),
          pendingUserMessage: null,
        });
        if (sent === null) return null;
        set((current) => ({
          pendingBackgroundStops: {
            ...current.pendingBackgroundStops,
            [taskId]: sent,
          },
        }));
        return sent;
      },
      stopAllBackgroundItems: () => {
        const state = get();
        const items = state.backgroundItems;
        // Unsupported sentinel, a stop-all already in flight, an accepted row stop still pending, or
        // nothing running: ignore so a rapid repeat does not enqueue duplicate stop frames.
        if (items === undefined) return null;
        if (state.pendingBackgroundStopAll !== null) return null;
        if (Object.keys(state.pendingBackgroundStops).length > 0) return null;
        if (items.length === 0) return null;
        const taskIds = new Set(items.map((item) => item.taskId));
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "stopAllBackgroundItems",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
        };
        const sent = sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "stopAllBackgroundItems"),
          pendingUserMessage: null,
        });
        if (sent === null) return null;
        set(() => ({
          pendingBackgroundStopAll: { clientActionId: sent, taskIds },
        }));
        return sent;
      },
      stopBackgroundSession: () => {
        const state = get();
        const items = state.backgroundItems;
        // Only meaningful when the host flagged a command as not individually stoppable - which also
        // proves the host understands this action, so the capability field doubles as the send gate.
        if (items === undefined || items.length === 0) return null;
        if (state.pendingBackgroundSessionStop !== null) return null;
        if (state.pendingBackgroundStopAll !== null) return null;
        if (
          !items.some(
            (item) =>
              item.kind === "command" &&
              item.individualStopUnavailable !== null,
          )
        ) {
          return null;
        }
        const turnActive = state.turnInProgress ?? state.activeTurn !== null;
        if (turnActive) {
          // Phase one: end the turn cleanly first.
          const stopSent = get().stopTurn();
          if (stopSent === null) return null;
          set(() => ({
            pendingBackgroundSessionStop: {
              clientActionId: stopSent,
              awaitingTurnEnd: true,
              turnId: state.activeTurn?.turnId ?? null,
            },
          }));
          return stopSent;
        }
        return sendBackgroundSessionStopFrame({ set, get });
      },
      pauseQueue: () => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "pauseQueue",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "pauseQueue"),
          pendingUserMessage: null,
        });
      },
      resumeQueue: () => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "resumeQueue",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "resumeQueue"),
          pendingUserMessage: null,
        });
      },
      queueEdit: (queueItemId, content) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "queueEdit",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          queueItemId,
          content,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "queueEdit"),
          pendingUserMessage: null,
        });
      },
      queueCancel: (queueItemId) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "queueCancel",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          queueItemId,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: {
            ...basicPending(clientActionId, "queueCancel"),
            queueItemId,
          },
          pendingUserMessage: null,
        });
      },
      queueReorder: (queueItemId, beforeQueueItemId) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "queueReorder",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          queueItemId,
          beforeQueueItemId,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "queueReorder"),
          pendingUserMessage: null,
        });
      },
      queueSteerNow: (queueItemId, newSettings) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "queueSteerNow",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          queueItemId,
          newSettings,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "queueSteerNow"),
          pendingUserMessage: null,
        });
      },
      queueAbortSteer: (queueItemId) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "queueAbortSteer",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          queueItemId,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "queueAbortSteer"),
          pendingUserMessage: null,
        });
      },
      restampQueuedItemSettings: (settings, excludeQueueItemId) => {
        // Only still-pending items live-mirror. Items mid-steer (steer_requested/steering/injected) locked
        // their settings at steer start; paused items keep their own.
        const pendingItems = get().queue.items.filter(
          (item: ChatQueuedItem) =>
            item.kind === "prompt" &&
            item.sender.type !== "agent" &&
            item.status === "pending" &&
            item.queueItemId !== excludeQueueItemId &&
            !chatRunSettingsEqual(item.settings, settings),
        );
        if (pendingItems.length === 0) return;
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "queueSettingsRestamp",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          settings,
          // Account context is GLOBAL, not per-chat: read the live selection at
          // dispatch as a sibling of the per-chat `settings`.
          accountContext: useAccountContextStore.getState().accountContext,
          excludeQueueItemId,
        };
        sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "queueSettingsRestamp"),
          pendingUserMessage: null,
        });
      },
      queueSettingsUpdate: (queueItemId, settings) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "queueSettingsUpdate",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          queueItemId,
          settings,
          accountContext: useAccountContextStore.getState().accountContext,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "queueSettingsUpdate"),
          pendingUserMessage: null,
        });
      },
      updateActivePermissionMode: (permissionMode) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "activePermissionModeUpdate",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          permissionMode,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "activePermissionModeUpdate"),
          pendingUserMessage: null,
        });
      },
      updateActiveProfile: (harnessId, profileId) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "activeProfileUpdate",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          harnessId,
          profileId,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "activeProfileUpdate"),
          pendingUserMessage: null,
        });
      },
      approvalDecision: (approvalId, decision) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "approvalDecision",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          approvalId,
          decision,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "approvalDecision"),
          pendingUserMessage: null,
        });
      },
      fileEditApprovalDecision: (approvalId, decision) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "fileEditApprovalDecision",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          approvalId,
          decision,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "fileEditApprovalDecision"),
          pendingUserMessage: null,
        });
      },
      restoreCheckpoint: (checkpointId, revertArtifacts) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "restoreCheckpoint",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          checkpointId,
          revertArtifacts,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "restoreCheckpoint"),
          pendingUserMessage: null,
        });
      },
      interviewAnswer: (blockId, answers) => {
        const existing = existingInterviewActionId(get(), blockId);
        if (existing !== null) return existing;
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "interviewAnswer",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          blockId,
          answers: [...answers],
        };
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: {
            ...basicPending(clientActionId, "interviewAnswer"),
            interviewBlockId: blockId,
          },
          pendingUserMessage: null,
        });
        return sentClientActionId;
      },
      interviewSkip: (blockId, reason, draftAnswers) => {
        const existing = existingInterviewActionId(get(), blockId);
        if (existing !== null) return existing;
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "interviewError",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          blockId,
          reason,
          settlement:
            draftAnswers === undefined
              ? null
              : { outcome: "skipped", draftAnswers: [...draftAnswers] },
        };
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: {
            ...basicPending(clientActionId, "interviewError"),
            interviewBlockId: blockId,
          },
          pendingUserMessage: null,
        });
        return sentClientActionId;
      },
      interviewDeliveryRetry: (identity) => {
        // The retry action is additive in protocol 1.7. Do not let a renderer
        // paired with an older host emit an unknown frame.
        if (!get().interviewDeliveryRetryProtocolSupported) return null;
        const existing = existingInterviewDeliveryRetryActionId(
          get(),
          identity,
        );
        if (existing !== null) return existing;
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "interviewDeliveryRetry",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          blockId: identity.blockId,
          settlementId: identity.settlementId,
          deliveryId: identity.deliveryId,
          generation: identity.generation,
        };
        return sendAction({
          set,
          get,
          frame,
          pending: {
            ...basicPending(clientActionId, "interviewDeliveryRetry"),
            interviewDeliveryRetry: identity,
          },
          pendingUserMessage: null,
        });
      },
      ackAcceptedAction: (clientActionId) => {
        set((state) => {
          if (!Object.hasOwn(state.acceptedActions, clientActionId)) {
            return state;
          }
          const next = { ...state.acceptedActions };
          delete next[clientActionId];
          return { acceptedActions: next };
        });
      },
      markNoticeDelivered: (clientActionId) => {
        set((state) => {
          if (state.deliveredNoticeActionIds.has(clientActionId)) return {};
          const next = new Set(state.deliveredNoticeActionIds);
          addWithFifoEviction(
            next,
            clientActionId,
            MAX_DELIVERED_CLIENT_ACTION_IDS,
          );
          return { deliveredNoticeActionIds: next };
        });
      },
      stateFailedSendRestoration: (clientActionId) => {
        const stagedRevision =
          stagingRevisionByRestoredAction.get(clientActionId);
        if (stagedRevision !== undefined) {
          useWorktreeIntentStagingStore
            .getState()
            .releaseIntentForDispatch(ownerStagingKey, stagedRevision);
          stagingRevisionByRestoredAction.delete(clientActionId);
        }
        set((state) => {
          const restoration = state.failedSendRestoration;
          if (restoration?.clientActionId !== clientActionId) return {};
          return {
            failedSendRestoration: null,
            errorNotices: appendErrorNotice(
              state.errorNotices,
              displacedRestorationNotice(
                clientActionId,
                restoration.content,
                // The DISPLACED variant, baked at slot creation: its worktree clauses read `handedBack: false`,
                // because the binding is not going back with the prompt and has just been released.
                restoration.displacedReason,
              ),
              state.deliveredNoticeActionIds,
            ),
          };
        });
      },
      ackFailedSendRestoration: (clientActionId) => {
        // The composer TOOK the prompt, so its binding stays staged with it.
        stagingRevisionByRestoredAction.delete(clientActionId);
        set((state) => {
          const restoration = state.failedSendRestoration;
          if (restoration?.clientActionId !== clientActionId) return {};
          // Spoken exactly once - but "spoken" means REACHED THE USER, not "was appended".
          if (
            restoration.stated &&
            state.deliveredNoticeActionIds.has(clientActionId)
          ) {
            return { failedSendRestoration: null };
          }
          // The draft has just landed in the composer, so this is the moment its account is worth reading -
          // and the only moment both handoff branches share.
          return {
            failedSendRestoration: null,
            errorNotices: appendErrorNotice(
              state.errorNotices,
              {
                code: SEND_RESTORED_NOTICE_CODE,
                message: restoration.reason,
                severity: "warning",
                clientActionId,
              },
              state.deliveredNoticeActionIds,
            ),
          };
        });
      },
      takeSetupFailedRestoration: (messageId) => {
        const state = get();
        const pendingUserMatch = state.pendingUserMessages.find(
          (message) => message.messageId === messageId,
        );
        const pendingActionMatch = findRestorableSendByMessageId(
          Object.values(state.pendingActions),
          messageId,
        );
        const acceptedActionMatch = findRestorableSendByMessageId(
          Object.values(state.acceptedActions),
          messageId,
        );
        const restored =
          pendingUserMatch?.content ??
          pendingActionMatch?.content ??
          acceptedActionMatch?.content ??
          null;
        if (restored === null) return null;
        // Clear every restorable slot in lockstep so a duplicate `setup.failed` event cannot
        // double-restore.
        set({
          pendingUserMessages:
            pendingUserMatch === undefined
              ? state.pendingUserMessages
              : state.pendingUserMessages.filter(
                  (message) => message.messageId !== messageId,
                ),
          pendingActions:
            pendingActionMatch === null
              ? state.pendingActions
              : {
                  ...state.pendingActions,
                  [pendingActionMatch.entry.clientActionId]: {
                    ...pendingActionMatch.entry,
                    restore: null,
                  },
                },
          acceptedActions:
            acceptedActionMatch === null
              ? state.acceptedActions
              : {
                  ...state.acceptedActions,
                  [acceptedActionMatch.entry.clientActionId]: {
                    ...acceptedActionMatch.entry,
                    restore: null,
                  },
                },
        });
        return restored;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        liveChatSessionStores.delete(store);
        unsubscribeLiveCompletionAcknowledgements();
        lease.unregister();
        clearBufferedDeltas();
        clearInFlightHydration();
        recovery.dropAll();
        clearResnapshotRequestTimer();
        clearStreamCompletionWatchdog();
        legacyTranscriptAdapter.detach("disposed");
        memory.chatWindows.detach(holderId);
        memory.accountant.release(BUDGET_PLANE_IDS.chatWindows, holderId);
        closeStreamClient();
      },
    };
  });

  if (notificationUserId !== null) {
    unsubscribeLiveCompletionAcknowledgements =
      notificationDependencies.completionAcknowledgements.subscribe(
        (acknowledgement) => {
          const activeTurnId = store.getState().activeTurn?.turnId ?? null;
          const recoverableTurnId = activeTurnId ?? fatalCloseTurnId;
          if (
            !liveChatCompletionAcknowledgementMatches(acknowledgement, {
              userId: notificationUserId,
              originHostId: options.hostId,
              epicId: options.epicId,
              chatId: options.chatId,
              recoverableTurnId,
            })
          ) {
            return;
          }
          const notifications =
            notificationDependencies.appLocalNotifications.getState();
          if (notifications.activeUserId !== notificationUserId) return;
          // Renderer clocks share one machine clock. Preserve timestamp ties and anything later so an
          // ambiguous or genuinely newer disconnect remains red; only clearly older failures are superseded.
          notifications.markEntityAsReadBefore(
            options.hostId,
            { epicId: options.epicId, chatId: options.chatId },
            Date.now(),
            acknowledgement.observedAt,
          );
          if (activeTurnId === null) fatalCloseTurnId = null;
        },
      );
  }

  liveChatSessionStores.add(store);

  return {
    epicId: options.epicId,
    chatId: options.chatId,
    userId: options.userId,
    store,
    deliveredNotices: {
      notices: new WeakSet<ChatErrorNotice>(),
      retainedClientActionIds: new Set<string>(),
      clientActionIds: new Set<string>(),
    },
    deliveredRestoreCompletionKeys: new Set<string>(),
    setSurfaceVisibility: (surfaceId, visible) => {
      if (surfaceVisibility.get(surfaceId) === visible) return;
      surfaceVisibility.set(surfaceId, visible);
      pushSurfaceVisibility();
    },
    clearSurfaceVisibility: (surfaceId) => {
      if (!surfaceVisibility.delete(surfaceId)) return;
      pushSurfaceVisibility();
    },
    dispose: () => store.getState().dispose(),
  };
}

function matchesChat(
  options: Pick<ChatSessionStoreOptions, "epicId" | "chatId">,
  epicId: string,
  chatId: string,
): boolean {
  return options.epicId === epicId && options.chatId === chatId;
}

function isUnauthorizedClose(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): boolean {
  return (
    status === "closed" &&
    reason !== null &&
    reason.kind === "fatalError" &&
    reason.details.code === "UNAUTHORIZED"
  );
}

function basicPending(
  clientActionId: string,
  action: ChatOwnerActionFrame["kind"],
): PendingChatActionSeed {
  return {
    clientActionId,
    action,
    queueItemId: null,
    interviewBlockId: null,
    interviewDeliveryRetry: null,
    messageId: null,
    restore: null,
    sender: null,
    settings: null,
    restoreWorktreeIntent: null,
    displayWorktreeIntent: null,
    messageConfirmedByHost: false,
    accountContext: null,
    deliveryPolicy: null,
    createdAt: Date.now(),
  };
}

/** View projection for queue cancels whose durable host disposition is still outstanding. */
export function projectQueueWithPendingCancellations(
  queue: ChatQueueState,
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
): ChatQueueState {
  const hiddenQueueItemIds = new Set(
    [
      ...Object.values(pendingActions),
      ...Object.values(acceptedActions),
    ].flatMap((action) =>
      action.action === "queueCancel" && action.queueItemId !== null
        ? [action.queueItemId]
        : [],
    ),
  );
  if (hiddenQueueItemIds.size === 0) return queue;
  const items = queue.items.filter(
    (item) => !hiddenQueueItemIds.has(item.queueItemId),
  );
  return items.length === queue.items.length ? queue : { ...queue, items };
}

/** The worktree choice owned by the dispatch that most recently consumed this chat's staging slot. */
export function dispatchedWorktreeIntentForDisplay(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  clientActionId: string | null,
): WorktreeIntent | null {
  if (clientActionId === null) return null;
  let action: PendingChatAction | AcceptedChatAction | null = null;
  if (Object.hasOwn(pendingActions, clientActionId)) {
    action = pendingActions[clientActionId];
  } else if (Object.hasOwn(acceptedActions, clientActionId)) {
    action = acceptedActions[clientActionId];
  }
  return action?.displayWorktreeIntent ?? null;
}

function releasePendingWorktreeIntentDisplayByMessageId(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  messageId: string,
): Readonly<Record<string, PendingChatAction>> {
  const pending = Object.values(pendingActions).find(
    (candidate) =>
      candidate.action === "send" &&
      candidate.messageId === messageId &&
      (!candidate.messageConfirmedByHost ||
        candidate.displayWorktreeIntent !== null),
  );
  if (pending === undefined) return pendingActions;
  return {
    ...pendingActions,
    [pending.clientActionId]: {
      ...pending,
      displayWorktreeIntent: null,
      messageConfirmedByHost: true,
    },
  };
}

// The client action id of an in-flight (pending) or accepted-but-unresolved interview action for
// `blockId`, or null.
function existingInterviewActionId(
  state: ChatSessionState,
  blockId: string,
): string | null {
  const pending = Object.values(state.pendingActions).find(
    (action) => action.interviewBlockId === blockId,
  );
  if (pending !== undefined) return pending.clientActionId;
  const accepted = Object.values(state.acceptedActions).find(
    (action) => action.interviewBlockId === blockId,
  );
  return accepted?.clientActionId ?? null;
}

function sameInterviewDeliveryRetryIdentity(
  left: InterviewDeliveryRetryIdentity,
  right: InterviewDeliveryRetryIdentity,
): boolean {
  return (
    left.blockId === right.blockId &&
    left.settlementId === right.settlementId &&
    left.deliveryId === right.deliveryId &&
    left.generation === right.generation
  );
}

// Delivery retry is deliberately independent of answer/skip's block-wide
// guard. A historical retry may only dedupe the exact settled outbox attempt.
function existingInterviewDeliveryRetryActionId(
  state: ChatSessionState,
  identity: InterviewDeliveryRetryIdentity,
): string | null {
  const actions = [
    ...Object.values(state.pendingActions),
    ...Object.values(state.acceptedActions),
  ];
  const existing = actions.find(
    (action) =>
      action.interviewDeliveryRetry !== null &&
      sameInterviewDeliveryRetryIdentity(
        action.interviewDeliveryRetry,
        identity,
      ),
  );
  return existing?.clientActionId ?? null;
}

// Drop every pending/accepted action targeting `blockId`'s interview.
function withoutInterviewActionsForBlock<
  T extends { readonly interviewBlockId: string | null },
>(
  actions: Readonly<Record<string, T>>,
  blockId: string,
): Readonly<Record<string, T>> {
  const entries = Object.entries(actions).filter(
    ([, action]) => action.interviewBlockId !== blockId,
  );
  if (entries.length === Object.keys(actions).length) return actions;
  return Object.fromEntries(entries);
}

function isCurrentRetryableInterviewDelivery(
  messages: ReadonlyArray<Message>,
  liveAssistantMessage: LiveAssistantMessage | null,
  identity: InterviewDeliveryRetryIdentity,
): boolean {
  const matchesBlock = (block: ContentBlock): boolean =>
    block.type === "interview" &&
    block.blockId === identity.blockId &&
    block.settlement?.settlementId === identity.settlementId &&
    block.delivery?.deliveryId === identity.deliveryId &&
    block.delivery.generation === identity.generation &&
    block.delivery.status === "failed" &&
    block.delivery.retryable;
  return (
    messages.some(
      (message) =>
        message.role === "assistant" && message.blocks.some(matchesBlock),
    ) ||
    (liveAssistantMessage?.blocks.some(matchesBlock) ?? false)
  );
}

// An accepted retry is not its own terminal state.
function withoutSupersededInterviewDeliveryRetryActions<
  T extends {
    readonly interviewDeliveryRetry: InterviewDeliveryRetryIdentity | null;
    readonly connectionEpoch: number;
  },
>(
  actions: Readonly<Record<string, T>>,
  messages: ReadonlyArray<Message>,
  liveAssistantMessage: LiveAssistantMessage | null,
  retireBeforeConnectionEpoch: number | null,
): Readonly<Record<string, T>> {
  const entries = Object.entries(actions).filter(
    ([, action]) =>
      action.interviewDeliveryRetry === null ||
      (retireBeforeConnectionEpoch !== null &&
      action.connectionEpoch < retireBeforeConnectionEpoch
        ? false
        : isCurrentRetryableInterviewDelivery(
            messages,
            liveAssistantMessage,
            action.interviewDeliveryRetry,
          )),
  );
  if (entries.length === Object.keys(actions).length) return actions;
  return Object.fromEntries(entries);
}

/**
 * Drops per-task background-stop entries whose stop frame's generic pending was swept as stale
 * (the frame/ack died with a dropped connection, so the task will never terminate on its account).
 */
function withoutBackgroundStopsForActions(
  pendingStops: Readonly<Record<string, string>>,
  sweptActionIds: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (sweptActionIds.size === 0) return pendingStops;
  const entries = Object.entries(pendingStops).filter(
    ([, clientActionId]) => !sweptActionIds.has(clientActionId),
  );
  if (entries.length === Object.keys(pendingStops).length) {
    return pendingStops;
  }
  return Object.fromEntries(entries);
}

/**
 * Clears a frame-driven restore slot that a lost connection stranded: an in-flight/progressing
 * slot stamped on an older connection than the authoritative snapshot would otherwise show
 */
function sweepStaleRestoreSlot(
  slot: ChatRestoreSlot | null,
  connectionEpoch: number,
): ChatRestoreSlot | null {
  if (slot === null || slot.kind === "completed") return slot;
  return slot.connectionEpoch < connectionEpoch ? null : slot;
}

function pendingActionForId(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  clientActionId: string,
): PendingChatAction | null {
  if (!Object.hasOwn(pendingActions, clientActionId)) return null;
  return pendingActions[clientActionId];
}

// The `taskId` whose in-flight stop carries `clientActionId`, or null. Used by
// the ack handler to clear the right per-item pending entry.
function backgroundStopTaskIdForActionId(
  pendingBackgroundStops: Readonly<Record<string, string>>,
  clientActionId: string,
): string | null {
  for (const taskId of Object.keys(pendingBackgroundStops)) {
    if (pendingBackgroundStops[taskId] === clientActionId) return taskId;
  }
  return null;
}

function reconcileBackgroundStopAck(
  state: ChatSessionState,
  frame: ChatActionAckFrame,
): {
  readonly pendingStops: Readonly<Record<string, string>>;
  readonly pendingStopAll: ChatSessionState["pendingBackgroundStopAll"];
} {
  // A stop stays "in flight" until the host running-only list drops the item(s), so accepted acks
  // keep disabled state tied to stream truth instead of ack timing.
  const ackTaskId = backgroundStopTaskIdForActionId(
    state.pendingBackgroundStops,
    frame.clientActionId,
  );
  const stopAllAcked =
    state.pendingBackgroundStopAll?.clientActionId === frame.clientActionId;
  const basePendingStops =
    ackTaskId !== null && frame.status === "rejected"
      ? withoutRecordKey(state.pendingBackgroundStops, ackTaskId)
      : state.pendingBackgroundStops;
  const pendingStops = stopAllAcked
    ? withBackgroundStopTaskIds(
        basePendingStops,
        frame.backgroundStopTaskIds,
        frame.clientActionId,
      )
    : basePendingStops;
  return {
    pendingStops,
    pendingStopAll: stopAllAcked ? null : state.pendingBackgroundStopAll,
  };
}

function reconcileSessionStopAck(
  sessionStop: ChatSessionState["pendingBackgroundSessionStop"],
  frame: ChatActionAckFrame,
  turnActive: boolean,
): ChatSessionState["pendingBackgroundSessionStop"] {
  if (sessionStop === null) return null;
  if (sessionStop.clientActionId !== frame.clientActionId) return sessionStop;
  if (!sessionStop.awaitingTurnEnd) {
    // Phase two (the session-stop frame itself): either verdict ends the in-flight state - on accept
    // the panel empties via the host's broadcast, on reject the generic errorNotice carries the host's
    return null;
  }
  // Phase one (the turn stop). Accepted: keep waiting for the settled frame.
  if (frame.status === "accepted") return sessionStop;
  return turnActive ? null : sessionStop;
}

function withoutRecordKey(
  record: Readonly<Record<string, string>>,
  key: string,
): Readonly<Record<string, string>> {
  if (!Object.hasOwn(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function withBackgroundStopTaskIds(
  record: Readonly<Record<string, string>>,
  taskIds: ReadonlyArray<string>,
  clientActionId: string,
): Readonly<Record<string, string>> {
  if (taskIds.length === 0) return record;
  return {
    ...record,
    ...Object.fromEntries(taskIds.map((taskId) => [taskId, clientActionId])),
  };
}

// Keep only the per-item stops whose task is still in the host's running-only list; a task that
// has left the list reached its terminal and is no longer stopping.
function reconcileBackgroundStops(
  pendingBackgroundStops: Readonly<Record<string, string>>,
  items: ReadonlyArray<BackgroundItem> | undefined,
): Readonly<Record<string, string>> {
  const taskIds = Object.keys(pendingBackgroundStops);
  if (taskIds.length === 0) return pendingBackgroundStops;
  const running =
    items === undefined ? null : new Set(items.map((i) => i.taskId));
  const kept = taskIds.filter(
    (taskId) => running !== null && running.has(taskId),
  );
  if (kept.length === taskIds.length) return pendingBackgroundStops;
  return Object.fromEntries(
    kept.map((taskId) => [taskId, pendingBackgroundStops[taskId]]),
  );
}

// The stop-all flag clears once the running list has fully drained (or the
// provider stopped reporting one); otherwise it persists until its ack.
function reconcileBackgroundStopAll(
  pendingBackgroundStopAll: {
    readonly clientActionId: string;
    readonly taskIds: ReadonlySet<string>;
  } | null,
  items: ReadonlyArray<BackgroundItem> | undefined,
): {
  readonly clientActionId: string;
  readonly taskIds: ReadonlySet<string>;
} | null {
  if (pendingBackgroundStopAll === null) return null;
  if (items === undefined || items.length === 0) return null;
  const running = new Set(items.map((item) => item.taskId));
  const covered = Array.from(pendingBackgroundStopAll.taskIds).filter(
    (taskId) => running.has(taskId),
  );
  if (covered.length === 0) return null;
  if (covered.length === pendingBackgroundStopAll.taskIds.size) {
    return pendingBackgroundStopAll;
  }
  return {
    clientActionId: pendingBackgroundStopAll.clientActionId,
    taskIds: new Set(covered),
  };
}

/**
 * Resolves the restorable `send` record for a `messageId` across either the `pendingActions` or
 * `acceptedActions` map.
 */
function findRestorableSendByMessageId<
  T extends {
    readonly clientActionId: string;
    readonly action: ChatOwnerActionFrame["kind"];
    readonly messageId: string | null;
    readonly restore: ChatSendRestore | null;
  },
>(
  entries: ReadonlyArray<T>,
  messageId: string,
): { readonly entry: T; readonly content: JsonContent } | null {
  for (const entry of entries) {
    if (
      entry.action === "send" &&
      entry.messageId === messageId &&
      entry.restore !== null
    ) {
      return { entry, content: entry.restore.content };
    }
  }
  return null;
}

/**
 * A chat session is "fully settled" when no turn is running, none is active, and the queue is
 * empty/idle.
 */
export function isChatSessionSettled(
  state: Pick<ChatSessionState, "runStatus" | "activeTurn" | "queue">,
): boolean {
  return (
    state.runStatus === "idle" &&
    state.activeTurn === null &&
    state.queue.status === "idle" &&
    state.queue.items.length === 0
  );
}

function shouldRenderSendAsPendingUserMessage(
  state: ChatSessionState,
): boolean {
  return isChatSessionSettled(state);
}

type OptimisticQueuedItemForSendInput = {
  readonly state: ChatSessionState;
  readonly clientActionId: string;
  readonly messageId: string;
  readonly content: JsonContent;
  readonly sender: UserMessageSender;
  readonly settings: ChatRunSettings;
};

function optimisticQueuedItemForSend(
  input: OptimisticQueuedItemForSendInput,
): ChatQueuedPromptItem | null {
  if (!shouldRenderSendAsOptimisticQueuedItem(input.state)) return null;
  const now = Date.now();
  return {
    kind: "prompt",
    queueItemId: optimisticQueuedItemId(input.clientActionId),
    messageId: input.messageId,
    message: {
      kind: "user",
      content: input.content,
      // Optimistic local echo only - the real `queue.added` event reconciles
      // this row once it arrives.
      browserAnnotations: [],
    },
    sender: input.sender,
    settings: input.settings,
    accountContext: useAccountContextStore.getState().accountContext,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

function shouldRenderSendAsOptimisticQueuedItem(
  state: ChatSessionState,
): boolean {
  return state.activeTurn !== null || state.queue.items.length > 0;
}

function messageExists(
  messages: ReadonlyArray<Message>,
  messageId: string,
): boolean {
  return messages.some(
    (message) => message.role === "user" && message.messageId === messageId,
  );
}

function eventExists(
  events: ReadonlyArray<ChatEvent>,
  eventId: string,
): boolean {
  return events.some((event) => event.eventId === eventId);
}

function upsertApproval(
  approvals: ReadonlyArray<ChatApprovalState>,
  approval: ChatApprovalState,
): ReadonlyArray<ChatApprovalState> {
  if (
    approvals.some((candidate) => candidate.approvalId === approval.approvalId)
  ) {
    return approvals.map((candidate) =>
      candidate.approvalId === approval.approvalId ? approval : candidate,
    );
  }
  return [...approvals, approval];
}

function upsertFileEditApproval(
  approvals: ReadonlyArray<ChatFileEditApprovalState>,
  approval: ChatFileEditApprovalState,
): ReadonlyArray<ChatFileEditApprovalState> {
  if (
    approvals.some((candidate) => candidate.approvalId === approval.approvalId)
  ) {
    return approvals.map((candidate) =>
      candidate.approvalId === approval.approvalId ? approval : candidate,
    );
  }
  return [...approvals, approval];
}

function upsertPendingInterview(
  interviews: ReadonlyArray<ChatPendingInterviewState>,
  interview: ChatPendingInterviewState,
): ReadonlyArray<ChatPendingInterviewState> {
  if (interviews.some((candidate) => candidate.blockId === interview.blockId)) {
    return interviews.map((candidate) =>
      candidate.blockId === interview.blockId ? interview : candidate,
    );
  }
  return [...interviews, interview];
}

function withoutPendingInterview(
  interviews: ReadonlyArray<ChatPendingInterviewState>,
  blockId: string,
): ReadonlyArray<ChatPendingInterviewState> {
  if (!interviews.some((interview) => interview.blockId === blockId)) {
    return interviews;
  }
  return interviews.filter((interview) => interview.blockId !== blockId);
}

function applyBlockDelta(
  state: ChatSessionState,
  event: RuntimeEvent,
  witnesses: ImageWitnessStore | null,
): Partial<ChatSessionState> {
  return event.type === "image_resolution.updated"
    ? applyImageResolutionDelta(state, event, witnesses)
    : applyContentDelta(state, event, witnesses);
}

function applyImageResolutionDelta(
  state: ChatSessionState,
  event: Extract<RuntimeEvent, { type: "image_resolution.updated" }>,
  witnesses: ImageWitnessStore | null,
): Partial<ChatSessionState> {
  // Recorded FIRST, and unconditionally: the witness is evidence about the source's write stream,
  // not about the client's holdings, so an unheld or unreachable row records exactly as a held one
  const witnessSeq = witnesses?.record(event.messageId, event.entry) ?? null;
  const messageIndex = state.messages.findIndex(
    (message) =>
      message.role === "assistant" && message.messageId === event.messageId,
  );
  if (messageIndex < 0) {
    const activeTurn = state.activeTurn;
    if (
      activeTurn === null ||
      event.turnId === null ||
      event.turnId !== activeTurn.turnId
    ) {
      return {};
    }
    const liveAssistant = liveAssistantForActiveTurn(
      state.liveAssistantMessage,
      activeTurn,
    );
    const resolutionIndex = liveAssistant.imageResolutions.findIndex(
      (resolution) =>
        resolution.messageId === event.messageId &&
        resolution.entry.canonicalSource === event.entry.canonicalSource,
    );
    const imageResolutions =
      resolutionIndex < 0
        ? [
            ...liveAssistant.imageResolutions,
            {
              messageId: event.messageId,
              entry: event.entry,
            },
          ]
        : liveAssistant.imageResolutions.map((resolution, index) =>
            index === resolutionIndex
              ? { ...resolution, entry: event.entry }
              : resolution,
          );
    return {
      liveAssistantMessage: {
        ...liveAssistant,
        imageResolutionOwnerMessageId: event.messageId,
        imageResolutions,
        imageResolutionsVersion: liveAssistant.imageResolutionsVersion + 1,
        timestamp: event.timestamp,
      },
    };
  }
  const message = state.messages[messageIndex];
  if (message.role !== "assistant") return {};
  const entryIndex = message.imageResolutions.findIndex(
    (entry) => entry.canonicalSource === event.entry.canonicalSource,
  );
  const imageResolutions =
    entryIndex < 0
      ? [...message.imageResolutions, event.entry]
      : message.imageResolutions.map((entry, index) =>
          index === entryIndex ? event.entry : entry,
        );
  // A no-op rather than `{}` if the row is unreachable: the caller has already decided this event
  // belongs to a persisted row rather than the live one, so falling back would re-run that decision
  const patch =
    rewriteMessageInPlace(
      state,
      message.messageId,
      (target) =>
        target.role === "assistant" ? { ...target, imageResolutions } : target,
      { charge: "now", witnesses },
    ) ?? {};
  // An APPLIED write stamps exactly - the applied witness names its own sequence, and
  // `rewriteWindowMessage` rewrote every holder, so every copy of the record in the new window
  if (
    witnesses !== null &&
    witnessSeq !== null &&
    "transcriptWindow" in patch &&
    patch.transcriptWindow !== undefined
  ) {
    witnesses.stampRewrittenCopies(
      patch.transcriptWindow,
      event.messageId,
      event.entry.canonicalSource,
      witnessSeq,
    );
  }
  return patch;
}

function applyContentDelta(
  state: ChatSessionState,
  event: Exclude<RuntimeEvent, { type: "image_resolution.updated" }>,
  witnesses: ImageWitnessStore | null,
): Partial<ChatSessionState> {
  // `usage.updated` carries the live in-flight context usage so the "% context left" composer chip
  // can update during the turn.
  if (event.type === "usage.updated") {
    const activeTurnId = state.activeTurn?.turnId ?? null;
    if (activeTurnId !== null && event.turnId !== activeTurnId) {
      return {};
    }
    return { liveTurnUsage: event.usage };
  }
  // `turn.started` opens a new turn - drop the previous turn's live value (it would briefly
  // attribute the prior turn's number to the new turn until its first usage.updated arrives).
  if (event.type === "turn.started") {
    if (state.liveTurnUsage === null) {
      return applyContentBlockDelta(state, event, witnesses);
    }
    const partial = applyContentBlockDelta(state, event, witnesses);
    return { ...partial, liveTurnUsage: null };
  }
  // `turn.completed` / `turn.stopped` / `turn.interrupted` / `error`: CARRY the final usage forward
  // instead of clearing.
  if (
    event.type === "turn.completed" ||
    event.type === "turn.stopped" ||
    event.type === "turn.interrupted" ||
    event.type === "error"
  ) {
    const partial = applyContentBlockDelta(state, event, witnesses);
    const finalUsage =
      event.type === "turn.completed" && event.usage !== undefined
        ? event.usage
        : state.liveTurnUsage;
    return finalUsage === state.liveTurnUsage
      ? partial
      : { ...partial, liveTurnUsage: finalUsage };
  }
  return applyContentBlockDelta(state, event, witnesses);
}

// The block id whose OWNING message a detached backgrounded-subagent event targets, plus whether
// that owner MUST already exist:
function isSubagentCardOpeningEvent(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: "subagent.started" | "workflow.started" }
> {
  return event.type === "subagent.started" || event.type === "workflow.started";
}

// The `subagent.*` / `workflow.*` arm, split out so the opens-versus-updates rule reads as two
// branches rather than a negated conjunction hidden in a flag - and so the parent function stays
function subagentCardOwnerTarget(
  event: RuntimeEvent,
): { readonly ownerBlockId: string; readonly ownerMustExist: boolean } | null {
  if (isSubagentCardOpeningEvent(event)) {
    return { ownerBlockId: event.blockId, ownerMustExist: false };
  }
  if (
    event.type === "subagent.progress" ||
    event.type === "subagent.completed" ||
    event.type === "workflow.progress" ||
    event.type === "workflow.completed"
  ) {
    return { ownerBlockId: event.blockId, ownerMustExist: true };
  }
  return null;
}

function detachedSubagentOwnerTarget(
  event: RuntimeEvent,
): { readonly ownerBlockId: string; readonly ownerMustExist: boolean } | null {
  const parentBlockId =
    "parentBlockId" in event &&
    typeof event.parentBlockId === "string" &&
    event.parentBlockId.length > 0
      ? event.parentBlockId
      : null;
  const cardTarget = subagentCardOwnerTarget(event);
  if (cardTarget !== null) return cardTarget;
  if (
    event.type === "tool_call.completed" ||
    event.type === "tool_call.errored" ||
    event.type === "command.completed"
  ) {
    if (parentBlockId !== null) {
      return { ownerBlockId: parentBlockId, ownerMustExist: true };
    }
    return {
      ownerBlockId: event.blockId,
      ownerMustExist:
        "backgroundTask" in event && event.backgroundTask === true,
    };
  }
  if (parentBlockId !== null) {
    return { ownerBlockId: parentBlockId, ownerMustExist: true };
  }
  return null;
}

// Does the ACTIVE TURN's row already own this block?
function activeTurnOwnsBlock(
  state: ChatSessionState,
  assistantIndex: number,
  blockId: string,
): boolean {
  if (
    assistantIndex >= 0 &&
    assistantMessageOwnsBlock(state.messages[assistantIndex], blockId)
  ) {
    return true;
  }
  const live = state.liveAssistantMessage;
  const activeTurnId = state.activeTurn?.turnId ?? null;
  return (
    live !== null &&
    activeTurnId !== null &&
    live.turnId === activeTurnId &&
    live.blocks.some((block) => block.blockId === blockId)
  );
}

/** Is this session on the windowed line? */
export function isWindowedTranscript<
  T extends Pick<ChatSessionState, "transcriptDerived">,
>(
  state: T,
): state is T & { readonly transcriptDerived: ChatTranscriptDerived } {
  return state.transcriptDerived !== null;
}

/** Rows the chat is BLOCKED on - the hydration obligation the viewport cannot express. */
function pendingInterviewOrdinals(
  answerability: ReadonlyArray<InterviewAnswerability> | null,
  pendingInterviews: ReadonlyArray<ChatPendingInterviewState>,
): ReadonlyArray<number> {
  if (answerability === null) return [];
  if (pendingInterviews.length === 0) return [];
  const pending = new Set(
    pendingInterviews.map((interview) => interview.blockId),
  );
  const ordinals: number[] = [];
  for (const entry of answerability) {
    // `null` is "no row renders it" - genuinely stuck, and nothing to fetch.
    if (entry.ordinal === null) continue;
    if (!pending.has(entry.blockId)) continue;
    ordinals.push(entry.ordinal);
  }
  return ordinals;
}

/** The ordinals hydration must reach beyond the viewport, as the STORE currently holds them. */
function requiredHydrationOrdinalsOf(
  state: ChatSessionState,
): ReadonlyArray<number> {
  const interviews = pendingInterviewOrdinals(
    state.transcriptDerived === null
      ? null
      : state.transcriptDerived.interviewAnswerability,
    state.pendingInterviews,
  );
  const jump = state.jumpTargetOrdinal;
  if (jump === null) return interviews;
  return interviews.includes(jump) ? interviews : [...interviews, jump];
}

/**
 * `state.coldRewrittenMessageIds` with one more id, bounded. A new Set per call, because the value
 * is state and the store's consumers compare identities.
 */
const MAX_COLD_REWRITTEN_MESSAGE_IDS = 256;

/** Stable empty identity, so a reset does not look like a change. */
const EMPTY_COLD_REWRITTEN_IDS: ReadonlySet<string> = new Set();

function withColdRewrite(
  state: ChatSessionState,
  messageId: string,
): ReadonlySet<string> {
  if (state.coldRewrittenMessageIds.has(messageId)) {
    return state.coldRewrittenMessageIds;
  }
  const next = new Set(state.coldRewrittenMessageIds);
  next.add(messageId);
  while (next.size > MAX_COLD_REWRITTEN_MESSAGE_IDS) {
    const oldest = next.values().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

/** Rewrite one row in place, on whichever line this session is on. */
function rewriteMessageInPlace(
  state: ChatSessionState,
  messageId: string,
  update: (message: Message) => Message,
  apply: {
    readonly charge: "now" | "deferred";
    readonly witnesses: ImageWitnessStore | null;
  },
): Partial<ChatSessionState> | null {
  const { charge, witnesses } = apply;
  if (!isWindowedTranscript(state)) {
    const index = state.messages.findIndex(
      (message) => message.messageId === messageId,
    );
    if (index < 0) return null;
    const messages = state.messages.slice();
    messages[index] = update(state.messages[index]);
    return { messages };
  }
  const applied =
    charge === "deferred"
      ? streamWindowMessage(
          state.transcriptWindow,
          messageId,
          update,
          witnesses,
        )
      : updateWindowMessage(
          state.transcriptWindow,
          messageId,
          update,
          witnesses,
        );
  if (!applied.held) {
    // The row's span is evicted, so the delta is deliberately dropped: the persisted host body carries
    // it at the next hydration.
    return { coldRewrittenMessageIds: withColdRewrite(state, messageId) };
  }
  return {
    transcriptWindow: applied.window,
    // `messages` only: republishing `events` from the same fold would hand every event consumer a new
    // array identity for a change that touched no event.
    messages: hydratedRecords(applied.window).messages,
  };
}

type InterviewBlock = Extract<ContentBlock, { readonly type: "interview" }>;
type InterviewLifecycleProjection = {
  readonly kind: "answered" | "errored";
  readonly blockId: string;
  readonly settlementId: string | null;
  readonly settlementSource: InterviewSettlementSource | null;
  readonly resolvedAt: number;
  readonly answers: ReadonlyArray<InterviewAnswer>;
  readonly reason: string | null;
  readonly outcome: InterviewBlock["outcome"];
  readonly draftAnswers: ReadonlyArray<InterviewAnswer>;
  readonly delivery: InterviewBlock["delivery"];
};

/** The host's code for "the Claude runtime was torn down under a running turn". */
const CLAUDE_RUNTIME_DISPOSED_ERROR_CODE = "CLAUDE_RUNTIME_DISPOSED";

/**
 * Drop the runtime-disposal errors that belong to ONE answered interview. Two conditions, and BOTH
 * are needed.
 */
function withRuntimeDisposalRetiredForInterview(
  blocks: ReadonlyArray<ContentBlock>,
  targetInterviewIndex: number,
  targetSettledAt: number,
): ReadonlyArray<ContentBlock> {
  let nearestInterviewIndex = -1;
  const retained: ContentBlock[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "interview") nearestInterviewIndex = index;
    if (
      block.type === "error" &&
      block.code === CLAUDE_RUNTIME_DISPOSED_ERROR_CODE &&
      nearestInterviewIndex === targetInterviewIndex &&
      targetSettledAt > block.timestamp
    ) {
      continue;
    }
    retained.push(block);
  }
  // Same reference when nothing matched, so a fold that changes nothing keeps
  // the row's identity and every memoized renderer below it.
  return retained.length === blocks.length ? blocks : retained;
}

function withInterviewLifecycleBlocks(
  blocks: ReadonlyArray<ContentBlock>,
  projection: InterviewLifecycleProjection,
  allowUnresolvedFallback: boolean,
): ReadonlyArray<ContentBlock> {
  const targetIndex = interviewLifecycleBlockIndex(
    blocks,
    projection,
    allowUnresolvedFallback,
  );
  if (targetIndex < 0) return blocks;
  const block = blocks[targetIndex];
  if (block.type !== "interview") return blocks;
  let updated: ContentBlock;
  if (
    projection.settlementId !== null &&
    projection.settlementSource !== null &&
    projection.outcome !== null
  ) {
    const reduced = applyInterviewSettlement(block, {
      settlementId: projection.settlementId,
      source: projection.settlementSource,
      outcome: projection.outcome,
      answers: [...projection.answers],
      draftAnswers: [...projection.draftAnswers],
      reason: projection.reason,
      diagnostic: null,
      delivery: projection.delivery,
      timestamp: projection.resolvedAt,
    });
    updated = reduced.changed ? { ...block, ...reduced.patch } : block;
  } else if (block.settlement !== null || block.outcome !== null) {
    // A partial legacy tuple cannot weaken a terminal fact already projected
    // for this row. This also makes duplicate legacy cleanup frames monotonic.
    updated = block;
  } else {
    const delivery = block.delivery;
    updated =
      projection.kind === "answered"
        ? {
            ...block,
            status: "completed",
            answers: [...projection.answers],
            error: null,
            outcome: "answered",
            draftAnswers: [],
            delivery,
          }
        : {
            ...block,
            status: "errored",
            error: projection.reason,
            outcome: projection.outcome,
            draftAnswers:
              projection.outcome === "skipped"
                ? [...projection.draftAnswers]
                : [],
            delivery,
          };
  }
  let settled: ReadonlyArray<ContentBlock> = blocks;
  if (updated !== block) {
    const next = blocks.slice();
    next[targetIndex] = updated;
    settled = next;
  }
  // Mirror of the host's settlement projection: an ANSWERED interview resumes the provider session
  // on a fresh runtime, so the disposal error that was waiting on this interview stops explaining
  if (!lifecycleFrameOwnsInterviewSettlement(updated, projection)) {
    return settled;
  }
  return withRuntimeDisposalRetiredForInterview(
    settled,
    targetIndex,
    projection.resolvedAt,
  );
}

/** Whether this frame is entitled to date the settled interview's answer. */
function lifecycleFrameOwnsInterviewSettlement(
  settledInterview: Extract<ContentBlock, { type: "interview" }>,
  projection: InterviewLifecycleProjection,
): boolean {
  if (settledInterview.outcome !== "answered") return false;
  const authority = settledInterview.settlement;
  return (
    authority !== null &&
    projection.settlementId !== null &&
    projection.settlementId === authority.settlementId
  );
}

function interviewLifecycleBlockIndex(
  blocks: ReadonlyArray<ContentBlock>,
  projection: InterviewLifecycleProjection,
  allowUnresolvedFallback: boolean,
): number {
  if (projection.settlementId !== null) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (
        block.type === "interview" &&
        block.blockId === projection.blockId &&
        block.settlement?.settlementId === projection.settlementId
      ) {
        return index;
      }
    }
  }
  if (!allowUnresolvedFallback) return -1;
  // A first lifecycle frame installs authority only on the newest unresolved
  // owner. Never fall back to an older terminal row that merely reused the id.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block.type === "interview" &&
      block.blockId === projection.blockId &&
      block.status === "streaming" &&
      block.settlement === null
    ) {
      return index;
    }
  }
  return -1;
}

function withInterviewLifecycleProjectionPass(
  messages: ReadonlyArray<Message>,
  projection: InterviewLifecycleProjection,
  allowUnresolvedFallback: boolean,
): {
  readonly messages: ReadonlyArray<Message>;
  readonly matched: boolean;
  /** The one row this pass rewrote, or `null` if it rewrote none. */
  readonly rewrittenMessageId: string | null;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (
      interviewLifecycleBlockIndex(
        message.blocks,
        projection,
        allowUnresolvedFallback,
      ) < 0
    ) {
      continue;
    }
    const blocks = withInterviewLifecycleBlocks(
      message.blocks,
      projection,
      allowUnresolvedFallback,
    );
    if (blocks === message.blocks) {
      return { messages, matched: true, rewrittenMessageId: null };
    }
    const next = messages.slice();
    next[index] = { ...message, blocks: [...blocks] };
    return {
      messages: next,
      matched: true,
      rewrittenMessageId: message.messageId,
    };
  }
  return { messages, matched: false, rewrittenMessageId: null };
}

function withInterviewLifecycleState(
  messages: ReadonlyArray<Message>,
  liveAssistantMessage: LiveAssistantMessage | null,
  projection: InterviewLifecycleProjection,
): {
  readonly messages: ReadonlyArray<Message>;
  readonly liveAssistantMessage: LiveAssistantMessage | null;
  readonly matchedOwner: boolean;
  readonly resolvedPendingOwner: boolean;
  /** See {@link withInterviewLifecycleProjectionPass}'s field of this name. */
  readonly rewrittenMessageId: string | null;
} {
  if (projection.settlementId !== null) {
    const exactMessages = withInterviewLifecycleProjectionPass(
      messages,
      projection,
      false,
    );
    if (exactMessages.matched) {
      return {
        messages: exactMessages.messages,
        liveAssistantMessage,
        matchedOwner: true,
        resolvedPendingOwner: false,
        rewrittenMessageId: exactMessages.rewrittenMessageId,
      };
    }
    if (liveAssistantMessage !== null) {
      const exactLiveMatched =
        interviewLifecycleBlockIndex(
          liveAssistantMessage.blocks,
          projection,
          false,
        ) >= 0;
      const exactLiveBlocks = withInterviewLifecycleBlocks(
        liveAssistantMessage.blocks,
        projection,
        false,
      );
      if (exactLiveMatched) {
        return {
          messages,
          liveAssistantMessage:
            exactLiveBlocks === liveAssistantMessage.blocks
              ? liveAssistantMessage
              : { ...liveAssistantMessage, blocks: exactLiveBlocks },
          matchedOwner: true,
          resolvedPendingOwner: false,
          // The live row is not a window record - it is `liveAssistantMessage`,
          // which both lines hold the same way.
          rewrittenMessageId: null,
        };
      }
    }
  }
  if (liveAssistantMessage !== null) {
    const liveMatched =
      interviewLifecycleBlockIndex(
        liveAssistantMessage.blocks,
        projection,
        true,
      ) >= 0;
    const liveBlocks = withInterviewLifecycleBlocks(
      liveAssistantMessage.blocks,
      projection,
      true,
    );
    if (liveMatched) {
      return {
        messages,
        liveAssistantMessage:
          liveBlocks === liveAssistantMessage.blocks
            ? liveAssistantMessage
            : { ...liveAssistantMessage, blocks: liveBlocks },
        matchedOwner: true,
        resolvedPendingOwner: true,
        rewrittenMessageId: null,
      };
    }
  }
  const unresolvedMessages = withInterviewLifecycleProjectionPass(
    messages,
    projection,
    true,
  );
  return {
    messages: unresolvedMessages.messages,
    liveAssistantMessage,
    matchedOwner: unresolvedMessages.matched,
    resolvedPendingOwner: unresolvedMessages.matched,
    rewrittenMessageId: unresolvedMessages.rewrittenMessageId,
  };
}

function assistantMessageOwnsBlock(message: Message, blockId: string): boolean {
  return (
    message.role === "assistant" &&
    message.blocks.some((block) => block.blockId === blockId)
  );
}

// Applies a block event to the frozen pre-split row of the active turn that owns it, when a steer
// split left that block still streaming there.
function applySteerSplitCarryoverEvent(
  state: ChatSessionState,
  assistantIndex: number,
  event: RuntimeEvent,
  witnesses: ImageWitnessStore | null,
): Partial<ChatSessionState> | null {
  if (assistantIndex < 0) return null;
  const active = state.messages[assistantIndex];
  if (active.role !== "assistant" || !("blockId" in event)) return null;
  if (assistantMessageOwnsBlock(active, event.blockId)) return null;
  const siblingIndex = earlierSameTurnRowOwningEventBlock(
    state.messages,
    assistantIndex,
    active.turnId ?? null,
    event,
  );
  if (siblingIndex < 0) return null;
  const sibling = state.messages[siblingIndex];
  if (sibling.role !== "assistant") return null;
  const content = accumulateTurnContent(
    { blocks: sibling.blocks, blocksVersion: sibling.blocksVersion ?? 0 },
    event,
  );
  if (content.blocks === sibling.blocks) return {};
  // `{}` and not `null` when the row is unreachable: `null` here means "this is not a carryover
  // event", and the caller answers it by routing to the ACTIVE row - which is the duplicate-card
  return (
    rewriteMessageInPlace(
      state,
      sibling.messageId,
      (target) =>
        target.role === "assistant"
          ? {
              ...target,
              blocks: content.blocks,
              ...(target.blocksVersion === undefined
                ? {}
                : { blocksVersion: content.blocksVersion }),
            }
          : target,
      { charge: "now", witnesses },
    ) ?? {}
  );
}

// Finds the EARLIER assistant row of the same turn that owns this event's block (or its parent
// block) - the frozen pre-split row a steer split left behind while the block was still streaming.
function earlierSameTurnRowOwningEventBlock(
  messages: ReadonlyArray<Message>,
  activeIndex: number,
  turnId: string | null,
  event: RuntimeEvent,
): number {
  if (turnId === null || !("blockId" in event)) return -1;
  const parentBlockId =
    "parentBlockId" in event && typeof event.parentBlockId === "string"
      ? event.parentBlockId
      : null;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // Steered user rows sit between split siblings: skip, don't stop.
    if (message.role !== "assistant" || message.turnId !== turnId) continue;
    if (
      assistantMessageOwnsBlock(message, event.blockId) ||
      (parentBlockId !== null &&
        assistantMessageOwnsBlock(message, parentBlockId))
    ) {
      return index;
    }
  }
  return -1;
}

// Apply a detached backgrounded-subagent event to the SETTLED message that owns its card (its
// spawning turn already ended), so the card keeps updating instead of being dropped (no active
function applyEventToOwningMessage(
  state: ChatSessionState,
  event: RuntimeEvent,
  ownerBlockId: string,
  witnesses: ImageWitnessStore | null,
): Partial<ChatSessionState> | null {
  const index = state.messages.findIndex((message) =>
    assistantMessageOwnsBlock(message, ownerBlockId),
  );
  if (index < 0) return null;
  const target = state.messages[index];
  if (target.role !== "assistant") return null;
  const content = accumulateTurnContent(
    { blocks: target.blocks, blocksVersion: target.blocksVersion ?? 0 },
    event,
  );
  if (content.blocks === target.blocks) return {};
  return (
    rewriteMessageInPlace(
      state,
      target.messageId,
      (message) =>
        message.role !== "assistant"
          ? message
          : {
              ...message,
              blocks: content.blocks,
              ...(message.blocksVersion === undefined
                ? {}
                : { blocksVersion: content.blocksVersion }),
              // Preserve the settled row's `timestamp` (its completed-at).
            },
      { charge: "now", witnesses },
    ) ?? {}
  );
}

/** Reduces a single runtime delta event onto the session state, and remembers the cards it opened. */
function applyContentBlockDelta(
  state: ChatSessionState,
  event: RuntimeEvent,
  witnesses: ImageWitnessStore | null,
): Partial<ChatSessionState> {
  const applied = reduceContentBlockDelta(state, event, witnesses);
  if (applied === state) return applied;
  if (!isSubagentCardOpeningEvent(event)) return applied;
  if (state.openedSubagentCardBlockIds.has(event.blockId)) return applied;
  const opened = new Set(state.openedSubagentCardBlockIds);
  addWithFifoEviction(
    opened,
    event.blockId,
    MAX_OPENED_SUBAGENT_CARD_BLOCK_IDS,
  );
  return { ...applied, openedSubagentCardBlockIds: opened };
}

// Reduces a single runtime delta event onto the session state. The branches map
// one-to-one to the distinct block/delta kinds; flattening that mapping is
// clearer than threading the dispatch through extra indirection.
// eslint-disable-next-line complexity
function reduceContentBlockDelta(
  state: ChatSessionState,
  event: RuntimeEvent,
  witnesses: ImageWitnessStore | null,
): Partial<ChatSessionState> {
  const assistantIndex = findAssistantMessageIndex(
    state.messages,
    state.activeTurn?.turnId ?? state.liveAssistantMessage?.turnId ?? null,
  );
  // Detached backgrounded-subagent activity: its card lives in an earlier, already-settled message.
  const detachedTarget = detachedSubagentOwnerTarget(event);
  if (
    detachedTarget !== null &&
    !activeTurnOwnsBlock(state, assistantIndex, detachedTarget.ownerBlockId)
  ) {
    const routed = applyEventToOwningMessage(
      state,
      event,
      detachedTarget.ownerBlockId,
      witnesses,
    );
    if (routed !== null) return routed;
    // A detached event whose owning message is gone must NOT fall through to the active turn: the
    // accumulator would append its terminal as a duplicate top-level card on an unrelated turn.
    if (
      detachedTarget.ownerMustExist ||
      state.openedSubagentCardBlockIds.has(detachedTarget.ownerBlockId)
    ) {
      return state;
    }
  }
  const carryoverRouted = applySteerSplitCarryoverEvent(
    state,
    assistantIndex,
    event,
    witnesses,
  );
  if (carryoverRouted !== null) return carryoverRouted;
  if (assistantIndex >= 0) {
    const target = state.messages[assistantIndex];
    if (target.role !== "assistant") {
      return { liveAssistantMessage: null };
    }
    // The ACTIVE TURN's row - the highest-frequency writer in the store, and the one the consumer
    // sweep missed.
    const content = accumulateTurnContent(
      {
        blocks: target.blocks,
        blocksVersion: target.blocksVersion ?? 0,
      },
      event,
    );
    if (content.blocks === target.blocks) return state;
    const streamed = rewriteMessageInPlace(
      state,
      target.messageId,
      (message) =>
        message.role !== "assistant"
          ? message
          : {
              ...message,
              blocks: content.blocks,
              ...(message.blocksVersion === undefined
                ? {}
                : { blocksVersion: content.blocksVersion }),
              timestamp: event.timestamp,
            },
      { charge: "deferred", witnesses },
    );
    return {
      ...(streamed ?? {}),
      liveAssistantMessage: null,
    };
  }

  const activeTurn = state.activeTurn;
  if (activeTurn === null) {
    // The turn already settled (activeTurn cleared - e.g. on disconnect, which nulls activeTurn but
    // keeps the not-yet-materialized live row).
    if (
      event.type !== "turn.completed" &&
      event.type !== "turn.stopped" &&
      event.type !== "turn.interrupted"
    ) {
      return state;
    }
    const live = state.liveAssistantMessage;
    if (live === null) return state;
    if (event.turnId !== live.turnId) return state;
    const settledContent = accumulateTurnContent(
      { blocks: [...live.blocks], blocksVersion: live.blocksVersion },
      event,
    );
    if (settledContent.blocksVersion === live.blocksVersion) return state;
    return {
      liveAssistantMessage: {
        ...live,
        blocks: settledContent.blocks,
        blocksVersion: settledContent.blocksVersion,
        timestamp: event.timestamp,
      },
    };
  }
  const liveAssistant = liveAssistantForActiveTurn(
    state.liveAssistantMessage,
    activeTurn,
  );
  const priorBlocks = liveAssistant.blocks;
  const content = accumulateTurnContent(
    {
      blocks: [...priorBlocks],
      blocksVersion: liveAssistant.blocksVersion,
    },
    event,
  );
  if (content.blocksVersion === liveAssistant.blocksVersion) return state;
  return {
    liveAssistantMessage: {
      ...liveAssistant,
      blocks: content.blocks,
      blocksVersion: content.blocksVersion,
      timestamp: event.timestamp,
    },
  };
}

function findAssistantMessageIndex(
  messages: ReadonlyArray<Message>,
  turnId: string | null,
): number {
  if (turnId === null) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.turnId === turnId) {
      return index;
    }
  }
  return -1;
}

function snapshotPreviousTurnId(
  activeTurn: ChatActiveTurn | null,
  liveAssistant: LiveAssistantMessage | null,
  snapshotActiveTurn: ChatActiveTurn | null,
): string | null {
  const nextTurnId = snapshotActiveTurn?.turnId ?? null;
  if (activeTurn !== null && activeTurn.turnId !== nextTurnId) {
    return activeTurn.turnId;
  }
  if (liveAssistant !== null && liveAssistant.turnId !== nextTurnId) {
    return liveAssistant.turnId;
  }
  return activeTurn?.turnId ?? liveAssistant?.turnId ?? null;
}

/** What `messages` becomes across a turn transition, on either line. */
function turnStateMessages(input: {
  readonly windowed: boolean;
  readonly previousMessages: ReadonlyArray<Message>;
  readonly previousWindow: TranscriptWindow;
  readonly nextWindow: TranscriptWindow;
  readonly materialized: Message | null;
  readonly turnIds: {
    readonly previousTurnId: string | null;
    readonly nextTurnId: string | null;
  };
}): ReadonlyArray<Message> {
  if (input.windowed) {
    return input.nextWindow === input.previousWindow
      ? input.previousMessages
      : hydratedRecords(input.nextWindow).messages;
  }
  const base =
    input.materialized === null
      ? input.previousMessages
      : [...input.previousMessages, input.materialized];
  return messagesForTurnStateChange(base, input.turnIds);
}

/** The per-record rewrite a steer restart implies, or `null` when it is a no-op. */
function turnRemapFor(turnIds: {
  readonly previousTurnId: string | null;
  readonly nextTurnId: string | null;
}): ((message: Message) => Message) | null {
  const previousTurnId = turnIds.previousTurnId;
  const nextTurnId = turnIds.nextTurnId;
  if (
    previousTurnId === null ||
    nextTurnId === null ||
    previousTurnId === nextTurnId
  ) {
    return null;
  }
  return (message: Message): Message =>
    message.role === "assistant" && message.turnId === previousTurnId
      ? { ...message, turnId: nextTurnId }
      : message;
}

function messagesForTurnStateChange(
  messages: ReadonlyArray<Message>,
  turnIds: {
    readonly previousTurnId: string | null;
    readonly nextTurnId: string | null;
  },
): ReadonlyArray<Message> {
  const remap = turnRemapFor(turnIds);
  return remap === null ? messages : messages.map(remap);
}

/** The row a settling turn's live assistant must be frozen into, or `null`. */
function materializedLiveAssistant(
  messages: ReadonlyArray<Message>,
  liveAssistant: LiveAssistantMessage | null,
  turnIds: {
    readonly previousActiveTurnId: string | null;
    readonly nextActiveTurnId: string | null;
  },
): Message | null {
  if (liveAssistant === null) return null;
  if (liveAssistantCoveredByMessages(liveAssistant, messages)) return null;
  if (
    turnIds.nextActiveTurnId !== null &&
    liveAssistant.turnId === turnIds.nextActiveTurnId
  ) {
    return null;
  }
  if (
    turnIds.previousActiveTurnId !== null &&
    liveAssistant.turnId === turnIds.previousActiveTurnId &&
    turnIds.nextActiveTurnId !== null
  ) {
    return null;
  }
  // Invariant: a frozen (materialized) assistant row can never contain a `streaming` action block.
  return assistantMessageFromLiveAssistant(liveAssistant, "interrupted");
}

function assistantMessageFromLiveAssistant(
  liveAssistant: LiveAssistantMessage,
  fallbackStatus: FinalizedActionStatus,
): Extract<Message, { role: "assistant" }> {
  // Spread converts the readonly live blocks to the mutable array the accumulator
  // signature takes (it does not mutate in place).
  const liveBlocks = [...liveAssistant.blocks];
  // Finalize the row's streaming blocks for this transient safety-net placeholder, but keep a
  // still-`streaming` (backgrounded) subagent card "running" - mirroring the accumulator's terminal
  const finalizedBlocks = reopenStreamingSubagentBlocks(
    liveBlocks,
    finalizeStreamingActionBlocks(
      liveBlocks,
      liveAssistant.timestamp,
      fallbackStatus,
    ),
  );
  const ownerMessageId = liveAssistant.imageResolutionOwnerMessageId;
  const imageResolutions =
    ownerMessageId === undefined
      ? liveAssistant.imageResolutions.map((resolution) => resolution.entry)
      : liveAssistant.imageResolutions
          .filter((resolution) => resolution.messageId === ownerMessageId)
          .map((resolution) => resolution.entry);
  return {
    role: "assistant",
    // This frozen row is a transient safety-net placeholder that the host's authoritative snapshot
    // replaces.
    messageId: transientLiveAssistantMessageId(liveAssistant.turnId),
    sender: liveAssistant.sender,
    blocks: finalizedBlocks,
    startedAt: liveAssistant.startedAt,
    blocksVersion: liveAssistant.blocksVersion,
    timestamp: liveAssistant.timestamp,
    turnId: liveAssistant.turnId,
    usage: null,
    reasoningEffort: liveAssistant.reasoningEffort,
    serviceTier: liveAssistant.serviceTier,
    // Unlike the two above - mirrored from `ChatActiveTurn`, which knows what the user PICKED - the
    // credential a spawn used is a host-side fact this transient placeholder never receives.
    envCredentialVar: null,
    imageResolutions,
  };
}

function liveAssistantForActiveTurnState(input: {
  readonly current: LiveAssistantMessage | null;
  readonly previousTurnId: string | null;
  readonly activeTurn: ChatActiveTurn;
  readonly messages: ReadonlyArray<Message>;
}): LiveAssistantMessage | null {
  const current =
    input.current !== null &&
    input.previousTurnId !== null &&
    input.current.turnId === input.previousTurnId &&
    input.current.turnId !== input.activeTurn.turnId
      ? { ...input.current, turnId: input.activeTurn.turnId }
      : input.current;
  if (
    current !== null &&
    liveAssistantCoveredByMessages(current, input.messages)
  ) {
    return null;
  }
  if (
    input.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.turnId === input.activeTurn.turnId,
    )
  ) {
    return null;
  }
  return liveAssistantForActiveTurn(current, input.activeTurn);
}

function liveAssistantForTurnStateFrame(input: {
  readonly current: LiveAssistantMessage | null;
  readonly previousTurnId: string | null;
  readonly activeTurn: ChatActiveTurn | null;
  readonly messages: ReadonlyArray<Message>;
}): LiveAssistantMessage | null {
  if (input.activeTurn === null) {
    if (liveAssistantCoveredByMessages(input.current, input.messages)) {
      return null;
    }
    return input.current;
  }
  return liveAssistantForActiveTurnState({
    current: input.current,
    previousTurnId: input.previousTurnId,
    activeTurn: input.activeTurn,
    messages: input.messages,
  });
}

function liveAssistantForActiveTurn(
  current: LiveAssistantMessage | null,
  activeTurn: ChatActiveTurn,
): LiveAssistantMessage {
  if (current !== null && current.turnId === activeTurn.turnId) {
    return current;
  }
  return {
    turnId: activeTurn.turnId,
    sender: {
      type: "agent",
      harnessId: activeTurn.harnessId,
      agentId: activeTurn.model,
      displayName: activeTurn.model,
      // Live assistant turns never participate in inter-agent broker
      // threads; replies are meaningful only on `role: "user"` agent senders.
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: activeTurn.startedAt,
    blocksVersion: 0,
    imageResolutions: [],
    imageResolutionOwnerMessageId: null,
    imageResolutionsVersion: 0,
    timestamp: activeTurn.updatedAt,
    reasoningEffort: activeTurn.reasoningEffort,
    serviceTier: activeTurn.serviceTier,
  };
}

function liveAssistantCoveredByMessages(
  liveAssistant: LiveAssistantMessage | null,
  messages: ReadonlyArray<Message>,
): boolean {
  if (liveAssistant === null) return true;
  return messages.some(
    (message) =>
      message.role === "assistant" && message.turnId === liveAssistant.turnId,
  );
}
