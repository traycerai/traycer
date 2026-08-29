import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES,
  TRANSCRIPT_RANGE_MAX_BYTES,
  TRANSCRIPT_TAIL_MAX_BYTES,
  buildTranscriptRecordLookup,
  sliceTranscriptRange,
  sliceTranscriptTail,
  type TranscriptRangeSlice,
  type TranscriptTailSlice,
} from "@traycer/protocol/persistence/chat-transcript/read-range";

/**
 * `sliceTranscriptRange` is the read behind `loadRange`. These pin its boundary
 * behaviour - clamping, the deliberately-unclamped inverted span, the byte
 * budget's always-serve-one rule - plus the property that only exists because
 * rows are not records: several rows can share one record set, and the budget
 * must charge for it once.
 */

function makeUserMessage(fields: {
  messageId: string;
  timestamp: number;
  text?: string;
}): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: {
      kind: "user",
      content: { type: "text", text: fields.text ?? fields.messageId },
    },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  });
}

function makeEvent(fields: { eventId: string; timestamp: number }): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: "chat.forked",
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
  });
}

function userRow(message: Message): TranscriptRowDescriptor {
  return {
    rowId: message.messageId,
    createdAt: message.timestamp,
    source: { kind: "user", messageId: message.messageId },
    context: {},
  };
}

function forkRow(event: ChatEvent): TranscriptRowDescriptor {
  return {
    rowId: `forked-chat-link:${event.eventId}`,
    createdAt: event.timestamp,
    source: { kind: "forked-chat-link", eventId: event.eventId },
    context: {},
  };
}

/** Two slices of one turn - the many-rows-one-record-set shape. */
function sliceRows(
  turnKey: string,
  messageIds: readonly string[],
  createdAt: number,
): readonly TranscriptRowDescriptor[] {
  return [0, 1].map((chunkIndex) => ({
    rowId: `assistant:${turnKey}:part:${chunkIndex}`,
    createdAt,
    source: {
      kind: "assistant-slice" as const,
      turnKey,
      messageIds,
      blockIds: [],
      chunkIndex,
      split: true,
      synthesizedBoundary: false,
      decoratingEventIds: [],
      steeredMessageIds: [],
    },
    context: {},
  }));
}

function slice(
  rows: readonly TranscriptRowDescriptor[],
  messages: readonly Message[],
  events: readonly ChatEvent[],
  request: { fromOrdinal: number; toOrdinal: number; maxBytes: number },
): TranscriptRangeSlice {
  return sliceTranscriptRange(
    rows,
    buildTranscriptRecordLookup(messages, events),
    request,
  );
}

/**
 * What a row costs the budget: its records, its row id as a JSON array
 * element, and one separator byte each. Spelled out here rather than imported
 * so the tests state the accounting instead of restating the implementation -
 * if the two ever disagree, that is the bug.
 */
function rowCost(rowId: string, records: readonly Message[]): number {
  const idBytes = Buffer.byteLength(JSON.stringify(rowId), "utf8") + 1;
  return records.reduce(
    (total, record) => total + recordByteLength(record) + 1,
    idBytes,
  );
}

/** A budget that fits exactly these rows and nothing more. */
function budgetFor(
  rows: ReadonlyArray<{ rowId: string; records: readonly Message[] }>,
): number {
  return rows.reduce(
    (total, row) => total + rowCost(row.rowId, row.records),
    TRANSCRIPT_RANGE_ENVELOPE_RESERVE_BYTES,
  );
}

const M0 = makeUserMessage({ messageId: "m-0", timestamp: 10 });
const M1 = makeUserMessage({ messageId: "m-1", timestamp: 20 });
const M2 = makeUserMessage({ messageId: "m-2", timestamp: 30 });
const THREE = [M0, M1, M2];
const THREE_ROWS = THREE.map(userRow);

