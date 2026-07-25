import type { ChatQueueState } from "@traycer/protocol/host/agent/gui/subscribe";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  AcceptedChatAction,
  FailedSendRestorationState,
  PendingChatAction,
  PendingUserMessage,
} from "@/stores/chats/chat-session-store";

/**
 * Input for queue reconciliation. Contains the immutable state slices needed
 * to determine which pending actions have been queued and should transition
 * to accepted actions.
 */
export type ReconcileQueueInput = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly queue: ChatQueueState;
  readonly nowMs: number;
};

/**
 * Output patch for queue reconciliation. Contains updated state slices
 * to apply to the store.
 */
export type ReconcileQueuePatch = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
};

/**
 * Input for snapshot reconciliation. Contains all state and snapshot data
 * needed to reconcile pending actions against a newly-received snapshot.
 */
export type ReconcileSnapshotInput = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly messages: ReadonlyArray<Message>;
  readonly queue: ChatQueueState;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  readonly nowMs: number;
};

/**
 * Output patch for snapshot reconciliation. Contains updated state slices
 * to apply to the store, including the failedSendRestoration field.
 */
export type ReconcileSnapshotPatch = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
};

/**
 * Reconcile pending actions when the queue changes. Transitions pending
 * actions that are now in the queue to accepted actions.
 *
 * Pure function - all timing inputs must be passed explicitly.
 */
export function reconcileQueueChange(
  input: ReconcileQueueInput,
): ReconcileQueuePatch {
  const queuedPendingActionIds = pendingActionIdsForQueuedMessages(
    input.pendingActions,
    input.pendingUserMessages,
    input.queue,
  );
  if (queuedPendingActionIds.size === 0) {
    return {
      pendingActions: input.pendingActions,
      acceptedActions: {},
      pendingUserMessages: input.pendingUserMessages,
    };
  }
  const queuedPendingActions = Object.values(input.pendingActions).filter(
    (action) => queuedPendingActionIds.has(action.clientActionId),
  );
  const nextPendingActions = queuedPendingActions.reduce(
    (next, action) => withoutPendingAction(next, action.clientActionId),
    input.pendingActions,
  );
  const nextAcceptedActions = pruneAcceptedActions(
    queuedPendingActions.reduce(
      (next, action) => addAcceptedAction(next, action, input.nowMs),
      {},
    ),
    input.nowMs,
  );
  return {
    pendingActions: nextPendingActions,
    acceptedActions: nextAcceptedActions,
    pendingUserMessages: input.pendingUserMessages.filter(
      (message) => !queuedPendingActionIds.has(message.clientActionId),
    ),
  };
}

/**
 * Reconcile pending actions against a snapshot. Clears pending actions whose
 * messages have been confirmed in the snapshot or are in the queue.
 *
 * Pure function - all timing inputs must be passed explicitly.
 */
export function reconcileSnapshotChange(
  input: ReconcileSnapshotInput,
): ReconcileSnapshotPatch {
  const acceptedMessageIds = confirmedMessageIdsForMessages(input.messages);
  const pendingUsersByAction = new Map(
    input.pendingUserMessages.map((message) => [
      message.clientActionId,
      message,
    ]),
  );
  const initial: ReconcileSnapshotPatch = {
    pendingActions: input.pendingActions,
    acceptedActions: {},
    pendingUserMessages: input.pendingUserMessages,
    failedSendRestoration: input.failedSendRestoration,
  };
  return Object.values(input.pendingActions).reduce(
    (next, pending): ReconcileSnapshotPatch => {
      if (
        (pending.action !== "send" && pending.action !== "editUserMessage") ||
        pending.messageId === null
      ) {
        return next;
      }
      const pendingUser = resolvePendingUser(pendingUsersByAction, pending);
      if (
        acceptedMessageIds.has(pending.messageId) ||
        (pending.action === "send" &&
          queueContainsPendingSend(input.queue, pending.messageId, pendingUser))
      ) {
        return {
          ...next,
          pendingActions: withoutPendingAction(
            next.pendingActions,
            pending.clientActionId,
          ),
          acceptedActions: addAcceptedAction(
            next.acceptedActions,
            pending,
            input.nowMs,
          ),
          pendingUserMessages: next.pendingUserMessages.filter(
            (message) => message.clientActionId !== pending.clientActionId,
          ),
        };
      }
      if (
        pending.restoreContent === null ||
        next.failedSendRestoration !== null
      ) {
        return next;
      }
      return {
        ...next,
        pendingActions: withoutPendingAction(
          next.pendingActions,
          pending.clientActionId,
        ),
        pendingUserMessages: next.pendingUserMessages.filter(
          (message) => message.clientActionId !== pending.clientActionId,
        ),
        failedSendRestoration: {
          clientActionId: pending.clientActionId,
          content: pending.restoreContent,
          reason: "Message was not confirmed after reconnect.",
        },
      };
    },
    initial,
  );
}

