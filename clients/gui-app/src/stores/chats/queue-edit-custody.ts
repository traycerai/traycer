import type {
  ChatQueuedItem,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import type {
  ChatSendRestore,
  PendingChatAction,
} from "@/stores/chats/chat-session-store";

/**
 * What the user asked for when they submitted an edited queued prompt: plain
 * Enter saves the text with its settings, Mod-Enter saves it and asks the host
 * to steer it into the running turn.
 */
export type QueueEditIntent = "save" | "steer";

/**
 * One frame's answer.
 *
 * `pending` while its ack can still arrive. `unconfirmed` once that ack died
 * with a connection: nothing will ever answer it, so only what the host is
 * later SEEN to hold can account for it. The two are kept apart because they
 * are owed different things - a pending frame is owed patience, an unconfirmed
 * one is owed evidence.
 */
export type QueueEditFrameOutcome =
  | "pending"
  | "accepted"
  | "rejected"
  | "unconfirmed";

/**
 * An edited queued prompt, held from the moment the composer is cleared until
 * the host has accounted for BOTH frames the submission went out as.
 *
 * A queue edit is two independent stream frames - `queueEdit` (the text) and
 * `queueSettingsUpdate` or `queueSteerNow` (the settings, or the steer) - and
 * the composer clears as soon as both are dispatched. Before this record the
 * edited text lived nowhere after that clear: a `queueEdit` the host refused
 * because the item had already started left a warning and nothing to recover
 * (traycerai/traycer#2418).
 *
 * "Accounted for" is an ack, or a POSITIVE match against what the host holds.
 * It is never an absence: a row that still shows the old text may belong to a
 * host that is still installing the edit, and a transcript body this client
 * has not loaded says nothing about what ran.
 *
 * WHY ITS OWN SLOT AND NOT `PendingChatAction.restore`. The same reason
 * `pendingCancelRestorations` gives: `restore` on a pending action is read as
 * the fact "this record holds the only copy of an unconfirmed SEND", and an
 * edit carrying one would be settled by the send passes as a message the host
 * never recorded.
 *
 * Keyed by the `queueEdit` action's `clientActionId`.
 */
export interface QueueEditRecord {
  readonly queueItemId: string;
  /**
   * The message the edited row will become, captured at dispatch. Once the row
   * leaves the queue this is the only way to find what the host ran.
   */
  readonly messageId: string;
  readonly intent: QueueEditIntent;
  /** The composer's own document plus its annotation cards - what goes back. */
  readonly restore: ChatSendRestore;
  /** The document the `queueEdit` frame carried - what the host would hold. */
  readonly wireContent: JsonContent;
  readonly settings: ChatRunSettings;
  /** The billing context the settings frame carried beside `settings`. */
  readonly accountContext: AccountContext;
  /**
   * Whether the row already held these settings and this account when the
   * submission left. The second frame then asks for nothing the host does not
   * have, so its answer cannot leave the submission half applied.
   */
  readonly followUpIsNoOp: boolean;
  /**
   * Each setting the submission asked the row to change, already named
   * ("model x", "billing team y"). Kept so a partial result can say what was
   * not applied after the row that showed the difference is gone.
   */
  readonly requestedChanges: ReadonlyArray<string>;
  readonly editActionId: string;
  /** The `queueSettingsUpdate` (save) or `queueSteerNow` (steer) action. */
  readonly followUpActionId: string;
  readonly edit: QueueEditFrameOutcome;
  readonly followUp: QueueEditFrameOutcome;
  /**
   * The host's reason for refusing the second frame, kept because that ack can
   * arrive BEFORE the text's own: the partial result is only stated once the
   * text is known saved, and by then the refusal's frame is gone.
   */
  readonly followUpReason: string | null;
  /**
   * Whether the edited text has already been handed back. A refused content
   * edit returns it at once rather than waiting on the second frame, and an
   * unconfirmed one returns it while the record keeps watching for the host to
   * show what it did.
   */
  readonly contentReturned: boolean;
  /** Local dispatch time. Never shown as a host-confirmed transition. */
  readonly dispatchedAt: number;
}

export type QueueEditRecords = Readonly<
  Record<string, QueueEditRecord | undefined>
>;

/**
 * Why an edited text is going back to the user.
 *
 * - `refused`: the host said no, on this connection, with a reason.
 * - `not_applied`: no ack, but the host shows the prompt ran as something
 *   else. An edit cannot land on a prompt that has started, so this is
 *   settled.
 * - `unconfirmed`: no ack and nothing the host shows settles it. The text goes
 *   back so it is not held out of sight, and it may still have been saved.
 */
export type QueueEditReturnCause = "refused" | "not_applied" | "unconfirmed";

/** What accounting for a record owes the user. Nothing, for one that landed whole. */
export type QueueEditSettlement =
  /**
   * The edited draft goes back to the composer (or to a copyable entry when a
   * newer draft is there). The original prompt is left to whatever the host
   * did with it and is never re-sent from here.
   */
  | {
      readonly kind: "content_returned";
      readonly clientActionId: string;
      readonly restore: ChatSendRestore;
      /**
       * The document the frame carried. It can name images the composer's own
       * document does not (an annotation crop is added on the way out), and a
       * hand-back has to stop trusting the host to hold those as well.
       */
      readonly wireContent: JsonContent;
      readonly cause: QueueEditReturnCause;
      /** The host's refusal. `null` for every cause but `refused`. */
      readonly hostReason: string | null;
    }
  /**
   * The text was saved and the second frame was not applied - or, after a
   * reconnect, could not be confirmed. The whole submission is kept for the
   * user as a copyable entry; the text itself is on the host and is not put
   * back in the composer, where it would read as unsent.
   */
  | {
      readonly kind: "partial";
      readonly clientActionId: string;
      readonly intent: QueueEditIntent;
      readonly restore: ChatSendRestore;
      /** See {@link QueueEditRecord.requestedChanges}. */
      readonly requestedChanges: ReadonlyArray<string>;
      /** `true` for a refusal the host stated, `false` for one never answered. */
      readonly refused: boolean;
      readonly hostReason: string | null;
    }
  /**
   * An edit handed back as unconfirmed that the host has since shown it did
   * save. The copy already returned is now a duplicate, and the user is told
   * so rather than left to send it a second time.
   */
  | {
      readonly kind: "saved_after_return";
      readonly clientActionId: string;
      readonly intent: QueueEditIntent;
      readonly followUpApplied: boolean;
      /**
       * `true` when the host is KNOWN to have refused the second frame: its
       * ack arrived before the connection that lost the text's. That is an
       * answer, with a reason, and is not told as "not confirmed".
       */
      readonly followUpRefused: boolean;
      /** The host's refusal of the second frame. `null` unless refused. */
      readonly hostReason: string | null;
    }
  /**
   * The mirror of `partial`: the host refused the text and then took the
   * second frame, which it handles on its own. The queued message kept its
   * earlier text and was given the new settings, or steered, all the same -
   * and the edited draft handed back says only that the edit was not saved.
   */
  | {
      readonly kind: "follow_up_alone";
      readonly clientActionId: string;
      readonly intent: QueueEditIntent;
      /** See {@link QueueEditRecord.requestedChanges}. */
      readonly requestedChanges: ReadonlyArray<string>;
    };

export interface QueueEditFold {
  readonly records: QueueEditRecords;
  readonly settlements: ReadonlyArray<QueueEditSettlement>;
}

const NO_SETTLEMENTS: ReadonlyArray<QueueEditSettlement> = [];

/** The record an action belongs to, as either of its two frames. */
export function queueEditRecordForAction(
  records: QueueEditRecords,
  clientActionId: string,
): QueueEditRecord | null {
  for (const record of Object.values(records)) {
    if (record === undefined) continue;
    if (
      record.editActionId === clientActionId ||
      record.followUpActionId === clientActionId
    ) {
      return record;
    }
  }
  return null;
}

export function withQueueEditRecord(
  records: QueueEditRecords,
  record: QueueEditRecord,
): QueueEditRecords {
  return { ...records, [record.editActionId]: record };
}

export function withoutQueueEditRecord(
  records: QueueEditRecords,
  editActionId: string,
): QueueEditRecords {
  return Object.fromEntries(
    Object.entries(records).filter(([id]) => id !== editActionId),
  );
}

/**
 * Retire the returned records aimed at a row the host has just cancelled.
 *
 * A record whose text went back as unconfirmed is kept so that a later save
 * can be reported as a duplicate. An accepted cancel of its row ends that
 * watch with a fact rather than an absence: the host removed the row while it
 * was still queued, and it refuses an edit for a row it no longer holds, so
 * nothing can save or run that text from here on.
 *
 * Only returned records: one whose text is still in custody is owed its own
 * ack, which the host sends whether the cancel got there first or not.
 */
export function withoutReturnedQueueEditsForRow(
  records: QueueEditRecords,
  queueItemId: string,
): QueueEditRecords {
  const kept = Object.entries(records).filter(
    ([, record]) =>
      record === undefined ||
      !(record.contentReturned && record.queueItemId === queueItemId),
  );
  return kept.length === Object.keys(records).length
    ? records
    : Object.fromEntries(kept);
}

/**
 * The records still holding a submission nothing else holds: every record
 * whose text has not been handed back. These are what a disposing session must
 * hand off and what an eviction must wait for.
 *
 * That includes one whose text the host has ALREADY saved while its second
 * frame is unanswered. The text is safe, but the submission is not: the
 * settings that were asked for and the annotation cards captured with it are
 * held by this record alone until that frame is accounted for, and a session
 * disposed in between would take them with it.
 */
export function queueEditRecordsInCustody(
  records: QueueEditRecords,
): ReadonlyArray<QueueEditRecord> {
  return Object.values(records).filter(
    (record): record is QueueEditRecord =>
      record !== undefined && !record.contentReturned,
  );
}

/** Whether any record is waiting on host evidence rather than on an ack. */
export function hasUnconfirmedQueueEdit(records: QueueEditRecords): boolean {
  for (const record of Object.values(records)) {
    if (record === undefined) continue;
    if (record.edit === "unconfirmed" || record.followUp === "unconfirmed") {
      return true;
    }
  }
  return false;
}

interface SettledQueueEditRecord {
  readonly record: QueueEditRecord | null;
  readonly settlements: ReadonlyArray<QueueEditSettlement>;
}

/**
 * What a record owes once an outcome has moved, and what is left of it.
 *
 * The text goes back as soon as its own frame is refused or left unconfirmed:
 * waiting on the second frame would hold the user's only copy behind an answer
 * that changes nothing about where the text belongs. The record survives that
 * hand-back - a refused one until the second frame is answered, so its refusal
 * is not narrated as a separate failure, and an unconfirmed one until the host
 * shows what it did.
 */
function settleQueueEditRecord(
  record: QueueEditRecord,
  returned: {
    readonly cause: QueueEditReturnCause;
    readonly hostReason: string | null;
  },
): SettledQueueEditRecord {
  const settlements: QueueEditSettlement[] = [];
  let next = record;
  if (
    (next.edit === "rejected" || next.edit === "unconfirmed") &&
    !next.contentReturned
  ) {
    settlements.push({
      kind: "content_returned",
      clientActionId: next.editActionId,
      restore: next.restore,
      wireContent: next.wireContent,
      cause: returned.cause,
      hostReason: returned.hostReason,
    });
    next = { ...next, contentReturned: true };
  }
  if (
    next.edit === "accepted" &&
    (next.followUp === "rejected" || next.followUp === "unconfirmed")
  ) {
    settlements.push({
      kind: "partial",
      clientActionId: next.followUpActionId,
      intent: next.intent,
      restore: next.restore,
      requestedChanges: next.requestedChanges,
      refused: next.followUp === "rejected",
      hostReason: next.followUpReason,
    });
    return { record: null, settlements };
  }
  // Not for a follow-up that asked the row to change nothing: there is no
  // second outcome to tell.
  if (
    next.edit === "rejected" &&
    next.followUp === "accepted" &&
    !next.followUpIsNoOp
  ) {
    settlements.push({
      kind: "follow_up_alone",
      clientActionId: next.followUpActionId,
      intent: next.intent,
      requestedChanges: next.requestedChanges,
    });
  }
  const landedWhole = next.edit === "accepted" && next.followUp === "accepted";
  const refusedAndAnswered =
    next.edit === "rejected" && next.followUp !== "pending";
  return {
    record: landedWhole || refusedAndAnswered ? null : next,
    settlements,
  };
}

/**
 * What an answer to the second frame leaves of it.
 *
 * A refusal of a frame that asked the row to change nothing leaves nothing
 * unapplied - typically a text-only save whose row started between the two
 * frames, so the settings frame found no row. It is recorded as answered in
 * full, so no outcome downstream reports settings that "were not applied"
 * for a submission that asked for none.
 */
function followUpOutcomeForAck(
  record: QueueEditRecord,
  status: "accepted" | "rejected",
): QueueEditFrameOutcome {
  return status === "rejected" && record.followUpIsNoOp ? "accepted" : status;
}

/**
 * Fold one `actionAck` into the records. Unchanged (same reference, no
 * settlements) for an ack that names neither frame of any record.
 */
export function foldQueueEditAck(
  records: QueueEditRecords,
  ack: {
    readonly clientActionId: string;
    readonly status: "accepted" | "rejected";
    readonly reason: string | null;
  },
): QueueEditFold {
  const record = queueEditRecordForAction(records, ack.clientActionId);
  if (record === null) return { records, settlements: NO_SETTLEMENTS };
  const answersEdit = record.editActionId === ack.clientActionId;
  const answered: QueueEditRecord = answersEdit
    ? { ...record, edit: ack.status }
    : {
        ...record,
        followUp: followUpOutcomeForAck(record, ack.status),
        followUpReason: ack.status === "rejected" ? ack.reason : null,
      };
  const { record: next, settlements } = settleQueueEditRecord(answered, {
    cause: "refused",
    hostReason: answersEdit ? ack.reason : null,
  });
  return {
    records:
      next === null
        ? withoutQueueEditRecord(records, record.editActionId)
        : withQueueEditRecord(records, next),
    settlements,
  };
}

/** An image node reduced to the one attribute that survives the host. */
function imageHashOf(node: JsonContent): string | null {
  return stringValue(node.attrs?.hash);
}

/** Whether every image in the document names its bytes by hash. */
function everyImageIsHashed(node: JsonContent): boolean {
  if (node.type === "imageAttachment") return imageHashOf(node) !== null;
  return (node.content ?? []).every(everyImageIsHashed);
}

/**
 * The document with each image reduced to its hash, IN PLACE: same node, same
 * position, same number of occurrences.
 */
function withImagesByHash(node: JsonContent): JsonContent {
  if (node.type === "imageAttachment") {
    return { type: "imageAttachment", attrs: { hash: imageHashOf(node) } };
  }
  if (node.content === undefined) return node;
  return { ...node, content: node.content.map(withImagesByHash) };
}

/** `JSON.stringify` with object keys ordered and absent values dropped. */
function canonicalJson(value: JsonContent): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return inner;
    }
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) {
      const entry: unknown = Reflect.get(inner, key);
      if (entry !== null && entry !== undefined) ordered[key] = entry;
    }
    return ordered;
  });
}

