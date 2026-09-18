/**
 * THE PLAYBACK TICK, on a clock this suite owns.
 *
 * The tick had no coverage of its own at all - the timeline suite pins the
 * play/pause BUTTON and the scrubber's geometry, and nothing drove the timer
 * that actually walks the cursor. That was survivable while a tick was one
 * `setTimeout` and one row; it is not now that the fast half of the speed
 * ladder advances several rows on one tick, because the rule that decides how
 * many lives in a loop whose only observable output is where the cursor landed.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphPlaybackPace } from "@/lib/comm-graph/comm-graph-transport";
import { useCommGraphTransport } from "@/components/epic-canvas/comm-graph/use-comm-graph-transport";
import {
  COMM_GRAPH_PLAYBACK_SPEEDS,
  readCommGraphTimelineEpicState,
  useCommGraphTimelineStore,
} from "@/stores/epics/comm-graph-timeline-store";

const EPIC = "epic-tick";

/** The top of the ladder - what the multi-row cases are actually about. */
const FASTEST =
  COMM_GRAPH_PLAYBACK_SPEEDS[COMM_GRAPH_PLAYBACK_SPEEDS.length - 1];

function event(id: number): CommGraphEvent {
  return {
    hostId: "host-a",
    id,
    // A second apart, so nothing here depends on the wall clock: playback is
    // event-paced and these intervals are never replayed.
    timestamp: id * 1_000,
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
    peerEpicId: null,
  };
}

const EVENTS: ReadonlyArray<CommGraphEvent> = Array.from(
  { length: 12 },
  (_unused, index) => event(index + 1),
);

/** Which row the cursor is on, as a 1-based id, or `null` for live. */
function cursorId(): number | null {
  const cursor = readCommGraphTimelineEpicState(EPIC).cursor;
  return cursor === null ? null : cursor.id;
}

/**
 * The store offers only `cycleSpeed`, so a case that wants a rung presses the
 * control until it gets there - which also means a rung that leaves the ladder
 * fails here loudly rather than silently testing a different speed.
 */
function cycleTo(speed: number): void {
  for (let press = 0; press <= COMM_GRAPH_PLAYBACK_SPEEDS.length; press += 1) {
    if (readCommGraphTimelineEpicState(EPIC).speed === speed) return;
    useCommGraphTimelineStore.getState().cycleSpeed(EPIC);
  }
  throw new Error(`${speed}x is not on the playback ladder`);
}

function playAt(speed: number) {
  const rendered = renderHook(() => useCommGraphTransport(EPIC, EVENTS));
  act(() => {
    cycleTo(speed);
    rendered.result.current.togglePlay();
  });
  return rendered;
}

/** One tick at this speed, whatever length the pace says that is. */
function tick(speed: number, times: number): void {
  const pace = commGraphPlaybackPace(speed);
  for (let step = 0; step < times; step += 1) {
    act(() => {
      vi.advanceTimersByTime(Math.ceil(pace.tickMs) + 1);
    });
  }
}

describe("the comm-graph playback tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  afterEach(() => {
    // UNMOUNTED, not merely forgotten. The hook's own doc says the store
    // outlives it and playback resumes on the next mount - so a hook left
    // mounted by an earlier case goes on ticking this same epic, and the next
    // case measures two transports advancing one cursor. That is exactly how
    // this suite first read 4 rows a tick out of a 2-row pace.
    cleanup();
    vi.useRealTimers();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  it("advances exactly one row per tick at the speeds below the floor", () => {
    playAt(1);
    // Play from live rewinds to the first row before the first tick lands.
    expect(cursorId()).toBe(1);

    tick(1, 3);

    expect(cursorId()).toBe(4);
  });

  it("advances SEVERAL rows on one tick at the top of the ladder", () => {
    const speed = FASTEST;
    const pace = commGraphPlaybackPace(speed);
    // GUARD, not a red of its own: this case is only about multi-row ticks if
    // the top rung actually produces one. A ladder or a floor that changed
    // until 16x stepped a single row would leave the assertion below green
    // while proving the opposite of what it says.
    expect(pace.rowsPerTick).toBeGreaterThan(1);

    playAt(speed);
    expect(cursorId()).toBe(1);

    tick(speed, 2);

    // Two ticks, `rowsPerTick` rows each - not two rows.
    expect(cursorId()).toBe(1 + pace.rowsPerTick * 2);
  });

  it("re-attaches to live and stops when a tick runs off the end", () => {
    const speed = FASTEST;
    playAt(speed);

    // Far more ticks than there are rows: the last one runs out mid-tick,
    // which is the branch a single-row tick could never reach.
    tick(speed, 20);

    expect(cursorId()).toBeNull();
    expect(readCommGraphTimelineEpicState(EPIC).playing).toBe(false);
  });

  it("moves the cursor ONCE per tick, not once per row it walked", () => {
    // Every cursor change re-renders and re-plans the whole graph. A multi-row
    // tick that wrote each row it passed would cost sixteen plans a tick at
    // 16x and draw fifteen states nobody sees.
    //
    // Counted by SUBSCRIBING rather than by spying the action: zustand hands
    // out a fresh state object per write, so a spy installed on `getState()`
    // is a spy on an object the next write replaces.
    const speed = FASTEST;
    const pace = commGraphPlaybackPace(speed);
    expect(pace.rowsPerTick).toBeGreaterThan(1);
    playAt(speed);

    let moves = 0;
    let last = readCommGraphTimelineEpicState(EPIC).cursor;
    const unsubscribe = useCommGraphTimelineStore.subscribe(() => {
      const now = readCommGraphTimelineEpicState(EPIC).cursor;
      if (now === last) return;
      last = now;
      moves += 1;
    });
    tick(speed, 1);
    unsubscribe();

    expect(moves).toBe(1);
  });

  it("never slows down as the speed control is pressed", () => {
    // What a cycling control owes its user, end to end rather than as
    // arithmetic: each rung must replay a row faster than the one before it.
    const perRow = COMM_GRAPH_PLAYBACK_SPEEDS.map((speed) => {
      const pace = commGraphPlaybackPace(speed);
      return pace.tickMs / pace.rowsPerTick;
    });
    for (let i = 1; i < perRow.length; i += 1) {
      expect(perRow[i]).toBeLessThan(perRow[i - 1]);
    }
    // And the fastest rung is fast enough to be worth pressing: a busy epic's
    // couple of thousand rows in well under a minute, against the six the old
    // 4x ceiling took. This is the "even at 4x, the graph is filling super
    // slow" of round 2's feedback, as a number.
    const fastest = perRow[perRow.length - 1];
    expect(fastest * 2_000).toBeLessThan(60_000);
    // Stated against what it replaced, so the rung cannot quietly come back
    // down: 4x was 175ms a row, which is where "super slow" came from.
    expect(fastest).toBeLessThan(700 / 4 / 4);
  });
});
