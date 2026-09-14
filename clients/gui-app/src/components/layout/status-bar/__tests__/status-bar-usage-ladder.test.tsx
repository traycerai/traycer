import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  nextStatusBarUsageSteps,
  statusBarUsageDetailCeiling,
  statusBarUsageDetailParts,
  statusBarUsageLadderLevels,
  statusBarUsageLadderStops,
  useStatusBarUsageLadder,
  type StatusBarUsageDetail,
} from "@/components/layout/status-bar/status-bar-usage-ladder";

const ALL_ON = { showModeWord: true, showBar: true, showTimer: true };
const ALL_OFF = { showModeWord: false, showBar: false, showTimer: false };

describe("statusBarUsageDetailParts", () => {
  it("full draws everything", () => {
    expect(statusBarUsageDetailParts("full")).toEqual({
      modeWord: true,
      bar: true,
      timer: true,
      label: true,
      percent: true,
    });
  });

  it("no-mode-word drops only the mode word", () => {
    expect(statusBarUsageDetailParts("no-mode-word")).toEqual({
      modeWord: false,
      bar: true,
      timer: true,
      label: true,
      percent: true,
    });
  });

  it("no-bars drops the mode word and the bar", () => {
    expect(statusBarUsageDetailParts("no-bars")).toEqual({
      modeWord: false,
      bar: false,
      timer: true,
      label: true,
      percent: true,
    });
  });

  it("no-timers drops the mode word, the bar and the countdown", () => {
    expect(statusBarUsageDetailParts("no-timers")).toEqual({
      modeWord: false,
      bar: false,
      timer: false,
      label: true,
      percent: true,
    });
  });

  it("percent-only keeps only the percentage", () => {
    expect(statusBarUsageDetailParts("percent-only")).toEqual({
      modeWord: false,
      bar: false,
      timer: false,
      label: false,
      percent: true,
    });
  });

  it("icon-only draws nothing but the icon", () => {
    expect(statusBarUsageDetailParts("icon-only")).toEqual({
      modeWord: false,
      bar: false,
      timer: false,
      label: false,
      percent: false,
    });
  });
});

describe("statusBarUsageLadderLevels", () => {
  it("keeps every rung when every preference is on", () => {
    expect(statusBarUsageLadderLevels(ALL_ON)).toEqual([
      "full",
      "no-mode-word",
      "no-bars",
      "no-timers",
      "percent-only",
      "icon-only",
    ]);
  });

  it("drops only no-mode-word when showModeWord is off", () => {
    expect(
      statusBarUsageLadderLevels({ ...ALL_ON, showModeWord: false }),
    ).toEqual(["full", "no-bars", "no-timers", "percent-only", "icon-only"]);
  });

  it("drops only no-bars when showBar is off", () => {
    expect(statusBarUsageLadderLevels({ ...ALL_ON, showBar: false })).toEqual([
      "full",
      "no-mode-word",
      "no-timers",
      "percent-only",
      "icon-only",
    ]);
  });

  it("drops only no-timers when showTimer is off", () => {
    expect(statusBarUsageLadderLevels({ ...ALL_ON, showTimer: false })).toEqual(
      ["full", "no-mode-word", "no-bars", "percent-only", "icon-only"],
    );
  });

  it("never drops full, percent-only or icon-only, however many preferences are off", () => {
    const levels = statusBarUsageLadderLevels(ALL_OFF);
    expect(levels).toEqual(["full", "percent-only", "icon-only"]);
  });
});

describe("statusBarUsageDetailCeiling", () => {
  it("mirrors the density one for one", () => {
    expect(statusBarUsageDetailCeiling("full")).toBe("full");
    expect(statusBarUsageDetailCeiling("compact")).toBe("no-timers");
    expect(statusBarUsageDetailCeiling("icon-only")).toBe("icon-only");
  });
});