describe("sliceTranscriptRange", () => {
  it("returns an empty slice with reachedStart and reachedEnd true for an empty transcript", () => {
    const result = slice([], [], [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: 1000,
    });

    expect(result).toEqual({
      fromOrdinal: 0,
      rowIds: [],
      messages: [],
      events: [],
      rowContext: {},
      reachedStart: true,
      reachedEnd: true,
      truncatedAtOrdinal: undefined,
    });
  });

  it("treats toOrdinal as inclusive - {from:0,to:0} on a 3-row transcript serves exactly 1 row", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0"]);
    expect(result.reachedStart).toBe(true);
    expect(result.reachedEnd).toBe(false);
  });

  it("sets reachedStart and reachedEnd true for a full-span request", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 0,
      toOrdinal: 2,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0", "m-1", "m-2"]);
    expect(result.reachedStart).toBe(true);
    expect(result.reachedEnd).toBe(true);
  });

  it("sets reachedStart and reachedEnd false for a middle span", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 1,
      toOrdinal: 1,
      maxBytes: 100_000,
    });

    expect(result.fromOrdinal).toBe(1);
    expect(result.rowIds).toEqual(["m-1"]);
    expect(result.reachedStart).toBe(false);
    expect(result.reachedEnd).toBe(false);
  });

  it("a span entirely past the end is empty, NOT the last row clamped back", () => {
    // Previously this clamped `fromOrdinal` down and served row 2 while
    // reporting `fromOrdinal: 2` - an unsolicited row under an ordinal the
    // caller never asked for. The doc always said empty; the code did not.
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 10,
      toOrdinal: 20,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.reachedStart).toBe(true);
    expect(result.reachedEnd).toBe(true);
  });

  it("clamps a toOrdinal past the end and sets reachedEnd true", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 1,
      toOrdinal: 99,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-1", "m-2"]);
    expect(result.reachedEnd).toBe(true);
  });

  it("an inverted span yields an empty slice, because toOrdinal is NOT clamped up to fromOrdinal", () => {
    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 2,
      toOrdinal: 0,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual([]);
    expect(result.fromOrdinal).toBe(2);
    expect(result.reachedEnd).toBe(false);
  });

  it("stops early under the byte budget, naming the first ordinal that did not fit, and clears reachedEnd even when the request named the last row", () => {
    const budget = budgetFor([
      { rowId: "m-0", records: [M0] },
      { rowId: "m-1", records: [M1] },
    ]);

    const result = slice(THREE_ROWS, THREE, [], {
      fromOrdinal: 0,
      toOrdinal: 2,
      maxBytes: budget,
    });

    expect(result.rowIds).toEqual(["m-0", "m-1"]);
    expect(result.truncatedAtOrdinal).toBe(2);
    expect(result.reachedEnd).toBe(false);
  });

  it("always serves a single record that alone exceeds maxBytes, over budget, rather than producing a permanent hole", () => {
    const huge = makeUserMessage({
      messageId: "m-huge",
      timestamp: 40,
      text: "x".repeat(5_000),
    });
    const rows = [userRow(huge)];

    const result = slice(rows, [huge], [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: 10,
    });

    expect(result.rowIds).toEqual(["m-huge"]);
    expect(result.messages).toEqual([huge]);
  });

  it("rowIds keep the interleaved row order while messages and events split into their own arrays", () => {
    const event = makeEvent({ eventId: "e-1", timestamp: 15 });
    const rows = [userRow(M0), forkRow(event), userRow(M1)];

    const result = slice(rows, [M0, M1], [event], {
      fromOrdinal: 0,
      toOrdinal: 2,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0", "forked-chat-link:e-1", "m-1"]);
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0", "m-1"]);
    expect(result.events.map((e) => e.eventId)).toEqual(["e-1"]);
  });
});

describe("shared record sets", () => {
  it("sends a turn's records ONCE for all of its slices", () => {
    const turnRows = sliceRows("t-1", ["m-0", "m-1"], 10);

    const result = slice(turnRows, [M0, M1], [], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual([
      "assistant:t-1:part:0",
      "assistant:t-1:part:1",
    ]);
    // Two rows, one record set. Sending it per-slice would multiply the largest
    // bodies in a transcript by the number of steers in them.
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0", "m-1"]);
  });

  it("charges the budget once for a shared record set, so a second slice is free", () => {
    const turnRows = sliceRows("t-1", ["m-0", "m-1"], 10);
    // Exactly enough for the turn's records once, plus BOTH row ids. If the
    // second slice were charged for the records again it would not fit, and
    // the span would truncate at ordinal 1.
    const budget = budgetFor([
      { rowId: "assistant:t-1:part:0", records: [M0, M1] },
      { rowId: "assistant:t-1:part:1", records: [] },
    ]);

    const result = slice(turnRows, [M0, M1], [], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: budget,
    });

    expect(result.rowIds).toHaveLength(2);
    expect(result.truncatedAtOrdinal).toBeUndefined();
    expect(result.reachedEnd).toBe(true);
  });

  it("keeps a row whose record the authority no longer holds, rather than shifting every later ordinal", () => {
    const rows = [userRow(M0), userRow(M1)];

    // `m-1` is named by a row but missing from the lookup - a branch edit that
    // raced the read. The row keeps its ordinal and arrives body-less.
    const result = slice(rows, [M0], [], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: 100_000,
    });

    expect(result.rowIds).toEqual(["m-0", "m-1"]);
    expect(result.messages.map((m) => m.messageId)).toEqual(["m-0"]);
  });
});

