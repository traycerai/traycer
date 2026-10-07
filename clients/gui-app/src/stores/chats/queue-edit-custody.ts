import type {
  ChatQueuedItem,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { recoveryTextFromContent } from "@/lib/composer/content-recovery";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
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

/** One frame's answer. `pending` until its ack arrives or a reconnect sweeps it. */
export type QueueEditFrameOutcome = "pending" | "accepted" | "rejected";

/**
 * An edited queued prompt, held from the moment the composer is cleared until
 * the host has answered for BOTH frames the submission went out as.
 *
 * A queue edit is two independent stream frames - `queueEdit` (the text) and
 * `queueSettingsUpdate` or `queueSteerNow` (the settings, or the steer) - and
 * the composer clears as soon as both are dispatched. Before this record the
 * edited text lived nowhere after that clear: a `queueEdit` the host refused
 * because the item had already started left a warning and nothing to recover
 * (traycerai/traycer#2418).
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
   * leaves the queue this is the only way to find what the host ran, which is
   * what a reconnect reads to learn whether the edit landed first.
   */
  readonly messageId: string;
  readonly intent: QueueEditIntent;
  /** The composer's own document plus its annotation cards - what goes back. */
  readonly restore: ChatSendRestore;
  /** The document the `queueEdit` frame carried - what the host would hold. */
  readonly wireContent: JsonContent;
  readonly settings: ChatRunSettings;
  readonly editActionId: string;
  /** The `queueSettingsUpdate` (save) or `queueSteerNow` (steer) action. */
  readonly followUpActionId: string;
  readonly edit: QueueEditFrameOutcome;
  readonly followUp: QueueEditFrameOutcome;
  /**
   * Whether the edited text has already been handed back. A refused content
   * edit returns it at once rather than waiting on the second frame, and the
   * record then stays only to account for that frame's answer.
   */
  readonly contentReturned: boolean;
  /** Local dispatch time. Never shown as a host-confirmed transition. */
  readonly dispatchedAt: number;
}

export type QueueEditRecords = Readonly<
  Record<string, QueueEditRecord | undefined>
>;