describe("statusBarUsageLadderStops", () => {
  const FULL_LEVELS = statusBarUsageLadderLevels(ALL_ON);

  it("walks every rung then one fold stop per foldable provider, from a full ceiling", () => {
    const stops = statusBarUsageLadderStops({
      ceiling: "full",
      levels: FULL_LEVELS,
      segmentCount: 3,
    });

    expect(stops).toEqual([
      { detail: "full", foldedCount: 0 },
      { detail: "no-mode-word", foldedCount: 0 },
      { detail: "no-bars", foldedCount: 0 },
      { detail: "no-timers", foldedCount: 0 },
      { detail: "percent-only", foldedCount: 0 },
      { detail: "icon-only", foldedCount: 0 },
      { detail: "icon-only", foldedCount: 1 },
      { detail: "icon-only", foldedCount: 2 },
    ]);
  });

  it("never folds the last provider - one segment adds no fold stops", () => {
    const stops = statusBarUsageLadderStops({
      ceiling: "full",
      levels: FULL_LEVELS,
      segmentCount: 1,
    });

    expect(stops).toEqual(
      FULL_LEVELS.map((detail) => ({ detail, foldedCount: 0 })),
    );
  });

  it("adds no fold stops for zero segments either", () => {
    const stops = statusBarUsageLadderStops({
      ceiling: "full",
      levels: FULL_LEVELS,
      segmentCount: 0,
    });

    expect(stops).toEqual(
      FULL_LEVELS.map((detail) => ({ detail, foldedCount: 0 })),
    );
  });

  it("a compact ceiling starts the walk at no-timers", () => {
    const stops = statusBarUsageLadderStops({
      ceiling: "no-timers",
      levels: FULL_LEVELS,
      segmentCount: 1,
    });

    expect(stops.map((stop) => stop.detail)).toEqual([
      "no-timers",
      "percent-only",
      "icon-only",
    ]);
  });

  it("a compact ceiling starts at no-bars once the timer preference has already removed no-timers", () => {
    // no-bars renders identically to no-timers once the timer is off, so the
    // ceiling is honoured through the ACTIVE levels rather than by rank - a
    // rank-based walk would skip straight to percent-only instead.
    const levels = statusBarUsageLadderLevels({ ...ALL_ON, showTimer: false });
    const stops = statusBarUsageLadderStops({
      ceiling: "no-timers",
      levels,
      segmentCount: 1,
    });

    expect(stops.map((stop) => stop.detail)).toEqual([
      "no-bars",
      "percent-only",
      "icon-only",
    ]);
  });

  it("an icon-only ceiling yields only the icon-only stop(s)", () => {
    const stops = statusBarUsageLadderStops({
      ceiling: "icon-only",
      levels: FULL_LEVELS,
      segmentCount: 3,
    });

    expect(stops).toEqual([
      { detail: "icon-only", foldedCount: 0 },
      { detail: "icon-only", foldedCount: 1 },
      { detail: "icon-only", foldedCount: 2 },
    ]);
  });
});