/**
 * Whether the host holds exactly the document this edit sent.
 *
 * A structural comparison, node for node and in order. The one thing it
 * normalises is how an image names its bytes: the frame carries them inline
 * when this host is not known to hold them, and the host stores them by hash,
 * so the document that comes back is never byte-identical to the one that left
 * even when the edit landed exactly. Everything else has to be the same -
 * including where each image sits and how many times it appears, because an
 * edit that only moves or repeats an image is still an edit. A document with
 * an image that names no hash matches nothing: there is no identity to compare.
 */
export function queueEditContentMatches(
  sent: JsonContent,
  held: JsonContent,
): boolean {
  if (!everyImageIsHashed(sent) || !everyImageIsHashed(held)) return false;
  return (
    canonicalJson(withImagesByHash(sent)) ===
    canonicalJson(withImagesByHash(held))
  );
}

/** What the host can be seen to hold, at the moment a record is accounted for. */
export interface QueueEditEvidence {
  readonly queue: ChatQueueState;
  /**
   * The transcript messages whose bodies this client holds. Never the whole
   * story: a windowed transcript holds only its loaded rows, and on any line a
   * row can leave the queue a frame before the message it became arrives. So
   * a message that is not here is not evidence of anything.
   */
  readonly messages: ReadonlyArray<Message>;
  readonly settingsEqual: (a: ChatRunSettings, b: ChatRunSettings) => boolean;
  readonly accountContextEqual: (
    a: AccountContext,
    b: AccountContext,
  ) => boolean;
}

