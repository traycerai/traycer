import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import {
  statusBarDensityForWidth,
  useStatusBarContentOverflow,
  useStatusBarDensity,
} from "@/components/layout/status-bar/status-bar-density";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

vi.mock("@/stores/resources/resources-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/resources/resources-registry")
    >();
  return {
    ...actual,
    useGlobalResourceProjection: () => actual.EMPTY_GLOBAL_RESOURCE_PROJECTION,
  };
});

vi.mock("@/hooks/resources/use-desktop-app-resource-usage", () => ({
  useDesktopAppResourceUsage: () => null,
}));

vi.mock("@/hooks/resources/use-global-resources-unsupported", () => ({
  useGlobalResourcesUnsupported: () => false,
}));

import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";

/**
 * The harness's global `MockResizeObserver` never invokes its callback, so the
 * hook's own wiring — last entry wins, an unmeasured entry is ignored,
 * `disconnect` on unmount — has no way to run without a controllable
 * replacement. Installed at MODULE LOAD, before any test body, the technique
 * `stable-tile-surface-host.test.tsx` uses.
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

const resizeObserverInstances: ControllableResizeObserver[] = [];

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

function resizeEntry(target: Element, width: number): ResizeObserverEntry {
  const box = { inlineSize: width, blockSize: 24 };
  const contentRect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    width,
    height: 24,
    top: 0,
    left: 0,
    right: width,
    bottom: 24,
    toJSON: () => ({}),
  };
  return {
    target,
    contentRect,
    borderBoxSize: [box],
    contentBoxSize: [box],
    devicePixelContentBoxSize: [box],
  };
}

function DensityProbe() {
  const ref = useRef<HTMLDivElement | null>(null);
  const density = useStatusBarDensity(ref);
  return <div ref={ref} data-testid="density-probe" data-density={density} />;
}

describe("statusBarDensityForWidth", () => {
  it("mirrors the design's two thresholds, exclusive at both", () => {
    expect(statusBarDensityForWidth(1200)).toBe("full");
    expect(statusBarDensityForWidth(900)).toBe("full");
    expect(statusBarDensityForWidth(899)).toBe("compact");
    expect(statusBarDensityForWidth(500)).toBe("compact");
    expect(statusBarDensityForWidth(499)).toBe("icon-only");
    expect(statusBarDensityForWidth(0)).toBe("icon-only");
  });
});

describe("useStatusBarDensity", () => {
  afterEach(() => {
    cleanup();
    resizeObserverInstances.length = 0;
  });

  function observer(): ControllableResizeObserver {
    const instance = resizeObserverInstances.at(-1);
    if (instance === undefined)
      throw new Error("no ResizeObserver was created");
    return instance;
  }

  function measure(width: number): void {
    const instance = observer();
    const target = screen.getByTestId("density-probe");
    act(() => {
      instance.callback([resizeEntry(target, width)], instance);
    });
  }

  function density(): string | null {
    return screen.getByTestId("density-probe").getAttribute("data-density");
  }

  it("narrows and widens with the box it observes", () => {
    render(<DensityProbe />);

    // The widest form is what the first paint shows; the observer fires right
    // after it, so it is on screen for at most a frame.
    expect(density()).toBe("full");
    measure(880);
    expect(density()).toBe("compact");
    measure(420);
    expect(density()).toBe("icon-only");
    measure(1200);
    expect(density()).toBe("full");
  });

  it("takes the LAST entry of a batch, not the first", () => {
    // Several resizes coalesced into one frame arrive in order; the first is
    // already stale by the time the callback runs.
    render(<DensityProbe />);
    const instance = observer();
    const target = screen.getByTestId("density-probe");

    act(() => {
      instance.callback(
        [resizeEntry(target, 1200), resizeEntry(target, 420)],
        instance,
      );
    });

    expect(density()).toBe("icon-only");
  });

  it("ignores a batch that measured nothing", () => {
    render(<DensityProbe />);
    measure(420);
    const instance = observer();

    act(() => {
      instance.callback([], instance);
    });

    expect(density()).toBe("icon-only");
  });

  it("disconnects when the bar goes away", () => {
    const view = render(<DensityProbe />);
    const instance = observer();

    view.unmount();

    expect(instance.disconnectCount).toBe(1);
  });
});

function OverflowProbe() {
  const measureRef = useStatusBarContentOverflow();
  return <div ref={measureRef} data-testid="overflow-probe" />;
}

/**
 * Renders whichever element type `variant` names at the same tree position,
 * so switching `variant` forces React to discard the old DOM node and mount a
 * fresh one under the same callback ref - the same shape `PopoverTrigger`'s
 * anchor swap produces in production, without depending on Radix internals.
 */
