import {
  addAcceptedAction,
  pruneAcceptedActions,
  reconcileQueueChange,
  reconcileSnapshotChange,
  sweepStalePendingActions,
  withoutPendingAction,
} from "@/stores/chats/chat-queue-reconciler";
import {
  appendOptimisticQueuedItem,
  mergeQueueWithOptimisticQueuedItems,
  optimisticQueuedItemId,
  removeOptimisticQueuedItemByClientActionId,
  removeOptimisticQueuedItemByMessageId,
} from "@/stores/chats/optimistic-queue";
import type {
  StreamFlushCoordinator,
  StreamFlushLease,
} from "@/stores/chats/stream-flush-coordinator";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import {
  readStagedWorktreeIntent,
  stagedWorktreeIntentRevision,
  stagedWorktreeIntentIsSuspended,
  useWorktreeIntentStagingStore,
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
import type { RestoreResultEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  PermissionMode,
  TokenUsage,
} from "@traycer/protocol/persistence/epic/foundation";
import type {
  Chat,
  ChatEvent,
  ContentBlock,
  InterviewAnswer,
  Message,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import { v4 as uuidv4 } from "uuid";
import { create, type StoreApi, type UseBoundStore } from "zustand";

type ChatStreamClientHandle = Pick<ChatStreamClient, "sendAction" | "close">;

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
}

export interface PendingChatAction {
  readonly clientActionId: string;
  readonly action: ChatOwnerActionFrame["kind"];
  readonly messageId: string | null;
  readonly restoreContent: JsonContent | null;
  readonly sender: UserMessageSender | null;
  readonly settings: ChatRunSettings | null;
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
  readonly restoreWorktreeStagingRevision: number | null;
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
  readonly messageId: string | null;
  readonly acceptedAt: number;
  /**
   * Structured prompt content carried over from the originating
   * `PendingChatAction` when the host accepts a `send`. The content
   * survives `actionAck`/`messageAccepted` and lives on the accepted
   * record so a later setup-gating `setup.failed` for the same
   * `messageId` can still restore the prompt to the composer
   * (Flow 8). `null` for non-`send` actions and after the content has
   * been consumed once by `takeSetupFailedRestoration`.
   */
  readonly restoreContent: JsonContent | null;
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
  readonly restore: ChatRestoreSlot | null;
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly errorNotices: ReadonlyArray<ChatErrorNotice>;
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
  interviewError: (blockId: string, reason: string) => string | null;
  ackAcceptedAction: (clientActionId: string) => void;
  ackFailedSendRestoration: (clientActionId: string) => void;
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
}

export interface ChatSessionStoreHandle {
  readonly epicId: string;
  readonly chatId: string;
  readonly userId: string | null;
  readonly store: UseBoundStore<StoreApi<ChatSessionState>>;
  readonly deliveredNotices: DeliveredNoticeTracker;
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

function appendErrorNotice(
  notices: ReadonlyArray<ChatErrorNotice>,
  next: ChatErrorNotice,
): ReadonlyArray<ChatErrorNotice> {
  if (notices.length < MAX_ERROR_NOTICE_RECORDS) {
    return [...notices, next];
  }
  // FIFO eviction once the cap is reached.
  return [
    ...notices.slice(notices.length - MAX_ERROR_NOTICE_RECORDS + 1),
    next,
  ];
}

export function createChatSessionStore(
  options: ChatSessionStoreOptions,
): ChatSessionStoreHandle {
  let disposed = false;
  let streamClient: ChatStreamClientHandle | null = null;
  // Assigned synchronously inside the `create()` initializer below, where the
  // delta buffer lives; read by the handle's surface-visibility rollup.
  let flushLease: StreamFlushLease | null = null;
  let activeStreamGeneration = 0;
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
    // message/turn state (`onSnapshot`, `onTurnStateChanged`, `onMessageAccepted`)
    // flushes the buffer first, so observable ordering matches arrival order.
    let bufferedDeltas: RuntimeEvent[] = [];

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
        return merged;
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
        flushBlockDeltas();
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
          const now = Date.now();
          // This snapshot is the authority for everything a lost connection
          // left in limbo: pendings dispatched on an earlier connection will
          // never see their ack, so drop them here (controls re-enable; the
          // user can re-issue against the state the snapshot shows). Message
          // sends stay - `reconcileSnapshotChange` settles those by messageId
          // with composer restoration.
          const sweep = sweepStalePendingActions(
            state.pendingActions,
            connectionEpoch,
          );
          const pending = reconcileSnapshotChange({
            pendingActions: sweep.pendingActions,
            pendingUserMessages: state.pendingUserMessages,
            messages,
            queue: frame.snapshot.queue,
            failedSendRestoration: state.failedSendRestoration,
            nowMs: now,
          });
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
          return {
            chat: {
              ...frame.snapshot.chat,
              messages: [...messages],
            },
            currentComposerSettings: authoritativeSettingsChanged
              ? frame.snapshot.chat.settings
              : state.currentComposerSettings,
            access: frame.snapshot.access,
            messages,
            events: frame.snapshot.chat.events,
            queue: mergeQueueWithOptimisticQueuedItems(
              frame.snapshot.queue,
              state.queue,
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
            pendingActions: pending.pendingActions,
            acceptedActions: pruneAcceptedActions(
              {
                ...state.acceptedActions,
                ...pending.acceptedActions,
              },
              now,
            ),
            pendingUserMessages: pending.pendingUserMessages,
            failedSendRestoration: pending.failedSendRestoration,
            restore: sweepStaleRestoreSlot(state.restore, connectionEpoch),
            snapshotLoaded: true,
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
      onActionAck: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        const rejectedPending =
          frame.status === "rejected"
            ? pendingActionForId(get().pendingActions, frame.clientActionId)
            : null;
        if (
          rejectedPending !== null &&
          rejectedPending.restoreWorktreeIntent !== null &&
          rejectedPending.restoreWorktreeStagingRevision !== null
        ) {
          const stagingKey: WorktreeStagingKey = {
            surface: "owner",
            epicId: options.epicId,
            ownerKind: "chat",
            ownerId: options.chatId,
          };
          const stagingStore = useWorktreeIntentStagingStore.getState();
          if (
            stagedWorktreeIntentRevision(stagingKey) ===
            rejectedPending.restoreWorktreeStagingRevision
          ) {
            stagingStore.setIntent(
              stagingKey,
              rejectedPending.restoreWorktreeIntent,
            );
          }
        }
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
          if (frame.status === "accepted") {
            if (pending === null) {
              return {
                pendingActions: nextPending,
                pendingUserMessages: nextPendingUsers,
                pendingBackgroundStops: backgroundStopAck.pendingStops,
                pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
              };
            }
            return {
              pendingActions: nextPending,
              acceptedActions: addAcceptedAction(
                state.acceptedActions,
                pending,
                Date.now(),
              ),
              pendingUserMessages: nextPendingUsers,
              pendingBackgroundStops: backgroundStopAck.pendingStops,
              pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
            };
          }
          return {
            pendingActions: nextPending,
            pendingUserMessages: nextPendingUsers,
            pendingBackgroundStops: backgroundStopAck.pendingStops,
            pendingBackgroundStopAll: backgroundStopAck.pendingStopAll,
            queue: removeOptimisticQueuedItemByClientActionId(
              state.queue,
              frame.clientActionId,
            ),
            failedSendRestoration:
              pending?.action === "send" && pending.restoreContent !== null
                ? {
                    clientActionId: frame.clientActionId,
                    content: pending.restoreContent,
                    reason: frame.reason ?? "Message was not accepted.",
                  }
                : state.failedSendRestoration,
            errorNotices: appendErrorNotice(state.errorNotices, {
              code: frame.code ?? "ACTION_REJECTED",
              message: frame.reason ?? "Action rejected.",
              severity: "warning",
              clientActionId: frame.clientActionId,
            }),
          };
        });
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
          if (messageExists(state.messages, frame.message.messageId)) {
            return {
              pendingUserMessages,
              queue: removeOptimisticQueuedItemByMessageId(
                state.queue,
                frame.message.messageId,
              ),
            };
          }
          return {
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
        // Materializes the live row into `messages`; flush first so the turn's
        // final buffered deltas are captured before it freezes.
        flushBlockDeltas();
        set((state) => {
          const baseMessages = messagesWithMaterializedLiveAssistant(
            state.messages,
            state.liveAssistantMessage,
            {
              previousActiveTurnId: state.activeTurn?.turnId ?? null,
              nextActiveTurnId: frame.activeTurn?.turnId ?? null,
            },
          );
          const nextMessages = messagesForTurnStateChange(baseMessages, {
            previousTurnId: state.activeTurn?.turnId ?? null,
            nextTurnId: frame.activeTurn?.turnId ?? null,
          });
          // Clear liveTurnUsage on any turn transition (turnId changes or
          // activeTurn settles to null). The new turn hasn't emitted its
          // own usage.updated yet, and keeping the previous turn's value
          // would briefly attribute the wrong number to the new turn.
          // Chip falls back to messages[last].usage during the gap.
          const previousTurnId = state.activeTurn?.turnId ?? null;
          const nextTurnId = frame.activeTurn?.turnId ?? null;
          const turnIdChanged = previousTurnId !== nextTurnId;
          const nextBackgroundItems =
            frame.backgroundItems ?? state.backgroundItems;
          return {
            messages: nextMessages,
            runStatus: frame.runStatus,
            activeTurn: frame.activeTurn,
            turnInProgress: frame.turnInProgress ?? state.turnInProgress,
            backgroundItems: nextBackgroundItems,
            // Keep background-stop pending state in lockstep with the
            // running-only list: a task that has left the list settled, so its
            // Stop is no longer in flight.
            pendingBackgroundStops: reconcileBackgroundStops(
              state.pendingBackgroundStops,
              nextBackgroundItems,
            ),
            pendingBackgroundStopAll: reconcileBackgroundStopAll(
              state.pendingBackgroundStopAll,
              nextBackgroundItems,
            ),
            liveAssistantMessage: liveAssistantForTurnStateFrame({
              current: state.liveAssistantMessage,
              previousTurnId,
              activeTurn: frame.activeTurn,
              messages: nextMessages,
            }),
            ...(turnIdChanged ? { liveTurnUsage: null } : {}),
          };
        });
      },
      onBlockDelta: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        bufferedDeltas.push(frame.event);
        lease.requestFlush();
        // The `code: "auth"` error frame is the one live push that flips the
        // re-auth banner on mid-session. The failed turn's error block is itself
        // suppressed from the transcript by `suppressAuthErrors`, so it never
        // surfaces a transcript error row.
        if (
          frame.event.type === "error" &&
          frame.event.code === AUTH_ERROR_CODE
        ) {
          // Nudge `providers.list` to refetch (and read the host's poisoned
          // `unauthenticated`) so the banner mounts + send blocks.
          if (options.onProviderAuthError !== null) {
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
        set((state) => ({
          pendingInterviews: withoutPendingInterview(
            state.pendingInterviews,
            frame.blockId,
          ),
        }));
      },
      onInterviewErrored: (frame) => {
        if (disposed || !matchesChat(options, frame.epicId, frame.chatId)) {
          return;
        }
        set((state) => ({
          pendingInterviews: withoutPendingInterview(
            state.pendingInterviews,
            frame.blockId,
          ),
        }));
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
          errorNotices: appendErrorNotice(state.errorNotices, frame.notice),
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
          return {
            connectionStatus: status,
            runStatus: status === "closed" ? "idle" : state.runStatus,
            activeTurn: status === "closed" ? null : state.activeTurn,
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
      },
      onWorktreeStateChanged: (frame) => {
        if (!isCurrentStream(streamGeneration)) return;
        callbacks.onWorktreeStateChanged(frame);
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
      chat: null,
      access: null,
      messages: [],
      events: [],
      queue: EMPTY_QUEUE,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: undefined,
      pendingApprovals: [],
      pendingFileEditApprovals: [],
      pendingInterviews: [],
      accumulatedFileChanges: [],
      backgroundItems: undefined,
      pendingBackgroundStops: {},
      pendingBackgroundStopAll: null,
      restore: null,
      pendingActions: {},
      acceptedActions: {},
      pendingUserMessages: [],
      errorNotices: [],
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
        set({
          connectionStatus: "connecting",
          fatalClose: null,
          snapshotLoaded: false,
        });
        streamClient = createStreamClient();
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
      sendMessage: (content, sender, settings) => {
        const clientActionId = uuidv4();
        const messageId = uuidv4();
        // A worktree staged mid-chat ("Create new worktree") rides on this send;
        // the host creates it at turn-start before gating on setup. Mirrors
        // the landing page bundling its intent with `epic.create`.
        const stagedKey: WorktreeStagingKey = {
          surface: "owner",
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
          deliveryPolicy: "auto",
          worktreeIntent,
        };
        // Consume before dispatch so the pending action captures precisely the
        // revision it may later restore. A synchronous action rejection cannot
        // race ahead of this transition.
        const stagingStore = useWorktreeIntentStagingStore.getState();
        let restoreWorktreeStagingRevision: number | null = null;
        if (worktreeIntent !== null) {
          stagingStore.clear(stagedKey);
          restoreWorktreeStagingRevision =
            stagedWorktreeIntentRevision(stagedKey);
        }
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: {
            clientActionId,
            action: "send",
            messageId,
            restoreContent: content,
            sender,
            settings,
            restoreWorktreeIntent: worktreeIntent,
            restoreWorktreeStagingRevision,
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
          pendingUserMessage: shouldRenderSendAsPendingUserMessage(get())
            ? {
                clientActionId,
                messageId,
                content,
                sender,
                settings,
                timestamp: Date.now(),
              }
            : null,
        });
        if (sentClientActionId === null) {
          if (worktreeIntent !== null) {
            stagingStore.setIntent(stagedKey, worktreeIntent);
          }
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
            .setEpicIntent(options.epicId, worktreeIntent, Date.now());
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
            messageId: input.messageId,
            restoreContent: input.content,
            sender: input.sender,
            settings: input.settings,
            restoreWorktreeIntent: null,
            restoreWorktreeStagingRevision: null,
            createdAt: Date.now(),
          },
          pendingUserMessage: {
            clientActionId: input.clientActionId,
            messageId: input.messageId,
            content: input.content,
            sender: input.sender,
            settings: input.settings,
            timestamp: Date.now(),
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
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: {
            clientActionId,
            action: "editUserMessage",
            messageId,
            restoreContent: null,
            sender: null,
            settings: null,
            restoreWorktreeIntent: null,
            restoreWorktreeStagingRevision: null,
            createdAt: Date.now(),
          },
          pendingUserMessage: null,
        });
        if (sentClientActionId === null) return null;
        if (worktreeIntent !== null) {
          useWorktreeIntentMemoryStore
            .getState()
            .setEpicIntent(options.epicId, worktreeIntent, Date.now());
          useWorktreeIntentStagingStore.getState().clear(stagedKey);
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
            messageId: null,
            restoreContent: null,
            sender: null,
            settings: null,
            restoreWorktreeIntent: null,
            restoreWorktreeStagingRevision: null,
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
        const pendingItems = get().queue.items.filter(
          (item: ChatQueuedItem) =>
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
          pending: basicPending(clientActionId, "interviewAnswer"),
          pendingUserMessage: null,
        });
        return sentClientActionId;
      },
      interviewError: (blockId, reason) => {
        const clientActionId = uuidv4();
        const frame: ChatOwnerActionFrame = {
          kind: "interviewError",
          hasBinaryPayload: false,
          epicId: options.epicId,
          chatId: options.chatId,
          clientActionId,
          blockId,
          reason,
        };
        const sentClientActionId = sendAction({
          set,
          get,
          frame,
          pending: basicPending(clientActionId, "interviewError"),
          pendingUserMessage: null,
        });
        return sentClientActionId;
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
      ackFailedSendRestoration: (clientActionId) => {
        set((state) =>
          state.failedSendRestoration?.clientActionId === clientActionId
            ? { failedSendRestoration: null }
            : {},
        );
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
        lease.unregister();
        clearBufferedDeltas();
        closeStreamClient();
      },
    };
  });

  return {
    epicId: options.epicId,
    chatId: options.chatId,
    userId: options.userId,
    store,
    deliveredNotices: {
      notices: new WeakSet<ChatErrorNotice>(),
      clientActionIds: new Set<string>(),
    },
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
    messageId: null,
    restoreContent: null,
    sender: null,
    settings: null,
    restoreWorktreeIntent: null,
    restoreWorktreeStagingRevision: null,
    createdAt: Date.now(),
  };
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
 * and the queue is empty/idle. Single source of truth for the
 * render-send-as-pending check and the turn-completion refresh subscribers
 * (`lib/chats/chat-turn-completions.ts`).
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
): ChatQueuedItem | null {
  if (!shouldRenderSendAsOptimisticQueuedItem(input.state)) return null;
  const now = Date.now();
  return {
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
//   - a terminal `tool_call.*` → its non-empty `parentBlockId` when it is a
//     subagent CHILD; otherwise its own `blockId` (a genuinely top-level
//     background command/Monitor terminal).
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
    event.type === "tool_call.errored"
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
