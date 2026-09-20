import {
  addAcceptedAction,
  confirmAcceptedSendByMessageId,
  noticeCarriesOnlyCopy,
  unrecoverableSendNotice,
  unrecoverableSendPrompt,
  type UnrecoverableSend,
  type UnrecoverableSendPrompt,
  pruneAcceptedActions,
  withoutResolvedAcceptedQueueCancellations,
  withoutSettledAcceptedQueueStatusActions,
  restoreOutcomesFrom,
  retransmittableRestoreActions,
  settleObservedRestoreSlot,
  settleRestoreAttemptsByEvidence,
  type SettledRestoreCompletion,
  consumeSettledRestoreCompletion,
  withoutSettledRestoreCompletionsBefore,
  withoutEarliestAcceptedRestoreActionFor,
  withRetransmittedRestoreActions,
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
  SetupCardWindowIdentity,
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
  activeTurnOrdinalsOf,
  rangeRecordsInstalled,
  rangeSeatsActiveTurn,
  recordSharingOrdinals,
  refreshSeatedRows,
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
import type { RemovedWorktreeRefs } from "@/lib/worktree/removed-worktree-refs";
import {
  readStagedWorktreeIntent,
  stagedDispatchDisplacement,
  stagedWorktreeIntentAwaitsDispatchFrom,
  stagedWorktreeIntentAwaitsDispatchOutcome,
  stagedWorktreeIntentDiffersFrom,
  partitionSweptIntent,
  partitionIntentAgainstSweptRefs,
  mergeRemovedWorktreeRefs,
  sessionSweptRefsForHost,
  stagedWorktreeIntentIsSuspended,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
// Runtime import, and cycle-free: `setup-card-rows` reaches
// `setup-card-segment` only through `import type`, which is erased, and nothing
// in its graph imports this store back.
import {
  buildSetupCardRows,
  type SetupCardRow,
} from "@/stores/chats/setup-card-rows";
import { transientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import { appLogger } from "@/lib/logger";
import type {
  ChatStreamCallbacks,
  ChatStreamClient,
} from "@traycer-clients/shared/host-transport/chat-stream-client";
import { SESSION_SILENCE_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/remote/config";
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
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
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
import type { ChatPortForward } from "@traycer/protocol/host/port-forward";
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
  LastFailedAttempt,
  LastFallbackOutcome,
  PendingFallback,
  PendingReturn,
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
import {
  buildTextOnlyPromptHandoff,
  buildUnrecordedPromptHandoff,
} from "@/lib/drafts/unrecorded-prompt-handoff";
import { resolveDraftImageBytes } from "@/lib/drafts/resolve-draft-image-bytes";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import { hashOnlyImageHashes } from "@/lib/composer/image-atoms";
import {
  invalidateDraftBlobConfirmations,
  markDraftBlobUnbridgeable,
} from "@/lib/drafts/draft-blob-transport";
import {
  decideDraftImageRefusal,
  type DraftImageRefusalCause,
} from "@/lib/drafts/draft-image-send-refusal";
import { reinlineRefusedSendContent } from "@/lib/drafts/draft-image-retry-content";
import { create, type StoreApi, type UseBoundStore } from "zustand";

export type ChatStreamClientHandle = Pick<
  ChatStreamClient,
  | "sendAction"
  | "close"
  | "sameTurnSteeringProtocolSupported"
  | "draftBlobBridgeSupported"
  // The two windowed READS. Required rather than optional even though every
  // implementation but the real client is a test double: the store calls them
  // unconditionally, and an optional method invoked through `?.()` is a silent
  // no-op - which on this line means a chat that asks for its tail, never
  // sends the request, and renders empty forever.
  | "requestTranscriptRange"
  | "requestResnapshot"
> &
  Partial<
    Pick<
      ChatStreamClient,
      | "interviewSettlementActionsProtocolSupported"
      // Optional for the same reason as its neighbour, and its ABSENCE is
      // read as `null` ("this handle cannot say") rather than `false`. A
      // double that never implemented the probe is not a line that refused
      // `auto`, and collapsing the two would veto the mode across every
      // fixture that predates it.
      | "autoPermissionModeProtocolSupported"
    >
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

/**
 * A grace-hold lease, from the frame that asked for it to the ack that minted
 * it. See `ChatSessionState.fallbackChoiceLease`.
 */
export interface FallbackChoiceLease {
  readonly traversalId: string;
  /** The `fallback.holdForChoice` frame this lease is the answer to. */
  readonly clientActionId: string;
  /** The host's token, once the ack carries one. `null` while `pending`. */
  readonly token: string | null;
  readonly status: "pending" | "held" | "refused";
  /**
   * The menu closed while the hold was still `pending` - so this lease OWES a
   * release that it has no token to send yet.
   *
   * Menu visibility and lease lifetime are different facts, and conflating
   * them is what froze the countdown: dropping the slot on close discarded
   * the correlation, the ack that followed found no lease to mint into, and
   * the host went on holding a window nobody could give back. The obligation
   * outlives the popover instead; `dispatchPendingChoiceRelease` discharges
   * it the moment the token arrives.
   */
  readonly releaseRequested: boolean;
  /**
   * The connection this lease was minted on, so a snapshot can tell a REAL
   * detach from a same-subscription refresh.
   *
   * A snapshot is not evidence of reattachment: the host answers a resnapshot
   * without replacing the subscriber and broadcasts one on every sibling-count
   * change. Only a dropped connection resumes the frozen remainder host-side,
   * and only a dropped connection moves this number - the same rule
   * `sweepStaleRestoreSlot` and `retireBeforeConnectionEpoch` already retire
   * their slots by.
   */
  readonly connectionEpoch: number;
}
/**
 * A manual fallback action the HOST confirmed, for the transcript announcer.
 *
 * The error card's rungs are the one fallback action with no DTO behind them.
 * A grace or waiting card's pick is visible as a `pendingFallback` state
 * transition, so a surface watching the stream sees it happen; the error card
 * acts on a failed ATTEMPT precisely because no traversal is live, and there
 * is nothing on any frame that says "this switch was applied". Without a
 * record the announcer would have to infer the outcome from the absence of
 * something, which is the mistake `pendingFallback`'s own contract warns about.
 *
 * Written from the MUTATION's `onSuccess` rather than a call site's, and that
 * is the load-bearing detail: the popover closes on `applied`, so by the time
 * the answer arrives the component that sent it is gone. TanStack runs a
 * `useMutation`-level callback from the Mutation in the cache, which outlives
 * the observer; the per-call `mutate(vars, { onSuccess })` handlers do not run
 * at all after unmount.
 */
export interface ConfirmedManualFallbackAction {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly rung: "retry" | "switch" | "wait_once";
  /**
   * The attempt the action named - BOTH halves, because the reuse path
   * re-sends one persisted user message across retries, so `userMessageId`
   * alone cannot tell an attempt from a replay of it.
   */
  readonly userMessageId: string;
  readonly turnId: string;
  /** Where a switch went. `null` for `retry` and `wait_once`, which stay put. */
  readonly target: ChatRunSettings | null;
  /**
   * Monotonic per store instance - the consumer's dedupe key.
   *
   * A counter and not a timestamp: two identical switches must be
   * distinguishable ("announce this one again" has to be expressible), and the
   * store's injected test clock is frozen, so a timestamp would collide on
   * exactly the case a dedupe key exists for.
   */
  readonly sequence: number;
}

/**
 * A fallback action's answer that arrived with nowhere to render it.
 *
 * The sibling case to {@link ConfirmedManualFallbackAction}, and the one MF11
 * found. A destination pick is answered by the host asynchronously, and the
 * surface that sent it is a POPOVER on a card the traversal's own next
 * transition removes: `waiting -> switching` replaces the waiting subtree
 * wholesale, so a losing pick's refusal can land with the menu, its inline
 * refusal line and its live region all gone. TanStack skips a per-call
 * `mutate(vars, { onSuccess })` handler once its observer has no listeners, so
 * that refusal was not merely invisible - it was never delivered anywhere.
 *
 * `text` is the already-rendered sentence rather than the raw outcome, and
 * deliberately: the wording is the chat surfaces' (`describeFallbackOutcome`),
 * and re-deriving it in the announcer would be a second copy table for one set
 * of facts - which is exactly how the two would come to disagree.
 *
 * Only outcomes NO mounted surface will report reach this record. A menu that
 * is still open answers inline, where the user is looking; this is the
 * fallback for when there is nowhere left to look. An `applied` outcome never
 * reaches it at all - the frame that follows, and the host's own durable
 * notice, are that outcome's feedback, and a second announcement would be the
 * duplicate the finding rules out.
 */
export interface UnattendedFallbackOutcome {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  /** The sentence to speak, already resolved by the surface's copy table. */
  readonly text: string;
  /**
   * Monotonic per store instance - the consumer's dedupe key, for the same
   * reason {@link ConfirmedManualFallbackAction.sequence} is one: two refusals
   * of the same pick are distinguishable only by this counter.
   */
  readonly sequence: number;
}

type ChatSnapshotFrame = Parameters<ChatStreamCallbacks["onSnapshot"]>[0];
type ChatWindowedSnapshotFrame = Parameters<
  ChatStreamCallbacks["onWindowedSnapshot"]
>[0];
/**
 * The windowed snapshot fields a LATER frame can supersede.
 *
 * Exactly the ones `applyAuthoritativeSnapshot` copies across from
 * `frame.snapshot` without consulting the transcript, plus `queue`, whose
 * merge takes the authoritative list as an input. Everything else the fold
 * produces is derived from the transcript or from store state the delta frames
 * have already updated in place, so replaying it is not a regression.
 *
 * Listed rather than `Partial<...>` of the whole snapshot: a field added to the
 * snapshot that a delta frame can also change has to be added here
 * deliberately, and a `Partial` would silently accept the omission.
 */
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
  | "portForwards"
  // All four fallback DTOs qualify under this type's own rule: they are on the
  // windowed snapshot AND `turnStateChanged` supersedes them. Omitting them
  // here would not merely replay a stale value - it would replay it
  // PERMANENTLY, because nothing re-sends a card that has already cleared, so
  // a deferred snapshot landing after a settle would put a dead grace
  // countdown back on screen for the rest of the session.
  | "pendingFallback"
  | "pendingReturn"
  | "lastFailedAttempt"
  // The outcome (D215) is here for the replay rule above AND for a second
  // reason the other three do not have: it is the only one of the four with a
  // consumer that must speak it EXACTLY ONCE. A stale replay is not a stale
  // card there, it is a false announcement of a result that was superseded.
  | "lastFallbackOutcome"
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
    portForwards: snapshot.portForwards,
    pendingFallback: snapshot.pendingFallback,
    pendingReturn: snapshot.pendingReturn,
    lastFailedAttempt: snapshot.lastFailedAttempt,
    lastFallbackOutcome: snapshot.lastFallbackOutcome,
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
 * What a send hands back to the composer if it never lands - the pre-submit
 * document plus the annotation cards that left with it. One value so a new
 * restorable composer artifact costs no call-site edits.
 */
export interface ChatSendRestore {
  readonly content: JsonContent;
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
}

/**
 * One queued row's prompt, held across its cancel's round trip. See
 * {@link ChatSessionState.pendingCancelRestorations}.
 */
export interface PendingCancelRestoration {
  /**
   * The row this cancel targets. The reconnect arm has no ack to read, so the
   * snapshot's queue is its evidence: row gone means the host honoured the
   * cancel, row present means it did not.
   */
  readonly queueItemId: string;
  readonly restore: ChatSendRestore;
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
   * Pre-submit composer document (no crop atoms) plus its annotation cards.
   * Used when a settled turn never recorded the send, so restore does not
   * inline the wire image atoms or drop the records.
   */
  readonly restore: ChatSendRestore;
  /**
   * The billing context this send was stamped with at dispatch. Retained for
   * the same reason `settings` is: it dies with the action, so a resend picks
   * up whatever the account picker holds NOW, and billing a different account
   * is exactly the surprise the drift statement exists to prevent.
   */
  readonly accountContext: AccountContext;
  /**
   * The delivery the send was dispatched with. Retained for the same reason
   * `settings` and `accountContext` are: it dies with the action, and a resend
   * takes whatever the composer's submit gesture implies now - so a message
   * queued to land after a safe point can come back and interrupt instead.
   */
  readonly deliveryPolicy: ChatQueueDeliveryPolicy | null;
  /**
   * The staged worktree choice this send consumed at dispatch, carried here so
   * it OUTLIVES the accepted ack. It is copied onto the accepted record too
   * (`AcceptedChatAction.restoreWorktreeIntent`), because the pending action -
   * the other copy - is dropped the moment the ack lands. A send stopped after
   * acceptance but before `messageAccepted` is restored to the composer by the
   * settled pass, and one that dies on a dropped connection by the accepted
   * pass in `reconcileSnapshotChange`; restoring either prompt without its
   * worktree is the silent-local-run {@link restoreStagedWorktreeIntent}
   * exists to prevent.
   */
  readonly restoreWorktreeIntent: WorktreeIntent | null;
}

/**
 * The durable outbox tuple a retry may requeue. `generation` is the compare-
 * and-swap guard that prevents a stale card from requeueing a newer attempt;
 * a later host projection also supersedes the accepted renderer action.
 */
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
  /**
   * Checkpoint targeted by a `restoreCheckpoint`; `null` for every other
   * action. With `revertArtifacts` it is the whole restore frame, so the
   * accepted record can RETRANSMIT the action after a reconnect: the host
   * answers a retried client action id from its durable outcome (or runs the
   * restore again when it never finished), which is the only completion
   * evidence a windowed reconnect can recover - its snapshot carries hydrated
   * transcript rows, and the restore outcome is not one.
   */
  readonly checkpointId: string | null;
  /** See {@link PendingChatAction.checkpointId}; `null` for every other action. */
  readonly revertArtifacts: boolean | null;
  // For `interviewAnswer` / `interviewError`, the interview block this action
  // targets; `null` for every other action. Lets the UI gate exactly the card
  // whose answer/skip is in flight (or accepted-but-unresolved) rather than all
  // interviews, and lets lifecycle resolution drop this block's stale actions.
  readonly interviewBlockId: string | null;
  /** Immutable retry identity; null for all non-delivery-retry actions. */
  readonly interviewDeliveryRetry: InterviewDeliveryRetryIdentity | null;
  readonly messageId: string | null;
  readonly restore: ChatSendRestore | null;
  /**
   * The attachment hashes this action put ON THE WIRE, for the ack memo
   * retraction - and carried SEPARATELY from {@link restore} on purpose.
   *
   * `restore` means "the prompt to hand back to the composer", which is a
   * send-only notion and is deliberately `null` for an edit: an edit re-opens
   * its own editor rather than restoring a draft. But the memo retraction is
   * not about restoring anything - it is about the renderer's belief that this
   * host holds these bytes, which a `MISSING_ATTACHMENT_BYTES` refusal falsifies
   * for whatever action carried them. Keying the retraction off `restore` tied
   * the two together and left every edit-and-resend refusal with a stale memo,
   * so the next Edit skipped the upload and was refused again, forever.
   *
   * `null` for actions that carry no content.
   */
  readonly sentContentHashes: ReadonlyArray<string> | null;
  readonly sender: UserMessageSender | null;
  readonly settings: ChatRunSettings | null;
  /** See {@link PendingUserMessage.accountContext}. */
  readonly accountContext: AccountContext | null;
  /** See {@link PendingUserMessage.deliveryPolicy}. */
  readonly deliveryPolicy: ChatQueueDeliveryPolicy | null;
  /**
   * Workspace selection consumed when a send goes on the wire. A rejected
   * send restores it to the owner's staging slot together with the composer
   * content, so retrying cannot silently fall back to the prior binding.
   */
  readonly restoreWorktreeIntent: WorktreeIntent | null;
  /**
   * Render-only copy of the consumed worktree choice. Unlike the restore copy,
   * this is retired once the host records the message, so retained action
   * bookkeeping cannot mask a newer binding after transcript-window eviction.
   */
  readonly displayWorktreeIntent: WorktreeIntent | null;
  /**
   * A live `messageAccepted` sighting retained across transcript-window
   * eviction until the action ack copies it to `AcceptedChatAction`.
   */
  readonly messageConfirmedByHost: boolean;
  /**
   * Whether this send IS the one inline retry of a refused hash-only send. A
   * `MISSING_ATTACHMENT_BYTES` rejection of a record carrying this surfaces the
   * host's reason rather than retrying again - the retry already carried the
   * bytes, so a second refusal is not about bytes we failed to send.
   */
  readonly hashOnlyRetry: boolean;
  /**
   * The document this action actually SENT, for a `send`; `null` for every
   * other action kind.
   *
   * Distinct from `restore.content` on purpose, and the distinction is the
   * whole point: `restore.content` is the composer's own document, captured
   * before submission appends annotation crop atoms and converts slash
   * commands, and it is what goes back into the composer on a hand-back. This
   * is what the host was given. A retry must rebuild from THIS or it silently
   * drops whatever submission added.
   */
  readonly wireContent: JsonContent | null;
  /**
   * Staging revision immediately after the send consumes its selection. A
   * rejection restores only when the user has made no newer picker choice.
   */
  readonly createdAt: number;
  /**
   * The connection epoch the action's frame was dispatched on (stamped by
   * `sendAction`). An epoch older than the one that produced the current
   * authoritative snapshot means the frame's ack can never arrive (frames
   * and acks are fire-and-forget per connection), so snapshot reconciliation
   * drops such non-message pendings instead of leaving their controls
   * disabled forever. Only `send` is excluded - it reconciles by messageId
   * with composer restoration. A stale `editUserMessage` is swept (its
   * applied edit still shows in the snapshot's messages either way; only
   * its accepted-action bookkeeping entry is skipped).
   */
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
   * Whether the path that created this slot ALREADY said the reason on a
   * surface the user can see.
   *
   * Each restored prompt's account is spoken exactly once. The rejection path
   * owns an `errorNotice` and states things there - that is deliberate, and
   * why it is `true` for that path. The two reconcile passes have no such
   * surface, so `ackFailedSendRestoration` speaks for them when the draft
   * lands in the composer.
   *
   * Without this the rejection path would say the same sentence twice, once
   * bare from its own notice and once qualified from the ack.
   */
  readonly stated: boolean;
  /**
   * The same account, told for a prompt that could NOT reach the composer.
   *
   * Baked here rather than derived at displacement, on the same rule the rest
   * of this family follows: the evidence is in hand when the slot is built and
   * gone by the time anyone consumes it. The only difference from
   * {@link reason} is `handedBack` - a displaced prompt's binding is released
   * rather than returned, so its worktree clauses have to ask for a re-pick
   * instead of reporting one already made.
   */
  readonly displacedReason: string;
}

export interface LiveAssistantMessage {
  readonly turnId: string;
  readonly sender: Extract<Message, { readonly role: "assistant" }>["sender"];
  readonly blocks: ReadonlyArray<ContentBlock>;
  /**
   * `ChatActiveTurn.startedAt` - set once at turn-start and never updated.
   * Mirrors the schema field on persisted `AssistantMessage` so the live row
   * and its persisted form share the same wall-clock anchor.
   */
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
   * Reasoning effort + service tier the turn is running with, mirrored from
   * `ChatActiveTurn` so the live row and its persisted `AssistantMessage` form
   * carry the same per-turn run metadata.
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
  // When reverting, also revert the artifact changes in scope (the dialog's
  // checked-by-default "Also revert N artifacts" opt-out). Ignored when
  // revertFileChanges is false.
  readonly revertArtifacts: boolean;
}

export interface AcceptedChatAction {
  readonly clientActionId: string;
  readonly action: ChatOwnerActionFrame["kind"];
  /** Carries an accepted queueCancel projection until host queue truth lands. */
  readonly queueItemId: string | null;
  /** See {@link PendingChatAction.checkpointId}. */
  readonly checkpointId: string | null;
  /** See {@link PendingChatAction.checkpointId}. */
  readonly revertArtifacts: boolean | null;
  // Carried over from the originating `PendingChatAction` so an accepted-but-
  // unresolved interview answer/skip keeps gating its card. `null` for every
  // non-interview action.
  readonly interviewBlockId: string | null;
  readonly interviewDeliveryRetry: InterviewDeliveryRetryIdentity | null;
  readonly messageId: string | null;
  readonly acceptedAt: number;
  /**
   * Structured prompt content carried over from the originating
   * `PendingChatAction` when the host accepts a `send`. The content survives
   * `actionAck`/`messageAccepted` and lives on the accepted record so a later
   * setup-gating `setup.failed` for the same `messageId` can still restore the
   * prompt to the composer, AND so a reconnect snapshot can settle an accepted
   * send that died before the host recorded it - see
   * {@link reconcileSnapshotChange}. `null` for non-`send` actions and after
   * the content has been consumed once by `takeSetupFailedRestoration`.
   */
  readonly restore: ChatSendRestore | null;
  /**
   * The rest of the recovery tuple, for `send` records only.
   *
   * This record used to keep "only what action bookkeeping needs", and that
   * was the whole defect: a send accepted while a turn was running renders as
   * a QUEUED item rather than a `pendingUserMessage`, so `pendingActions` was
   * the only place its recovery fields lived - and the accepted ack moved it
   * here, dropping them. If the connection then died before `queueChanged` or
   * `messageAccepted`, no pass could see it: the snapshot reconciler walks
   * `pendingActions`, the settled pass walks `pendingUserMessages`, and this
   * record was read by nothing. The draft went with it, silently - a dead send
   * with no account, which is the one thing this whole surface promises cannot
   * happen.
   *
   * `null` on every non-`send` action.
   */
  readonly sender: UserMessageSender | null;
  readonly settings: ChatRunSettings | null;
  readonly accountContext: AccountContext | null;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy | null;
  readonly restoreWorktreeIntent: WorktreeIntent | null;
  /** See {@link PendingChatAction.displayWorktreeIntent}. */
  readonly displayWorktreeIntent: WorktreeIntent | null;
  /**
   * The connection this send was DISPATCHED on, carried across the accepted
   * ack. Absence from a snapshot is only evidence against an earlier
   * connection's dispatch - the same bar {@link reconcileSnapshotChange}
   * applies to pending sends, and for the same reason.
   */
  readonly connectionEpoch: number;
  /**
   * Whether the HOST has ever confirmed this send - reported it in the
   * transcript, or parked in the queue.
   *
   * Named for the fact rather than the messenger, because confirmation
   * arrives four ways and only one of them is a snapshot: a live
   * `queueChanged` (the common case - it fires promptly on the dispatching
   * connection), a snapshot's messages or queue, `messageAccepted` reporting
   * the message in the transcript, and - for the order where that frame
   * outran the ack - the transcript already holding the message when the ack
   * births this record. The ack itself confirms only that the host RECEIVED
   * the frame and so never counts on its own. A name that said "in snapshot"
   * would be false for the doors most sends actually come through.
   *
   * Absence stops being evidence once presence has been seen. A queued send
   * the user then CANCELS is absent from every later snapshot, and without
   * this the reconnect pass read that absence as death and pushed the
   * deliberately-discarded prompt back at them - on top of the copy the cancel
   * UX already put in the composer (`use-chat-queue-actions` replaces the
   * draft with the canceled item's content). The host's queue is DURABLE
   * across restarts - it is persisted on the chat record and rehydrated on
   * boot - so for an observed send, later absence can only mean the user
   * canceled it or the agent consumed it. Neither is a loss, and neither is
   * ours to narrate.
   *
   * It also covers the cross-client case a clear-on-cancel would miss: another
   * window of the same user cancels, and this client - which observed the item
   * - simply stays quiet.
   */
  readonly confirmedByHost: boolean;
}

/**
 * Discriminated restore-flow state. Collapses the previous trio of
 * mutually-exclusive nullable slots (`restoreInFlight`, `restoreProgress`,
 * `lastRestoreResult`) into a single value so consumers can branch on
 * `restore?.kind` without re-deriving "which slot wins."
 *
 * Lifecycle:
 *   null
 *   → onRestoreStarted    → { kind: "in-flight",   checkpointId, ... }
 *   → onRestoreProgress   → { kind: "progressing", checkpointId, ..., counts }
 *   → onRestoreCompleted  → { kind: "completed",   checkpointId, results }
 *
 * The `kind: "completed"` slot persists after the flow ends so toast and
 * dialog consumers can react to the latest result; a subsequent restore
 * overwrites it.
 */
export type ChatRestoreSlot =
  | {
      readonly kind: "in-flight";
      readonly checkpointId: string;
      readonly restoringUserId: string;
      readonly restoringHostId: string;
      readonly startedAt: number;
      /**
       * Connection epoch the `restoreStarted` frame arrived on. The slot is
       * frame-driven with no snapshot representation, so an in-flight slot
       * whose `restoreCompleted` was lost to a drop would spin forever; the
       * first authoritative snapshot of a NEWER connection clears such a
       * stale slot instead. Trade-off: progress frames refine only an
       * existing slot, so a restore genuinely still running re-surfaces only
       * at its `restoreCompleted` (progress shown until then is lost).
       */
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
 * The chat record MINUS its transcript spine.
 *
 * `ChatSessionState` keeps the transcript in its own `messages`/`events`
 * fields, and the snapshot's `chat` carries the same arrays a second time.
 * Storing both meant every session retained the whole transcript TWICE - on a
 * 40 MB chat across the ~30 live subscriptions a multi-pane workspace holds,
 * that second copy is the larger half of the store's footprint - to serve four
 * scalar reads (`title`, `isTitleEditedByUser`, `settings`, `parentId`).
 *
 * The fields are omitted from the TYPE rather than merely left unassigned, so
 * the compiler is what proves nothing reads them. Anything that needs the
 * transcript reads `state.messages` / `state.events`, which is where the
 * merge, the row projection and (with the windowed transcript) hydration all
 * already look.
 */
export type ChatSessionRecord = Omit<Chat, "messages" | "events">;

/**
 * Drops the transcript arrays off a snapshot's chat record.
 *
 * Written as a destructure so adding a transcript-bearing field to `Chat`
 * cannot silently start being retained again: the omission is expressed once,
 * here and in {@link ChatSessionRecord}, and the two are checked against each
 * other by the return type.
 */
function chatRecordWithoutTranscript(chat: Chat): ChatSessionRecord {
  const { messages: _messages, events: _events, ...record } = chat;
  return record;
}

/**
 * What the connection attempts BEFORE the first snapshot have produced - the
 * evidence the chat tile's pre-content body reads (`chat-pre-content.ts`).
 *
 * It exists because a stream can fail forever without ever going terminal. A
 * host that refuses `chat.subscribe` with a RETRYABLE fatal (host 1.2.0 on a
 * chat store a 1.3 host migrated answers `CHAT_OPEN_FAILED` that way, per open
 * attempt, indefinitely) is handled inside the transport as an ordinary drop:
 * it reconnects on its own backoff, so `fatalClose` stays `null` and
 * `snapshotLoaded` stays `false` with nothing to end the spinner. Counting the
 * attempts here - where they are already observed - is what lets the tile say
 * so.
 */
export interface PreSnapshotRetryEvidence {
  /** Failed attempts observed while this session had no snapshot. */
  readonly count: number;
  /** When the first of them was observed (epoch ms). */
  readonly firstAt: number;
  /**
   * The host's own code and reason from the most recent attempt that carried
   * them - an attempt that carries none leaves the last pair standing rather
   * than erasing it.
   *
   * Both transports publish a retryable close's details as the `retryCause`
   * of the `reconnecting` transition it causes - a host's `CHAT_OPEN_FAILED`,
   * or a chat session's lifecycle refusal such as `SESSION_NOT_READY` - and
   * that is what fills these. A dropped socket or a failed dial has no cause,
   * so it counts without touching them. They are what the tile's report
   * carries as the host's code.
   */
  readonly code: string | null;
  readonly reason: string | null;
}

/**
 * The streak after one more failed pre-snapshot attempt.
 *
 * `now` is passed in rather than read here so the fold stays pure - the clock
 * read belongs to the caller that observed the failure.
 */
function countPreSnapshotRetry(
  previous: PreSnapshotRetryEvidence | null,
  details: FatalErrorDetails | null,
  now: number,
): PreSnapshotRetryEvidence {
  return {
    count: (previous?.count ?? 0) + 1,
    // Stamped by the FIRST failure and never moved: a tile that mounts into
    // this streak dates its wait from here (`chatLoadWaitBeganAt`), which asks
    // how long this load has been failing, not how long ago the newest
    // attempt died.
    firstAt: previous?.firstAt ?? now,
    code: details?.code ?? previous?.code ?? null,
    reason: details?.reason ?? previous?.reason ?? null,
  };
}

export interface ChatSessionState {
  readonly epicId: string;
  readonly chatId: string;
  readonly connectionStatus: StreamConnectionStatus;
  /**
   * Set when the host terminates the `chat.subscribe` stream with a
   * `fatalError` (e.g. `CHAT_INVALID` or `CHAT_NOT_VISIBLE`, each sent under
   * its own code). Drives the tile's error state instead of an indefinite
   * loading spinner when a snapshot never arrives. Cleared on every fresh
   * (re)connect attempt.
   */
  readonly fatalClose: FatalErrorDetails | null;
  readonly snapshotLoaded: boolean;
  /**
   * See {@link PreSnapshotRetryEvidence}. `null` while nothing has failed -
   * a fresh session, or one whose snapshot has landed.
   */
  readonly preSnapshotRetries: PreSnapshotRetryEvidence | null;
  /**
   * When a LOADED session was last dropped back into a pre-snapshot wait, or
   * `null` while this session has never finished one.
   *
   * `retry()` clears `snapshotLoaded`, and its three automatic callers - the
   * wake pulse, the plan-restricted reprobe and the host-version move - all
   * reach a session whose transcript is already on screen. The tile's own
   * anchor is its FIRST render for the chat, so without this stamp a tile
   * mounted longer than the deadline would declare the replacement
   * subscription overdue on sight and put the "hasn't loaded yet" card over a
   * fresh attempt that has had no time at all. See `chatLoadWaitBeganAt`.
   *
   * Stamped only when a snapshot HAD landed, so the ordinary first load - and
   * a Try again pressed during one - keeps the tile's anchor and the
   * handle-pending half of the wait still restarts nothing.
   */
  readonly preSnapshotReloadStartedAt: number | null;
  /**
   * The connection whose authoritative snapshot established the CURRENT
   * transcript, or `NO_TRANSCRIPT_BASELINE` before the first one lands.
   *
   * Consumers that must tell a live arrival from transcript history read
   * this instead of inferring it from row shape (see `useChatAnnouncements`):
   * a changed value means the transcript was (re)hydrated wholesale - mount,
   * or a reconnect that can backfill rows written while this client was
   * away - so whatever is visible is history. An unchanged value means the
   * client has been connected and watching since the last observation, so
   * anything that appears or settles is live, however it sorts and whenever
   * its timestamps say it happened. Steady-state snapshots on the SAME
   * connection (an authoritative host-side refresh) deliberately keep the
   * value, since those carry live news too.
   */
  readonly transcriptBaselineEpoch: number;
  /**
   * The connection generation, mirrored into state so it can be SUBSCRIBED to.
   *
   * Its partner is {@link transcriptBaselineEpoch}, which is set to this value
   * when a snapshot seats. So the two together answer a question neither can
   * answer alone: `transcriptBaselineEpoch === connectionEpoch` means the
   * visible transcript was hydrated on the connection that is live NOW, and an
   * inequality means THE CURRENT CONNECTION HAS NOT SEATED ITS BASELINE.
   *
   * That is deliberately weaker than "the client reconnected", because two
   * different states produce the inequality and only one of them is a
   * reconnect: a cold mount has never seated anything, and its baseline is
   * `NO_TRANSCRIPT_BASELINE` (**-1**, not `0`) against an epoch of `0`. Both
   * states correctly mean "do not treat what you see as live news yet", which
   * is why one predicate serves both. A consumer that needs to tell them apart
   * tests `transcriptBaselineEpoch === NO_TRANSCRIPT_BASELINE`; it must never
   * infer "reconnecting" from the inequality alone.
   *
   * The reconnect window is short and invisible from outside, and it is exactly
   * where a consumer can mistake reconnect history for live news.
   *
   * A warm remount is the case this exists for. A tile can close and reopen
   * across an automatic reconnect while the store and transport survive: a
   * freshly mounted consumer never personally observed the disconnect, and
   * `snapshotLoaded` still describes the OLD connection. Comparing these two
   * epochs is recoverable from state alone and needs no status history.
   *
   * MIRRORED, not authoritative. The counter itself is a closure variable
   * written only by `bumpConnectionEpoch`, which exists so this field cannot
   * drift from it - a `+= 1` that forgets the mirror would leave every
   * subscriber reading a stale generation with nothing to signal the error.
   * Deliberately NOT `snapshotLoaded`: that flag renders the cached transcript
   * (`ChatSessionMessagesSurface`) and clearing it on reconnect would blank a
   * transcript the reader can legitimately still see.
   */
  readonly connectionEpoch: number;
  /**
   * Bumped whenever a range response seated rows the reader SCROLLED to.
   *
   * The third way transcript data reaches this client, and the one
   * `transcriptBaselineEpoch` cannot describe. That epoch separates "the
   * transcript was rehydrated wholesale" from "we have been watching since the
   * last observation", and on the windowed line neither fits a range: the
   * connection is unchanged and watching, yet the rows that just appeared are
   * settled history the reader travelled backwards to reach, not news.
   *
   * Consumers that would otherwise read a newly-present settled row as a live
   * arrival (see `useChatAnnouncements`, which would announce a turn from last
   * week as it scrolled into view) absorb rows that appear across a change in
   * this counter. Always `0` off the windowed line, where nothing hydrates
   * ranges.
   */
  readonly transcriptHydrationSequence: number;
  /**
   * What each hydrated row renders WITH, by row id.
   *
   * The host projects a row against whole history; a range serves that row's
   * records alone. Every derivation that reads the rows AROUND the one it is
   * drawing therefore gets a different answer from a bounded subset - and in
   * two cases the re-derived row id then disagrees with the skeleton, so the
   * ordinal is suppressed and the row draws unplaced. Those derivations read
   * this instead. See `row-context.ts`.
   *
   * Published in the SAME `set` as the records it describes, so no consumer
   * can observe rows against a previous hydration's context. Empty off the
   * windowed line, where `messages` is the whole transcript and every
   * derivation can still see everything it needs.
   */
  readonly transcriptRowContext: Readonly<Record<string, TranscriptRowContext>>;
  readonly chat: ChatSessionRecord | null;
  readonly access: ChatAccess | null;
  readonly messages: ReadonlyArray<Message>;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly queue: ChatQueueState;
  /**
   * Host-owned chat run state (`idle | running | stopping`). The single
   * source of truth the GUI reads for its in-progress indicators (response
   * row, composer stop button, sidebar/tab marker). Carried by every
   * `chat.subscribe` snapshot and `turnStateChanged` frame so it covers the
   * first create turn and every multi-turn send, and flips to `stopping` the
   * moment a stop is requested. Never derived on the renderer.
   */
  readonly runStatus: ChatRunStatus;
  readonly activeTurn: ChatActiveTurn | null;
  /**
   * Whether the tab's negotiated `chat.subscribe` protocol version understands
   * the `after_safe_point` explicit-steer delivery policy (host handshake
   * minor >= 5). A new renderer paired with a released <=1.4 host must NOT emit
   * `after_safe_point`: that host predates same-turn steering and would inject
   * the message under whatever ordering/settings it does understand. Captured
   * once the stream reaches `open` (the version is stable per connection);
   * `false` until then and on any non-open status, so `Mod-Enter` degrades to
   * the plain-Enter queue alias until steer support is confirmed.
   */
  readonly steerProtocolSupported: boolean;
  /** Own stream's draft-blob bridge capability; false until open and on disconnect. */
  readonly draftBlobBridgeSupported: boolean;
  /** `chat.subscribe@1.7` support for detached interview delivery retries. */
  readonly interviewDeliveryRetryProtocolSupported: boolean;
  /**
   * Whether THIS tab's negotiated `chat.subscribe` line can carry
   * `permissionMode: "auto"` on a client frame (`@1.13`), or `null` while the
   * session cannot say - not yet `open`, or a handle without the probe.
   *
   * The mode is OFFERED from the harness catalog line
   * (`agent.gui.listHarnesses@9.1`) and CARRIED on this one, which are
   * different methods and negotiate independently. A composer that gates only
   * on the catalog can light up Auto on a line that then refuses the frame -
   * `projectChatClientFrameForVersion` throws rather than dropping it - so a
   * chat composer has to hold both and this is the half only a session knows.
   */
  readonly autoPermissionModeProtocolSupported: boolean | null;
  /**
   * The host's own `isTurnInProgress()`: is a turn genuinely active or
   * activating right now? Narrower than `runStatus !== "idle"`, which also
   * reads "running" for a pending queued item or visible background work
   * outliving the turn - neither of which this corresponds to. `undefined`
   * means an older host that predates this field; consumers should fall back
   * to their own `runStatus`/`activeTurn`/`queue`/`backgroundItems`-derived
   * approximation (see `chat-tile-session-state.ts`) rather than treat a
   * missing value as a fixed true/false for the whole session.
   */
  readonly turnInProgress: boolean | undefined;
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingInterviews: ReadonlyArray<ChatPendingInterviewState>;
  readonly accumulatedFileChanges: ReadonlyArray<ChatAccumulatedFileChange>;
  /**
   * The transcript index and whichever bodies are hydrated, on the windowed
   * line. Empty on every other line, where the whole transcript rides the
   * snapshot and {@link messages} is complete by construction.
   *
   * `messages`/`events` are DERIVED from this on the windowed line - they hold
   * what is hydrated, not what exists. `transcriptWindow.rowCount` is what
   * exists.
   */
  readonly transcriptWindow: TranscriptWindow;
  /**
   * Whole-transcript folds the host computed because a windowed client cannot:
   * the pinned-todo stack, the latest usage, the fork boundary, and the
   * restorable setup interruption (whose event occupies no ordinal at all).
   * `null` off the windowed line, where each is still derived locally.
   */
  readonly transcriptDerived: ChatTranscriptDerived | null;
  /**
   * How many files this chat has touched, per the windowed snapshot - what the
   * accumulated-changes panel paints its collapsed header from before any
   * summary chunk lands. `0` off the windowed line, where
   * {@link accumulatedFileChanges} carries the whole set.
   */
  readonly accumulatedFileChangeCount: number;
  /**
   * Rows rewritten while their span was EVICTED, so the rewrite was dropped.
   *
   * Provenance, not content: the body itself is recovered by the next
   * hydration. What this preserves is that the row's next appearance is NEWS
   * rather than history - see `rewriteMessageInPlace` and
   * `ChatAnnouncementsInput.coldRewrittenMessageIds`. Empty on the legacy
   * line, which evicts nothing.
   */
  readonly coldRewrittenMessageIds: ReadonlySet<string>;
  /**
   * An ordinal a pending transcript JUMP needs hydrated, or `null`.
   *
   * Set by the surface that holds the jump request when its target resolves to
   * a row outside the retained spans, and cleared when the jump is consumed.
   * See {@link requiredHydrationOrdinalsOf}.
   */
  readonly jumpTargetOrdinal: number | null;
  /**
   * The accumulated-change SUMMARIES, assembled from the chunk frames.
   *
   * Separate from {@link accumulatedFileChanges} rather than replacing it,
   * because they are different types: a summary carries a digest and counts,
   * not the before/after CONTENTS. `accumulatedFileChanges` stays empty on this
   * line and nothing reads it here - the panel takes a content-free row model
   * both lines produce (`accumulated-change-rows.ts`), and the contents are
   * fetched by digest only by the diff tile a row click opens.
   */
  readonly accumulatedFileChangeSummaries: ReadonlyArray<ChatAccumulatedFileChangeSummary>;
  /**
   * Whether any chunk of the CURRENT summary generation has been accepted.
   *
   * The array above is deliberately retained across a rebuild (see the
   * generation reset), so between the reset and the first replacement chunk it
   * holds the PREVIOUS generation's entries - with the previous digests. A
   * length comparison cannot see that: when the replacement stream's total
   * happens to equal the retained length, which is the common case for a set
   * that has not changed and the certain case for a set that fits one chunk,
   * "delivered === authoritative" is true over entries no chunk of this
   * generation ever sent.
   *
   * So completeness is answered by GENERATION, not by length: false here means
   * the retained array cannot vouch for anything, whatever its length.
   */
  readonly accumulatedSummaryGenerationSeated: boolean;
  /**
   * Whether a replacement generation is being assembled off-screen right now.
   *
   * The public face of the store's private assembly buffer, and the reason it
   * has one: unseated-plus-zero-count is BOTH "a chat with no accumulated
   * changes", which is complete, and "a generation mid-flight whose count a
   * delayed same-epoch snapshot rewound to zero", which is not. Nothing
   * outside this store could tell those apart, so
   * {@link accumulatedSummarySetComplete} read the second as the first and
   * every consumer of it treated an empty published array as authoritative -
   * bundle paths absent from it reading as reverted.
   */
  readonly accumulatedSummaryAssemblyStarted: boolean;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  /**
   * The live fallback traversal on this chat (`chat.subscribe@1.10`), or
   * `undefined` when there is none.
   *
   * DERIVED per frame by the host and NEVER accumulated here: the durable
   * record outlives the session that produced it, so every frame carrying this
   * key is the whole truth as of that frame. That is why the appliers below
   * assign it straight across instead of taking the `??` fallback
   * {@link backgroundItems} takes - for that field an omitted key means
   * "unchanged", but here `undefined` means "there is no traversal", which is
   * exactly the value that clears the card. A `??` would pin a grace countdown
   * on screen for the rest of the session, and it is the same value an older
   * host's silence produces, so one code path serves both.
   *
   * `undefined` also covers every pre-`1.10` host: the key is stripped from
   * those lines by the host's own projection, so a client on an old host simply
   * never offers the affordances.
   */
  readonly pendingFallback: PendingFallback | undefined;
  /**
   * The switch-back offer (`chat.subscribe@1.10`), or `undefined` when none is
   * up.
   *
   * Same derived-per-frame contract as {@link pendingFallback}, and the same
   * assign-straight-across rule. Read this by VALUE and never by key presence:
   * on a live `1.10` frame the KEY is always set - the host's builders write it
   * unconditionally, with `undefined` meaning "clear the banner" - so a
   * presence test (`"pendingReturn" in frame`) reads as "offer up" forever.
   * The host's own projection tests the key, because ITS question is the mirror
   * one (may this peer see the key at all); a renderer's question is whether
   * there is an offer.
   */
  readonly pendingReturn: PendingReturn | undefined;
  /**
   * The chat's latest terminal failure, when the host would admit a manual
   * rung on it (`chat.subscribe@1.10`, D152/D156) - the error card's Retry /
   * Switch… / Wait-until affordances and nothing else.
   *
   * Same derived-per-frame contract and the same assign-straight-across rule
   * as the two above, and the same BY-VALUE read. Two things about this one
   * specifically:
   *
   * **Never accumulate it.** `undefined` is what HIDES the affordances, and a
   * store that kept its last value would offer Retry on a turn that has since
   * succeeded - the defect D122 closed on the host, arriving through the
   * renderer instead.
   *
   * **`eligibleRungs: []` is a different fact from an absent value.** Absent
   * means no affordances at all; empty means the host walked its guard chain
   * and admitted nothing for this failure (`auth` is exactly that shape). A
   * reader that falls back to offering all three on an empty array rebuilds
   * the dead-button case the field exists to remove.
   */
  readonly lastFailedAttempt: LastFailedAttempt | undefined;
  /**
   * The last CONFIRMED fallback result for the current incident
   * (`chat.subscribe@1.10`, D215/D218), or `undefined` when there is none.
   *
   * Same derived-per-frame contract, same assign-straight-across rule and same
   * BY-VALUE read as the three above. What is different is what a reader may
   * conclude from it, and the two rules below are the host's, not this store's.
   *
   * **Absence is not an outcome.** The key clears when a new traversal arms, so
   * absent means "no confirmed outcome for the current incident" - never
   * success, cancellation or failure. Do not infer one from this key
   * disappearing, and do not infer one from {@link pendingFallback}
   * disappearing either: terminal success, cancel and failure are all absent
   * there too. A consumer that treats absence as a result announces outcomes
   * that never happened.
   *
   * **`sequence` is not a cross-incident counter.** It is a total order over
   * writes to THIS slot, starting at 1 and reset when a new traversal arms, so
   * incident B's `2` is not after incident A's `7`. It orders one incident's
   * writes and nothing else; identity and dedupe belong to `blockId`, which is
   * minted deterministically so a replayed phase re-derives the same string.
   *
   * It replaced a `revision` that could TIE. The settled notice is appended
   * BEFORE the terminal transition commits, so a settle with no intervening
   * transition carried the identical number as the preceding hop's `applied` -
   * and `applied` → `applied` → `settled` is the ordinary shape, not a corner
   * case. `sequence` is minted at the write site from the slot being replaced,
   * so it cannot tie.
   *
   * Not to be confused with `PendingFallback.revision`: a different field on a
   * different DTO, NOT renamed, and the one the cancel verb presents. Two
   * fields named `revision` on neighbouring fallback DTOs is exactly the shape
   * that gets one read for the other, which is half of why this one moved.
   *
   * `assistantMessageId` may point OUTSIDE the bounded tail - that is the whole
   * reason the field exists - so treat it as an anchor for later hydration,
   * never as a row readable from the frame that carried it.
   */
  readonly lastFallbackOutcome: LastFallbackOutcome | undefined;
  /**
   * The shells this chat created, whatever state they are in - not a subset
   * of {@link backgroundItems}, since a shell outlives the turn that started
   * it. Carried whole by every snapshot and every `managedCommandsChanged`
   * frame, so keeping it current is one assignment.
   *
   * Always an array, never `undefined`: a host too old to send the field has no
   * managed-command subsystem, so it owns no commands and `[]` is the truth
   * rather than a fallback. The surfaces are presence-based and render "old
   * host" and "none yet" identically.
   */
  readonly managedCommands: ReadonlyArray<ManagedCommand>;
  /**
   * The subset of {@link managedCommands} whose last output a committed Stop
   * fence is holding back. Carried whole by every snapshot and every
   * `heldUpdatesChanged` frame, so keeping it current is one assignment.
   *
   * Its own field rather than a flag on the command row because a hold is not a
   * property of the command: it belongs to the Stop that captured it, appears
   * and clears without the command's own status moving, and outlives the host
   * process that installed it. Always an array, for the same reason
   * {@link managedCommands} is - a host too old to send it cannot install holds
   * either, so `[]` is the truth and not a fallback.
   */
  readonly heldUpdates: ReadonlyArray<HeldManagedCommandUpdate>;
  /**
   * This agent's port forwards (`chat.subscribe@1.14`). Carried whole by every
   * snapshot and every `portForwardsChanged` frame, so keeping it current is
   * one assignment - the same contract {@link managedCommands} has, and `[]`
   * for the same reason: a host too old to send the field cannot forward a
   * port, so "none" is the truth and not a fallback.
   *
   * The row has no byte or connection counters on purpose (they would re-send
   * this whole set per packet); those live on the host-level listing.
   *
   * Not one of the budgeted whole-set slices, like {@link heldUpdates}: a
   * forward is a deliberate act and its row is a few short strings, so the set
   * cannot grow into something the chat-windows accountant needs to see.
   */
  readonly portForwards: ReadonlyArray<ChatPortForward>;
  /**
   * In-flight per-item background stops, keyed by `taskId` → the
   * `clientActionId` of the stop frame that was sent. An entry exists from the
   * moment its Stop frame is dispatched until the host either removes that item
   * from {@link backgroundItems} (its terminal) or rejects the stop. Drives
   * per-row Stop disabling and the no-duplicate-frame guard - a repeat stop for
   * an already-stopping task is a no-op.
   */
  readonly pendingBackgroundStops: Readonly<Record<string, string>>;
  /**
   * The in-flight "Stop all" background request (its `clientActionId`), or
   * null. Used only while the stop-all frame is outstanding before its ack; the
   * matching ack clears it. Accepted task ids from that ack move into
   * `pendingBackgroundStops`, which then owns per-row disabling until those
   * tasks leave the running list.
   */
  readonly pendingBackgroundStopAll: {
    readonly clientActionId: string;
    readonly taskIds: ReadonlySet<string>;
  } | null;
  /**
   * The in-flight session-scoped background stop (the escalation for commands
   * carrying `individualStopUnavailable`), or null. Two phases:
   * `awaitingTurnEnd` means the turn-stop frame went out first and the
   * session-stop frame is dispatched the moment a turn-state frame reports
   * the turn settled - the host refuses a session stop under a live turn, so
   * the client owns this sequencing. `clientActionId` is the ack handle of
   * whichever frame the current phase is waiting on: the turn-stop frame
   * while `awaitingTurnEnd`, the session-stop frame after. Tracking the
   * phase-one id lets a rejected turn stop (turn genuinely still running)
   * release the escalation instead of stranding it, and lets the reconnect
   * sweep drop either phase when its frame died with the connection.
   * `turnId` is the turn phase one stopped (null when unknown or in phase
   * two): if a DIFFERENT turn is ever seen active, the escalation is stale -
   * a queued turn started meanwhile - and firing at that turn's end would
   * take work the user never confirmed stopping.
   */
  readonly pendingBackgroundSessionStop: {
    readonly clientActionId: string;
    readonly awaitingTurnEnd: boolean;
    readonly turnId: string | null;
  } | null;
  /**
   * The grace-hold lease taken by the destination menu, or `null`.
   *
   * A STREAM lease, which is why it lives here and not in the menu's own React
   * state. `fallback.holdForChoice` freezes the remaining grace window and the
   * host mints a token that binds to this subscription's `connectionId`; the
   * token arrives on the action ack rather than on a frame of its own, so the
   * only place that can see it is the code that reconciles acks.
   *
   * `status` is what the menu renders against. `pending` means the frame is out
   * and the window may still be running - the menu must not claim a pause the
   * engine has not granted, and the card says "countdown paused" only once the
   * DTO itself reports `choosing`. `held` carries the token every later
   * `chat.fallback.chooseTarget` presents. `refused` is a hold the host
   * declined, and the menu closes on it rather than picking against a window it
   * does not hold. `refused` does NOT mean the traversal advanced: an accepted
   * ack that mints no token lands here too (`reconcileFallbackChoiceAck`), and
   * reopening from `choosing` is a normal path since B1.
   *
   * Its lifetime is the SUBSCRIPTION's, not the popover's. A close that
   * beats the ack leaves the obligation standing
   * (`FallbackChoiceLease.releaseRequested`), and an authoritative frame ends
   * the lease only on a real detach or a traversal the host says is over -
   * `reconcileFallbackChoiceLeaseWithFrame` owns both rules.
   */
  readonly fallbackChoiceLease: FallbackChoiceLease | null;
  /**
   * The last manual fallback action the host confirmed, or `null`.
   *
   * An EVENT record rather than a piece of chat state: nothing on the wire
   * clears it, because nothing on the wire un-happens it. Consumers dedupe on
   * `sequence`. See {@link ConfirmedManualFallbackAction}.
   */
  readonly confirmedManualFallbackAction: ConfirmedManualFallbackAction | null;
  /**
   * A fallback action outcome that reached no surface, or `null`.
   *
   * The same kind of EVENT record as {@link confirmedManualFallbackAction}
   * above and cleared by nothing, for the same reason. See
   * {@link UnattendedFallbackOutcome}.
   */
  readonly unattendedFallbackOutcome: UnattendedFallbackOutcome | null;
  readonly restore: ChatRestoreSlot | null;
  /**
   * Restore attempts whose record the durable outcome retired ahead of their
   * `restoreCompleted` frame - the frames still owed on this connection.
   * `onRestoreCompleted` answers a frame from here before it retires a
   * record, so a completion the event already settled does not retire a
   * later attempt's record. See {@link SettledRestoreCompletion}.
   */
  readonly settledRestoreCompletions: ReadonlyArray<SettledRestoreCompletion>;
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly errorNotices: ReadonlyArray<ChatErrorNotice>;
  /**
   * Notices the toast layer has actually SHOWN, by `clientActionId`.
   *
   * Only the eviction rule reads it, and only for `SEND_RESTORED`: that notice
   * is replayable on focus, and the ring is its only replay source, so
   * evicting it before the pane came back deleted the qualifications outright.
   * Once shown it ages like ordinary history. Bounded by the same FIFO cap as
   * the toast layer's own tracker, since an unbounded set keyed by action id
   * grows for the life of a chat.
   */
  readonly deliveredNoticeActionIds: ReadonlySet<string>;
  /**
   * Actions whose LAST-COPY notice (`noticeCarriesOnlyCopy`) the toast layer
   * has shown - the parking hold's release, and only that.
   *
   * A separate axis from {@link deliveredNoticeActionIds} on both counts
   * that matter to a hold. Key: that set answers "did ANY speaker for this
   * action reach the user", and a rejection's own `ACTION_REJECTED` toast
   * shown while the pane was focused answers yes for an action whose
   * `SEND_NOT_RECORDED` notice was stated a moment later, after focus left -
   * so the draft it carries was never seen and the hold read it as released
   * (Codex on 4df091443). Lifetime: that set is a FIFO, and a flood of
   * ordinary notices forgets a draft that WAS shown while its record stays
   * in the ring (last-copy records are never evicted), which turns a shown
   * draft into a permanent veto no refocus can repair - the toaster's own
   * retained tracker suppresses the repeat that would re-mark it. This set
   * is deliberately UNBOUNDED, the same lifetime as the records it answers
   * for and the toaster's `retainedClientActionIds`: one entry per settled
   * send, deduped on insert, and a session loses drafts in ones.
   */
  readonly deliveredLastCopyActionIds: ReadonlySet<string>;
  /**
   * The DOCUMENTS behind the last-copy notices still in the ring, keyed by
   * action id.
   *
   * A last-copy notice is a presentation, and for these sends it is the only
   * custody there is: the action is settled, the prompt is out of
   * `pendingActions`, and the notice's `message` holds the draft only as
   * rendered text. So the handoff at teardown needs the real document, and
   * `ChatErrorNotice` cannot carry it - it is a protocol type, so a field on
   * it would be a wire change.
   *
   * Written wherever a last-copy notice is appended (this store's two sites
   * and the reconciler's `appendedLastCopyPrompts`), dropped when the notice
   * is DELIVERED - the same release point as
   * {@link ChatSessionState.deliveredLastCopyActionIds}, because a prompt the
   * user has actually been shown is no longer the only copy.
   *
   * SIZE: one document per draft this session has actually lost. That is the
   * same ceiling `appendErrorNotice` already argues for its un-evictable
   * last-copy records, deduped on the same key - and this map is strictly
   * shorter-lived than that exemption, which never releases. The documents
   * are ordinarily hash-only (the bytes live in the image partition, which is
   * this epic's whole point); a draft that still carries inline base64 is
   * held whole, which is the cost of being able to hand it back at all.
   */
  readonly lastCopyPrompts: Readonly<Record<string, UnrecoverableSendPrompt>>;
  /**
   * Block ids this session has already OPENED a subagent/workflow card for.
   *
   * The one thing that tells a first `subagent.started` from a late re-emit of
   * it, because nothing on the wire does: a `blockDelta` frame carries no turn
   * identity, and the two events are otherwise the same shape. A repeat is
   * definitionally a SECOND start for a block id, so remembering the first is
   * the whole discriminator.
   *
   * It matters because the two want opposite answers when no row owns the
   * block. A first start must create its card - that is the birth of every
   * subagent card. A re-emit must not: the accumulator deliberately permits one
   * after its turn has completed (Codex resolves the agent nickname
   * asynchronously and re-emits `subagent.started` when it lands), so on the
   * windowed line its row may have been evicted by then, and creating from it
   * would mint a copy of an OLD turn's card under whatever turn is running now.
   *
   * Bounded by the same FIFO shape as {@link deliveredNoticeActionIds}: an
   * unbounded set keyed by block id grows for the life of a chat. Eviction is
   * safe in the direction that matters - a forgotten id only means a re-emit
   * that old is treated as a first start again, which is the behaviour this
   * replaces, and block ids are unique per run so a stale entry cannot deny a
   * genuinely new card.
   */
  readonly openedSubagentCardBlockIds: ReadonlySet<string>;
  /**
   * Content a `queueCancel` will hand back to the composer IF the host accepts
   * it, keyed by the cancel's `clientActionId`.
   *
   * Only rows whose worktree provisioning FAILED get an entry: cancelling one
   * of those is the user abandoning a prompt that never ran, and the prompt is
   * theirs to keep. A row that ran, or is queued behind a healthy setup, is
   * cancelled the way it always was.
   *
   * WHY A SEPARATE SLOT AND NOT `PendingChatAction.restore`. That field is not
   * free storage - {@link acceptedActionHoldsUnrecoveredSend} reads it as the
   * FACT "this record holds the only copy of an unconfirmed send", explicitly
   * "not the action kind, because `restore` already IS this fact: it is `null`
   * on every non-`send` action". A cancel carrying one would read as an
   * unrecovered send that can never be confirmed, and pin its accepted record
   * open against the settlement pass. Same reason it is not on the queue row.
   *
   * WHY CAPTURED AT DISPATCH. The cancelled row leaves `queue.items`, so by ack
   * time its content is gone; and it cannot be handed over at dispatch either,
   * because the host may refuse the cancel and keep the row - see the
   * `WORKTREE_CREATE_FAILED` arm in `onActionAck`. So it is held here across
   * exactly that round trip and consumed by whichever arm answers.
   *
   * TWO ARMS ANSWER, NOT ONE. The ack is the ordinary one; the other is the
   * reconnect snapshot. A cancel the host accepted and acted on can lose its
   * ack to a dying connection, and the snapshot fold then sweeps its pending as
   * an older-epoch non-send - so an ack-only consumer would leave the promised
   * prompt unreturned and this entry orphaned for the life of the store, with
   * its image bytes rooted behind it. {@link PendingCancelRestoration.queueItemId}
   * is carried for exactly that arm: the snapshot's own queue is the evidence
   * of whether the cancel landed.
   */
  readonly pendingCancelRestorations: Readonly<
    Record<string, PendingCancelRestoration | undefined>
  >;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  /**
   * Refused hash-only sends this client is quietly re-inlining and resending,
   * keyed by the SETTLED action id each replaces.
   *
   * A map rather than one slot, and that is not a capacity nicety. A single
   * slot made concurrent refusals - ordinary for a host that has lost its blob
   * store - compete for one piece of custody: the second either clobbered the
   * first's record and roots, or was refused recovery and took the loud path,
   * where it then occupied `failedSendRestoration` and left the first with
   * nowhere to hand its prompt back to. Both prompts are real, both need an
   * owner, so each gets one.
   *
   * Every lifecycle consumer that reasons about pending work has to see these:
   * reconciliation (a recovering message is still pending, not stranded),
   * queue merges (its optimistic row is retained by the RECOVERY, since its
   * action is gone), parking (a recovering chat is not idle), the GC root
   * sources, and disposal (which must abandon rather than leave a continuation
   * writing into a dead store).
   */
  readonly hashOnlyRecoveries: Readonly<Record<string, HashOnlyRecoveryState>>;
  readonly currentComposerSettings: ChatRunSettings | null;
  readonly liveAssistantMessage: LiveAssistantMessage | null;
  /**
   * Live token usage for the most recent turn, populated from `usage.updated`
   * runtime events the host emits during streaming and CARRIED through
   * `turn.completed` (with the final event's usage value, if any). The "%
   * context left" chip prefers this over the persisted assistant message's
   * usage, so the value updates live during the turn AND smoothly
   * transitions to the final number at completion (no flash to the prior
   * turn's value while waiting for the post-completion snapshot).
   *
   * Cleared on:
   *   - `turn.started` blockDelta (new turn opens; old value would
   *     mis-attribute)
   *   - `turnStateChanged` with a different activeTurn.turnId (covers
   *     transitions that bypass turn.started, e.g. queue-resume)
   *   - any chat.subscribe snapshot ingest (snapshot is authoritative;
   *     the assistant message's persisted usage takes over)
   *
   * All four harnesses now emit `usage.updated`: Claude via per-message
   * BetaUsage, Codex via thread/tokenUsage/updated, OpenCode via
   * message.updated, Cursor via SendOptions.onDelta.
   */
  readonly liveTurnUsage: TokenUsage | null;
  /**
   * Local-only worktree binding projected from the host's SQLite layer.
   * `null` until the host decides a binding for this owner. Populated by
   * the `chat.subscribe` snapshot and refreshed by `worktreeStateChanged`
   * frames. Not part of the cloud-synced chat record.
   */
  readonly worktreeBinding: WorktreeBinding | null;

  /**
   * `workspacePath`s of binding entries whose effective run directory is missing
   * on disk, computed host-side and carried on the snapshot + every
   * `worktreeStateChanged` frame. Non-empty → the composer blocks send (the
   * host rejects the turn with WORKTREE_MISSING) and offers recovery. Empty
   * under the normal case; never silently demoted to Local.
   *
   * Primary writer is the host stream (snapshot + `worktreeStateChanged`).
   * The chat tile additionally refreshes it from an on-focus
   * `worktree.getBinding` re-query via {@link refreshMissingWorktreePaths} so a
   * restored folder lifts the send-disable without a send or reload.
   */
  readonly missingWorktreePaths: ReadonlyArray<string>;

  /**
   * Overwrite {@link missingWorktreePaths} from an out-of-band fresh recompute -
   * the chat tile's on-focus / pane-activation `worktree.getBinding` re-query,
   * which recomputes the missing set server-side. Lets restoring a missing
   * folder + returning to the window auto-clear the composer's send-disable,
   * the independent recompute trigger that keeps the disable from stranding
   * recovery. A no-op once disposed.
   */
  refreshMissingWorktreePaths: (update: MissingWorktreePathsUpdate) => void;

  /**
   * Re-subscribe after a fatal close. Tears down the existing stream and opens
   * a fresh `chat.subscribe`, clearing `fatalClose` and `snapshotLoaded`. Drives
   * the tile error state's retry affordance.
   */
  /** See the implementation - names the ordinal a pending jump is waiting on. */
  requestTranscriptOrdinal: (ordinal: number | null) => void;
  retry: () => void;
  /**
   * {@link retry}, escalated to a transport re-dial first when - and only
   * when - this chat's own transport reports itself SILENT.
   *
   * The entry point for a PERSON: the pane's Retry button. `retry()` alone
   * re-subscribes on the existing session, which is the right answer for every
   * automatic caller and the wrong one for the state this exists for - a
   * session whose host stopped answering, where a fresh `chat.subscribe` would
   * be sent down the same dead channel and the person would press the button
   * again.
   *
   * Deliberately a SECOND action rather than a gate inside `retry()`.
   * `retry()` has three automatic callers - the wake pulse, the plan-restricted
   * reprobe, and the host-version move - and none of them may drop a socket:
   * they fire on their own schedule, against sessions that are usually
   * healthy, and a gate inside `retry()` would hand all three a redial as a
   * side effect.
   */
  retryFromUser: () => void;
  /**
   * Stops this session's transport waiting out its backoff and re-dials now.
   *
   * Keeps the transcript, the snapshot and every pending action exactly as
   * they are - see {@link ChatSessionStoreOptions.wakeTransport} for why that
   * distinction matters, and why this is not {@link retry}.
   */
  wake: () => void;
  /**
   * Which ordinals the transcript viewport is currently showing, from the
   * timeline's viewability pass - the second obligation
   * `planTranscriptHydration` folds in (the first is the tail). `null` means
   * "no placed row is visible" (the pending tail, a concealed surface, the
   * legacy line), which clears the viewport obligation rather than requesting
   * anything. A no-op off the windowed line and once disposed; repeats of the
   * same range are absorbed here, and an identical planned request is not
   * re-sent while the one in flight is unanswered.
   */
  reportVisibleTranscriptRange: (range: OrdinalRange | null) => void;
  sendMessage: (
    input: SendChatSessionMessageInput,
  ) => SentChatMessageAction | null;
  /**
   * Sends the initial handoff message reusing its pre-minted ids (shared with
   * the host turn-overlap idempotency gate). The driver's fallback `send`
   * path uses this when the host did not already start the turn from
   * `epic.createChat`'s `initialMessage`, so the same message never double-runs.
   */
  sendSeededUserMessage: (input: {
    readonly messageId: string;
    readonly clientActionId: string;
    readonly content: JsonContent;
    readonly sender: UserMessageSender;
    readonly settings: ChatRunSettings;
    /**
     * The handoff's own worktree intent - the one the create carried. Rides
     * this frame because the resend can be the first thing that reaches a host
     * which provisioned SYNCHRONOUSLY (a `@1.1` host, a create with no opt-in,
     * a create the host's post-condition sent down its synchronous fallback):
     * there `handleSend` materializes it against the worktree `resolveIntent`
     * already made and adopts it. On the deferred path the resend is a
     * duplicate and this frame is never read.
     */
    readonly worktreeIntent: WorktreeIntent | null;
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
  /**
   * Open the destination menu on a live grace window: freeze the remainder and
   * ask for a lease. Returns the `clientActionId`, or `null` when there is
   * nothing to hold - no traversal, a traversal in a state the hold does not
   * apply to, or a hold already in flight for it.
   *
   * Reopening while a close's release is still owed returns the IN-FLIGHT
   * request's id and sends no second frame; see
   * `FallbackChoiceLease.releaseRequested`.
   */
  fallbackHoldForChoice: (traversalId: string) => string | null;
  /**
   * Close the menu and resume the frozen remainder.
   *
   * Returns the release frame's `clientActionId` only when a token was
   * actually handed back. `null` covers two different situations: a `refused`
   * hold, which minted nothing, and a `pending` one, whose token has not
   * arrived - the second RECORDS the obligation and discharges it on the ack
   * rather than dropping it. The host resumes the remainder on detach, close
   * and restart regardless, which is why it can never treat this frame as the
   * only way a hold ends.
   */
  fallbackReleaseChoice: () => string | null;
  /**
   * Record a manual fallback action the host answered `applied` to.
   *
   * The store is a MAILBOX here, not a decider: it stamps the sequence and
   * holds the last one. Whether an action is worth announcing, and in what
   * words, belongs to the announcer.
   */
  publishConfirmedManualFallbackAction: (
    input: Omit<ConfirmedManualFallbackAction, "sequence">,
  ) => void;
  /**
   * Record a fallback outcome whose initiating surface had already gone.
   *
   * The same mailbox contract as the action above: the CALLER decides that no
   * mounted surface will report this one, and supplies the sentence. The store
   * stamps a sequence and holds the last.
   */
  publishUnattendedFallbackOutcome: (
    input: Omit<UnattendedFallbackOutcome, "sequence">,
  ) => void;
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
   * Narrow in-flight profile switch, parallel to
   * `updateActivePermissionMode`: tells the host the chat's CURRENT work
   * should run on `profileId` (of `harnessId` - profile ids are
   * harness-scoped). The host stamps a pre-spawn override from the frame at
   * intake, so a turn still parked on worktree setup adopts the switch
   * before it spawns. Deliberately not a whole-settings frame: model/harness
   * never late-bind into an accepted turn.
   */
  updateActiveProfile: (
    harnessId: GuiHarnessId,
    profileId: string | null,
  ) => string | null;
  // Live-mirror: atomically re-stamp every non-transient pending queued item
  // with the current toolbar settings so the host's stored copy stays current
  // for auto-send. Transient items (steer_requested/steering/injected) keep the
  // settings they locked at steer start and are skipped. `excludeQueueItemId`
  // skips the item open in the composer for editing (it commits its own settings
  // on submit). No-op updates (settings already equal) are not sent.
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
   * Record that THIS notice reached the screen. Called by the toast layer,
   * which is the only thing that knows - see
   * {@link ChatSessionState.deliveredNoticeActionIds}. Takes the notice, not
   * its action id, because the store keeps two delivery axes and the
   * notice's code decides which it writes: every notice marks its action
   * delivered (any speaker), and a last-copy notice also marks
   * {@link ChatSessionState.deliveredLastCopyActionIds}, the parking hold's
   * release. A notice without an action id has nothing to mark.
   */
  markNoticeDelivered: (notice: ChatErrorNotice) => void;
  /**
   * Settle the restoration slot by STATING its prompt instead of handing it to
   * the composer - see {@link displacedRestorationNotice}. Used when the
   * composer already holds a newer draft that must not be overwritten.
   */
  stateFailedSendRestoration: (clientActionId: string) => void;
  /**
   * Returns the locally-cached structured prompt content keyed by
   * `messageId` (the persistent id the host attaches to `setup.failed`)
   * so the chat composer can restore the prompt to the editor.
   *
   * The lookup walks three retention slots in order so worktree setup
   * gating can restore the prompt no matter how the accepted-send acks
   * interleave with the gating event:
   *
   *  1. `pendingUserMessages` - pre-ack send still in flight.
   *  2. `pendingActions` - `messageAccepted` already cleared the user
   *     message buffer but `actionAck` has not yet landed.
   *  3. `acceptedActions` - both `actionAck` and `messageAccepted`
   *     arrived first; the host then rejected the send during
   *     setup gating.
   *
   * Subsequent calls for the same `messageId` return `null` (the
   * `pendingUserMessages` entry is removed; `pendingActions` /
   * `acceptedActions` entries have their `restore` field nulled
   * out) so a duplicate or replayed `setup.failed` event does not
   * double-restore. The matching action records stay in their slots so
   * downstream ack/accept reconciliation continues to work.
   */
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
  /**
   * Decides when buffered `blockDelta` batches are folded into the store. A
   * streaming turn can emit dozens of text deltas per second; applying each
   * one as its own `set()` drives a full render-tree rebuild + markdown
   * re-lex per token, which is the dominant source of the renderer's
   * streaming GC churn. Production injects the process-wide coordinator
   * (one rAF + timeout-fallback tick shared by every chat store, with
   * visibility-tiered flush rates); tests inject
   * `IMMEDIATE_STREAM_FLUSH_COORDINATOR` so assertions land on the same tick.
   */
  readonly streamFlushCoordinator: StreamFlushCoordinator;
  readonly onAuthError: (() => void) | null;
  /**
   * Fired when the chat stream delivers a recoverable `code: "auth"` error frame
   * - the host's live signal that the tab's provider CLI signed out mid-turn.
   * The registry wires this to a plain `providers.list` invalidate so the
   * composer's re-auth gate refetches and reads the host's poisoned
   * `unauthenticated` (the host→renderer error frame is the only live push;
   * `providers.list` has no subscription). Distinct from `onAuthError`, which is
   * the Traycer *session* auth (an unauthorized stream close).
   */
  readonly onProviderAuthError: (() => void) | null;
  /**
   * Collapse this session's own transport backoff and re-dial NOW, keeping
   * everything the session holds.
   *
   * Deliberately NOT {@link ChatSessionState.retry}, and the difference is what
   * makes it safe behind a button someone presses while reading. `retry()`
   * tears the stream down and clears `snapshotLoaded`, so the transcript on
   * screen is replaced by its loading state - and any surface gating on
   * "content is showing" loses its own precondition at the same moment. A wake
   * touches no state at all: the socket is already redialing on a backoff, and
   * this only declines to wait for it.
   *
   * Injected because the session owns its transport but the store does not see
   * it. The registry builds the socket, so only the registry can name the
   * connection this wakes - and it must be THIS chat's, never the app-wide one.
   * `null` where no transport was built (a test factory), which reads as
   * nothing to wake.
   */
  readonly wakeTransport: (() => void) | null;
  /**
   * Whether this chat's own transport has been READY and silent for `ms` - the
   * gate on {@link ChatSessionState.retryFromUser}'s escalation.
   *
   * Injected for the same reason as {@link wakeTransport}, and answered by the
   * same socket: the store owns the session, the registry owns the connection,
   * and a predicate resolved anywhere else would report on a transport the
   * person is not waiting for.
   *
   * OPTIONAL, unlike `wakeTransport`, and the asymmetry is deliberate: this is
   * a read whose ABSENCE has a correct answer ("not measured", i.e. never
   * silent, i.e. no escalation), while a missing wake would silently disable a
   * button that exists. Absent and `null` mean the same thing here, so the
   * forty-odd suites that build these options by hand keep the plain
   * re-subscribe without stating it - the same call the transport layer's own
   * `IHostStreamClient.isSilentFor?` makes for the same reason.
   */
  readonly transportSilentFor?: ((ms: number) => boolean) | null;
}

/**
 * Per-session tracker for error notices already surfaced as toasts. Lives
 * on the store handle (not in React state) so dedupe survives component
 * unmount/remount - switching chat tabs and back must not replay toasts.
 *
 * - `clientActionIds`: notices carrying a client action id dedupe by that
 *   id. Stable across object-identity changes.
 * - `notices`: WeakSet keyed by notice object identity for anonymous
 *   notices (`clientActionId === null`). The notice ring is immutable, so
 *   refs stay stable for the lifetime of the store.
 */
export interface DeliveredNoticeTracker {
  readonly notices: WeakSet<ChatErrorNotice>;
  readonly clientActionIds: Set<string>;
  /**
   * Delivery state for notices the ring never evicts (see
   * `noticeCarriesOnlyCopy`). Deliberately UNBOUNDED, mirroring the exemption
   * on the records themselves: bounded delivery state under an unbounded
   * record set forgets that a draft was already shown, and the next notice to
   * arrive re-traverses the ring and fires the never-expiring toast again.
   * Bounded in practice by the same argument as the ring - one entry per
   * settled send, deduped, and a session loses drafts in ones.
   */
  readonly retainedClientActionIds: Set<string>;
}

export interface ChatSessionStoreHandle {
  readonly epicId: string;
  readonly chatId: string;
  readonly userId: string | null;
  readonly store: UseBoundStore<StoreApi<ChatSessionState>>;
  readonly deliveredNotices: DeliveredNoticeTracker;
  /**
   * Completed restores already surfaced as toasts. Completion state remains in
   * the store for the dialog, so delivery lives on the handle to survive task-
   * tab focus changes and component remounts without replaying the result.
   */
  readonly deliveredRestoreCompletionKeys: Set<string>;
  /**
   * Per-surface visibility report feeding the stream-flush coordinator's
   * tiered flush rate. The same chat can render in several surfaces (split
   * panes, keep-alive tabs); the chat counts as visible when ANY reporting
   * surface is visible, and defaults to visible while nothing reports so an
   * unreported store never starves.
   */
  readonly setSurfaceVisibility: (surfaceId: string, visible: boolean) => void;
  readonly clearSurfaceVisibility: (surfaceId: string) => void;
  readonly dispose: () => void;
}

export function isChatRunInProgress(runStatus: ChatRunStatus): boolean {
  return runStatus === "running" || runStatus === "stopping";
}

/**
 * How long an unanswered range or resnapshot request is waited on before its
 * dedup latch is released and the plan re-issued.
 *
 * Generous, because an oversized range rides the BULK lane behind whatever else
 * is queued there. Releasing the latch does NOT cancel the request: the earlier
 * answer stays eligible to seat (its recovery-ledger entry survives), so this
 * deadline governs only how long a possibly-dropped request may suppress a
 * re-ask. Timing it too tight therefore costs a redundant round trip, never a
 * discarded answer - which is what makes a generous value safe on both sides.
 *
 * Module scope rather than the store closure so the helpers that arm it cannot
 * out-order its declaration.
 */
export const HYDRATION_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How many sent-and-unanswered range requests keep their staleness record.
 *
 * Reached only when the host answers nothing for several timeouts running, so
 * the value just has to be comfortably above the number of re-asks a live
 * connection can stack up. Small enough that the map cannot become a leak on a
 * tab left open against a wedged host.
 *
 * That premise is a constraint on the CALLERS, not a property of the cap: it
 * holds only while nothing mints a request for a range already being answered.
 * Releasing the dedup slot on a frame that did not end the request breaks it -
 * eight aux rebroadcasts then evict the very entry the outstanding answer needs
 * - so a new clear site has to justify itself against this number.
 *
 * The value itself lives on the recovery ledger now, which owns the eviction;
 * re-exported here for the consumers that size scenarios by it.
 */
export { MAX_OUTSTANDING_HYDRATION_REQUESTS } from "@/stores/chats/recovery-ledger";

/**
 * How long a chunked delivery may go quiet before it is treated as stalled
 * rather than slow.
 *
 * Longer than {@link HYDRATION_REQUEST_TIMEOUT_MS} on purpose. That deadline
 * governs a single round trip the client asked for; this one governs the gap
 * BETWEEN chunks of a stream the host is pushing, and firing it early costs a
 * whole-transcript resnapshot rather than one re-request.
 */
export const STREAM_COMPLETION_TIMEOUT_MS = 45_000;

/**
 * How many times a stalled stream may be restarted within one epoch.
 *
 * The recovery restarts the very stream that stalled, so an unbounded retry is
 * a self-sustaining loop against a link that keeps dropping the last frame.
 * Past the cap the client keeps its partial state rather than asking again -
 * which is exactly the behaviour that existed before the watchdog, so the cap
 * degrades to the status quo instead of to something worse.
 */
export const MAX_WATCHDOG_RESTREAMS_PER_EPOCH = 3;

/**
 * How many catch-ups one provisionally seated body may ask for.
 *
 * A catch-up is answered with a slice, and a slice taken while the turn is still
 * writing can be overtaken before it lands: the client then holds a body with
 * the later writes and the answer carries the earlier one, and no merge of the
 * two is sound. Asking again is the repair - the next slice is taken later - but
 * a stream that keeps overtaking would make that a request per round trip for
 * the length of the turn. Past the cap the client keeps what it has and stops
 * asking; the turn's completion rebase re-seats the row from the host, so the
 * cap costs a delayed repair rather than a permanent one.
 */
export const MAX_PROVISIONAL_CATCH_UP_ROUNDS = 3;

/**
 * Is this stream event evidence that the host wrote to the STREAMING turn?
 *
 * Read by the write mark, so it errs towards yes: over-counting costs a request,
 * under-counting can certify an answer that is short of the host. The one thing
 * it rules out is an event the reducer itself will reject as another turn's - a
 * late `usage.updated` from the previous turn, say (see `applyBlockDelta`) -
 * which changes nothing about the active body and so is no evidence at all.
 */
function countsAsActiveTurnWrite(
  event: RuntimeEvent,
  activeTurnId: string | null,
): boolean {
  if (activeTurnId === null) return false;
  if (!("turnId" in event) || typeof event.turnId !== "string") return true;
  return event.turnId === activeTurnId;
}

const EMPTY_QUEUE: ChatQueueState = { status: "idle", items: [] };

function chatRunSettingsEqual(a: ChatRunSettings, b: ChatRunSettings): boolean {
  // Keyed by every `ChatRunSettings` field via `satisfies`: adding a field to
  // the type forces an entry here (compile error otherwise), so the
  // comparison can't silently ignore a new field.
  const fieldsEqual = {
    harnessId: a.harnessId === b.harnessId,
    model: a.model === b.model,
    permissionMode: a.permissionMode === b.permissionMode,
    reasoningEffort: a.reasoningEffort === b.reasoningEffort,
    serviceTier: a.serviceTier === b.serviceTier,
    agentMode: a.agentMode === b.agentMode,
    // `??` guards a pre-profile queued item (the field is missing, not
    // `null`, on an old serialized `ChatRunSettings`) so it still compares
    // equal to a fresh ambient commit instead of spuriously restamping.
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
/**
 * Cap the per-chat error-notice ring. Without this the array grows
 * unbounded - a noisy chat session (lots of rejected actions or repeated
 * errorNotice frames) would leak memory and force every `useShallow`
 * subscriber to compare a longer array on every state update.
 *
 * `ChatTileErrorNoticeToasts` only needs recent entries for toast emission, so
 * older entries are rotated out under FIFO.
 */
export const MAX_ERROR_NOTICE_RECORDS = 32;
/**
 * Cap the delivered-notice client-action-id tracker. Notices with a
 * `clientActionId` are deduped by string id, but strings don't GC out of
 * a `Set` like `WeakSet` entries do - so without a cap the set would grow
 * unbounded over a long-lived chat session. Sized at 4× the notice ring
 * to leave generous headroom for rapid eviction churn while still keeping
 * memory bounded.
 */
export const MAX_DELIVERED_CLIENT_ACTION_IDS = MAX_ERROR_NOTICE_RECORDS * 4;

/**
 * How many opened subagent/workflow card block ids a session remembers.
 *
 * Sized for "cards a live chat can open before an old one's re-emit stops
 * mattering" rather than for the transcript: the window the memory has to
 * cover is one async nickname lookup, and a chat that has opened 256 further
 * cards since is long past it.
 */
export const MAX_OPENED_SUBAGENT_CARD_BLOCK_IDS = 256;
/** Bounds string-key retention while comfortably covering recent restores. */
export const MAX_DELIVERED_RESTORE_COMPLETIONS = 32;

/**
 * Append a reconciler's notice DELTA onto the store's ring. Returns the ring
 * unchanged (same reference) for an empty delta, so a pass with nothing to say
 * never touches the slice.
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
  // A last-copy notice is the user's draft, not notice history: the reconcile
  // that emitted it dropped the send's row, so evicting the record destroys
  // the text outright. Before that change an eviction cost a pointer and the
  // row still held the words; now it is the whole loss, so these records are
  // exempt below.
  //
  // Deduping on insert is what keeps that exemption bounded, and it answers
  // the re-emission hazard in the same stroke: at most one un-evictable
  // record per settled send, and a send settles once (its action is dropped
  // when it is stated). So the ring's ceiling is the number of drafts a
  // session has actually lost - ones, in the half-open double-send window
  // that produces them - plus the cap for ordinary history.
  if (noticeCarriesOnlyCopy(next)) {
    const alreadyStated = notices.some(
      (notice) =>
        noticeCarriesOnlyCopy(notice) &&
        notice.clientActionId === next.clientActionId,
    );
    // Never capped, and never counted against ordinary history below.
    return alreadyStated ? notices : [...notices, next];
  }
  // A `SEND_RESTORED` notice is replayable ON PURPOSE - it may arrive while
  // the pane is unfocused, and the qualifications it carries are the only
  // warning that the restored prompt will resend under something else. But
  // the ring is the ONLY replay source, so 32 ordinary notices arriving first
  // silently deleted it before the pane ever came back. It is not a last-copy
  // notice (the draft is safe in the composer, so no permanent pin) - the
  // axis is different: survive EVICTION until DELIVERED, then age normally
  // like any other warning.
  if (
    next.code === SEND_RESTORED_NOTICE_CODE &&
    next.clientActionId !== null &&
    !delivered.has(next.clientActionId)
  ) {
    return [...notices, next];
  }
  // The cap applies to ORDINARY history only. Counting total length made the
  // exemption's cost fall on ordinary notices: with the ring full of retained
  // drafts there was one usable slot left, so the next ordinary error evicted
  // the previous one before an inactive pane could ever show it. The exemption
  // protects drafts; it must not quietly shrink everything else.
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
 * Re-stage the worktree intent a `send`/`editUserMessage` pending captured,
 * unless the user has staged a newer selection since (revision guard). Shared
 * by the rejection ack and the reconnect sweep: an edit dropped before its ack
 * (connection lost mid-flight) never runs the rejection path, so without this
 * its staged selection would stay cleared and the next resend would silently
 * run against the prior binding - the exact silent-local-run the restore exists
 * to prevent.
 */
/**
 * The two fields a revision-guarded re-stage needs. Structural rather than
 * tied to `PendingChatAction`, because the binding has to survive past the
 * accepted ack that drops the action - `PendingUserMessage` carries the same
 * pair for exactly that reason, and both restore through one guard.
 */
export interface StagedWorktreeIntentSource {
  readonly restoreWorktreeIntent: WorktreeIntent | null;
  /**
   * Whose hand-back this is. NOT an ownership CLAIM on the pick - a restored
   * prompt takes the slot whoever consumed it last, which is the whole point
   * of {@link stagedWorktreeIntentAwaitsDispatchOutcome} being ownership-blind.
   * It is here so the staging store can tell its OWN bookkeeping apart from a
   * different, still-pending dispatch's: see `restoreIntentForDispatch`.
   */
  readonly clientActionId: string;
}

/**
 * A swept action's claim on the staged pick.
 *
 * It carries the action id because a sweep hand-back is a PICK hand-back for
 * one specific action, and a pick may only go back to the action that took it
 * - the same rule the rejection ack applies through `rejectionOwnsSlot`. A
 * prompt hand-back is deliberately NOT this type: a restored prompt claims the
 * slot on behalf of whatever the user is about to resend, so it matches on no
 * owner at all.
 */
interface SweptWorktreeClaimant extends StagedWorktreeIntentSource {
  readonly clientActionId: string;
}

/**
 * Keep the background-stop slices in lockstep with the running-only list: a
 * task that has left it has settled, so its Stop is no longer in flight.
 * Extracted so the turn-state updater stays under the complexity budget.
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
 * Decide the slot between claimants that a reconnect killed together.
 *
 * The restored PROMPT is terminal, and terminal either way. If it carried a
 * worktree, that worktree is staged with it; if it was deliberately sent
 * WITHOUT one, the slot stays empty - that is its dispatch state, and it is
 * just as much a decision. What must not happen is a lower-priority claimant
 * filling the gap: an unrelated action's binding attaching itself to this
 * prompt is the wrong-binding hazard, and a prompt sent with no worktree is
 * exactly where it used to slip in, because a null claim looked like no claim.
 *
 * Only when NO prompt came back do the swept actions get their bindings, which
 * is the case the sweep's own reasoning was written for.
 */
/**
 * The statement a rejected action earns.
 *
 * A rejected SEND that could not claim the restoration slot is a dead send
 * neither restored nor stated - the same hole the settle passes closed in
 * rounds 1-4, on the one surface that kept a reason-only notice. It routes
 * through the SAME builder they use rather than a parallel one, so it inherits
 * the inlined text and every qualification clause automatically; a second
 * notice shape here would drift from those the moment either changed.
 *
 * Everything else - a non-send, a send that DID claim the slot, an action with
 * no content - keeps the host's reason, which is the whole story for it.
 */
/**
 * The send a rejection is about to state as UNRECOVERABLE, or `null` when this
 * rejection is not one.
 *
 * Shared by the notice and by the `lastCopyPrompts` record beside it, so
 * "which rejections are last copies" is decided once. Two copies of this
 * condition would drift, and the failure mode is silent: a notice with no
 * document behind it looks exactly like a notice.
 */
/** Drop one last-copy document. `Record` spread is additive, so this is a doing. */
function withoutLastCopyPrompt(
  prompts: Readonly<Record<string, UnrecoverableSendPrompt>>,
  clientActionId: string,
): Readonly<Record<string, UnrecoverableSendPrompt>> {
  const { [clientActionId]: _delivered, ...remaining } = prompts;
  return remaining;
}

/** Merge a reconcile pass's last-copy documents into the map. */
function withLastCopyPrompts(
  prompts: Readonly<Record<string, UnrecoverableSendPrompt>>,
  appended: ReadonlyArray<UnrecoverableSendPrompt>,
): Readonly<Record<string, UnrecoverableSendPrompt>> {
  if (appended.length === 0) return prompts;
  const next = { ...prompts };
  for (const prompt of appended) {
    next[prompt.clientActionId] = prompt;
  }
  return next;
}

/** Add a last-copy document to the map, or leave it alone for a `null` send. */
function recordLastCopyPrompt(
  prompts: Readonly<Record<string, UnrecoverableSendPrompt>>,
  send: UnrecoverableSend | null,
): Readonly<Record<string, UnrecoverableSendPrompt>> {
  if (send === null) return prompts;
  return {
    ...prompts,
    [send.clientActionId]: unrecoverableSendPrompt(send),
  };
}

function rejectionLastCopySend(input: {
  readonly frame: {
    readonly reason: string | null;
    readonly code: string | null;
    readonly clientActionId: string;
  };
  readonly pending: PendingChatAction | null;
  readonly displaced: boolean;
  readonly account: DeadSendAccount | null;
}): UnrecoverableSend | null {
  const pending = input.pending;
  if (
    !input.displaced ||
    pending === null ||
    pending.action !== "send" ||
    pending.restore === null
  ) {
    return null;
  }
  const reason = input.frame.reason ?? "Action rejected.";
  return {
    clientActionId: input.frame.clientActionId,
    content: pending.restore.content,
    browserAnnotations: pending.restore.browserAnnotations,
    circumstance: `A message was not accepted (${reason.replace(/\.$/, "")})`,
    account: input.account ?? EMPTY_DEAD_SEND_ACCOUNT,
  };
}

function rejectionNotice(input: {
  readonly frame: {
    readonly reason: string | null;
    readonly code: string | null;
    readonly clientActionId: string;
  };
  readonly pending: PendingChatAction | null;
  readonly displaced: boolean;
  /**
   * This send's account, gathered BEFORE the restore ran - `null` when the
   * rejection is not a restorable send. Prepared rather than derived here so
   * the sweep evidence is read while it still exists.
   */
  readonly account: DeadSendAccount | null;
}): ChatErrorNotice {
  const lastCopy = rejectionLastCopySend(input);
  if (lastCopy !== null) return unrecoverableSendNotice(lastCopy);
  const reason = input.frame.reason ?? "Action rejected.";
  // A rejected send that WINS the slot is restored, so it never reaches
  // `unrecoverableSendNotice` - this is the surface that speaks for it, and
  // `handedBack` is true because its surviving binding went back with it.
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
 * This rejection's account, or `null` when the frame is not a restorable send
 * and so has nothing to say.
 *
 * Takes the sweep as an ARGUMENT rather than reading it: the caller gathers it
 * before the restore runs, because the restore's own staging write clears the
 * record this describes.
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

/**
 * The slot a rejected SEND claims, or `null` when this rejection claims none.
 *
 * Third winner path, same obligation: the send whose prompt is going back to
 * the composer is the one about to be resent, so it is the one that has to
 * hear what changed underneath it. Worktree first, then the run
 * qualifications - the same clause order the statement path uses.
 */
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
 * Drop the accepted records a settling pass - snapshot or live turn-state -
 * just declared dead. `Record` spread is additive, so a removal needs doing
 * rather than expressing.
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

/**
 * ...and the optimistic queue rows that were standing in for them. A settled
 * send will never be confirmed, so its row would otherwise sit in the queue
 * claiming a message the host does not have.
 */
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

/**
 * Whether the restoration slot is already promised to a DIFFERENT action's
 * prompt.
 *
 * The prompt slot and the staging slot are one pair, and a binding may only be
 * handed back to sit under its OWN prompt. Every individual hand-back rule
 * here is about a single action's right to its own pick; this is the rule
 * about the pair, and it is the one two locally-correct decisions can violate
 * between them.
 *
 * Deliberately NOT expressed as a terminal claim on the staging slot by
 * whichever prompt wins. Closing the slot would also close it for the
 * legitimate later pairing - once the composer consumes the restored prompt
 * the slot frees, and a subsequent restore of the OTHER send's prompt should
 * still bring its own binding with it - and a terminal claim that outlived the
 * prompt would block the winner's own sweep hand-back, which is the
 * cross-owner staging hazard arriving from the other side. Asking the question
 * at hand-back time costs nothing and keeps both doors open.
 */
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
  /**
   * Who the restoration slot is promised to right now. A prompt handed back by
   * THIS pass is already it, so only the swept-claimant fallback below has to
   * ask - see {@link restorationSlotHeldByOther}.
   */
  restoration: FailedSendRestorationState | null,
): boolean {
  if (restoredPrompt !== null) {
    // Reported ONLY for the restored prompt. The swept-claimant fallback below
    // belongs to a different `clientActionId`, is never queried at
    // displacement, and the revision guard already declines to touch it.
    return restoreStagedWorktreeIntent(restoredPrompt, stagingKey);
    // A prompt that HAD a binding and did not get it back because a sweep ran
    // mid-flight comes back unbound through no decision of the user's - the
    // one refusal worth saying out loud. A refusal caused by their own newer
    // pick is not: they chose it, and claiming their worktree was deleted
    // would be a lie.
  }
  // OWNERSHIP, not merely "a consumption is outstanding". The mark names
  // whichever dispatch consumed last, and that dispatch may have gone on to be
  // ACCEPTED - a later send taking the slot and succeeding leaves the mark
  // its own, the slot empty, and this swept action with no claim on either.
  // Handing its pick back there stages a binding over one an accepted send
  // already ran against, which is the silent-local-run this restore exists to
  // prevent, arriving by the other door.
  //
  // And the slot must not already be promised to somebody else's prompt. This
  // fallback defers to a prompt handed back by its OWN pass, but a prompt
  // handed back by an earlier one is still sitting there unconsumed, and
  // staging a swept action's binding underneath it is the same mismatch the
  // rejection path had.
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

/**
 * Put a consumed worktree pick back, unless the user has since said otherwise.
 *
 * The discriminator is "is this slot still awaiting THIS dispatch's outcome" -
 * empty, and untouched since a send took it. A revision comparison answered a
 * different question, how far the counter moved, and the two diverge when a
 * SECOND send stages and consumes its own pick: the counter advances twice and
 * the slot ends empty, so the first send's binding was suppressed to protect a
 * selection that no longer existed, and its restored prompt silently resent
 * against the chat's previous worktree.
 *
 * Occupancy alone is not enough either: an explicit user clear also leaves the
 * slot empty, and that IS a choice to send without one. The store's marker
 * separates the two - only a dispatch sets it, every user mutation drops it.
 *
 * The slot holds ONE pick, so when several dead actions each want theirs back
 * the caller decides precedence: the action whose PROMPT is handed to the
 * composer wins, because a prompt and the worktree it was written for have to
 * travel together. See the snapshot handler.
 */
function restoreStagedWorktreeIntent(
  source: StagedWorktreeIntentSource | null,
  stagingKey: WorktreeStagingKey,
): boolean {
  if (source === null || source.restoreWorktreeIntent === null) return false;
  if (!stagedWorktreeIntentAwaitsDispatchOutcome(stagingKey)) return false;
  // Tested against THIS intent, not the mark's entries - the mark describes
  // whichever dispatch consumed last, which need not be this one.
  //
  // PER ENTRY, because a `WorktreeIntent` is one binding per workspace folder
  // and those are independent. Refusing the whole intent because one folder's
  // worktree was swept threw away every surviving folder's binding too, and
  // the survivors then resent against whatever the chat is bound to now -
  // silently, since the statement spoke of a single missing worktree.
  const { survivors } = partitionSweptIntent(
    stagingKey,
    source.restoreWorktreeIntent,
  );
  if (survivors === null) return false;
  // A hand-back, NOT a user pick - so it may only clear its own dispatch's
  // records. The gate above is ownership-blind, so the mark standing here
  // often belongs to a newer, still-pending send whose sweep evidence its
  // rejection has not read yet.
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
    // Held across a cancel the host may still refuse. Same argument as
    // `failedSendRestoration` one slot up: the composer cleared on dispatch,
    // so between the cancel and its ack this row is the only thing naming
    // these crops.
    for (const entry of Object.values(state.pendingCancelRestorations)) {
      if (entry === undefined) continue;
      records.push(...entry.restore.browserAnnotations);
    }
    // A queued prompt is re-derived from this payload at DRAIN time, so its
    // sidecar has to outlive every slot above. This is also what covers the
    // queued-blob repair: the repair only runs for an item still IN the
    // queue, so the item's own root already spans the window between
    // `send.failed` and the re-upload.
    //
    // A managed-command item carries no message at all, and an AGENT-authored
    // prompt carries content but no annotation sidecar - hence both guards.
    for (const item of state.queue.items) {
      if (item.kind !== "prompt") continue;
      if (item.message.kind !== "user") continue;
      records.push(...item.message.browserAnnotations);
    }
    // A recovery's annotation crops need rooting for exactly the reason its
    // document does: its action is gone from `pendingActions`, and a queued
    // send has no echo either, so for the length of the recovery nothing else
    // names these records. The crop atoms travel in `wireContent`, but the
    // RECORDS are what a hand-back restores and what the retry re-attaches -
    // and their bytes live under the annotation hash, not the document's.
    for (const recovery of Object.values(state.hashOnlyRecoveries)) {
      records.push(...recovery.restore.browserAnnotations);
    }
    // A LAST-COPY prompt's sidecar, for the reason its document already had
    // its own collector here: the action is settled and gone and the echo is
    // retired, so until the handoff writes it nothing else names these crops.
    for (const prompt of Object.values(state.lastCopyPrompts)) {
      records.push(...prompt.browserAnnotations);
    }
  }
  // Anything a disposal is still CAPTURING. The session's own roots go with
  // it synchronously, but the handoff reads crops asynchronously afterwards,
  // so for that window these records are named by nothing at all.
  for (const capture of handoffCaptureRoots.values()) {
    records.push(...capture.browserAnnotations);
  }
  return collectAnnotationImageHashes(records);
}

registerExtraImageRootSource({
  hashes: collectPendingAnnotationImageHashes,
});

/**
 * The same slots, walked for the images in the recovery DOCUMENT rather
 * than the annotation cards beside it.
 *
 * The annotation source above collects `browserAnnotations` only, which is the
 * sidecar array - it says nothing about the `imageAttachment` nodes in the
 * prompt itself. So a send whose upload failed, followed by a reconcile, lost
 * the only bytes the restored draft could be re-inlined from: the composer had
 * already cleared, the draft row was gone, and nothing else named the hash.
 * Restoration hands the user back a prompt, and a prompt with a dead image in
 * it is not the prompt they wrote.
 *
 * Separate from the annotation source rather than folded into it because the
 * two answer different questions about the same records, and a reader of
 * either should not have to untangle which half it is looking at.
 */
function collectPendingRestoreContentImageHashes(): ReadonlyArray<string> {
  const hashes: string[] = [];
  for (const sessionStore of liveChatSessionStores) {
    const state = sessionStore.getState();
    for (const pending of Object.values(state.pendingActions)) {
      if (pending.restore !== null) {
        hashes.push(...blobHashesFromContent(pending.restore.content));
      }
    }
    for (const message of state.pendingUserMessages) {
      // BOTH documents. The restore is what a hand-back returns; the row's own
      // `content` is what the transcript is rendering, and the two are not
      // guaranteed to name the same hashes once a send goes out hash-only.
      // Rooting a hash twice costs nothing; rooting one of them not at all
      // deletes bytes the other is still showing.
      hashes.push(...blobHashesFromContent(message.restore.content));
      hashes.push(...blobHashesFromContent(message.content));
    }
    if (state.failedSendRestoration !== null) {
      hashes.push(
        ...blobHashesFromContent(state.failedSendRestoration.content),
      );
    }
    // Held across a cancel the host may still refuse, so the document has the
    // same custody gap as `failedSendRestoration`: the composer cleared on
    // dispatch and nothing else names these hashes until the ack lands.
    for (const entry of Object.values(state.pendingCancelRestorations)) {
      if (entry === undefined) continue;
      hashes.push(...blobHashesFromContent(entry.restore.content));
    }
    // A queued prompt is re-derived from THIS payload at drain time, so its
    // bytes have to outlive every slot above - and no other root names them,
    // because a queued item has no pending action and no optimistic echo.
    //
    // Content is taken from both prompt variants. An agent-authored prompt's
    // images are ordinarily the host's to resolve, so rooting them looks
    // redundant; but a hash whose bytes were never local roots nothing, while
    // guessing wrong the other way deletes bytes a drain still needs.
    for (const item of state.queue.items) {
      if (item.kind !== "prompt") continue;
      hashes.push(...blobHashesFromContent(item.message.content));
    }
    // A recovery in flight owns bytes nothing else names: its action is
    // settled and gone from `pendingActions`, and a QUEUED send has no
    // optimistic echo either. Without this the sweep could delete the very
    // bytes the retry is waiting on, and a second refusal would then hand back
    // a document whose hashes resolve nowhere. BOTH documents: the wire one is
    // what the retry re-inlines, the restore one is what a hand-back returns.
    for (const recovery of Object.values(state.hashOnlyRecoveries)) {
      hashes.push(...blobHashesFromContent(recovery.wireContent));
      hashes.push(...blobHashesFromContent(recovery.restore.content));
    }
    // A LAST-COPY prompt is rooted by nothing else, for the same reason it
    // needed its own collector: the action is settled and gone, the echo is
    // retired, and the notice holds only rendered text. Unrooted, the sweep
    // deletes the bytes and the eventual handoff stashes a document whose
    // hashes resolve nowhere - which reads to the user as the image being
    // dropped, not as the send having failed.
    for (const prompt of Object.values(state.lastCopyPrompts)) {
      hashes.push(...blobHashesFromContent(prompt.content));
    }
  }
  // Anything a disposal is still CAPTURING. The session's own roots go with it
  // synchronously, but the handoff reads images asynchronously afterwards, so
  // for that window these hashes are named by nothing at all.
  for (const capture of handoffCaptureRoots.values()) {
    hashes.push(...blobHashesFromContent(capture.content));
  }
  return hashes;
}

/**
 * What a disposal's handoff has not finished reading: the document AND the
 * annotation sidecar beside it. Both need rooting for the same reason and
 * neither covers the other - the crops live under the annotation hash, not
 * inside the document.
 *
 * Held from just before the capture starts until the handoff settles, because
 * `dispose()` removes the store from `liveChatSessionStores` in the same tick
 * and every root above is derived from that set. Keyed by a capture id minted
 * per handoff, which is what the `finally` has in hand.
 */
interface HandoffCaptureRoot {
  readonly content: JsonContent;
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
}

const handoffCaptureRoots = new Map<string, HandoffCaptureRoot>();

registerExtraImageRootSource({
  hashes: collectPendingRestoreContentImageHashes,
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
 * The six slices charged to the chat-windows plane alongside the transcript.
 *
 * THE OBLIGATION: every write to one of these must be followed by a budget
 * re-settle. The transcript paths get theirs from `commitChatWindowBudget` /
 * `commitLegacyTranscriptBudget`; everything else calls
 * `commitWholeSetSliceBudget`. A write with no re-settle behind it leaves the
 * accountant holding a stale figure for as long as this chat stays quiet on
 * the transcript, which is the whole of the growth it is supposed to bound.
 * Adding a slice here adds that obligation to its writers too.
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
   * The counter half of this store's stream guard - shared, so the check that
   * keeps a superseded socket's frames out of the live store exists once rather
   * than once per plane.
   *
   * The DISPOSAL half is this store's own and is composed over it in
   * {@link streamGuard}, not folded into the shared counter: a retired
   * generation and a dead store are different facts, and only one of them is
   * about which socket a frame came from.
   */
  const streamGenerations = createGenerationGuard();
  /**
   * What every stream handler is actually guarded on: a live store AND a
   * current generation.
   *
   * `disposed` is deliberately kept as its own conjunct rather than argued
   * redundant. It IS redundant on the path anyone would check - `dispose()`
   * calls `closeStreamClient()`, which retires the generation - but only while
   * `streamClient !== null`, since that method early-returns otherwise, and
   * only for as long as nothing builds a stream after disposal. Both of those
   * are properties of code elsewhere in this file, not of the guard, so the
   * conjunct stays where it cannot be invalidated from a distance.
   */
  const streamGuard: GenerationGuard = {
    current: () => streamGenerations.current(),
    next: () => streamGenerations.next(),
    isCurrent: (candidate) =>
      !disposed && streamGenerations.isCurrent(candidate),
  };
  let fatalCloseNotificationGeneration: number | null = null;
  // `activeTurn` is cleared as soon as a stream fatally closes. Retain the
  // turn that produced that close so another renderer's later live completion
  // can still acknowledge this renderer's matching failure. A subsequent
  // active turn or fatal close supersedes this slot.
  let fatalCloseTurnId: string | null = null;
  let unsubscribeLiveCompletionAcknowledgements = (): void => undefined;
  // Bumped whenever the connection the pendings were dispatched on is gone: a
  // transport `reconnecting`/`closed` status, or a stream-client replacement
  // (`retry`). Pending actions are stamped with this at dispatch, and the
  // next authoritative snapshot drops non-message pendings from an older
  // epoch - their ack can never arrive. Never acted on at the connection
  // event itself: a wobble that reconnects cancels nothing by itself.
  let connectionEpoch = 0;
  /**
   * Whether {@link store} has been ASSIGNED - false for the whole of the
   * `create()` initializer below, and false forever if that initializer throws.
   *
   * Not a redundant reading of `store`: until `create()` returns, `store` is in
   * its temporal dead zone, so touching it at all throws a `ReferenceError`
   * rather than yielding `undefined`. A flag is the only thing that can be
   * asked the question.
   *
   * The window is real and reachable, not defensive tidiness. The factory runs
   * INSIDE the initializer and `LogicalStream.onStatusChange` replays a terminal
   * `closed` SYNCHRONOUSLY to a handler installed after the transition - which
   * is exactly what `ChatStreamClient`'s constructor does - so a remote chat
   * dialled against an already-closed stream runs this store's status handler
   * from inside its own initializer. The factory-throw rollback below already
   * records the general shape of this: "that ordering would depend on no factory
   * callback settling synchronously, which nothing enforces".
   */
  let storeReady = false;
  /**
   * The ONLY writer of {@link connectionEpoch}.
   *
   * A function rather than the two `+= 1` sites it replaces, because the
   * counter now has a mirror in state (`ChatSessionState.connectionEpoch`) that
   * consumers subscribe to. Two write sites and a mirror is three things to
   * keep in step; one writer is one. A future third bump site inherits the
   * mirror instead of silently omitting it - and an omission would be invisible
   * from outside, since a stale generation still reads as a plausible number.
   *
   * Reaching `store` from out here is the file's existing shape (see the
   * `store.getState()` calls in the handle). The `storeReady` gate states the
   * relationship the two halves actually have rather than assuming a caller:
   * the COUNTER is authoritative and the state field is only its mirror, so a
   * bump with no store yet still counts, and the initial state below publishes
   * it by seeding from this variable rather than from a literal `0`.
   *
   * SECOND line, not the first. The one construction-time caller - a status
   * replayed synchronously by the factory - is deferred at the callback so the
   * whole handler runs against a real store; this is what keeps a future bump
   * site added inside the initializer from throwing a `ReferenceError` on
   * `store` instead of simply counting.
   */
  const bumpConnectionEpoch = (): void => {
    connectionEpoch += 1;
    if (!storeReady) return;
    store.setState({ connectionEpoch });
  };
  const surfaceVisibility = new Map<string, boolean>();

  const pushSurfaceVisibility = (): void => {
    if (flushLease === null) return;
    const visible =
      surfaceVisibility.size === 0 ||
      Array.from(surfaceVisibility.values()).some((value) => value);
    flushLease.setVisible(visible);
  };

  // This chat's staging slot, and the question both reconcile passes have to
  // be able to ask about it. Bound once here because the passes are pure: they
  // STATE displaced sends, and a statement that names a swept worktree as
  // re-pickable is the same defect the restore paths already guard against.
  const ownerStagingKey: WorktreeStagingKey = {
    surface: "owner",
    hostId: options.hostId,
    epicId: options.epicId,
    ownerKind: "chat",
    ownerId: options.chatId,
  };
  /**
   * The staging revision each restored prompt's hand-back left behind, so a
   * later displacement can take that pick back WITHOUT touching one anybody
   * else owns. Captured at re-stage time - evidence in hand, never re-read
   * from live records at displacement.
   */
  const stagingRevisionByRestoredAction = new Map<string, number>();
  const recordStagedRevisionFor = (
    source: StagedWorktreeIntentSource | null,
    handedBack: boolean,
  ): void => {
    // ONLY on a write, and only AFTER it. The hand-back refuses at three
    // doors before writing, and a refusal bumps no revision - so an
    // unconditional capture still matches at displacement and the release
    // deletes whatever is standing at the key, which on the refusal path is
    // the user's own pick. Capturing the pre-write revision is the mirror
    // error: the write moves it, the release never matches, and the binding
    // stays attached to the newer draft. What the release needs is the
    // revision the hand-back LEFT BEHIND.
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

  // Phase two of the session-scoped background stop: the actual frame. Split
  // from the store method because it has two dispatch moments - immediately
  // when no turn is running, or from `onTurnStateChanged` once a stopped
  // turn's settled frame arrives.
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

  // Hands a minted token back and empties the slot. Two callers, deliberately
  // sharing one implementation: the ordinary menu close, and the ack that
  // arrives after a close (see `FallbackChoiceLease.releaseRequested`). A
  // second copy of the frame would be a second place for the token to go
  // missing.
  const sendFallbackChoiceRelease = (input: {
    readonly set: SendActionInput["set"];
    readonly get: SendActionInput["get"];
    readonly traversalId: string;
    readonly token: string;
  }): string | null => {
    const clientActionId = uuidv4();
    const frame: ChatOwnerActionFrame = {
      kind: "fallback.releaseChoice",
      hasBinaryPayload: false,
      epicId: options.epicId,
      chatId: options.chatId,
      clientActionId,
      traversalId: input.traversalId,
      token: input.token,
    };
    return sendAction({
      set: input.set,
      get: input.get,
      frame,
      pending: basicPending(clientActionId, "fallback.releaseChoice"),
      pendingUserMessage: null,
    });
  };

  // The release a closed menu still owes, discharged the moment the token it
  // was waiting for exists.
  //
  // State-based and called after every action ack, for the same reason
  // `maybeDispatchPendingBackgroundSessionStop` is: the arrival that completes
  // the obligation is a frame, not a click, and the surface that took the hold
  // is gone by then. Clearing the slot here (rather than on the eventual
  // release ack) is what lets the next open ask for a fresh hold - the token
  // has been handed back, so there is nothing left to correlate.
  const dispatchPendingChoiceRelease = (
    set: ChatSessionSetState,
    get: ChatSessionGetState,
  ): void => {
    const lease = get().fallbackChoiceLease;
    if (lease === null || !lease.releaseRequested) return;
    if (lease.status !== "held" || lease.token === null) return;
    set(() => ({ fallbackChoiceLease: null }));
    sendFallbackChoiceRelease({
      set,
      get,
      traversalId: lease.traversalId,
      token: lease.token,
    });
  };

  // The graceful downgrade for a confirmed session stop whose gated command
  // settled on its own: stop the remaining rows individually so wakeups stay
  // scheduled (the confirmation's count excluded them) and rows whose stop
  // is already in flight are left alone rather than tripping stop-all's
  // in-flight guard into stopping nothing.
  const stopRemainingItemsIndividually = (
    get: ChatSessionGetState,
    items: readonly BackgroundItem[],
  ): void => {
    for (const item of items) {
      if (item.kind === "wakeup") continue;
      get().stopBackgroundItem(item.taskId);
    }
  };

  // Deliberately state-based rather than edge-based: called after every
  // turn-state, action-ack AND snapshot reduction, so a phase-one turn stop
  // that races the turn's natural end (its `stop` rejected with
  // NO_ACTIVE_TURN, no further turn frame due) or a reconnect that ate the
  // settled frame still advances instead of waiting forever.
  const maybeDispatchPendingBackgroundSessionStop = (
    set: ChatSessionSetState,
    get: ChatSessionGetState,
  ): void => {
    const state = get();
    let pending = state.pendingBackgroundSessionStop;
    if (pending === null || !pending.awaitingTurnEnd) return;
    const activeTurnId = state.activeTurn?.turnId ?? null;
    if (pending.turnId === null && activeTurnId !== null) {
      // Confirmed during the request-to-turn activation window, before the
      // turn had an id. Latch the first id observed so a LATER turn still
      // reads as different and cancels the escalation.
      pending = { ...pending, turnId: activeTurnId };
      const latched = pending;
      set(() => ({ pendingBackgroundSessionStop: latched }));
    }
    if (
      pending.turnId !== null &&
      activeTurnId !== null &&
      activeTurnId !== pending.turnId
    ) {
      // A different turn than the one the user confirmed against is running
      // (a queued turn started meanwhile, possibly while disconnected).
      // Firing at ITS end would take work the user never asked to stop -
      // release the escalation instead.
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
      // The gated command settled on its own while the turn wound down, so
      // the reason for killing the provider session is gone. Honor the
      // confirmed "stop my background work" with graceful per-item stops
      // instead of the process kill.
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
    bumpConnectionEpoch();
    client.close();
  };

  const store = create<ChatSessionState>()((set, get) => {
    // `blockDelta` coalescing. Deltas accumulate here and are folded into a
    // single `set()` per coordinator tick (one animation frame in production)
    // instead of one `set()` per token. Every non-delta frame that consumes
    // message/turn state (`onSnapshot`, `onTurnStateChanged`, `onMessageAccepted`,
    // `onInterviewRequested`) flushes the buffer first, so observable ordering
    // matches arrival order.
    let bufferedDeltas: RuntimeEvent[] = [];

    // `providers.list` nudge driven by the DURABLE auth-failure signal: an
    // error block tagged `code: "auth"` persisted on the latest assistant row
    // (a trailing user row - e.g. a message accepted after the failure - does
    // not hide it). Live failures already nudge via the `onBlockDelta` error
    // frame below; this covers failures that happened headlessly (an
    // A2A-triggered turn with no live subscriber) and only surface on
    // subscribe/rehydrate - reload, host restart, reconnect, or opening the
    // tab after the fact. Deduped by the failed turn's `turnId` (shared by the
    // live and persisted paths - `ChatActiveTurn.turnId` mirrors 1:1 onto the
    // eventual `AssistantMessage.turnId`), NOT once per store lifetime: a
    // reconnect can surface a NEW headless failure after the user already
    // re-authed the first one, and that later snapshot must still invalidate
    // the (long-staleTime) provider query. Re-delivery of the SAME row across
    // reconnects, or a snapshot arriving right after the live nudge already
    // fired for the same turn, stays a single nudge; a stale nudge is a
    // harmless refetch either way (the gate is a pure predicate).
    let nudgedAuthErrorTurnId: string | null = null;

    /**
     * Act on the whole-transcript answer, whichever line produced it.
     *
     * The SELECTION moved to `provider-auth-failure.ts` and the two lines get
     * it from different places - the legacy caller runs it over the snapshot's
     * full record array, the windowed caller reads the host's scalar. What
     * stays here is the dedupe, because the marker it compares against is also
     * written by the live `blockDelta` path below and neither line can see
     * that.
     *
     * `null` means "the latest turn did not fail on a credential", on both
     * lines. It never means "could not tell": that ambiguity is precisely what
     * the derived scalar exists to remove.
     */
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
      //
      // The deferral publishes the snapshot's `aux` but deliberately not its
      // `activeTurn`, and no assistant row is seated yet - so a delta folded
      // now has nothing to attach to and `applyBlockDelta` discards it. That
      // is a permanent loss for the one delta that cannot be recovered from
      // anywhere else: the oversized tail travels on the BULK lane, so a delta
      // can overtake a range response that was sliced BEFORE the delta
      // existed, leaving it absent from the live stream and from the
      // hydration. The reader then sees a live turn missing a span of its own
      // output until the next turn boundary rewrites the row.
      //
      // Nothing here bounds the buffer, and that is the existing contract: it
      // is drained by the flush coordinator's tick on every non-deferred beat,
      // and a deferral resolves on the next range response that hydrates the
      // tail. On a live chat the streaming row IS the tail, so a catch-up
      // demotion of that row can re-open the deferral for one more answer;
      // that is bounded by `MAX_PROVISIONAL_CATCH_UP_ROUNDS`, and the repair
      // seat drains this buffer itself before it looks at the served body.
      if (deferredWindowedSnapshot !== null) return;
      const batch = bufferedDeltas;
      bufferedDeltas = [];
      if (disposed) return;
      set((state) => {
        // Fold the batch through the same reducer used for a single delta,
        // threading the accumulated state so later deltas see earlier ones.
        // `applyBlockDelta` returns the input state (identity) or an empty
        // object on a no-op; skip both to keep the result reference stable
        // when nothing changed (zustand then fires no listeners).
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
      // A streaming turn is under-read for its duration: block deltas defer
      // measurement, and `evictChatWindowForAccountant` settles before
      // deciding. The eviction above does not change that - it is gated on
      // `hydratedBytes`, which a `deferred` charge leaves unmoved, so it fires
      // only where a settled write already grew the tier and never serializes
      // the growing row. Recency stays the only budget fact this path can
      // honestly stamp without paying for that.
      //
      // Order carries no meaning: the eviction reads `hydratedBytes`, the
      // viewport range and the required ordinals, and publishes; the stamp
      // writes recency. Neither reads what the other writes. The eviction runs
      // first only so the stamp describes a settled window.
      recencyStamp = memory.stampChatRecency();
    };

    /**
     * Run the fresh tier's eviction after an in-place rewrite grew it.
     *
     * `rewriteWindowMessage` recomputes `hydratedBytes` exactly for a CHARGED
     * write and then applies only `boundStaleTierToBudget`, which by
     * construction cannot drop a fresh span - and the reducers' callers publish
     * the returned window directly. So repeated growth on an already-settled
     * turn (a detached subagent's progress, an image resolving) could hold the
     * fresh tier above the budget for as long as no range or snapshot was
     * seated, and keep growing.
     *
     * Here rather than inside the window module, because the eviction's
     * protections are the CALLER's to supply: `visibleTranscriptRange` and the
     * rows a pending question sits on. The latter especially cannot be retained
     * on the window the way the viewport can - `onWindowedSnapshot` passes the
     * FRAME's pair precisely because protecting the rows the previous snapshot
     * was blocked on would protect the wrong ones - so it is derived from
     * current state at the moment of use, exactly as `onRange` does.
     *
     * Gated on `hydratedBytes` alone, which is what makes this affordable on
     * the delta path. The figure is exact after a `now` charge and deliberately
     * UNMOVED by a `deferred` one, so the streaming row's growth cannot trip
     * this and `settleWindowBytes` is never paid per token - which is the whole
     * reason the deferred charge exists.
     */
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

    /**
     * The authoritative-snapshot fold, shared by BOTH lines.
     *
     * Named and hoisted rather than left inline because the windowed line
     * needs exactly this - the pending-send reconcile, the queue merge, the
     * worktree-intent hand-back, the interview-draft reap - over a transcript
     * that arrives differently. Re-implementing it for the windowed peer
     * would be a second copy of the most intricate fold in this store, and
     * the two would drift on the first bug fixed in one of them.
     *
     * It takes a LEGACY-shaped snapshot; the windowed caller adapts. See
     * `applyWindowedSnapshotFrame` for what that adaptation is and is not.
     *
     * `extra` is merged into the fold's own `set`, so state that must land
     * ATOMICALLY with the published transcript can. The windowed caller passes
     * the new `transcriptWindow` (and its snapshot aux) through here rather
     * than setting it in its own earlier `set`, because the row merge treats
     * "span names a row `rendered` lacks" as deliberate renderer suppression -
     * and a store state holding new spans beside old rendered models makes
     * that judgement about a legitimate new row. The legacy caller passes
     * either `null` or the windowed-state RESET (a downgrade is the same
     * atomicity argument in reverse).
     *
     * `authFailureTurnKey` is passed in rather than scanned from `frame`
     * because THIS is the one question the adaptation cannot carry: the
     * windowed caller's `frame.snapshot.chat.messages` is the hydrated subset,
     * so a scan here would answer "no failure" for a failure that is merely
     * cold. Each caller supplies the whole-transcript answer its own line has -
     * the legacy scan, or the host's scalar - and the two agree by running the
     * same selection.
     */
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
      // Pendings dispatched on an earlier connection never see their ack, so
      // the snapshot drops them (below). Computed here, before the set, so a
      // swept `editUserMessage` gets its staged worktree intent restored the
      // same way a rejected one does - the drop otherwise leaves the slot
      // cleared and the next resend runs against the prior binding. Reads
      // `get()` (no pendingActions mutation happens before the set), so it
      // sees the same state the updater will.
      const sweep = sweepStalePendingActions(
        get().pendingActions,
        connectionEpoch,
      );
      // Every swept id came from this same `pendingActions` snapshot, so the
      // lookup is always present. DEFERRED past the reconcile rather than
      // applied here: the slot holds one pick, and a swept edit is not the
      // only claimant. See `restoreOneWorktreeIntent` below for who wins.
      const sweptPendings = get().pendingActions;
      const sweptWorktreeIntents = [...sweep.sweptActionIds].map(
        (sweptId) => sweptPendings[sweptId],
      );
      let restoredWorktreeIntentForSnapshot: StagedWorktreeIntentSource | null =
        null;
      // A cancel whose ack died with the old connection: the sweep above has
      // just declared it unanswerable, so this snapshot's queue decides it
      // instead. Computed (and its memo retracted) here rather than in the
      // updater, for the same reason the rejection arm reads its evidence
      // early - `forgetRefusedContentBlobAcks` is a side effect and the
      // updater must stay pure.
      const cancelSettlement = settleCancelRestorations(
        get().pendingCancelRestorations,
        sweep.sweptActionIds,
        frame.snapshot.queue,
      );
      for (const honoured of cancelSettlement.honoured) {
        forgetRefusedContentBlobAcks(options.hostId, honoured.restore.content);
      }
      // Filled by the updater, sent after it: the frames go out only once the
      // records are re-stamped, so a re-entrant snapshot cannot send them twice.
      let retransmitRestoreActions: ReadonlyArray<AcceptedChatAction> = [];
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
        // A changed persisted tuple is an authoritative host-side update
        // (for example `agent.configure`) and must replace the live picker.
        // An unchanged tuple is ordinary stream traffic, so keep any local
        // composer edits that have not been committed by a send yet.
        const authoritativeSettingsChanged =
          state.chat === null ||
          !nullableChatRunSettingsEqual(
            state.chat.settings,
            frame.snapshot.chat.settings,
          );
        // What a RESEND would run under after this snapshot lands. The
        // drift statement compares against this, not the persisted tuple:
        // a local pick the user just made is what the composer will send.
        const nextComposerSettings = authoritativeSettingsChanged
          ? frame.snapshot.chat.settings
          : state.currentComposerSettings;
        const now = Date.now();
        // This snapshot is the authority for everything a lost connection
        // left in limbo: pendings dispatched on an earlier connection will
        // never see their ack, so drop them (via `sweep`, computed above so
        // swept edits restore their staged worktree intent). Controls
        // re-enable; the user can re-issue against the state the snapshot
        // shows. Message sends stay - `reconcileSnapshotChange` settles those
        // by messageId with composer restoration, and only for sends from
        // an earlier epoch: this same connection's in-flight sends keep
        // waiting for their ack (a steady-state refresh snapshot is not
        // evidence they were lost).
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
        // `reconcileSnapshotChange` only settles sends still awaiting their
        // ack. A send whose accepted ack landed before the connection died
        // has already left `pendingActions`, so its optimistic user message
        // needs its own settled pass: when this authoritative snapshot
        // reports no turn in progress, an entry with no remaining path to
        // materialization will never be cleared by a later frame - drop it
        // (restoring its content if the transcript never recorded it).
        const settled = reconcileTurnSettled(
          turnSettledFromStatus(
            frame.snapshot.turnInProgress,
            frame.snapshot.runStatus,
          ),
          {
            pendingActions: pending.pendingActions,
            recoveringActionIds: new Set(Object.keys(get().hashOnlyRecoveries)),
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
        // The honoured cancels join the SAME single-slot contest the two
        // reconcile passes above just ran, folded after them so a send whose
        // restoration has been waiting since before the reconnect keeps the
        // slot. Whoever loses keeps its document, exactly as the two passes
        // above do: the notice is the rendering, the prompt is the copy.
        //
        // The fold can produce SEVERAL losers - one reconnect can settle many
        // stranded cancels and only the first can have the slot - which is
        // precisely why they are accumulated rather than carried singly.
        //
        // The document is built HERE, beside the notice, rather than by mapping
        // the accumulated sends at the state patch below. Both orders record the
        // same prompts, but only this one puts the construction in the same
        // block as the notice it belongs to - which is exactly what
        // `last-copy-notice-producer-scan` reads, and what it could not see
        // when the two halves sat in different scopes. It also makes this arm
        // the same TYPE as the two it is spread beside, instead of the only one
        // needing a `.map` at the seam.
        const cancelRestorationsForSnapshot = cancelSettlement.honoured.reduce<{
          slot: FailedSendRestorationState | null;
          readonly notices: ChatErrorNotice[];
          readonly appendedLastCopyPrompts: UnrecoverableSendPrompt[];
        }>(
          (carried, honoured) => {
            const awarded = awardCancelRestorationSlot(
              carried.slot,
              honoured.clientActionId,
              honoured.restore,
            );
            if (awarded.notice !== null) carried.notices.push(awarded.notice);
            if (awarded.lastCopy !== null) {
              carried.appendedLastCopyPrompts.push(
                unrecoverableSendPrompt(awarded.lastCopy),
              );
            }
            return {
              slot: awarded.failedSendRestoration,
              notices: carried.notices,
              appendedLastCopyPrompts: carried.appendedLastCopyPrompts,
            };
          },
          {
            slot: settled.failedSendRestoration,
            notices: [],
            appendedLastCopyPrompts: [],
          },
        );
        const pendingActions = withoutSupersededInterviewDeliveryRetryActions(
          pending.pendingActions,
          messages,
          state.liveAssistantMessage,
          null,
        );
        // Restore attempts, in three steps. (1) Evidence: on the legacy line
        // the snapshot's events carry the durable `checkpoint.restored`
        // outcome for a completion frame that was lost, and it retires the
        // record and completes the spinner from the recorded result; the
        // windowed line's tail is hydrated rows and never carries it, which
        // is what step 3 is for. (2) The spinner, AFTER the evidence so a
        // completion the evidence proved is kept for the toast consumers: an
        // in-flight slot still stamped on an older connection is swept - its
        // frames died with that connection. (3) Retransmit: every surviving
        // record dispatched on an older connection is re-sent after this
        // pass (`retransmitRestoreActions`) so the host re-answers it from
        // its journal, and re-stamped here so a record is retried once per
        // reconnect, not once per snapshot.
        // The completion ledger is scoped to a connection: an entry from an
        // older one waited for a frame that died with it, so it goes before
        // this snapshot's evidence can add entries for the current one.
        const settledRestores = settleRestoreAttemptsByEvidence(
          {
            acceptedActions: state.acceptedActions,
            restore: state.restore,
            settledRestoreCompletions: withoutSettledRestoreCompletionsBefore(
              state.settledRestoreCompletions,
              connectionEpoch,
            ),
          },
          restoreOutcomesFrom(frame.snapshot.chat.events),
          connectionEpoch,
        );
        const restoreSettlement = {
          acceptedActions: settledRestores.acceptedActions,
          restore: sweepStaleRestoreSlot(
            settledRestores.restore,
            connectionEpoch,
          ),
          settledRestoreCompletions: settledRestores.settledRestoreCompletions,
        };
        const restoreRetransmits = retransmittableRestoreActions(
          restoreSettlement.acceptedActions,
          connectionEpoch,
        );
        retransmitRestoreActions = restoreRetransmits;
        // The resolved-cancellation retirement runs on BOTH doors now. It used
        // to be on `queueChanged` only, so a `queueCancel` accepted just before
        // a reconnect kept its record through every later snapshot: the cap and
        // the retention window skip it (it is lifecycle-locked), and the one
        // pass that retires it was never reached from here. Same authoritative
        // queue, same rule, so the record expires whichever door delivers the
        // truth.
        const acceptedActions = withoutSettledAcceptedQueueStatusActions(
          withoutResolvedAcceptedQueueCancellations(
            withoutSupersededInterviewDeliveryRetryActions(
              pruneAcceptedActions(
                {
                  ...withoutSettledAcceptedActions(
                    // Restore attempts settled by the snapshot's evidence,
                    // and the survivors re-stamped for retransmission - see
                    // `restoreSettlement` above.
                    withRetransmittedRestoreActions(
                      restoreSettlement.acceptedActions,
                      restoreRetransmits,
                      connectionEpoch,
                    ),
                    // BOTH passes retire records: the snapshot pass for sends
                    // it settled itself, the settled pass for rows it
                    // recovered.
                    new Set([
                      ...pending.settledAcceptedActionIds,
                      ...settled.settledAcceptedActionIds,
                    ]),
                  ),
                  // Confirmation stamps first, then this pass's own additions -
                  // an id cannot be in both, but ordering the merge makes that
                  // independent of whether it ever could be.
                  ...pending.confirmedAcceptedActions,
                  ...pending.acceptedActions,
                },
                now,
              ),
              messages,
              state.liveAssistantMessage,
              connectionEpoch,
            ),
            frame.snapshot.queue,
          ),
          frame.snapshot.queue,
        );
        return {
          // Destructured rather than spread-and-overwritten: the point is
          // that neither array is RETAINED, and `{...chat, messages: []}`
          // would still hold `events` (and any transcript-bearing field a
          // later minor adds). See `ChatSessionRecord`.
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
            new Set([
              ...Object.keys(pending.pendingActions),
              ...Object.keys(state.hashOnlyRecoveries),
            ]),
          ),
          runStatus: frame.snapshot.runStatus,
          activeTurn: frame.snapshot.activeTurn,
          turnInProgress: frame.snapshot.turnInProgress,
          pendingApprovals: frame.snapshot.pendingApprovals,
          pendingFileEditApprovals: frame.snapshot.pendingFileEditApprovals,
          pendingInterviews: frame.snapshot.pendingInterviews,
          accumulatedFileChanges: frame.snapshot.accumulatedFileChanges,
          backgroundItems: frame.snapshot.backgroundItems,
          // Straight across, deliberately WITHOUT the `??` fallback the
          // neighbours take: for these two `undefined` is a value ("no
          // traversal", "no offer") rather than an omission, and it is the one
          // that clears the card. See `ChatSessionState.pendingFallback`.
          pendingFallback: frame.snapshot.pendingFallback,
          pendingReturn: frame.snapshot.pendingReturn,
          lastFailedAttempt: frame.snapshot.lastFailedAttempt,
          lastFallbackOutcome: frame.snapshot.lastFallbackOutcome,
          // NOT unconditionally cleared, and that was the blocker: a snapshot
          // is not a detach. See `reconcileFallbackChoiceLeaseWithFrame` for
          // the two facts that do end a lease.
          fallbackChoiceLease: reconcileFallbackChoiceLeaseWithFrame(
            state.fallbackChoiceLease,
            frame.snapshot.pendingFallback,
            connectionEpoch,
          ),
          managedCommands: frame.snapshot.managedCommands,
          heldUpdates: frame.snapshot.heldUpdates,
          portForwards: frame.snapshot.portForwards,
          // Drop per-item stops whose task has left the running-only list
          // (its terminal landed) and clear the stop-all flag once nothing
          // is left running, so settled rows never stay disabled. A stop
          // whose FRAME died with a dropped connection never terminates its
          // task, so also drop entries whose generic pending was just swept
          // (same clientActionId) - an ack-ACCEPTED stop has no generic
          // pending left and correctly stays disabled until its terminal.
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
          // A session stop whose in-flight frame died with the connection
          // (either phase) was just swept - drop it so Stop all re-enables.
          // One whose frame was already accepted survives; the dispatch
          // call after this set advances or clears it against the
          // snapshot's turn and item state.
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
          // Every swept cancel is settled here whichever way it went, so none
          // can outlive the connection that stranded it.
          pendingCancelRestorations: withoutCancelRestorations(
            state.pendingCancelRestorations,
            cancelSettlement.settledActionIds,
          ),
          failedSendRestoration: cancelRestorationsForSnapshot.slot,
          // Statements both reconcile passes owe the user: a send whose
          // restoration lost the single-slot race on reconnect, and a
          // stranded send the settled pass dropped without the slot.
          // Appended through the same ring/cap as the rejection path's
          // notice - the honoured cancels' displaced statements included,
          // since they lose the same single slot to the same winner.
          errorNotices: appendErrorNoticeDelta(
            state.errorNotices,
            [
              ...pending.appendedErrorNotices,
              ...settled.appendedErrorNotices,
              ...cancelRestorationsForSnapshot.notices,
            ],
            state.deliveredNoticeActionIds,
          ),
          // The documents behind those notices, from the same three passes -
          // the honoured cancels included, since a prompt that loses the slot
          // needs its copy kept for the same reason theirs do.
          lastCopyPrompts: withLastCopyPrompts(state.lastCopyPrompts, [
            ...pending.appendedLastCopyPrompts,
            ...settled.appendedLastCopyPrompts,
            ...cancelRestorationsForSnapshot.appendedLastCopyPrompts,
          ]),
          restore: restoreSettlement.restore,
          settledRestoreCompletions:
            restoreSettlement.settledRestoreCompletions,
          snapshotLoaded: true,
          // The load this session was waiting on has arrived, so whatever it
          // took to get here is no longer evidence of anything - the next
          // stalled load has to accumulate its own. Cleared HERE rather than
          // on the `open` status because a connection that opens and then
          // never delivers is precisely the failure the gate exists for.
          preSnapshotRetries: null,
          // Stamped with the CONNECTION, not a per-snapshot counter: a
          // reconnect's backfill re-baselines transcript consumers, while a
          // steady-state refresh on this same connection does not.
          transcriptBaselineEpoch: connectionEpoch,
          worktreeBinding: frame.snapshot.worktreeBinding,
          missingWorktreePaths: frame.snapshot.missingWorktreePaths,
          liveAssistantMessage: liveAssistantForTurnStateFrame({
            current: state.liveAssistantMessage,
            previousTurnId,
            activeTurn: frame.snapshot.activeTurn,
            messages,
          }),
          // Snapshot is authoritative - the assistant message's
          // persisted `usage` field now carries any final state. Clear
          // the transient liveTurnUsage so a stale value from a
          // disconnected/abandoned turn can't survive a reconnect or
          // route swap. The chip falls back to messages[last].usage
          // (which the new snapshot just refreshed) until the next
          // live `usage.updated` arrives.
          liveTurnUsage: null,
          // Last, on purpose: the caller's atomically-co-published state (see
          // the function doc) wins over anything the fold computed.
          ...extra,
        };
      });
      // The retransmit itself, after the records are re-stamped. The same
      // frame the action first went out as - same client action id, so the
      // host's journal recognises the command - through the client's raw send
      // rather than `sendAction`: this is not a new pending action, and the
      // accepted ack it earns is a no-op on a record that already exists.
      // The client is non-null here: a snapshot only arrives through it.
      if (retransmitRestoreActions.length > 0 && streamClient !== null) {
        for (const action of retransmitRestoreActions) {
          if (action.checkpointId === null || action.revertArtifacts === null) {
            continue;
          }
          streamClient.sendAction({
            kind: "restoreCheckpoint",
            hasBinaryPayload: false,
            epicId: options.epicId,
            chatId: options.chatId,
            clientActionId: action.clientActionId,
            checkpointId: action.checkpointId,
            revertArtifacts: action.revertArtifacts,
          });
        }
      }
      // A prompt handed back to the composer takes its staged worktree with
      // it, or the resubmit silently runs against the chat's previous
      // binding.
      //
      // PRECEDENCE, because the slot holds one pick and a reconnect can kill
      // several actions that each want theirs back. The prompt in the
      // composer wins: a prompt and the worktree it was written for have to
      // travel together, and staging an unrelated action's binding beside it
      // is worse than staging none - the resend looks right and runs
      // somewhere else. A swept edit only gets its binding back when no
      // prompt is being handed back, which is the case the sweep's own
      // reasoning was written for (an edit dropped before its ack never runs
      // the rejection path, so nothing else would restore it).
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
        // Read AFTER the reconcile `set`, so this is who holds the slot now -
        // this pass's own restored prompt, or an earlier pass's still waiting
        // to be consumed.
        get().failedSendRestoration,
      );
      recordStagedRevisionFor(
        restoredWorktreeIntentForSnapshot,
        handedBackForSnapshot,
      );
      // A deferred session stop that survived the sweep (its turn stop was
      // accepted before the connection dropped) may never see another
      // turn-state frame - the turn could have settled while offline - so
      // advance it against the snapshot state directly.
      maybeDispatchPendingBackgroundSessionStop(set, get);
      // This snapshot is authoritative for which interviews are still
      // pending, so any stored draft whose block has left the set is an
      // orphan (its interview resolved, possibly while this window was
      // offline). Prune those keys; currently-pending drafts survive. Runs on
      // every snapshot, so cold start and reconnect both reap orphans.
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
     * A windowed snapshot whose TAIL had no bodies, held until it does.
     *
     * The wait-for-tail rule lives here. The fold above answers "did the
     * transcript record this message?" by looking in the records it was
     * handed, and on this line absence means "not hydrated" rather than "never
     * landed" - so running it against an empty window restores an already-sent
     * message into the composer and the user sends it twice.
     *
     * A pending send is recent by construction, so if it landed it is at the
     * tail. That makes the tail's presence exactly the condition under which
     * the fold's question is answerable, and holding the WHOLE snapshot until
     * then is the simple correct move: the alternative - applying aux state now
     * and reconciling later - splits one authoritative frame into two
     * half-applications for a case that only arises when a chat's last row is
     * over the host's 256 KB tail budget. Rare enough to pay a round trip for;
     * not rare enough to get wrong.
     */
    let deferredWindowedSnapshot: ChatWindowedSnapshotFrame | null = null;

    /**
     * The held snapshot's AUX state, advanced by every frame that arrives while
     * it waits.
     *
     * A deferred snapshot is authoritative about the transcript it was sent
     * with, and about nothing that happened afterwards - but the frames that
     * carry "afterwards" are applied immediately, because only the transcript
     * half of the fold is what the tail gates. A range answer can ride the BULK
     * lane and land well after a `queueChanged`, a `turnStateChanged` or an
     * `approvalRequested`, so replaying the frame's own aux at that point
     * reinstates values those frames had already replaced - and it does so
     * PERMANENTLY, because nothing re-sends them. An approval can vanish from
     * the panel while the agent stays blocked waiting for it.
     *
     * So the snapshot's aux is kept live rather than frozen: this starts as the
     * frame's own copy and each later frame applies the SAME update to it that
     * it applies to the store. Two baselines, one rule per site - never two
     * copies of the rule. The result is the union the frames would have
     * produced had they arrived in order, which neither "frame wins" nor "store
     * wins" can express: the snapshot may add an approval the store has never
     * seen while a later frame adds another the snapshot predates.
     *
     * `null` whenever nothing is deferred, which is the ordinary state - every
     * advance below is then a no-op.
     */
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

    /**
     * Whether this session negotiated the windowed line.
     *
     * Set by the first windowed snapshot rather than read from the transport,
     * because it is the SHAPE of what arrived that the appliers below have to
     * branch on, and that shape is what the frame proves. The negotiated minor
     * is fixed for a CONNECTION, not for this closure: `retry()` builds a new
     * stream client inside the same store, and the new connection negotiates
     * its own minor - a host rolled back below `1.8` between the two answers
     * with a LEGACY snapshot. `onSnapshot` therefore resets this flag and
     * drops the windowed state outright, because a skeleton and spans built
     * under the old line describe a coordinate space no current peer serves,
     * and merging a whole legacy transcript against them would omit and
     * duplicate rows.
     */
    let windowedLine = false;

    /**
     * The witnessed image-resolution write stream - the directional evidence
     * the settled arm's image tiebreak compares (see
     * {@link ImageWitnessStore}). Lives and dies with the WINDOW, never the
     * connection: replaced on a windowed-to-legacy downgrade, where its
     * ordinals' whole coordinate space becomes unaddressable, and otherwise
     * carried across reconnects exactly as the window's spans are.
     */
    let imageWitnesses = createImageWitnessStore();

    /**
     * The ordinal range the transcript viewport is showing, as last reported
     * by {@link ChatSessionState.reportVisibleTranscriptRange}. Fed into every
     * hydration plan so scrolling into unhydrated history fetches what the
     * reader is looking at. Survives a reconnect (it describes the viewport,
     * not the connection), and the timeline re-reports on its next
     * viewability pass anyway.
     */
    let visibleTranscriptRange: OrdinalRange | null = null;

    /**
     * What a request that has been SENT and not yet answered still promises.
     *
     * Kept per request id rather than on the dedup slot below, because the two
     * answer different questions and their lifetimes are not the same. The
     * slot asks "is there an outstanding ask for this range, so I should not
     * re-send it"; this ledger asks "is the answer that just arrived still
     * describing rows this client can trust". Releasing the first must not
     * forget the second: a request the timeout gave up waiting for is one
     * whose answer is LATE, and late is not the same as wrong.
     *
     * That distinction is the whole fix for a loop this store shipped once. A
     * range response is deliberately unbounded for a single folded row (see
     * `read-range.ts`) and rides the relay's BULK lane, so exceeding any
     * client-side deadline is an ordinary slow answer, not evidence of a drop.
     * With one slot holding both roles, the timeout's re-issue replaced the id
     * the original answer would be matched against, so that answer was
     * discarded on arrival and its replacement re-armed the same deadline -
     * every answer thrown away, every discard minting one more request.
     *
     * `superseded` is the other half of the hazard, and it is why an answer
     * cannot simply be trusted because it parses. An oversized `range`
     * response is the one frame on this line the relay may reclassify to BULK,
     * where it can be reordered behind INTERACTIVE deltas - so an
     * `indexChanged` naming a row that response is carrying can arrive FIRST.
     * An `updated` deliberately keeps both the epoch and the row id (see
     * `diffRowSkeleton`: a row id that moved is a `reindexed` instead), so
     * NEITHER check inside {@link applyRangeResponse} can see the staleness.
     * The pre-update body seats, passes every check, and nothing re-requests
     * it - a row frozen at a previous revision for the life of the epoch.
     */
    // The ledger those questions now live on - range obligations, resnapshot
    // dedup, skeleton-completion, and the summary-assembly trust state, one
    // record per fact. See the module doc for the entry state machine.
    const recovery = createRecoveryLedger();

    /**
     * The summary re-stream this client is currently assembling.
     *
     * `-1` rather than 0 so the FIRST generation the host sends (1) is already
     * a change - a client starting at 0 would match generation 0 and accept a
     * mid-stream chunk before ever seeing an index-0 one.
     *
     * Compared for INEQUALITY, never for ordering. The counter is the host's
     * PER-SUBSCRIBER one, so a reconnect mints a fresh subscriber that starts
     * over at 1 - lower than whatever this client accumulated on the previous
     * connection. What matters is only "is this the stream I am assembling",
     * and a `>` test here would reject every chunk after a reconnect and leave
     * the panel permanently empty.
     *
     * Which is also why inequality ALONE is not enough, and this is reset at
     * the rebuild boundary in `onWindowedSnapshot`. Restarting at 1 does not
     * merely produce a lower number - it produces a COLLIDING one whenever the
     * held value is also 1, and one rebuild per subscriber is the modal case.
     * A colliding generation reads as "the stream I am assembling", so a chunk
     * from the new stream whose index-0 predecessor was dropped splices into
     * the RETAINED previous-generation array instead of asking for a re-stream.
     * The reset makes the new stream's first chunk a change again.
     *
     * Reset at `indexRevision === null` specifically - the documented "the host
     * holds no index for this subscriber and is rebuilding one" signal, which
     * is the same condition under which the host emits these chunks at all. An
     * aux-only snapshot must NOT reset it: no chunks accompany one, so the next
     * chunk of the stream still in flight would read as foreign and buy a
     * re-stream, over and over for as long as aux traffic keeps arriving.
     */
    let accumulatedSummaryGeneration = -1;
    /**
     * The replacement summary generation being assembled, unpublished.
     *
     * `null` when no chunk of the current generation has arrived yet. Kept
     * out of the store so the panel renders the previous COMPLETE set while
     * a replacement streams in - publishing partial assemblies is the
     * "2 files changed" flash mid-restream.
     *
     * Its EXISTENCE is public even though its contents are not, as
     * `accumulatedSummaryAssemblyStarted` - the two move together at every one
     * of the three sites that assign this. Keeping the fact of an in-flight
     * generation private made the trust gate outside this store unable to see
     * it, and `accumulatedSummarySetComplete` then read an assembling
     * generation whose count had been rewound to zero as a finished one.
     */
    let assemblingSummaries:
      | readonly ChatAccumulatedFileChangeSummary[]
      | null = null;

    /**
     * The range request currently in flight, so a stream of identical
     * viewport reports does not re-send the same ask while the host is
     * answering it. Cleared when a range response arrives (whatever it held -
     * a partial answer changes the next plan anyway), cleared on a windowed
     * snapshot that RESET this client's connection or its coordinate space (a
     * reconnect's request died with its connection, and the transcript epoch
     * can survive one - without the clear, an identical re-plan would be
     * suppressed forever), and superseded by any differently-planned request.
     *
     * On a snapshot that did NEITHER - an aux-only rebroadcast - it is
     * deliberately kept. The request it names is still being answered, so
     * releasing the key would let the same range be asked again per aux frame;
     * see the clear site in `onWindowedSnapshot` for why that also destroys the
     * answer it was waiting for.
     *
     * Holds no staleness state of its own: that lives on the recovery
     * ledger's range entries, keyed by the id this names.
     */
    let inFlightHydrationRequest: {
      readonly requestId: string;
      readonly epoch: number;
      readonly range: OrdinalRange;
    } | null = null;

    /**
     * How many writes to the streaming turn this client has seen, from any
     * source: block deltas it applied, block deltas it had nowhere to put, and
     * accepted index echoes reporting a write the host made.
     *
     * Monotonic, never decremented, and deliberately NOT a count of outstanding
     * work. Its whole purpose is to date a `range` answer against the writes it
     * MAY be missing. A request records the value it was sent under
     * ({@link hydrationRequestMarks}); the host slices its answer at some point
     * after that, which may be before or after any given write. So the mark
     * answers one question, in one direction only, and that is the whole of what
     * is needed here:
     *
     *   sentUnderMark === activeTurnWriteMark  =>  no write was observed
     *   between this request going out and its answer arriving, so what it
     *   carries plus what the client has applied since is the whole of the turn.
     *
     * The converse does NOT hold: a write observed in that interval may still be
     * in the answer, because the host may have sliced after it. Nothing here
     * claims otherwise - an observed write means coverage is not ESTABLISHED,
     * which is why the response is to ask again rather than to discard anything.
     * The clock also sees only what reaches this client's callbacks, never every
     * write the host made.
     *
     * Counting EVERY write, rather than only the ones the client dropped, is
     * what makes that implication hold - and it is the correction a cold review
     * forced twice. An earlier version compared the held copy's
     * `blocksVersion` before and after the fold to spot a write that overtook a
     * catch-up. That reading is a per-SEAT baseline, so one answer installing a
     * body reset it and the next answer read "unchanged" and discharged the
     * obligation while the write was still missing; and `blocksVersion` is
     * optional on the wire, so where the host omits it every reading
     * normalised to the same number and no overtaking write was ever visible.
     * A mark carried by each REQUEST has neither problem: it is per-answer
     * provenance rather than shared state, and it does not depend on a field
     * the schema lets the host leave out.
     */
    let activeTurnWriteMark = 0;

    /**
     * The mark each outstanding range request was sent under.
     *
     * Retired when its answer arrives, whatever became of it, so this tracks
     * the ledger's open ranges rather than accumulating. The bulk clears sit
     * beside the ledger's own (`authorityBoundary`, `dropAll`), because a
     * request those abandon is one no answer will ever retire.
     */
    const hydrationRequestMarks = new Map<string, number>();

    /** The mark a request was sent under, retired from the map. */
    const takeHydrationRequestMark = (
      requestId: string,
    ): number | undefined => {
      const mark = hydrationRequestMarks.get(requestId);
      hydrationRequestMarks.delete(requestId);
      return mark;
    };

    /**
     * The streaming turn whose held body is UNSOUND, with the repair budget
     * spent on it so far.
     *
     * Unsound means the client's copy is not what the host would serve: either
     * nothing is held, or a write arrived with no body to apply it to and the
     * body seated afterwards is torn around the gap. It is set when such a write
     * is dropped and cleared only by an answer that provably closes the gap -
     * one whose request saw no write between going out and coming back.
     *
     * `rounds` counts catch-up requests actually SENT for this turn, charged at
     * the mint in {@link requestPlannedHydration} rather than at the demotion
     * that asks for one. The two differ: a demotion whose re-plan is suppressed
     * by an outstanding request for the same rows sends nothing, and charging it
     * let a queue of old answers spend the whole budget without a single
     * corrective request reaching the host.
     *
     * Kept for the turn once exhausted, which is why `rounds` lives here rather
     * than beside the obligation it bounds: forgetting the record at the cap let
     * a late answer that predated the write start the budget over, and the cap
     * has to be a per-turn total. Keyed by `turnId` for the opposite reason - a
     * NEXT turn must not inherit an exhausted budget and give up before asking
     * once.
     */
    let catchUpBudget: {
      readonly turnId: string;
      /** The held body is known to be short of the host. */
      readonly unsound: boolean;
      /** Catch-up requests sent for this turn. */
      readonly rounds: number;
    } | null = null;

    /**
     * The ordinals a demotion retired, waiting for the re-plan to turn them
     * back into a request.
     *
     * The ORDINALS and not a bare flag, because the next request the planner
     * mints need not be the repair: the reader can scroll away between the
     * demotion and the re-plan, and the requests that follow are then for
     * scrollback that owes nothing. Charging the budget for those spent it on
     * history and left the streaming row with no rounds when the reader came
     * back to it. A round is charged only by a request that covers the rows the
     * demotion opened.
     */
    let pendingCatchUp: {
      readonly turnId: string;
      readonly ordinals: readonly number[];
    } | null = null;

    const forgetCatchUpBudget = (): void => {
      catchUpBudget = null;
      pendingCatchUp = null;
    };

    /** The budget for `turnId`, fresh when the turn is new. */
    const budgetForTurn = (
      turnId: string,
    ): { readonly unsound: boolean; readonly rounds: number } =>
      catchUpBudget?.turnId === turnId
        ? catchUpBudget
        : { unsound: false, rounds: 0 };

    let resnapshotRequestTimer: number | null = null;

    const clearResnapshotRequestTimer = (): void => {
      if (resnapshotRequestTimer === null) return;
      window.clearTimeout(resnapshotRequestTimer);
      resnapshotRequestTimer = null;
    };

    /**
     * Ask for a `resnapshot`, at most one per epoch - and not forever.
     *
     * The dedup lives on the ledger's `resnapshot` entry, and it would wedge
     * for exactly the reason an unanswered range request does (see
     * {@link clearInFlightHydration}): a request or its answer dropped on a
     * stream that stays OPEN clears nothing, and only authority movement
     * closes the entry - which is the very thing that is not coming. The
     * consequence is worse here than for a range, because an invalidated
     * window is the WHOLE transcript rather than one visible gap: every
     * ordinal belongs to a coordinate space this client has left, so nothing
     * on screen can be repaired until a snapshot lands.
     *
     * Same bounded wait, and the retry has TWO shapes because this request
     * serves two recoveries. Releasing the entry is enough for the invalidated
     * index: the next windowed frame re-plans, sees the invalidation and asks
     * again. It is not enough for a stalled summary stream, whose transcript is
     * valid and often fully hydrated - the planner measures the transcript, so
     * it looks at that state and asks for nothing. That one is re-armed on the
     * completion watchdog instead, inside the timeout below.
     *
     * An aux-only snapshot deliberately closes NOTHING here: the pending
     * answer is a rebuild that repairs everything this entry was opened for,
     * and releasing per aux frame would re-send once per approval or queue
     * change. Only the rebuild announcement, a rebase, or a voided index -
     * the authority-boundary cases - replace the entry, plus the bounded wait
     * below.
     *
     * A late answer to the abandoned request costs nothing either way - a
     * resnapshot is idempotent, and the snapshot it produces closes the entry
     * whichever request it answers.
     */
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
        // `requestPlannedHydration` retries only what it can SEE, and it looks
        // at the transcript: an invalidated window re-asks here, and a planned
        // range covers a visible gap. Neither describes a summary-only stall -
        // that transcript is valid and often fully hydrated, so the planner
        // returns having asked for nothing, while the watchdog timer that
        // started this recovery has already fired and cleared itself.
        //
        // Nothing else re-arms it. The watchdog is restarted by delivery
        // progress or a snapshot, and the whole premise of this timeout is that
        // neither arrived - so on an idle chat the summary set stays incomplete
        // for the life of the connection while the retry budget still reads as
        // unspent.
        //
        // Re-arming here is what makes that budget real. It cannot spin: the
        // watchdog spends `MAX_WATCHDOG_RESTREAMS_PER_EPOCH` before it will ask
        // again, and `readCompleteness` disarms it outright once the delivery
        // is whole - so an answered resnapshot ends the loop on the next fire
        // rather than starting another.
        armStreamCompletionWatchdog({
          readCompleteness: true,
          restartDeadline: true,
        });
      }, HYDRATION_REQUEST_TIMEOUT_MS);
      client.requestResnapshot();
    };

    /**
     * Ask the host to start the accumulated-summary stream over.
     *
     * A `resnapshot`, because there is no narrower request: the summaries are
     * emitted while the host rebuilds a subscriber's index, and a resnapshot
     * is what puts it back into that state (it clears the host's per-subscriber
     * record of which set this client holds, so the reconcile actually
     * re-streams instead of short-circuiting on an identity match).
     *
     * Deduped on the same recovery-ledger resnapshot entry the invalidated
     * index uses, and deliberately the SAME entry rather than a second one:
     * one resnapshot repairs both, so two independent obligations would send
     * two for a frame that stales both at once.
     */
    const requestSummaryRestream = (): void => {
      requestResnapshotOnceForEpoch(get().transcriptWindow.epoch);
    };

    /**
     * The ONE derivation of both summary trust flags, from the ledger's
     * summary-assembly entry. The code note at the old assignment sites said
     * the two move together at every site; deriving them from one entry is
     * that note made structural - hand-setting either is how the trust gate
     * outside this store reads an assembling generation as a finished one.
     */
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
     * Is a chunked delivery still missing part of what it promised?
     *
     * Read off the TOTALS the snapshot states, and deliberately not off
     * whether a chunk was ever received. An earlier version gated both streams
     * behind "this stream has delivered something", to stop a chat that was
     * never going to stream from reading as stalled. That gate is unsound, and
     * unsound in exactly the case the watchdog exists for: when a stream's
     * whole content fits in ONE chunk and that sole chunk is dropped, the gate
     * never closes, and a stall that loses everything is the one stall it
     * cannot see. The same hole swallows the summaries whenever the skeleton
     * arrives and the summary stream's first chunk does not.
     *
     * The premise behind it was wrong too. No chat rides the snapshot without a
     * skeleton stream: `chunkRowSkeleton` states that an EMPTY skeleton yields
     * one empty final chunk rather than zero, precisely so "this chat has no
     * rows" is distinguishable from "chunks were lost", and the host streams it
     * on every bootstrap (`reconcileWindowedIndex`'s `state.kind === "none"`).
     * A receipt gate on the client threw that distinction away again.
     *
     * So the totals answer it directly:
     *
     * - The skeleton is owed until `skeletonComplete`, which only a chunk
     *   carrying `isFinal` sets, and only once its coverage agrees.
     * - The summaries are owed while a generation is mid-ASSEMBLY, or while
     *   the published count DISAGREES with `accumulatedFileChangeCount` -
     *   self-gating, because a chat with no accumulated changes promises
     *   none, assembles nothing, and `0 !== 0` is false.
     *
     * The assembly half is not redundant with the count: the count is aux and
     * can be rewound under a generation that is still arriving, and the array
     * it would be measured against has not been published yet. See the guard
     * itself.
     *
     * Still not the same predicate as `accumulatedSummarySetComplete`, which
     * the UI's visibility and action gates share: that one asks whether the
     * PUBLISHED set is trustworthy, this one whether a delivery is still owed.
     * But they are not independent, and reading them as two clean questions
     * was the mistake - a published set cannot be trusted while its
     * replacement is mid-flight, so "a delivery is owed" is an INPUT to
     * trustworthiness. Both now open on the same clause over the same public
     * state; what stays private is the assembly's CONTENTS, which is all the
     * panel needed kept back to keep rendering the previous complete set.
     *
     * Any mismatch, not just a short prefix. A revert LOWERS the count, and
     * the snapshot path deliberately retains the previous summary array until
     * a replacement chunk starting at index 0 arrives - so if that first
     * replacement chunk is dropped, the retained array is LONGER than the
     * count it is being measured against. A `<` reads that as complete,
     * disarms the watchdog, and leaves reverted paths and stale digests in
     * the panel for the rest of the connection. Overshoot is exactly as much
     * evidence of a broken stream as shortfall.
     *
     * Neither can indict a healthy chat, because the only state that reads as
     * incomplete is one where a resnapshot genuinely repairs something:
     * `handleResnapshot` resets the subscriber's index to `none` and its
     * summary belief to `null`, so the answer to it is always a full skeleton
     * and a full summary re-stream.
     */
    const chunkedDeliveryIncomplete = (): boolean => {
      const state = get();
      if (!state.transcriptWindow.skeletonComplete) return true;
      // A rebuild is in flight and its replacement stream has not landed. The
      // length check below cannot answer this: the retained array is the
      // previous generation's, and when the counts coincide it reads as a
      // finished delivery over stale digests - so the watchdog would disarm on
      // the one state it exists to notice.
      //
      // An unvouched-for ASSEMBLY proves that independently of the count, and
      // has to, because the count is aux and last-write-wins: a delayed
      // same-epoch snapshot can rewind it to zero mid-generation, and against
      // a published array that is still empty a count test then reads
      // `0 !== 0` as a finished delivery and disarms the watchdog on a
      // generation that never published.
      //
      // Read from STATE rather than from `assemblingSummaries` directly, and
      // the same clause is now the first thing
      // {@link accumulatedSummarySetComplete} asks. That predicate answers a
      // different question - whether the PUBLISHED set can be trusted, not
      // whether a delivery is owed - but the answers are not independent: a
      // set cannot be trusted while its replacement is in flight. Leaving the
      // in-flight fact private here is what let that predicate call an
      // assembling zero-count generation complete.
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

    /**
     * Notice a chunked delivery that STOPPED rather than finished.
     *
     * Both of these streams close their loop only when the final chunk
     * arrives - `applySkeletonChunk` reads completeness off `chunk.isFinal`,
     * and the summaries' gap check only runs when a LATER chunk exposes the
     * hole. Losing exactly the last frame is therefore silent: the skeleton
     * suffix keeps no metadata and `userRowPresence` answers `"unknown"`
     * forever, the file rows stay missing with `Review all` held back by a
     * nonzero undelivered count, and neither repairs before a reconnect. The
     * window's own doc already says what that state is worth: "`skeletonComplete`
     * merely goes false, which requests no repair."
     *
     * An IDLE timeout, re-armed by every chunk, rather than one deadline for
     * the whole stream. The failure being detected is a STALL, so a stream
     * that is merely slow but still arriving must not be restarted - it would
     * be torn down and re-sent precisely when the link is least able to afford
     * it. Re-arming makes the question "has anything arrived lately", which is
     * the question that actually distinguishes the two.
     *
     * Bounded by {@link MAX_WATCHDOG_RESTREAMS_PER_EPOCH}. A resnapshot
     * restarts the very stream whose stall triggered it, so an unbounded
     * version is a self-sustaining loop against a link that keeps dropping the
     * last frame - the same shape as the range-request loop this store already
     * shipped once. Past the cap it stops asking and leaves the partial state,
     * which is no worse than the behaviour this replaces.
     */
    const armStreamCompletionWatchdog = (input: {
      /**
       * Whether to read completeness before arming.
       *
       * `false` for a caller whose state has not landed yet - a snapshot can be
       * DEFERRED, so reading completeness here would read the window the
       * snapshot is about to replace. Arming costs one idle timer; the
       * fire-time check below is the authoritative one either way, and a missed
       * arm is the failure that matters.
       */
      readonly readCompleteness: boolean;
      /**
       * Whether this caller is DELIVERY PROGRESS, and so entitled to restart
       * the idle clock.
       *
       * The watchdog measures "has anything arrived lately", so only something
       * that actually carries stream content may reset it. A chunk qualifies. A
       * REBUILD snapshot qualifies - a fresh stream is starting behind it. An
       * aux-only snapshot does not: it carries no chunk, and an active chat
       * re-broadcasts one on every queue change and approval. Letting those
       * restart the deadline postpones the stall detector for as long as the
       * chat stays busy, which is exactly when a dropped chunk is most likely
       * and least affordable - the transcript keeps its missing rows for the
       * rest of the connection and nothing ever asks again.
       */
      readonly restartDeadline: boolean;
    }): void => {
      // Teardown first, and it always CLEARS - the guard below must never be
      // able to leave a timer running on a disposed store.
      if (disposed || !windowedLine) {
        clearStreamCompletionWatchdog();
        return;
      }
      // A non-progress arm with a deadline already running is a no-op: the
      // timer in flight is the one measuring this stall, and replacing it with
      // an identical one that starts now is the postponement itself.
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
          // Past the budget it stops asking and leaves the partial state -
          // and the ledger says so: the epoch's open recovery entries move to
          // the ABANDONED terminal, rendered-but-degraded via the existing
          // surfaces rather than silently reading as still-in-flight. The
          // planner keeps running over whatever the partial skeleton
          // delivered; abandonment is about streams nothing will re-ask for.
          recovery.abandonEpochRecovery(epoch);
          return;
        }
        watchdogRestreamsForEpoch = { epoch, count: spent + 1 };
        requestResnapshotOnceForEpoch(epoch);
      }, STREAM_COMPLETION_TIMEOUT_MS);
    };

    let hydrationRequestTimer: number | null = null;

    /**
     * Release the slot an unanswered range request is holding.
     *
     * The slot is the dedup key: while it holds a request for a range, every
     * later plan for that same range is suppressed as already-asked. That is
     * right for a request that is going to be answered, and a wedge for one
     * that is not - a `loadRange` or its response dropped on a stream that
     * stays OPEN clears nothing, and the visible gap then stays placeholders
     * for as long as the viewport does not move. Nothing else recovers it:
     * `applyVisibleTranscriptRange` returns early on an unchanged report, and
     * the other two clear sites are a snapshot and a downgrade, both of which
     * need a reconnect.
     *
     * So the wait is bounded ({@link HYDRATION_REQUEST_TIMEOUT_MS}) and the
     * plan is simply re-issued.
     *
     * Releasing the slot says nothing about the request's ANSWER: its
     * recovery-ledger entry survives, so an answer that merely took longer
     * than the deadline still seats. The states in which the ordinals no
     * longer name anything usable - an authority boundary, a downgrade - are
     * the ledger's own transitions (`authorityBoundary`, `dropAll`), taken
     * beside this release, never instead of it.
     *
     * The converse is not a free action, which is the trap this pairing hides.
     * Releasing the slot while KEEPING the ledger looks like the conservative
     * half of the choice and is the one that loses the answer: the re-plan it
     * permits asks for the same range again, and the new request's ledger entry
     * evicts an older one at the cap. Call this only for a request that is
     * genuinely gone, never as a precaution.
     */
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
      // Clears the previous request's timeout as well as its slot: replanning
      // over an outstanding request abandons it, and its deadline with it. Its
      // ledger entry deliberately stays - a differently-planned request does
      // not make the earlier answer wrong, only unawaited.
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
      // The repair budget is charged HERE, at the mint, and not at the demotion
      // that asks for one. A demotion is a request to re-plan, not a request on
      // the wire: when an outstanding request already covers the same rows the
      // re-plan is deduplicated and nothing is sent. Charging the demotion let a
      // queue of answers older than the write spend the whole budget while the
      // dedup slot suppressed every send - the client then warned that it was
      // giving up after three rounds having asked the host exactly nothing.
      // Owned by the turn that asked for it, as well as by the rows: a demotion
      // whose re-plan never went out can outlive its turn, and without the turn
      // check the NEXT turn's first request over those same rows was charged as
      // that turn's first repair before it had asked for anything.
      const repairs =
        pendingCatchUp !== null &&
        pendingCatchUp.turnId === catchUpBudget?.turnId &&
        pendingCatchUp.ordinals.some(
          (ordinal) => ordinal >= next.fromOrdinal && ordinal < next.toOrdinal,
        );
      // Dated on the way out: what this answer can be missing is decided by the
      // writes already made when it was asked for, never by what the window
      // happens to hold when it lands.
      hydrationRequestMarks.set(requestId, activeTurnWriteMark);
      if (repairs) {
        pendingCatchUp = null;
        if (catchUpBudget !== null) {
          catchUpBudget = {
            ...catchUpBudget,
            rounds: catchUpBudget.rounds + 1,
          };
        }
      }
      hydrationRequestTimer = window.setTimeout(() => {
        hydrationRequestTimer = null;
        // Only the request this timeout was armed for. Anything else already
        // replaced the slot - and took the deadline with it.
        if (disposed || inFlightHydrationRequest?.requestId !== requestId) {
          return;
        }
        // Releases the dedup slot so the plan can be re-asked. `requestId`
        // keeps its ledger entry: this is a request that has waited too long,
        // not one whose answer has been ruled out.
        inFlightHydrationRequest = null;
        requestPlannedHydration();
      }, HYDRATION_REQUEST_TIMEOUT_MS);
      client.requestTranscriptRange({
        requestId,
        epoch: transcriptWindow.epoch,
        fromOrdinal: next.fromOrdinal,
        // The two bounds mean different things and the conversion is here.
        // `OrdinalRange.toOrdinal` is EXCLUSIVE (see its declaration);
        // `ChatLoadRangeRequest.toOrdinal` is inclusive at both ends, as is the
        // `sliceTranscriptRange` that serves it. Forwarding it unchanged asked
        // for one row more than the plan on every request - and at a gap
        // boundary that extra row is the first row of the span already held,
        // so it also pulled a body the client did not need across the wire.
        //
        // `planTranscriptHydration` never returns an empty range, so
        // `toOrdinal - 1` cannot fall below `fromOrdinal`.
        toOrdinal: next.toOrdinal - 1,
        // The host clamps this to its own ceiling regardless, so asking for the
        // full frame budget is asking for "as much as one frame holds" rather
        // than a number this side has to keep in step.
        maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
      });
      // The cap binding is a SUPERSEDE-AND-REPLAN, never silent trust: the
      // evicted oldest entries are replaced by one NEW wider request covering
      // their rows, whose own entry carries the obligation. A response to an
      // evicted requestId is discarded exactly as any unrecorded response is,
      // and only the wider request's own accepted answer closes its entry -
      // no path lets one member's response discharge another's obligation.
      // The ledger evicted enough to fit this one back under the cap.
      if (capEvicted.length > 0) {
        // The marks go with the entries, always. `takeHydrationRequestMark`
        // retires a mark when its answer ARRIVES, and for these ids no answer
        // ever will be accepted - the ledger dropped them, so the response path
        // refuses them exactly as it refuses an unrecorded id. Leaving the marks
        // behind grew the map without bound on any stream that keeps losing
        // requests or answers: the 30-second timeout re-asks, each re-ask can
        // evict at the cap, and none of it is visible to the ledger's own byte
        // accounting because these entries sit outside it.
        for (const entry of capEvicted) {
          hydrationRequestMarks.delete(entry.requestId);
        }
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
        // Dated like any other request. It replaces the evicted entries'
        // obligations, and it inherits nothing from them: it is sent NOW, so
        // what it can contain is what the current mark says.
        hydrationRequestMarks.set(widerRequestId, activeTurnWriteMark);
        client.requestTranscriptRange({
          requestId: widerRequestId,
          epoch: transcriptWindow.epoch,
          fromOrdinal: evictedFrom,
          toOrdinal: evictedTo - 1,
          maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
        });
      }
    };

    /**
     * Record that a delta invalidated bodies a range request is still waiting
     * for.
     *
     * Reads the SAME predicates {@link applyIndexChange} folds with
     * ({@link bodyInvalidatingOrdinals}, then {@link recordSharingOrdinals})
     * rather than re-deriving "which ordinals does this frame stale" from
     * `changes` here - a second copy of that rule would drift from the one that
     * decides which spans to drop, and the two disagreeing is exactly the state
     * this guards against.
     *
     * ## An ordinal is not the unit a response is stale in
     *
     * The ordinals a request ASKED for are not the rows its answer can carry a
     * stale copy of. A range serves a row from its turn's shared records, so a
     * response for slice 10 generated before an `updated` for sibling slice 12
     * seats that turn's pre-update records - and an intersection on requested
     * ordinals is empty, so the answer is accepted. Slice 10 is then covered,
     * slice 12 need not be visible, and nothing refetches either.
     *
     * So the frame's ordinals are widened to the turn before they are matched
     * against a range. The widening is deliberately conservative: superseding a
     * request that would have been fine costs one discard and one refetch,
     * while accepting one that was not costs a body no gap will ever re-ask
     * for.
     */
    const supersedeInFlightHydration = (input: {
      readonly epoch: number;
      readonly changes: readonly ChatIndexChange[];
    }): void => {
      if (!recovery.hasOpenRanges()) return;
      const bodyInvalidated = bodyInvalidatingOrdinals(input.changes);
      // Against the window as the requests were framed against it - this runs
      // before the fold, and an `updated` never renumbers a row, so the turn a
      // widened ordinal belongs to is the same either side of it.
      //
      // The per-entry rules live on the ledger and are unchanged: EVERY open
      // request is marked, not just the one holding the dedup slot; a
      // `reindexed` - or a NEWER epoch, which is a reindexed this client
      // learned about late - voids every entry's answer outright; a same-epoch
      // `updated` accumulates its ordinals per intersecting entry (exclusive
      // at the range top, matching the wire's inclusive-bound conversion).
      const invalidated =
        bodyInvalidated === "all"
          ? bodyInvalidated
          : recordSharingOrdinals(get().transcriptWindow, bodyInvalidated);
      recovery.markRangesSuperseded({ epoch: input.epoch, invalidated });
    };

    /**
     * Should this `range` response be thrown away rather than seated?
     *
     * Tested against what the response actually SERVED - a truncated answer
     * that stopped before the invalidated ordinal is still current, and
     * discarding it would cost a round trip for nothing.
     *
     * An untracked response is discarded rather than trusted. A record is
     * absent only because a snapshot or a downgrade dropped it (see
     * the ledger's `authorityBoundary`/`dropAll`) or the cap evicted it, and that is
     * precisely the state in which nothing recorded what happened to these
     * ordinals while the answer was in the air. Costing a re-request there is
     * the cheap side of the trade; the expensive side is a body that renders
     * as current forever.
     *
     * Matched against the response's OWN request rather than whichever one
     * currently holds the dedup slot. A slow answer is late, not wrong: the
     * question is what happened to the ordinals THIS request asked for, and
     * the request that replaced it in the slot cannot answer that.
     */
    const rangeResponseIsStale = (response: ChatRangeResponse): boolean =>
      recovery.rangeAnswerIsStale({
        requestId: response.requestId,
        fromOrdinal: response.fromOrdinal,
        servedCount: response.rowIds.length,
      });

    /**
     * What every log line about a range answer names.
     *
     * Every discarded answer is logged, at the one level the desktop log keeps
     * for the renderer. A range that never seats has no other trace: the
     * placeholder it would have filled looks exactly like one nothing has asked
     * for yet, and the loop this store shipped twice - every answer thrown
     * away, every discard minting one more request - was invisible from
     * outside until a screenshot arrived.
     */
    const rangeAnswerLogFields = (
      response: ChatRangeResponse,
    ): {
      readonly epicId: string;
      readonly chatId: string;
      readonly requestId: string;
      readonly epoch: number;
      readonly fromOrdinal: number;
      readonly rows: number;
      readonly activeTurnId: string | null;
    } => ({
      epicId: options.epicId,
      chatId: options.chatId,
      requestId: response.requestId,
      epoch: response.epoch,
      fromOrdinal: response.fromOrdinal,
      rows: response.rowIds.length,
      activeTurnId: get().activeTurn?.turnId ?? null,
    });

    /**
     * May this answer install over a body the client knows is unsound?
     *
     * Every condition here is about there being a REPAIR behind the forfeit.
     * Handing the served body the seat is only acceptable because something
     * comes after it to correct what it in turn is missing; where nothing can,
     * the ordinary held-copy preference is what protects the drawn body, and
     * that is also exactly what base does.
     */
    const mayRepairUnsoundBody = (input: {
      readonly budget: {
        readonly unsound: boolean;
        readonly rounds: number;
      } | null;
      readonly turnOrdinals: readonly number[];
      readonly markIsCurrent: boolean;
      readonly deferred: boolean;
    }): boolean => {
      const { budget } = input;
      if (budget === null || !budget.unsound) return false;
      // Nothing of the turn's OWN rows to retire means no repair can follow, so
      // a forfeit here is just a worse body installed with no gap left to
      // re-request it. A STEER row is the case that matters: it carries the
      // whole turn's records, so the answer passes the records test, but it is
      // not one of the turn's assistant rows - it yields no ordinal,
      // `refreshSeatedRows` moves nothing, and the demotion never happens.
      if (input.turnOrdinals.length === 0) return false;
      // While a windowed snapshot waits for its tail the coalescing buffer
      // cannot be drained, so seating a served body over the held one would
      // install it against a window that has not absorbed the writes the client
      // already holds - the double-apply, by another route.
      if (input.deferred) return false;
      // Either this answer is itself the whole truth, or another repair can
      // still follow it.
      return (
        input.markIsCurrent || budget.rounds < MAX_PROVISIONAL_CATCH_UP_ROUNDS
      );
    };

    /**
     * Seat one non-stale `range` answer, logging the two ways the fold can
     * still refuse it, and re-ask for a body that predates a dropped write.
     */
    const seatRangeAnswer = (
      response: ChatRangeResponse,
      /**
       * The write mark this answer's request was sent under, or `undefined` for
       * a request nothing recorded - a cap-evicted or boundary-abandoned id,
       * whose answer the ledger has already refused.
       */
      sentUnderMark: number | undefined,
    ): TranscriptWindow => {
      const activeTurnIdBeforeFlush = get().activeTurn?.turnId ?? null;
      // Forfeiting the held copy's authority is only ever worth it because a
      // repair is in play: the served body may be older than what is on screen,
      // and what makes that acceptable is either that THIS answer is the repair,
      // or that one can still follow it. An old answer arriving once neither
      // holds would replace the best body the client has with a worse one and
      // nothing would put it back, so past that point the ordinary held-copy
      // preference protects what is drawn - while the exhausted budget is still
      // retained, so nothing restarts the rounds.
      //
      // The first disjunct is not redundant, and leaving it out broke the LAST
      // repair of every episode. Rounds are charged when a request is SENT, so
      // by the time the third one's own answer arrives the budget already reads
      // as spent; asking "may I authorise another" there rejected the very body
      // that repair had been authorised to fetch and certified the torn copy in
      // its place. Asking instead whether THIS answer saw no write in flight
      // gets that case right, and is strictly better than a "was this the
      // repair" stamp would be: an authorised repair that a write DID overtake
      // is not preferred either, so the newer text on screen survives it.
      const markIsCurrent =
        sentUnderMark !== undefined && sentUnderMark === activeTurnWriteMark;
      // The rows this answer could retire, decided before the seat because the
      // forfeit below depends on it.
      const turnOrdinals = activeTurnOrdinalsOf(
        response,
        activeTurnIdBeforeFlush,
      );
      const repairsUnsoundBody = mayRepairUnsoundBody({
        budget:
          activeTurnIdBeforeFlush === null
            ? null
            : budgetForTurn(activeTurnIdBeforeFlush),
        turnOrdinals,
        markIsCurrent,
        deferred: deferredWindowedSnapshot !== null,
      });
      if (repairsUnsoundBody) {
        // Drain the coalescing buffer BEFORE seating, so the window this answer
        // folds into is what the client has actually received rather than what
        // the flush coordinator has got round to applying.
        //
        // Everywhere else the two can differ harmlessly, because the active
        // arm keeps the held copy and the buffered delta lands on it a tick
        // later. This path is the exception: it hands the served body the seat,
        // and a delta still sitting in the buffer is then applied on top of a
        // body the host had ALREADY applied it to - the same text twice. The
        // mark cannot see that either, since it counts a write when the frame
        // arrives and the buffer is exactly the gap between arriving and being
        // applied.
        //
        // The deferred-snapshot state is excluded by the gate above rather than
        // here: that is the one state `applyBufferedDeltas` refuses to drain in
        // (there is no seated row for a delta to attach to yet, and forcing it
        // would discard the batch), so taking the repair arm there would seat a
        // served body with the buffer still full - the same double-apply by
        // another route.
        applyBufferedDeltas();
      }
      const before = get().transcriptWindow;
      const activeTurnId = get().activeTurn?.turnId ?? null;
      const seated = applyRangeResponse(
        before,
        response,
        // An UNSOUND body forfeits the active turn's held-copy authority: it is
        // one this client knows is not what the host would serve, so the premise
        // that the held copy has every write - the whole basis of the active arm
        // - is false for it, and letting it stand would have that body
        // substitute away the catch-up sent to repair it. `activeTurnId` is the
        // only thing that selects that arm, so passing `null` is how the fold is
        // told. Under the settled arm the served copy seats unless the held one
        // is demonstrably ahead, which is the right default for a record the
        // client has already established is incomplete.
        repairsUnsoundBody ? null : activeTurnId,
        imageWitnesses,
      );
      if (seated === before) {
        // The fold returns its input by identity on an epoch mismatch or an
        // empty answer - neither seats a row.
        appLogger.warn("[transcript] discarded a range answer unseated", {
          ...rangeAnswerLogFields(response),
          windowEpoch: before.epoch,
        });
        return seated;
      }
      if (!before.invalidated && seated.invalidated) {
        appLogger.warn(
          "[transcript] discarded a range answer that contradicted the skeleton; index voided",
          rangeAnswerLogFields(response),
        );
        return seated;
      }
      return settleActiveTurnCatchUp({
        response,
        seated,
        activeTurnId,
        markIsCurrent,
        turnOrdinals,
      });
    };

    /**
     * Decide what the answer just seated leaves owed for the streaming turn:
     * nothing, or another catch-up.
     *
     * Split out of {@link seatRangeAnswer} for the complexity budget, and the
     * split falls where the two halves genuinely differ - above is "did this
     * answer seat at all", here is "is what it seated the whole of the turn".
     */
    const settleActiveTurnCatchUp = (input: {
      readonly response: ChatRangeResponse;
      readonly seated: TranscriptWindow;
      readonly activeTurnId: string | null;
      /** No write was observed between this answer's request and its arrival. */
      readonly markIsCurrent: boolean;
      /** The active turn's own rows among the ones this answer served. */
      readonly turnOrdinals: readonly number[];
    }): TranscriptWindow => {
      const { response, seated, activeTurnId, markIsCurrent, turnOrdinals } =
        input;
      // The turn's RECORDS are what a write staled, so records are what this
      // asks about. Scrollback from the same era is current and must not be
      // re-fetched; a sibling row of the turn is stale even though the echo
      // named a different ordinal. And "seats" rather than "carries": a row the
      // host declared incomplete takes its whole turn out of the fold, so an
      // answer that carries the turn and withholds it has installed nothing -
      // reading the raw records there retired a COMPLETE historical row served
      // in the same answer and asked for it again, discarding valid hydration
      // to chase a body that never seated.
      if (activeTurnId === null) return seated;
      if (!rangeSeatsActiveTurn(response, activeTurnId)) return seated;
      const budget = budgetForTurn(activeTurnId);
      // Nothing is owed for a turn whose held copy is sound: the deltas have
      // been landing on it, so it is already what the host would serve, and the
      // active arm of the fold kept it over this answer for exactly that reason.
      if (!budget.unsound) return seated;
      // Closing the gap takes BOTH halves, and each rules out a different way
      // of being wrong.
      //
      // The mark answers "did any write happen between this request going out
      // and its answer coming back". If none did, the answer carries every
      // write up to its slice and the client has applied every write since, so
      // together they are the turn. It is per-ANSWER provenance, which is what
      // makes it hold when several answers are outstanding at once: a shared
      // "has the body changed since the last seat" baseline cannot, because the
      // first answer to install resets it and the next then reads "unchanged"
      // and discharges the obligation with the write still missing.
      //
      // But a mark describes the ANSWER, and the answer is not necessarily what
      // the window ended up holding - the fold can substitute a held copy for
      // the served one. Certifying on the mark alone then declared the row
      // current while the body on screen was the torn one this answer had been
      // sent to replace. So the records have to have actually landed.
      const closesTheGap =
        markIsCurrent &&
        rangeRecordsInstalled(seated, response.messages, activeTurnId);
      if (closesTheGap) {
        catchUpBudget = { ...budget, turnId: activeTurnId, unsound: false };
        // And the demotion that never became a request is cancelled with it.
        // Left standing, the next request to cover these rows - a plain
        // re-visit, once the turn is sound again - would be charged as a repair
        // for a turn that no longer owes one.
        pendingCatchUp = null;
        return seated;
      }
      if (budget.rounds >= MAX_PROVISIONAL_CATCH_UP_ROUNDS) {
        // Writes have overtaken every catch-up actually sent. Keep what is on
        // screen and stop: the completion rebase re-seats the turn from the
        // host, and a request per round trip for the rest of a long turn is a
        // worse failure than a body that repairs late.
        //
        // The exhausted budget is KEPT, not forgotten. Dropping it let a late
        // answer - one that predated the write and had been in flight through
        // the whole episode - find a fresh budget and start the rounds over,
        // which is the cap failing to be a cap.
        appLogger.warn(
          "[transcript] giving up on catching a streaming row up; leaving it to the completion rebase",
          { ...rangeAnswerLogFields(response), rounds: budget.rounds },
        );
        pendingCatchUp = null;
        return seated;
      }
      // The ACTIVE TURN's rows only, widened to the turn inside
      // `refreshSeatedRows`: a slice and its steer siblings share the records
      // that went stale, so retiring one without the others would leave the
      // same trailing body drawn under a neighbouring ordinal. A settled row
      // served in the same answer is not retired and is not repair work -
      // taking every ordinal the answer happened to carry threw away a complete
      // historical row's hydration, and then let a later visit to that row be
      // charged against the streaming row's repair budget. The seat stays
      // rendered - the stale tier still draws - and the gap it opens is what
      // the planner turns back into a request.
      const refreshed = refreshSeatedRows(seated, turnOrdinals);
      if (refreshed === seated) return seated;
      // Asking for the re-plan, not charging for it. The budget moves only if
      // this turns into a request on the wire - see the mint in
      // `requestPlannedHydration`.
      catchUpBudget = { ...budget, turnId: activeTurnId };
      pendingCatchUp = { turnId: activeTurnId, ordinals: turnOrdinals };
      appLogger.info(
        "[transcript] re-asking for a range answer that predates a write",
        {
          ...rangeAnswerLogFields(response),
          // Which half of the gap test refused it: `false` means a write was
          // observed while it was in flight, `true` means the fold kept a held
          // copy over the one it served.
          markIsCurrent,
          activeTurnWriteMark,
          rounds: budget.rounds,
        },
      );
      return refreshed;
    };

    /** {@link ChatSessionState.reportVisibleTranscriptRange}'s implementation;
     *  hoisted beside the planner it drives rather than defined inline in the
     *  state object two thousand lines below. */
    const applyVisibleTranscriptRange = (range: OrdinalRange | null): void => {
      const unchanged =
        (range === null && visibleTranscriptRange === null) ||
        (range !== null &&
          visibleTranscriptRange !== null &&
          range.fromOrdinal === visibleTranscriptRange.fromOrdinal &&
          range.toOrdinal === visibleTranscriptRange.toOrdinal);
      visibleTranscriptRange = range;
      // Off the windowed line the value is recorded (the line can be
      // negotiated by a later reconnect) but nothing here could mean anything
      // yet.
      if (unchanged || !windowedLine || disposed) return;
      // Warm the LRU for what the reader is looking at BEFORE planning. An
      // already-hydrated visible span plans no fetch, so this report is the
      // only event that ever re-touches it - without it, returning to old
      // scrollback leaves it "coldest" for the next eviction even while it is
      // on screen.
      //
      // A `null` report reaches this too, and must: it warms nothing, but the
      // window RETAINS the range to protect the carry the reader is on, and a
      // retained one would go on exempting spans they have scrolled away from.
      const window = get().transcriptWindow;
      const touched = touchTranscriptRange(window, range);
      if (touched !== window) set({ transcriptWindow: touched });
      // What `null` does only CLEAR is the standing obligation - there is
      // nothing to fetch for "no placed row visible".
      if (range === null) return;
      requestPlannedHydration();
    };

    /**
     * Re-point `messages`/`events` at what the window now holds.
     *
     * The steady-state path for every windowed frame that changes hydration
     * without being authoritative about anything else.
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

    /**
     * Re-settle after a WHOLE-SET slice moved while the transcript did not.
     *
     * Both charge formulas fold {@link chatSlicesOf}'s six slices in, but only
     * the transcript paths used to re-settle. An auxiliary frame - managed
     * commands, the queue, an approval, an interview, background items - wrote
     * its slice into the store and left the accountant holding the previous
     * figure, so that growth sat outside the process-wide chat budget until
     * some unrelated transcript frame happened to arrive and recompute it.
     *
     * Picks the arm the same way the accountant's own `evict` does, off
     * `windowedLine`, so the two can never disagree about what this holder is
     * charged for.
     *
     * Deliberately does NOT stamp recency, unlike the two commits above.
     * Recency orders LRU eviction, and a frame arriving is not evidence anyone
     * is READING this chat; stamping here would quietly reorder eviction as a
     * side effect of an accounting fix.
     */
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
      // `null` for the ordinary frames, which say nothing beyond "this is what
      // the window holds now"; a range response passes its counter bump so the
      // rows and their provenance land in ONE `set`.
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
     * Route a record that arrived with no ordinal into the window.
     *
     * The append half of "state.messages is DERIVED on this line". An applier
     * that appended to the published array instead would have its work erased
     * by the very next windowed frame - a skeleton chunk, an index delta, a
     * range - because that array is rebuilt from the window each time. The
     * legacy line has the same shape and does not notice, because there the only
     * rebuild is a snapshot, which carries the record anyway.
     *
     * {@link rewriteMessageInPlace} is the same rule for a record that already
     * HAS an ordinal.
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
     * Settle an interview, on whichever line this session is on.
     *
     * The shared path for `onInterviewAnswered` and `onInterviewErrored`, which
     * differ only in the projection they build. Both used to write the
     * lifecycle result to `state.messages` alone, and on the windowed line that
     * array is DERIVED: the very next skeleton chunk, index delta, range or
     * appended event rebuilds it from `transcriptWindow` and the interview
     * block reverts to unresolved - with `pendingInterviews` already cleared,
     * so nothing re-settles it and the row stays stuck showing a question the
     * user has answered.
     *
     * A settlement that landed on the LIVE row needs no window write:
     * `liveAssistantMessage` is not a window record and both lines hold it the
     * same way.
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
          // `held: false` means the row left the window between the fold above
          // and here. Publishing the fold's array anyway would reintroduce a
          // record the window no longer holds; the host's emit-after-persist
          // invariant means the eventual re-hydration serves it settled.
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

    /**
     * The windowed snapshot as the shared fold expects it.
     *
     * The chat record regains its two transcript arrays - from the WINDOW, so
     * they hold what is hydrated rather than what exists - and every other
     * field maps across unchanged, because the two snapshot shapes differ in
     * exactly the transcript and the accumulated changes.
     *
     * `accumulatedFileChanges` is deliberately empty. The windowed line carries
     * SUMMARIES (a digest and counts, no before/after contents), which is a
     * different type from what this field holds; they land in
     * `accumulatedFileChangeSummaries` instead, and every surface that used to
     * read this field now reads the row model derived from whichever of the two
     * this line delivers.
     */
    const adaptWindowedSnapshot = (
      frame: ChatWindowedSnapshotFrame,
      window: TranscriptWindow,
      // The frame's aux as of NOW rather than as of when it was sent - see
      // {@link deferredWindowedSnapshotAux}. `null` for a snapshot applied on
      // arrival, which is every snapshot whose tail was already in.
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
          portForwards: current.portForwards,
          turnInProgress: current.turnInProgress,
          pendingFallback: current.pendingFallback,
          pendingReturn: current.pendingReturn,
          lastFailedAttempt: current.lastFailedAttempt,
          lastFallbackOutcome: current.lastFallbackOutcome,
        },
      };
    };

    /**
     * Runs the shared fold if the tail is in, or holds the frame until it is.
     * The one place the wait-for-tail rule is enforced.
     *
     * `aux` is the state that must land WITH the published transcript - the
     * new window above all (see `applyAuthoritativeSnapshot`'s doc for why
     * setting it in a separate earlier `set` mis-suppresses rows). When the
     * fold runs, `aux` rides its atomic `set`; when the frame defers, `aux`
     * rides a single `set` with the window's own hydrated records.
     *
     * Those records go out on the DEFERRAL path too, and that is the point.
     * The deferral cases are a rebase (no spans) or a same-epoch snapshot whose
     * retained spans already agree with the rendered models - so publishing is
     * a no-op in the second and the whole fix in the first. A rebase moves the
     * transcript into a new coordinate space and `applyWindowedSnapshot`
     * returns an empty window for it; leaving `messages`/`events` alone there
     * keeps the PREVIOUS epoch's rows on screen, where the row merge reads them
     * as unplaced rows of the new space. If the tail that would replace them is
     * slow or lost, the reader keeps seeing a transcript that no longer exists.
     */
    const applyOrDeferWindowedSnapshot = (
      frame: ChatWindowedSnapshotFrame,
      window: TranscriptWindow,
      aux: Partial<ChatSessionState>,
    ): void => {
      if (!isTailHydrated(window)) {
        const records = hydratedRecords(window);
        // D215: the OUTCOME is seated immediately, alone among the four
        // fallback DTOs, and the asymmetry is deliberate.
        //
        // The other three are transcript-coupled CARD state: publishing them a
        // beat early makes the row merge read a real row as renderer-suppressed
        // (see `applyAuthoritativeSnapshot`'s doc). An outcome has no such
        // coupling - it is a fact about an incident, not a row - and it has a
        // consumer that must speak it exactly once. Holding it costs an
        // announcement outright, because `appendFallbackNoticeBlock` publishes
        // a SNAPSHOT and guarantees no later `turnStateChanged`: there is no
        // second carrier to rescue a deferred snapshot-only outcome.
        //
        // Read the HELD aux, never `frame.snapshot`. This branch re-runs on
        // every range response that does not complete the tail, and the stash
        // below is guarded on the frame being NEW - so on re-entry the held aux
        // carries the supersessions `advanceDeferredSnapshotAux` has collected
        // and the frame carries the value it arrived with. Reading the frame
        // here would re-apply a withdrawn outcome on each pass, which is the
        // exact defect the aux exists to prevent.
        const heldAux =
          frame === deferredWindowedSnapshot
            ? deferredWindowedSnapshotAux
            : null;
        set({
          ...aux,
          lastFallbackOutcome: (
            heldAux ?? deferredWindowedSnapshotAuxOf(frame.snapshot)
          ).lastFallbackOutcome,
          messages: records.messages,
          events: records.events,
          transcriptRowContext: records.rowContext,
        });
        // Re-entry with the frame already held keeps the supersessions
        // collected since it arrived; a NEW snapshot replaces both, because its
        // own aux is the newer authority for everything it carries.
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
      // The adapted snapshot's records ARE `hydratedRecords(window)`, so its
      // context has to ride the same apply. Left out, a snapshot would seat
      // rows against whatever context the previous hydration published.
      applyAuthoritativeSnapshot(
        adaptWindowedSnapshot(frame, window, superseded),
        {
          ...aux,
          transcriptRowContext: hydratedRowContext(window),
        },
        // The HOST's answer, not a scan of the adapted frame: those records are
        // the hydrated subset, and a failure several user rows back is exactly
        // the shape that falls outside the inline tail.
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
        // The legacy line's `messages` IS the transcript, so the scan is the
        // whole-transcript answer here and needs no host help.
        //
        // This event is also a whole-transcript RESIDENCY claim, not merely a
        // decode buffer: `applyAuthoritativeSnapshot` retains both arrays in the
        // replica. T5's process-wide accountant must charge that complete cost;
        // this line has no ordinal/range mechanism with which to evict part of
        // it and later recover it.
        applyAuthoritativeSnapshot(
          frame,
          null,
          latestAssistantAuthFailureTurnKey(frame.snapshot.chat.messages),
        );
        commitLegacyTranscriptBudget();
        return;
      }
      // A LEGACY snapshot on a session that had negotiated `1.8`: the
      // reconnect renegotiated onto an older line (a host rolled back below
      // `1.8`, or a fallback route to an older peer). The windowed state is
      // not stale-but-usable, it is unaddressable - no current peer serves
      // the epoch its ordinals live in, so stale placeholders could never
      // hydrate - and left in place it would make the appliers treat this
      // WHOLE transcript as a hydrated subset and merge it against a dead
      // skeleton. Drop all of it, atomically with the snapshot's own publish
      // (`extra` below), and fall back to the legacy shape the discriminator
      // now reports.
      windowedLine = false;
      clearInFlightHydration();
      clearStreamCompletionWatchdog();
      // Not merely unawaited: this line no longer HAS ordinals, so an answer
      // still in the air describes a coordinate space nothing here can read.
      // The whole ledger drops with the window - ranges, recovery entries
      // and summary trust alike.
      recovery.dropAll();
      hydrationRequestMarks.clear();
      // The window itself is going: whatever body was seated in it is not
      // there to repair any more.
      forgetCatchUpBudget();
      clearResnapshotRequestTimer();
      forgetDeferredWindowedSnapshot();
      // The buffer belongs to the windowed line too. Left behind, the flag
      // below and it disagree at the one site whose own comment demands a
      // blank slate for a later re-upgrade.
      assemblingSummaries = null;
      // The witness store's evidence orders copies within the windowed
      // coordinate space this line is abandoning; a later re-upgrade starts
      // a new lineage and must not inherit stamps from the old one.
      imageWitnesses = createImageWitnessStore();
      applyAuthoritativeSnapshot(
        frame,
        {
          transcriptWindow: emptyTranscriptWindow(),
          transcriptDerived: null,
          // The rest of the windowed line's aux state, back to its initial
          // values: nothing reads either once `transcriptDerived` is null,
          // but a LATER re-upgrade must start from the same blank state a
          // fresh store does.
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
      // No epoch/cursor exists on this line from which an authority-side
      // replacement could be inferred. In particular, this is not a client
      // reseed escape hatch: AdapterHost intentionally has no such capability.
      requestReplacement: () => {},
    });

    /**
     * Hand a stalled recovery back to the composer, loudly - the ordinary
     * refusal outcome, reached late.
     *
     * Every exit from recovery that is not a dispatched retry comes here: the
     * resolver found nothing, the session was torn down, or `sendAction`
     * refused because the connection is no longer open. Without it the
     * prompt's only record was an async closure, and a reconnect during
     * recovery lost it outright - no pending action, no queue row, no
     * restoration, and for a QUEUED send not even an optimistic echo, because
     * queued sends never get one.
     */
    /**
     * Action ids whose follow-up `errorNotice` must still be swallowed, and
     * the timer that stops swallowing.
     *
     * Suppressing only while the recovery record exists was not enough. The
     * host's rejection is a SEQUENCE - the ack, then an awaited failure-event
     * append, then a separate `errorNotice` - and local byte recovery can be
     * quick enough to dispatch the retry before that notice arrives. The
     * record is gone by then, the notice no longer matches, and a successful
     * retry ends with the user reading a missing-attachment warning for a
     * message that went through.
     *
     * Bounded rather than permanent: a notice that never comes must not leave
     * an id suppressed for the life of the session, because the id could be
     * reused by nothing else but the SET would grow. Cleared when the notice
     * is observed, or after the window.
     */
    const noticesSuppressedAfterDispatch = new Map<string, number>();
    const suppressNoticeAfterDispatch = (clientActionId: string): void => {
      const existing = noticesSuppressedAfterDispatch.get(clientActionId);
      if (existing !== undefined) window.clearTimeout(existing);
      noticesSuppressedAfterDispatch.set(
        clientActionId,
        window.setTimeout(() => {
          noticesSuppressedAfterDispatch.delete(clientActionId);
        }, POST_DISPATCH_NOTICE_SUPPRESSION_MS),
      );
    };
    /** True once, then stops: the notice this was waiting for has arrived. */
    const consumeSuppressedNotice = (clientActionId: string): boolean => {
      const timer = noticesSuppressedAfterDispatch.get(clientActionId);
      if (timer === undefined) return false;
      window.clearTimeout(timer);
      noticesSuppressedAfterDispatch.delete(clientActionId);
      return true;
    };
    const clearSuppressedNotices = (): void => {
      for (const timer of noticesSuppressedAfterDispatch.values()) {
        window.clearTimeout(timer);
      }
      noticesSuppressedAfterDispatch.clear();
    };

    /**
     * Release the staging revision this action left behind, leaving a NEWER
     * entry alone.
     *
     * `stateFailedSendRestoration` does the same thing for a prompt that is
     * not going back to the composer. A dispatched retry is the other case
     * with the same need: it consumed a pick of its own, so the entry the
     * settled action recorded is stale, and leaving it lets a later
     * displacement release a binding that belongs to whatever the user has
     * staged since.
     */
    const releaseStagingRevisionFor = (clientActionId: string): void => {
      const stagedRevision =
        stagingRevisionByRestoredAction.get(clientActionId);
      if (stagedRevision === undefined) return;
      useWorktreeIntentStagingStore
        .getState()
        .releaseIntentForDispatch(ownerStagingKey, stagedRevision);
      stagingRevisionByRestoredAction.delete(clientActionId);
    };

    /**
     * Put whatever prompt exists only in this store into the Drafts control,
     * as a closed start-page draft.
     *
     * Best effort and deliberately fire-and-forget: `dispose` is synchronous
     * and the shared registry gives it no await, so blocking is not on the
     * table. The install outlives this turn, which is the whole point - the
     * alternative is not "a slower handoff", it is none.
     */
    const handOffUnrecordedPromptToStash = (): void => {
      const state = get();
      // PLURAL, matching `holdsUnrecordedPrompt`'s four states. A first version
      // handed off the single best source and repeated the defect this whole
      // thread is about: `failedSendRestoration` is still ONE slot, so when two
      // refusals abandon together the loser's prompt lives only inside a notice
      // MESSAGE - a string, with no document behind it to stash later. Nothing
      // would have noticed, because the one that won the slot was handed off
      // and the stash had an entry in it.
      //
      // The last-copy documents now come from `lastCopyPrompts`, not from a
      // list this disposal happened to build: a notice-only state that has
      // been sitting in the ring since long before teardown is exactly the
      // one that reaches the hour cap, and a list of "what THIS disposal
      // abandoned" is empty for it.
      for (const source of unrecordedPromptSources(
        state.failedSendRestoration,
        Object.values(state.pendingActions),
        // No `deliveredLastCopyActionIds` filter here, and it would now be
        // actively wrong. Delivery deletes the entry for a TEXT-ONLY prompt,
        // in the same updater that adds the id to that set, so for those a
        // filter would be a second guard on the first one's result - and an
        // unreachable guard is worse than none: it attracts tests that then
        // pass for a reason other than their name. For an ANNOTATED prompt
        // the entry deliberately survives delivery, because the notice never
        // showed the sidecar, and filtering on the delivered set would skip
        // exactly the prompt this handoff exists to save. One mechanism,
        // stated where it lives: the map holds what still needs stashing.
        Object.values(state.lastCopyPrompts),
        retryHandoffAccountFor,
      )) {
        const captureId = uuidv4();
        // Root the bytes for the capture. Registered BEFORE the first await:
        // `dispose()` drops this store from `liveChatSessionStores`
        // synchronously, so from that instant until the read completes nothing
        // else names these hashes and a concurrent sweep is free to delete
        // them.
        handoffCaptureRoots.set(captureId, {
          content: source.content,
          browserAnnotations: source.browserAnnotations,
        });
        // Stamped before the first await, re-asked synchronously right before
        // the install. See `identityGeneration`: the synchronous flag cannot
        // fence a capture that was already in flight when the account changed,
        // and installing then would file the outgoing account's prompt in the
        // incoming account's Drafts list - and root its images in that
        // account's landing partition.
        const startedAtGeneration = identityGeneration;
        const stillCurrent = (): boolean =>
          identityGeneration === startedAtGeneration;
        // Released once the handoff's READS have settled, which is not the
        // same moment as its install. The image resolution is bounded but not
        // cancellable, so a deadline that fires leaves the original import
        // still reading blobs while the text-only fallback installs - and from
        // the instant `dispose()` dropped this store, these roots are the only
        // thing naming those hashes. `PromptHandoffOutcome.readsSettled` is
        // that second moment; on every other path it is already resolved.
        const releaseCaptureRoots = (): void => {
          handoffCaptureRoots.delete(captureId);
        };
        void buildUnrecordedPromptHandoff({
          content: source.content,
          browserAnnotations: source.browserAnnotations,
          reason: source.reason,
          stillCurrent,
          // The SAME resolver the composer's own draft images use. Passing an
          // empty image map instead - which this did - made every hash-only
          // handoff throw and vanish.
          readHashImage: (hash) =>
            resolveDraftImageBytes(
              hash,
              draftImageByteTargetForHost(options.hostId),
            ),
        })
          // SECOND chance, text-only. The handoff's own fallback covers a
          // document whose IMAGES it cannot resolve; this covers an install
          // that threw, which is a different failure at a later stage.
          //
          // `buildTextOnlyPromptHandoff` rather than a null resolver: an
          // INLINE image is read from the node before any resolver is
          // consulted, so the null-resolver version of this re-imported the
          // same oversized document and was refused all over again.
          .catch(() =>
            buildTextOnlyPromptHandoff({
              content: source.content,
              // Not carried - a landing draft owns no annotation sidecar - but
              // passed so the draft can SAY the sidecar was dropped rather
              // than looking like a complete capture.
              browserAnnotations: source.browserAnnotations,
              reason: source.reason,
              cause: "capacity",
              stillCurrent,
            }),
          )
          // The roots outlive the INSTALL, not just the call: see
          // `releaseCaptureRoots` above.
          .then((outcome) => outcome.readsSettled)
          // Swallowed to match this store's own fire-and-forget convention,
          // and because there is nothing left to fall back to: the session is
          // already torn down by the time this settles. A draft that cannot be
          // installed is one the user cannot read either, so the failure is
          // visible there.
          .catch(() => undefined)
          .finally(releaseCaptureRoots);
      }
    };

    /**
     * The account clauses for a prompt that never got one composed - an
     * in-flight retry, whose send was still alive when the chat closed.
     *
     * Built from the action's OWN frozen values, so a multi-folder staging
     * keeps every entry, its branch and its worktree ref. The first version
     * passed a single `workspacePath` to the handoff builder, which silently
     * dropped an import worktree's ref, its branch, and every folder after
     * the first.
     */
    const retryHandoffAccountFor = (action: PendingChatAction): string => {
      const state = get();
      return deadSendAccountClauses(
        {
          // The HOST-level set, not the per-slot partition. This was the one
          // account builder left reading `worktreePartition`, whose evidence
          // is dropped by every mutation that resolves a slot - so a retry's
          // handoff could still say a swept worktree is fine to re-pick while
          // every other statement about the same send said it was gone.
          worktree: sweepAccountForIntent(
            action.restoreWorktreeIntent,
            action.clientActionId,
          ),
          sentSettings: action.settings ?? state.currentComposerSettings,
          currentSettings: state.currentComposerSettings,
          sentAccountContext:
            action.accountContext ??
            useAccountContextStore.getState().accountContext,
          currentAccountContext:
            useAccountContextStore.getState().accountContext,
          sentDeliveryPolicy: action.deliveryPolicy ?? "auto",
        },
        false,
      );
    };

    /**
     * The worktree half of a recovery's account, from evidence that OUTLIVED
     * the staging store's own record of it. See `HashOnlyRecoveryState.sweptRefs`.
     */
    const recoverySweepAccount = (
      recovery: HashOnlyRecoveryState,
    ): WorktreeSweepAccount =>
      sweepAccountForIntent(recovery.worktreeIntent, recovery.clientActionId);

    /** One answer to "what has been swept from this staging", for every speaker. */
    /**
     * Deletion facts this consumer has OBSERVED about its own frozen intent,
     * keyed by the action that owns them, and never retracted.
     *
     * The host ledger is the observation feed; this is the per-consumer
     * projection of it. The distinction is the whole of R7F3: the ledger is
     * shared, so chat B staging a path clears a fact that was still owed to
     * chat A's already-dispatched retry - and staging does not even prove
     * recreation, since `stageEntry` is called verbatim by the workspace
     * selector's automatic remembered-default seeding. A fact, once owed to a
     * particular send, is that send's to keep.
     *
     * Bounded by the number of live consumers: entries are dropped when their
     * action settles.
     */
    const stickySweptByAction = new Map<string, RemovedWorktreeRefs>();

    /** Fold whatever the host ledger currently says about `intent` into the record. */
    const observeSweptForAction = (
      clientActionId: string,
      intent: WorktreeIntent | null,
    ): RemovedWorktreeRefs | null => {
      const held = stickySweptByAction.get(clientActionId) ?? null;
      if (intent === null) return held;
      const observed = sessionSweptRefsForHost(options.hostId);
      if (observed === null) return held;
      // Only the facts that bear on THIS intent, so one consumer's record does
      // not accumulate the whole host's history.
      const relevant = partitionIntentAgainstSweptRefs(intent, observed).swept;
      if (relevant === null) return held;
      const merged = mergeRemovedWorktreeRefs(held, {
        worktreePaths: new Set(
          relevant.entries.flatMap((entry) =>
            "worktreePath" in entry && typeof entry.worktreePath === "string"
              ? [entry.workspacePath, entry.worktreePath]
              : [entry.workspacePath],
          ),
        ),
        branches: observed.branches,
      });
      if (merged !== null) stickySweptByAction.set(clientActionId, merged);
      return merged;
    };

    const sweepAccountForIntent = (
      intent: WorktreeIntent | null,
      clientActionId: string,
    ): WorktreeSweepAccount => {
      if (intent === null) {
        return { survivors: null, swept: null, superseded: false };
      }
      // Asked of the SESSION ledger, live, at the moment the statement is
      // made. The earlier shape - a snapshot on the record, folded forward by
      // a staging-store subscription - lost the evidence in three ordinary
      // sequences, all of them the same root: `sweptRefsByKey` is recorded
      // only against a slot with a live dispatch mark and is dropped by every
      // mutation that resolves one. A sweep after the ack restored staging had
      // no mark to record against; a partial sweep's evidence went when the
      // survivors were restaged, before the snapshot was taken; and a retry
      // holding a captured record spoke from a copy a later sweep had already
      // replaced. `sessionSweptRefsByHost` is never cleared, so a frozen ref
      // can be asked about at any later time.
      const { survivors, swept } = partitionIntentAgainstSweptRefs(
        intent,
        observeSweptForAction(clientActionId, intent),
      );
      return { survivors, swept, superseded: false };
    };

    /**
     * Returns the prompts this pass could NOT put in the restoration slot -
     * the ones whose only remaining trace is a notice's text. A caller that is
     * tearing the store down must hand those off durably; see
     * {@link handOffUnrecordedPromptToStash}.
     */
    /**
     * Capture deletion facts for every live consumer, before anything can
     * clear them.
     *
     * Without this the record is only ever filled in when a consumer SPEAKS,
     * so a sweep followed by another chat staging that path - between the send
     * and the handoff - is observed by nobody and the fact is gone. The
     * subscription is cheap: it returns immediately when this session owns no
     * unrecorded prompt, which is almost always.
     */
    const observeSweptForLiveConsumers = (): void => {
      const state = get();
      for (const recovery of Object.values(state.hashOnlyRecoveries)) {
        observeSweptForAction(recovery.clientActionId, recovery.worktreeIntent);
      }
      for (const action of Object.values(state.pendingActions)) {
        if (!action.hashOnlyRetry) continue;
        observeSweptForAction(
          action.clientActionId,
          action.restoreWorktreeIntent,
        );
      }
    };
    const unsubscribeSweptObserver = useWorktreeIntentStagingStore.subscribe(
      observeSweptForLiveConsumers,
    );

    /**
     * Retire a settled action's sweep evidence.
     *
     * Cleanup used to happen solely on abandonment - the path a send takes
     * when it FAILS - so every send that simply succeeded left its evidence
     * behind for the session's life.
     *
     * The `rejected` exclusion is now LOAD-BEARING, and this comment used to
     * say the opposite. When it was written, a retry's second refusal stated
     * itself through `worktreePartition` and never touched this map, so no
     * sequence read an entry after a rejected ack deleted it. `rejectionSweepFor`
     * changed that: a `hashOnlyRetry` action's refusal now reads exactly this
     * map to build its terminal account. Retiring on a rejected ack would hand
     * that statement an empty ledger - the one fact the map exists to keep -
     * for the send most likely to need it.
     *
     * Its own retirement happens after that read instead, in
     * {@link retireConsumedRetryEvidence}.
     *
     * A named function rather than an inline branch because `onActionAck` sits
     * one step under this workspace's complexity ceiling, and an added `if`
     * there fails the build.
     */
    const retireSweptEvidenceOnAck = (frame: ChatActionAckFrame): void => {
      if (frame.status === "rejected") return;
      stickySweptByAction.delete(frame.clientActionId);
    };

    /**
     * The worktree account a rejection states.
     *
     * A hash-only RETRY's second refusal is its send's TERMINAL statement, and
     * it is the one rejection that must not re-derive from the live per-slot
     * partition. That partition answers "what is staged now", so once the user
     * has picked a newer worktree it reports the frozen one as fine - and both
     * the loud restoration and the stashed copy then tell them to re-pick a
     * directory that was deleted. The transferred sticky evidence is what this
     * send actually knows, carried across from its recovery at dispatch.
     *
     * Every other rejection keeps the live read: its pick is still the current
     * one, and the slot is the right place to ask.
     *
     * A named function rather than an inline ternary because `onActionAck`
     * sits at this workspace's complexity ceiling, where one more branch fails
     * the build.
     */
    const rejectionSweepFor = (
      pending: PendingChatAction | null,
    ): WorktreeSweepAccount => {
      if (pending?.hashOnlyRetry === true) {
        return sweepAccountForIntent(
          pending.restoreWorktreeIntent,
          pending.clientActionId,
        );
      }
      return worktreeSweepFor(
        pending?.restoreWorktreeIntent ?? null,
        worktreePartition,
        false,
      );
    };

    /**
     * Retire a retry's evidence once its SECOND refusal has consumed it.
     *
     * Called after the rejection updater has built its account, not before:
     * that statement is the last reader, and this entry is terminal from the
     * moment it is made. Without it the record survives to disposal, which is
     * the retention the ack cleanup exists to prevent - just on the one path
     * the ack cleanup deliberately skips.
     */
    const retireConsumedRetryEvidence = (
      pending: PendingChatAction | null,
    ): void => {
      if (pending === null || !pending.hashOnlyRetry) return;
      stickySweptByAction.delete(pending.clientActionId);
    };

    const abandonAllHashOnlyRecoveries = (reason: string): void => {
      for (const recovery of Object.values(get().hashOnlyRecoveries)) {
        abandonHashOnlyRecovery(recovery, reason);
      }
      // No return value any more. This used to hand the caller the prompts it
      // could not slot, so disposal could stash them - which covered only the
      // abandonments made DURING that disposal. A notice-only state that has
      // been sitting in the ring for an hour is precisely the one that reaches
      // the deferral cap, and it was invisible to that list. The notice site
      // now records into `lastCopyPrompts`, which the handoff reads, so the
      // two cases are the same case.
    };

    const abandonHashOnlyRecovery = (
      recovery: HashOnlyRecoveryState,
      reason: string,
    ): void => {
      // ONE account for all three outcomes, computed BEFORE the updater so the
      // caller can have the same sentence the notice got. The notice path
      // already rendered an account; the restoration path stored the host's
      // raw reason and rendered nothing, so a prompt handed back to the
      // composer arrived with no statement of the worktree it was written for
      // - and `displacedRestorationNotice`, which expects the clauses baked
      // in, later repeated that silence.
      const account: DeadSendAccount = {
        worktree: recoverySweepAccount(recovery),
        sentSettings: recovery.settings,
        currentSettings: get().currentComposerSettings,
        sentAccountContext: recovery.accountContext,
        currentAccountContext: useAccountContextStore.getState().accountContext,
        sentDeliveryPolicy: recovery.deliveryPolicy,
      };
      // The `handedBack` axis every other builder of this slot uses: `reason`
      // is read when the prompt IS back in the composer with its binding,
      // `displacedReason` when it never got there.
      const handedBackReason = `${reason}${deadSendAccountClauses(account, true)}`;
      const displacedReason = `${reason}${deadSendAccountClauses(account, false)}`;
      // Built once, so the notice and the prompt recorded beside it are two
      // views of the same send rather than two constructions of it.
      const lastCopy: UnrecoverableSend = {
        clientActionId: recovery.clientActionId,
        content: recovery.restore.content,
        browserAnnotations: recovery.restore.browserAnnotations,
        circumstance: reason.replace(/\.$/, ""),
        account,
      };
      set((state): Partial<ChatSessionState> => {
        // Idempotent: a second abandon for the same recovery (disposal racing
        // a refused dispatch) must not speak twice.
        if (!Object.hasOwn(state.hashOnlyRecoveries, recovery.clientActionId)) {
          return {};
        }
        const { [recovery.clientActionId]: _retired, ...remaining } =
          state.hashOnlyRecoveries;
        // The restoration slot holds ONE prompt, and another refusal may
        // already own it. The first version kept the incumbent with `??` and
        // dropped this recovery's record, queue row and echo - destroying the
        // last copy of a prompt because a different one got there first. It
        // said nothing, either.
        //
        // So the slot is taken only when free, and when it is not, this prompt
        // is still ACCOUNTED FOR: the notice carries its reason and says the
        // content was displaced, which is the same machinery an ordinary
        // rejection uses when it loses the slot race. Nothing is silently
        // discarded.
        const slotFree = state.failedSendRestoration === null;
        return {
          hashOnlyRecoveries: remaining,
          queue: removeOptimisticQueuedItemByClientActionId(
            state.queue,
            recovery.clientActionId,
          ),
          pendingUserMessages: state.pendingUserMessages.filter(
            (message) => message.clientActionId !== recovery.clientActionId,
          ),
          failedSendRestoration: slotFree
            ? {
                clientActionId: recovery.clientActionId,
                content: recovery.restore.content,
                browserAnnotations: recovery.restore.browserAnnotations,
                reason: handedBackReason,
                // Nothing has said this yet - the whole point of the silent
                // branch is that the first refusal made no noise, so the
                // hand-back is the first and only statement.
                stated: false,
                displacedReason,
              }
            : state.failedSendRestoration,
          errorNotices: slotFree
            ? state.errorNotices
            : appendErrorNotice(
                state.errorNotices,
                // The REAL last-copy machinery, not a sentence about it - and
                // `unrecoverableSendNotice` rather than
                // `displacedRestorationNotice`, which is the correction this
                // finding is about.
                //
                // Both quote the draft under `SEND_NOT_RECORDED`. The
                // difference is the ACCOUNT TAIL: `displacedRestorationNotice`
                // expects a reason whose worktree and settings clauses are
                // already baked in by whichever pass built the restoration
                // slot, and renders none of its own. Recovery has no such pass
                // - it passed the raw host reason - so the notice told the
                // user their prompt was lost without telling them its worktree
                // went with it. Following it would resend A against whatever
                // is staged now, which after a concurrent refusal is B's.
                //
                // `unrecoverableSendNotice` renders the account itself, from
                // the recovery's FROZEN intent, so the re-pick instruction
                // names the workspace this send actually had.
                unrecoverableSendNotice(lastCopy),
                state.deliveredNoticeActionIds,
              ),
          // The DOCUMENT behind that notice. Without it the notice is the only
          // custody and it holds the draft as rendered text, so a teardown an
          // hour later has nothing to hand the stash.
          lastCopyPrompts: slotFree
            ? state.lastCopyPrompts
            : {
                ...state.lastCopyPrompts,
                [recovery.clientActionId]: unrecoverableSendPrompt(lastCopy),
              },
        };
      });
      // The queue is one of the six budgeted slices, so every write to it owes
      // a re-settle. Recovery mutates it twice - here and at repaint - and
      // both were missing it, leaving the accountant holding a stale figure
      // for as long as the chat stayed quiet on the transcript.
      commitWholeSetSliceBudget();
      // This consumer has spoken; its facts are in the statement now. Bounds
      // the map to LIVE consumers rather than every send the session made.
      stickySweptByAction.delete(recovery.clientActionId);
      // A prompt that did NOT go back to the composer must not leave its
      // worktree binding attached to whatever is there now - the same rule
      // `stateFailedSendRestoration` follows for a displaced restoration, and
      // the same silent wrong-checkout submit if it is skipped. Scoped by the
      // revision this action left, so a newer pick is untouched.
      // Derived from COMMITTED state rather than a flag set inside the
      // updater: React may replay a functional updater, so nothing outside one
      // may depend on a value computed inside it.
      if (
        get().failedSendRestoration?.clientActionId !== recovery.clientActionId
      ) {
        releaseStagingRevisionFor(recovery.clientActionId);
      }
    };

    /**
     * The silent half of the hash-only refusal path: re-inline the refused
     * content and send it once more, carrying its bytes.
     *
     * Three things this deliberately does NOT do, each of which was a defect:
     *
     *  - It does not rebuild from `restore.content`. That document predates
     *    submission's annotation crop atoms and slash-command conversion, so a
     *    retry built from it delivered the prompt with the annotation
     *    screenshot silently gone. `wireContent` is what the host was given.
     *  - It does not call `sendMessage`. That reads the staged worktree pick
     *    and the account context from AMBIENT state at dispatch time, so a user
     *    who staged a new workspace during recovery had this older prompt
     *    consume it - the old message running in the new workspace, and the new
     *    pick gone. Every such value is frozen on the recovery record and
     *    passed explicitly here.
     *  - It does not retire the original's presentation until the retry is
     *    actually on the wire. `sendAction` can refuse (reconnecting, access
     *    lost), and until it has not, the recovery record is the only thing
     *    rooting these bytes against GC.
     *
     * Sent even when some digest resolved nowhere: a retry still carrying a
     * bare hash is refused again, and THAT rejection is loud because its record
     * is marked `hashOnlyRetry`. One statement either way, one implementation.
     */
    const runHashOnlyInlineRetry = async (
      recovery: HashOnlyRecoveryState,
    ): Promise<void> => {
      const { content } = await reinlineRefusedSendContent({
        content: recovery.wireContent,
        hostId: options.hostId,
      });
      if (disposed) {
        abandonHashOnlyRecovery(recovery, recovery.reason);
        return;
      }
      const clientActionId = uuidv4();
      const frame: ChatOwnerActionFrame = {
        kind: "send",
        hasBinaryPayload: false,
        epicId: options.epicId,
        chatId: options.chatId,
        clientActionId,
        // The ORIGINAL message id. A new action id is required - the host
        // replays the stored ack for a settled one, so a same-id resend is
        // answered with its own rejection and never re-executed - but the
        // transcript dedupes by message id, so reusing it is what keeps the
        // optimistic row from blinking out and back.
        messageId: recovery.messageId,
        content,
        sender: recovery.sender,
        settings: recovery.settings,
        // Frozen, not re-read: this is the same logical send, not a new user
        // action, and the ambient values have had a whole recovery to move.
        accountContext: recovery.accountContext,
        deliveryPolicy: recovery.deliveryPolicy,
        worktreeIntent: recovery.worktreeIntent,
        browserAnnotations: [...recovery.restore.browserAnnotations],
      };
      const sent = sendAction({
        set,
        get,
        frame,
        pending: {
          clientActionId,
          action: "send",
          queueItemId: null,
          checkpointId: null,
          revertArtifacts: null,
          interviewBlockId: null,
          interviewDeliveryRetry: null,
          messageId: recovery.messageId,
          restore: recovery.restore,
          sender: recovery.sender,
          settings: recovery.settings,
          accountContext: recovery.accountContext,
          // The digests THIS dispatch still sends bare, off the re-inlined
          // document rather than `wireContent` or `restore.content`.
          //
          // Not `null`: the docblock above says this retry goes out "even when
          // some digest resolved nowhere", so a recovery resend can and does
          // carry hash-only nodes, and the second refusal has to be able to
          // retract their acks.
          //
          // Not covered by the `restore`-keyed arm either, which is the reason
          // this is not redundant: that arm walks `restore.content`, the
          // PRE-SUBMISSION draft, while the retry is built from `wireContent`
          // - the submitted document, which carries annotation crop atoms the
          // draft never had. A crop digest sent bare here would be retracted by
          // nothing without this field.
          sentContentHashes: hashOnlyImageHashes(content),
          restoreWorktreeIntent: recovery.worktreeIntent,
          displayWorktreeIntent: recovery.worktreeIntent,
          messageConfirmedByHost: false,
          deliveryPolicy: recovery.deliveryPolicy,
          // The marker that makes this the LAST attempt: a second refusal of
          // this record surfaces instead of retrying again.
          hashOnlyRetry: true,
          wireContent: content,
          createdAt: Date.now(),
        },
        // Re-keyed to the NEW action id. Carrying the original echo through
        // unchanged registered it under the SETTLED id, which the cleanup
        // below then removed as a leftover - so the row vanished entirely,
        // the exact failure the message-id reuse exists to prevent.
        // `sendAction` dedupes by message id, so this REPLACES the old echo
        // in place rather than adding a second.
        pendingUserMessage:
          recovery.pendingUserMessage === null
            ? null
            : { ...recovery.pendingUserMessage, clientActionId },
      });
      if (sent === null) {
        abandonHashOnlyRecovery(recovery, recovery.reason);
        return;
      }
      // The sticky sweep evidence follows the send, not the id. A retry mints
      // a NEW `clientActionId`, so without this hand-across the record is
      // keyed to an action that no longer exists and the retry's own handoff
      // starts from nothing - which reads as "the worktree is still there"
      // for a directory this send already knows is gone. Same frozen intent,
      // same facts, new owner.
      const carriedEvidence = stickySweptByAction.get(recovery.clientActionId);
      if (carriedEvidence !== undefined) {
        stickySweptByAction.set(clientActionId, carriedEvidence);
        stickySweptByAction.delete(recovery.clientActionId);
      }
      // Only now. `sendAction` already deduped `pendingUserMessages` by message
      // id, so the echo was replaced rather than doubled; what is left is the
      // settled original's queue row and the recovery record itself, retired
      // in one step so nothing renders twice and nothing is unrooted in
      // between.
      // R6: the host's follow-up notice for the ORIGINAL refusal can arrive
      // after this dispatch (it appends and awaits a failure event first), so
      // retiring the recovery here would let that notice through and make a
      // successful retry loud. The id stays suppressed until the notice is
      // actually seen, or a bounded time elapses.
      suppressNoticeAfterDispatch(recovery.clientActionId);
      set((state) => ({
        hashOnlyRecoveries: withoutRecordKeyGeneric(
          state.hashOnlyRecoveries,
          recovery.clientActionId,
        ),
        // The settled action's row goes and the retry's takes its place, in
        // ONE step so the user never sees a gap. `sendAction` does not paint
        // this - `sendMessage` appends it separately - so without re-painting
        // here a queued send's row simply vanished on dispatch and did not
        // come back until the host's next queue snapshot. Only re-painted
        // when the original actually had one: the retry must reproduce what
        // that send did, not invent a row for a send that never had one.
        queue: repaintOptimisticQueueRowForRetry({
          queue: removeOptimisticQueuedItemByClientActionId(
            state.queue,
            recovery.clientActionId,
          ),
          recovery,
          clientActionId,
          content,
        }),
        // Only the SETTLED action's echo, which `sendAction`'s message-id
        // dedupe has normally already replaced. A safety net for the case
        // where it has not, and it cannot touch the retry's own row because
        // that one carries the new id.
        pendingUserMessages: state.pendingUserMessages.filter(
          (message) => message.clientActionId !== recovery.clientActionId,
        ),
      }));
      // The retry TAKES OVER the pick, rather than merely releasing the
      // original's bookkeeping.
      //
      // Releasing alone (the first version) left the re-staged pick with no
      // dispatch owner at all: the retry carried it on the wire, but
      // `stagedWorktreeIntentAwaitsDispatchFrom(key, retryId)` answered false,
      // so if the retry was ALSO refused the loud hand-back returned the text
      // without the worktree. For a queued send that is the whole exposure -
      // the host defers materialization to dequeue, so neither attempt ever
      // applied the pick, and the user's next Enter would run the restored
      // prompt against the chat's previous binding with no sign anything was
      // dropped.
      //
      // Order matters: release the ORIGINAL's revision entry first (scoped, so
      // a newer user pick is untouched), then consume under the retry's id so
      // the mark names the action that is actually in flight.
      // Transfer dispatch ownership to the retry, but ONLY while the slot
      // still holds the pick this recovery re-staged.
      //
      // `consumeForDispatch` is unconditional - it takes whatever is standing
      // there - so calling it blind consumed a pick the USER staged during the
      // recovery, for their next prompt. That is the exact overwrite this
      // finding warned against, and two existing tests caught it immediately.
      //
      // The recorded revision is the evidence, the same evidence
      // `releaseStagingRevisionFor` scopes its release by: if anything has
      // touched the slot since the re-stage, the newer pick is not ours, the
      // retry does not own it, and a second refusal correctly declines to hand
      // it back. Read BEFORE the release, which clears the entry.
      const ownedRevision = stagingRevisionByRestoredAction.get(
        recovery.clientActionId,
      );
      const slotUntouched =
        ownedRevision !== undefined &&
        (useWorktreeIntentStagingStore.getState().revisionByKey[
          worktreeStagingKeyString(ownerStagingKey)
        ] ?? 0) === ownedRevision;
      releaseStagingRevisionFor(recovery.clientActionId);
      if (slotUntouched) {
        // Marks the slot dispatched BY this action id - the evidence
        // `stagedWorktreeIntentAwaitsDispatchFrom` reads when deciding whether
        // a rejection of the RETRY may hand the pick back with the prompt.
        // Without it the retry carried the pick on the wire but owned nothing,
        // so a second refusal returned the text and silently dropped the
        // worktree.
        useWorktreeIntentStagingStore
          .getState()
          .consumeForDispatch(ownerStagingKey, clientActionId);
      }
      // The queue slice moved here too.
      commitWholeSetSliceBudget();
    };

    /**
     * Take over a `MISSING_ATTACHMENT_BYTES` rejection this client can quietly
     * fix, and answer whether it did.
     *
     * A named function rather than an inline branch because `onActionAck` is
     * already at this workspace's complexity ceiling, and because "did the
     * silent path claim this ack" is exactly the kind of question a caller
     * should be able to read in one line.
     *
     * Placed by its CALLER after the worktree re-stage and before every
     * surface - see the call site for why both halves of that position matter.
     */
    const beginHashOnlyRecovery = (
      frame: ChatActionAckFrame,
      rejectedPending: PendingChatAction,
    ): boolean => {
      const retry = hashOnlyRetryForRejection(
        frame,
        rejectedPending,
        options.hostId,
      );
      if (retry === null) return false;
      // No first-writer-wins any more: the map gives every refusal its own
      // custody, so two hash-only sends refused close together BOTH recover.
      // The old single slot forced a choice between clobbering the first and
      // pushing the second onto the loud path, where it then took the
      // restoration slot and left the first with nowhere to hand back to.
      // Re-entry for the SAME action is still refused - that would be a second
      // recovery of one send.
      if (Object.hasOwn(get().hashOnlyRecoveries, frame.clientActionId)) {
        return false;
      }
      // Carried so the retry can re-register the same echo under its new
      // action id. A QUEUED send has none - which is exactly why the recovery
      // record has to exist at all, since for those it is the only trace of
      // the send while recovery runs.
      const echo =
        get().pendingUserMessages.find(
          (message) => message.clientActionId === frame.clientActionId,
        ) ?? null;
      const recovery: HashOnlyRecoveryState = {
        ...retry,
        pendingUserMessage: echo,
        hadOptimisticQueueRow: get().queue.items.some(
          (item) =>
            item.queueItemId === optimisticQueuedItemId(frame.clientActionId),
        ),
      };
      // The settled ACTION goes - the host has answered it, and leaving it in
      // `pendingActions` would have it pretending to be a wire request a
      // reconcile could hand back. Everything that PRESENTS the send stays:
      // the optimistic queue row, and the transcript echo if it has one. The
      // recovery record takes over custody of both, so the send is
      // continuously rooted, continuously visible and continuously restorable
      // for the whole of the await that follows. Nothing is retired until the
      // retry is actually on the wire.
      set((state) => ({
        pendingActions: withoutPendingAction(
          state.pendingActions,
          frame.clientActionId,
        ),
        hashOnlyRecoveries: {
          ...state.hashOnlyRecoveries,
          [frame.clientActionId]: recovery,
        },
      }));
      // SYNCHRONOUSLY, before anything can run. The subscription only watches
      // consumers that already exist, so a deletion fact sitting in the host
      // ledger at this moment belongs to this recovery and nothing will tell
      // it: the next stage from another chat clears the ledger and the
      // subscription's first callback finds nothing to capture. Observing
      // here is what makes the sticky record an actual record of what was
      // true when this send's custody began.
      observeSweptForAction(frame.clientActionId, recovery.worktreeIntent);
      void runHashOnlyInlineRetry(recovery);
      return true;
    };

    /**
     * The blob-ack retractions this ack owes, and the one record its updater
     * still needs afterwards.
     *
     * The arms and why they divide are enumerated on
     * {@link forgetRefusedContentBlobAcks}; they are gathered here because they
     * are one class, and because `onActionAck` is at this workspace's
     * complexity ceiling with them inlined.
     *
     * RETURNING the cancel restoration rather than letting the caller re-read
     * it is the load-bearing part. It has to be read BEFORE the `set` that
     * clears the entry, and a second read is a second chance to get that order
     * wrong - which is not hypothetical here, since the whole reason this
     * record exists is that the accepted cancellation destroys the row it
     * describes.
     *
     * Called AFTER `beginHashOnlyRecovery` has declined, never before: see the
     * ordering docblock on the handler for why nothing here may run on an ack
     * the silent recovery took over.
     */
    const retractRefusedBlobAcksForAck = (
      frame: ChatActionAckFrame,
      rejectedPending: PendingChatAction | null,
    ): PendingCancelRestoration | null => {
      // THE arm a `MISSING_ATTACHMENT_BYTES` refusal actually reaches.
      if (rejectedPending !== null && rejectedPending.restore !== null) {
        forgetRefusedContentBlobAcks(
          options.hostId,
          rejectedPending.restore.content,
        );
      }
      // The same retraction for an action that carried content but hands back
      // no prompt - today, edit-and-resend. `restore` is null there by design
      // (an edit re-opens its own editor), so the branch above cannot see it,
      // and gating the memo on `restore` is what left every refused edit
      // believing this host still held its bytes: the next Edit skipped the
      // upload at `confirmAttachmentsByHash` and was refused identically, with
      // no way out but reloading the window.
      if (
        rejectedPending !== null &&
        rejectedPending.sentContentHashes !== null
      ) {
        invalidateDraftBlobConfirmations(
          options.hostId,
          rejectedPending.sentContentHashes,
        );
      }
      // Arm 4 of the same class: an ACCEPTED cancel of a setup-failed row hands
      // its prompt back, so the resend must re-upload its bytes for the same
      // reason a refused send must.
      const cancelRestoration =
        frame.status === "accepted"
          ? (get().pendingCancelRestorations[frame.clientActionId] ?? null)
          : null;
      if (cancelRestoration !== null) {
        forgetRefusedContentBlobAcks(
          options.hostId,
          cancelRestoration.restore.content,
        );
      }
      return cancelRestoration;
    };

    const callbacks: ChatStreamCallbacks = {
      onSnapshot: (frame) => {
        // The adapter emits synchronously. Keeping the callback itself free of
        // projection writes is the proof that the legacy arm is behind the
        // runtime seam rather than a parallel store mutation path.
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
        // Whole set, same as the command list above: a hold clearing is the
        // ABSENCE of a row, so a delta shape would need a removal frame the
        // host has no reason to send.
        set({ heldUpdates: frame.heldUpdates });
        advanceDeferredSnapshotAux(() => ({ heldUpdates: frame.heldUpdates }));
      },
      onPortForwardsChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // Whole set, same as the two above: a stopped forward is the ABSENCE
        // of a row, so there is no removal frame to lose.
        set({ portForwards: frame.portForwards });
        advanceDeferredSnapshotAux(() => ({
          portForwards: frame.portForwards,
        }));
      },
      // ─── The windowed line (`chat.subscribe@1.8`) ────────────────────────
      //
      // Live: `chatSubscribeV18` is registered, so two `1.8`-capable peers
      // negotiate onto this handler. Against an older peer negotiation still
      // settles on that peer's minor and the legacy handlers above serve the
      // session instead.
      onWindowedSnapshot: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        windowedLine = true;
        // NEITHER the dedup slot nor the ledger is cleared here, and both
        // decisions are deferred to below for the same reason. A snapshot is
        // not only a reconnection on this line: an aux-only rebroadcast (a
        // queue change, an approval) arrives through this same handler at the
        // SAME epoch and preserves every span, and treating one as a
        // connection reset makes a large `loadRange` answer still travelling on
        // the BULK lane arrive untracked and be rejected as stale. Repeated aux
        // snapshots could therefore discard every slow response in turn and
        // leave the visible gap unhydrated indefinitely.
        const epochBeforeSnapshot = get().transcriptWindow.epoch;
        // The resnapshot entry deliberately does NOT close here. The answer
        // that obligation is waiting for is authority movement - a rebuild
        // announcement, a rebase, or a void - and the boundary block after
        // the fold closes it there. An aux-only rebroadcast through this same
        // handler is not that answer, and closing per aux frame would re-send
        // one resnapshot per approval or queue change while the real answer
        // is still streaming.
        //
        // Before the fold, exactly as the legacy path flushes: a queued delta
        // applied after an authoritative snapshot would re-add a block the
        // snapshot already carries.
        flushBlockDeltas();
        // Budgeted here as well as in `onRange`, because seating a tail is the
        // OTHER way this window grows: `insertSpan` has exactly two callers
        // (`applyWindowedSnapshot` and `applyRangeResponse`) and leaving one
        // unbudgeted means a reader who hydrated scrollback and then stopped
        // asking for ranges accumulates every completed turn's tail without
        // the budget ever running.
        const windowBeforeSnapshot = get().transcriptWindow;
        const seated = applyWindowedSnapshot(
          windowBeforeSnapshot,
          {
            epoch: frame.snapshot.transcriptEpoch,
            rowCount: frame.snapshot.rowCount,
            indexRevision: frame.snapshot.indexRevision,
            tail: frame.snapshot.tail,
          },
          // The STORE's active turn, not the frame's: the held-copy
          // preference is about the client's current delta-rewrite state,
          // and a completion snapshot whose frame already settled the turn
          // must still not displace a fresher held copy while the store is
          // mid-handoff.
          get().activeTurn?.turnId ?? null,
          imageWitnesses,
        );
        // The fold returns its input BY IDENTITY when it refuses the frame (a
        // stale-epoch snapshot with a concrete revision, a same-epoch
        // straggler), and every acceptance mints a new window - so identity IS
        // the acceptance fact, read before the evict below can obscure it.
        const snapshotAccepted = seated !== windowBeforeSnapshot;
        const window = evictTranscriptWindowToBudget(
          seated,
          TRANSCRIPT_WINDOW_MAX_BYTES,
          visibleTranscriptRange,
          // The FRAME's pair, not the store's: this runs before the snapshot's
          // judgement and pending list are published, and protecting the rows
          // the PREVIOUS snapshot was blocked on would protect the wrong ones
          // for exactly the beat that matters.
          pendingInterviewOrdinals(
            frame.snapshot.derived.interviewAnswerability,
            frame.snapshot.pendingInterviews,
          ),
        );
        // NOW the boundary decision, with the applied window in hand - the
        // fold runs FIRST, deliberately, so everything below reads post-fold
        // authority.
        //
        // Three cases and only three, the same three the dedup slot has
        // always released on: a rebuild announcement (`indexRevision: null` -
        // a reconnect mints a fresh subscriber whose index state is `none`,
        // and its request really did die with the previous connection), a
        // REBASE (the epoch moved, so every outstanding ordinal denotes a row
        // in a space this client has left), and a VOIDED index (this snapshot
        // proved the held index unusable). An aux-only rebroadcast is none of
        // them and releases nothing: aux frames arrive per approval and queue
        // change while preserving every span, and treating one as a boundary
        // would let a steady drip discard every slow `loadRange` answer in
        // turn - the starvation the old same-epoch protection existed for.
        //
        // At a boundary the ledger SUBSUMES rather than merely clears. Every
        // open range entry is replaced at once - a pre-boundary-framed answer
        // must never seat, because the host slices at answer time and a
        // pre-boundary answer is indistinguishable from a post-boundary slice
        // of current state - and a rebuild announcement opens the
        // skeleton-completion entry that carries the subsumed obligations to
        // a guaranteed-within-budget close, after which the planner (which is
        // never gated on the open entry) re-derives every remaining gap from
        // the fresh skeleton. The lineage evidence the image tiebreak reads
        // is invalidated on the same edge and is safe for the same reason:
        // nothing framed before the boundary can seat after it.
        const rebased = window.epoch !== epochBeforeSnapshot;
        // Gated on the fold ACCEPTING the frame, not only on what the frame
        // claims: a refused straggler leaves the window unchanged, and if
        // that window was already invalidated (a void awaiting its rebuild),
        // an ungated boundary would fire on a frame that moved nothing -
        // dropping the open resnapshot entry in exactly the invalidated
        // stretch its dedup protects, and wiping lineage evidence for
        // comparisons still in the air.
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
          // The marks go with the entries they date: the boundary subsumes
          // every open range, so no answer will retire them individually.
          hydrationRequestMarks.clear();
          // And so does the obligation they carried, budget included. An
          // authoritative snapshot re-seats the turn's body from the host,
          // which IS the repair the catch-up was asking for - carrying the
          // obligation across would retire the row the boundary just made
          // current, and carrying an exhausted budget across would deny the
          // next episode the rounds it is entitled to.
          forgetCatchUpBudget();
          imageWitnesses.invalidateAll();
        }
        if (window.skeletonComplete) {
          recovery.skeletonCompleted(window.epoch);
        }
        // The rebuild boundary for the summary generation tracker. `null` is
        // the host saying it holds no index for THIS subscriber and is about
        // to rebuild one (see `applyWindowedSnapshot`'s own doc) - and the
        // summary chunks are emitted only during that rebuild, so a `null`
        // revision is exactly "a re-stream is coming, from a counter that may
        // have restarted". Resetting to `-1` makes whatever generation that
        // re-stream carries - including the host's first, `1` - a change.
        //
        // Keyed on the revision and NOT on "a snapshot arrived": an aux-only
        // re-broadcast comes through this same handler at a live revision and
        // sends no chunks at all, so resetting there would make the next chunk
        // of the CURRENT stream look foreign and fire `requestSummaryRestream`
        // - a restream livelock under any steady aux traffic. Same reasoning
        // as the summaries themselves, below.
        if (frame.snapshot.indexRevision === null) {
          accumulatedSummaryGeneration = -1;
          assemblingSummaries = null;
          recovery.resetSummaryStream();
          // The retained array is now the PREVIOUS generation's, so it vouches
          // for nothing until a replacement chunk lands - including when its
          // length already equals the authoritative count.
          set(summaryTrustState());
        }
        // The window and the snapshot's aux ride the fold's own `set` (or the
        // deferral's single `set`) rather than being published here first - a
        // beat of "new spans, old rendered models" reads to the row merge as
        // renderer suppression of a real row.
        applyOrDeferWindowedSnapshot(frame, window, {
          transcriptWindow: window,
          transcriptDerived: frame.snapshot.derived,
          accumulatedFileChangeCount: frame.snapshot.accumulatedFileChangeCount,
          // A rebase replaces the coordinate space, so a pending "this row was
          // rewritten while cold" note is about rows that no longer exist under
          // these ordinals. The announcements hook drops its own consumption
          // record on the same edge.
          ...(rebased
            ? { coldRewrittenMessageIds: EMPTY_COLD_REWRITTEN_IDS }
            : {}),
          // Deliberately NOT resetting `accumulatedFileChangeSummaries` here.
          //
          // A re-stream already resets it: the host chunks the whole set from
          // `fromIndex: 0`, and the splice below turns that first chunk into
          // `slice(0, 0) + summaries`, so the assembled list ends at exactly
          // the new total and no entry of a previous set can outlive it.
          //
          // And a snapshot is NOT proof that a re-stream is coming. The host
          // re-streams the summaries whenever they CHANGED - the reconcile runs
          // ahead of every index branch, so a turn that replaces them while
          // leaving every ordinal intact still delivers them - but it compares
          // what this subscriber was last sent by identity, so an UNCHANGED set
          // is never re-sent. An aux-only re-broadcast - a queue change, an
          // approval - therefore carries no chunks at all, and clearing here
          // would empty the panel on the next approval and leave it empty, with
          // the header still counting the files it can no longer list.
        });
        commitChatWindowBudget(window);
        // An aux-only re-broadcast - a queue change, an approval - clears the
        // resnapshot latch and `invalidated` while sending no chunks at all
        // (see the comment just above). If the re-stream this client asked for
        // was itself dropped, nothing else would ever ask again: the partial
        // index would simply read as valid. `true` because the apply above may
        // have DEFERRED, so completeness cannot be read here yet.
        armStreamCompletionWatchdog({
          readCompleteness: false,
          // A rebuild is a fresh stream starting, so it restarts the clock; an
          // aux-only re-broadcast carries no chunk and must not. Same
          // `indexRevision === null` discriminator the summary-generation reset
          // above and the window's own skeleton-coverage reset read.
          //
          // OR a rebase, which is not the same condition and is easy to miss: a
          // reindex can move the epoch while the host still HOLDS this
          // subscriber's index, so the revision is a real number. A timer left
          // running from the previous epoch is inert - its fire-time check
          // returns on the epoch mismatch - so preserving it there would leave
          // the new coordinate space with no watchdog at all.
          restartDeadline: frame.snapshot.indexRevision === null || rebased,
        });
        requestPlannedHydration();
      },
      onSkeletonChunk: (frame) => {
        // `!windowedLine` covers the downgrade reset in `onSnapshot` above: a
        // windowed frame straggling in after a legacy snapshot has replaced
        // the transcript must not rebuild windowed state - or worse, republish
        // `messages` from the emptied window over the legacy transcript.
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
        // Re-arms while the skeleton is still short, disarms once it covers
        // `rowCount`. A stream that simply stops after a non-final chunk is
        // otherwise indistinguishable from one still in progress.
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
        // The streaming turn's own index echo supersedes nothing: the deltas
        // that produced it have already rewritten the held records, so an
        // answer in flight for that turn's rows is not stale. Discarding it
        // anyway is a starvation loop on a chat dominated by one long turn -
        // every answer arrives after the next echo and hydration never lands.
        //
        // The exemption is NOT gated on the client holding a copy of the
        // turn, and it used to be. That gate read as the conservative half of
        // the choice and was the loop's own trigger: the state in which the
        // window holds no copy - the live record retired by a seated span,
        // that span then dropped or its answer discarded - is precisely the
        // state every later echo then re-created. Each echo superseded the
        // request in flight for the row, the discarded answer re-planned a
        // new one, and the next echo (one per approval on a tool-heavy turn,
        // sixty-odd on the turn that surfaced this) caught that one too. The
        // row stayed a placeholder for the life of the turn and, with nothing
        // backing it, the turn's live copy was not drawn either - only the
        // status chip. The completion rebase was the first thing that seated
        // it.
        //
        // What the gate was protecting is real and is handled differently: a
        // copy the window does not hold is not being rewritten - its deltas
        // are dropped - so an answer sliced before those deltas seats a body
        // that trails the host, and a hydrated row is never re-asked for. So
        // the seat is allowed, and the row is marked UNSOUND instead
        // (`catchUpBudget`, read in `onRange`): the client's copy is not what
        // the host would serve, and stays so until an answer provably closes
        // the gap. That puts a trailing body on screen for a round trip rather
        // than no body for the whole turn.
        //
        // The holds scan is gated on there being an outstanding request at
        // all, so it never runs on the bare per-token path.
        const streamingEcho = isActiveTurnStreamingEcho(
          frame.changes,
          activeTurnId,
        );
        const echoWhileUnheld =
          streamingEcho &&
          recovery.hasOpenRanges() &&
          !holdsActiveTurnAssistantMessage(
            get().transcriptWindow,
            activeTurnId,
          );
        // Folded FIRST, but not published yet - the two orderings this has to
        // satisfy pull in opposite directions and this is what satisfies both.
        //
        // `supersedeInFlightHydration` must read the PRE-fold window, because
        // it compares against the epoch each in-flight request was framed
        // against and the fold can move it. But it must not run for a frame
        // the window REJECTS: `applyIndexChange` drops a duplicated or
        // reordered same-epoch frame on `indexRevision <= window.indexRevision`
        // and changes nothing, while the supersede has already marked a valid
        // in-flight request - so its answer is discarded and re-asked for a
        // frame that moved nothing, extending the placeholders it was going to
        // fill. Repeated stragglers can keep a range from ever settling.
        //
        // Computing the fold without `set` gives both: `get()` still returns
        // the pre-fold window below, and identity tells us whether the frame
        // was accepted. Deliberately NOT a second copy of the acceptance rule -
        // the epoch, revision and rebuild-suspension checks are intricate
        // enough that a mirror of them here would drift.
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
        if (streamingEcho && window !== beforeFold && activeTurnId !== null) {
          // Same acceptance gate as the supersede: a frame the window rejected
          // reports no write. An accepted one reports a write the host made,
          // and every write moves the mark whether or not this client had a
          // body to put it in - that is what lets a request's own mark decide
          // whether its answer could have contained it.
          activeTurnWriteMark += 1;
          if (echoWhileUnheld) {
            // And this write had nowhere to land, so the copy the client ends
            // up with is torn around it. What the echo NAMED is deliberately
            // not recorded - the write staled the turn's records, which every
            // row of that turn shares, so an obligation keyed on the echoed
            // ordinal misses the sibling rows carrying the same stale copy.
            catchUpBudget = {
              turnId: activeTurnId,
              unsound: true,
              rounds: budgetForTurn(activeTurnId).rounds,
            };
          }
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
        // Retired here rather than beside the seat, so an answer that never
        // reaches the seat - stale, or refused by the fold - does not leave its
        // mark behind for a request id that will never be answered again.
        const sentUnderMark = takeHydrationRequestMark(frame.range.requestId);
        // This request is answered: it can neither be superseded nor seat
        // anything again, whichever way the staleness check just went.
        recovery.closeRange(frame.range.requestId);
        // Clear the slot ONLY for the request this response actually answers.
        //
        // Clearing it unconditionally forgets a replacement that is still on
        // the wire, and the re-plan below then re-issues it under a new id -
        // whose own answer arrives to find the slot mismatched again. Every
        // answer discarded, every discard minting exactly one more request:
        // a self-sustaining loop in which the visible gap never hydrates.
        //
        // Reached by ordinary scrolling: replanning while a request is
        // outstanding replaces the slot, so the first answer back is already
        // one this store has moved on from.
        if (tracked !== null && tracked.requestId === frame.range.requestId) {
          clearInFlightHydration();
        }
        if (stale) {
          appLogger.warn("[transcript] discarded a range answer as stale", {
            ...rangeAnswerLogFields(frame.range),
            // Whether the dedup slot still named this request. `false` is the
            // late-answer shape (the timeout re-asked, or a re-plan replaced
            // it); `true` is an answer superseded by an index change while it
            // was the one being waited for.
            awaited: tracked?.requestId === frame.range.requestId,
          });
          // Seat nothing. The ordinals stay unhydrated, so the re-plan below
          // asks for them again - which is the whole point: a discarded
          // response costs a round trip, a seated stale one costs a row that
          // never corrects itself.
          requestPlannedHydration();
          return;
        }
        const window = evictTranscriptWindowToBudget(
          seatRangeAnswer(frame.range, sentUnderMark),
          TRANSCRIPT_WINDOW_MAX_BYTES,
          // What the reader is looking at is never evicted - see the
          // function's own doc for the oversized-row re-fetch loop this
          // forecloses.
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
          // The tail this response was asked for may have arrived. The fold
          // publishes `messages`/`events` itself - with the window riding the
          // same `set` - so it replaces the steady-state publish above.
          applyOrDeferWindowedSnapshot(deferred, window, {
            transcriptWindow: window,
            ...hydrated,
          });
          // Whatever arrived while the snapshot was held. Only once it is
          // actually seated - `applyOrDeferWindowedSnapshot` can defer AGAIN if
          // this response was not the tail it was waiting for, and flushing
          // then would fold the deltas into the same empty state the hold
          // exists to keep them out of.
          if (deferredWindowedSnapshot === null) flushBlockDeltas();
          commitChatWindowBudget(window);
        }
        requestPlannedHydration();
      },
      onAccumulatedChanges: (frame) => {
        // Same downgrade guard as `onSkeletonChunk`, and it is not symmetry
        // for its own sake: `onSnapshot` clears the summaries when it falls
        // back to the legacy line, where `accumulatedFileChanges` is the
        // authoritative set - and nothing clears them a second time. A
        // straggling chunk repopulating them here leaves the panel serving
        // rows from an abandoned windowed epoch for the life of the session.
        if (
          disposed ||
          !windowedLine ||
          !matchesChat(options, frame.epicId, frame.chatId)
        ) {
          return;
        }
        // The summaries are the ONE windowed stream whose chunks do not pass
        // through a function that holds the epoch - `applySkeletonChunk` and
        // `applyRangeResponse` both open with this comparison, and both can
        // because they fold into the window. These land in a store field of
        // their own, so the check has to be made here or not at all.
        //
        // Dropped on any mismatch, exactly as those two do. A resnapshot or
        // reindex advances the epoch while a chunk is still in flight, and a
        // stale one beginning at index 0 would otherwise REPLACE the current
        // set: the splice below treats `fromIndex: 0` as "a fresh set starts
        // here", so an abandoned epoch's paths and digests become the panel's,
        // and if its length happens to match the new count the completeness
        // check reads them as the whole story.
        //
        // Dropped without asking for a re-stream, deliberately. The chunk
        // carries no evidence that the CURRENT epoch is short - the host
        // re-emits these only when the summary set itself changed, so a stale
        // chunk arriving at a client that is already complete would buy a
        // whole-transcript resnapshot for nothing. Whether anything is
        // actually missing is what the completion watchdog reads off the
        // totals, and it is the one place that question is answerable.
        if (frame.chunk.epoch !== get().transcriptWindow.epoch) return;
        // Every same-epoch chunk is an OBSERVATION of its generation's
        // assembly, recorded on the ledger before anything is judged: a new
        // generation's entry replaces the previous one (whatever its state -
        // a dropped final chunk for gen N cannot hold the seated flag hostage
        // once gen N+1 is observed), and a chunk of the current generation
        // re-opens a closed entry, which is what "a non-final chunk actively
        // un-seats" means now. The restream entry, if one was open, is
        // consumed: the stream it asked for is arriving.
        recovery.observeSummaryChunk(frame.chunk.generation);
        // Chunks are contiguous and in order from `fromIndex`, so a chunk
        // starting at 0 begins a fresh set and any other extends the one being
        // assembled. Splicing at `fromIndex` rather than appending makes a
        // re-sent chunk idempotent instead of duplicating its entries.
        // Which re-stream this client is assembling. A chunk from a LATER
        // generation than the one in hand is only seatable at index 0, which is
        // where every generation starts; anything else means its predecessors -
        // including that index-0 chunk - were dropped.
        //
        // This is the case the gap check below cannot see. The client retains
        // the previous generation's array until a replacement at index 0
        // arrives, so when a file changes without changing the COUNT that array
        // is still at the authoritative length: a later chunk's `fromIndex` is
        // not greater than it, and it splices cleanly into the wrong
        // generation. The result is a prefix of the old set with a suffix of
        // the new one, whose stale digests make every content fetch return
        // `stale`, and both the gap check and the count watchdog read it as
        // healthy.
        if (frame.chunk.generation !== accumulatedSummaryGeneration) {
          if (frame.chunk.fromIndex !== 0) {
            // The chunk itself cannot seat - its predecessors were dropped -
            // but the generation WAS observed above, so the trust flags
            // already read the replacement stream as running. Publishing that
            // is the fix for the previous shape, which returned here leaving
            // `accumulatedSummaryGenerationSeated` vouching for the previous
            // generation while its replacement was known to be in flight.
            set(summaryTrustState());
            requestSummaryRestream();
            return;
          }
          accumulatedSummaryGeneration = frame.chunk.generation;
          // A fresh generation assembles OFF-SCREEN. Publishing its first
          // chunk immediately repainted the panel with a partial replacement
          // - "2 files changed" flashing mid-restream over a 6-file set - so
          // the previous complete set stays published until the replacement
          // reaches the authoritative count. The seated flag goes false so
          // the completion watchdog measures the ASSEMBLY, not the retained
          // array whose length may coincide with the count.
          assemblingSummaries = [];
          set(summaryTrustState());
        }
        // A chunk starting PAST the end is a chunk whose predecessor was
        // dropped. `slice(0, fromIndex)` cannot express that - on a shorter
        // array it silently returns the whole thing and appends, so every
        // entry from here on sits at an index below the one the host gave
        // it, and the panel's rows are then attributed to the wrong files.
        //
        // Dropped rather than seated at the wrong offset - but dropping
        // alone is not a recovery. The host re-streams these chunks when the
        // summaries CHANGE, and it records the set it just sent: a chunk lost
        // in transit leaves the host believing this subscriber holds that
        // generation, so ordinary traffic over an unchanged set sends nothing
        // and the panel stays short - "Review all" held back - for the rest
        // of the connection. A resnapshot is what restarts the stream, and it
        // is the same recovery a void index uses.
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
        // Published only once whole. Until then the previous set keeps the
        // panel honest, and the watchdog - armed below off the un-seated
        // flag - is what recovers a replacement stream that stops short.
        //
        // Whole means the host SAID so, not that the length agrees.
        // `isFinal` is the chunk contract's own statement that the generation
        // is complete; `accumulatedFileChangeCount` is an aux field, and aux
        // is last-write-wins, so a delayed same-epoch snapshot restores an
        // older, smaller count for a frame. Only one of those two can answer
        // the question.
        //
        // Requiring the count to AGREE as well was the same defect this whole
        // change exists to remove, one field over: the client holds the
        // complete generation the host declared final, and a transient aux
        // value made it discard that and keep rendering the previous set,
        // with no route back. A count that disagrees with a FINAL assembly is
        // evidence the count is stale, and `chunkedDeliveryIncomplete` already
        // reads that disagreement as a reason to keep the watchdog armed until
        // a snapshot corrects it - recovery, rather than a refusal to publish.
        //
        // A non-final chunk actively un-seats, so a generation can never stay
        // seated across one, and a prefix whose length coincides with the
        // count is no longer seatable on that coincidence.
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
        // The gap check above only fires when a LATER chunk exposes the hole,
        // so it cannot see the stream simply stopping. Armed after the `set`
        // so the watchdog reads the assembled length this chunk produced.
        armStreamCompletionWatchdog({
          readCompleteness: true,
          restartDeadline: true,
        });
      },
      /**
       * TWO BLOB-ACK RETRACTIONS LIVE IN THIS HANDLER, AND THEY DO NOT
       * DOUBLE-FIRE. The order is the whole of the argument, so it is written
       * down rather than left to be re-derived. Both reach the same primitive
       * (`invalidateDraftBlobConfirmations`) and differ only in WHICH digests
       * they name, so "they call different functions" is not what separates
       * them and never was.
       *
       * 1. `beginHashOnlyRecovery` goes FIRST on a `MISSING_ATTACHMENT_BYTES`
       *    rejection, and when it takes the ack over it RETURNS out of this
       *    handler entirely. Its retraction is
       *    `invalidateDraftBlobConfirmations(hostId, decision.hashes)` - scoped
       *    to exactly the digests the host refused, because it is about to
       *    re-inline those and must not have the send gate trust the memo that
       *    just proved wrong. Nothing below runs for that ack.
       * 2. {@link retractRefusedBlobAcksForAck} is the FALLBACK, on the path
       *    where the silent recovery declined: a cause of `unsupported-format`
       *    or `too-large`, a retry already spent, an action that cannot send
       *    bare, or a code that is not `MISSING_ATTACHMENT_BYTES` at all. Those
       *    refusals surface, the content goes back to the user, and its acks
       *    are dropped wholesale - a wider retraction than (1) deliberately,
       *    because nothing is being re-sent here and an over-forget costs one
       *    re-upload.
       *
       * So the two are mutually exclusive by CONTROL FLOW, not by a predicate
       * either of them evaluates - which is why inserting anything between the
       * recovery fork and that call, or removing its `return`, would make them
       * both run on the same ack. The extraction moved the arms out of this
       * function but deliberately NOT out of that order: the call sits exactly
       * where the arms did.
       *
       * The cancel arm is outside that alternation on a third axis: it reads
       * `pendingCancelRestorations` and fires only on `status: "accepted"`,
       * and every path above is a REJECTION. An accepted ack never reaches the
       * recovery fork, and a rejected one never finds a cancel restoration.
       */
      onActionAck: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        retireSweptEvidenceOnAck(frame);
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
        // Asked BEFORE the hand-back below, because a successful restore
        // stages the survivors through `setIntent`, and every user-mutation
        // Read BEFORE anything below stages or clears, because the evidence
        // is destroyed by the very operation it describes: the restore stages
        // survivors through the staging store, and that write drops the
        // dispatch mark and the swept-refs record with it. Reading afterwards
        // finds an empty record and says nothing was swept - which is how the
        // partial sentence went missing once already.
        const rejectionSweep = rejectionSweepFor(rejectedPending);
        const worktreeGoneForRejection = rejectionSweep.swept !== null;
        // Only the dispatch that TOOK the slot may put its pick back. An
        // earlier action's rejection arriving after a later dispatch consumed
        // its own pick would otherwise steal a slot that dispatch still needs,
        // and revive a choice the user superseded when they staged the newer
        // one. The restoration paths deliberately do NOT match on owner - they
        // hand back a prompt, and round 10 proved the last consumer is not
        // necessarily the one whose prompt returns.
        //
        // Owning the mark is necessary but NOT sufficient, because the two
        // slots have to move together. Two rejections can each decide
        // correctly on their own terms and still combine into a mismatch: the
        // first wins the PROMPT slot without owning the mark, the second owns
        // the mark but has its prompt displaced, and the composer ends up
        // holding one send's text over another send's worktree - a resend that
        // looks right and runs somewhere else.
        if (
          rejectedPending !== null &&
          rejectionOwnsSlot &&
          !restorationSlotHeldByOther(
            get().failedSendRestoration,
            rejectedPending.clientActionId,
          )
        ) {
          // Third re-stage site. Same rule as the two reconcile paths: capture
          // only what the hand-back actually left, so a later displacement can
          // take back its own write and nothing else.
          recordStagedRevisionFor(
            rejectedPending,
            restoreStagedWorktreeIntent(rejectedPending, rejectionStagingKey),
          );
        }
        // The hash-only refusal fork.
        //
        // Placed AFTER the worktree re-stage above and BEFORE every surface
        // below, and both halves of that position are load-bearing. The
        // re-stage has to have run, because the recovery record freezes the
        // pick this send was made under and a retry cannot go out without one.
        // Returning before the surfaces is what makes the first refusal
        // silent.
        if (
          rejectedPending !== null &&
          beginHashOnlyRecovery(frame, rejectedPending)
        ) {
          return;
        }
        // Third surface, same rule. This path refuses the hand-back exactly as
        // the reconnect paths do, but it states things through its own
        // errorNotice rather than `failedSendRestoration.reason` - so without
        // this the refusal was silent here while being spoken everywhere else.
        // Still never said for a user's own newer pick: only a sweep.
        // The third way a prompt comes back unbound, and the only one that was
        // silent. `stagedWorktreeIntentAwaitsDispatchOutcome` splits the
        // refusals exactly: it is FALSE when a pick stands in the slot (the
        // user can see their own choice, so saying anything would narrate it
        // back at them) and FALSE when no mark stands at all (they cleared it,
        // or never had one). It is TRUE only when the slot is empty because a
        // dispatch took it - and since this rejection does not own that mark,
        // a LATER one did. That is the misleading shape: the pick is gone,
        // nothing stands in its place, and nothing said so.
        //
        // The sweep wins when both are true. "Your worktree is gone" is the
        // more specific fact and the more actionable one; adding "and it was
        // also superseded" is noise on top of it.
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
        // Step (2) of the ordering above: the FALLBACK retractions, reached
        // only because `beginHashOnlyRecovery` declined this ack and returned
        // false. This call must stay between that fork and the `set` below -
        // after the fork because nothing here may run on an ack the silent
        // recovery took over, and before the `set` because the cancel record it
        // returns is destroyed by that very update.
        const cancelRestoration = retractRefusedBlobAcksForAck(
          frame,
          rejectedPending,
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
          const choiceLease = reconcileFallbackChoiceAck(
            state.fallbackChoiceLease,
            frame,
          );
          const nextSessionStop = reconcileSessionStopAck(
            state.pendingBackgroundSessionStop,
            frame,
            state.turnInProgress ?? state.activeTurn !== null,
          );
          // Consumed on BOTH arms and on both accepted shapes: an entry whose
          // ack has been answered is spent, and one left behind would be handed
          // to the composer by a later cancel that reused the id.
          const nextCancelRestorations = withoutCancelRestoration(
            state.pendingCancelRestorations,
            frame.clientActionId,
          );
          // The single-slot contest, in {@link cancelRestorationSettlementForAck}.
          // All three land on BOTH accepted shapes below, because which of them
          // runs is decided by whether the ACK's own action is still pending - a
          // fact about the cancel's bookkeeping that says nothing about whether
          // a prompt just lost the slot.
          const {
            failedSendRestoration: nextFailedSendRestoration,
            errorNotices: nextErrorNotices,
            lastCopyPrompts: nextLastCopyPrompts,
          } = cancelRestorationSettlementForAck(
            state,
            frame.clientActionId,
            cancelRestoration,
          );
          if (frame.status === "accepted") {
            if (pending === null) {
              return {
                pendingActions: nextPending,
                pendingUserMessages: nextPendingUsers,
                pendingBackgroundStops: backgroundStopAck.pendingStops,
                pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
                pendingBackgroundSessionStop: nextSessionStop,
                fallbackChoiceLease: choiceLease,
                pendingCancelRestorations: nextCancelRestorations,
                failedSendRestoration: nextFailedSendRestoration,
                errorNotices: nextErrorNotices,
                lastCopyPrompts: nextLastCopyPrompts,
              };
            }
            return {
              pendingCancelRestorations: nextCancelRestorations,
              failedSendRestoration: nextFailedSendRestoration,
              errorNotices: nextErrorNotices,
              lastCopyPrompts: nextLastCopyPrompts,
              pendingActions: nextPending,
              acceptedActions: addAcceptedAction(
                state.acceptedActions,
                pending,
                Date.now(),
                {
                  // An ack confirms the host RECEIVED the frame, nothing about
                  // whether the message exists - that rule stands. What CAN
                  // confirm at this door is the transcript the record is born
                  // into: `messageAccepted` legitimately arrives BEFORE the ack
                  // (`takeSetupFailedRestoration` slot 2 documents the order),
                  // and in that order door 5 fired while the send was still
                  // pending, found no accepted record to stamp, and this birth
                  // is the only chance to carry that sighting. A hardcoded
                  // `false` here re-opened the resurrection through the other
                  // arm of the same race.
                  //
                  // The transcript ONLY - deliberately not `state.queue`, which
                  // is merged with locally-minted optimistic items, so reading
                  // it would let our own write confirm our own send. A false
                  // confirmation fails in the dangerous direction (quiet about
                  // a real loss); queue-parked sends are covered in both orders
                  // by the queue and snapshot doors.
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
              fallbackChoiceLease: choiceLease,
            };
          }
          const rejectionNoticeInput = {
            frame,
            pending,
            // Displaced: the slot was already taken when this rejection
            // landed, so first-writer-wins gave this prompt nothing.
            displaced: state.failedSendRestoration !== null,
            account: rejectionAccountForFrame,
          };
          return {
            // The rejected arm drops the entry WITHOUT restoring: the host
            // materializes before it honours a cancel and refuses with
            // `WORKTREE_CREATE_FAILED` when that fails, leaving the row in the
            // queue. The prompt is still in the dock, so handing a copy to the
            // composer would fork it - the same reason the queued guard
            // declines. `failedSendRestoration` below stays the rejection
            // path's own.
            pendingCancelRestorations: nextCancelRestorations,
            pendingActions: nextPending,
            pendingUserMessages: nextPendingUsers,
            pendingBackgroundStops: backgroundStopAck.pendingStops,
            pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
            pendingBackgroundSessionStop: nextSessionStop,
            fallbackChoiceLease: choiceLease,
            queue: removeOptimisticQueuedItemByClientActionId(
              state.queue,
              frame.clientActionId,
            ),
            // A rejection naming an ACCEPTED restore is the host refusing its
            // retransmit (`retransmittableRestoreActions`): no restore under
            // this action id is running or will run, so the record and its
            // spinner settle here - the fourth evidence door.
            ...settleRestoreAttemptsByEvidence(
              state,
              [{ clientActionId: frame.clientActionId, kind: "refusal" }],
              connectionEpoch,
            ),
            // Single slot, first writer wins until `ackFailedSendRestoration`
            // clears it - the same rule `reconcileSnapshotChange` and the
            // settled-turn pass already follow. Two rejections landing before
            // the composer consumes the first would otherwise leave the
            // earlier (longer-waiting) content unreachable.
            failedSendRestoration:
              rejectionRestoration({
                state,
                pending,
                frame,
                account: rejectionAccountForFrame,
              }) ?? state.failedSendRestoration,
            errorNotices: appendErrorNotice(
              state.errorNotices,
              rejectionNotice(rejectionNoticeInput),
              state.deliveredNoticeActionIds,
            ),
            lastCopyPrompts: recordLastCopyPrompt(
              state.lastCopyPrompts,
              rejectionLastCopySend(rejectionNoticeInput),
            ),
          };
        });
        // `queue` is one of the six, and this handler removes an optimistic
        // item from it. The direction is the OPPOSITE of the growth cases
        // above, and it is a defect for the same reason: the accountant keeps
        // over-charging this holder and evicts it ahead of chats that really
        // are that large. The obligation `chatSlicesOf` states is about every
        // write, not every growth.
        commitWholeSetSliceBudget();
        // AFTER the updater above, which is this evidence's last reader.
        retireConsumedRetryEvidence(rejectedPending);
        maybeDispatchPendingBackgroundSessionStop(set, get);
        // AFTER the reduction above, never inside it: the ack this handler is
        // processing may be the very one that mints the token a closed menu is
        // waiting to hand back, and the frame that hands it back cannot be
        // sent from inside a `set`.
        dispatchPendingChoiceRelease(set, get);
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
          // The fifth confirmation door. Applied on BOTH arms: whether the
          // message is new to us or already in `messages`, the frame is the
          // host reporting it in the transcript, and that is the fact the
          // stamp records.
          const acceptedActions = confirmAcceptedSendByMessageId(
            state.acceptedActions,
            frame.message.messageId,
          );
          const pendingActions = releasePendingWorktreeIntentDisplayByMessageId(
            state.pendingActions,
            frame.message.messageId,
          );
          // On the windowed line the record goes into the WINDOW instead (see
          // `takeLiveRecords`), and `messages` is republished from there - so
          // the existence check moves with it, because `state.messages` here
          // holds only what is hydrated. `appendLiveRecords` runs the same
          // check against the live set AND the spans.
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
        // THE LEGACY ARM'S SETTLE. `takeLiveRecords` re-settles through
        // `publishWindowedTranscript` for the windowed line, and the legacy
        // line had nothing - it appends straight into `messages` and left the
        // accountant on the previous figure. `commitLegacyTranscriptBudget`
        // rather than `commitWholeSetSliceBudget` so both arms of the SAME
        // handler agree about recency: the windowed arm stamps it, and a
        // message landing means the same thing on either line.
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
              // A recovering send's row is retained by the RECOVERY, not by a
              // pending action - its action is gone by design. Without this the
              // next unrelated queue update drops the row, and for a queued send
              // that row is the only thing the user can see.
              new Set([
                ...Object.keys(patch.pendingActions),
                ...Object.keys(state.hashOnlyRecoveries),
              ]),
            ),
            pendingActions: patch.pendingActions,
            acceptedActions: withoutSettledAcceptedQueueStatusActions(
              withoutResolvedAcceptedQueueCancellations(
                pruneAcceptedActions(
                  {
                    ...state.acceptedActions,
                    // Confirmation stamps for records that were already
                    // accepted when this frame arrived, then this pass's own
                    // transitions.
                    ...patch.confirmedAcceptedActions,
                    ...patch.acceptedActions,
                  },
                  now,
                ),
                frame.queue,
              ),
              frame.queue,
            ),
            pendingUserMessages: patch.pendingUserMessages,
          };
        });
        // The AUTHORITATIVE queue, not the merged one the store now holds:
        // that is what the deferred fold's own merge takes as its input, and
        // handing it a list the optimistic items are already in would keep an
        // item whose pending action has since settled.
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
          // Resolved ONCE and reused: the same two ids drove four separate
          // `?.turnId ?? null` reads, which is both noise and four extra
          // branches in an updater already at the complexity budget.
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
          // The frozen row goes into the WINDOW on the windowed line, not into
          // the published array. It has no ordinal yet - the host indexes it
          // and tells us in a later `appended` index change - so it is a LIVE
          // record, the same home `onEventAppended` uses. Written to
          // `state.messages` instead it would survive only until the next
          // windowed frame republished that array from `transcriptWindow`, and
          // the turn that just finished would vanish from the transcript until
          // some later snapshot or range happened to restore it.
          const windowed = isWindowedTranscript(state);
          const seated =
            materialized === null || !windowed
              ? state.transcriptWindow
              : appendLiveRecords(state.transcriptWindow, {
                  messages: [materialized],
                  events: [],
                });
          // The steer-restart remap is the SAME rule one step on: it renames a
          // `turnId` across every row carrying it, and on this line those rows
          // live in the window too. Applied to the published array alone it
          // would be undone by the next republish exactly as the frozen row
          // above was, leaving the moved rows attributed to a turn that no
          // longer exists.
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
          // Clear liveTurnUsage on any turn transition (turnId changes or
          // activeTurn settles to null). The new turn hasn't emitted its
          // own usage.updated yet, and keeping the previous turn's value
          // would briefly attribute the wrong number to the new turn.
          // Chip falls back to messages[last].usage during the gap.
          const turnIdChanged = previousTurnId !== nextTurnId;
          const nextBackgroundItems =
            frame.backgroundItems ?? state.backgroundItems;
          // A frame reporting the turn settled (the host's `turnInProgress`
          // when present, `runStatus` idle for an older host) is the point
          // where a send stopped during activation can be declared dead:
          // its accepted ack kept the optimistic user message waiting for a
          // `messageAccepted` that will now never arrive. Drop such stranded
          // entries and restore their content to the composer.
          const settledPatch = reconcileTurnSettled(
            turnSettledFromStatus(frame.turnInProgress, frame.runStatus),
            {
              pendingActions: state.pendingActions,
              recoveringActionIds: new Set(
                Object.keys(state.hashOnlyRecoveries),
              ),
              pendingUserMessages: state.pendingUserMessages,
              messages: nextMessages,
              queue: state.queue,
              failedSendRestoration: state.failedSendRestoration,
              // The LIVE composer tuple, not the last snapshot's persisted
              // one: a resend runs under what the composer holds now, and a
              // settle can arrive before any snapshot carries a just-made
              // change - which is precisely when the warning matters.
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
            // Taken FIELD BY FIELD, never spread. Two of the patch's keys -
            // `appendedErrorNotices` and `restoredWorktreeIntent` - are
            // reconcile plumbing, not state, and a spread writes them into
            // the store where every `useShallow` subscriber compares them for
            // the rest of the session. The delta feeds `errorNotices`, which
            // the spread would not have written anyway.
            pendingUserMessages: settledPatch.pendingUserMessages,
            failedSendRestoration: settledPatch.failedSendRestoration,
            // A record is retired by whichever pass recovers its send - the
            // reconciler's contract - and this caller recovered it, so the
            // retirement happens here exactly as at the snapshot site. Left
            // unretired, the unconfirmed record survived the live settle and
            // the next snapshot recovered the same send a second time.
            // Removal only, no `pruneAcceptedActions` wrap: this site never
            // adds a record, and TTL pruning stays a snapshot-pass concern.
            acceptedActions: withoutSettledAcceptedActions(
              state.acceptedActions,
              settledPatch.settledAcceptedActionIds,
            ),
            errorNotices: appendErrorNoticeDelta(
              state.errorNotices,
              settledPatch.appendedErrorNotices,
              state.deliveredNoticeActionIds,
            ),
            lastCopyPrompts: withLastCopyPrompts(
              state.lastCopyPrompts,
              settledPatch.appendedLastCopyPrompts,
            ),
            messages: nextMessages,
            // Same object when nothing above touched it, so the windowed
            // subscribers that compare by identity see no change on the
            // ordinary turn transition.
            transcriptWindow: nextWindow,
            runStatus: frame.runStatus,
            activeTurn: frame.activeTurn,
            turnInProgress: frame.turnInProgress ?? state.turnInProgress,
            backgroundItems: nextBackgroundItems,
            // No `??` here, unlike the two lines above, and the difference is
            // the point: those fields are omitted by an older host and
            // "omitted" means "unchanged", whereas a live `1.10` peer sets
            // these keys on EVERY frame with `undefined` meaning "the
            // traversal is over". Taking the fallback would make a settled
            // grace card immortal - the host never re-sends a card it has
            // cleared, so nothing would ever take it back down.
            pendingFallback: frame.pendingFallback,
            pendingReturn: frame.pendingReturn,
            lastFailedAttempt: frame.lastFailedAttempt,
            lastFallbackOutcome: frame.lastFallbackOutcome,
            // The settle usually arrives HERE rather than as a snapshot, and
            // this handler used not to touch the slot at all - so a traversal
            // that ended through the commoner frame type left a dead lease
            // standing, which the next open then read as a hold already in
            // flight. Same reconciler as the snapshot path: one rule, two
            // readers.
            fallbackChoiceLease: reconcileFallbackChoiceLeaseWithFrame(
              state.fallbackChoiceLease,
              frame.pendingFallback,
              connectionEpoch,
            ),
            // Keep background-stop pending state in lockstep with the
            // running-only list: a task that has left the list settled, so its
            // Stop is no longer in flight.
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
        // The other path that grows the window without seating a range:
        // `appendLiveRecords` adds the materialized row and `mapWindowMessages`
        // rewrites every record carrying the remapped turn. Same reason, same
        // guard - a no-op unless the fresh tier is genuinely over budget.
        evictWindowAfterInPlaceGrowth();
        // ...and the eviction guard is NOT the re-settle. It returns without
        // touching the accountant whenever the window is under
        // `TRANSCRIPT_WINDOW_MAX_BYTES`, and immediately on the legacy line -
        // so this handler wrote `backgroundItems` and seated the turn's frozen
        // row while the accountant kept the pre-turn figure. Buffered deltas
        // deliberately leave a streaming turn under-read, which makes the
        // completed turn the moment its real size first exists; a multi-megabyte
        // response followed by no range or snapshot stayed charged at the
        // pre-turn size for as long as the chat then stayed quiet.
        commitWholeSetSliceBudget();
        // Routed through the shared decider rather than calling
        // `restoreStagedWorktreeIntent` directly, so the swept-claimant rule
        // is applied here too.
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
        // Same `??` fallbacks as the updater above, against the deferred
        // snapshot's own baseline rather than the store's: an older host omits
        // both fields, and "omitted" means "unchanged", not "cleared".
        advanceDeferredSnapshotAux((held) => ({
          runStatus: frame.runStatus,
          activeTurn: frame.activeTurn,
          turnInProgress: frame.turnInProgress ?? held.turnInProgress,
          backgroundItems: frame.backgroundItems ?? held.backgroundItems,
          // Same rule as the store write above - "one rule per site, never two
          // copies of the rule". Without these two the held snapshot would
          // replay its own (older) card state when its tail arrives, and
          // because nothing re-sends a cleared card that replay is permanent.
          pendingFallback: frame.pendingFallback,
          pendingReturn: frame.pendingReturn,
          lastFailedAttempt: frame.lastFailedAttempt,
          // The supersession half of D215. Without this a held snapshot
          // replays the outcome it was sent with even after this frame cleared
          // it, and the announcer speaks a result that was withdrawn.
          lastFallbackOutcome: frame.lastFallbackOutcome,
        }));
      },
      onBlockDelta: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // The chat stream is the only source that can prove a success happened
        // after a renderer-local transport failure. Notification-feed rows
        // arrive on an independent replicated stream, so their arrival order
        // cannot establish lifecycle order. A live terminal completion can:
        // acknowledge only this host-bound chat's earlier local failure.
        // Matching the active turn also keeps a late terminal delta from an
        // older turn from consuming a failure that belongs to the current
        // one. If the connection closes after this event, the recurring
        // failure write below flips the row unread again.
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
          // Every renderer has its own app-local Zustand store. Broadcast the
          // same live, causally-qualified proof so a sibling window whose
          // stream died can acknowledge its copy of the earlier failure too.
          // This is deliberately ephemeral: replaying a retained completion
          // could consume a failure from a later connection lifecycle.
          notificationDependencies.completionAcknowledgements.publish({
            userId: notificationUserId,
            originHostId: options.hostId,
            epicId: options.epicId,
            chatId: options.chatId,
            turnId: frame.event.turnId,
            observedAt,
          });
        }
        // A block delta is the most direct evidence of a write to the streaming
        // turn this client ever gets - it needs no index echo to follow it and
        // no `blocksVersion` to be present. Counted here, before the fold that
        // may or may not find a body to apply it to, because the mark asks what
        // the HOST did while the request was in the air, not what this client
        // could do with it. An echo for the same write counts again; the mark is
        // a monotonic clock, so double-counting one write costs nothing.
        //
        // Except for an event the reducer will reject as belonging to a
        // different turn - a late `usage.updated` from the previous turn on
        // OpenCode's SSE ordering, say (see `applyBlockDelta`'s own check). That
        // is not a write to the streaming turn's body at all, and counting it
        // retired a perfectly current catch-up answer and spent a round asking
        // the host to re-send a body that had not changed.
        if (
          countsAsActiveTurnWrite(frame.event, get().activeTurn?.turnId ?? null)
        ) {
          activeTurnWriteMark += 1;
        }
        bufferedDeltas.push(frame.event);
        lease.requestFlush();
        // The `code: "auth"` error frame is the one live push that flips the
        // re-auth banner on mid-session. The failed turn's error block also
        // renders in the transcript as the failure's durable record; failures
        // with no live subscriber are instead caught on snapshot by
        // `nudgeProviderAuthFromPersistedError` above.
        if (
          frame.event.type === "error" &&
          frame.event.code === AUTH_ERROR_CODE
        ) {
          // Nudge `providers.list` to refetch (and read the host's poisoned
          // `unauthenticated`) so the banner mounts + send blocks. Record the
          // SAME turnId marker `nudgeProviderAuthFromPersistedError` uses, so
          // the snapshot that follows this live failure (on this connection
          // or after a reconnect) doesn't nudge a second time for the
          // identical turn.
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
        // Consuming frame: the host emits this interview's `blockDelta` first,
        // but that delta is still buffered until the next coordinator tick.
        // Publishing the pending id ahead of its block would expose a
        // host-pending interview with no `streaming` segment - which
        // `findUnanswerableInterviews` reads as permanently stuck and answers
        // with the destructive dismiss affordance, mid-normal-Q&A.
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
        // Unconditional, unlike the store write above. `resolvedPendingOwner`
        // asks whether the STORE still listed this interview; a deferred
        // snapshot is a different list and may still carry it. Settled is
        // settled on either.
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
        // Unconditional, unlike the store write above. `resolvedPendingOwner`
        // asks whether the STORE still listed this interview; a deferred
        // snapshot is a different list and may still carry it. Settled is
        // settled on either.
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
        // The durable outcome of a restore names its action, so it retires
        // the accepted `restoreCheckpoint` record exactly - the door for a
        // `restoreCompleted` frame that never arrives. Before the transcript
        // arms below, which differ by line; the record is line-independent.
        if (frame.event.type === "checkpoint.restored") {
          set((state) => {
            const evidence = restoreOutcomesFrom([frame.event]);
            const settled = settleRestoreAttemptsByEvidence(
              state,
              evidence,
              connectionEpoch,
            );
            return {
              acceptedActions: settled.acceptedActions,
              settledRestoreCompletions: settled.settledRestoreCompletions,
              // Also for a spinner this window did not originate (no record
              // to match through): a live outcome is in order, so it is the
              // slot's own attempt.
              restore: settleObservedRestoreSlot(settled.restore, evidence),
            };
          });
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
        // Same asymmetry as `onMessageAccepted`, and the same remedy: the
        // early return above settles through `takeLiveRecords`, this arm did
        // not settle at all.
        commitLegacyTranscriptBudget();
      },
      onRestoreStarted: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // The accepted `restoreCheckpoint` record is NOT retired here. This
        // slot is the spinner, and a reconnect snapshot sweeps it
        // (`sweepStaleRestoreSlot`); the record is the parking hold, and it
        // keeps holding until completion evidence (`onRestoreCompleted`, the
        // durable `checkpoint.restored` event, an error notice for the
        // action). Retiring it at the start handed the hold to a slot that
        // did not survive the reconnect, and the epic parked over a restore
        // still writing files.
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
          // Progress frames only refine the matching in-flight/progress
          // entry. Late-arriving progress for a previous checkpoint or
          // for a flow that already completed is ignored.
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
              // A progress frame is live proof the restore is still running
              // on THIS connection - refresh the stamp so the next snapshot
              // does not clear an actively-progressing slot.
              connectionEpoch,
            },
          };
        });
      },
      onRestoreCompleted: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => {
          // One attempt finished. The frame carries no client action id, so
          // the ledger answers first: a completion whose durable outcome
          // reached this client ahead of the frame (a snapshot serialized in
          // the host's journal-then-broadcast gap) has already retired its
          // record exactly, and retiring "the earliest for this checkpoint"
          // here would take a second attempt's record instead (Codex on
          // ad9f99fb8). Otherwise retire ONE record, the earliest accepted,
          // which is the attempt the host reached first; a second attempt
          // accepted behind it keeps its own record until its own completion.
          const answered = consumeSettledRestoreCompletion(
            state.settledRestoreCompletions,
            frame.checkpointId,
            frame.finishedAt,
          );
          return {
            restore: {
              kind: "completed",
              checkpointId: frame.checkpointId,
              finishedAt: frame.finishedAt,
              results: [...frame.results],
            },
            settledRestoreCompletions: answered.entries,
            acceptedActions: answered.consumed
              ? state.acceptedActions
              : withoutEarliestAcceptedRestoreActionFor(
                  state.acceptedActions,
                  frame.checkpointId,
                ),
          };
        });
      },
      onErrorNotice: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // The host does not stop at the rejected ack. `rejectAction` persists
        // and broadcasts the failure and then sends a SEPARATE `errorNotice`
        // carrying the same client action id - so returning early from
        // `onActionAck` suppressed only the notice that callback synthesizes,
        // and the host's own arrived a moment later and made the "silent"
        // first refusal loud after all. A successful retry still showed the
        // user a missing-attachment warning for a message that went through.
        //
        // Suppressed by ACTION ID and only while that exact action is the one
        // being recovered, so the retry's own new id stays loud and a second
        // refusal says its piece.
        const noticeActionId = frame.notice.clientActionId;
        if (
          noticeActionId !== null &&
          (Object.hasOwn(get().hashOnlyRecoveries, noticeActionId) ||
            consumeSuppressedNotice(noticeActionId))
        ) {
          return;
        }
        set((state) => ({
          errorNotices: appendErrorNotice(
            state.errorNotices,
            frame.notice,
            state.deliveredNoticeActionIds,
          ),
          // A notice naming an accepted restore is the host saying that
          // attempt is over without a completion - the third retirement
          // door, so a failed restore does not hold the epic resident. Its
          // spinner goes with it.
          ...(frame.notice.clientActionId === null
            ? {}
            : settleRestoreAttemptsByEvidence(
                state,
                [
                  {
                    clientActionId: frame.notice.clientActionId,
                    kind: "refusal",
                  },
                ],
                connectionEpoch,
              )),
        }));
      },
      onConnectionStatus: (status, reason, retryCause) => {
        if (disposed) return;
        if (status === "reconnecting" || status === "closed") {
          // Frames dispatched on the lost connection can no longer be
          // answered. Only stamps get older here - nothing is cancelled
          // until an authoritative post-reconnect snapshot arrives.
          bumpConnectionEpoch();
        }
        set((state) => {
          // Capture a fatal close so the tile can show the host's reason
          // (e.g. CHAT_INVALID) instead of spinning forever. A non-fatal close
          // (caller teardown) keeps any prior value; any (re)connect clears it.
          const resolveFatalClose = () => {
            if (status !== "closed") return null;
            if (reason?.kind === "fatalError") return reason.details;
            return state.fatalClose;
          };
          // The negotiated `chat.subscribe` version is stable per connection and
          // available once the handshake completes (status `open`). Capture the
          // steer-protocol capability there so the composer only resolves
          // `after_safe_point` against a host that understands it; a non-open
          // status drops it back to `false` so a reconnect re-confirms.
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
          // THREE states, unlike the two gates above, and the third is the
          // point. `null` is "this session cannot say yet" - the handshake has
          // not completed, or a handle that predates the probe - and a surface
          // reading it falls back to what the harness CATALOG line proves.
          // `false` is a line that answered and cannot carry `auto`.
          //
          // Collapsing the unknown into `false` would veto Auto on every
          // not-yet-open session and every older fixture, which is a much
          // louder wrong answer than the latent case this gate exists for.
          const resolveAutoPermissionModeProtocolSupported = () => {
            if (status !== "open") return null;
            return (
              streamClient?.autoPermissionModeProtocolSupported?.() ?? null
            );
          };
          // One attempt that failed before delivering a snapshot, counted for
          // the tile's bounded loading gate (see `PreSnapshotRetryEvidence`).
          //
          // `reconnecting` is the whole trigger because it is what every such
          // failure looks like from here: the transport publishes it once per
          // dropped socket, failed dial and retryable fatal, and then
          // re-dials. A retryable fatal's details come with it as
          // `retryCause`. The two statuses that are NOT counted each already
          // have their own surface - a terminal `closed` carries
          // `fatalClose`, and `open`/`connecting` are attempts still in
          // flight.
          //
          // Only before the first snapshot: after one has landed the tile is
          // rendering the transcript and an ordinary reconnect is not a
          // stalled load. `retry()` clears `snapshotLoaded`, so a session the
          // user re-dials is counted again - and it deliberately does NOT
          // clear the streak, because the failures are evidence about the host
          // and dropping them on a click would put the reader back on the
          // spinner they just escaped.
          const resolvePreSnapshotRetries = () => {
            if (state.snapshotLoaded || status !== "reconnecting") {
              return state.preSnapshotRetries;
            }
            return countPreSnapshotRetry(
              state.preSnapshotRetries,
              retryCause,
              Date.now(),
            );
          };
          return {
            connectionStatus: status,
            runStatus: status === "closed" ? "idle" : state.runStatus,
            activeTurn: status === "closed" ? null : state.activeTurn,
            steerProtocolSupported: resolveSteerProtocolSupported(),
            draftBlobBridgeSupported:
              status === "open" &&
              (streamClient?.draftBlobBridgeSupported() ?? false),
            interviewDeliveryRetryProtocolSupported:
              resolveInterviewDeliveryRetryProtocolSupported(),
            autoPermissionModeProtocolSupported:
              resolveAutoPermissionModeProtocolSupported(),
            fatalClose: resolveFatalClose(),
            preSnapshotRetries: resolvePreSnapshotRetries(),
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
     * The stream-facing callbacks: every frame this store accepts, each inert
     * once its generation is retired.
     *
     * The guard used to be written out by hand on all twenty-seven, and the bug
     * it prevents - a superseded socket's frame landing in the live store -
     * returned the moment a twenty-eighth was added without the line. The
     * pass-through frames now wire it through the shared {@link guardHandler},
     * which is the same check in one place; the three that do more than forward
     * keep their bodies and check {@link streamGuard} themselves, because the
     * work they do after the frame is this store's, not the guard's.
     *
     * `callbacks.onX` is read here, when the handler is wired, rather than per
     * frame. Nothing reassigns a member of that object, and a future change
     * that wants to swap one at runtime has to take that up with this line.
     */
    const makeCallbacks = (streamGeneration: number): ChatStreamCallbacks => {
      const guarded = <TArgs extends unknown[]>(
        handler: (...args: TArgs) => void,
      ): ((...args: TArgs) => void) =>
        guardHandler(streamGuard, streamGeneration, handler);
      /**
       * Everything this store does with a status, split out from the callback so
       * the callback can hold ONE extra decision: whether there is a store yet.
       *
       * Every line here needs one. `get()` below reads state zustand assigns
       * only after the initializer RETURNS, the epoch mirror writes
       * `store.setState`, and `callbacks.onConnectionStatus` ends in a `set()`
       * whose updater is handed `undefined` during construction. Splitting keeps
       * that one decision at the boundary instead of growing a second,
       * construction-time copy of this logic.
       */
      const applyConnectionStatus = (
        status: StreamConnectionStatus,
        reason: StreamCloseReason | null,
        retryCause: FatalErrorDetails | null,
      ): void => {
        if (!streamGuard.isCurrent(streamGeneration)) return;
        // A RETRYABLE fatalError is the transport saying "not now" - the client
        // is already reconnecting on its own backoff and the user needs to do
        // nothing. Notifying on it turned an overnight sleep into a stack of
        // "Agent stream closed unexpectedly" rows (one per dark wake), which
        // read as data loss when nothing was lost. Only an adjudicated close -
        // one the user must act on - is worth a notification.
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
        callbacks.onConnectionStatus(status, reason, retryCause);
      };
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
        onPortForwardsChanged: guarded(callbacks.onPortForwardsChanged),
        // Guarded like every frame above rather than passed through: whatever
        // binds these must not apply a hydration response from a stream
        // generation this store has already replaced.
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
        // The one frame that can arrive before this store EXISTS.
        //
        // `createStreamClient()` runs inside the `create()` initializer, and
        // `LogicalStream.onStatusChange` replays a terminal `closed`
        // SYNCHRONOUSLY to a handler installed after that transition - which is
        // precisely how `ChatStreamClient`'s constructor installs its own. So a
        // remote chat dialled against an already-closed logical stream lands
        // here from inside the initializer, where `get()` returns `undefined`,
        // `set()`'s updater is handed `undefined`, and `store` is in its
        // temporal dead zone. It threw, the factory's `catch` rolled the store
        // back and rethrew, and the tile got no session at all - a crash where
        // the honest answer was a closed chat.
        //
        // Deferred to a microtask rather than reimplemented for the
        // construction case: `create()` is synchronous, so by the time this
        // runs the store exists and the SAME handler applies the status through
        // the same path. It is also the answer this transport stack already
        // gives to this hazard - `createInertStreamSession` in
        // `ws-stream-client.ts` defers its terminal status for one microtask
        // "so a wrapper constructor finishes wiring its handlers first".
        //
        // Nothing can interleave in the gap: construction runs to completion in
        // one task, so the only thing this reorders against is the rest of that
        // construction, and the epoch bump inside is counted either way.
        onConnectionStatus: (status, reason, retryCause) => {
          if (storeReady) {
            applyConnectionStatus(status, reason, retryCause);
            return;
          }
          queueMicrotask(() => {
            // Construction can also FAIL - the factory throws, `create()` never
            // returns, and `storeReady` never flips. Re-read rather than assume:
            // a status deferred out of a doomed construction has nothing to land
            // on, and running it would trade a synchronous throw for an
            // unhandled one in a microtask.
            if (!storeReady) return;
            applyConnectionStatus(status, reason, retryCause);
          });
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
      // The flush-coordinator lease is registered above, before the first
      // stream is built. If the factory throws (e.g. a transport that fails to
      // construct), `dispose()` is never reachable, so release the lease here -
      // otherwise the coordinator keeps invoking this store's flush/hasPending
      // callbacks for the lifetime of the process.
      lease.unregister();
      // The budget holder is attached before the factory runs, and the same
      // reasoning applies to it: no handle is returned, so `dispose()` - which
      // holds this exact pair - is unreachable for this id.
      //
      // Not hygiene. The leaked `evict` closure calls `get()`, which zustand
      // has not assigned yet, so measuring residency off `state.messages`
      // throws a TypeError - and `reconcile` has no catch, so it escapes into
      // whichever LIVE chat's frame path happened to cross the soft limit.
      // `touchedAt` is 0 for a holder that never settled, so it sorts first in
      // LRU order and is the one asked first, every time.
      //
      // Rolled back here rather than by moving the attach after the factory:
      // that ordering would depend on no factory callback settling
      // synchronously, which nothing enforces.
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
      preSnapshotRetries: null,
      preSnapshotReloadStartedAt: null,
      transcriptBaselineEpoch: NO_TRANSCRIPT_BASELINE,
      // The live counter, not a literal `0`, because this field IS that
      // counter's mirror and the two must not be able to disagree. They are
      // equal here today - the one construction-time bump path is deferred at
      // the status callback - so this is the statement of the invariant rather
      // than the repair of a live drift: a bump that ever lands before the
      // store exists writes no mirror, and a literal seed would then publish an
      // epoch one BEHIND the stamps `sendAction` is already writing, which
      // reads as pending actions belonging to a future connection.
      connectionEpoch,
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
      draftBlobBridgeSupported: false,
      interviewDeliveryRetryProtocolSupported: false,
      // `null`, not `false` - no session has answered yet, so the catalog line
      // decides alone rather than the mode being vetoed before a handshake.
      autoPermissionModeProtocolSupported: null,
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
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFailedAttempt: undefined,
      lastFallbackOutcome: undefined,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      fallbackChoiceLease: null,
      confirmedManualFallbackAction: null,
      unattendedFallbackOutcome: null,
      pendingBackgroundStops: {},
      pendingBackgroundStopAll: null,
      pendingBackgroundSessionStop: null,
      restore: null,
      settledRestoreCompletions: [],
      pendingActions: {},
      acceptedActions: {},
      pendingUserMessages: [],
      errorNotices: [],
      deliveredNoticeActionIds: new Set<string>(),
      deliveredLastCopyActionIds: new Set<string>(),
      lastCopyPrompts: {},
      openedSubagentCardBlockIds: new Set<string>(),
      pendingCancelRestorations: {},
      failedSendRestoration: null,
      hashOnlyRecoveries: {},
      hashOnlyRecovery: null,
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
       * Name (or clear) the ordinal a pending transcript jump is waiting on.
       *
       * Called by the surface holding the jump request when its target is not
       * in the hydrated set. Hydration is otherwise driven by the VIEWPORT, and
       * the jump does not move the viewport until its target arrives - so
       * without this the request waits on a row nothing will fetch.
       */
      requestTranscriptOrdinal: (ordinal: number | null) => {
        if (get().jumpTargetOrdinal === ordinal) return;
        set({ jumpTargetOrdinal: ordinal });
        if (ordinal !== null) requestPlannedHydration();
      },
      wake: () => {
        if (disposed) return;
        // No state written, deliberately. The status stays whatever the
        // transport reports; if the re-dial succeeds the stream reports `open`
        // through its normal callback, and if it fails the backoff re-arms.
        // Writing an optimistic "connecting" here would claim progress this
        // has no way to observe.
        options.wakeTransport?.();
      },
      retryFromUser: () => {
        if (disposed) return;
        // The escalation, in this order and no other: drop the socket FIRST,
        // then re-subscribe. `wake` writes no store state and drops the
        // session synchronously, so the fresh `chat.subscribe` below is
        // adopted by the same session while it is reconnecting and released at
        // its open-ack - a re-subscribe sent before the drop would be enqueued
        // onto the very channel the drop is about to discard.
        //
        // The gate is the TRANSPORT's verdict, not a timestamp of our own:
        // `isSilentFor` includes the session's readiness, so a Retry pressed
        // while the relay reports the host merely DETACHED stays a plain
        // re-subscribe. Forcing there would put a fresh handshake in front of a
        // host that blipped, and its timeout would bank a refusal against it.
        if (options.transportSilentFor?.(SESSION_SILENCE_TIMEOUT_MS) === true) {
          get().wake();
        }
        get().retry();
      },
      retry: () => {
        if (disposed) return;
        closeStreamClient();
        clearBufferedDeltas();
        const prior = get();
        set({
          connectionStatus: "connecting",
          steerProtocolSupported: false,
          draftBlobBridgeSupported: false,
          interviewDeliveryRetryProtocolSupported: false,
          autoPermissionModeProtocolSupported: null,
          fatalClose: null,
          snapshotLoaded: false,
          // A LATER pre-snapshot wait begins here, and the tile's anchor
          // describes one that already ended. Stamped only when a snapshot
          // had landed: a retry before the first one is still the same wait,
          // whose clock the tile owns (see `preSnapshotReloadStartedAt`).
          preSnapshotReloadStartedAt: prior.snapshotLoaded
            ? Date.now()
            : prior.preSnapshotReloadStartedAt,
        });
        try {
          streamClient = createStreamClient();
        } catch (cause) {
          // The replacement factory can throw (durable-transport wiring throws
          // on a failed subscription). Without this restore the session would
          // strand in "connecting" with NO stream client - nothing ever moves
          // it again, and recovery passes (the wake retry, the tile's retry
          // affordance) all key off a terminal status. Restore the pre-attempt
          // terminal state so the next pulse or click can try again, then
          // rethrow for the caller to report.
          set({
            connectionStatus: "closed",
            fatalClose: prior.fatalClose,
            snapshotLoaded: prior.snapshotLoaded,
            // No attempt began, so no later wait did either.
            preSnapshotReloadStartedAt: prior.preSnapshotReloadStartedAt,
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
        // A worktree staged mid-chat ("Create new worktree") rides on this send;
        // the host creates it at turn-start before gating on setup. Mirrors
        // the landing page bundling its intent with `epic.create`.
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
        // Consume before dispatch so the pending action captures precisely the
        // revision it may later restore. A synchronous action rejection cannot
        // race ahead of this transition.
        const stagingStore = useWorktreeIntentStagingStore.getState();
        // Unconditional: a dispatch is this slot's current state whether or
        // not it took a pick. Skipping the intent-free case left an earlier
        // action's mark standing, so that action could hand back a choice this
        // send had already superseded. Captured first so a send REFUSED below
        // can put back what this consume displaces - see `rollBackDispatch`.
        const displaced = stagedDispatchDisplacement(stagedKey);
        stagingStore.consumeForDispatch(stagedKey, clientActionId);
        // Captured once, before dispatch, and reused for the optimistic echo
        // below - a queued send (this false) gets NO optimistic transcript
        // row today. Re-deriving this condition after dispatch instead of
        // reusing it would risk it reading post-dispatch state (e.g. the
        // just-appended optimistic queue item) and disagreeing with what
        // `pendingUserMessage` below actually decided.
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
            checkpointId: null,
            revertArtifacts: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId,
            restore: input.restore,
            sender: input.sender,
            settings: input.settings,
            accountContext: frame.accountContext,
            sentContentHashes: null,
            restoreWorktreeIntent: worktreeIntent,
            displayWorktreeIntent: worktreeIntent,
            messageConfirmedByHost: false,
            deliveryPolicy: frame.deliveryPolicy,
            hashOnlyRetry: false,
            // The document that actually went on the wire, which is NOT
            // `restore.content`: the composer appends annotation crop atoms
            // and converts slash commands AFTER capturing the restore
            // document. A retry rebuilt from the restore document delivered
            // the prompt with the annotation screenshot silently missing.
            wireContent: frame.content,
            createdAt: Date.now(),
          },
          // Echo the user message optimistically so it paints INSTANTLY on send -
          // including a worktree-creating send. The host announces the setup
          // card before the slow `git worktree add` and persists the message only
          // AFTER it, so without an echo the message would visibly lag the card by
          // the worktree-add latency. The earlier jump (card flipping from below
          // to above the message) is gone because the setup card now anchors to
          // this message by id (`triggeringMessageId`), not by timestamp - see
          // rendered-messages.ts. The persisted message later replaces this echo
          // by shared `messageId` (the `dedupedPending` guard), and the card stays
          // pinned immediately above it throughout.
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
          // This send never reached the wire, so the slot goes back exactly as
          // it was found - the pick AND everything the consume displaced. An
          // unconditional consume needs an unconditional rollback.
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
        // Consume the staged worktree once it's on the wire so a later send
        // doesn't re-create it (the frame carries it across transport retries).
        // Remember it per-epic so reopening this epic restores the same picks.
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
        // Sends the first message using the handoff's PRE-MINTED ids (shared
        // with the optimistic seed and the host's turn-overlap idempotency
        // gate), so the seed reconciles cleanly and the host never double-runs
        // the turn. Used by the driver's fallback `send` path.
        const seededStagingKey: WorktreeStagingKey = {
          surface: "owner",
          hostId: options.hostId,
          epicId: options.epicId,
          ownerKind: "chat",
          ownerId: options.chatId,
        };
        // CLAIM THE SLOT, but only when this send carries an intent AND the
        // slot is not holding a competing one.
        //
        // Why claim at all: `restoreWorktreeIntent` on the pending action below
        // is inert on its own. The rejection path hands a pick back only to the
        // dispatch that OWNS the slot's consumption mark
        // (`stagedWorktreeIntentAwaitsDispatchFrom`), and without a consume
        // there is no mark, so a `WORKTREE_CREATE_FAILED` rejection would
        // restore the prompt UNBOUND - the silent-local-run the restore exists
        // to prevent. The mark is what makes the hand-back this send's to make.
        //
        // Why not unconditionally, the way `sendMessage` does it: THIS send's
        // intent comes from the HANDOFF, not from the slot. `sendMessage` is
        // the slot's own dispatch and consuming is how it takes its pick; here
        // the slot is someone else's, and the handoff can sit for a long time -
        // waiting on image recovery or on the connection - with the chat's
        // workspace selector live the whole while (`chat-tile.tsx`,
        // `disabled={false}`). So two things are gated:
        //
        //  - a null intent claims nothing: the intent-free resend, the
        //    overwhelmingly common one, has nothing to hand back and leaves the
        //    slot exactly as it found it.
        //  - a slot holding a DIFFERENT pick claims nothing either. That pick
        //    is a newer choice the user made during the wait, and consuming it
        //    would both discard it on success and - through the mark - let this
        //    send's older intent be restored over it on a rejection. This send
        //    still goes out with its OWN intent on the frame (the handoff's is
        //    what this message was written against); the newer pick simply
        //    stays staged and applies to the user's next send, which is what
        //    staging it meant. The cost is that a rejection then hands this
        //    prompt back unbound - correctly, because the slot the composer
        //    would show it against is already showing the user's own newer
        //    choice, and overwriting that is the worse failure.
        //  - a slot ALREADY CONSUMED by another dispatch claims nothing either,
        //    and this is not the same condition as the one above. An empty slot
        //    is not the same thing as an unowned one: if the user picked Y and
        //    SENT it while this handoff was still waiting, Y's own dispatch took
        //    the pick and left its consumption mark behind, so the slot reads
        //    empty with nothing visible to protect. Consuming there writes OUR
        //    `clientActionId` over Y's mark, and `consumeForDispatch` keeps one
        //    mark per slot - so if Y is then rejected while this send is still
        //    pending, `rejectionOwnsSlot` is false for Y and Y cannot hand its
        //    own worktree back. Y's rejection is the case that most needs the
        //    slot, and stealing the mark is what silently denies it.
        const seededSlotHoldsNewerPick =
          input.worktreeIntent !== null &&
          stagedWorktreeIntentDiffersFrom(
            seededStagingKey,
            input.worktreeIntent,
          );
        // "Awaits an outcome" IS "empty because a dispatch took it" - the store
        // separates that from an empty-because-cleared slot precisely so this
        // question is answerable. Narrowed to OTHER dispatches so a re-entry
        // that already owns the mark is not refused by its own claim.
        const seededSlotAwaitsOtherDispatch =
          stagedWorktreeIntentAwaitsDispatchOutcome(seededStagingKey) &&
          !stagedWorktreeIntentAwaitsDispatchFrom(
            seededStagingKey,
            input.clientActionId,
          );
        const seededClaimsSlot =
          input.worktreeIntent !== null &&
          !seededSlotHoldsNewerPick &&
          !seededSlotAwaitsOtherDispatch;
        const seededDisplacement = seededClaimsSlot
          ? stagedDispatchDisplacement(seededStagingKey)
          : null;
        const seededSlotPick = seededClaimsSlot
          ? readStagedWorktreeIntent(seededStagingKey)
          : null;
        if (seededClaimsSlot) {
          useWorktreeIntentStagingStore
            .getState()
            .consumeForDispatch(seededStagingKey, input.clientActionId);
        }
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
          // The handoff's intent rides the frame as well as `epic.create`. On
          // the deferred path this resend is a duplicate of the seeded message
          // and the frame is never read; on every SYNCHRONOUS path it can win
          // the race with the host's own initial turn, and `handleSend` then
          // materializes this intent against the worktree the pre-commit
          // `resolveIntent` already created - adopted, so one worktree and one
          // turn. Sending `null` there would run the turn in the source
          // checkout if the resend won.
          worktreeIntent: input.worktreeIntent,
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
            checkpointId: null,
            revertArtifacts: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId: input.messageId,
            restore: { content: input.content, browserAnnotations: [] },
            sender: input.sender,
            settings: input.settings,
            // Both copies, so a `WORKTREE_CREATE_FAILED` rejection of this
            // resend on a synchronous host restores the composer WITH the
            // intent rather than without it - a prompt handed back without its
            // worktree is the silent-local-run these fields exist to prevent.
            //
            // Carried even when this send did NOT claim the slot, and that is
            // safe rather than sloppy: the hand-back is gated on the mark this
            // send then never wrote, so `restoreStagedWorktreeIntent` refuses
            // and the user's newer pick stands. What the field still buys there
            // is the SWEEP account - `worktreeSweepFor` reads it to say "your
            // worktree is gone", which is true of this send's intent however
            // the slot ended up.
            sentContentHashes: null,
            restoreWorktreeIntent: input.worktreeIntent,
            displayWorktreeIntent: input.worktreeIntent,
            messageConfirmedByHost: false,
            // The DISPATCHED context, not a default. A Team-billed first
            // message that strands would otherwise report that it was going
            // to bill personal - a drift statement lying about the very thing
            // it exists to warn about.
            accountContext: frame.accountContext,
            deliveryPolicy: frame.deliveryPolicy,
            hashOnlyRetry: false,
            wireContent: null,
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
            // DELIBERATELY null while the pending ACTION above carries it. This
            // copy outlives the ack (it is what the accepted record restores
            // from on a dropped connection), and by then the intent has either
            // been materialized by the host or is riding the seeded queue item
            // - so handing it back to the staging slot would stage a SECOND
            // worktree create for the user's next send. The pending action's
            // copy dies with the ack, which is exactly the rejection window the
            // restore is for.
            restoreWorktreeIntent: null,
          },
        });
        if (sentClientActionId === null) {
          // Never reached the wire, so the slot goes back exactly as it was
          // found - the pick AND everything the consume displaced. Unconditional
          // rollback for a conditional consume: `seededDisplacement` is `null`
          // only where no consume ran.
          if (seededDisplacement !== null) {
            useWorktreeIntentStagingStore
              .getState()
              .rollBackDispatch(seededStagingKey, {
                intent: seededSlotPick,
                displaced: seededDisplacement,
              });
          }
          return null;
        }
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
        // Consume before dispatch, exactly like `sendMessage`: the pending
        // action captures the staging revision it may later restore, so a
        // rejected edit (e.g. the staged worktree failed to materialize) puts
        // the selection back unless the user re-picked meanwhile. Without
        // this, the folder chip silently reverts to the prior binding and the
        // next resend runs there - the silent-local-run the reject exists to
        // prevent.
        const stagingStore = useWorktreeIntentStagingStore.getState();
        // Unconditional: a dispatch is this slot's current state whether or
        // not it took a pick. Skipping the intent-free case left an earlier
        // action's mark standing, so that action could hand back a choice this
        // send had already superseded. Captured first so an edit REFUSED below
        // can put back what this consume displaces - see `rollBackDispatch`.
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
            checkpointId: null,
            revertArtifacts: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId,
            restore: null,
            sender: null,
            settings: null,
            // The hashes this edit put on the wire BARE. Kept here rather than
            // read off `restore` (null for an edit) so a refused edit still
            // retracts its acks - and, since `hashOnlyRetryForRejection` now
            // classifies edits too, so the refusal marks exactly the digests
            // this edit asked the host to resolve from its own store.
            //
            // The narrow reading deliberately: `blobHashesFromContent` would
            // also name digests this edit inlined, and an `unsupported-format`
            // refusal would then mark bytes undecodable that the host never had
            // to decode from a hash. The retraction below is unharmed either
            // way (over-forgetting costs one re-upload); the marking is not.
            sentContentHashes: hashOnlyImageHashes(input.content),
            restoreWorktreeIntent: worktreeIntent,
            displayWorktreeIntent: worktreeIntent,
            messageConfirmedByHost: false,
            accountContext: null,
            deliveryPolicy: null,
            hashOnlyRetry: false,
            wireContent: null,
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
            checkpointId: null,
            revertArtifacts: null,
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId: null,
            restore: null,
            sender: null,
            settings: null,
            sentContentHashes: null,
            restoreWorktreeIntent: null,
            displayWorktreeIntent: null,
            messageConfirmedByHost: false,
            accountContext: null,
            deliveryPolicy: null,
            hashOnlyRetry: false,
            wireContent: null,
            createdAt: Date.now(),
          },
          pendingUserMessage: null,
        });
      },
      fallbackHoldForChoice: (traversalId) => {
        const state = get();
        // The DTO is the capability gate. `pendingFallback` exists only on a
        // live `chat.subscribe@1.10` frame, so a host that has no handler for
        // this action is also a host that never gave us a traversal to hold -
        // no separate version check, and none that could drift from this one.
        const pending = state.pendingFallback;
        if (pending === undefined) return null;
        if (pending.traversalId !== traversalId) return null;
        // Only a live window can be frozen. `switching` has committed and
        // `waiting` never had a countdown; both open their menu with no hold at
        // all, so asking for one here would be asking the host to freeze
        // something that is not running.
        //
        // `choosing` IS admitted, and that is the reacquisition half of the
        // blocker. The window is frozen with no deadline and no host-side
        // timer, so a client that cannot re-ask has no way back at all - and
        // the host is willing: it re-delivers the existing token to the SAME
        // subscriber rather than minting a second lease. Refusing here meant a
        // reopened menu sat on "Pausing the countdown…" for the life of the
        // chat.
        if (pending.state !== "hold" && pending.state !== "choosing") {
          return null;
        }
        const lease = state.fallbackChoiceLease;
        if (lease !== null && lease.traversalId === traversalId) {
          // Reopened while a close's release was still owed. The token this
          // request would wait for is the one already in flight, so the honest
          // answer is to WITHDRAW the obligation rather than send a second
          // frame: a new `clientActionId` would overwrite the correlation the
          // pending release is keyed by, and the first token would then be the
          // orphan instead.
          if (lease.releaseRequested && lease.status === "pending") {
            set(() => ({
              fallbackChoiceLease: { ...lease, releaseRequested: false },
            }));
            return lease.clientActionId;
          }
          // A hold already in flight or already granted for this traversal: a
          // second frame would mint a second lease and orphan the first. A
          // `refused` one falls through - there is nothing to orphan.
          if (lease.status !== "refused") return null;
        }
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "fallback.holdForChoice",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          traversalId,
        };
        const sent = sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "fallback.holdForChoice"),
          pendingUserMessage: null,
        });
        if (sent === null) return null;
        set(() => ({
          fallbackChoiceLease: {
            traversalId,
            clientActionId: sent,
            token: null,
            status: "pending",
            releaseRequested: false,
            connectionEpoch,
          },
        }));
        return sent;
      },
      fallbackReleaseChoice: () => {
        const lease = get().fallbackChoiceLease;
        if (lease === null) return null;
        // A `pending` hold has no token to hand back YET - which is not the
        // same as having nothing to hand back. Dropping the slot here is what
        // stranded the window: the ack that followed found no lease to mint
        // into, so the token the host had already committed to was discarded
        // and the freeze became permanent. The slot stays, carrying the
        // obligation, and `dispatchPendingChoiceRelease` discharges it.
        if (lease.status === "pending") {
          if (lease.releaseRequested) return null;
          set(() => ({
            fallbackChoiceLease: { ...lease, releaseRequested: true },
          }));
          return null;
        }
        // `held` (hand the token back) and `refused` (nothing was ever minted)
        // both empty the slot: the menu is closing either way and a stale slot
        // would block the next open.
        set(() => ({ fallbackChoiceLease: null }));
        if (lease.status !== "held" || lease.token === null) return null;
        return sendFallbackChoiceRelease({
          set,
          get,
          traversalId: lease.traversalId,
          token: lease.token,
        });
      },
      publishConfirmedManualFallbackAction: (input) => {
        if (disposed) return;
        set((state) => ({
          confirmedManualFallbackAction: {
            ...input,
            // Off the PREVIOUS record rather than a separate counter, so the
            // number is a property of the sequence itself and cannot drift out
            // of step with what is stored.
            sequence: (state.confirmedManualFallbackAction?.sequence ?? 0) + 1,
          },
        }));
      },
      publishUnattendedFallbackOutcome: (input) => {
        if (disposed) return;
        set((state) => ({
          unattendedFallbackOutcome: {
            ...input,
            sequence: (state.unattendedFallbackOutcome?.sequence ?? 0) + 1,
          },
        }));
      },
      stopBackgroundItem: (taskId) => {
        const state = get();
        const items = state.backgroundItems;
        // Unsupported by this provider (sentinel), a stop-all already in
        // flight, this task already stopping, or the task no longer in the
        // host's running-only list: no-op, so no duplicate stop frame is sent.
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
        // Unsupported sentinel, a stop-all already in flight, an accepted row
        // stop still pending, or nothing running: ignore so a rapid repeat does
        // not enqueue duplicate stop frames.
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
        // Only meaningful when the host flagged a command as not individually
        // stoppable - which also proves the host understands this action, so
        // the capability field doubles as the send gate.
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
          // Phase one: end the turn cleanly first. The host refuses a session
          // stop under a live turn (killing the provider mid-turn reads as a
          // crash), so the session-stop frame waits for the turn-settled
          // frame - see `onTurnStateChanged`.
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
        // RETURN-TO-COMPOSER FOR A ROW WHOSE PROVISIONING FAILED.
        //
        // `takeSetupFailedRestoration` deliberately declines while the row is
        // still queued - the prompt is visible and editable in the dock, so
        // handing a second copy to the composer would fork it. But the driver's
        // `eventId` dedupe consumes the `setup.failed` either way, so once the
        // user cancels the row, that copy was the last one and it goes with it.
        // Cancel is therefore where the prompt has to come back, and the only
        // place it still exists to be read.
        //
        // Captured here, released at the ack. Deliberately NOT written into
        // `failedSendRestoration` yet: the host materializes the worktree
        // before it honours a cancel and REJECTS with `WORKTREE_CREATE_FAILED`
        // when that fails, leaving the row exactly where it was. Restoring
        // optimistically would flash the prompt into a composer that still has
        // its row in the dock, then have to take it back.
        const cancelRestore = setupFailedQueueRowRestore(
          get(),
          options.epicId,
          options.chatId,
          queueItemId,
        );
        const sent = sendAction({
          set,
          get,
          frame,
          pending: {
            ...basicPending(clientActionId, "queueCancel"),
            queueItemId,
          },
          pendingUserMessage: null,
        });
        // Only for a cancel that actually reached the wire: a frame that never
        // left has no ack coming, so an entry recorded here would never be
        // consumed by either arm.
        if (sent !== null && cancelRestore !== null) {
          set((state) => ({
            pendingCancelRestorations: {
              ...state.pendingCancelRestorations,
              [clientActionId]: { queueItemId, restore: cancelRestore },
            },
          }));
        }
        return sent;
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
        // Only still-pending items live-mirror. Items mid-steer
        // (steer_requested/steering/injected) locked their settings at steer
        // start; paused items keep their own. The edited item is excluded (it
        // commits on submit), and items already on these settings are skipped.
        // Received A2A responses (agent sender) are system-owned and excluded -
        // the host refuses to restamp them, so they must not live-mirror either.
        // Managed-command items carry no settings stamp at all (they dispatch on
        // the chat's current settings), so there is nothing to restamp.
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
          pending: {
            ...basicPending(clientActionId, "restoreCheckpoint"),
            checkpointId,
            revertArtifacts,
          },
          pendingUserMessage: null,
        });
      },
      interviewAnswer: (blockId, answers) => {
        // Defense-in-depth against a duplicate store dispatch: the UI already
        // gates on the busy state, but never send a second answer/skip for a
        // block whose action is still in flight or accepted-but-unresolved.
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
      markNoticeDelivered: (notice) => {
        const clientActionId = notice.clientActionId;
        if (clientActionId === null) return;
        set((state) => {
          let deliveredNoticeActionIds = state.deliveredNoticeActionIds;
          if (!deliveredNoticeActionIds.has(clientActionId)) {
            const next = new Set(deliveredNoticeActionIds);
            addWithFifoEviction(
              next,
              clientActionId,
              MAX_DELIVERED_CLIENT_ACTION_IDS,
            );
            deliveredNoticeActionIds = next;
          }
          // The hold's release: unbounded, see the field. A store write even
          // when the action-wide set already had the id, because that set
          // may have been written by another speaker for the action, and
          // this write is what the parking watcher re-evaluates on.
          let deliveredLastCopyActionIds = state.deliveredLastCopyActionIds;
          if (
            noticeCarriesOnlyCopy(notice) &&
            !deliveredLastCopyActionIds.has(clientActionId)
          ) {
            deliveredLastCopyActionIds = new Set([
              ...deliveredLastCopyActionIds,
              clientActionId,
            ]);
          }
          // The prompt has been SHOWN, so this record is no longer the only
          // copy and the handoff must not stash it.
          //
          // Except that a notice shows the WORDS and only the words:
          // `unrecoverableSendNotice` renders `quotedDraftOf(content)` and
          // never looks at `browserAnnotations`. For an annotated prompt the
          // toast hands the user the text while the records stay uncopied, so
          // dropping the row here would take the last copy of the sidecar AND
          // unroot its crops, which `collectPendingAnnotationImageHashes`
          // names through this very map. Custody moves for what was actually
          // delivered; the rest keeps its row until the handoff stashes it.
          //
          // This is why the row and the HOLD are no longer released from one
          // condition. They now fail in opposite directions and only one of
          // those is harmful: a hold with no row is a session pinned for a
          // prompt the handoff cannot find, while a row with no hold simply
          // means eviction comes sooner and disposal stashes the prompt on
          // its way out. The words have genuinely been shown, so the hold is
          // right to release.
          const shown = Object.hasOwn(state.lastCopyPrompts, clientActionId)
            ? state.lastCopyPrompts[clientActionId]
            : null;
          const lastCopyPrompts =
            shown !== null && shown.browserAnnotations.length === 0
              ? withoutLastCopyPrompt(state.lastCopyPrompts, clientActionId)
              : state.lastCopyPrompts;
          if (
            deliveredNoticeActionIds === state.deliveredNoticeActionIds &&
            deliveredLastCopyActionIds === state.deliveredLastCopyActionIds &&
            lastCopyPrompts === state.lastCopyPrompts
          ) {
            return {};
          }
          return {
            deliveredNoticeActionIds,
            deliveredLastCopyActionIds,
            lastCopyPrompts,
          };
        });
      },
      stateFailedSendRestoration: (clientActionId) => {
        // The prompt is NOT going to the composer, so the binding its
        // hand-back staged must not stay attached to the newer draft - that is
        // a silent wrong-checkout submit, which "visible in the picker" does
        // not prevent. Scoped by the revision the hand-back left: if anything
        // has touched the slot since, this is a no-op.
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
                // The DISPLACED variant, baked at slot creation: its worktree
                // clauses read `handedBack: false`, because the binding is not
                // going back with the prompt and has just been released.
                restoration.displacedReason,
              ),
              state.deliveredNoticeActionIds,
            ),
            // THIS producer was missing. The restoration slot is being cleared
            // and the prompt is not going to the composer, so from here the
            // notice is its only custody - and a notice holds the draft as
            // rendered text. If the pane's toaster is inactive when a newer
            // draft displaces this one, nothing is ever delivered, so nothing
            // releases the hold, and the session sits held until the deferral
            // cap with an EMPTY collector: held for a prompt the handoff could
            // not then find.
            //
            // `displacedReason` rather than `reason` for the same reason the
            // notice uses it: this prompt is not handed back, so its account
            // must name the worktree and ask for a re-pick.
            lastCopyPrompts: {
              ...state.lastCopyPrompts,
              [clientActionId]: {
                clientActionId,
                content: restoration.content,
                // The sidecar goes with it: from here the stash handoff is
                // this prompt's only custody, and the records name crops that
                // nothing else will root once the slot is cleared.
                browserAnnotations: restoration.browserAnnotations,
                reason: restoration.displacedReason,
              },
            },
          };
        });
      },
      ackFailedSendRestoration: (clientActionId) => {
        // The composer TOOK the prompt, so its binding stays staged with it.
        stagingRevisionByRestoredAction.delete(clientActionId);
        set((state) => {
          const restoration = state.failedSendRestoration;
          if (restoration?.clientActionId !== clientActionId) return {};
          // Spoken exactly once - but "spoken" means REACHED THE USER, not
          // "was appended". The rejection path owns a notice and says the
          // account there, so `stated` is right; what it could not know is
          // whether anyone saw it. `useActivePaneEffect` tears the toast
          // subscription down while the pane is unfocused, so a rejection that
          // lands then sits in the ring unseen (and can be evicted by a flood
          // before the pane returns). Deferring to a notice that was never
          // shown left the prompt in the composer with silently changed
          // semantics - the exact silent-resend this surface exists to stop.
          //
          // `deliveredNoticeActionIds` is the delivery axis for the whole
          // surface and is accurate here: `markNoticeDelivered` fires only
          // where a toast is actually shown. So a stated-and-DELIVERED account
          // stays quiet, and a stated-but-undelivered one is said here.
          if (
            restoration.stated &&
            state.deliveredNoticeActionIds.has(clientActionId)
          ) {
            return { failedSendRestoration: null };
          }
          // The draft has just landed in the composer, so this is the moment
          // its account is worth reading - and the only moment both handoff
          // branches share. `markFailedByAction` does not ack, but it flips
          // the handoff to `failed`, which sends the very next transition
          // down `restoreAndAckFailed`; so every restored prompt passes
          // through here exactly once.
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
        // STILL QUEUED means there is nothing to restore. Restoring pulls the
        // prompt into the composer and drops its optimistic echo, which is
        // right when the send was REJECTED - the message then exists nowhere
        // else - and wrong for a row the host is holding for Retry + resume:
        // the user would be looking at the prompt in the composer AND in the
        // queue, and could run it twice.
        //
        // The guard is on the predicate "the message is still queued" rather
        // than on the async-create path, so it also covers today's queued
        // per-message intent that fails at dequeue and stays paused. A rejected
        // send never entered the queue, so its `setup.failed` still restores.
        const stillQueued = state.queue.items.some(
          (item) => item.kind === "prompt" && item.messageId === messageId,
        );
        if (stillQueued) return null;
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
        // Clear every restorable slot in lockstep so a duplicate
        // `setup.failed` event cannot double-restore. The action records
        // themselves stay in place - only their `restore` slot is
        // nulled - so downstream ack/accept reconciliation continues to
        // work.
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
        // Arm 2 of the class in {@link forgetRefusedContentBlobAcks}: this door
        // hands hash-carrying content back to the composer, so a resend of it
        // would meet the same ack memo. Defensive rather than the reached path
        // - this door is driven only by `setup.failed` / `setup.cancelled`, and
        // neither missing-bytes site emits those.
        forgetRefusedContentBlobAcks(options.hostId, restored);
        return restored;
      },
      dispose: () => {
        if (disposed) return;
        // BEFORE `disposed = true` and before the store leaves
        // `liveChatSessionStores`, because abandonment has to actually land:
        // it writes the prompt into `failedSendRestoration` (or states it),
        // and both the write and its GC roots are worthless once this store is
        // unregistered. The old shape left the continuation to discover
        // disposal on its own and write into a dead store after its UI driver
        // had unmounted - the prompt existed nowhere a replacement store could
        // find it.
        //
        // A recovery has exactly one terminal outcome. Anything still
        // recovering at teardown takes the hand-back one, now.
        abandonAllHashOnlyRecoveries(
          "The chat closed before the image could be re-attached.",
        );
        // DURABLE HANDOFF, after the abandonment above has put every recovery
        // into a restoration or a notice.
        //
        // Retention alone cannot be the answer, and this is the line that says
        // so. Every hold in the registry is bounded: the idle deferral caps at
        // `MAX_ACTIVE_CHAT_IDLE_DEFER_MS`, and at that boundary the shared
        // registry disposes whatever the predicate says. A longer timer is not
        // a handoff. So before this store goes, anything that exists ONLY here
        // is installed as a closed start-page draft - the app's durable,
        // user-visible home for an unsent prompt (D01/D03), which outlives the
        // session and has its own UI, the composer's Drafts control, for
        // finding and reopening it.
        //
        // Every disposal route lands here: warm-cap overflow and idle expiry
        // both end at `policy.dispose(handle)`, which is `handle.dispose()`.
        // Suppressed across an identity change - see
        // `identityTeardownInProgress`. The prompt is dropped with the
        // outgoing account rather than written where the next one would find
        // it.
        if (!identityTeardownInProgress) handOffUnrecordedPromptToStash();
        clearSuppressedNotices();
        unsubscribeSweptObserver();
        stickySweptByAction.clear();
        disposed = true;
        liveChatSessionStores.delete(store);
        unsubscribeLiveCompletionAcknowledgements();
        lease.unregister();
        clearBufferedDeltas();
        clearInFlightHydration();
        recovery.dropAll();
        hydrationRequestMarks.clear();
        forgetCatchUpBudget();
        clearResnapshotRequestTimer();
        clearStreamCompletionWatchdog();
        legacyTranscriptAdapter.detach("disposed");
        memory.chatWindows.detach(holderId);
        memory.accountant.release(BUDGET_PLANE_IDS.chatWindows, holderId);
        closeStreamClient();
        // Disposal suppresses the stream's close callback, so `onConnectionStatus`
        // never runs here and nothing recomputes these. Every per-stream
        // capability is meaningful ONLY while the status is `open`, so each has
        // to be retired by hand or a store held past disposal keeps advertising
        // a stream it no longer has.
        //
        // Clear them as a SET, and keep this list identical to `retry()`'s. The
        // two teardown paths drifting apart is the defect here, and it has now
        // happened TWICE: first when the draft-blob flag was added and cleared
        // only here, then when `autoPermissionModeProtocolSupported` was added
        // and cleared only in `retry()`. A new capability must join both.
        //
        // `null`, not `false`, for the auto flag: absence means "this handle
        // cannot say", and a disposed store has not refused `auto` - it has
        // stopped being able to answer. That is the same value `retry()` and
        // the initial state use.
        set({
          steerProtocolSupported: false,
          draftBlobBridgeSupported: false,
          interviewDeliveryRetryProtocolSupported: false,
          autoPermissionModeProtocolSupported: null,
        });
      },
    };
  });
  // The first statement after the assignment, deliberately: everything between
  // here and the `create()` above is the window `storeReady` exists to name, and
  // anything inserted before this line silently joins it.
  storeReady = true;

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
          // Renderer clocks share one machine clock. Preserve timestamp ties
          // and anything later so an ambiguous or genuinely newer disconnect
          // remains red; only clearly older failures are superseded.
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

/**
 * What `ackFailedSendRestoration` says when this prompt lands in the composer.
 *
 * States the CAUSE, not the gesture: the user knows they pressed Cancel, and
 * what they need told is why the prompt came back to them rather than being
 * discarded like every other cancelled row.
 */
const CANCELLED_AFTER_SETUP_FAILED_REASON =
  "Workspace setup failed, so this message was never sent. It's back in the composer.";

/**
 * The same cause, for a prompt that did NOT reach the composer.
 *
 * Stops at the loss, because {@link displacedRestorationNotice} appends "It was
 * not put back in the composer, because you have started another message
 * there." and quotes the draft. Sharing one string would have the notice claim
 * the prompt is back in the composer and then, one clause later, that it is
 * not - which is the `reason` / `displacedReason` split on
 * {@link FailedSendRestorationState} existing for a reason.
 */
const CANCELLED_AFTER_SETUP_FAILED_DISPLACED_REASON =
  "Workspace setup failed, so this message was never sent.";

/**
 * How this prompt died, phrased to open an {@link unrecoverableSendNotice}
 * statement - no trailing period, because both renderings continue the
 * sentence. The notice appends ", and another unsent message is already waiting
 * in the composer."; the stash prompt's `reason` appends "." and the account.
 */
const CANCELLED_AFTER_SETUP_FAILED_CIRCUMSTANCE =
  "Workspace setup failed, so a cancelled message was never sent";

/**
 * Award the single restoration slot to a cancelled row's prompt, or take
 * custody of it.
 *
 * The invariant the rejection paths and `reconcileTurnSettled` already keep:
 * there is ONE slot, first writer wins, and a prompt that loses it is never
 * dropped. Dropping was the defect here - the comment reasoned that the row was
 * still in the dock, which is true right up until the accepted cancellation
 * removes it, and then the only remaining copy was the one this function
 * discarded.
 *
 * The loser becomes an {@link UnrecoverableSend} rather than a bare
 * `displacedRestorationNotice`, because upstream's custody model is strictly
 * the stronger answer to the same problem: the notice is only a rendering, and
 * a user who never reads that toast still loses the text, while a LAST-COPY
 * prompt is also rooted against the image sweep and stashed at teardown. The
 * caller is what completes it - this function cannot write state - so a caller
 * that takes the `notice` and drops the `lastCopy` has reintroduced the defect
 * in a quieter form.
 */
function awardCancelRestorationSlot(
  current: FailedSendRestorationState | null,
  clientActionId: string,
  restore: ChatSendRestore,
): {
  readonly failedSendRestoration: FailedSendRestorationState | null;
  readonly notice: ChatErrorNotice | null;
  readonly lastCopy: UnrecoverableSend | null;
} {
  if (current !== null) {
    const lastCopy: UnrecoverableSend = {
      clientActionId,
      content: restore.content,
      browserAnnotations: restore.browserAnnotations,
      circumstance: CANCELLED_AFTER_SETUP_FAILED_CIRCUMSTANCE,
      // This path composed no account and must not invent one: the cancel is
      // the user's own gesture on a row whose worktree never materialized, so
      // there is no surviving binding to go re-pick and no settings drift to
      // report. `EMPTY_DEAD_SEND_ACCOUNT` is how that is SAID rather than
      // guessed - the field is required precisely so a caller with nothing to
      // say has to say so.
      account: EMPTY_DEAD_SEND_ACCOUNT,
    };
    return {
      failedSendRestoration: current,
      notice: unrecoverableSendNotice(lastCopy),
      lastCopy,
    };
  }
  return {
    lastCopy: null,
    failedSendRestoration: {
      clientActionId,
      content: restore.content,
      browserAnnotations: restore.browserAnnotations,
      reason: CANCELLED_AFTER_SETUP_FAILED_REASON,
      displacedReason: CANCELLED_AFTER_SETUP_FAILED_DISPLACED_REASON,
      // No notice of its own - this path is a direct answer to the user's own
      // Cancel, so `ackFailedSendRestoration` speaks once when the draft lands
      // rather than narrating a failure they just acted on.
      stated: false,
    },
    notice: null,
  };
}

/**
 * The three state slices an accepted cancel's restoration decides, folded into
 * one place because they are one decision answered three ways: who holds the
 * slot, what is said about it, and which document is kept.
 *
 * Module-level and pure, taking `state` rather than closing over the store:
 * the single-slot invariant is the whole content of this function, and it
 * should be checkable without the ack handler around it. The call site is
 * `onActionAck`'s updater, which was over the complexity ceiling with this
 * inlined and where these were the only lines about the cancel arm at all.
 *
 * A `null` restoration returns the state's own values untouched - the ordinary
 * ack, where nothing was cancelled and nothing contends for the slot.
 */
function cancelRestorationSettlementForAck(
  state: ChatSessionState,
  clientActionId: string,
  cancelRestoration: PendingCancelRestoration | null,
): {
  readonly failedSendRestoration: FailedSendRestorationState | null;
  readonly errorNotices: ReadonlyArray<ChatErrorNotice>;
  readonly lastCopyPrompts: Readonly<Record<string, UnrecoverableSendPrompt>>;
} {
  if (cancelRestoration === null) {
    return {
      failedSendRestoration: state.failedSendRestoration,
      errorNotices: state.errorNotices,
      lastCopyPrompts: state.lastCopyPrompts,
    };
  }
  // First-writer-wins on the single slot - and the LOSER IS KEPT, not dropped.
  // The first version of this reasoned that a displaced cancel's prompt was
  // still safe in the dock; it is not, because the very cancellation being
  // acked is what removes that row, so the discarded copy was the last one.
  const awarded = awardCancelRestorationSlot(
    state.failedSendRestoration,
    clientActionId,
    cancelRestoration.restore,
  );
  return {
    failedSendRestoration: awarded.failedSendRestoration,
    errorNotices:
      awarded.notice === null
        ? state.errorNotices
        : appendErrorNotice(
            state.errorNotices,
            awarded.notice,
            state.deliveredNoticeActionIds,
          ),
    // The document behind that notice, written on the same pass. Taking the
    // notice and leaving this behind would reintroduce the dropped prompt in a
    // quieter form - the toast would still appear and the text would be gone.
    lastCopyPrompts: recordLastCopyPrompt(
      state.lastCopyPrompts,
      awarded.lastCopy,
    ),
  };
}

/**
 * Settle the cancel restorations whose acks died with an old connection.
 *
 * Scoped to SWEPT ids only. An entry whose cancel is still pending on the
 * current epoch has an ack that can still arrive, and settling it here would
 * race the arm that actually knows the answer; the sweep is precisely the set
 * the fold has just declared unanswerable.
 *
 * The snapshot's queue is the verdict. Row gone - the host honoured the cancel
 * before the connection died, and the prompt is owed to the composer. Row still
 * there - the cancel never landed, the row is the user's to see and cancel
 * again, and handing a copy to the composer would fork it.
 */
function settleCancelRestorations(
  restorations: Readonly<Record<string, PendingCancelRestoration | undefined>>,
  sweptActionIds: ReadonlySet<string>,
  queue: ChatQueueState,
): {
  readonly settledActionIds: ReadonlySet<string>;
  readonly honoured: ReadonlyArray<{
    readonly clientActionId: string;
    readonly restore: ChatSendRestore;
  }>;
} {
  const settledActionIds = new Set<string>();
  const honoured: {
    readonly clientActionId: string;
    readonly restore: ChatSendRestore;
  }[] = [];
  for (const [clientActionId, entry] of Object.entries(restorations)) {
    if (entry === undefined || !sweptActionIds.has(clientActionId)) continue;
    settledActionIds.add(clientActionId);
    const rowStillQueued = queue.items.some(
      (item) => item.queueItemId === entry.queueItemId,
    );
    if (!rowStillQueued) {
      honoured.push({ clientActionId, restore: entry.restore });
    }
  }
  return { settledActionIds, honoured };
}

/** The map minus a settled set; unchanged when it held none of them. */
function withoutCancelRestorations(
  restorations: Readonly<Record<string, PendingCancelRestoration | undefined>>,
  settledActionIds: ReadonlySet<string>,
): Readonly<Record<string, PendingCancelRestoration | undefined>> {
  if (settledActionIds.size === 0) return restorations;
  return Object.fromEntries(
    Object.entries(restorations).filter(([id]) => !settledActionIds.has(id)),
  );
}

/** The map minus one spent entry; unchanged when it never held that id. */
function withoutCancelRestoration(
  restorations: Readonly<Record<string, PendingCancelRestoration | undefined>>,
  clientActionId: string,
): Readonly<Record<string, PendingCancelRestoration | undefined>> {
  if (restorations[clientActionId] === undefined) return restorations;
  return Object.fromEntries(
    Object.entries(restorations).filter(([id]) => id !== clientActionId),
  );
}

/**
 * The content a `queueCancel` owes the composer, or `null` when it owes
 * nothing.
 *
 * Non-null only when the row is a PROMPT still in the queue AND the setup card
 * window its message triggered has rolled up to `failed`. Both halves matter:
 *
 *  - a row whose setup is `creating` or `ready` is being cancelled for ordinary
 *    reasons, and today's silent removal is what the user is asking for;
 *  - a row with no window at all (the overwhelmingly common cancel) is not a
 *    provisioning casualty either.
 *
 * The LAST window for that message id, matching
 * `use-epic-create-seed-hold-driver`'s rule: a Retry opens a fresh window under
 * the same triggering id, and the live one is the answer - a row whose retry
 * succeeded must not read as failed off its first window.
 */
function setupFailedQueueRowRestore(
  state: ChatSessionState,
  epicId: string,
  chatId: string,
  queueItemId: string,
): ChatSendRestore | null {
  const row = state.queue.items.find(
    (item) => item.queueItemId === queueItemId,
  );
  if (row === undefined || row.kind !== "prompt") return null;
  // USER-AUTHORED ONLY. A queued prompt's payload is a union, and the agent
  // member is a message another agent sent into this chat over A2A - nobody
  // typed it here, so there is no composer draft it came from and none it can
  // go back to. Handing one to the composer would put words in the user's
  // mouth. (It also has no `browserAnnotations`: the restore contract needs
  // that field, which is itself the union telling us these are different
  // things.)
  if (row.message.kind !== "user") return null;
  const rows = buildSetupCardRows(
    state.events,
    { epicId, ownerId: chatId, ownerKind: "chat" },
    state.transcriptDerived?.setupCardWindows ?? EMPTY_SETUP_CARD_WINDOWS,
  );
  let window: SetupCardRow | null = null;
  for (const candidate of rows) {
    if (candidate.triggeringMessageId === row.messageId) window = candidate;
  }
  if (window === null || window.model.aggregate.state !== "failed") return null;
  return {
    content: row.message.content,
    browserAnnotations: row.message.browserAnnotations,
  };
}

/** See the identically-named constant in the seed-hold driver. */
const EMPTY_SETUP_CARD_WINDOWS: ReadonlyArray<SetupCardWindowIdentity> = [];

function basicPending(
  clientActionId: string,
  action: ChatOwnerActionFrame["kind"],
): PendingChatActionSeed {
  return {
    clientActionId,
    action,
    queueItemId: null,
    checkpointId: null,
    revertArtifacts: null,
    interviewBlockId: null,
    interviewDeliveryRetry: null,
    messageId: null,
    restore: null,
    sender: null,
    settings: null,
    sentContentHashes: null,
    restoreWorktreeIntent: null,
    displayWorktreeIntent: null,
    messageConfirmedByHost: false,
    accountContext: null,
    deliveryPolicy: null,
    hashOnlyRetry: false,
    wireContent: null,
    createdAt: Date.now(),
  };
}

/**
 * View projection for queue cancels whose durable host disposition is still
 * outstanding. The authoritative queue remains intact in store state, so a
 * rejection or reconnect sweep restores the row simply by removing the
 * pending action; an accepted action holds the projection across the
 * ack-before-queueChanged window.
 */
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

/**
 * The worktree choice owned by the dispatch that most recently consumed this
 * chat's staging slot. This is a render-only bridge across the interval where
 * the picker choice has left staging but the host has not yet published the
 * replacement binding.
 *
 * The transcript message is the authoritative end of that interval: on an
 * ordered connection the host publishes the replacement binding before
 * `messageAccepted`, while queued sends do not enter the transcript until
 * their deferred worktree setup has completed. Accepted action records may be
 * retained after that point for recovery bookkeeping, so message presence is
 * also what prevents a retained record from masking later binding changes.
 */
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

// The client action id of an in-flight (pending) or accepted-but-unresolved
// interview action for `blockId`, or null. Used both to refuse a duplicate
// dispatch and to derive the UI busy gate for that block's card.
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

// Drop every pending/accepted action targeting `blockId`'s interview. Called
// when the host authoritatively resolves the interview so a lingering
// accepted-but-unacked entry can never keep a later card gated. Returns the
// same reference when nothing matches so zustand skips a redundant notify.
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

// An accepted retry is not its own terminal state. The card's authoritative
// delivery projection is: any status, generation, or identity change retires
// the old action. A later retryable failure has a new generation and therefore
// renders a fresh Retry affordance instead of reviving a stale accepted id.
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
 * Drops per-task background-stop entries whose stop frame's generic pending
 * was swept as stale (the frame/ack died with a dropped connection, so the
 * task will never terminate on its account). Keyed by the shared
 * `clientActionId` both records carry.
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
 * Clears a frame-driven restore slot that a lost connection stranded: an
 * in-flight/progressing slot stamped on an older connection than the
 * authoritative snapshot would otherwise show "restoring" forever, because
 * its `restoreCompleted` died with the dropped stream. A restore that is
 * genuinely still running re-surfaces at its `restoreCompleted` (which sets
 * the slot unconditionally); progress frames only refine an existing slot,
 * so intermediate progress after the clear is not re-shown - an accepted
 * trade-off against the forever-spinner.
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
  // A stop stays "in flight" until the host running-only list drops the item(s),
  // so accepted acks keep disabled state tied to stream truth instead of ack
  // timing. Rejected acks clear only the failed request's pending state.
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

const MISSING_ATTACHMENT_BYTES_CODE = "MISSING_ATTACHMENT_BYTES";

/**
 * How long after a retry dispatches its predecessor's follow-up notice is
 * still swallowed. Generous relative to the host's ack-then-notice gap (one
 * awaited event append) and short relative to anything a user would connect to
 * a later action.
 */
export const POST_DISPATCH_NOTICE_SUPPRESSION_MS = 10_000;

/** `withoutRecordKey` for a record of any value type. */
function withoutRecordKeyGeneric<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (!Object.hasOwn(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * A refused hash-only send that this client is quietly recovering, held in the
 * store for exactly as long as the recovery runs.
 *
 * It exists because the recovery has an await in the middle of it, and during
 * that await the send must still be SOMETHING. The first version kept it only
 * in an async closure, which meant that for the length of a byte resolution the
 * prompt had no pending action, no queue row, no restoration slot and - for a
 * QUEUED send, which never gets an optimistic echo - no presence at all. A
 * reconnect in that window lost the message outright, and the GC root collector
 * (which walks pending actions, pending users and the restoration slot) could
 * release the very bytes the retry was waiting for.
 *
 * So this is custody: the store owns the send until the retry is dispatched or
 * it is handed back. Everything `sendMessage` would otherwise re-read from
 * ambient state at dispatch time is frozen here instead, because the ambient
 * values belong to whatever the user is doing NOW, not to this send.
 */
/**
 * What `sendMessage` takes. NAMED because three consumers had hand-typed their
 * own copy of it - `useChatActions`, its test's store fake, and the composer
 * submit hook's local slice - and a copy is only correct until this one moves.
 * The last time it did, a copy that had drifted stayed green under compile and
 * went red only when someone ran the file.
 */
/**
 * True while an AUTH IDENTITY teardown is disposing sessions.
 *
 * The durable handoff must never cross accounts. A handed-off prompt becomes a
 * closed start-page draft in the Drafts control, and the landing draft store is
 * per WINDOW rather than per account, so a draft installed during a sign-out or
 * user-switch is a draft the NEXT person to sign in opens and finds - with its
 * images rooted in their landing partition. That is precisely
 * what `EpicSessionLifecycleBridge` exists to prevent - it already dismisses
 * the retained-draft TOAST on this boundary for the same reason, and the
 * handoff quietly inverted that policy by writing the same text somewhere
 * durable instead.
 *
 * It is also worse than a race with the sign-out wipe: the handoff is
 * fire-and-forget and resolves images first, so its install lands SECONDS after
 * disposal - after a wipe has run, into the store the next identity will use.
 *
 * So on this boundary the prompt is DROPPED, matching the bridge's existing
 * policy for the toast. The disposal is TOLD this by
 * {@link disposingForIdentityTeardown} rather than inferring it: a store
 * cannot tell "this tab closed" from "the account went away" by looking at
 * itself, and guessing wrong in one direction loses a prompt while guessing
 * wrong in the other leaks one.
 */
let identityTeardownInProgress = false;

/**
 * Bumped by every identity teardown. A handoff stamps this before its first
 * await and re-checks it synchronously at the install boundary.
 *
 * The boolean above is a START-TIME question and cannot answer a LIFETIME one.
 * An ordinary disposal - a closed tab - begins a capture and leaves the
 * registry; the user then signs out while that image read is still pending.
 * The wrapped teardown cannot reach an in-flight job it never knew about, the
 * flag is back to `false` by the time the read returns, and the install puts
 * the previous account's prompt into the next one's drafts list. The flag
 * is necessary (it stops a teardown's OWN disposals from stashing) and it is
 * not sufficient.
 *
 * Modelled on `OpenEpicSessionRegistry.disposalGeneration`, which exists for
 * exactly this: an async tail learning that the world it was retaining into is
 * gone.
 */
let identityGeneration = 0;

/**
 * Run an auth-identity teardown with the cross-account handoff suppressed.
 *
 * Wraps the WHOLE teardown, not just the chat registry's own `disposeAll`,
 * because a chat session can also be disposed transitively by an epic session
 * going down in the same transition.
 */
export function disposingForIdentityTeardown(run: () => void): void {
  // Bumped FIRST, so a capture already in flight is stale before any of the
  // teardown below runs.
  identityGeneration += 1;
  // Bumping it is now enough on its own. The handoff's last step is a
  // synchronous `installLandingDraft` guarded by a re-check of this same
  // generation, so there is no open transaction between the sample and the
  // effect for a "stop what is running" call to roll back - which is what the
  // retired prompt stash's awaited multi-step write needed.
  identityTeardownInProgress = true;
  try {
    run();
  } finally {
    identityTeardownInProgress = false;
  }
}

export interface SendChatSessionMessageInput {
  readonly content: JsonContent;
  readonly sender: UserMessageSender;
  readonly settings: ChatRunSettings;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy;
  readonly restore: ChatSendRestore;
}

interface HashOnlyRecoveryState {
  /** The settled action this replaces, still owning its queue row until dispatch. */
  readonly clientActionId: string;
  /** Reused by the retry, so the optimistic transcript row never moves. */
  readonly messageId: string;
  /** What was actually SENT - not `restore.content`. See `PendingChatAction.wireContent`. */
  readonly wireContent: JsonContent;
  /** The composer's own document, for a hand-back. */
  readonly restore: ChatSendRestore;
  readonly sender: UserMessageSender;
  readonly settings: ChatRunSettings;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy;
  /**
   * The worktree pick THIS send was made under. Frozen because the staging slot
   * is shared and mutable: a user staging a new workspace mid-recovery would
   * otherwise have this older prompt consume it.
   */
  readonly worktreeIntent: PendingChatAction["restoreWorktreeIntent"];
  /** The account context this send was made under, frozen for the same reason. */
  readonly accountContext: AccountContext;
  /** The optimistic echo to re-register with the retry, or `null` for a queued send. */
  readonly pendingUserMessage: PendingUserMessage | null;
  /**
   * Whether the original send painted an optimistic QUEUE row - the queued
   * send's equivalent of the transcript echo, and for those sends the only
   * thing the user can see. Recorded rather than re-derived so the retry
   * reproduces what the original actually did, instead of asking the live
   * state (which has had a whole recovery to change its mind).
   */
  readonly hadOptimisticQueueRow: boolean;
  /** The host's reason, kept for the hand-back if recovery never dispatches. */
  readonly reason: string;
}

/** A prompt that would be destroyed by teardown, and what to say about it. */
interface UnrecordedPrompt {
  readonly clientActionId: string;
  readonly content: JsonContent;
  /**
   * The annotation sidecar, which does NOT travel inside `content`: the
   * records name crops stored under their own hashes. The handoff built from
   * this is the last copy of both, so a source that drops them here destroys
   * the records and orphans their bytes in the same step.
   */
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
  /**
   * Already account-qualified by whoever produced it, in the NOT-handed-back
   * wording: every one of these is going to the stash rather than back to a
   * composer, so each needs its worktree named and a re-pick asked for.
   */
  readonly reason: string;
}

/**
 * EVERY prompt a disposing store still owns, deduplicated by action id.
 *
 * Plural because `holdsUnrecordedPrompt` is: a session is held back from
 * eviction for four distinct states, and a handoff covering fewer of them
 * leaves the registry refusing to dispose for a reason the handoff cannot
 * discharge - which is the deferral cap arriving and destroying it anyway.
 *
 * `displaced` are the abandonment losers: prompts that could not take the
 * single restoration slot and exist only inside a notice's text.
 */
function unrecordedPromptSources(
  restoration: FailedSendRestorationState | null,
  actions: ReadonlyArray<PendingChatAction>,
  lastCopies: ReadonlyArray<UnrecoverableSendPrompt>,
  accountForRetry: (action: PendingChatAction) => string,
): ReadonlyArray<UnrecordedPrompt> {
  const byAction = new Map<string, UnrecordedPrompt>();
  if (restoration !== null) {
    byAction.set(restoration.clientActionId, {
      clientActionId: restoration.clientActionId,
      content: restoration.content,
      browserAnnotations: restoration.browserAnnotations,
      // The DISPLACED variant, not `reason`. The prompt is going to the stash,
      // not back to a composer with its binding, so the reader needs the
      // worktree named and a re-pick asked for - which is exactly what the
      // handed-back wording omits. Using `reason` here stashed a prompt whose
      // workspace was never stated while `displacedReason`, which said it,
      // sat unused on the same record.
      reason: restoration.displacedReason,
    });
  }
  for (const action of actions) {
    if (!action.hashOnlyRetry || action.restore === null) continue;
    if (byAction.has(action.clientActionId)) continue;
    byAction.set(action.clientActionId, {
      clientActionId: action.clientActionId,
      content: action.restore.content,
      browserAnnotations: action.restore.browserAnnotations,
      // Nothing composed an account for an in-flight retry, so one is built
      // here from the action's own frozen values - every staged entry, its
      // branch and its worktree ref, not just a primary workspace path.
      reason: `The chat closed before the host confirmed this message.${accountForRetry(action)}`,
    });
  }
  for (const prompt of lastCopies) {
    if (byAction.has(prompt.clientActionId)) continue;
    byAction.set(prompt.clientActionId, prompt);
  }
  return [...byAction.values()];
}

/**
 * The digests this action asked the host to resolve from its own store - the
 * ones a `MISSING_ATTACHMENT_BYTES` refusal is actually ABOUT.
 *
 * Two shapes, because the two actions that can send bare keep their document in
 * different places. A `send` freezes the whole prompt in `restore`, so the set
 * is read off that document. An `editUserMessage` has no `restore` at all - it
 * re-opens its own editor rather than handing anything back - so the hashes are
 * recorded at dispatch instead (`sentContentHashes`), which is the only trace
 * of what that edit put on the wire.
 *
 * Empty for everything else, which is what keeps the marking below scoped to
 * the two actions that can earn it.
 */
function refusedHashOnlyDigests(
  pending: PendingChatAction,
): ReadonlyArray<string> {
  if (pending.action === "send") {
    return pending.restore === null
      ? []
      : hashOnlyImageHashes(pending.restore.content);
  }
  if (pending.action === "editUserMessage") {
    return pending.sentContentHashes ?? [];
  }
  return [];
}

/**
 * Whether this rejection is a hash-only refusal this client should quietly fix,
 * and what to re-inline if so.
 *
 * Returns `null` for every rejection that is not one - a different code, an
 * action that cannot send bare, a record with no frozen content to retry, or a
 * refusal whose cause says retrying would change nothing. Those all fall
 * through to the loud path unchanged.
 *
 * The `unsupported-format` marking happens HERE rather than on the loud path,
 * because it must happen whether or not anything is retried: the point of the
 * mark is that the node stops travelling bare from now on.
 *
 * ## The two halves divide at the decision, not at the door
 *
 * MARKING runs for `send` AND `editUserMessage`; the silent inline RETRY is
 * send-only. Gating the whole function on `send` is what made a refused edit
 * permanent: the edit path became hash-only, so an `unsupported-format` refusal
 * of an edit reached nothing that could record the verdict, and every later
 * edit of that message sent the same undecodable digest bare and was refused
 * identically, with no way out but reloading the window.
 *
 * The retry stays send-only deliberately, and not for symmetry: re-sending a
 * send's bytes inline replays a message the host never recorded, while
 * re-sending an EDIT inline would silently rewrite a message the user is
 * looking at. A refused edit is the user's to decide about, so it surfaces.
 */
function hashOnlyRetryForRejection(
  frame: ChatActionAckFrame,
  pending: PendingChatAction,
  hostId: string,
): HashOnlyRecoveryState | null {
  if (frame.code !== MISSING_ATTACHMENT_BYTES_CODE) return null;
  const decision = decideDraftImageRefusal({
    cause: refusalCauseOf(frame),
    hashOnlyHashes: refusedHashOnlyDigests(pending),
    alreadyRetried: pending.hashOnlyRetry,
  });
  if (decision.kind === "surface") {
    for (const hash of decision.unbridgeable) {
      markDraftBlobUnbridgeable(hostId, hash);
    }
    return null;
  }
  // Past the marking, and therefore into the SILENT half. Everything below
  // rebuilds and re-dispatches the message, which only a `send` may do - and an
  // edit reaching here has consumed no `hashOnlyRetry`, because nothing has
  // been retried and the flag is only ever stamped on a retry's own record.
  if (pending.action !== "send") return null;
  const restore = pending.restore;
  const messageId = pending.messageId;
  if (restore === null || messageId === null) return null;
  // The memo said this host held these digests and it does not. Drop those
  // claims BEFORE the re-inline, so the resolver actually goes looking for
  // bytes instead of the gate trusting the same wrong answer on the way out.
  invalidateDraftBlobConfirmations(hostId, decision.hashes);
  const { sender, settings, wireContent, accountContext } = pending;
  // A send always has all four. Bailing rather than defaulting: a retry that
  // invented a sender, settings, an account context or a document would be a
  // different message from the one the user sent.
  if (
    sender === null ||
    settings === null ||
    wireContent === null ||
    accountContext === null
  ) {
    return null;
  }
  return {
    clientActionId: frame.clientActionId,
    messageId,
    wireContent,
    restore,
    sender,
    settings,
    // `auto` where the record kept none: a retry must still be delivered, and
    // a steer/queue policy only ever narrows delivery, so this cannot make the
    // retry more intrusive than the send it replaces.
    deliveryPolicy: pending.deliveryPolicy ?? "auto",
    worktreeIntent: pending.restoreWorktreeIntent,
    accountContext,
    // All three filled in by the caller, which is the only place that can see
    // the live presentation this send currently has, and the staging key its
    // sweep evidence is recorded under.
    pendingUserMessage: null,
    hadOptimisticQueueRow: false,
    reason: frame.reason ?? "The host could not attach the image.",
  };
}

/** The 1.12 typed cause, or `null` on a session that strips it. */
function refusalCauseOf(
  frame: ChatActionAckFrame,
): DraftImageRefusalCause | null {
  const cause: unknown = (frame as { readonly cause?: unknown }).cause;
  if (
    cause === "unsupported-format" ||
    cause === "too-large" ||
    cause === "not-on-host"
  ) {
    return cause;
  }
  return null;
}

/**
 * The ack that mints, refuses, or does not concern a grace-hold lease.
 *
 * The token rides the ACK rather than a frame of its own so the lease and the
 * acceptance are one message - a token delivered separately could arrive after
 * the client had given up on the hold - which makes this the only place in the
 * renderer that can see it.
 *
 * `status: "rejected"` becomes `refused` rather than `null`, deliberately. The
 * menu has to tell "the host declined this hold" from "no hold was ever asked
 * for": the first closes the menu and says the chat has moved on, the second is
 * the ordinary closed state, and collapsing them would make a refusal look like
 * a menu that simply never opened.
 */
function reconcileFallbackChoiceAck(
  lease: ChatSessionState["fallbackChoiceLease"],
  frame: ChatActionAckFrame,
): ChatSessionState["fallbackChoiceLease"] {
  if (lease === null) return null;
  if (lease.clientActionId !== frame.clientActionId) return lease;
  if (frame.status !== "accepted" || frame.token === null) {
    // An accepted hold with no token is a host that took the freeze and minted
    // nothing - treated as a refusal, because a pick with no token to present
    // is `choice_lease_stale` at the verb and the menu is better off closing
    // here than offering rows that cannot be chosen.
    //
    // A refusal ends a pending release OBLIGATION too, and by discharging it
    // rather than deferring it: there is no token, so there is nothing to hand
    // back, and the surface that would have read the refusal has already
    // closed. Dropping the slot outright leaves the next open unblocked.
    return lease.releaseRequested
      ? null
      : { ...lease, token: null, status: "refused" };
  }
  return { ...lease, token: frame.token, status: "held" };
}

/**
 * The lease slot after an AUTHORITATIVE frame (snapshot or turn-state).
 *
 * Two facts end a lease, and a snapshot arriving is neither of them.
 *
 * **The connection went away.** Subscriber detach resumes the frozen remainder
 * host-side, so a lease minted on an older connection names a hold that no
 * longer exists. `connectionEpoch` moves only when the client is actually gone
 * (`closeStreamClient`, and a `reconnecting`/`closed` status) - never on a
 * resnapshot, which the host answers without replacing the subscriber, and
 * never on the sibling-count snapshot it broadcasts to every chat mid-switch.
 * Clearing on every snapshot treated all three as a detach and threw away
 * proof of a lease the host was still holding.
 *
 * **The traversal ended or moved past the window.** The DTO is the host's own
 * account of it: absent means settled, a different `traversalId` means this one
 * is over, and any state but `hold`/`choosing` means the window has been spent
 * or committed. Applied on the turn-state path as well as the snapshot path,
 * because the settle usually arrives as a turn-state frame - which previously
 * did not touch the slot at all, leaving a dead lease standing.
 *
 * TWO call sites is the COMPLETE set, and the windowed line is not a missing
 * third: `adaptWindowedSnapshot` turns a windowed frame into a
 * `ChatSnapshotFrame` and hands it to the same `applyAuthoritativeSnapshot`,
 * so that line is already covered. A call added on the windowed path would run
 * the rule twice on one frame.
 */
function reconcileFallbackChoiceLeaseWithFrame(
  lease: ChatSessionState["fallbackChoiceLease"],
  pendingFallback: PendingFallback | undefined,
  connectionEpoch: number,
): ChatSessionState["fallbackChoiceLease"] {
  if (lease === null) return null;
  if (lease.connectionEpoch !== connectionEpoch) return null;
  if (pendingFallback === undefined) return null;
  if (pendingFallback.traversalId !== lease.traversalId) return null;
  if (
    pendingFallback.state !== "hold" &&
    pendingFallback.state !== "choosing"
  ) {
    return null;
  }
  return lease;
}

function reconcileSessionStopAck(
  sessionStop: ChatSessionState["pendingBackgroundSessionStop"],
  frame: ChatActionAckFrame,
  turnActive: boolean,
): ChatSessionState["pendingBackgroundSessionStop"] {
  if (sessionStop === null) return null;
  if (sessionStop.clientActionId !== frame.clientActionId) return sessionStop;
  if (!sessionStop.awaitingTurnEnd) {
    // Phase two (the session-stop frame itself): either verdict ends the
    // in-flight state - on accept the panel empties via the host's broadcast,
    // on reject the generic errorNotice carries the host's reason.
    return null;
  }
  // Phase one (the turn stop). Accepted: keep waiting for the settled frame.
  // Rejected with the turn genuinely still running: the escalation is dead,
  // release it so Stop all re-enables. Rejected because the turn already
  // ended on its own (the NO_ACTIVE_TURN race): keep the slot - the
  // state-based dispatch that runs after every ack advances it to phase two.
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

// Keep only the per-item stops whose task is still in the host's running-only
// list; a task that has left the list reached its terminal and is no longer
// stopping. Returns the same reference when nothing changes so zustand skips a
// redundant notification.
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
 * Retract this host's blob acks for content a host refusal has just handed
 * back, so the resend re-uploads instead of shipping the same dead hashes.
 *
 * WHY THIS EXISTS. `confirmedBlobsByHost` records that a host acked a digest,
 * and the submit path skips the upload for anything it holds. The host's
 * staging tier sweeps on quota and idle age, so an entry can outlive the bytes.
 * That is not one lost message but a cycle with no exit: the refusal hands the
 * prompt back, the prompt carries the same hashes, the memo still says
 * confirmed, and the resend uploads nothing and is refused again. This call is
 * the exit.
 *
 * WHERE IT BELONGS - the class, enumerated by "returns refused content to the
 * composer" rather than by any one function name, because the first version of
 * this fix sat on the wrong door and its test passed by calling that door
 * directly:
 *
 *  1. THE LIVE SEND, and the only arm a `MISSING_ATTACHMENT_BYTES` refusal
 *     actually reaches. The host rejects the send FRAME
 *     (`chat-session-manager.ts:~24774`, `eventType: "send.failed"`); the
 *     renderer sees it in `onActionAck`, `rejectionRestoration` puts the
 *     content in `failedSendRestoration`, and the handoff driver hands it to
 *     the composer. Called from that rejection branch.
 *  2. THE SETUP-GATING RESTORE (`takeSetupFailedRestoration`), driven ONLY by
 *     `setup.failed` / `setup.cancelled`
 *     (`RESTORABLE_SETUP_INTERRUPTION_EVENT_TYPES`). No missing-bytes refusal
 *     emits either - both host sites emit `send.failed` - so this one is
 *     defensive: it restores hash-carrying content, and a resend of it would
 *     meet the same memo.
 *  3. THE QUEUED DRAIN is still not in this class, but it is no longer an open
 *     gap - it is answered somewhere else, and the reason is that it is not a
 *     RESTORE at all. `failQueuedPromptPreparation`
 *     (`chat-session-manager.ts:~25041`) writes a `send.failed` row and PAUSES
 *     the queue with the item retained: nothing is handed back to the composer,
 *     so there is no restore arm here to hang a retraction on. What closes it is
 *     `use-queued-prompt-blob-repair.ts` over `queued-prompt-blob-repair.ts`,
 *     which reads that durable row's typed metadata, retracts these same acks
 *     through {@link invalidateDraftBlobConfirmations}, re-uploads the named
 *     hashes and resumes the queue. It calls
 *     {@link invalidateDraftBlobConfirmations} directly rather than this helper
 *     because it is handed the missing HASHES by the host and has no restored
 *     document to walk.
 *  4. CANCELLING A SETUP-FAILED QUEUED ROW, which IS a restore and so belongs
 *     in this class (see {@link ChatSessionState.pendingCancelRestorations}).
 *     The accepted `queueCancel` hands the row's prompt to the composer, so its
 *     hashes are retracted exactly as a refused send's are. Arms 3 and 4 are
 *     the two answers a queued row can get, and they divide by what each hands
 *     back: arm 3 REPAIRS a row the user is keeping - it stays queued, the
 *     bytes are re-uploaded under it and the drain resumes - while this arm
 *     answers the user ABANDONING one, so the row goes and its content returns
 *     to the composer as the only copy left.
 *
 * EVERY refusal reaching arm 1, not only the missing-bytes code: nothing in the
 * renderer parses that code, and the two errors are not symmetric - an
 * over-forget costs one re-upload of bytes this window still holds, an
 * under-forget costs the loop above. Deliberately NOT called from the
 * connection-death restore paths in `chat-queue-reconciler.ts`: a dropped
 * socket is not the host retracting anything, and forgetting there would make
 * every reconnect-restored send re-upload.
 *
 * EVERY hash the document names, not only the ones it currently carries bare.
 * `blobHashesFromContent` is the wider of the two readings and the right one
 * HERE, by that same asymmetry: a node that still holds inline bytes today can
 * lose them to a reconcile sweep and be sent bare tomorrow, and it would then
 * consult exactly the ack this retraction failed to drop. The narrow reading
 * (`hashOnlyImageHashes`) belongs to the MARKING decision, where over-reach
 * would declare a digest undecodable that was never sent bare at all.
 */
function forgetRefusedContentBlobAcks(
  hostId: string,
  content: JsonContent,
): void {
  invalidateDraftBlobConfirmations(hostId, blobHashesFromContent(content));
}

/**
 * Resolves the restorable `send` record for a `messageId` across either
 * the `pendingActions` or `acceptedActions` map. Returns the matched
 * entry plus a non-null `content` reference so the caller can both
 * restore the prompt and clear the slot in a single update.
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
 * A chat session is "fully settled" when no turn is running, none is active,
 * and the queue is empty/idle. Used only by the render-send-as-pending check
 * below - the turn-completion refresh subscribers
 * (`lib/chats/chat-turn-completions.ts`) intentionally use their own looser
 * `turnEnded` (idle + no active turn; the queue may still be paused), so an
 * errored turn's parked queue still drives a completion refresh.
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

/**
 * Put the retry's optimistic queue row where the settled send's used to be.
 *
 * Only when the original had one. `shouldRenderSendAsOptimisticQueuedItem`
 * reads LIVE state, and by now the turn it was queued behind may have ended -
 * asking it again would invent a row for a send that never showed one, or drop
 * one the user has been looking at since before the refusal. What the original
 * did is the fact worth reproducing, so it is recorded on the recovery.
 */
function repaintOptimisticQueueRowForRetry(input: {
  readonly queue: ChatSessionState["queue"];
  readonly recovery: HashOnlyRecoveryState;
  readonly clientActionId: string;
  readonly content: JsonContent;
}): ChatSessionState["queue"] {
  if (!input.recovery.hadOptimisticQueueRow) return input.queue;
  const now = Date.now();
  return appendOptimisticQueuedItem(input.queue, {
    kind: "prompt",
    queueItemId: optimisticQueuedItemId(input.clientActionId),
    // The ORIGINAL message id, exactly as the transcript echo reuses it, so
    // the host's eventual queue snapshot reconciles onto the same row.
    messageId: input.recovery.messageId,
    message: {
      kind: "user",
      content: input.content,
      // Optimistic local echo only, exactly as the original row was built -
      // the host's `queue.added` reconciles it once it arrives.
      browserAnnotations: [],
    },
    sender: input.recovery.sender,
    settings: input.recovery.settings,
    // Frozen with the rest of the execution context, not re-read: this is the
    // same logical send, and the live selection has had a whole recovery to
    // move.
    accountContext: input.recovery.accountContext,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: now,
    updatedAt: now,
  });
}

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
  // Recorded FIRST, and unconditionally: the witness is evidence about the
  // source's write stream, not about the client's holdings, so an unheld or
  // unreachable row records exactly as a held one does - that is what stamps
  // a later first hydration correctly.
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
  // A no-op rather than `{}` if the row is unreachable: the caller has already
  // decided this event belongs to a persisted row rather than the live one, so
  // falling back would re-run that decision with a worse answer.
  const patch =
    rewriteMessageInPlace(
      state,
      message.messageId,
      (target) =>
        target.role === "assistant" ? { ...target, imageResolutions } : target,
      { charge: "now", witnesses },
    ) ?? {};
  // An APPLIED write stamps exactly - the applied witness names its own
  // sequence, and `rewriteWindowMessage` rewrote every holder, so every copy
  // of the record in the new window carries it.
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
  // `usage.updated` carries the live in-flight context usage so the
  // "% context left" composer chip can update during the turn. It must
  // NOT flow through the block accumulator (no message content to
  // append) and must NOT clear `liveAssistantMessage`. Validate the
  // event's turnId against activeTurn so a late-arriving emit from the
  // previous turn (possible on OpenCode's SSE event ordering) can't
  // pollute the new turn's chip.
  if (event.type === "usage.updated") {
    const activeTurnId = state.activeTurn?.turnId ?? null;
    if (activeTurnId !== null && event.turnId !== activeTurnId) {
      return {};
    }
    return { liveTurnUsage: event.usage };
  }
  // `turn.started` opens a new turn - drop the previous turn's live
  // value (it would briefly attribute the prior turn's number to the
  // new turn until its first usage.updated arrives). Always full reset.
  if (event.type === "turn.started") {
    if (state.liveTurnUsage === null) {
      return applyContentBlockDelta(state, event, witnesses);
    }
    const partial = applyContentBlockDelta(state, event, witnesses);
    return { ...partial, liveTurnUsage: null };
  }
  // `turn.completed` / `turn.stopped` / `turn.interrupted` / `error`:
  // CARRY the final usage forward instead of clearing. The persisted
  // assistant message's `usage` field doesn't land until the next
  // snapshot arrives (one network round-trip later), so clearing
  // immediately would briefly fall back to the PREVIOUS turn's
  // persisted usage - visible regression-then-jump on every turn end.
  // Keeping liveTurnUsage populated bridges the gap; it's cleared on
  // the next turn.started or snapshot (already wired above). For
  // turn.completed.usage carrying the final number, prefer it over the
  // previously cached liveTurnUsage to capture the authoritative value.
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

// The block id whose OWNING message a detached backgrounded-subagent event
// targets, plus whether that owner MUST already exist:
//   - `subagent.*` / `workflow.*` → the subagent block (`event.blockId`).
//   - a terminal `tool_call.*` / `command.completed` → its non-empty
//     `parentBlockId` when it is a subagent CHILD; otherwise its own `blockId`
//     (a genuinely top-level background terminal - Claude backgrounds through a
//     `tool_call`, Codex through a plain `command`).
//   - any other nested event  → its `parentBlockId`.
// Null for everything else (text/reasoning/top-level tool deltas), so the
// common high-frequency path skips the owner lookup.
//
// `workflow.*` is here because it is the SAME CARD: all three write a
// `subagent` block through `makeSubAgentBlock`, addressed by `event.blockId`,
// with `started` opening and `progress`/`completed` updating-or-synthesizing -
// the accumulator's workflow arm mirrors its subagent arm case for case. A
// Workflow run is a fleet that outlives its spawning turn exactly as a
// background subagent does, so leaving it out of this table was not a
// narrower policy, it was the same hazard with no guard on it.
//
// `ownerMustExist` decides what happens when the scan finds NO owner, and it
// says what it means rather than proxying it through how the owner is named.
// The distinction it draws is whether this event OPENS its own card or updates
// one:
//
//   - `subagent.started` / `workflow.started` open it - the FIRST time.
//     `accumulateTurnContent` builds the block FROM this event, so "no message
//     owns it" is the ordinary birth of every such card, not evidence of a
//     detached one. Dropping it there means the card is never created - and
//     then its own progress and completion have no owner either, so nothing
//     about that run ever renders. A REPEAT of one is an update wearing a
//     start's clothes and is held to the update rule instead; the caller
//     supplies that, since only the session's memory knows which it is (see
//     `ChatSessionState.openedSubagentCardBlockIds`).
//   - the matching `progress` / `completed` update it. They ALSO build a card
//     when none exists (see the accumulator), which is exactly the synthesis
//     that must not happen under an unrelated turn: their card's row is
//     evictable on the windowed line, so an ownerless one means gone, not new.
//   - a `parentBlockId` owner, or a parentless BACKGROUND terminal, belongs to
//     an older row for the same reason and never falls through.
//
// A parentless FOREGROUND terminal keeps the fall-through it has always had:
// with the active turn's own row consulted (see `activeTurnOwnsBlock`) a live
// call's terminal never reaches here, so what is left is a terminal whose
// `started` was genuinely never seen, and completing it beats stranding it.
// Does this event OPEN a subagent/workflow card, as opposed to updating one?
// Named because two places need the same answer for different reasons: the
// owner rule below, and the session memory that tells a first one from a
// repeat.
function isSubagentCardOpeningEvent(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: "subagent.started" | "workflow.started" }
> {
  return event.type === "subagent.started" || event.type === "workflow.started";
}

// The `subagent.*` / `workflow.*` arm, split out so the opens-versus-updates
// rule reads as two branches rather than a negated conjunction hidden in a
// flag - and so the parent function stays under the complexity ceiling as the
// pair grows. Both triples address the SAME card by their own `blockId`; the
// only thing that differs between them is which event opens it.
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
//
// The active turn writes to one of two places, and which one is not a detail
// this check can skip: `state.messages[assistantIndex]` once the turn has
// materialized a row, and `liveAssistantMessage` before it does - which is the
// ordinary case for a turn that is still streaming. `liveAssistantMessage` is
// NOT in `state.messages`, so a scan of `state.messages` alone answers "no row
// owns this block" for every card the active turn is currently building, and
// the detached branch then drops the turn's own tool calls and subagent cards.
//
// The live row counts only while it IS the active turn's. A completed turn's
// row stays visible after the next turn starts (see
// `liveAssistantForActiveTurnState`), and an event for a block it owns is not
// the active turn's to accumulate - letting it pass here would write that
// block into the NEW turn's row instead.
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

/**
 * Is this session on the windowed line?
 *
 * `transcriptDerived` is the discriminator because it is the one field only a
 * windowed snapshot sets and every windowed snapshot sets - the host computes
 * those folds precisely because a windowed client cannot. Named here so the
 * rule is stated once: it is read by the row appliers below, by the context
 * chip's usage selector, and by the composer-restore selector, and three
 * hand-written `transcriptDerived !== null` checks would be three places to
 * forget it.
 *
 * What it MEANS is the important part: on this line `state.messages` holds what
 * is HYDRATED, not what exists, and it is DERIVED - rebuilt from
 * `transcriptWindow` by `publishWindowedTranscript` on every windowed frame. So
 * "not found in `state.messages`" is not "absent", and a write to
 * `state.messages` is not a write at all.
 */
export function isWindowedTranscript<
  T extends Pick<ChatSessionState, "transcriptDerived">,
>(
  state: T,
): state is T & { readonly transcriptDerived: ChatTranscriptDerived } {
  return state.transcriptDerived !== null;
}

/**
 * Rows the chat is BLOCKED on - the hydration obligation the viewport cannot
 * express.
 *
 * A pending interview's answer card renders in the composer slot, off a
 * `streaming` interview block found by walking the rendered rows. Scrolling
 * never brings it into view, so viewport-driven hydration will not fetch it,
 * and a chat whose question sits outside the retained window has no affordance
 * at all: the card cannot render, and the dismiss notice is (correctly) held
 * back because the host says the question is answerable. Naming the ordinal is
 * what closes that.
 *
 * Intersected with the store's OWN pending list rather than taken from the
 * host's judgement wholesale. The two are the same set at the snapshot that
 * produced them, and they diverge afterwards in exactly one direction that
 * matters: an interview settled by a live frame is dropped from `state`
 * immediately, and re-fetching a row for a question already answered would be
 * work with nothing on the other end of it.
 *
 * Empty on the legacy line, where `transcriptDerived` is null and the whole
 * transcript is materialized anyway.
 */
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

/**
 * The ordinals hydration must reach beyond the viewport, as the STORE currently
 * holds them.
 *
 * Two sources, and they are here together because `planTranscriptHydration`
 * takes one list: the pending interviews' answer cards, and a transcript JUMP
 * whose target is cold.
 *
 * The jump one is not an optimization. A cross-tile jump waits for its target
 * to appear before it scrolls, and a scroll is what moves the viewport, which
 * is what drives hydration - so for a target outside the retained spans the
 * request waits on a row that nothing will ever ask for, and the jump parks
 * forever. Naming the ordinal here is what breaks that circle.
 */
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
 * `state.coldRewrittenMessageIds` with one more id, bounded.
 *
 * A new Set per call, because the value is state and the store's consumers
 * compare identities. The cap is what keeps this from being a leak on a long
 * session: the set exists only so a row's FIRST post-hydration appearance can
 * be classified, and the oldest entries are the ones least likely to still be
 * waiting for that. Dropping one costs a missed announcement, never
 * correctness.
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

/**
 * Rewrite one row in place, on whichever line this session is on.
 *
 * The shared path for the row-targeted delta appliers - an image resolving, a
 * detached subagent's card, a block carried to the frozen half of a split turn.
 * Each locates its own target (they key on a block, not a message id), then
 * hands the row and its rewrite here.
 *
 * On the windowed line the write goes into the WINDOW. That is not a detail of
 * where the data lives: `state.messages` is rebuilt from the window by the next
 * windowed frame of ANY kind, so an applier that spliced the published array
 * would have its work erased by the next skeleton chunk, index delta, range or
 * appended event - whichever arrived first. `05577d2f` settled that for records
 * arriving with no ordinal; this is the same rule for records that have one.
 *
 * `null` means the row is not reachable and the change is DROPPED. That is
 * sound rather than lossy, and only because of the host's emit-after-persist
 * invariant: the host wrote the row before it told us about the change, so the
 * `loadRange` that eventually hydrates that ordinal serves a body that already
 * contains it. Dropping loses nothing; applying to a copy the next frame
 * overwrites loses the same thing while looking like it worked.
 *
 * `charge` says when the window's byte figure is brought back in line, and it
 * follows from how often the caller runs rather than from what it wants. The
 * row-targeted appliers pass `"now"`. The ACTIVE TURN's streaming row passes
 * `"deferred"`, because charging it exactly would serialize a growing record
 * on every buffered delta - see `unsettledByteMessageIds` in
 * `transcript-window`.
 */
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
    // The row's span is evicted, so the delta is deliberately dropped: the
    // persisted host body carries it at the next hydration. What is NOT
    // recoverable is the fact that it happened - the row then first becomes
    // observable across a hydration-sequence bump, which every consumer reads
    // as "history arriving late". For the announcements hook that is the
    // difference between a screen-reader user hearing a detached background
    // task complete and never learning of it at all.
    //
    // Recorded rather than announced here: this is a pure reducer over a
    // record, and which of these is worth saying out loud is the hook's
    // question, not this function's.
    return { coldRewrittenMessageIds: withColdRewrite(state, messageId) };
  }
  return {
    transcriptWindow: applied.window,
    // `messages` only: republishing `events` from the same fold would hand
    // every event consumer a new array identity for a change that touched no
    // event.
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

/**
 * The host's code for "the Claude runtime was torn down under a running turn".
 *
 * Restated here rather than imported because the host is not on this side of
 * the wire, and `errorBlockSchema.code` is a free-form string with no enum to
 * share. The value is the contract; the host owns it (`CLAUDE_RUNTIME_DISPOSED`
 * in `claude-converter.ts`), and this fold is only a live mirror of a decision
 * the host has already made durably - a mismatch degrades to "the card lingers
 * until the next snapshot", never to wrong persisted state.
 */
const CLAUDE_RUNTIME_DISPOSED_ERROR_CODE = "CLAUDE_RUNTIME_DISPOSED";

/**
 * Drop the runtime-disposal errors that belong to ONE answered interview.
 *
 * Two conditions, and BOTH are needed. Either alone retires a truthful error.
 *
 * 1. POSITION - the target must be the disposal's nearest preceding interview.
 *    The row is not an interview boundary: a provider turn can ask more than
 *    once and both interview blocks land in the same row, so a turn that
 *    answers A, asks B, then dies holds `[A answered, B streaming, disposal]`.
 *    A row-wide filter would let an exact lifecycle frame for A retire the card
 *    that is B's only explanation, while B is still waiting on the user.
 *
 * 2. CHRONOLOGY - the target's settlement must be strictly LATER than the
 *    disposal. Answering does not end the turn: the continuation streams more
 *    text and tool calls into the same row and the runtime can die after all of
 *    it, giving `[A answered, text, disposal]` where A is STILL the nearest
 *    preceding interview. There the disposal is the honest terminal for the
 *    later work, and a stale or duplicate exact-settlement frame for A - which
 *    re-runs this fold, since the effective block stays answered - must leave
 *    it alone.
 *
 * `targetSettledAt` must be the CANONICAL acceptance time - the `resolvedAt` of
 * the lifecycle frame that speaks for the block's own settlement authority,
 * which the host derives from the durable settlement envelope. It must NOT be
 * the block's `timestamp`: the reducer advances that on every contributing
 * settlement, so a losing cleanup can drag it past a disposal the answer truly
 * predates, and a stamp-based guard would then delete a truthful error.
 *
 * STRICTLY later, not "at or after": both values are millisecond readings, so
 * equality cannot order them, and retiring on a tie erases an error the user
 * needed while retaining on a tie only leaves a stale card that the host's
 * authoritative row clears on the next snapshot.
 *
 * One known degradation, deliberately accepted: a LEGACY/partial lifecycle
 * tuple carries no `settlementId`, so the caller cannot confirm it speaks for
 * this block's authority and retains. The host has still retired the block
 * durably, so the next snapshot corrects it.
 *
 * The host owns the same predicate over the same array
 * (`withRuntimeDisposalRetiredForInterview` in `chat-session-manager.ts`); this
 * is the live mirror for a row the client already hydrated.
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
  // Mirror of the host's settlement projection: an ANSWERED interview resumes
  // the provider session on a fresh runtime, so the disposal error that was
  // waiting on this interview stops explaining why the turn stopped and starts
  // reading as "answering failed". The host removes it in the settlement's own
  // durable write; folding it here is what a client that already hydrated this
  // row needs, since a bounded windowed snapshot may never resend an
  // arbitrarily old row. The host stays the policy owner - this only makes its
  // accepted projection visible immediately.
  //
  // Only this code, and only the disposal correlated to THIS interview by both
  // position and chronology. An unrelated error and a still-actionable
  // `QUEUE_PAUSED_AFTER_ERROR` notice both stay, as do a later interview's own
  // disposal and one that followed work this answer released.
  if (!lifecycleFrameOwnsInterviewSettlement(updated, projection)) {
    return settled;
  }
  return withRuntimeDisposalRetiredForInterview(
    settled,
    targetIndex,
    projection.resolvedAt,
  );
}

/**
 * Whether this frame is entitled to date the settled interview's answer.
 *
 * Retirement needs a canonical acceptance time, and `resolvedAt` is only that
 * when the frame speaks for the block's OWN settlement authority. A frame
 * carrying a different settlementId is a loser or a stale duplicate of some
 * other settlement and says nothing about when THIS answer was accepted; a
 * legacy/partial tuple carries no settlementId at all. Both retain and wait
 * for the host's authoritative row, which has already made the durable call.
 *
 * Deliberately not the block's own `timestamp`: the reducer advances that on
 * every contributing settlement, so a losing cleanup can drag it past a
 * disposal the answer truly predates.
 */
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
  /**
   * The one row this pass rewrote, or `null` if it rewrote none.
   *
   * Reported rather than left to be recovered by diffing the two arrays,
   * because the windowed line needs to write that row back into
   * `transcriptWindow` and "whichever element changed identity" is a fact this
   * function already knows and the caller would have to re-derive.
   */
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

// Applies a block event to the frozen pre-split row of the active turn that
// owns it, when a steer split left that block still streaming there. A child
// event whose parent lives in such a row follows its parent (the accumulator
// creates it beside the parent). The sibling scan runs only when the active
// row does not own the block (a block's first event, or a carryover event).
// The row's timestamp is deliberately NOT advanced: the frozen row keeps its
// split-time position semantics (mirrors the host's carryover writer and the
// detached writer). Returns null when the event is not a carryover (caller
// falls through to active-row routing).
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
  // `{}` and not `null` when the row is unreachable: `null` here means "this is
  // not a carryover event", and the caller answers it by routing to the ACTIVE
  // row - which is the duplicate-card outcome this function exists to prevent.
  // A sibling we found but cannot write to is still a carryover.
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

// Finds the EARLIER assistant row of the same turn that owns this event's
// block (or its parent block) - the frozen pre-split row a steer split left
// behind while the block was still streaming. Restricted to same-turn rows so
// a provider blockId reused across turns (e.g. a resumed agent) can never
// resurrect an unrelated old row. Returns -1 when no sibling owns it.
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

// Apply a detached backgrounded-subagent event to the SETTLED message that owns
// its card (its spawning turn already ended), so the card keeps updating instead
// of being dropped (no active turn) or mis-applied to a later turn's row. Returns
// null when no message owns the block (caller falls back to active-turn routing).
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
              // Preserve the settled row's `timestamp` (its completed-at). A
              // detached subagent's later activity must NOT advance the turn's
              // completed-at / cache token - the host detached writer only
              // replaces blocks/blocksVersion, and this mirrors it so the turn
              // doesn't appear to "complete later".
            },
      { charge: "now", witnesses },
    ) ?? {}
  );
}

/**
 * Reduces a single runtime delta event onto the session state, and remembers
 * the cards it opened.
 *
 * The memory is kept HERE rather than inside the reducer because it is one
 * fact about one event kind, and every branch below would otherwise have to
 * carry it. Recorded only when the event actually landed - `applied === state`
 * is the reducer's own identity signal for "dropped" - so a start that was
 * refused (no active turn, say) does not leave a note that would make its
 * legitimate re-delivery look like a repeat.
 */
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
  // Detached backgrounded-subagent activity: its card lives in an earlier,
  // already-settled message. Route the event to that message when the active
  // turn's row does not own the block, so the card keeps updating live. Gated to
  // subagent-context events; the active turn's own subagent skips this.
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
    // A detached event whose owning message is gone must NOT fall through to
    // the active turn: the accumulator would append its terminal as a duplicate
    // top-level card on an unrelated turn. The owner is its only legitimate
    // target, so drop it (identity = no-op) instead.
    //
    // Gated on `ownerMustExist`, which is the direct question and not the
    // `parentBlockId`-versus-own-`blockId` proxy this used to read. That proxy
    // was sound only while the transcript was whole: on the windowed line a
    // `subagent.progress/completed` names its own card's block and that card's
    // row is EVICTABLE, so a background subagent outliving its spawning turn
    // finds its owner gone for a reason that has nothing to do with the event
    // - and synthesizes its progress or completion under whatever turn happens
    // to be active. Those two are `ownerMustExist` now, so they still drop.
    //
    // What must NOT drop is an event that opens its own card FOR THE FIRST
    // TIME, because "no owner" is its normal starting condition rather than
    // evidence of anything. `subagent.started` is that event, and dropping it
    // took the subagent card with it - see `detachedSubagentOwnerTarget`.
    //
    // A REPEAT of a start is the other thing entirely, and the exemption above
    // is a door it would otherwise walk straight through. The accumulator
    // deliberately accepts a `subagent.started` re-emitted after its turn has
    // COMPLETED - Codex resolves the agent nickname asynchronously and re-emits
    // when it lands - so on the windowed line that late arrival can find its
    // row evicted while a newer turn is running, which is the synthesis case
    // exactly. The session's own memory is what separates the two, because
    // nothing on the wire does: a `blockDelta` carries no turn identity, and a
    // re-emit is otherwise indistinguishable from a start.
    //
    // Dropping is safe precisely because eviction is recoverable: the row is
    // re-served whole by the range that re-hydrates it, carrying this update
    // already folded in. Falling through is not - it writes a card under a turn
    // that never spawned it, and no later frame corrects that.
    if (
      detachedTarget.ownerMustExist ||
      state.openedSubagentCardBlockIds.has(detachedTarget.ownerBlockId)
    ) {
      return state;
    }
  }
  // Steer-split carryover: a block that was still STREAMING when a steered
  // user message split the turn lives in an EARLIER assistant row of the SAME
  // turn (the split freezes that row and continues in a fresh one). Route the
  // block's later events - deltas, completion - to the row that owns it, so
  // the block completes in place above the steer bubble instead of
  // re-materializing as a duplicate in the continuation row.
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
    // The ACTIVE TURN's row - the highest-frequency writer in the store, and
    // the one the consumer sweep missed. It goes through the same window
    // write-through as the row-targeted appliers: `state.messages` is DERIVED
    // on the windowed line, so accumulating into it alone meant the next
    // appended event republished from the window and erased everything
    // streamed since the last snapshot. The row is at the tail and hydrated by
    // construction, which is why this reads as "always worked" - being
    // hydrated is what makes the write land, not what makes it survive.
    //
    // `deferred` because this runs per buffered delta on a GROWING row; the
    // byte figure is trued up before eviction reads it.
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
    // The turn already settled (activeTurn cleared - e.g. on disconnect, which
    // nulls activeTurn but keeps the not-yet-materialized live row). ONLY a
    // terminal turn event for that row may still apply here, finalizing its
    // in-flight blocks so it never freezes with a spinner. Every other event is
    // dropped, as before: with no active turn there is nothing legitimate for a
    // non-terminal delta to mutate, and admitting one would re-open a streaming
    // block on a frozen row. (A terminal turn event carries `turnId`; after the
    // narrow it is always present, so match it directly.)
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

/**
 * What `messages` becomes across a turn transition, on either line.
 *
 * The two lines differ in WHERE the records live, which is the whole reason
 * this is one function rather than a conditional at the call site. On the
 * windowed line both the frozen row and the steer remap have already been
 * applied to the window, so the published array is simply re-derived from it -
 * and re-derived only when the window actually moved, so an ordinary turn
 * transition hands subscribers the same array identity they already had. On
 * the legacy line there is no window, so the same two edits are made to the
 * array directly.
 */
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

/**
 * The per-record rewrite a steer restart implies, or `null` when it is a no-op.
 *
 * ONE definition with two appliers, because the two transcript lines hold their
 * records in different places: {@link messagesForTurnStateChange} maps the
 * legacy line's published array with it, and `mapWindowMessages` maps the
 * window with it. Stated once rather than twice - a second copy of a predicate
 * this quiet is the kind that drifts without either copy looking wrong.
 */
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

/**
 * The row a settling turn's live assistant must be frozen into, or `null`.
 *
 * Returns the RECORD rather than a rewritten array, because the two lines put
 * it in different places and only the caller knows which one it is on: the
 * legacy line appends it to `state.messages`, the windowed line appends it to
 * the window's live records. Handing back an array here is what made the
 * windowed line lose it - `state.messages` is derived from `transcriptWindow`
 * there, so the append survived only until the next windowed frame of any kind
 * republished the array from a window that never received the row.
 */
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
  // Invariant: a frozen (materialized) assistant row can never contain a
  // `streaming` action block. The terminal `blockDelta` normally finalizes the
  // live blocks before this runs (onTurnStateChanged flushes the delta buffer
  // first); this is the safety net for when that delta was dropped/reordered.
  // A genuine steer-restart never reaches here - it is handled by the terminal
  // delta plus the live-row remap to the new turn (the prev===live && next
  // guard above returns early), so this path cannot reliably distinguish
  // "superseded" from "interrupted" and uses the generic cut-off status. The
  // authoritative status (and any "superseded") arrives with the next snapshot.
  return assistantMessageFromLiveAssistant(liveAssistant, "interrupted");
}

function assistantMessageFromLiveAssistant(
  liveAssistant: LiveAssistantMessage,
  fallbackStatus: FinalizedActionStatus,
): Extract<Message, { role: "assistant" }> {
  // Spread converts the readonly live blocks to the mutable array the accumulator
  // signature takes (it does not mutate in place).
  const liveBlocks = [...liveAssistant.blocks];
  // Finalize the row's streaming blocks for this transient safety-net placeholder,
  // but keep a still-`streaming` (backgrounded) subagent card "running" - mirroring
  // the accumulator's terminal handling. Force-finalizing it to `interrupted` here
  // would briefly flicker a legitimately-running detached subagent until the host's
  // authoritative snapshot (which carries the real status) replaces this row.
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
    // This frozen row is a transient safety-net placeholder that the host's
    // authoritative snapshot replaces. Mark the stand-in id so fork actions can
    // wait for a durable assistant message id from persistence.
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
    // Unlike the two above - mirrored from `ChatActiveTurn`, which knows what
    // the user PICKED - the credential a spawn used is a host-side fact this
    // transient placeholder never receives. Left null rather than guessed: the
    // authoritative snapshot that replaces this row carries the real value, and
    // a wrong `null` here would only ever be visible for the moment before it.
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