/** What settling a record owes the user. Nothing, for a submission that landed whole. */
export type QueueEditSettlement =
  /**
   * The text was not saved. The edited draft goes back to the composer (or to
   * a copyable entry when a newer draft is there); the original prompt is left
   * to whatever the host did with it and is never re-sent from here.
   */
  | {
      readonly kind: "content_returned";
      readonly clientActionId: string;
      readonly restore: ChatSendRestore;
      /** The host's refusal, or `null` when a reconnect settled it. */
      readonly hostReason: string | null;
    }
  /** The text was saved and the second frame was not applied. */
  | {
      readonly kind: "partial";
      readonly clientActionId: string;
      readonly intent: QueueEditIntent;
      /** The host's refusal, or `null` when a reconnect could not confirm it. */
      readonly hostReason: string | null;
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

function withoutQueueEditRecord(
  records: QueueEditRecords,
  editActionId: string,
): QueueEditRecords {
  return Object.fromEntries(
    Object.entries(records).filter(([id]) => id !== editActionId),
  );
}

/**
 * What a record owes once an outcome has moved, and what is left of it.
 *
 * A refused content edit returns the text IMMEDIATELY: waiting for the second
 * frame would hold the user's only copy behind an answer that changes nothing
 * about where the text belongs. The record survives that hand-back until the
 * second frame is accounted for, so its refusal is not narrated as a separate
 * failure of a submission already reported.
 */
function settleQueueEditRecord(
  record: QueueEditRecord,
  hostReason: string | null,
): {
  readonly record: QueueEditRecord | null;
  readonly settlement: QueueEditSettlement | null;
} {
  const settled = record.edit !== "pending" && record.followUp !== "pending";
  if (record.edit === "rejected" && !record.contentReturned) {
    return {
      record: settled ? null : { ...record, contentReturned: true },
      settlement: {
        kind: "content_returned",
        clientActionId: record.editActionId,
        restore: record.restore,
        hostReason,
      },
    };
  }
  if (record.edit === "accepted" && record.followUp === "rejected") {
    return {
      record: null,
      settlement: {
        kind: "partial",
        clientActionId: record.followUpActionId,
        intent: record.intent,
        hostReason,
      },
    };
  }
  return { record: settled ? null : record, settlement: null };
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
  const answered: QueueEditRecord =
    record.editActionId === ack.clientActionId
      ? { ...record, edit: ack.status }
      : { ...record, followUp: ack.status };
  const { record: next, settlement } = settleQueueEditRecord(
    answered,
    ack.status === "rejected" ? ack.reason : null,
  );
  return {
    records:
      next === null
        ? withoutQueueEditRecord(records, record.editActionId)
        : withQueueEditRecord(records, next),
    settlements: settlement === null ? NO_SETTLEMENTS : [settlement],
  };
}

/**
 * Whether two documents are the same prompt as far as a person can tell: the
 * same recoverable text and the same images.
 *
 * Deliberately not `JSON.stringify` equality. The frame carries images inline
 * when this host is not known to hold their bytes, and the host stores them by
 * hash, so the document that comes back is never byte-identical to the one that
 * left even when the edit landed exactly.
 */
export function queueEditContentMatches(
  sent: JsonContent,
  held: JsonContent,
): boolean {
  if (recoveryTextFromContent(sent) !== recoveryTextFromContent(held)) {
    return false;
  }
  const sentHashes = [...blobHashesFromContent(sent)].sort();
  const heldHashes = [...blobHashesFromContent(held)].sort();
  return (
    sentHashes.length === heldHashes.length &&
    sentHashes.every((hash, index) => hash === heldHashes[index])
  );
}

interface HeldQueueEditContent {
  /** The row, while it is still queued. */
  readonly row: ChatQueuedItem | null;
  /** The document the host holds for it - queued or run - or `null` if unknown. */
  readonly content: JsonContent | null;
}

/** What the host holds for a record's prompt now - queued, run, or unknown. */
function heldContentFor(
  record: QueueEditRecord,
  queue: ChatQueueState,
  messages: ReadonlyArray<Message>,
): HeldQueueEditContent {
  const row =
    queue.items.find((item) => item.queueItemId === record.queueItemId) ?? null;
  if (row !== null) {
    return {
      row,
      content: row.kind === "prompt" ? row.message.content : null,
    };
  }
  const message = messages.find(
    (candidate) =>
      candidate.role === "user" && candidate.messageId === record.messageId,
  );
  return {
    row: null,
    content:
      message !== undefined && message.role === "user"
        ? message.message.content
        : null,
  };
}

/**
 * A swept content edit, decided by what the host holds: only the edited text
 * itself, on the row or on the message the row became, confirms it landed.
 */
function sweptEditOutcome(
  record: QueueEditRecord,
  held: HeldQueueEditContent,
): QueueEditFrameOutcome {
  if (held.content === null) return "rejected";
  return queueEditContentMatches(record.wireContent, held.content)
    ? "accepted"
    : "rejected";
}

/**
 * A swept second frame nobody can answer for any more. It is read as applied
 * unless a still-queued row shows otherwise: once the row has run, the
 * transcript is what says how.
 */
function sweptFollowUpOutcome(
  record: QueueEditRecord,
  held: HeldQueueEditContent,
  settingsEqual: (a: ChatRunSettings, b: ChatRunSettings) => boolean,
): QueueEditFrameOutcome {
  if (held.row === null) return "accepted";
  return followUpAppliedOnRow(record, held.row, settingsEqual)
    ? "accepted"
    : "rejected";
}

/**
 * Whether a still-queued row shows the second frame landed. A row that has left
 * the queue answers nothing here: the transcript shows how it ran.
 */
function followUpAppliedOnRow(
  record: QueueEditRecord,
  row: ChatQueuedItem,
  settingsEqual: (a: ChatRunSettings, b: ChatRunSettings) => boolean,
): boolean {
  if (row.kind !== "prompt") return false;
  if (record.intent === "save") {
    return settingsEqual(row.settings, record.settings);
  }
  // A steer the host took leaves the row aimed at the running turn, or already
  // moved on from `pending` (requested, steering, injected, or fallen back with
  // the row saying so itself).
  return row.delivery === "same_turn" || row.status !== "pending";
}

/**
 * Account for the records whose acks died with an earlier connection, BEFORE
 * their action ids are swept.
 *
 * Scoped to swept ids only, like the cancel restorations: a frame dispatched on
 * the current connection can still be answered, and the snapshot not showing
 * its effect yet proves nothing about it.
 *
 * The snapshot is the evidence. The edited text on the row - or on the message
 * the row became - confirms the edit landed. Anything else leaves the edit
 * unconfirmed, and the text goes back to the user: a copy they may not need is
 * recoverable, a correction held nowhere is not. Nothing here ever re-sends.
 */
export function settleQueueEditsForSnapshot(input: {
  readonly records: QueueEditRecords;
  readonly sweptActionIds: ReadonlySet<string>;
  readonly queue: ChatQueueState;
  readonly messages: ReadonlyArray<Message>;
  readonly settingsEqual: (a: ChatRunSettings, b: ChatRunSettings) => boolean;
}): QueueEditFold {
  let records = input.records;
  const settlements: QueueEditSettlement[] = [];
  for (const record of Object.values(input.records)) {
    if (record === undefined) continue;
    const editSwept =
      record.edit === "pending" &&
      input.sweptActionIds.has(record.editActionId);
    const followUpSwept =
      record.followUp === "pending" &&
      input.sweptActionIds.has(record.followUpActionId);
    if (!editSwept && !followUpSwept) continue;
    const held = heldContentFor(record, input.queue, input.messages);
    const edit = editSwept ? sweptEditOutcome(record, held) : record.edit;
    const followUp = followUpSwept
      ? sweptFollowUpOutcome(record, held, input.settingsEqual)
      : record.followUp;
    const { record: next, settlement } = settleQueueEditRecord(
      { ...record, edit, followUp },
      null,
    );
    records =
      next === null
        ? withoutQueueEditRecord(records, record.editActionId)
        : withQueueEditRecord(records, next);
    if (settlement !== null) settlements.push(settlement);
  }
  return { records, settlements };
}

/** What a queued row's own control is doing while its frame is unanswered. */
export type QueueItemInFlight = "saving" | "requesting_steer" | "cancelling";

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