function SwappableOverflowProbe(props: { readonly variant: "div" | "span" }) {
  const measureRef = useStatusBarContentOverflow();
  return props.variant === "div" ? (
    <div ref={measureRef} data-testid="overflow-probe" />
  ) : (
    <span ref={measureRef} data-testid="overflow-probe" />
  );
}

describe("useStatusBarContentOverflow", () => {
  afterEach(() => {
    cleanup();
    resizeObserverInstances.length = 0;
  });

  function probeElement(): HTMLElement {
    return screen.getByTestId("overflow-probe");
  }

  function clipped(): string | null {
    return probeElement().getAttribute("data-clipped");
  }

  // jsdom reports both as 0 by default, so every case sets its own pair
  // rather than relying on a real layout to produce them.
  function setBoxWidths(
    target: HTMLElement,
    scrollWidth: number,
    clientWidth: number,
  ): void {
    Object.defineProperty(target, "scrollWidth", {
      configurable: true,
      value: scrollWidth,
    });
    Object.defineProperty(target, "clientWidth", {
      configurable: true,
      value: clientWidth,
    });
  }

  // No dependency array on the underlying `useLayoutEffect` - re-rendering the
  // SAME element is what re-triggers the measurement, mirroring a content
  // change that alters `scrollWidth` without touching the box.
  function remeasure(view: { rerender: (node: ReactElement) => void }): void {
    act(() => {
      view.rerender(<OverflowProbe />);
    });
  }

  // The observer currently watching `node` - never assumed to be the
  // last-created instance, so a reattachment bug (an old observer left on a
  // stale node) fails this lookup instead of silently passing against the
  // wrong instance.
  function observerFor(node: Element): ControllableResizeObserver {
    const instance = resizeObserverInstances.find((candidate) =>
      candidate.observed.has(node),
    );
    if (instance === undefined) {
      throw new Error("no ResizeObserver is currently observing this node");
    }
    return instance;
  }

  it("reads no overflow when content fits its box", () => {
    const view = render(<OverflowProbe />);

    setBoxWidths(probeElement(), 100, 100);
    remeasure(view);

    expect(clipped()).toBe("false");
  });

  it("flags overflow once scrollWidth exceeds the box by more than the 1px slack", () => {
    const view = render(<OverflowProbe />);

    setBoxWidths(probeElement(), 102, 100);
    remeasure(view);

    expect(clipped()).toBe("true");
  });

  it("treats exactly 1px over as within the deliberate slack", () => {
    const view = render(<OverflowProbe />);

    setBoxWidths(probeElement(), 101, 100);
    remeasure(view);

    expect(clipped()).toBe("false");
  });

  it("re-measures from a resize observation alone, with no render in between", () => {
    const view = render(<OverflowProbe />);
    setBoxWidths(probeElement(), 100, 100);
    remeasure(view);
    expect(clipped()).toBe("false");

    // A box shrink with no re-render: only the observer can catch this, since
    // nothing about the component's own output changed.
    setBoxWidths(probeElement(), 200, 100);
    const instance = observerFor(probeElement());
    act(() => {
      instance.callback([], instance);
    });

    expect(clipped()).toBe("true");
  });

  it("disconnects its observer on unmount", () => {
    const view = render(<OverflowProbe />);
    const instance = observerFor(probeElement());

    view.unmount();

    expect(instance.disconnectCount).toBe(1);
  });

  it("follows the node when the probe swaps its underlying DOM element", () => {
    // Regression guard for the detached-node bug: `PopoverTrigger` wraps its
    // child in a Popper anchor only from its second commit onward, replacing
    // the DOM node the hook measures. A callback ref has to notice and
    // re-attach, or the observer is left watching a node nothing renders
    // anymore.
    const view = render(<SwappableOverflowProbe variant="div" />);
    const firstNode = probeElement();
    setBoxWidths(firstNode, 100, 100);
    act(() => {
      view.rerender(<SwappableOverflowProbe variant="div" />);
    });
    expect(clipped()).toBe("false");
    const firstObserver = observerFor(firstNode);

    act(() => {
      view.rerender(<SwappableOverflowProbe variant="span" />);
    });

    // The old node is gone from the DOM and its observer was told to let go.
    expect(document.body.contains(firstNode)).toBe(false);
    expect(firstObserver.disconnectCount).toBe(1);

    const currentNode = probeElement();
    expect(currentNode).not.toBe(firstNode);
    setBoxWidths(currentNode, 300, 100);
    // Looked up by which node it actually observes, not by creation order -
    // this is what makes the assertion below fail against an implementation
    // that left the old observer running instead of reattaching.
    const currentObserver = observerFor(currentNode);
    act(() => {
      currentObserver.callback([], currentObserver);
    });

    expect(clipped()).toBe("true");
  });
});