describe("the frame ceiling", () => {
  /**
   * Encodes the slice exactly as `chatRangeResponseSchema` puts it on the wire,
   * so the assertion measures the FRAME rather than the records inside it.
   * `requestId` is at its schema maximum, which is the worst case the host has
   * to survive because the client picks it.
   */
  function encodedFrameBytes(result: TranscriptRangeSlice): number {
    return Buffer.byteLength(
      JSON.stringify({
        requestId: "r".repeat(128),
        epoch: 4_294_967_295,
        fromOrdinal: result.fromOrdinal,
        rowIds: result.rowIds,
        messages: result.messages,
        events: result.events,
        reachedStart: result.reachedStart,
        reachedEnd: result.reachedEnd,
        ...(result.truncatedAtOrdinal === undefined
          ? {}
          : { truncatedAtOrdinal: result.truncatedAtOrdinal }),
      }),
      "utf8",
    );
  }

  /**
   * The review's measured shape: 4,378 records averaging ~273 encoded bytes,
   * which came to a 1,196,401-byte frame under the old accounting. The padding
   * is what makes each record that size - an unpadded fixture is small enough
   * that 4,378 of them fit inside 1 MiB, and the test would then pass without
   * ever exercising the ceiling.
   */
  function manySmallRows(count: number): {
    readonly rows: readonly TranscriptRowDescriptor[];
    readonly messages: readonly Message[];
  } {
    const messages = Array.from({ length: count }, (_unused, index) =>
      makeUserMessage({
        messageId: `m-${index}`,
        timestamp: index,
        text: `row ${index} ${"x".repeat(140)}`,
      }),
    );
    return { rows: messages.map(userRow), messages };
  }

  it("keeps the ENCODED frame under the relay threshold for thousands of small rows", () => {
    // The cold review's exact measurement: 4,378 small records under a 1 MiB
    // budget produced a 1,196,401-byte frame - 148 KB past the threshold, with
    // no oversized record anywhere in it - because the budget counted only
    // `JSON.stringify(record)` and ignored the row ids, the separators and the
    // envelope. This is the assertion that was missing.
    const { rows, messages } = manySmallRows(4_378);

    const result = slice(rows, messages, [], {
      fromOrdinal: 0,
      toOrdinal: rows.length - 1,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });

    expect(encodedFrameBytes(result)).toBeLessThanOrEqual(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
    // Truncation is the mechanism: it must have stopped early rather than
    // served everything and happened to fit.
    expect(result.truncatedAtOrdinal).toBeDefined();
    expect(result.rowIds.length).toBeLessThan(rows.length);
  });

  it("clamps a client budget larger than the invariant instead of trusting it", () => {
    const { rows, messages } = manySmallRows(4_378);

    const result = slice(rows, messages, [], {
      fromOrdinal: 0,
      toOrdinal: rows.length - 1,
      // A client asking for 64 MiB is not a reason to emit a 64 MiB frame.
      maxBytes: 64 * 1024 * 1024,
    });

    expect(encodedFrameBytes(result)).toBeLessThanOrEqual(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
  });

  it("charges the row id, so ids alone cannot push the frame over", () => {
    // Same records, ids two orders of magnitude longer. If row ids were free
    // the two slices would serve the same number of rows and the second frame
    // would be far larger.
    const { messages } = manySmallRows(4_378);
    const shortIdRows = messages.map(userRow);
    const longIdRows: TranscriptRowDescriptor[] = messages.map((message) => ({
      rowId: `${message.messageId}:${"x".repeat(200)}`,
      createdAt: message.timestamp,
      source: { kind: "user", messageId: message.messageId },
      context: {},
    }));

    const request = {
      fromOrdinal: 0,
      toOrdinal: messages.length - 1,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    };
    const short = slice(shortIdRows, messages, [], request);
    const long = slice(longIdRows, messages, [], request);

    expect(long.rowIds.length).toBeLessThan(short.rowIds.length);
    expect(encodedFrameBytes(long)).toBeLessThanOrEqual(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
  });

  it("still serves one oversized row over budget - a permanent hole is worse than a late frame", () => {
    const huge = makeUserMessage({
      messageId: "m-huge",
      timestamp: 1,
      text: "x".repeat(2 * 1024 * 1024),
    });

    const result = slice([userRow(huge)], [huge], [], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });

    expect(result.rowIds).toEqual(["m-huge"]);
    expect(encodedFrameBytes(result)).toBeGreaterThan(
      TRANSCRIPT_RANGE_MAX_BYTES,
    );
  });
});

/**
 * A tail budget that fits exactly these rows and nothing more.
 *
 * No envelope reserve, unlike {@link budgetFor}: the tail does not own a frame,
 * it is one field of a snapshot, and `TRANSCRIPT_TAIL_MAX_BYTES` is already
 * only a quarter of the frame ceiling precisely so the rest of the snapshot
 * has room. Adding a second reserve here would be double-counting.
 */
function tailBudgetFor(
  rows: ReadonlyArray<{ rowId: string; records: readonly Message[] }>,
): number {
  return rows.reduce(
    (total, row) => total + rowCost(row.rowId, row.records),
    0,
  );
}

function tail(
  rows: readonly TranscriptRowDescriptor[],
  messages: readonly Message[],
  events: readonly ChatEvent[],
  maxBytes: number,
): TranscriptTailSlice {
  return sliceTranscriptTail(
    rows,
    buildTranscriptRecordLookup(messages, events),
    maxBytes,
  );
}

/**
 * The tail is the one budgeted read with a HARD ceiling.
 *
 * `sliceTranscriptRange` serves an over-budget row alone rather than leave a
 * permanent hole, because a `range` response is ordered against nothing. A
 * snapshot has no such protection - it is ordered against every delta after it,
 * and a re-snapshot is not even first on the wire - so the tail must be willing
 * to come back EMPTY and let `loadRange` do the work.
 */
describe("sliceTranscriptTail", () => {
  it("takes the last rows that fit, not the first", () => {
    const result = tail(
      THREE_ROWS,
      THREE,
      [],
      tailBudgetFor([
        { rowId: "m-1", records: [M1] },
        { rowId: "m-2", records: [M2] },
      ]),
    );

    expect(result.rowIds).toEqual(["m-1", "m-2"]);
    expect(result.fromOrdinal).toBe(1);
    expect(result.messages.map((message) => message.messageId)).toEqual([
      "m-1",
      "m-2",
    ]);
  });

  it("returns the whole transcript when it fits, anchored at ordinal 0", () => {
    const result = tail(THREE_ROWS, THREE, [], TRANSCRIPT_TAIL_MAX_BYTES);

    expect(result.rowIds).toEqual(["m-0", "m-1", "m-2"]);
    expect(result.fromOrdinal).toBe(0);
  });

  it("carries the served rows' projection context, and charges it", () => {
    // The tail is the one hydration nothing ever repairs: the planner counts
    // these rows hydrated, so no range is ever asked for them and a wrong
    // elapsed time or profile label persists until they are evicted.
    const withContext: readonly TranscriptRowDescriptor[] = THREE_ROWS.map(
      (row) =>
        row.rowId === "m-2"
          ? { ...row, context: { legacyRowAnchorAt: 7 } }
          : row,
    );
    const result = tail(withContext, THREE, [], TRANSCRIPT_TAIL_MAX_BYTES);

    expect(result.rowContext).toEqual({ "m-2": { legacyRowAnchorAt: 7 } });

    // The ceiling is HARD here, so an uncounted field would push a snapshot
    // past the frame invariant with no over-budget exception to fall back on.
    const budgetForTwo = tailBudgetFor([
      { rowId: "m-1", records: [M1] },
      { rowId: "m-2", records: [M2] },
    ]);
    expect(tail(THREE_ROWS, THREE, [], budgetForTwo).rowIds).toEqual([
      "m-1",
      "m-2",
    ]);
    expect(tail(withContext, THREE, [], budgetForTwo).rowIds).toEqual(["m-2"]);
  });

  it("returns an EMPTY tail rather than break the ceiling for one huge row", () => {
    // The whole reason this is not `sliceTranscriptRange` with a flag. The
    // client paints one round trip later for this chat; the alternative is an
    // oversized snapshot the relay can reorder against the deltas that follow.
    const huge = makeUserMessage({
      messageId: "m-huge",
      timestamp: 1,
      text: "x".repeat(2 * 1024 * 1024),
    });

    const result = tail([userRow(huge)], [huge], [], TRANSCRIPT_TAIL_MAX_BYTES);

    expect(result.rowIds).toEqual([]);
    expect(result.messages).toEqual([]);
    // `rows.length`, so a client can seat an empty tail against the skeleton
    // without a special case for "nothing hydrated".
    expect(result.fromOrdinal).toBe(1);
  });

  it("abandons the rows BEFORE an unfittable last row, because the tail is contiguous", () => {
    // Walking backward, the huge row is hit first and stops the walk - so the
    // tail is empty even though earlier rows would have fit. That is the
    // honest consequence of a contiguous tail, and it is pinned here so a
    // future change to skip-and-continue is a deliberate decision.
    const huge = makeUserMessage({
      messageId: "m-huge",
      timestamp: 40,
      text: "x".repeat(2 * 1024 * 1024),
    });
    const rows = [...THREE_ROWS, userRow(huge)];

    const result = tail(rows, [...THREE, huge], [], TRANSCRIPT_TAIL_MAX_BYTES);

    expect(result.rowIds).toEqual([]);
    expect(result.fromOrdinal).toBe(4);
  });

  it("clamps a caller asking for more than the tail budget", () => {
    const wide = Array.from({ length: 400 }, (unused, index) =>
      makeUserMessage({
        messageId: `w-${index}`,
        timestamp: index,
        text: "y".repeat(4_000),
      }),
    );

    const result = tail(wide.map(userRow), wide, [], 64 * 1024 * 1024);

    // Charged separately, because `rowIds` and `messages` are NOT parallel -
    // this file proves it twice over, deduplicating a record set shared across
    // rows and omitting one the lookup no longer holds. Pairing them by index
    // happens to hold for this fixture's one-record-per-row shape, and would
    // start measuring `undefined` the moment that stopped being true.
    const spent =
      result.rowIds.reduce((total, rowId) => total + rowCost(rowId, []), 0) +
      result.messages.reduce(
        (total, message) => total + recordByteLength(message) + 1,
        0,
      );
    expect(spent).toBeLessThanOrEqual(TRANSCRIPT_TAIL_MAX_BYTES);
    expect(result.rowIds.length).toBeLessThan(wide.length);
  });

  it("is empty for an empty transcript, anchored at 0", () => {
    const result = tail([], [], [], TRANSCRIPT_TAIL_MAX_BYTES);

    expect(result.rowIds).toEqual([]);
    expect(result.fromOrdinal).toBe(0);
  });

  it("charges a shared record set once across the rows that share it", () => {
    const rows = sliceRows("turn-1", [M0.messageId], 10);

    const result = tail(
      rows,
      [M0],
      [],
      tailBudgetFor([
        { rowId: rows[0].rowId, records: [M0] },
        { rowId: rows[1].rowId, records: [] },
      ]),
    );

    expect(result.rowIds).toEqual([rows[0].rowId, rows[1].rowId]);
    expect(result.messages).toEqual([M0]);
  });
});

function makeTurnEvent(fields: {
  eventId: string;
  type: ChatEvent["type"];
  turnId: string | null;
  timestamp: number;
}): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: fields.type,
    timestamp: fields.timestamp,
    turnId: fields.turnId,
    clientActionId: null,
    actor: null,
    message: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
  });
}

