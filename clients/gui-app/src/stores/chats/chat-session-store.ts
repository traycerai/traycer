import {
  addAcceptedAction,
  confirmAcceptedSendByMessageId,
  noticeCarriesOnlyCopy,
  unrecoverableSendNotice,
  pruneAcceptedActions,
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
  applyIndexChange,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  appendLiveRecords,
  bodyInvalidatingOrdinals,
  emptyTranscriptWindow,
  evictTranscriptWindowToBudget,
  hydratedRecords,
  hydratedRowContext,
  isTailHydrated,
  mapWindowMessages,
  planTranscriptHydration,
  recordSharingOrdinals,
  streamWindowMessage,
  touchTranscriptRange,
  updateWindowMessage,
  TRANSCRIPT_WINDOW_MAX_BYTES,
  type OrdinalRange,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
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
  // The two windowed READS. Required rather than optional even though every
  // implementation but the real client is a test double: the store calls them
  // unconditionally, and an optional method invoked through `?.()` is a silent
  // no-op - which on this line means a chat that asks for its tail, never
  // sends the request, and renders empty forever.
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
 * What a send hands back to the composer if it never lands - the pre-submit
 * document plus the annotation cards that left with it. One value so a new
 * restorable composer artifact costs no call-site edits.
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
  // For `interviewAnswer` / `interviewError`, the interview block this action
  // targets; `null` for every other action. Lets the UI gate exactly the card
  // whose answer/skip is in flight (or accepted-but-unresolved) rather than all
  // interviews, and lets lifecycle resolution drop this block's stale actions.
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
  /**
   * Workspace selection consumed when a send goes on the wire. A rejected
   * send restores it to the owner's staging slot together with the composer
   * content, so retrying cannot silently fall back to the prior binding.
   */
  readonly restoreWorktreeIntent: WorktreeIntent | null;
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

export interface ChatSessionState {
  readonly epicId: string;
  readonly chatId: string;
  readonly connectionStatus: StreamConnectionStatus;
  /**
   * Set when the host terminates the `chat.subscribe` stream with a
   * `fatalError` (e.g. `CHAT_INVALID` / `CHAT_NOT_VISIBLE`, collapsed to code
   * `UNAUTHORIZED` on the wire). Drives the tile's error state instead of an
   * indefinite loading spinner when a snapshot never arrives. Cleared on every
   * fresh (re)connect attempt.
   */
  readonly fatalClose: FatalErrorDetails | null;
  readonly snapshotLoaded: boolean;
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
  /** `chat.subscribe@1.7` support for detached interview delivery retries. */
  readonly interviewDeliveryRetryProtocolSupported: boolean;
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
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
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
  readonly restore: ChatRestoreSlot | null;
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
  readonly failedSendRestoration: FailedSendRestorationState | null;
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
  sendMessage: (input: {
    readonly content: JsonContent;
    readonly sender: UserMessageSender;
    readonly settings: ChatRunSettings;
    readonly attachments: ReadonlyArray<Attachment>;
    readonly deliveryPolicy: ChatQueueDeliveryPolicy;
    readonly restore: ChatSendRestore;
  }) => SentChatMessageAction | null;
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
   * Record that a notice reached the screen. Called by the toast layer, which
   * is the only thing that knows - see {@link ChatSessionState.deliveredNoticeActionIds}.
   */
  markNoticeDelivered: (clientActionId: string) => void;
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
 * answer stays eligible to seat (see `outstandingHydrationRequests`), so this
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
 */
export const MAX_OUTSTANDING_HYDRATION_REQUESTS = 8;

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

export function createChatSessionStoreWithNotificationDependencies(
  options: ChatSessionStoreOptions,
  notificationDependencies: ChatSessionNotificationDependencies,
): ChatSessionStoreHandle {
  const notificationUserId = options.userId;
  let disposed = false;
  let streamClient: ChatStreamClientHandle | null = null;
  // Assigned synchronously inside the `create()` initializer below, where the
  // delta buffer lives; read by the handle's surface-visibility rollup.
  let flushLease: StreamFlushLease | null = null;
  let activeStreamGeneration = 0;
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
    activeStreamGeneration += 1;
    // A replaced client is a new connection - the old one's `closed` status
    // event is suppressed by the generation guard, so bump here too.
    connectionEpoch += 1;
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
      // and a deferral resolves on the very next range response.
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
          const partial = applyBlockDelta(merged, event);
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
    };

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

    const isCurrentStream = (streamGeneration: number): boolean =>
      !disposed && streamGeneration === activeStreamGeneration;

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
          failedSendRestoration: settled.failedSendRestoration,
          // Statements both reconcile passes owe the user: a send whose
          // restoration lost the single-slot race on reconnect, and a
          // stranded send the settled pass dropped without the slot.
          // Appended through the same ring/cap as the rejection path's
          // notice.
          errorNotices: appendErrorNoticeDelta(
            state.errorNotices,
            [...pending.appendedErrorNotices, ...settled.appendedErrorNotices],
            state.deliveredNoticeActionIds,
          ),
          restore: sweepStaleRestoreSlot(state.restore, connectionEpoch),
          snapshotLoaded: true,
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
    interface OutstandingHydrationRequest {
      readonly epoch: number;
      readonly range: OrdinalRange;
      /**
       * Ordinals inside `range` whose body a later frame invalidated while
       * this request was outstanding, or `"all"` for a `reindexed`. Clipped to
       * the request's own extent, so the set is bounded by what one response
       * can serve rather than by how long the request stays in flight.
       */
      readonly superseded: ReadonlySet<number> | "all";
    }

    /**
     * Every sent-and-unanswered request, newest last.
     *
     * Bounded by {@link MAX_OUTSTANDING_HYDRATION_REQUESTS} rather than left
     * to grow: entries leave on their answer, and a host that answers nothing
     * would otherwise accumulate one per timeout for the life of the tab. The
     * cap evicts the OLDEST, whose answer is the least likely to still be
     * coming - and dropping a record only costs the round trip a re-plan
     * already pays for, since an unrecorded response is discarded, never
     * seated.
     */
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

    const outstandingHydrationRequests = new Map<
      string,
      OutstandingHydrationRequest
    >();

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
     * Holds no staleness state of its own: that lives in
     * {@link outstandingHydrationRequests}, keyed by the id this names.
     */
    let inFlightHydrationRequest: {
      readonly requestId: string;
      readonly epoch: number;
      readonly range: OrdinalRange;
    } | null = null;

    /**
     * The epoch a `resnapshot` has already been asked for, so an invalidated
     * window asks once rather than once per frame.
     *
     * Invalidation is sticky until a snapshot clears it, and every windowed
     * callback ends in {@link requestPlannedHydration} - so without the latch
     * a skeleton chunk, an index delta and a range response arriving after the
     * same invalidation send three identical resnapshot requests, each
     * answered with a full bounded snapshot. Keyed by epoch rather than a bare
     * boolean because a second invalidation under a NEW epoch is a genuinely
     * new ask.
     */
    let resnapshotRequestedForEpoch: number | null = null;

    let resnapshotRequestTimer: number | null = null;

    const clearResnapshotRequest = (): void => {
      resnapshotRequestedForEpoch = null;
      if (resnapshotRequestTimer === null) return;
      window.clearTimeout(resnapshotRequestTimer);
      resnapshotRequestTimer = null;
    };

    /**
     * Ask for a `resnapshot`, at most one per epoch - and not forever.
     *
     * The latch is a dedup key, and it wedges for exactly the reason an
     * unanswered range request does (see {@link clearInFlightHydration}): a
     * request or its answer dropped on a stream that stays OPEN clears nothing,
     * and only a snapshot clears the latch - which is the very thing that is
     * not coming. The consequence is worse here than for a range, because an
     * invalidated window is the WHOLE transcript rather than one visible gap:
     * every ordinal belongs to a coordinate space this client has left, so
     * nothing on screen can be repaired until a snapshot lands.
     *
     * Same bounded wait, and the retry has TWO shapes because this request
     * serves two recoveries. Releasing the latch is enough for the invalidated
     * index: the next windowed frame re-plans, sees the invalidation and asks
     * again. It is not enough for a stalled summary stream, whose transcript is
     * valid and often fully hydrated - the planner measures the transcript, so
     * it looks at that state and asks for nothing. That one is re-armed on the
     * completion watchdog instead, inside the timeout below.
     *
     * A late answer to the abandoned request costs nothing either way - a
     * resnapshot is idempotent, and the snapshot it produces clears the latch
     * whichever request it answers.
     */
    const requestResnapshotOnceForEpoch = (epoch: number): void => {
      const client = streamClient;
      if (client === null) return;
      if (resnapshotRequestedForEpoch === epoch) return;
      clearResnapshotRequest();
      resnapshotRequestedForEpoch = epoch;
      resnapshotRequestTimer = window.setTimeout(() => {
        resnapshotRequestTimer = null;
        if (disposed || resnapshotRequestedForEpoch !== epoch) return;
        resnapshotRequestedForEpoch = null;
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
     * Deduped on the same `resnapshotRequestedForEpoch` latch the invalidated
     * index uses, and deliberately the SAME latch rather than a second one:
     * one resnapshot repairs both, so two independent latches would send two
     * for a frame that stales both at once.
     */
    const requestSummaryRestream = (): void => {
      requestResnapshotOnceForEpoch(get().transcriptWindow.epoch);
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
     * - The summaries are owed while the assembled count DISAGREES with
     *   `accumulatedFileChangeCount` - self-gating, because a chat with no
     *   accumulated changes promises none and `0 !== 0` is false.
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
      if (
        !state.accumulatedSummaryGenerationSeated &&
        state.accumulatedFileChangeCount > 0
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
        if (spent >= MAX_WATCHDOG_RESTREAMS_PER_EPOCH) return;
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
     * Releasing the slot says nothing about the request's ANSWER: its record
     * in `outstandingHydrationRequests` survives, so an answer that merely
     * took longer than the deadline still seats. Callers that mean "these
     * ordinals no longer name anything I can use" - a rebase, a downgrade -
     * must additionally call {@link forgetOutstandingHydration}.
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

    /**
     * Drop every outstanding request's staleness record, so any answer still
     * on the wire is discarded rather than seated.
     *
     * For the coordinate-space resets only, and "a snapshot arrived" is NOT
     * one of them. A downgrade leaves the windowed line entirely, and a
     * snapshot that REBASED (new epoch) or voided the index re-frames every
     * ordinal - in those, an ordinal an outstanding request was framed against
     * no longer denotes the row it did when the request was sent, and no
     * per-response check can notice.
     *
     * A same-epoch snapshot is a different animal and calling this for one is
     * a bug with a plausible comment: aux-only rebroadcasts come through the
     * same handler, preserve every span, and can overtake a large `loadRange`
     * answer on the BULK lane. Clearing then makes that still-valid answer
     * arrive untracked, `rangeResponseIsStale` rejects it, and a steady drip of
     * approvals or queue changes can discard every slow response in turn.
     */
    const forgetOutstandingHydration = (): void => {
      outstandingHydrationRequests.clear();
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
      outstandingHydrationRequests.set(requestId, {
        epoch: transcriptWindow.epoch,
        range: next,
        superseded: new Set<number>(),
      });
      while (
        outstandingHydrationRequests.size > MAX_OUTSTANDING_HYDRATION_REQUESTS
      ) {
        // Map iterates in insertion order, so this is the oldest record.
        const oldest = outstandingHydrationRequests.keys().next();
        if (oldest.done === true) break;
        outstandingHydrationRequests.delete(oldest.value);
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
      if (outstandingHydrationRequests.size === 0) return;
      const bodyInvalidated = bodyInvalidatingOrdinals(input.changes);
      // Against the window as the requests were framed against it - this runs
      // before the fold, and an `updated` never renumbers a row, so the turn a
      // widened ordinal belongs to is the same either side of it.
      const invalidated =
        bodyInvalidated === "all"
          ? bodyInvalidated
          : recordSharingOrdinals(get().transcriptWindow, bodyInvalidated);
      // EVERY outstanding request, not just the one holding the dedup slot. A
      // reindex invalidates whatever is in the air, and after a timeout the
      // slot no longer names the request whose answer is most likely to land
      // next - marking only that one would let an older answer seat a body
      // this frame just superseded.
      for (const [requestId, request] of outstandingHydrationRequests) {
        if (request.superseded === "all") continue;
        // Two ways a frame voids the whole coordinate space rather than some
        // rows in it, and they must be read together because
        // {@link applyIndexChange} folds them together for the same reason.
        //
        // A `reindexed` is the host saying so. A frame from a NEWER epoch is
        // this client discovering it: the frame that would have carried the new
        // space here was lost, so the reindex happened and was not seen. Either
        // way every outstanding request was framed against a space that no
        // longer exists, and the window is about to be voided at the new epoch -
        // so an answer to any of them is unseatable, and the record has to say
        // that rather than leave a late one looking merely untracked.
        if (invalidated === "all" || input.epoch > request.epoch) {
          outstandingHydrationRequests.set(requestId, {
            ...request,
            superseded: "all",
          });
          continue;
        }
        // An `updated` from an OLDER epoch says nothing about whether THIS
        // request's answer is still current: it describes rows in a coordinate
        // space the request was not framed against, and `applyIndexChange`
        // discards it for the same reason.
        if (input.epoch !== request.epoch) continue;
        // EXCLUSIVE at the top, because `request.range` is the planner's
        // `OrdinalRange` rather than the wire request built from it: the
        // request converts to the wire's inclusive bound by sending
        // `toOrdinal - 1`, so the highest ordinal a response can serve is
        // `range.toOrdinal - 1`. Testing `<=` here would let a delta one row
        // PAST the request supersede it, costing a discard and a re-fetch for
        // a row it never asked for.
        const inside = invalidated.filter(
          (ordinal) =>
            ordinal >= request.range.fromOrdinal &&
            ordinal < request.range.toOrdinal,
        );
        if (inside.length === 0) continue;
        outstandingHydrationRequests.set(requestId, {
          ...request,
          superseded: new Set([...request.superseded, ...inside]),
        });
      }
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
     * {@link forgetOutstandingHydration}) or the cap evicted it, and that is
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
    const rangeResponseIsStale = (response: ChatRangeResponse): boolean => {
      const request = outstandingHydrationRequests.get(response.requestId);
      if (request === undefined) return true;
      if (request.superseded === "all") return true;
      const servedEnd = response.fromOrdinal + response.rowIds.length;
      for (const ordinal of request.superseded) {
        if (ordinal >= response.fromOrdinal && ordinal < servedEnd) return true;
      }
      return false;
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
      // A `null` report only CLEARS the standing obligation - there is nothing
      // to fetch for "no placed row visible". Off the windowed line the value
      // is recorded (the line can be negotiated by a later reconnect) but no
      // request could mean anything yet.
      if (unchanged || range === null || !windowedLine || disposed) return;
      // Warm the LRU for what the reader is looking at BEFORE planning. An
      // already-hydrated visible span plans no fetch, so this report is the
      // only event that ever re-touches it - without it, returning to old
      // scrollback leaves it "coldest" for the next eviction even while it is
      // on screen.
      const window = get().transcriptWindow;
      const touched = touchTranscriptRange(window, range);
      if (touched !== window) set({ transcriptWindow: touched });
      requestPlannedHydration();
    };

    /**
     * Re-point `messages`/`events` at what the window now holds.
     *
     * The steady-state path for every windowed frame that changes hydration
     * without being authoritative about anything else.
     */
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
    };

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
          turnInProgress: current.turnInProgress,
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
        set({
          ...aux,
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

    const callbacks: ChatStreamCallbacks = {
      onSnapshot: (frame) => {
        if (!windowedLine) {
          // The legacy line's `messages` IS the transcript, so the scan is the
          // whole-transcript answer here and needs no host help.
          applyAuthoritativeSnapshot(
            frame,
            null,
            latestAssistantAuthFailureTurnKey(frame.snapshot.chat.messages),
          );
          return;
        }
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // A LEGACY snapshot on a session that had negotiated `1.8`: the
        // reconnect renegotiated onto an older line (a host rolled back below
        // `1.8`, or a fallback route to an older peer). The windowed state is
        // not stale-but-usable, it is unaddressable - no current peer serves
        // the epoch its ordinals live in, so stale placeholders could never
        // hydrate - and left in place it would make the appliers treat this
        // WHOLE transcript as a hydrated subset and merge it against a dead
        // skeleton. Drop all of it, atomically with the snapshot's own
        // publish (`extra` below), and fall back to the legacy shape the
        // discriminator now reports.
        windowedLine = false;
        clearInFlightHydration();
        clearStreamCompletionWatchdog();
        // Not merely unawaited: this line no longer HAS ordinals, so an answer
        // still in the air describes a coordinate space nothing here can read.
        forgetOutstandingHydration();
        clearResnapshotRequest();
        forgetDeferredWindowedSnapshot();
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
          },
          // A downgrade frame is a LEGACY snapshot - full records - so the
          // scan is again the whole-transcript answer.
          latestAssistantAuthFailureTurnKey(frame.snapshot.chat.messages),
        );
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
        // A fresh snapshot IS the answer an invalidated window was waiting
        // for, whether or not this one was sent in reply to that request.
        clearResnapshotRequest();
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
        const window = evictTranscriptWindowToBudget(
          applyWindowedSnapshot(get().transcriptWindow, {
            epoch: frame.snapshot.transcriptEpoch,
            rowCount: frame.snapshot.rowCount,
            indexRevision: frame.snapshot.indexRevision,
            tail: frame.snapshot.tail,
          }),
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
        // NOW the ledger decision, with the applied window in hand. An
        // outstanding request's ordinals stop denoting the rows they were
        // framed against exactly when the COORDINATE SPACE moves - which is
        // what the epoch versions - or when this snapshot voided the index
        // outright. In those two cases no per-response check could notice the
        // mismatch, so the records have to go. In every other case the
        // ordinals still mean what they meant and a slow answer is still a
        // valid answer.
        const rebased = window.epoch !== epochBeforeSnapshot;
        if (rebased || window.invalidated) {
          forgetOutstandingHydration();
        }
        // The dedup SLOT, on the same footing - and it was the half left behind.
        //
        // Releasing it unconditionally reads as harmless (it only permits a
        // re-plan) and is not, because the re-plan is not free: the gap is
        // still unhydrated while the answer is in the air, so the very same
        // range is planned again, and with the slot empty nothing suppresses
        // it. Each aux snapshot therefore mints one more `loadRange` for a
        // range already being answered, and each new request takes a ledger
        // entry - which is capped at {@link MAX_OUTSTANDING_HYDRATION_REQUESTS}
        // and evicts the OLDEST. Eight aux frames are enough to evict the
        // original request's own record, so the answer this client is waiting
        // for arrives untracked and `rangeResponseIsStale` discards it. Keeping
        // the ledger while releasing the slot preserved the record and then
        // pushed it out the back of the same ledger.
        //
        // The slot is a fact about the CONNECTION - it names a request sent on
        // it - which makes it per-SUBSCRIBER on the host, so it resets on the
        // documented rebuild signal and not on a snapshot's mere arrival. That
        // is the summary generation's rule and the watchdog deadline's rule,
        // for the same reason (see `applyWindowedSnapshot`'s "what
        // `indexRevision === null` means to each counter"): a reconnect mints a
        // fresh subscriber whose index state is `none`, and `null` is exactly
        // how that reaches this client. Its request really did die with the
        // previous connection, and the epoch can survive a reconnect - so
        // without this release an identical re-plan would be suppressed
        // forever.
        //
        // The other two are the ledger's own cases, kept in step deliberately:
        // an ordinal in a space this window has left cannot dedup anything, so
        // a slot holding one is a stale key rather than a live request.
        if (
          frame.snapshot.indexRevision === null ||
          rebased ||
          window.invalidated
        ) {
          clearInFlightHydration();
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
          // The retained array is now the PREVIOUS generation's, so it vouches
          // for nothing until a replacement chunk lands - including when its
          // length already equals the authoritative count.
          set({ accumulatedSummaryGenerationSeated: false });
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
        // BEFORE the fold, because it reads the epoch the in-flight request
        // was framed against and the fold can move it.
        supersedeInFlightHydration({
          epoch: frame.epoch,
          changes: frame.changes,
        });
        const window = applyIndexChange(get().transcriptWindow, {
          epoch: frame.epoch,
          rowCount: frame.rowCount,
          indexRevision: frame.indexRevision,
          changes: frame.changes,
        });
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
        outstandingHydrationRequests.delete(frame.range.requestId);
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
          // Seat nothing. The ordinals stay unhydrated, so the re-plan below
          // asks for them again - which is the whole point: a discarded
          // response costs a round trip, a seated stale one costs a row that
          // never corrects itself.
          requestPlannedHydration();
          return;
        }
        const window = evictTranscriptWindowToBudget(
          applyRangeResponse(get().transcriptWindow, frame.range),
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
            requestSummaryRestream();
            return;
          }
          accumulatedSummaryGeneration = frame.chunk.generation;
        }
        set((state) => {
          const assembled = state.accumulatedFileChangeSummaries;
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
          if (frame.chunk.fromIndex > assembled.length) {
            requestSummaryRestream();
            return {};
          }
          const summaries = [
            ...assembled.slice(0, frame.chunk.fromIndex),
            ...frame.chunk.summaries,
          ];
          return {
            accumulatedFileChangeSummaries: summaries,
            accumulatedSummaryGenerationSeated: true,
          };
        });
        // The gap check above only fires when a LATER chunk exposes the hole,
        // so it cannot see the stream simply stopping. Armed after the `set`
        // so the watchdog reads the assembled length this chunk produced.
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
        // Asked BEFORE the hand-back below, because a successful restore
        // stages the survivors through `setIntent`, and every user-mutation
        // Read BEFORE anything below stages or clears, because the evidence
        // is destroyed by the very operation it describes: the restore stages
        // survivors through the staging store, and that write drops the
        // dispatch mark and the swept-refs record with it. Reading afterwards
        // finds an empty record and says nothing was swept - which is how the
        // partial sentence went missing once already.
        const rejectionSweep = worktreeSweepFor(
          rejectedPending?.restoreWorktreeIntent ?? null,
          worktreePartition,
          false,
        );
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
                pending.messageId !== null &&
                  messageExists(state.messages, pending.messageId),
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
          // The fifth confirmation door. Applied on BOTH arms: whether the
          // message is new to us or already in `messages`, the frame is the
          // host reporting it in the transcript, and that is the fact the
          // stamp records.
          const acceptedActions = confirmAcceptedSendByMessageId(
            state.acceptedActions,
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
              pendingUserMessages,
              queue: removeOptimisticQueuedItemByMessageId(
                state.queue,
                frame.message.messageId,
              ),
            };
          }
          return {
            acceptedActions,
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
        }
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
            acceptedActions: pruneAcceptedActions(
              {
                ...state.acceptedActions,
                // Confirmation stamps for records that were already accepted
                // when this frame arrived, then this pass's own transitions.
                ...patch.confirmedAcceptedActions,
                ...patch.acceptedActions,
              },
              now,
            ),
            pendingUserMessages: patch.pendingUserMessages,
          };
        });
        // The AUTHORITATIVE queue, not the merged one the store now holds:
        // that is what the deferred fold's own merge takes as its input, and
        // handing it a list the optimistic items are already in would keep an
        // item whose pending action has since settled.
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
              : mapWindowMessages(seated, remap);
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
            messages: nextMessages,
            // Same object when nothing above touched it, so the windowed
            // subscribers that compare by identity see no change on the
            // ordinary turn transition.
            transcriptWindow: nextWindow,
            runStatus: frame.runStatus,
            activeTurn: frame.activeTurn,
            turnInProgress: frame.turnInProgress ?? state.turnInProgress,
            backgroundItems: nextBackgroundItems,
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
          // Frames dispatched on the lost connection can no longer be
          // answered. Only stamps get older here - nothing is cancelled
          // until an authoritative post-reconnect snapshot arrives.
          connectionEpoch += 1;
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

    const makeCallbacks = (streamGeneration: number): ChatStreamCallbacks => ({
      onSnapshot: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onSnapshot(frame);
        const activeTurnId = get().activeTurn?.turnId ?? null;
        if (activeTurnId !== null && activeTurnId !== fatalCloseTurnId) {
          fatalCloseTurnId = null;
        }
      },
      onWorktreeStateChanged: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onWorktreeStateChanged(frame);
      },
      onManagedCommandsChanged: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onManagedCommandsChanged(frame);
      },
      onHeldUpdatesChanged: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onHeldUpdatesChanged(frame);
      },
      // Guarded like every frame above rather than passed through: whatever
      // binds these must not apply a hydration response from a stream
      // generation this store has already replaced.
      onWindowedSnapshot: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onWindowedSnapshot(frame);
      },
      onSkeletonChunk: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onSkeletonChunk(frame);
      },
      onIndexChanged: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onIndexChanged(frame);
      },
      onRange: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onRange(frame);
      },
      onAccumulatedChanges: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onAccumulatedChanges(frame);
      },
      onActionAck: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onActionAck(frame);
      },
      onMessageAccepted: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onMessageAccepted(frame);
      },
      onQueueChanged: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onQueueChanged(frame);
      },
      onTurnStateChanged: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onTurnStateChanged(frame);
        const activeTurnId = get().activeTurn?.turnId ?? null;
        if (activeTurnId !== null && activeTurnId !== fatalCloseTurnId) {
          fatalCloseTurnId = null;
        }
      },
      onBlockDelta: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onBlockDelta(frame);
      },
      onApprovalRequested: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onApprovalRequested(frame);
      },
      onApprovalResolved: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onApprovalResolved(frame);
      },
      onFileEditApprovalRequested: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onFileEditApprovalRequested(frame);
      },
      onFileEditApprovalResolved: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onFileEditApprovalResolved(frame);
      },
      onInterviewRequested: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onInterviewRequested(frame);
      },
      onInterviewAnswered: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onInterviewAnswered(frame);
      },
      onInterviewErrored: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onInterviewErrored(frame);
      },
      onEventAppended: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onEventAppended(frame);
      },
      onRestoreStarted: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onRestoreStarted(frame);
      },
      onRestoreProgress: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onRestoreProgress(frame);
      },
      onRestoreCompleted: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onRestoreCompleted(frame);
      },
      onErrorNotice: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onErrorNotice(frame);
      },
      onConnectionStatus: (status, reason) => {
        if (!isCurrentStream(streamGeneration)) return;
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
        callbacks.onConnectionStatus(status, reason);
      },
    });

    const createStreamClient = (): ChatStreamClientHandle => {
      activeStreamGeneration += 1;
      const streamGeneration = activeStreamGeneration;
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
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId,
            restore: input.restore,
            sender: input.sender,
            settings: input.settings,
            accountContext: frame.accountContext,
            restoreWorktreeIntent: worktreeIntent,
            deliveryPolicy: frame.deliveryPolicy,
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
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId: input.messageId,
            restore: { content: input.content, browserAnnotations: [] },
            sender: input.sender,
            settings: input.settings,
            restoreWorktreeIntent: null,
            // The DISPATCHED context, not a default. A Team-billed first
            // message that strands would otherwise report that it was going
            // to bill personal - a drift statement lying about the very thing
            // it exists to warn about.
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
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId,
            restore: null,
            sender: null,
            settings: null,
            restoreWorktreeIntent: worktreeIntent,
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
            interviewBlockId: null,
            interviewDeliveryRetry: null,
            messageId: null,
            restore: null,
            sender: null,
            settings: null,
            restoreWorktreeIntent: null,
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
        return sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "queueCancel"),
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
          pending: basicPending(clientActionId, "restoreCheckpoint"),
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
        forgetOutstandingHydration();
        clearResnapshotRequest();
        clearStreamCompletionWatchdog();
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