describe("nextStatusBarUsageSteps", () => {
  it("pushes the available width once it overflows", () => {
    const result = nextStatusBarUsageSteps([], {
      availableWidth: 500,
      overflowing: true,
      maxSteps: 3,
    });

    expect(result).toEqual([500]);
  });

  it("returns the SAME REFERENCE once every step has already been taken", () => {
    // Nothing left to drop, so recording another width would only lengthen
    // the walk back up without changing what is drawn.
    const steps = [100, 200, 300];
    const result = nextStatusBarUsageSteps(steps, {
      availableWidth: 400,
      overflowing: true,
      maxSteps: 3,
    });

    expect(result).toBe(steps);
  });

  it("returns the SAME REFERENCE when nothing is overflowing and no step has been recorded", () => {
    const steps: ReadonlyArray<number> = [];
    const result = nextStatusBarUsageSteps(steps, {
      availableWidth: 900,
      overflowing: false,
      maxSteps: 5,
    });

    expect(result).toBe(steps);
  });

  it("returns the SAME REFERENCE at exactly the slack boundary (recorded + 24) - the no-oscillation guarantee", () => {
    const steps = [100];
    const result = nextStatusBarUsageSteps(steps, {
      availableWidth: 124,
      overflowing: false,
      maxSteps: 5,
    });

    expect(result).toBe(steps);
  });

  it("pops the step once the available width clears the slack boundary by one pixel (recorded + 25)", () => {
    const steps = [100];
    const result = nextStatusBarUsageSteps(steps, {
      availableWidth: 125,
      overflowing: false,
      maxSteps: 5,
    });

    expect(result).toEqual([]);
  });

  it("returns the SAME REFERENCE when the available width IS the settled rung's content width - the ratchet case", () => {
    // A shrink-to-fit box reports its own content the instant that content
    // fits, so once a step down has settled, measuring THAT box would report
    // an "available" width equal to (or below) the very width that was just
    // recorded for the step - never beating recorded + STEP_UP_SLACK_PX,
    // however wide the window actually gets. This is exactly the ratchet the
    // room box exists to avoid, exercised here as a property of the reducer
    // alone, with no DOM involved.
    const steps = [100];
    const result = nextStatusBarUsageSteps(steps, {
      availableWidth: 100,
      overflowing: false,
      maxSteps: 5,
    });

    expect(result).toBe(steps);
  });
});

/**
 * The harness's global `MockResizeObserver` never invokes its callback, so
 * the ladder's own wiring - measuring on ref attach, stepping from either
 * observer's callback, disconnecting both on unmount - has no way to run
 * without a controllable replacement. Installed at MODULE LOAD, before any
 * test body, the technique `status-bar-density.test.tsx` uses.
 */
class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();
  disconnectCount = 0;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverInstances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.observed.clear();
  }
}

let resizeObserverInstances: ControllableResizeObserver[] = [];

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

const ROOM_TESTID = "ladder-room";
const CONTENT_TESTID = "ladder-content";
const RESERVED_TESTID = "ladder-reserved";

// jsdom reports 0 for `scrollWidth`/`clientWidth`, and its `offsetWidth` is a
// plain prototype value rather than layout, so none of the three boxes ever
// carries a size on its own - a prototype override keyed on the probe's test
// ids is what lets a test put them into a persistent, independent state
// before the ref callbacks ever measure them, exactly the shape
// `status-bar-rate-limit-cluster.test.tsx` uses for its own trigger button.
// This suite is about the ladder's WALK, not the box model a shrink-to-fit
// trigger imposes on it - the coupled-layout modelling that demonstrates the
// ratchet itself lives in `status-bar-rate-limit-cluster.test.tsx`.
let roomClientWidth: number | null = null;
let contentScrollWidth: number | null = null;
// `reservedRef` reads `offsetWidth` rather than observing it, so this is the
// one box in the trio whose width is a read, not a resize delivery.
let reservedOffsetWidth: number | null = null;

const originalScrollWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollWidth",
);
const originalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth",
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);

function readOriginalWidth(
  descriptor: PropertyDescriptor | undefined,
  element: HTMLElement,
): number {
  const value: unknown = descriptor?.get?.call(element);
  return typeof value === "number" ? value : 0;
}

Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (
      contentScrollWidth !== null &&
      this.getAttribute("data-testid") === CONTENT_TESTID
    ) {
      return contentScrollWidth;
    }
    return readOriginalWidth(originalScrollWidth, this);
  },
});
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (
      roomClientWidth !== null &&
      this.getAttribute("data-testid") === ROOM_TESTID
    ) {
      return roomClientWidth;
    }
    return readOriginalWidth(originalClientWidth, this);
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (
      reservedOffsetWidth !== null &&
      this.getAttribute("data-testid") === RESERVED_TESTID
    ) {
      return reservedOffsetWidth;
    }
    return readOriginalWidth(originalOffsetWidth, this);
  },
});

