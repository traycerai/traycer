import { describe, expect, it } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphCursorForEvent } from "@/lib/comm-graph/comm-graph-timeline";
import {
  BASE_STEP_MS,
  commGraphCursorAtEnd,
  commGraphCursorIndex,
  commGraphEventAtFraction,
  commGraphPlaybackPace,
  commGraphPlayheadFraction,
  commGraphPlaybackPace as pace,
  commGraphTrackFraction,
  commGraphTransportMarkers,
  commGraphTransportTrack,
  type CommGraphTransportTrack,
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

/** The track these events actually produce, asserted non-null once. */
function trackFor(
  events: ReadonlyArray<CommGraphEvent>,
): CommGraphTransportTrack {
  const track = commGraphTransportTrack(events);
  if (track === null) throw new Error("expected a track for these events");
  return track;
}

/**
 * The three base rows are a second apart, which is longer than one playback
 * step - so each gap trims to `BASE_STEP_MS` and the three land at 0, 0.5 and
 * 1, exactly where the old wall-clock axis put them. Kept that way on purpose:
 * the cases below that are NOT about trimming should not have to change because
 * the axis did.
 */
const TRACK = trackFor(EVENTS);

describe("commGraphTransportTrack", () => {
  it("measures a gap in the replay time playback will spend crossing it", () => {
    // A second apart is more than one step, so each gap costs exactly one.
    expect(TRACK).toEqual({
      offsets: [0, BASE_STEP_MS, BASE_STEP_MS * 2],
      totalMs: BASE_STEP_MS * 2,
    });
  });

  it("TRIMS an idle gap to one step, whatever the wall clock says", () => {
    // THE FEEDBACK, as arithmetic. Three rows in a burst, an hour of nothing,
    // then three more. On a wall-clock axis the idle is 99.9% of the span and
    // both bursts render as a smear at either end.
    const burstThenIdle = [
      event({ id: 1, timestamp: 0 }),
      event({ id: 2, timestamp: 100 }),
      event({ id: 3, timestamp: 200 }),
      event({ id: 4, timestamp: 3_600_000 }),
      event({ id: 5, timestamp: 3_600_100 }),
      event({ id: 6, timestamp: 3_600_200 }),
    ];
    const track = trackFor(burstThenIdle);

    // The hour costs one step; the four 100ms gaps cost 100ms each.
    expect(track.totalMs).toBe(BASE_STEP_MS + 400);
    // And the idle is now a minority of the track rather than all of it.
    const idleShare = BASE_STEP_MS / track.totalMs;
    expect(idleShare).toBeLessThan(0.7);
    // The wall-clock axis this replaced would have given it essentially
    // everything - stated as a number so the comparison is not rhetorical.
    expect(3_600_000 / 3_600_200).toBeGreaterThan(0.999);
  });

  it("renders a SUB-STEP gap proportionally, so a burst still looks like a burst", () => {
    // Trimming is not bucketing: four messages inside a second must still pack
    // tighter than four a second apart, or the axis would have thrown away the
    // density `commGraphTransportMarkers` refuses to throw away.
    const tight = trackFor([
      event({ id: 1, timestamp: 0 }),
      event({ id: 2, timestamp: 10 }),
      event({ id: 3, timestamp: 20 }),
    ]);

    expect(tight.totalMs).toBe(20);
    expect(tight.offsets).toEqual([0, 10, 20]);
  });

  it("is null for an empty log, rather than an invented axis", () => {
    expect(commGraphTransportTrack([])).toBeNull();
  });

  it("stays monotone when rows share an instant", () => {
    const together = trackFor([
      event({ id: 1, timestamp: 1_000 }),
      event({ id: 2, timestamp: 1_000 }),
    ]);

    expect(together).toEqual({ offsets: [0, 0], totalMs: 0 });
  });
});

describe("commGraphTrackFraction", () => {
  it("maps the ends to 0 and 1 and an evenly spaced middle to 0.5", () => {
    expect(commGraphTrackFraction(TRACK, 0)).toBe(0);
    expect(commGraphTrackFraction(TRACK, 1)).toBe(0.5);
    expect(commGraphTrackFraction(TRACK, 2)).toBe(1);
  });

  it("clamps an index outside the log instead of running off the track", () => {
    expect(commGraphTrackFraction(TRACK, -3)).toBe(0);
    expect(commGraphTrackFraction(TRACK, 99)).toBe(1);
  });

  it("puts a zero-length track at the LIVE edge, not the start", () => {
    // Every row shares the newest instant, so they all belong at the right -
    // parking the playhead left while the graph shows the newest state reads as
    // a broken scrubber rather than as a short session.
    expect(commGraphTrackFraction({ offsets: [0, 0], totalMs: 0 }, 0)).toBe(1);
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
    // Three of them land on the same tick. Dropping any would misreport how
    // much happened.
    expect(commGraphTransportMarkers(crowded, trackFor(crowded))).toHaveLength(
      4,
    );
  });

  it("keys markers by host AND row id, because ids are per-host", () => {
    const rows = [
      event({ id: 1, timestamp: 1_000 }),
      event({ id: 1, timestamp: 2_000, hostId: "host-b" }),
    ];
    const markers = commGraphTransportMarkers(rows, trackFor(rows));
    expect(markers.map((marker) => marker.key)).toEqual([
      "host-a:1",
      "host-b:1",
    ]);
  });

  it("keys reused cloud origin sequences by canonical event id", () => {
    const rows = [
      event({
        id: 1,
        eventId: "cloud-before-repair",
        timestamp: 1_000,
      }),
      event({
        id: 1,
        eventId: "cloud-after-repair",
        timestamp: 2_000,
      }),
    ];
    const markers = commGraphTransportMarkers(rows, trackFor(rows));

    expect(markers.map((marker) => marker.key)).toEqual([
      "cloud-before-repair",
      "cloud-after-repair",
    ]);
  });
});

describe("commGraphPlayheadFraction", () => {
  it("pins LIVE to the right edge", () => {
    expect(commGraphPlayheadFraction(EVENTS, null, TRACK)).toBe(1);
  });

  it("places a held cursor on its own ROW, not its own instant", () => {
    expect(
      commGraphPlayheadFraction(
        EVENTS,
        commGraphCursorForEvent(EVENTS[1]),
        TRACK,
      ),
    ).toBe(0.5);
  });

  it("puts the playhead where a trimmed gap actually left the row", () => {
    // The defect this signature change closes: the middle row is an hour after
    // the first and a tenth of a second before the last, so a timestamp-based
    // playhead would sit at 0.99993 - the right-hand edge - while the graph
    // showed the SECOND of three rows.
    const spread = [
      event({ id: 1, timestamp: 0 }),
      event({ id: 2, timestamp: 3_600_000 }),
      event({ id: 3, timestamp: 3_600_100 }),
    ];
    const track = trackFor(spread);

    const fraction = commGraphPlayheadFraction(
      spread,
      commGraphCursorForEvent(spread[1]),
      track,
    );
    expect(fraction).toBeCloseTo(BASE_STEP_MS / (BASE_STEP_MS + 100), 10);
    expect(fraction).toBeLessThan(0.9);
  });

  it("is at the edge when there is no track to place it in", () => {
    expect(commGraphPlayheadFraction(EVENTS, null, null)).toBe(1);
  });
});

describe("commGraphEventAtFraction", () => {
  it("seeks to the LAST row at or before the point", () => {
    // "Show me the graph as of here", not "jump to the nearest thing".
    expect(commGraphEventAtFraction(EVENTS, TRACK, 0.75)?.id).toBe(2);
    expect(commGraphEventAtFraction(EVENTS, TRACK, 0.5)?.id).toBe(2);
    expect(commGraphEventAtFraction(EVENTS, TRACK, 1)?.id).toBe(3);
  });

  it("floors at the first row rather than an empty graph", () => {
    expect(commGraphEventAtFraction(EVENTS, TRACK, 0)?.id).toBe(1);
    expect(commGraphEventAtFraction(EVENTS, TRACK, -5)?.id).toBe(1);
  });

  it("reaches every row of a burst that used to share one pixel", () => {
    // The other half of trimming: a click has to be able to LAND on each of
    // these. On the wall-clock axis all three burst rows sat within 0.006% of
    // the track and no pointer could separate them.
    const burstThenIdle = [
      event({ id: 1, timestamp: 0 }),
      event({ id: 2, timestamp: 100 }),
      event({ id: 3, timestamp: 200 }),
      event({ id: 4, timestamp: 3_600_000 }),
    ];
    const track = trackFor(burstThenIdle);
    const reached = new Set<number>();
    for (let step = 0; step <= 100; step += 1) {
      const found = commGraphEventAtFraction(burstThenIdle, track, step / 100);
      if (found !== null) reached.add(found.id);
    }

    expect([...reached].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("is null only when there is nothing to seek to", () => {
    expect(commGraphEventAtFraction([], TRACK, 0.5)).toBeNull();
  });
});

describe("commGraphPlaybackPace", () => {
  it("shortens the tick and advances one row while there is room to", () => {
    expect(pace(1)).toEqual({ tickMs: BASE_STEP_MS, rowsPerTick: 1 });
    expect(pace(0.5)).toEqual({ tickMs: BASE_STEP_MS * 2, rowsPerTick: 1 });
    expect(pace(4)).toEqual({ tickMs: BASE_STEP_MS / 4, rowsPerTick: 1 });
  });

  it("buys ROWS rather than a shorter tick past the renderer's floor", () => {
    // The point of the two new rungs: 16x has to actually be four times 4x,
    // and a 44ms timer would not have delivered that.
    const fast = commGraphPlaybackPace(16);
    expect(fast.rowsPerTick).toBeGreaterThan(1);
    expect(fast.tickMs).toBeGreaterThan(BASE_STEP_MS / 16);
    expect(fast.tickMs / fast.rowsPerTick).toBeCloseTo(BASE_STEP_MS / 16, 10);
  });

  it("gets strictly faster per row at every rung of the ladder", () => {
    // The guarantee a cycling control owes its user: pressing it never makes
    // the replay slower. A floor applied without the rows-per-tick half would
    // have flattened the top of the ladder instead.
    const perRow = [0.5, 1, 2, 4, 8, 16].map((speed) => {
      const at = commGraphPlaybackPace(speed);
      return at.tickMs / at.rowsPerTick;
    });
    for (let i = 1; i < perRow.length; i += 1) {
      expect(perRow[i]).toBeLessThan(perRow[i - 1]);
    }
  });

  it("never schedules a tick a timer cannot honour", () => {
    for (const speed of [16, 64, 1_000]) {
      expect(commGraphPlaybackPace(speed).tickMs).toBeGreaterThan(50);
    }
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