export interface StalePendingActionsSweep {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly sweptActionIds: ReadonlySet<string>;
}

const NO_SWEPT_ACTION_IDS: ReadonlySet<string> = new Set();

/**
 * Drop pending actions dispatched on an earlier connection than the
 * snapshot's. Their `actionAck` died with the dropped stream (frames and
 * acks are fire-and-forget per connection), so keeping them would leave
 * their controls (Stop, restore/revert, message edit, plan approval, queue
 * edits) disabled forever. The arriving snapshot is the authority on what
 * actually happened; dropping the pending re-enables the control so the user
 * can re-issue against that state. Only `send` is excluded -
 * `reconcileSnapshotChange` settles sends by messageId, restoring an
 * unconfirmed send's content to the composer, a path no other kind has
 * (a stale APPLIED `editUserMessage` shows in the snapshot's messages
 * either way; only its accepted-action bookkeeping entry is skipped).
 *
 * Pure function; only ever driven by an authoritative snapshot, never by a
 * connection-status event (a transient wobble must not cancel anything).
 * Returns the swept ids so the caller can settle sibling records keyed by
 * the same `clientActionId` (background stops) without re-deriving them.
 */
export function sweepStalePendingActions(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  connectionEpoch: number,
): StalePendingActionsSweep {
  const stale = Object.values(pendingActions).filter(
    (pending) =>
      pending.action !== "send" && pending.connectionEpoch < connectionEpoch,
  );
  if (stale.length === 0) {
    return { pendingActions, sweptActionIds: NO_SWEPT_ACTION_IDS };
  }
  const sweptActionIds = new Set(
    stale.map((pending) => pending.clientActionId),
  );
  return {
    pendingActions: Object.fromEntries(
      Object.entries(pendingActions).filter(
        ([clientActionId]) => !sweptActionIds.has(clientActionId),
      ),
    ),
    sweptActionIds,
  };
}

/**
 * Find all pending action ids that correspond to messages already in the queue.
 * Used during queue reconciliation to identify which pending actions to promote
 * to accepted.
 */
function pendingActionIdsForQueuedMessages(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  pendingUserMessages: ReadonlyArray<PendingUserMessage>,
  queue: ChatQueueState,
): Set<string> {
  const pendingUsersByAction = new Map(
    pendingUserMessages.map((message) => [message.clientActionId, message]),
  );
  return new Set([
    ...Object.values(pendingActions).flatMap((action) =>
      action.action === "send" &&
      action.messageId !== null &&
      queueContainsPendingSend(
        queue,
        action.messageId,
        resolvePendingUser(pendingUsersByAction, action),
      )
        ? [action.clientActionId]
        : [],
    ),
    ...pendingUserMessages.flatMap((message) =>
      queueContainsPendingSend(queue, message.messageId, message)
        ? [message.clientActionId]
        : [],
    ),
  ]);
}

/**
 * Resolve the pending user message associated with a pending action,
 * either from the live array or reconstructed from the action fields.
 */
function resolvePendingUser(
  pendingUsersByAction: ReadonlyMap<string, PendingUserMessage>,
  action: PendingChatAction,
): PendingUserMessage | undefined {
  return (
    pendingUsersByAction.get(action.clientActionId) ??
    pendingUserMessageFromPendingAction(action)
  );
}

/**
 * Reconstruct a pending user message from a pending action's fields.
 * Returns undefined if the action lacks the required fields.
 */
function pendingUserMessageFromPendingAction(
  action: PendingChatAction,
): PendingUserMessage | undefined {
  if (
    action.messageId === null ||
    action.restoreContent === null ||
    action.sender === null ||
    action.settings === null
  ) {
    return undefined;
  }
  return {
    clientActionId: action.clientActionId,
    messageId: action.messageId,
    content: action.restoreContent,
    sender: action.sender,
    settings: action.settings,
    timestamp: action.createdAt,
  };
}

/**
 * Check if a queue contains a send matching the given pending message id
 * or content. Matches by message id first, then falls back to content
 * equality for pending messages not yet assigned an id by the host.
 */