/**
 * A row is not only what it is built from.
 *
 * The renderer folds a turn's `turn.*` into its elapsed counter and its
 * `checkpoint.captured` into the restore affordance, by scanning the WHOLE
 * event array — which is exactly what a windowed client stops having. So the
 * ids travel with the row, and the range must actually carry the bodies.
 *
 * The failure this prevents is the quietest kind: hydration reports success and
 * the row renders with no duration and no restore point, looking merely poorer
 * rather than broken.
 */
describe("assistant rows carry the events that decorate them", () => {
  const TURN_KEY = "turn-1";
  const STARTED = makeTurnEvent({
    eventId: "e-started",
    type: "turn.started",
    turnId: TURN_KEY,
    timestamp: 5,
  });
  const CHECKPOINT = makeTurnEvent({
    eventId: "e-checkpoint",
    type: "checkpoint.captured",
    turnId: TURN_KEY,
    timestamp: 7,
  });
  const OTHER_TURN = makeTurnEvent({
    eventId: "e-other",
    type: "turn.started",
    turnId: "turn-2",
    timestamp: 9,
  });

  function decoratedRows(): readonly TranscriptRowDescriptor[] {
    return sliceRows(TURN_KEY, [M0.messageId], 10).map((row) => {
      if (row.source.kind !== "assistant-slice")
        throw new Error("expected slice");
      return {
        ...row,
        source: {
          ...row.source,
          decoratingEventIds: [STARTED.eventId, CHECKPOINT.eventId],
        },
      };
    });
  }

  it("serves a row's turn-lifecycle and checkpoint events with its records", () => {
    const rows = decoratedRows();

    const result = slice(rows, [M0], [STARTED, CHECKPOINT, OTHER_TURN], {
      fromOrdinal: 0,
      toOrdinal: 0,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });

    expect(result.events.map((event) => event.eventId)).toEqual([
      "e-started",
      "e-checkpoint",
    ]);
    expect(result.messages.map((message) => message.messageId)).toEqual([
      "m-0",
    ]);
  });

  it("does not leak another turn's events into the span", () => {
    const rows = decoratedRows();

    const result = slice(rows, [M0], [STARTED, CHECKPOINT, OTHER_TURN], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });

    expect(result.events.map((event) => event.eventId)).not.toContain(
      "e-other",
    );
  });

  it("charges a turn's decorating events once across its slices", () => {
    // Both slices name the same ids; the dedup that makes a shared record set
    // free has to cover events too, or a heavily-split turn looks unfetchable.
    const rows = decoratedRows();

    const result = slice(rows, [M0], [STARTED, CHECKPOINT], {
      fromOrdinal: 0,
      toOrdinal: 1,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });

    expect(result.rowIds).toHaveLength(2);
    expect(result.events).toHaveLength(2);
  });

  it("carries them in the snapshot tail too, not only in a range", () => {
    const rows = decoratedRows();

    const result = tail(
      rows,
      [M0],
      [STARTED, CHECKPOINT],
      TRANSCRIPT_TAIL_MAX_BYTES,
    );

    expect(result.events.map((event) => event.eventId)).toEqual([
      "e-started",
      "e-checkpoint",
    ]);
  });
});

