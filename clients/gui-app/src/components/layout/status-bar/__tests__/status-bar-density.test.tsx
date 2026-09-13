import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import {
  statusBarDensityForWidth,
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