function queueContainsPendingSend(
  queue: ChatQueueState,
  pendingMessageId: string,
  pendingUser: PendingUserMessage | undefined,
): boolean {
  const pendingUserMessageId = pendingUser?.messageId ?? null;
  let targetContent: string | null = null;
  let targetSender: string | null = null;
  let targetSettings: string | null = null;
  return queue.items.some((item) => {
    if (item.messageId === pendingMessageId) return true;
    if (pendingUser === undefined) return false;
    if (item.messageId === pendingUserMessageId) return true;
    if (targetContent === null) {
      targetContent = JSON.stringify(pendingUser.content);
      targetSender = JSON.stringify(pendingUser.sender);
      targetSettings = JSON.stringify(pendingUser.settings);
    }
    if (JSON.stringify(item.message.content) !== targetContent) return false;
    if (JSON.stringify(item.sender) !== targetSender) return false;
    return JSON.stringify(item.settings) === targetSettings;
  });
}

/**
 * Extract message ids from a message list. Used to determine which
 * pending actions have been confirmed by the host.
 */
function confirmedMessageIdsForMessages(
  messages: ReadonlyArray<Message>,
): Set<string> {
  return new Set(
    messages.flatMap((message) => {
      if (message.role === "user") return [message.messageId];
      return [];
    }),
  );
}

/**
 * Remove a pending action from the record by id. Returns the same object
 * if the action is not present (no allocation).
 */
export function withoutPendingAction(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
  clientActionId: string,
): Readonly<Record<string, PendingChatAction>> {
  if (!Object.hasOwn(pendingActions, clientActionId)) return pendingActions;
  const next = { ...pendingActions };
  delete next[clientActionId];
  return next;
}

/**
 * Add a pending action as accepted to the record. Applies pruning to
 * enforce retention limits.
 */
export function addAcceptedAction(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  pending: PendingChatAction,
  now: number,
): Readonly<Record<string, AcceptedChatAction>> {
  return pruneAcceptedActions(
    {
      ...acceptedActions,
      [pending.clientActionId]: {
        clientActionId: pending.clientActionId,
        action: pending.action,
        interviewBlockId: pending.interviewBlockId,
        messageId: pending.messageId,
        acceptedAt: now,
        restoreContent: pending.restoreContent,
      },
    },
    now,
  );
}

/**
 * Prune accepted actions to enforce retention time limit (5 minutes) and
 * record cap (64 records). Prioritizes send/editUserMessage actions and
 * recent entries. Returns the same object if no pruning is needed.
 *
 * An accepted-but-unresolved interview action (`interviewBlockId !== null`)
 * is a lifecycle lock, not generic action history: the UI busy-gate and the
 * duplicate-dispatch guard both read it via `existingInterviewActionId`, and
 * it must survive until the host's `interviewAnswered`/`interviewErrored`
 * frame authoritatively clears it (`withoutInterviewActionsForBlock`).
 * Exempt it from the retention window and record cap below, or a
 * slow-to-resolve interview (or enough unrelated traffic to evict it from the
 * cap) would silently un-gate a duplicate submission before the host
 * responds.
 */
export function pruneAcceptedActions(
  acceptedActions: Readonly<Record<string, AcceptedChatAction>>,
  now: number,
): Readonly<Record<string, AcceptedChatAction>> {
  const RETENTION_MS = 5 * 60 * 1_000;
  const MAX_RECORDS = 64;

  const all = Object.values(acceptedActions);
  const interviewLocked = all.filter(
    (action) => action.interviewBlockId !== null,
  );
  const prunable = all.filter((action) => action.interviewBlockId === null);

  const unexpired = prunable.filter(
    (action) => now - action.acceptedAt <= RETENTION_MS,
  );
  const retained =
    unexpired.length <= MAX_RECORDS
      ? unexpired
      : unexpired
          .toSorted(compareAcceptedActionForRetention)
          .slice(0, MAX_RECORDS);
  const kept = [...interviewLocked, ...retained];
  if (kept.length === all.length) {
    return acceptedActions;
  }
  return kept.reduce<Record<string, AcceptedChatAction>>((next, action) => {
    next[action.clientActionId] = action;
    return next;
  }, {});
}

/**
 * Comparator for sorting accepted actions by retention priority.
 * Prioritizes send/editUserMessage actions and more recent entries.
 */
function compareAcceptedActionForRetention(
  a: AcceptedChatAction,
  b: AcceptedChatAction,
): number {
  const rankDelta =
    acceptedActionRetentionRank(b) - acceptedActionRetentionRank(a);
  if (rankDelta !== 0) return rankDelta;
  const timeDelta = b.acceptedAt - a.acceptedAt;
  if (timeDelta !== 0) return timeDelta;
  return a.clientActionId.localeCompare(b.clientActionId);
}

/**
 * Retention rank for an action type. Send and editUserMessage actions
 * rank higher (1) than other actions (0).
 */
function acceptedActionRetentionRank(action: AcceptedChatAction): number {
  return action.action === "send" || action.action === "editUserMessage"
    ? 1
    : 0;
}
