/**
 * WHAT A STEP OF PLAYBACK COSTS THE BAR.
 *
 * The track draws one marker per captured row, each a Radix tooltip whose label
 * is a markdown parse - and the bar re-renders on every step, because moving the
 * playhead is what a step DOES. So an epic with a couple of thousand rows in it
 * re-parsed a couple of thousand messages per tick, for markers that had not
 * moved since the frame before.
 *
 * That is the other half of "even at 4x, the graph is filling super slow": the
 * speed ladder answers how often a step happens, and this answers what one
 * costs. Raising the ladder without this would only have asked the bar to do
 * the same work more often.
 *
 * COUNTED THROUGH `markdownToPlainText`, which is the expensive half of a
 * marker's label and is reached only from there in this component, so its call
 * count is a direct reading of work the bar did rather than a proxy for it.
 *
 * THE OUTCOME, NOT EACH MECHANISM. Two things stop the re-parsing - a `memo`
 * boundary on the marker layer and a `WeakMap` keyed by the row - and either
 * alone would satisfy the count below. That is on purpose: what a reader is
 * owed is that a step costs nothing, and pinning the two separately would pin
 * an implementation rather than a bill. They are not redundant in the long
 * run, though, and the split is worth knowing - the memo is what keeps the
 * cache from being consulted N times a tick, and the `WeakMap` is what
 * survives the layer remounting.
 *
 * `markerTitles` is module-scoped and outlives `mockClear`, so the first case
 * here depends on running before its sibling. That is the safe direction - a
 * reorder makes `afterFirstPaint >= ROWS` fail loudly rather than quietly
 * measure nothing - but it is worth knowing before moving either.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphCursorForEvent } from "@/lib/comm-graph/comm-graph-timeline";
import { CommGraphTransportBar } from "@/components/epic-canvas/comm-graph/comm-graph-transport-bar";
import { useCommGraphTimelineStore } from "@/stores/epics/comm-graph-timeline-store";

const plainTextCalls = vi.fn();

vi.mock("@/lib/markdown/markdown-to-plain-text", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/markdown/markdown-to-plain-text")
    >();
  return {
    ...actual,
    markdownToPlainText: (text: string): string => {
      plainTextCalls();
      return actual.markdownToPlainText(text);
    },
  };
});

const EPIC = "epic-bar-cost";
const ROWS = 40;

function event(id: number): CommGraphEvent {
  return {
    hostId: "host-a",
    id,
    timestamp: id * 1_000,
    kind: "a2a_message",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: `**row ${id}** with some _markdown_ in it`,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
  };
}

const EVENTS: ReadonlyArray<CommGraphEvent> = Array.from(
  { length: ROWS },
  (_unused, index) => event(index + 1),
);

describe("what a playback step costs the transport bar", () => {
  beforeEach(() => {
    plainTextCalls.mockClear();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  afterEach(() => {
    cleanup();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  it("parses each row's label once, however many times the playhead moves", () => {
    render(<CommGraphTransportBar epicId={EPIC} events={EVENTS} />);
    // The first paint reads every row: that is the work this is about NOT
    // repeating, so it has to actually happen first.
    const afterFirstPaint = plainTextCalls.mock.calls.length;
    expect(afterFirstPaint).toBeGreaterThanOrEqual(ROWS);

    // Ten steps of playback, driven the way the tick drives them.
    for (let step = 0; step < 10; step += 1) {
      act(() => {
        useCommGraphTimelineStore
          .getState()
          .setCursor(EPIC, commGraphCursorForEvent(EVENTS[step]));
      });
    }

    // Not one more parse. Unmemoized this was ten more passes over every row.
    expect(plainTextCalls.mock.calls.length).toBe(afterFirstPaint);
  });

  it("still reads a row that has only just landed", () => {
    // The control. "Never parse again" would also satisfy the case above, and
    // would mean a row arriving live got no tooltip at all.
    const { rerender } = render(
      <CommGraphTransportBar epicId={EPIC} events={EVENTS} />,
    );
    const afterFirstPaint = plainTextCalls.mock.calls.length;

    rerender(
      <CommGraphTransportBar
        epicId={EPIC}
        events={[...EVENTS, event(ROWS + 1)]}
      />,
    );

    expect(plainTextCalls.mock.calls.length).toBeGreaterThan(afterFirstPaint);
  });
});

/**
 * WHERE THE OFFICE'S CURSOR CHIP WENT.
 *
 * `Paused at 14:32:07` / `Replaying 14:32:07` used to sit in the office
 * canvas's top-left corner - the last read-only sentence drawn over the
 * drawing, and the fourth chip to leave that canvas. The READING is worth
 * keeping and the chip was not: a floor scrubbed back to an hour ago is
 * pixel-identical to a live one, and the playhead gives a position without a
 * time. So it lives here now, where a media player puts its clock and where it
 * costs the drawing nothing.
 */