type QueueEditVerdict = "applied" | "not_applied" | "unknown";

/**
 * Whether the host saved the edited text, as far as it can be SEEN.
 *
 * - The edited document on the row, or on the message the row became: applied.
 * - The message the row became, holding something else: not applied. The host
 *   refuses an edit to a prompt that has started, so nothing can change it now.
 *   Only when BOTH documents can be compared: one carrying an image with no
 *   hash (a sent document that went out with the bytes inline, or a held one
 *   that names none) has nothing to compare by, and a comparison that cannot
 *   be made is not a mismatch.
 * - Anything else is unknown, and stays unknown until one of the two above is
 *   seen. A row still showing other text may be about to change (the host
 *   finishes a handler it had already started when the connection dropped). A
 *   row that is gone with no message in hand may be a body not loaded, or a
 *   message one frame behind the queue change that removed the row. Absence is
 *   never read as an answer.
 */
function queueEditVerdict(
  record: QueueEditRecord,
  row: ChatQueuedItem | null,
  evidence: QueueEditEvidence,
): QueueEditVerdict {
  if (row !== null) {
    return row.kind === "prompt" &&
      queueEditContentMatches(record.wireContent, row.message.content)
      ? "applied"
      : "unknown";
  }
  const message = evidence.messages.find(
    (candidate) =>
      candidate.role === "user" && candidate.messageId === record.messageId,
  );
  if (message !== undefined && message.role === "user") {
    if (queueEditContentMatches(record.wireContent, message.message.content)) {
      return "applied";
    }
    // A document that went out with an image inline names no hash for it (the
    // bytes travel in the hash's place), so it can match nothing the host
    // holds; a held document with an image that names no hash can be matched
    // by nothing either. Failing to match is then no evidence that the prompt
    // ran as something else: it stays unknown, and is never told as "not
    // saved".
    return everyImageIsHashed(record.wireContent) &&
      everyImageIsHashed(message.message.content)
      ? "not_applied"
      : "unknown";
  }
  return "unknown";
}

