/**
 * WHAT MOUNTING THE BAR COSTS, AND WHAT HOVERING ONE TICK COSTS IT.
 *
 * Every tick used to carry its own Radix tooltip, each with a markdown parse
 * for its label built at RENDER time - so mounting (or growing) the track
 * parsed every captured row's message just to label ticks nobody had pointed
 * at, and a step of playback that moved nothing about the ticks themselves
 * still reconciled a tooltip per row. The bar now draws bare ticks and builds
 * a label only for the one tick actually HOVERED, and only once the hover
 * delay has elapsed - see `comm-graph-transport-bar.tsx`'s `markerTitle` and
 * `MARKER_HOVER_DELAY_MS`.
 *
 * COUNTED THROUGH `markdownToPlainText`, which is the expensive half of a
 * marker's label and is reached only from `markerTitle` in this component, so
 * its call count is a direct reading of how many rows the bar actually
 * described rather than a proxy for it.
 *
 * THE CACHE IS BY OBJECT IDENTITY (`markerTitles`, a module-scoped
 * `WeakMap`), which is why every case below builds its OWN rows through
 * `rows()` instead of sharing one array: a row hovered in an earlier test
 * would already carry a cached title, and the next test's "exactly one
 * parse" assertion would then pass over a cache hit rather than the code path
 * it means to prove. The second describe below shares its own `EVENTS`
 * constant freely, because it never counts parses.
 *
 * GEOMETRY IS STUBBED, not simulated - jsdom lays out nothing, so
 * `getBoundingClientRect` is pinned to a 400px-wide box at `left: 0`
 * (`stubTrackGeometry`, the same shape `slider-pointer-geometry.ts` uses,
 * without its `hasPointerCapture` override, which would disable hover
 * entirely). The fixture rows sit 1000ms apart, more than one playback step
 * (`BASE_STEP_MS` = 700ms), so all 39 gaps between the 40 rows are capped
 * identically and every tick lands evenly at `index / 39` of the track -
 * `tickX` spends that arithmetic once. `hasPointerCapture` already defaults
 * to `false` globally (`__tests__/test-browser-apis.ts`), which is what lets
 * a plain `pointermove` reach the hover path at all; the one case that needs
 * capture stubs it back to `true` itself, nowhere else.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import {
  commGraphCursorForEvent,
  commGraphEventKey,
} from "@/lib/comm-graph/comm-graph-timeline";
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
    peerEpicId: null,
  };
}

const EVENTS: ReadonlyArray<CommGraphEvent> = Array.from(
  { length: ROWS },
  (_unused, index) => event(index + 1),
);

/** A fresh 40-row fixture, built per test - see the WeakMap note above. */
function rows(): CommGraphEvent[] {
  return Array.from({ length: ROWS }, (_unused, index) => event(index + 1));
}

/**
 * Pins the track to a 400px-wide box at `left: 0`, the same shape
 * `slider-pointer-geometry.ts` uses and for the same reason - jsdom lays out
 * nothing, so a pointer test needs a real width to turn a `clientX` into a
 * fraction. `stubSliderGeometry` itself is not reused here: it also forces
 * `hasPointerCapture` to `true`, which would disable hover entirely.
 */
function stubTrackGeometry(): () => void {
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 24,
      width: 400,
      height: 24,
      toJSON: () => ({}),
    });
  return () => rect.mockRestore();
}

/** The x, in pixels, for tick `index` of the 40 evenly spaced fixture rows. */
function tickX(index: number): number {
  return (index / (ROWS - 1)) * 400;
}

/** Halfway between two neighbouring ticks - about 5.1px from each, further
 * than the 4px reach, so it resolves to no tick at all. */
function betweenTicksX(index: number): number {
  return (tickX(index) + tickX(index + 1)) / 2;
}

