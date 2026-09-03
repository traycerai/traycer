import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { statusBarDensityForWidth } from "@/components/layout/status-bar/status-bar-density";
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