/**
 * Whether the host can be SEEN to hold what the second frame asked for. Only a
 * still-queued row can show it: the settings and account it carries, or a
 * steer the host has taken. A row that is merely paused shows nothing.
 *
 * The row is read FIRST, ahead of what this client believed at dispatch. A
 * save that looked like a no-op then (the row already held those settings) is
 * not one if the row now shows others - another device changed them in
 * between - and saying "applied" over a row that visibly disagrees would be
 * the one claim this accounting exists not to make. Only once the row is gone,
 * and with it anything that could contradict, does that dispatch-time fact
 * stand: the submission asked the row to change nothing.
 */
function followUpShownApplied(
  record: QueueEditRecord,
  row: ChatQueuedItem | null,
  evidence: QueueEditEvidence,
): boolean {
  if (row === null) return record.followUpIsNoOp;
  if (row.kind !== "prompt") return false;
  if (record.intent === "save") {
    return (
      evidence.settingsEqual(row.settings, record.settings) &&
      evidence.accountContextEqual(row.accountContext, record.accountContext)
    );
  }
  return (
    row.steerRequest !== null ||
    row.status === "steering" ||
    row.status === "injected"
  );
}

/**
 * Account for one record that has a frame no ack will answer, from what the
 * host shows now.
 */
function accountForUnconfirmedRecord(
  record: QueueEditRecord,
  evidence: QueueEditEvidence,
): SettledQueueEditRecord {
  const row =
    evidence.queue.items.find(
      (item) => item.queueItemId === record.queueItemId,
    ) ?? null;
  const verdict =
    record.edit === "unconfirmed"
      ? queueEditVerdict(record, row, evidence)
      : null;
  const followUpApplied =
    record.followUp === "accepted" ||
    (record.followUp === "unconfirmed" &&
      followUpShownApplied(record, row, evidence));
  if (verdict === "applied" && record.contentReturned) {
    return {
      record: null,
      settlements: [
        {
          kind: "saved_after_return",
          // The second frame's id, not the edit's: the hand-back this follows
          // was stated under the edit's id, and a notice that shared it would
          // be counted as already delivered the moment that one was shown.
          clientActionId: record.followUpActionId,
          intent: record.intent,
          followUpApplied,
          followUpRefused: record.followUp === "rejected",
          hostReason:
            record.followUp === "rejected" ? record.followUpReason : null,
        },
      ],
    };
  }
  const edit = editOutcomeForVerdict(record.edit, verdict);
  // Kept whatever the text's own state: the row can show the settings or the
  // steer while it still holds the earlier text, and that row is gone by the
  // time a transcript message settles the text. Evidence dropped here could
  // not be read again, and a prompt that then ran with its earlier text would
  // be settled with nothing said about the second frame having gone ahead.
  const followUp = followUpApplied ? "accepted" : record.followUp;
  if (edit === record.edit && followUp === record.followUp) {
    return settleQueueEditRecord(record, UNCONFIRMED_RETURN);
  }
  return settleQueueEditRecord(
    { ...record, edit, followUp },
    verdict === "not_applied" ? NOT_APPLIED_RETURN : UNCONFIRMED_RETURN,
  );
}