function basicPending(
  clientActionId: string,
  action: ChatOwnerActionFrame["kind"],
): PendingChatActionSeed {
  return {
    clientActionId,
    action,
    interviewBlockId: null,
    interviewDeliveryRetry: null,
    messageId: null,
    restore: null,
    sender: null,
    settings: null,
    restoreWorktreeIntent: null,
    accountContext: null,
    deliveryPolicy: null,
    createdAt: Date.now(),
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
): Partial<ChatSessionState> {
  return event.type === "image_resolution.updated"
    ? applyImageResolutionDelta(state, event)
    : applyContentDelta(state, event);
}

function applyImageResolutionDelta(
  state: ChatSessionState,
  event: Extract<RuntimeEvent, { type: "image_resolution.updated" }>,
): Partial<ChatSessionState> {
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
  return (
    rewriteMessageInPlace(
      state,
      message.messageId,
      (target) =>
        target.role === "assistant" ? { ...target, imageResolutions } : target,
      "now",
    ) ?? {}
  );
}

function applyContentDelta(
  state: ChatSessionState,
  event: Exclude<RuntimeEvent, { type: "image_resolution.updated" }>,
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
      return applyContentBlockDelta(state, event);
    }
    const partial = applyContentBlockDelta(state, event);
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
    const partial = applyContentBlockDelta(state, event);
    const finalUsage =
      event.type === "turn.completed" && event.usage !== undefined
        ? event.usage
        : state.liveTurnUsage;
    return finalUsage === state.liveTurnUsage
      ? partial
      : { ...partial, liveTurnUsage: finalUsage };
  }
  return applyContentBlockDelta(state, event);
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
  charge: "now" | "deferred",
): Partial<ChatSessionState> | null {
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
      ? streamWindowMessage(state.transcriptWindow, messageId, update)
      : updateWindowMessage(state.transcriptWindow, messageId, update);
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
  if (updated === block) return blocks;
  const next = blocks.slice();
  next[targetIndex] = updated;
  return next;
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
      "now",
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
      "now",
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
): Partial<ChatSessionState> {
  const applied = reduceContentBlockDelta(state, event);
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
      "deferred",
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