function LadderProbe(props: {
  readonly ceiling: StatusBarUsageDetail;
  readonly levels: ReadonlyArray<StatusBarUsageDetail>;
  readonly segmentCount: number;
  readonly enabled?: boolean;
  readonly showReserved?: boolean;
}) {
  const { stop, roomRef, reservedRef, contentRef } = useStatusBarUsageLadder({
    ceiling: props.ceiling,
    levels: props.levels,
    segmentCount: props.segmentCount,
    enabled: props.enabled ?? true,
  });
  const showReserved = props.showReserved ?? true;
  return (
    <div
      ref={roomRef}
      data-testid={ROOM_TESTID}
      data-detail={stop.detail}
      data-folded={stop.foldedCount}
    >
      <span ref={contentRef} data-testid={CONTENT_TESTID} />
      {showReserved ? (
        <span ref={reservedRef} data-testid={RESERVED_TESTID} />
      ) : null}
    </div>
  );
}

describe("useStatusBarUsageLadder", () => {
  afterEach(() => {
    cleanup();
    resizeObserverInstances = [];
    roomClientWidth = null;
    contentScrollWidth = null;
    reservedOffsetWidth = null;
  });

  function detail(): string | null {
    return screen.getByTestId(ROOM_TESTID).getAttribute("data-detail");
  }

  function observerFor(node: Element): ControllableResizeObserver {
    const instance = resizeObserverInstances.find((candidate) =>
      candidate.observed.has(node),
    );
    if (instance === undefined) {
      throw new Error("no ResizeObserver is currently observing this node");
    }
    return instance;
  }

  function observing(node: Element): boolean {
    return resizeObserverInstances.some((candidate) =>
      candidate.observed.has(node),
    );
  }

  function setOverflowing(): void {
    roomClientWidth = 200;
    contentScrollWidth = 300;
  }

  it("measures on ref attach, with no manual observer fire needed", () => {
    // Persistently overflowing before the component ever mounts, so the very
    // first measurement - taken inside the room ref callback during
    // `render` - is what has to account for the step down.
    setOverflowing();

    render(
      <LadderProbe
        ceiling="full"
        levels={statusBarUsageLadderLevels(ALL_ON)}
        segmentCount={1}
      />,
    );

    expect(detail()).toBe("no-mode-word");
  });

  it("steps down from a resize observation alone, with no re-render in between", () => {
    setOverflowing();
    render(
      <LadderProbe
        ceiling="full"
        levels={statusBarUsageLadderLevels(ALL_ON)}
        segmentCount={1}
      />,
    );
    expect(detail()).toBe("no-mode-word");

    const room = screen.getByTestId(ROOM_TESTID);
    const instance = observerFor(room);
    act(() => {
      instance.callback([], instance);
    });

    expect(detail()).toBe("no-bars");
  });

  it("steps down from either observer - the room's and the content's alike", () => {
    setOverflowing();
    render(
      <LadderProbe
        ceiling="full"
        levels={statusBarUsageLadderLevels(ALL_ON)}
        segmentCount={1}
      />,
    );
    expect(detail()).toBe("no-mode-word");

    const room = screen.getByTestId(ROOM_TESTID);
    const content = screen.getByTestId(CONTENT_TESTID);
    const roomObserver = observerFor(room);
    const contentObserver = observerFor(content);
    // Two distinct instances - the room and the content are observed
    // separately, since a countdown ticking changes only the content's width.
    expect(roomObserver).not.toBe(contentObserver);

    act(() => {
      roomObserver.callback([], roomObserver);
    });
    expect(detail()).toBe("no-bars");

    act(() => {
      contentObserver.callback([], contentObserver);
    });
    expect(detail()).toBe("no-timers");
  });

  it("disconnects both observers on unmount", () => {
    setOverflowing();
    const view = render(
      <LadderProbe
        ceiling="full"
        levels={statusBarUsageLadderLevels(ALL_ON)}
        segmentCount={1}
      />,
    );
    const room = screen.getByTestId(ROOM_TESTID);
    const content = screen.getByTestId(CONTENT_TESTID);
    const roomObserver = observerFor(room);
    const contentObserver = observerFor(content);

    view.unmount();

    expect(roomObserver.disconnectCount).toBe(1);
    expect(contentObserver.disconnectCount).toBe(1);
  });

  describe("the enabled gate", () => {
    it("observes neither node while disabled, however the boxes are sized, and the stop stays at the ceiling", () => {
      // Wildly overflowing by the numbers alone - if the gate did not stop
      // the ladder from measuring, this would step down immediately.
      setOverflowing();

      render(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
          enabled={false}
        />,
      );

      expect(detail()).toBe("full");
      expect(observing(screen.getByTestId(ROOM_TESTID))).toBe(false);
      expect(observing(screen.getByTestId(CONTENT_TESTID))).toBe(false);
    });

    it("resets the stop back to the ceiling when enabled flips from true to false after stepping down", () => {
      setOverflowing();
      const view = render(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
          enabled
        />,
      );
      expect(detail()).toBe("no-mode-word");

      view.rerender(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
          enabled={false}
        />,
      );

      // Same overflowing boxes as before, but the gate is what is asserted
      // here: a cluster switched off must forget the rungs it stood on, not
      // merely stop reacting to further resizes.
      expect(detail()).toBe("full");
      expect(observing(screen.getByTestId(ROOM_TESTID))).toBe(false);
      expect(observing(screen.getByTestId(CONTENT_TESTID))).toBe(false);
    });

    it("re-attaches and measures again when enabled flips back to true", () => {
      setOverflowing();
      const view = render(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
          enabled={false}
        />,
      );
      expect(detail()).toBe("full");

      view.rerender(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
          enabled
        />,
      );

      // Re-attaching measures immediately, the same as the very first mount
      // does - no manual resize fire needed to see the step down.
      expect(detail()).toBe("no-mode-word");
      expect(observing(screen.getByTestId(ROOM_TESTID))).toBe(true);
      expect(observing(screen.getByTestId(CONTENT_TESTID))).toBe(true);

      const room = screen.getByTestId(ROOM_TESTID);
      const instance = observerFor(room);
      act(() => {
        instance.callback([], instance);
      });
      expect(detail()).toBe("no-bars");
    });
  });

  describe("the reserved box", () => {
    it("subtracts the reserved box's width from the room, stepping down at a width where a zero-width reservation would not", () => {
      // The readings fit the room alone (300 vs 290, within slack) but not
      // once a 20px reserved control is taken out of that same room - proving
      // the subtraction is what reaches `nextStatusBarUsageSteps`, not the
      // room's raw `clientWidth`.
      roomClientWidth = 300;
      contentScrollWidth = 290;
      reservedOffsetWidth = 0;
      const view = render(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
        />,
      );
      expect(detail()).toBe("full");
      view.unmount();

      reservedOffsetWidth = 20;
      render(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
        />,
      );
      expect(detail()).toBe("no-mode-word");
    });

    it("reserves nothing when no reserved node is rendered at all - a null reservation reserves nothing", () => {
      setOverflowing();
      // Configured as if a reserved node existed and would report 20px - the
      // point is that without an actual `RESERVED_TESTID` element for the
      // hook to hold a ref to, `reservedNodeRef.current` stays null and
      // nothing is subtracted, so behavior is unchanged from before this ref
      // existed at all (see "measures on ref attach" above).
      reservedOffsetWidth = 20;
      render(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
          showReserved={false}
        />,
      );
      expect(detail()).toBe("no-mode-word");
    });

    it("is read, not observed - no ResizeObserver instance holds the reserved node, unlike the room and content", () => {
      setOverflowing();
      render(
        <LadderProbe
          ceiling="full"
          levels={statusBarUsageLadderLevels(ALL_ON)}
          segmentCount={1}
        />,
      );

      const reserved = screen.getByTestId(RESERVED_TESTID);
      expect(() => observerFor(reserved)).toThrow();
      expect(observing(screen.getByTestId(ROOM_TESTID))).toBe(true);
      expect(observing(screen.getByTestId(CONTENT_TESTID))).toBe(true);
    });
  });
});