const UNCONFIRMED_RETURN = { cause: "unconfirmed", hostReason: null } as const;
const NOT_APPLIED_RETURN = { cause: "not_applied", hostReason: null } as const;

function editOutcomeForVerdict(
  current: QueueEditFrameOutcome,
  verdict: QueueEditVerdict | null,
): QueueEditFrameOutcome {
  if (verdict === "applied") return "accepted";
  if (verdict === "not_applied") return "rejected";
  return current;
}

/**
 * Account for the records no ack can answer any more, from what the host
 * shows.
 *
 * Called with the ids a reconnect is about to sweep, BEFORE they are dropped:
 * a frame dispatched on an earlier connection will never be acked, so it
 * becomes `unconfirmed` here. Called again, with no swept ids, whenever the
 * host shows something new - a queue change, a later snapshot, a transcript
 * body arriving - so a record left unconfirmed is settled by the first
 * evidence that can settle it. A frame still pending on the current connection
 * is never touched: its ack can still arrive, and a snapshot not showing its
 * effect yet proves nothing about it.
 *
 * Nothing here ever re-sends.
 */
export function accountForQueueEdits(input: {
  readonly records: QueueEditRecords;
  readonly sweptActionIds: ReadonlySet<string>;
  readonly evidence: QueueEditEvidence;
}): QueueEditFold {
  let records = input.records;
  const settlements: QueueEditSettlement[] = [];
  for (const record of Object.values(input.records)) {
    if (record === undefined) continue;
    const swept = withSweptFramesUnconfirmed(record, input.sweptActionIds);
    if (swept.edit !== "unconfirmed" && swept.followUp !== "unconfirmed") {
      continue;
    }
    const accounted = accountForUnconfirmedRecord(swept, input.evidence);
    if (accounted.record === record && accounted.settlements.length === 0) {
      continue;
    }
    records =
      accounted.record === null
        ? withoutQueueEditRecord(records, record.editActionId)
        : withQueueEditRecord(records, accounted.record);
    settlements.push(...accounted.settlements);
  }
  return { records, settlements };
}