/**
 * A row that under-reports the records it needs is the failure `rowRecordIds`
 * exists to prevent: hydration reports success and the row renders blank, and
 * nothing retries because the span says the ordinal is hydrated.
 */
describe("a row's records are enumerated, not inferred", () => {
  it("serves the triggering user record with a synthesized stopped row", () => {
    const user = makeUserMessage({ messageId: "m-1", timestamp: 10 });
    const stopped = makeEvent({ eventId: "e-1", timestamp: 11 });
    const row: TranscriptRowDescriptor = {
      rowId: "assistant:t-1",
      createdAt: 11,
      source: {
        kind: "stopped-turn",
        turnKey: "t-1",
        eventId: "e-1",
        triggeringMessageId: "m-1",
      },
      context: {},
    };

    const slice = sliceTranscriptRange(
      [row],
      buildTranscriptRecordLookup([user], [stopped]),
      { fromOrdinal: 0, toOrdinal: 0, maxBytes: TRANSCRIPT_RANGE_MAX_BYTES },
    );

    expect(slice.rowIds).toEqual(["assistant:t-1"]);
    expect(slice.events.map((event) => event.eventId)).toEqual(["e-1"]);
    expect(slice.messages.map((message) => message.messageId)).toEqual(["m-1"]);
  });

  it("still serves the row when the triggering record was branched away", () => {
    // A row naming a record the authority no longer holds is served without it
    // rather than dropped - a hole in the ids would shift every later ordinal.
    const stopped = makeEvent({ eventId: "e-1", timestamp: 11 });
    const row: TranscriptRowDescriptor = {
      rowId: "assistant:t-1",
      createdAt: 11,
      source: {
        kind: "stopped-turn",
        turnKey: "t-1",
        eventId: "e-1",
        triggeringMessageId: "m-gone",
      },
      context: {},
    };

    const slice = sliceTranscriptRange(
      [row],
      buildTranscriptRecordLookup([], [stopped]),
      { fromOrdinal: 0, toOrdinal: 0, maxBytes: TRANSCRIPT_RANGE_MAX_BYTES },
    );

    expect(slice.rowIds).toEqual(["assistant:t-1"]);
    expect(slice.messages).toEqual([]);
  });
});