describe("what a playback step costs the transport bar", () => {
  let restoreGeometry: () => void;

  beforeEach(() => {
    plainTextCalls.mockClear();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
    vi.useFakeTimers();
    restoreGeometry = stubTrackGeometry();
  });

  afterEach(() => {
    cleanup();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
    vi.useRealTimers();
    restoreGeometry();
  });

  function track(): HTMLElement {
    return screen.getByTestId("comm-graph-transport-track");
  }

  /** Moves onto tick `index` and pays the hover delay in full. */
  function armHover(index: number): void {
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: tickX(index) });
    act(() => {
      vi.advanceTimersByTime(500);
    });
  }

  it("mounts every row without parsing a single label", () => {
    const events = rows();
    render(<CommGraphTransportBar epicId={EPIC} events={events} />);

    expect(plainTextCalls).not.toHaveBeenCalled();
    // Anti-vacuity: the bar actually drew all 40 rows, not zero of them.
    for (const row of events) {
      expect(
        screen.getByTestId(
          `comm-graph-transport-marker-${commGraphEventKey(row)}`,
        ),
      ).toBeTruthy();
    }
  });

  it("parses the hovered row's label once the hover delay has elapsed", () => {
    const events = rows();
    render(<CommGraphTransportBar epicId={EPIC} events={events} />);

    armHover(10);

    expect(plainTextCalls).toHaveBeenCalledTimes(1);
    const hover = screen.getByTestId("comm-graph-transport-marker-hover");
    expect(hover.getAttribute("data-marker-key")).toBe(
      commGraphEventKey(events[10]),
    );
    // `formatSingleLine` doesn't touch this fixture's text (well under its
    // 120-char cap), so `markdownToPlainText` reduces
    // "**row 11** with some _markdown_ in it" to exactly this prose.
    expect(screen.getByRole("tooltip").textContent).toContain(
      "row 11 with some markdown in it",
    );
  });

  it("parses each row's label once, however many times the playhead moves", () => {
    const events = rows();
    render(<CommGraphTransportBar epicId={EPIC} events={events} />);
    armHover(10);
    expect(plainTextCalls).toHaveBeenCalledTimes(1);

    // Ten steps of playback, driven the way the tick drives them - none of
    // them touch the hovered tick's own label.
    for (let step = 0; step < 10; step += 1) {
      act(() => {
        useCommGraphTimelineStore
          .getState()
          .setCursor(EPIC, commGraphCursorForEvent(events[step]));
      });
    }

    expect(plainTextCalls).toHaveBeenCalledTimes(1);
  });

  it("never re-parses a row hovered twice, but does parse a different one - the WeakMap cache", () => {
    const events = rows();
    render(<CommGraphTransportBar epicId={EPIC} events={events} />);
    armHover(10);
    expect(plainTextCalls).toHaveBeenCalledTimes(1);

    // Off the tick onto empty track: the hover element is gone.
    fireEvent.pointerMove(track(), {
      pointerId: 1,
      clientX: betweenTicksX(10),
    });
    expect(
      screen.queryByTestId("comm-graph-transport-marker-hover"),
    ).toBeNull();

    // Back onto the same row: no new parse - the cache hit this pins.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: tickX(10) });
    expect(plainTextCalls).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByTestId("comm-graph-transport-marker-hover")
        .getAttribute("data-marker-key"),
    ).toBe(commGraphEventKey(events[10]));

    // Control: a DIFFERENT row still parses. If the zero above were really a
    // dead hover path rather than a cache hit, this would also read zero.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: tickX(20) });
    expect(plainTextCalls).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByTestId("comm-graph-transport-marker-hover")
        .getAttribute("data-marker-key"),
    ).toBe(commGraphEventKey(events[20]));
  });

  it("shows nothing before the hover delay elapses, and the label once it does", () => {
    const events = rows();
    render(<CommGraphTransportBar epicId={EPIC} events={events} />);

    fireEvent.pointerMove(track(), { pointerId: 1, clientX: tickX(5) });
    expect(
      screen.queryByTestId("comm-graph-transport-marker-hover"),
    ).toBeNull();
    expect(plainTextCalls).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(
      screen.getByTestId("comm-graph-transport-marker-hover"),
    ).toBeTruthy();
    expect(plainTextCalls).toHaveBeenCalledTimes(1);
  });

  it("shows no hover while the track holds pointer capture", () => {
    const capture = vi
      .spyOn(Element.prototype, "hasPointerCapture")
      .mockReturnValue(true);
    try {
      const events = rows();
      render(<CommGraphTransportBar epicId={EPIC} events={events} />);

      fireEvent.pointerMove(track(), { pointerId: 1, clientX: tickX(10) });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(
        screen.queryByTestId("comm-graph-transport-marker-hover"),
      ).toBeNull();
      expect(plainTextCalls).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  });

  it("pointerleave clears the hover, and re-entering pays the delay again", () => {
    const events = rows();
    render(<CommGraphTransportBar epicId={EPIC} events={events} />);
    armHover(10);
    expect(
      screen.getByTestId("comm-graph-transport-marker-hover"),
    ).toBeTruthy();

    fireEvent.pointerLeave(track());
    expect(
      screen.queryByTestId("comm-graph-transport-marker-hover"),
    ).toBeNull();

    fireEvent.pointerMove(track(), { pointerId: 1, clientX: tickX(10) });
    // The delay was cancelled by the leave, so the label is not back yet.
    expect(
      screen.queryByTestId("comm-graph-transport-marker-hover"),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(
      screen.getByTestId("comm-graph-transport-marker-hover"),
    ).toBeTruthy();
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
/** The bar's clock, spelled independently - see the width case for why. */
function expectedClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

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

    // Detached: the row the cursor actually names, not the newest one. The
    // expected spelling is built here rather than imported, so that a change
    // to the bar's clock has to be made deliberately in two places - but what
    // pins the FORMAT is the width case below, not this. This case is about
    // WHICH ROW is read.
    expect(
      screen.getByTestId("comm-graph-transport-cursor-time").textContent,
    ).toBe(expectedClock(EVENTS[3].timestamp));
    expect(expectedClock(EVENTS[3].timestamp)).not.toBe(
      expectedClock(EVENTS[EVENTS.length - 1].timestamp),
    );

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

  it("writes a clock that is the same width at every hour of the day", () => {
    // WHY THE RESERVATION CAN BE EXACT. Two earlier versions reserved a
    // MEASURED width - the newest row's time, then the longest of a day's
    // probes - and both were approximations: a locale's `9:05:09 AM` is a
    // character shorter than its `12:05:09 PM`, and once that was handled by
    // character count, `AM` and `PM` are still different widths at the same
    // length in a proportional face. The reading is absolutely positioned, so
    // any shortfall paints across the Live badge instead of pushing it along.
    //
    // So the variance is removed rather than chased, and these are the two
    // properties that do it - asserted on the rendered output rather than on
    // the formatter, because the element is what has to hold still.
    const at = (hour: number): CommGraphEvent => ({
      ...event(hour + 1),
      timestamp: Date.UTC(2024, 0, 1, hour, 59, 59),
    });
    const day = Array.from({ length: 24 }, (_unused, hour) => at(hour));
    render(<CommGraphTransportBar epicId={EPIC} events={day} />);

    const readings: string[] = [];
    for (const row of day) {
      act(() => {
        useCommGraphTimelineStore
          .getState()
          .setCursor(EPIC, commGraphCursorForEvent(row));
      });
      readings.push(
        screen.getByTestId("comm-graph-transport-cursor-time").textContent,
      );
    }

    // ONE LENGTH across the whole day - no one-digit hour beside a two-digit
    // one - and the reserved box is that same length.
    expect(new Set(readings.map((text) => text.length)).size).toBe(1);
    expect(
      screen.getByTestId("comm-graph-transport-cursor-time-reserve").textContent
        .length,
    ).toBe(readings[0].length);

    // AND NOT A LETTER IN ANY OF THEM, which is what makes equal length mean
    // equal WIDTH: `tabular-nums` equalises digits and says nothing about
    // `AM` against `PM`. Without this the case above would pass on a format
    // that still varied in pixels.
    for (const text of readings) expect(text).not.toMatch(/\p{L}/u);

    // Anti-vacuity: all twenty-four were actually read back, and they are not
    // all the empty string.
    expect(readings).toHaveLength(24);
    expect(readings[0].length).toBeGreaterThan(0);
    expect(new Set(readings).size).toBe(24);
  });
});
