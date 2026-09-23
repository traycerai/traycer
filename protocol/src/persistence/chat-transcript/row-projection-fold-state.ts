import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/senders";

import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * # The row projection's persisted fold state, and the vocabulary of its increment
 *
 * `projectTranscriptRows` is a whole-history fold: steer retraction, the
 * profile walk, the running session anchor, checkpoint overlap, pause
 * correlation and the setup-window partition all read the whole chat. A store
 * that keeps the projection's output as a persisted row index therefore cannot
 * derive a changed row from its neighbourhood - it has to re-run the fold, and
 * it can only afford to re-run it over what changed if the fold's own running
 * state is persisted beside the index. This module is that state's shape, plus
 * the types the increment (`foldTranscriptRows` in `row-projection.ts`) speaks.
 *
 * Types only, plus the pure order-key codec: nothing here knows what a row is,
 * which is what lets `row-projection.ts` import it without a cycle.
 *
 * ## Units
 *
 * The projection's rows come from four kinds of producer, and each produces its
 * rows from a bounded set of records. A UNIT is one producer: a user record's
 * row, one assistant turn's rows (or its synthesized stopped row), one
 * row-materializing event's row, one setup window's card. The increment
 * re-describes whole units, and a store replaces a unit's rows as one set.
 *
 * ## The order key
 *
 * Ordinals come from a STABLE sort by `createdAt` over rows concatenated in a
 * fixed pass order, then a weave that puts anchored setup cards above their
 * anchor row, then two pins (the imported-chat marker above everything, the
 * genesis card above the transcript). Every one of those decisions is a
 * comparison over values a unit knows about its own rows, so the whole order
 * is a lexicographic comparison of {@link TranscriptRowOrder}. That is what
 * lets a store keep ordinals as `ROW_NUMBER() OVER (ORDER BY order_key)`
 * without ever holding the chat.
 */

/** A record together with its place in first-insert order. */
export interface PositionedMessage {
  /**
   * First-insert order. The array index in the whole-array entry; the
   * store's `insert_seq` (reset when a tombstoned record is re-inserted, which
   * is what `applyChatOp` does to its array) otherwise. Only its ORDER is
   * meaningful.
   */
  readonly position: number;
  readonly message: Message;
}