describe("the scrubber's own time readout", () => {
  beforeEach(() => {
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  afterEach(() => {
    cleanup();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  it("carries the detached cursor's own time, and nothing while live", () => {
    // WHERE THE OFFICE'S CURSOR CHIP WENT. It was the last read-only sentence
    // drawn over the floor and was removed with the rest of them; the reading
    // it carried is worth keeping, because a floor scrubbed back to an hour
    // ago is pixel-identical to a live one and the playhead gives a position
    // without a time. So the scrubber carries it, where a media player does.
    render(<CommGraphTransportBar epicId={EPIC} events={EVENTS} />);

    // Live: no cursor, so no time - not the wall clock, which would be a
    // clock, and not a dash holding the space.
    expect(screen.queryByTestId("comm-graph-transport-cursor-time")).toBeNull();

    act(() => {
      useCommGraphTimelineStore
        .getState()
        .setCursor(EPIC, commGraphCursorForEvent(EVENTS[3]));
    });

    // Detached: the row the cursor actually names, not the newest one.
    expect(
      screen.getByTestId("comm-graph-transport-cursor-time").textContent,
    ).toBe(new Date(EVENTS[3].timestamp).toLocaleTimeString());

    act(() => {
      useCommGraphTimelineStore.getState().setCursor(EPIC, null);
    });

    expect(screen.queryByTestId("comm-graph-transport-cursor-time")).toBeNull();
  });

  it("holds the same footprint whether or not there is a cursor", () => {
    // WHAT THE TRACK IS STANDING NEXT TO. The reading sits in the bar's flex
    // row beside a `flex-1 min-w-0` track, so one that mounts on the first
    // seek takes its width out of the track - and the first seek is a
    // pointer-down on that track, which would then re-lay-out under the
    // finger that started it and resolve the rest of the drag against a rect
    // that had moved.
    //
    // PINNED AS THE MECHANISM, because jsdom has no layout to measure: the
    // element that occupies the row is present in both states and reads the
    // same in both, so its width cannot be a function of the cursor. A
    // component that went back to rendering `null` while live fails the
    // first half; one that reserved the CURSOR's own time fails the second.
    render(<CommGraphTransportBar epicId={EPIC} events={EVENTS} />);
    const reserved = (): HTMLElement =>
      screen.getByTestId("comm-graph-transport-cursor-time-reserve");

    const live = reserved().textContent;
    expect(live).not.toBe("");

    act(() => {
      useCommGraphTimelineStore
        .getState()
        .setCursor(EPIC, commGraphCursorForEvent(EVENTS[3]));
    });

    expect(reserved().textContent).toBe(live);
  });

  it("reserves room for the widest hour, not for the newest row's", () => {
    // A LOCALIZED TIME IS NOT ONE WIDTH. `9:05:09 AM` is a character shorter
    // than `12:05:09 PM`, and which one an instant produces has nothing to do
    // with how recent it is - so a box reserved from any particular row leaves
    // some other row's reading overrunning it. The reading is absolutely
    // positioned, so an overrun paints across the Live badge beside it rather
    // than pushing it along.
    //
    // Swept over a full day rather than over one handpicked pair, because the
    // pair that is wider depends on the locale the suite happens to run in -
    // and in a 24-hour locale there is no such pair at all, which would leave
    // a single-case version quietly proving nothing.
    const at = (hour: number): CommGraphEvent => ({
      ...event(hour + 1),
      timestamp: Date.UTC(2024, 0, 1, hour, 59, 59),
    });
    const day = Array.from({ length: 24 }, (_unused, hour) => at(hour));
    render(<CommGraphTransportBar epicId={EPIC} events={day} />);
    const reserved = screen.getByTestId(
      "comm-graph-transport-cursor-time-reserve",
    ).textContent;

    let checked = 0;
    for (const row of day) {
      act(() => {
        useCommGraphTimelineStore
          .getState()
          .setCursor(EPIC, commGraphCursorForEvent(row));
      });
      const reading = screen.getByTestId(
        "comm-graph-transport-cursor-time",
      ).textContent;
      // The reserved box is never the narrower of the two, at any hour.
      expect(reserved.length).toBeGreaterThanOrEqual(reading.length);
      checked += 1;
    }

    // Anti-vacuity: every hour was actually read back, and the reservation is
    // a real string rather than the empty one that trivially satisfies a
    // length comparison against nothing.
    expect(checked).toBe(24);
    expect(reserved.length).toBeGreaterThan(0);
  });
});
