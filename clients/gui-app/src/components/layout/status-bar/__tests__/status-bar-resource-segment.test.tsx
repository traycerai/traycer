import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EMPTY_GLOBAL_RESOURCE_PROJECTION,
  type GlobalResourceProjection,
} from "@/stores/resources/resources-registry";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
  type ResourceMetric,
} from "@/stores/settings/layout-store";

/**
 * What the segment does with the data it is handed — attribution above all,
 * since the strip's chip names a host at all times and the registry publishes
 * ONE projection for the window. `status-bar-resource-reading.test.ts` owns the
 * rule; this owns the wiring, which is the half a prop rename would break
 * silently.
 */
const registry: {
  projection: GlobalResourceProjection;
  unsupported: boolean;
} = {
  projection: EMPTY_GLOBAL_RESOURCE_PROJECTION,
  unsupported: false,
};

vi.mock("@/stores/resources/resources-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/resources/resources-registry")
    >();
  return {
    ...actual,
    useGlobalResourceProjection: () => registry.projection,
  };
});

vi.mock("@/hooks/resources/use-desktop-app-resource-usage", () => ({
  useDesktopAppResourceUsage: () => null,
}));

vi.mock("@/hooks/resources/use-global-resources-unsupported", () => ({
  useGlobalResourcesUnsupported: () => registry.unsupported,
}));

import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";

const GIB = 1024 * 1024 * 1024;

function liveProjection(hostId: string | null): GlobalResourceProjection {
  return {
    ...EMPTY_GLOBAL_RESOURCE_PROJECTION,
    hostId,
    sampledAt: 1,
    hostTree: {
      sampledAt: 1,
      processCount: 14,
      cpuPercent: 12,
      rssBytes: GIB,
      pssBytes: null,
      privateBytes: null,
    },
    app: {
      sampledAt: 1,
      hostTotalMemoryBytes: 16 * GIB,
      process: null,
      processCount: 3,
      cpuPercent: 4,
      rssBytes: 256 * 1024 * 1024,
      pssBytes: null,
      privateBytes: null,
    },
  };
}

function renderSegment(props: { readonly hasExplicitPick: boolean }): void {
  render(
    <TooltipProvider delayDuration={0}>
      <StatusBarResourceSegment
        density="full"
        hostId="host-b"
        hostLabel="Office Linux"
        hasExplicitPick={props.hasExplicitPick}
      />
    </TooltipProvider>,
  );
}

function metricText(metric: ResourceMetric): string {
  return screen.getByTestId(`status-bar-resource-metric-${metric}`).textContent;
}

describe("<StatusBarResourceSegment />", () => {
  beforeEach(() => {
    registry.projection = EMPTY_GLOBAL_RESOURCE_PROJECTION;
    registry.unsupported = false;
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  it("renders the watched host's numbers", () => {
    registry.projection = liveProjection("host-b");

    renderSegment({ hasExplicitPick: true });

    expect(metricText("cpu")).toContain("12%");
    expect(metricText("processes")).toContain("14");
  });

  it("draws no numbers from a projection belonging to another machine", () => {
    // The failure this closes: a picked host that cannot serve a global stream
    // has no registry entry, so the projection falls back to the per-epic
    // aggregate on the AMBIENT transport - the active host - and the strip
    // would print it under the picked host's name.
    registry.projection = liveProjection("host-a");

    renderSegment({ hasExplicitPick: true });

    expect(metricText("cpu")).not.toContain("12%");
    expect(screen.getAllByText("cpu: unavailable")).toHaveLength(1);
  });

  it("says the host is too old once its foreign numbers are gone", async () => {
    registry.projection = liveProjection("host-a");
    registry.unsupported = true;

    renderSegment({ hasExplicitPick: true });
    // The sentence lives on the tooltip, which is only reached for a metric
    // with NO value - which is exactly why an unattributed projection used to
    // swallow it.
    fireEvent.focus(screen.getByTestId("status-bar-resource-metric-cpu"));

    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Office Linux is running an older Traycer host",
    );
  });

  it("keeps reading an unattributed projection while following the active host", () => {
    registry.projection = liveProjection(null);

    renderSegment({ hasExplicitPick: false });

    expect(metricText("cpu")).toContain("12%");
  });

  it("says so when every metric is switched off", () => {
    // Reachable from Settings, which has one switch per metric. An icon with no
    // readout beside it is what a broken segment looks like.
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        resources: { ...DEFAULT_STATUS_BAR_LAYOUT.resources, metrics: [] },
      },
    });

    renderSegment({ hasExplicitPick: false });

    expect(screen.getByTestId("status-bar-resource-no-metrics")).not.toBeNull();
    // In the button's NAME, not in hidden text inside it: an `aria-label`
    // replaces the flattened contents, so a sentence in there is announced to
    // nobody - and here it is the only explanation there is.
    expect(
      screen.getByRole("button", { name: "Resources, no metrics selected" }),
    ).not.toBeNull();
    // Still the resource panel's trigger: the numbers are one click away.
    expect(screen.getByTestId("status-bar-resource-segment")).not.toBeNull();
  });
});