export interface PositionedEvent {
  readonly position: number;
  readonly event: ChatEvent;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** The imported-chat marker pin, then the genesis card pin, then the weave. */
export const TRANSCRIPT_ROW_SECTION = {
  importedMarker: 0,
  genesisCard: 1,
  woven: 2,
} as const;

/**
 * The pass a woven row was concatenated in before the stable sort. Ties on
 * `createdAt` keep this order, and inside one pass they keep record order.
 */
export const TRANSCRIPT_ROW_PASS = {
  /** User rows and assistant turns, interleaved in record order. */
  walk: 0,
  /** Synthesized stopped-turn rows, in first-stop order. */
  stoppedTurn: 1,
  forkedChatLink: 2,
  notificationAnchor: 3,
  autoJudgeUnattendedDenial: 4,
  /** Setup cards with no anchor row, in window order. */
  floatingSetupCard: 5,
} as const;

/** A card woven above its anchor sorts before the anchor itself. */
export const TRANSCRIPT_ROW_SLOT = { anchoredCard: 0, row: 1 } as const;

export interface TranscriptRowOrder {
  readonly section: number;
  readonly createdAt: number;
  readonly pass: number;
  /** The producing record's position; the window index for a floating card. */
  readonly position: number;
  /** The row's index inside its unit - a turn's slices and steers. */
  readonly entry: number;
  readonly slot: number;
  /** The window index of an anchored card; 0 otherwise. */
  readonly card: number;
}

function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function compareTranscriptRowOrder(
  a: TranscriptRowOrder,
  b: TranscriptRowOrder,
): number {
  return (
    compareNumbers(a.section, b.section) ||
    compareNumbers(a.createdAt, b.createdAt) ||
    compareNumbers(a.pass, b.pass) ||
    compareNumbers(a.position, b.position) ||
    compareNumbers(a.entry, b.entry) ||
    compareNumbers(a.slot, b.slot) ||
    compareNumbers(a.card, b.card)
  );
}

const FLOAT_HEX_CHARS = 16;
const SMALL_INT_HEX_CHARS = 8;
const DIGIT_HEX_CHARS = 1;
const SMALL_INT_LIMIT = 0xffffffff;

/**
 * A float64 as sixteen hex digits whose BYTE order is its numeric order.
 *
 * The IEEE bits of a non-negative double already sort as unsigned integers;
 * setting the sign bit lifts them above every negative, and inverting a
 * negative's bits reverses its magnitude order. `-0` is folded to `0` because
 * the comparator the projection sorts with treats them as equal.
 */
function orderedFloatHex(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("row order: a non-finite number cannot be ordered");
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value === 0 ? 0 : value);
  let high = view.getUint32(0);
  let low = view.getUint32(4);
  if (high >= 0x80000000) {
    high = ~high >>> 0;
    low = ~low >>> 0;
  } else {
    high = (high | 0x80000000) >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

function floatFromOrderedHex(hex: string): number {
  let high = Number.parseInt(hex.slice(0, 8), 16);
  let low = Number.parseInt(hex.slice(8, 16), 16);
  if (high >= 0x80000000) {
    high = (high & 0x7fffffff) >>> 0;
  } else {
    high = ~high >>> 0;
    low = ~low >>> 0;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, high);
  view.setUint32(4, low);
  return view.getFloat64(0);
}

function smallIntHex(value: number, width: number): string {
  if (!Number.isInteger(value) || value < 0 || value > SMALL_INT_LIMIT) {
    throw new Error("row order: a component is out of its integer range");
  }
  return value.toString(16).padStart(width, "0");
}

/**
 * The order as one string whose byte order is {@link compareTranscriptRowOrder}.
 *
 * Lowercase hex throughout, fixed width per component, so SQLite's BINARY
 * collation on a TEXT column orders keys exactly as the comparator does and a
 * covering index over the column serves `ROW_NUMBER()` and keyset cursors.
 */
export function encodeTranscriptRowOrder(order: TranscriptRowOrder): string {
  return (
    smallIntHex(order.section, DIGIT_HEX_CHARS) +
    orderedFloatHex(order.createdAt) +
    smallIntHex(order.pass, DIGIT_HEX_CHARS) +
    orderedFloatHex(order.position) +
    smallIntHex(order.entry, SMALL_INT_HEX_CHARS) +
    smallIntHex(order.slot, DIGIT_HEX_CHARS) +
    smallIntHex(order.card, SMALL_INT_HEX_CHARS)
  );
}

export const TRANSCRIPT_ROW_ORDER_KEY_LENGTH =
  DIGIT_HEX_CHARS +
  FLOAT_HEX_CHARS +
  DIGIT_HEX_CHARS +
  FLOAT_HEX_CHARS +
  SMALL_INT_HEX_CHARS +
  DIGIT_HEX_CHARS +
  SMALL_INT_HEX_CHARS;

const ORDER_KEY_PATTERN = /^[0-9a-f]+$/;

export function decodeTranscriptRowOrder(key: string): TranscriptRowOrder {
  if (
    key.length !== TRANSCRIPT_ROW_ORDER_KEY_LENGTH ||
    !ORDER_KEY_PATTERN.test(key)
  ) {
    throw new Error("row order: malformed order key");
  }
  let offset = 0;
  const take = (width: number): string => {
    const part = key.slice(offset, offset + width);
    offset += width;
    return part;
  };
  return {
    section: Number.parseInt(take(DIGIT_HEX_CHARS), 16),
    createdAt: floatFromOrderedHex(take(FLOAT_HEX_CHARS)),
    pass: Number.parseInt(take(DIGIT_HEX_CHARS), 16),
    position: floatFromOrderedHex(take(FLOAT_HEX_CHARS)),
    entry: Number.parseInt(take(SMALL_INT_HEX_CHARS), 16),
    slot: Number.parseInt(take(DIGIT_HEX_CHARS), 16),
    card: Number.parseInt(take(SMALL_INT_HEX_CHARS), 16),
  };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export function userRowUnitKey(messageId: string): string {
  return `u:${messageId}`;
}

export function turnRowUnitKey(turnKey: string): string {
  return `t:${turnKey}`;
}

export function eventRowUnitKey(eventId: string): string {
  return `e:${eventId}`;
}

export function setupCardUnitKey(windowIndex: number): string {
  return `s:${windowIndex}`;
}

export function isSetupCardUnitKey(unitKey: string): boolean {
  return unitKey.startsWith("s:");
}

// ---------------------------------------------------------------------------
// Record fold facts
// ---------------------------------------------------------------------------

/**
 * The version of {@link TranscriptMessageFoldFacts}' SHAPE and derivation.
 *
 * Facts are persisted beside each record and compared against a freshly
 * derived value to decide whether an in-place rewrite moved the whole-history
 * walk. A build that derives them differently must not compare against facts
 * an older build wrote, so a fact carrying another version - or a fold state
 * written under another version - makes the increment decline and the store
 * run the full projection.
 */
export const TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION = 1;

/**
 * What the whole-history walk reads from one message. A rewrite that leaves
 * these unchanged cannot move any row outside the record's own unit.
 */
export type TranscriptMessageFoldFacts =
  | {
      readonly v: number;
      readonly role: "user";
      readonly timestamp: number;
      readonly sessionAnchor: ChatSessionAnchor | null;
    }
  | {
      readonly v: number;
      readonly role: "assistant";
      readonly turnKey: string;
      readonly hasBlocks: boolean;
      readonly opensAutonomous: boolean;
      readonly hasTurnProfile: boolean;
      /** The user message ids this record's steer blocks name, in block order. */
      readonly steerTargets: readonly string[];
    };

/**
 * JSON with object keys sorted, so two structurally equal values compare equal
 * whatever key order produced them.
 */
export function canonicalFoldJson(value: unknown): string {
  return JSON.stringify(sortedKeys(value));
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const member: unknown = Reflect.get(value, key);
    if (member === undefined) continue;
    out[key] = sortedKeys(member);
  }
  return out;
}

export function transcriptMessageFoldFactsEqual(
  a: TranscriptMessageFoldFacts,
  b: TranscriptMessageFoldFacts,
): boolean {
  return canonicalFoldJson(a) === canonicalFoldJson(b);
}

// ---------------------------------------------------------------------------
// The fold state
// ---------------------------------------------------------------------------

export const TRANSCRIPT_FOLD_STATE_VERSION = 1;

/**
 * Where the record walk the increment re-runs starts.
 *
 * The session anchor and the legacy anchor timestamp are running values over
 * user records, and the profile walk counts dispatch attempts per span between
 * user records. None of them can be continued from the end of the chat when a
 * record in the middle changes - so the state keeps the walk's running values
 * as of a record near the tail, and everything from that record on is
 * re-walked, over fold facts and never bodies, whenever a walk fact there
 * moves. A walk fact moving BEFORE it widens that walk to the whole chat -
 * still facts only - rather than declining the increment; only the turns whose
 * walked state then differs from their stored state are re-described.
 *
 * The region never splits a turn: every record of a turn is on one side of
 * {@link TranscriptWalkRegion.from}. A new record for a turn that started
 * before it widens the walk too.
 */
export interface TranscriptWalkRegion {
  /** The position the region starts at, or `null` for the whole chat. */
  readonly from: number | null;
  /** The session anchor in effect just before {@link from}. */
  readonly anchorBefore: ChatSessionAnchor | null;
  /** `lastUserTimestamp` just before {@link from}. */
  readonly lastUserTimestampBefore: number | null;
  /**
   * The attempt turn keys the span {@link from} falls in collected before it,
   * in first-seen order. Records at or after {@link from} can still add
   * attempts to that span, and two or more mark every turn in it - these
   * included.
   */
  readonly spanKeysBefore: readonly string[];
  /**
   * Which of {@link spanKeysBefore} an EARLIER span marked. Every record of
   * those turns is before {@link from}, so this never moves; it is what lets
   * the span's own mark be re-decided for them without walking back.
   */
  readonly spanKeysMarkedElsewhere: readonly string[];
}

export interface TranscriptFoldState {
  readonly version: number;
  readonly factsVersion: number;
  /** The turn the index was projected as running - `null` for a store's index. */
  readonly activeTurnId: string | null;
  /** Highest message position folded, `null` before the first. */
  readonly messagesThrough: number | null;
  /** Highest event position folded, `null` before the first. */
  readonly eventsThrough: number | null;
  readonly region: TranscriptWalkRegion;
  /** Turns with a `turn.started` and no terminal event since, in start order. */
  readonly openTurnKeys: readonly string[];
  /** Steer targets: user message id to the turn keys whose steer blocks name it. */
  readonly steerTargets: Readonly<Record<string, readonly string[]>>;
  /** The running `steeredMessageIdsFromEvents` fold. */
  readonly completedSteer: {
    readonly messageIds: readonly string[];
    readonly requestMessageIdByQueueItemId: Readonly<Record<string, string>>;
  };
  /** `turnKeysWithLaterOverlappingChanges` over the whole event log. */
  readonly overlappingTurnKeys: readonly string[];
  /** User message id to the turns a `turn.stopped` naming it belongs to. */
  readonly stopTriggers: Readonly<Record<string, readonly string[]>>;
  readonly setup: {
    readonly windowCount: number;
    /** Whether the last window is still open. */
    readonly openWindow: boolean;
    /** Every row id a card is woven above. */
    readonly cardAnchors: readonly string[];
  };
}

export const EMPTY_TRANSCRIPT_FOLD_STATE: TranscriptFoldState = {
  version: TRANSCRIPT_FOLD_STATE_VERSION,
  factsVersion: TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION,
  activeTurnId: null,
  messagesThrough: null,
  eventsThrough: null,
  region: {
    from: null,
    anchorBefore: null,
    lastUserTimestampBefore: null,
    spanKeysBefore: [],
    spanKeysMarkedElsewhere: [],
  },
  openTurnKeys: [],
  steerTargets: {},
  completedSteer: { messageIds: [], requestMessageIdByQueueItemId: {} },
  overlappingTurnKeys: [],
  stopTriggers: {},
  setup: { windowCount: 0, openWindow: false, cardAnchors: [] },
};

/**
 * What an assistant turn's rows were projected with, stored with them so the
 * turn can be re-described later without re-walking the records before it.
 */
export interface TranscriptTurnUnitState {
  /** `lastUserTimestamp` at the turn's first record. */
  readonly lastUserTimestamp: number | null;
  /** The session anchor in effect at the turn's first record. */
  readonly sessionAnchor: ChatSessionAnchor | null;
  readonly profileWalkUnprovable: boolean;
}

// ---------------------------------------------------------------------------
// The increment's input, loads and output
// ---------------------------------------------------------------------------

export interface TranscriptMessageTouch {
  readonly position: number;
  /** The record as it stands after the change. */
  readonly message: Message;
  /**
   * The record as it stood BEFORE the change when it was live then - its
   * position and fold facts. `null` for a record that is new, or re-inserted
   * after a removal (which appends it, so it takes a new position).
   */
  readonly previous: {
    readonly position: number;
    readonly facts: TranscriptMessageFoldFacts;
  } | null;
}

export interface TranscriptMessageRemoval {
  readonly messageId: string;
  readonly position: number;
  /** The removed record's fold facts. */
  readonly facts: TranscriptMessageFoldFacts;
}

export interface TranscriptEventTouch {
  readonly position: number;
  readonly event: ChatEvent;
  /** The body the id held before, when the append replaced one in place. */
  readonly previous: ChatEvent | null;
}

/**
 * One change to fold, as the records stand after it. A message touched twice
 * in one change appears once, with the `previous` from before the change; an
 * event appended then replaced within the change appears once, as new.
 */
export interface TranscriptFoldChange {
  readonly chatId: string;
  readonly activeTurnId: string | null;
  readonly upsertedMessages: readonly TranscriptMessageTouch[];
  readonly removedMessages: readonly TranscriptMessageRemoval[];
  /** In position order. */
  readonly appendedEvents: readonly TranscriptEventTouch[];
}

/** An index row as the store holds it. */
export interface StoredTranscriptRow {
  readonly unitKey: string;
  readonly rowId: string;
  readonly order: TranscriptRowOrder;
  readonly unitState: TranscriptTurnUnitState | null;
}

/**
 * What the increment asks its driver for. Every answer reflects the records
 * AFTER the change, except where a request says otherwise; every list is in
 * position order and holds live records only.
 */
export type TranscriptFoldLoad =
  | {
      /**
       * The stored fold facts of every message at or after `position`; of
       * every message when `null`.
       */
      readonly kind: "facts-from";
      readonly position: number | null;
    }
  | {
      /** The stored fold facts of every message of these turns. */
      readonly kind: "facts-of-turns";
      readonly turnKeys: readonly string[];
    }
  | {
      /** Every message whose `assistantTurnKey` is one of these. */
      readonly kind: "messages-of-turns";
      readonly turnKeys: readonly string[];
    }
  | {
      readonly kind: "messages-by-id";
      readonly messageIds: readonly string[];
    }
  | {
      /**
       * Events persisted BEFORE this change whose stored row turn key is one
       * of these. The change's own appended events are the increment's to
       * associate; it never asks for them.
       */
      readonly kind: "events-of-turns";
      readonly turnKeys: readonly string[];
    }
  | {
      /** Every event of these types, the change's own included. */
      readonly kind: "events-by-type";
      readonly types: readonly ChatEvent["type"][];
    }
  | {
      /**
       * The `turnId` of the latest pause-opening event persisted before this
       * change with this correlation key, a non-null `turnId`, and a position
       * below `beforePosition`.
       */
      readonly kind: "pause-open";
      readonly pauseKey: string;
      readonly beforePosition: number;
    }
  | {
      /** The index rows the store holds for these units. */
      readonly kind: "unit-rows";
      readonly unitKeys: readonly string[];
    }
  | {
      /** The index rows the store holds with these row ids, any unit. */
      readonly kind: "rows-by-id";
      readonly rowIds: readonly string[];
    };

/** An event as the store holds it, with the turn it was stored as decorating. */
export interface PositionedTurnEvent extends PositionedEvent {
  readonly rowTurnKey: string;
}

/** A message's fold facts as the store holds them. */
export interface PositionedMessageFacts {
  readonly position: number;
  readonly messageId: string;
  readonly facts: TranscriptMessageFoldFacts;
}

export type TranscriptFoldLoadResult =
  | {
      readonly kind: "messages";
      readonly messages: readonly PositionedMessage[];
    }
  | {
      readonly kind: "facts";
      readonly facts: readonly PositionedMessageFacts[];
    }
  | { readonly kind: "events"; readonly events: readonly PositionedEvent[] }
  | {
      /** The answer to `events-of-turns`. */
      readonly kind: "turn-events";
      readonly events: readonly PositionedTurnEvent[];
    }
  | { readonly kind: "pause-open"; readonly turnId: string | null }
  | { readonly kind: "rows"; readonly rows: readonly StoredTranscriptRow[] };

export interface TranscriptFoldRow {
  readonly order: TranscriptRowOrder;
  readonly descriptor: TranscriptRowDescriptor;
  /** Set on an assistant turn's folded rows, `null` on every other row. */
  readonly unitState: TranscriptTurnUnitState | null;
}

/** One re-described unit: the rows that replace the unit's stored rows. */
export interface TranscriptFoldUnit {
  readonly unitKey: string;
  /** Empty when the unit no longer produces a row. */
  readonly rows: readonly TranscriptFoldRow[];
  /** The records the rows render from - a skeleton is computed over these. */
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
}

export type TranscriptFoldResult =
  | {
      readonly continued: false;
      /** Why the increment declined; the caller runs the full projection. */
      readonly reason: string;
    }
  | {
      readonly continued: true;
      readonly state: TranscriptFoldState;
      readonly units: readonly TranscriptFoldUnit[];
      /** The stored rows of every unit in {@link units}, as loaded. */
      readonly previousRows: readonly StoredTranscriptRow[];
      /** The turn each newly appended event decorates, for events that decorate one. */
      readonly eventRowTurnKeys: ReadonlyMap<string, string>;
    };