/** The record with each swept, still-pending frame marked unanswerable. */
function withSweptFramesUnconfirmed(
  record: QueueEditRecord,
  sweptActionIds: ReadonlySet<string>,
): QueueEditRecord {
  const editSwept =
    record.edit === "pending" && sweptActionIds.has(record.editActionId);
  const followUpSwept =
    record.followUp === "pending" &&
    sweptActionIds.has(record.followUpActionId);
  if (!editSwept && !followUpSwept) return record;
  return {
    ...record,
    edit: editSwept ? "unconfirmed" : record.edit,
    followUp: followUpSwept ? "unconfirmed" : record.followUp,
  };
}

/** What a queued row's own control is doing while its frame is unanswered. */
export type QueueItemInFlight = "saving" | "requesting_steer" | "cancelling";

// `queueCancel` is listed for completeness of the derivation, but the chat tile
// never draws it: a row whose cancel is pending is hidden outright
// (`projectQueueWithPendingCancellations`) and comes back if the host refuses.
// "Cancelling" is therefore what an aborted steer shows, on a row that stays.
const IN_FLIGHT_BY_ACTION: Partial<
  Record<PendingChatAction["action"], QueueItemInFlight>
> = {
  queueEdit: "saving",
  queueSettingsUpdate: "saving",
  queueReorder: "saving",
  queueSteerNow: "requesting_steer",
  queueCancel: "cancelling",
  queueAbortSteer: "cancelling",
};

