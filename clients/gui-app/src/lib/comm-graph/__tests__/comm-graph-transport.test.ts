import { describe, expect, it } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphCursorForEvent } from "@/lib/comm-graph/comm-graph-timeline";
import {
  commGraphCursorAtEnd,
  commGraphCursorIndex,
  commGraphEventAtFraction,
  commGraphFractionForTimestamp,
  commGraphPlayheadFraction,
  commGraphTimeRange,
  commGraphTransportMarkers,
} from "@/lib/comm-graph/comm-graph-transport";

function event(
  overrides: Partial<CommGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): CommGraphEvent {
  return {
    hostId: "host-a",
    kind: "a2a_message",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: "hi",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    ...overrides,
  };
}

const EVENTS: ReadonlyArray<CommGraphEvent> = [
  event({ id: 1, timestamp: 1_000 }),
  event({ id: 2, timestamp: 2_000 }),
  event({ id: 3, timestamp: 3_000 }),
];

describe("commGraphTimeRange", () => {
  it("spans the first and last captured rows", () => {
    expect(commGraphTimeRange(EVENTS)).toEqual({
      startMs: 1_000,
      endMs: 3_000,
    });
  });

  it("is null for an empty log, rather than an invented range", () => {
    expect(commGraphTimeRange([])).toBeNull();
  });
});

describe("commGraphFractionForTimestamp", () => {
  const range = { startMs: 1_000, endMs: 3_000 };

  it("maps the ends to 0 and 1 and the middle to 0.5", () => {
    expect(commGraphFractionForTimestamp(1_000, range)).toBe(0);
    expect(commGraphFractionForTimestamp(2_000, range)).toBe(0.5);
    expect(commGraphFractionForTimestamp(3_000, range)).toBe(1);
  });

  it("clamps outside the range instead of running off the track", () => {
    expect(commGraphFractionForTimestamp(0, range)).toBe(0);
    expect(commGraphFractionForTimestamp(9_999, range)).toBe(1);
  });

  it("puts a zero-width range at the LIVE edge, not the start", () => {
    // Every row shares the newest instant, so they all belong at the right -
    // parking the playhead left while the graph shows the newest state reads as
    // a broken scrubber rather than as a short session.
    expect(
      commGraphFractionForTimestamp(500, { startMs: 500, endMs: 500 }),
    ).toBe(1);
  });
});

describe("commGraphTransportMarkers", () => {
  it("emits ONE marker per event, never bucketed or thinned", () => {
    const crowded = [
      event({ id: 1, timestamp: 1_000 }),
      event({ id: 2, timestamp: 1_000 }),
      event({ id: 3, timestamp: 1_000 }),
      event({ id: 4, timestamp: 3_000 }),
    ];
    const range = commGraphTimeRange(crowded);
    expect(range).not.toBeNull();
    if (range === null) return;
    // Three of them land on the same tick. Dropping any would misreport how
    // much happened.
    expect(commGraphTransportMarkers(crowded, range)).toHaveLength(4);
  });

  it("keys markers by host AND row id, because ids are per-host", () => {
    const range = { startMs: 1_000, endMs: 3_000 };
    const markers = commGraphTransportMarkers(
      [
        event({ id: 1, timestamp: 1_000 }),
        event({ id: 1, timestamp: 2_000, hostId: "host-b" }),
      ],
      range,
    );
    expect(markers.map((marker) => marker.key)).toEqual([
      "host-a:1",
      "host-b:1",
    ]);
  });
});

describe("commGraphPlayheadFraction", () => {
  it("pins LIVE to the right edge", () => {
    expect(
      commGraphPlayheadFraction(null, { startMs: 1_000, endMs: 3_000 }),
    ).toBe(1);
  });

  it("places a held cursor at its own timestamp", () => {
    expect(
      commGraphPlayheadFraction(commGraphCursorForEvent(EVENTS[1]), {
        startMs: 1_000,
        endMs: 3_000,
      }),
    ).toBe(0.5);
  });

  it("is at the edge when there is no range to place it in", () => {
    expect(commGraphPlayheadFraction(null, null)).toBe(1);
  });
});

describe("commGraphEventAtFraction", () => {
  const range = { startMs: 1_000, endMs: 3_000 };

  it("seeks to the LAST row at or before the point", () => {
    // "Show me the graph as of here", not "jump to the nearest thing".
    expect(commGraphEventAtFraction(EVENTS, range, 0.75)?.id).toBe(2);
    expect(commGraphEventAtFraction(EVENTS, range, 0.5)?.id).toBe(2);
    expect(commGraphEventAtFraction(EVENTS, range, 1)?.id).toBe(3);
  });

  it("floors at the first row rather than an empty graph", () => {
    expect(commGraphEventAtFraction(EVENTS, range, 0)?.id).toBe(1);
    expect(commGraphEventAtFraction(EVENTS, range, -5)?.id).toBe(1);
  });

  it("is null only when there is nothing to seek to", () => {
    expect(commGraphEventAtFraction([], range, 0.5)).toBeNull();
  });
});

describe("commGraphCursorAtEnd", () => {
  it("treats live as the end", () => {
    expect(commGraphCursorAtEnd(EVENTS, null)).toBe(true);
  });

  it("is true on the newest row and false behind it", () => {
    expect(
      commGraphCursorAtEnd(EVENTS, commGraphCursorForEvent(EVENTS[2])),
    ).toBe(true);
    expect(
      commGraphCursorAtEnd(EVENTS, commGraphCursorForEvent(EVENTS[1])),
    ).toBe(false);
  });

  it("leaves a cursor DETACHED when a newer row lands under it", () => {
    // The user sat at what was then the end; a new arrival must not silently
    // drag them forward into live.
    const grown = [...EVENTS, event({ id: 4, timestamp: 4_000 })];
    expect(
      commGraphCursorAtEnd(grown, commGraphCursorForEvent(EVENTS[2])),
    ).toBe(false);
  });
});

describe("commGraphCursorIndex", () => {
  it("reports LIVE as the last index, not a sentinel", () => {
    expect(commGraphCursorIndex(EVENTS, null)).toBe(2);
  });

  it("finds the row a cursor names", () => {
    expect(
      commGraphCursorIndex(EVENTS, commGraphCursorForEvent(EVENTS[0])),
    ).toBe(0);
    expect(
      commGraphCursorIndex(EVENTS, commGraphCursorForEvent(EVENTS[1])),
    ).toBe(1);
  });

  it("resolves a cursor naming an absent row to the as-of row", () => {
    // Matches the as-of projection rather than reporting "not found".
    expect(
      commGraphCursorIndex(EVENTS, {
        timestamp: 2_500,
        hostId: "host-a",
        id: 99,
      }),
    ).toBe(1);
  });

  it("is -1 only for an empty log", () => {
    expect(commGraphCursorIndex([], null)).toBe(-1);
  });
});