describe("<StatusBarResourceSegment /> density", () => {
  beforeEach(() => {
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  function renderSegment(density: "full" | "compact" | "icon-only"): void {
    render(
      <StatusBarResourceSegment
        density={density}
        hostId="host-a"
        hostLabel="Host A"
        hasExplicitPick={false}
      />,
    );
  }

  function renderedMetrics(): ReadonlyArray<string> {
    return screen
      .getAllByTestId(/^status-bar-resource-metric-/)
      .map((element) => element.getAttribute("data-testid") ?? "");
  }

  it("shows every selected metric with its label at full width", () => {
    renderSegment("full");

    expect(renderedMetrics()).toEqual([
      "status-bar-resource-metric-cpu",
      "status-bar-resource-metric-memory",
      "status-bar-resource-metric-processes",
    ]);
    expect(screen.getByText("cpu")).not.toBeNull();
    expect(screen.getByText("mem")).not.toBeNull();
    expect(screen.getByText("procs")).not.toBeNull();
  });

  it("drops the labels but keeps every metric when compact", () => {
    renderSegment("compact");

    expect(renderedMetrics()).toHaveLength(3);
    expect(screen.queryByText("cpu")).toBeNull();
    expect(screen.queryByText("procs")).toBeNull();
  });

  it("keeps memory alone at icon-only width", () => {
    renderSegment("icon-only");

    expect(renderedMetrics()).toEqual(["status-bar-resource-metric-memory"]);
  });

  it("never empties a configured segment when memory is switched off", () => {
    // The density is the app narrowing its own chrome; it has no business
    // emptying a control the user configured, so the first selected metric
    // stands in for memory.
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        resources: {
          ...DEFAULT_STATUS_BAR_LAYOUT.resources,
          metrics: ["cpu", "processes"],
        },
      },
    });

    renderSegment("icon-only");

    expect(renderedMetrics()).toEqual(["status-bar-resource-metric-cpu"]);
  });

  it("dashes an unavailable metric and says so to assistive tech", () => {
    // Nothing has streamed yet in this suite, so every metric is unavailable.
    renderSegment("full");

    expect(screen.getByText("cpu: unavailable")).not.toBeNull();
    expect(screen.getByText("mem: unavailable")).not.toBeNull();
  });
});