/**
 * The rows with a mutation the host has not answered, and what each is doing.
 *
 * Derived from the pending actions themselves, so it clears on exactly the
 * events that clear them: the ack, or the reconnect sweep. A steer outranks a
 * save on one row because a save-and-steer submission dispatches both, and the
 * steer is the half still to be decided.
 */
export function queueItemsInFlight(
  pendingActions: Readonly<Record<string, PendingChatAction>>,
): ReadonlyMap<string, QueueItemInFlight> {
  const inFlight = new Map<string, QueueItemInFlight>();
  for (const pending of Object.values(pendingActions)) {
    if (pending.queueItemId === null) continue;
    const stage = IN_FLIGHT_BY_ACTION[pending.action];
    if (stage === undefined) continue;
    const current = inFlight.get(pending.queueItemId);
    if (current === undefined || stage === "requesting_steer") {
      inFlight.set(pending.queueItemId, stage);
    }
  }
  return inFlight;
}

/** The pill a row shows while its own mutation is unanswered. */
export function queueItemInFlightLabel(stage: QueueItemInFlight): string {
  switch (stage) {
    case "saving":
      return "Saving";
    case "requesting_steer":
      return "Requesting steer";
    case "cancelling":
      return "Cancelling";
  }
}

/**
 * How long a `send` may stay unanswered on an open stream before the row stops
 * claiming it is on its way. A DISPLAY deadline only: nothing is rejected,
 * nothing is retransmitted, and the send keeps every id it was dispatched with.
 */
export const UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS = 30_000;
