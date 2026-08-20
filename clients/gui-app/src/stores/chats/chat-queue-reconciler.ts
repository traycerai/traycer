import type {
  ChatErrorNotice,
  ChatQueueState,
  ChatRunStatus,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import type {
  AcceptedChatAction,
  FailedSendRestorationState,
  PendingChatAction,
  PendingUserMessage,
} from "@/stores/chats/chat-session-store";

/**
 * Notice code for a send whose text the CLIENT is the last holder of - the
 * message body is inlined in `ChatErrorNotice.message` because nothing else
 * holds it any more. The toast layer reads this twice: to REPLAY such a notice
 * when a pane focuses (the reconnect-while-away case is exactly when one
 * arrives, and an unreplayed one is a destroyed draft), and to keep it on
 * screen until dismissed. A notice carrying the only copy of someone's text
 * must neither be skipped nor expire on a timer.
 *
 * Both reconcile passes emit it, because both make the same promise: this
 * send is settled, its row is gone, and the text is right here.
 */
export const SEND_NOT_RECORDED_NOTICE_CODE = "SEND_NOT_RECORDED";

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
 *
 * `appendedErrorNotices` is a DELTA - only the notices this pass produced, in
 * order - not the store's ring. The caller appends them onto its own
 * `errorNotices` (that is where the FIFO cap lives), so an empty delta writes
 * nothing. Named so it cannot collide with the `errorNotices` STATE key: the
 * settled patch below is applied by spreading it into the state update, and a
 * colliding name would silently replace the ring with the delta.
 */
export type ReconcileSnapshotPatch = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  readonly appendedErrorNotices: ReadonlyArray<ChatErrorNotice>;
};

/**
 * The statement for a dead send that could not claim the single
 * `failedSendRestoration` slot.
 *
 * The slot is deliberately first-writer-wins - the earlier send has waited
 * longest, and last-wins would bury it - so a displacement is expected. What
 * must not happen is a displaced send going quiet: the rejection ack path
 * already pairs the same rule with an `errorNotice`, and this is that
 * statement for both reconcile passes.
 *
 * It INLINES the message body, because by the time this fires the client is
 * the last holder of that text. Both passes settle the send outright - row
 * dropped, action dropped - so there is no surviving row to point at. That is
 * deliberate on both: a row that will never confirm keeps edit/delete gated
 * off and renders a user message the host never recorded, and (on the
 * reconnect path) an action left restoration-eligible re-states itself on
 * every later snapshot and pushes stale text back into the composer after the
 * user has already resent it.
 *
 * `extractPlainTextFromComposerJSONContent` is text-only: a send whose body
 * was entirely an image attachment has no text to carry, and says so rather
 * than rendering an empty quote.
 */
