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
  AssistantMessage,
  Chat,
  ChatEvent,
  ContentBlock,
  ImageResolutionEntry,
  InterviewAnswer,
  Message,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import { v4 as uuidv4 } from "uuid";
import { create, type StoreApi, type UseBoundStore } from "zustand";

type ChatStreamClientHandle = Pick<
  ChatStreamClient,
  "sendAction" | "close" | "sameTurnSteeringProtocolSupported"
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
type ChatSessionSetState = StoreApi<ChatSessionState>["setState"];
type ChatSessionGetState = StoreApi<ChatSessionState>["getState"];
type SendActionInput = {
  readonly set: ChatSessionSetState;
  readonly get: ChatSessionGetState;
  readonly frame: ChatOwnerActionFrame;
  readonly pending: PendingChatActionSeed;
  readonly pendingUserMessage: PendingUserMessage | null;
};

export interface PendingUserMessage {
  readonly clientActionId: string;
  readonly messageId: string;
  readonly content: JsonContent;
  readonly sender: UserMessageSender;
  readonly settings: ChatRunSettings;
  readonly timestamp: number;
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
  readonly restoreContent: JsonContent | null;
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
  readonly restoreContent: JsonContent | null;
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
  readonly chat: Chat | null;
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
  retry: () => void;
  sendMessage: (
    content: JsonContent,
    sender: UserMessageSender,
    settings: ChatRunSettings,
    deliveryPolicy: ChatQueueDeliveryPolicy,
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
   * `acceptedActions` entries have their `restoreContent` field nulled
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
    pending.restoreContent !== null
  ) {
    return unrecoverableSendNotice({
      clientActionId: input.frame.clientActionId,
      content: pending.restoreContent,
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
  if (pending.restoreContent === null) return null;
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
  if (pending?.action !== "send" || pending.restoreContent === null) {
    return null;
  }
  return {
    clientActionId: frame.clientActionId,
    content: pending.restoreContent,
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

    const nudgeProviderAuthFromPersistedError = (
      messages: ReadonlyArray<Message>,
    ): void => {
      if (options.onProviderAuthError === null) return;
      const lastAssistant = messages.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      );
      if (lastAssistant === undefined) return;
      const turnKey = lastAssistant.turnId ?? lastAssistant.messageId;
      if (nudgedAuthErrorTurnId === turnKey) return;
      const hasAuthError = lastAssistant.blocks.some(
        (block) => block.type === "error" && block.code === AUTH_ERROR_CODE,
      );
      if (!hasAuthError) return;
      nudgedAuthErrorTurnId = turnKey;
      options.onProviderAuthError();
    };

    const applyBufferedDeltas = (): void => {
      if (bufferedDeltas.length === 0) return;
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

    const callbacks: ChatStreamCallbacks = {
      onSnapshot: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        nudgeProviderAuthFromPersistedError(frame.snapshot.chat.messages);
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
          const acceptedActions =
            withoutSupersededInterviewDeliveryRetryActions(
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
            chat: {
              ...frame.snapshot.chat,
              messages: [...messages],
            },
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
              [
                ...pending.appendedErrorNotices,
                ...settled.appendedErrorNotices,
              ],
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
      },
      onWorktreeStateChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set({
          worktreeBinding: frame.worktreeBinding,
          missingWorktreePaths: frame.missingWorktreePaths,
        });
      },
      onManagedCommandsChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // The frame carries the whole set, so a dropped one can never strand a
        // stale row - the next frame replaces everything either way.
        set({ managedCommands: frame.managedCommands });
      },
      onHeldUpdatesChanged: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // Whole set, same as the command list above: a hold clearing is the
        // ABSENCE of a row, so a delta shape would need a removal frame the
        // host has no reason to send.
        set({ heldUpdates: frame.heldUpdates });
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
          if (messageExists(state.messages, frame.message.messageId)) {
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
          const baseMessages = messagesWithMaterializedLiveAssistant(
            state.messages,
            state.liveAssistantMessage,
            {
              previousActiveTurnId: previousTurnId,
              nextActiveTurnId: nextTurnId,
            },
          );
          const nextMessages = messagesForTurnStateChange(baseMessages, {
            previousTurnId,
            nextTurnId,
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
      },
      onInterviewAnswered: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // Authoritative resolution boundary: the host accepted the answer, so
        // the retained draft is now safe to discard (the card unmounts as the
        // interview leaves the pending set). Also drop this block's pending/
        // accepted actions so their busy gate can never outlive the interview.
        useInterviewDraftStore
          .getState()
          .clearDraft(frame.chatId, frame.blockId);
        set((state) => {
          const messages = withInterviewLifecycleProjection(state.messages, {
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
          const liveAssistantMessage = withLiveInterviewLifecycleProjection(
            state.liveAssistantMessage,
            {
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
            },
          );
          return {
            messages,
            liveAssistantMessage,
            pendingInterviews: withoutPendingInterview(
              state.pendingInterviews,
              frame.blockId,
            ),
            pendingActions: withoutInterviewActionsForBlock(
              state.pendingActions,
              frame.blockId,
            ),
            acceptedActions: withoutSupersededInterviewDeliveryRetryActions(
              withoutInterviewActionsForBlock(
                state.acceptedActions,
                frame.blockId,
              ),
              messages,
              liveAssistantMessage,
              null,
            ),
          };
        });
      },
      onInterviewErrored: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        // The interview is resolved (skipped/errored) authoritatively; drop the
        // retained draft and this block's actions on the same lifecycle
        // boundary as an accepted answer.
        useInterviewDraftStore
          .getState()
          .clearDraft(frame.chatId, frame.blockId);
        set((state) => {
          const messages = withInterviewLifecycleProjection(state.messages, {
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
          const liveAssistantMessage = withLiveInterviewLifecycleProjection(
            state.liveAssistantMessage,
            {
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
            },
          );
          return {
            messages,
            liveAssistantMessage,
            pendingInterviews: withoutPendingInterview(
              state.pendingInterviews,
              frame.blockId,
            ),
            pendingActions: withoutInterviewActionsForBlock(
              state.pendingActions,
              frame.blockId,
            ),
            acceptedActions: withoutSupersededInterviewDeliveryRetryActions(
              withoutInterviewActionsForBlock(
                state.acceptedActions,
                frame.blockId,
              ),
              messages,
              liveAssistantMessage,
              null,
            ),
          };
        });
      },
      onEventAppended: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
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
      failedSendRestoration: null,
      currentComposerSettings: null,
      liveAssistantMessage: null,
      liveTurnUsage: null,
      worktreeBinding: null,
      missingWorktreePaths: [],

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
      sendMessage: (content, sender, settings, deliveryPolicy) => {
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
        const frame: ChatOwnerActionFrame = {
          kind: "send",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          messageId,
          content,
          sender,
          settings,
          accountContext: useAccountContextStore.getState().accountContext,
          deliveryPolicy,
          worktreeIntent,
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
            restoreContent: content,
            sender,
            settings,
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
                content,
                sender,
                settings,
                timestamp: Date.now(),
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
          content,
          sender,
          settings,
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
            restoreContent: input.content,
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
            sender: input.sender,
            settings: input.settings,
            accountContext: frame.accountContext,
            deliveryPolicy: frame.deliveryPolicy,
            timestamp: Date.now(),
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
            restoreContent: null,
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
            restoreContent: null,
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
        // themselves stay in place - only their `restoreContent` slot is
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
                    restoreContent: null,
                  },
                },
          acceptedActions:
            acceptedActionMatch === null
              ? state.acceptedActions
              : {
                  ...state.acceptedActions,
                  [acceptedActionMatch.entry.clientActionId]: {
                    ...acceptedActionMatch.entry,
                    restoreContent: null,
                  },
                },
        });
        return restored;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        unsubscribeLiveCompletionAcknowledgements();
        lease.unregister();
        clearBufferedDeltas();
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
    restoreContent: null,
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
    readonly restoreContent: JsonContent | null;
  },
>(
  entries: ReadonlyArray<T>,
  messageId: string,
): { readonly entry: T; readonly content: JsonContent } | null {
  for (const entry of entries) {
    if (
      entry.action === "send" &&
      entry.messageId === messageId &&
      entry.restoreContent !== null
    ) {
      return { entry, content: entry.restoreContent };
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
  const messages = state.messages.slice();
  messages[messageIndex] = { ...message, imageResolutions };
  return { messages };
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
// targets, plus whether routing to that owner is MANDATORY:
//   - `subagent.*`             → the subagent block (`event.blockId`).
//   - a terminal `tool_call.*` / `command.completed` → its non-empty
//     `parentBlockId` when it is a subagent CHILD; otherwise its own `blockId`
//     (a genuinely top-level background terminal - Claude backgrounds through a
//     `tool_call`, Codex through a plain `command`).
//   - any other nested event  → its `parentBlockId`.
// `mandatory` is set whenever the owner comes from `parentBlockId` or from a
// parentless background tool terminal: such an event belongs to an older row
// and must NEVER fall through to the active turn, where the accumulator would
// mint a duplicate top-level card for it.
// Null for everything else (text/reasoning/top-level tool deltas), so the
// common high-frequency path skips the owner lookup.
function detachedSubagentOwnerTarget(
  event: RuntimeEvent,
): { readonly ownerBlockId: string; readonly mandatory: boolean } | null {
  const parentBlockId =
    "parentBlockId" in event &&
    typeof event.parentBlockId === "string" &&
    event.parentBlockId.length > 0
      ? event.parentBlockId
      : null;
  if (
    event.type === "subagent.started" ||
    event.type === "subagent.progress" ||
    event.type === "subagent.completed"
  ) {
    return { ownerBlockId: event.blockId, mandatory: false };
  }
  if (
    event.type === "tool_call.completed" ||
    event.type === "tool_call.errored" ||
    event.type === "command.completed"
  ) {
    if (parentBlockId !== null) {
      return { ownerBlockId: parentBlockId, mandatory: true };
    }
    return {
      ownerBlockId: event.blockId,
      mandatory: "backgroundTask" in event && event.backgroundTask === true,
    };
  }
  if (parentBlockId !== null) {
    return { ownerBlockId: parentBlockId, mandatory: true };
  }
  return null;
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
): ReadonlyArray<ContentBlock> {
  const next = blocks.map((block): ContentBlock => {
    if (block.type !== "interview" || block.blockId !== projection.blockId) {
      return block;
    }
    if (
      block.settlement !== null &&
      projection.settlementId !== null &&
      block.settlement.settlementId !== projection.settlementId
    ) {
      return block;
    }
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
      return reduced.changed ? { ...block, ...reduced.patch } : block;
    }
    if (block.settlement !== null) return block;
    const delivery = block.delivery;
    return projection.kind === "answered"
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
  });
  return next.some((block, index) => block !== blocks[index]) ? next : blocks;
}

function withInterviewLifecycleProjection(
  messages: ReadonlyArray<Message>,
  projection: InterviewLifecycleProjection,
): ReadonlyArray<Message> {
  const next = messages.map((message): Message => {
    if (message.role !== "assistant") return message;
    const blocks = withInterviewLifecycleBlocks(message.blocks, projection);
    if (blocks === message.blocks) return message;
    return { ...message, blocks: [...blocks] };
  });
  return next.some((message, index) => message !== messages[index])
    ? next
    : messages;
}

function withLiveInterviewLifecycleProjection(
  message: LiveAssistantMessage | null,
  projection: InterviewLifecycleProjection,
): LiveAssistantMessage | null {
  if (message === null) return null;
  const blocks = withInterviewLifecycleBlocks(message.blocks, projection);
  return blocks === message.blocks ? message : { ...message, blocks };
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
  const next = state.messages.slice();
  next[siblingIndex] = {
    ...sibling,
    blocks: content.blocks,
    ...(sibling.blocksVersion === undefined
      ? {}
      : { blocksVersion: content.blocksVersion }),
  };
  return { messages: next };
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
  const next = state.messages.slice();
  next[index] = {
    ...target,
    blocks: content.blocks,
    ...(target.blocksVersion === undefined
      ? {}
      : { blocksVersion: content.blocksVersion }),
    // Preserve the settled row's `timestamp` (its completed-at). A detached
    // subagent's later activity must NOT advance the turn's completed-at / cache
    // token - the host detached writer only replaces blocks/blocksVersion, and
    // this mirrors it so the turn doesn't appear to "complete later".
  };
  return { messages: next };
}

// Reduces a single runtime delta event onto the session state. The branches map
// one-to-one to the distinct block/delta kinds; flattening that mapping is
// clearer than threading the dispatch through extra indirection.
// eslint-disable-next-line complexity
function applyContentBlockDelta(
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
    !(
      assistantIndex >= 0 &&
      assistantMessageOwnsBlock(
        state.messages[assistantIndex],
        detachedTarget.ownerBlockId,
      )
    )
  ) {
    const routed = applyEventToOwningMessage(
      state,
      event,
      detachedTarget.ownerBlockId,
    );
    if (routed !== null) return routed;
    // A parented (subagent-child) event whose owning message is gone must NOT
    // fall through to the active turn: the accumulator would append its
    // terminal as a duplicate top-level card on an unrelated turn. The settled
    // subagent owner is its only legitimate target, so drop it (identity =
    // no-op) instead.
    if (detachedTarget.mandatory) return state;
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
    // Index-targeted update: copy the messages array once (slice is O(N)
    // but allocates only the spine, not the elements) and replace exactly
    // the streaming row. Avoids the prior `.map` which re-creates every
    // unchanged element on every text delta.
    const content = accumulateTurnContent(
      {
        blocks: target.blocks,
        blocksVersion: target.blocksVersion ?? 0,
      },
      event,
    );
    if (content.blocks === target.blocks) return state;
    const next = state.messages.slice();
    next[assistantIndex] = {
      ...target,
      blocks: content.blocks,
      ...(target.blocksVersion === undefined
        ? {}
        : { blocksVersion: content.blocksVersion }),
      timestamp: event.timestamp,
    };
    return {
      messages: next,
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

function messagesForTurnStateChange(
  messages: ReadonlyArray<Message>,
  turnIds: {
    readonly previousTurnId: string | null;
    readonly nextTurnId: string | null;
  },
): ReadonlyArray<Message> {
  if (
    turnIds.previousTurnId === null ||
    turnIds.nextTurnId === null ||
    turnIds.previousTurnId === turnIds.nextTurnId
  ) {
    return messages;
  }
  return messages.map((message) =>
    message.role === "assistant" && message.turnId === turnIds.previousTurnId
      ? { ...message, turnId: turnIds.nextTurnId }
      : message,
  );
}

function messagesWithMaterializedLiveAssistant(
  messages: ReadonlyArray<Message>,
  liveAssistant: LiveAssistantMessage | null,
  turnIds: {
    readonly previousActiveTurnId: string | null;
    readonly nextActiveTurnId: string | null;
  },
): ReadonlyArray<Message> {
  if (liveAssistant === null) return messages;
  if (liveAssistantCoveredByMessages(liveAssistant, messages)) return messages;
  if (
    turnIds.nextActiveTurnId !== null &&
    liveAssistant.turnId === turnIds.nextActiveTurnId
  ) {
    return messages;
  }
  if (
    turnIds.previousActiveTurnId !== null &&
    liveAssistant.turnId === turnIds.previousActiveTurnId &&
    turnIds.nextActiveTurnId !== null
  ) {
    return messages;
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
  return [
    ...messages,
    assistantMessageFromLiveAssistant(liveAssistant, "interrupted"),
  ];
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