function unrecoverableSendNotice(
  clientActionId: string,
  content: JsonContent,
  circumstance: string,
): ChatErrorNotice {
  const text = extractPlainTextFromComposerJSONContent(content).trim();
  const preamble = `${circumstance}, and another unsent message is already waiting in the composer.`;
  return {
    code: SEND_NOT_RECORDED_NOTICE_CODE,
    message:
      text.length === 0
        ? `${preamble} It had no text to recover - any attachments on it are lost.`
        : `${preamble} Copy it from here to resend: ${text}`,
    severity: "warning",
    clientActionId,
  };
}

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
    appendedErrorNotices: [],
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
      // Nothing to restore and nothing lost: the send stays pending and no
      // statement is owed.
      if (pending.restoreContent === null) {
        return next;
      }
      // The slot is taken by a longer-waiting send. Keep first-writer-wins,
      // but SETTLE this one rather than leaving it parked: its ack died with
      // the connection and this snapshot is authoritative, so it can never
      // confirm. Leaving it eligible re-stated it on every later snapshot
      // (polluting the notice ring until it evicted unrelated entries) and
      // let the slot re-claim it once freed, pushing stale text into the
      // composer after the user had followed the advice and resent it. The
      // statement carries the text, since nothing holds it once the row goes.
      if (next.failedSendRestoration !== null) {
        return {
          ...next,
          pendingActions: withoutPendingAction(
            next.pendingActions,
            pending.clientActionId,
          ),
          pendingUserMessages: next.pendingUserMessages.filter(
            (message) => message.clientActionId !== pending.clientActionId,
          ),
          appendedErrorNotices: [
            ...next.appendedErrorNotices,
            unrecoverableSendNotice(
              pending.clientActionId,
              pending.restoreContent,
              "A message was not confirmed after reconnect",
            ),
          ],
        };
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

/**
 * Input for turn-settled reconciliation: the state slices needed to decide
 * which optimistic pending user messages can no longer materialize.
 */
export type ReconcileTurnSettledInput = {
  readonly pendingActions: Readonly<Record<string, PendingChatAction>>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly messages: ReadonlyArray<Message>;
  readonly queue: ChatQueueState;
  readonly failedSendRestoration: FailedSendRestorationState | null;
};

export type ReconcileTurnSettledPatch = {
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
  /** Delta, appended by the caller - see {@link ReconcileSnapshotPatch}. */
  readonly appendedErrorNotices: ReadonlyArray<ChatErrorNotice>;
};

/**
 * Whether a `turnStateChanged` frame or `chat.subscribe` snapshot reports the
 * turn settled: the host's own `turnInProgress` when present, with the
 * `runStatus` idle read as the fallback for an older host that predates the
 * field. A settled report is the trigger for {@link reconcileTurnSettled}.
 */
export function turnSettledFromStatus(
  turnInProgress: boolean | undefined,
  runStatus: ChatRunStatus,
): boolean {
  return turnInProgress === undefined ? runStatus === "idle" : !turnInProgress;
}

/**
 * Drop stranded optimistic user messages when the turn settles.
 *
 * An accepted send ack deliberately keeps its `pendingUserMessages` entry
 * alive - the durable `messageAccepted` frame is what normally clears it. A
 * stop during turn activation can abort the send after the accepted ack but
 * before the host appends the message, in which case neither
 * `messageAccepted` nor a rejected ack ever arrives and the entry would
 * survive indefinitely - keeping edit/delete gated off and rendering a user
 * message the host never recorded. A settled report is the authoritative
 * "this send will never materialize" signal. It arrives two ways, and this
 * runs on both: a live `turnStateChanged` frame, and a re-subscribe snapshot
 * (`reconcileSnapshotChange` only settles sends still in `pendingActions`,
 * so an already-acked entry needs this pass on reconnect too).
 *
 * An entry survives while a path to materialization remains open: its ack is
 * still in flight (`pendingActions`) or it was parked in the queue (a later
 * `queueChanged`/`messageAccepted` settles it, and the mutation gate stays
 * closed on the queue anyway). An entry whose message already reached the
 * transcript is stale bookkeeping - dropped without restoration. Truly dead
 * entries are dropped and the first one's content is restored to the
 * composer via the `failedSendRestoration` slot (single-slot; an occupied
 * slot is never overwritten).
 *
 * Every OTHER truly-dead entry - the ones the single slot cannot take - is
 * stated via {@link unrecoverableSendNotice}, which inlines the message body.
 * Dropping the row is correct here but it takes the last copy of that text
 * with it, so the statement has to carry the text or the send is simply gone.
 * An entry already in the transcript needs no notice: dropping it loses
 * nothing.
 *
 * The invariant both passes now share: a dead send is either RESTORED to the
 * composer (it won the slot) or STATED with its text inlined (it did not).
 * Never both - which is what made the reconnect path manufacture duplicate
 * sends - and never neither.
 *
 * Pure function - all state is passed explicitly. `settled` is
 * {@link turnSettledFromStatus}'s answer for the triggering frame/snapshot; a
 * non-settled report returns the input slices unchanged.
 */
export function reconcileTurnSettled(
  settled: boolean,
  input: ReconcileTurnSettledInput,
): ReconcileTurnSettledPatch {
  if (!settled) {
    return {
      pendingUserMessages: input.pendingUserMessages,
      failedSendRestoration: input.failedSendRestoration,
      appendedErrorNotices: [],
    };
  }
  const confirmedMessageIds = confirmedMessageIdsForMessages(input.messages);
  const stranded = input.pendingUserMessages.filter(
    (message) =>
      !Object.hasOwn(input.pendingActions, message.clientActionId) &&
      !queueContainsPendingSend(input.queue, message.messageId, message),
  );
  if (stranded.length === 0) {
    return {
      pendingUserMessages: input.pendingUserMessages,
      failedSendRestoration: input.failedSendRestoration,
      appendedErrorNotices: [],
    };
  }
  const restorable = stranded.find(
    (message) => !confirmedMessageIds.has(message.messageId),
  );
  const strandedActionIds = new Set(
    stranded.map((message) => message.clientActionId),
  );
  // Who actually gets the composer back: `restorable` only claims the slot
  // when it is free, because the slot is first-writer-wins. Everyone else
  // whose message never reached the transcript is losing their only copy, so
  // each of them is stated with their text inlined - not just the first.
  const slotClaimantActionId =
    input.failedSendRestoration === null && restorable !== undefined
      ? restorable.clientActionId
      : null;
  return {
    pendingUserMessages: input.pendingUserMessages.filter(
      (message) => !strandedActionIds.has(message.clientActionId),
    ),
    failedSendRestoration:
      input.failedSendRestoration !== null || restorable === undefined
        ? input.failedSendRestoration
        : {
            clientActionId: restorable.clientActionId,
            content: restorable.content,
            reason: "The message was not recorded before the turn stopped.",
          },
    appendedErrorNotices: stranded
      .filter(
        (message) =>
          !confirmedMessageIds.has(message.messageId) &&
          message.clientActionId !== slotClaimantActionId,
      )
      .map((message) =>
        unrecoverableSendNotice(
          message.clientActionId,
          message.content,
          "A message was not recorded before the turn stopped",
        ),
      ),
  };
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
    // A managed-command item is host-authored and content-free; it can never be
    // the queue's echo of the user's pending send.
    if (item.kind !== "prompt") return false;
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
