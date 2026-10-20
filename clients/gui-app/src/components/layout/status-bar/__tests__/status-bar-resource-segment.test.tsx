import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EMPTY_GLOBAL_RESOURCE_PROJECTION,
  type GlobalResourceProjection,
} from "@/stores/resources/resources-registry";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import type { ResourceMetric } from "@/lib/layout/layout-values";
import { RUNNING_LOW_TEXT_CLASS_NAME } from "@/lib/rate-limits/window-severity";
import type { DesktopAppResourceUsage } from "@/lib/resources/desktop-app-resource-usage";

/**
 * What the segment does with the data it is handed — attribution above all,
 * since the strip watches a host at all times and the registry publishes ONE
 * projection for the window. `status-bar-resource-reading.test.ts` owns the
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

vi.mock("@/hooks/resources/use-global-resources-unsupported", () => ({
  useGlobalResourcesUnsupported: () => registry.unsupported,
}));

/**
 * The shell sampler, as the segment asks for it: `enabled` is what starts a
 * once-a-second IPC poll, so the test records it rather than only answering.
 */
const desktopSampler: {
  usage: DesktopAppResourceUsage | null;
  enabledCalls: boolean[];
} = { usage: null, enabledCalls: [] };

vi.mock("@/hooks/resources/use-desktop-app-resource-usage", () => ({
  useDesktopAppResourceUsage: (enabled: boolean) => {
    desktopSampler.enabledCalls.push(enabled);
    return enabled ? desktopSampler.usage : null;
  },
}));

import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";

const GIB = 1024 * 1024 * 1024;

const DESKTOP_APP: DesktopAppResourceUsage = {
  sampledAt: 1,
  cpuPercent: 3,
  rssBytes: GIB / 2,
  processCount: 6,
  main: { cpuPercent: 1, rssBytes: GIB / 8, processCount: 1 },
  renderer: { cpuPercent: 2, rssBytes: GIB / 4, processCount: 2 },
  other: { cpuPercent: 0, rssBytes: GIB / 8, processCount: 3 },
};

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

function renderSegment(props: {
  readonly hasExplicitPick: boolean;
  readonly watchesThisMachine?: boolean;
}): void {
  render(
    <TooltipProvider delayDuration={0}>
      <StatusBarResourceSegment
        hostId="host-b"
        hostLabel="Office Linux"
        hasExplicitPick={props.hasExplicitPick}
        watchesThisMachine={props.watchesThisMachine ?? false}
        interactive={false}
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
    desktopSampler.usage = DESKTOP_APP;
    desktopSampler.enabledCalls = [];
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });

  it("renders the watched host's numbers", () => {
    registry.projection = liveProjection("host-b");

    renderSegment({ hasExplicitPick: true });

    expect(metricText("cpu")).toContain("12%");
    expect(metricText("processes")).toContain("14");
  });

  describe("the desktop shell", () => {
    it("is counted in the total when the watched host is this computer", () => {
      // The same number the resource monitor's headline prints for this
      // machine: the host tree plus the Electron app, so the strip and the
      // panel can no longer disagree by the shell's working set.
      registry.projection = liveProjection("host-b");
      useLayoutStore.getState().setRegionValues("resourceMonitor", {
        cpu: true,
        memory: true,
        processes: true,
        ramShare: true,
      });

      renderSegment({ hasExplicitPick: true, watchesThisMachine: true });

      expect(metricText("memory")).toBe("mem1.5 GB");
      expect(metricText("cpu")).toBe("cpu15%");
      expect(metricText("processes")).toBe("procs20");
      expect(metricText("ramShare")).toBe("ram9.4%");
    });

    it("is left out of another machine's total, and never sampled for it", () => {
      // Sampling is an IPC round trip a second for the life of the window, so
      // a reading about a remote host must not start it, not merely ignore it.
      registry.projection = liveProjection("host-b");
      useLayoutStore
        .getState()
        .setRegionValues("resourceMonitor", { memory: true });

      renderSegment({ hasExplicitPick: true, watchesThisMachine: false });

      expect(metricText("memory")).toBe("mem1.0 GB");
      expect(desktopSampler.enabledCalls).not.toContain(true);
    });

    it("is not sampled while every metric is switched off", () => {
      useLayoutStore.getState().setRegionValues("resourceMonitor", {
        cpu: false,
        memory: false,
        processes: false,
        ramShare: false,
      });

      renderSegment({ hasExplicitPick: false, watchesThisMachine: true });

      expect(desktopSampler.enabledCalls).not.toContain(true);
    });
  });

  describe("density", () => {
    function projectionWithCpu(cpuPercent: number): GlobalResourceProjection {
      const live = liveProjection("host-b");
      return {
        ...live,
        hostTree:
          live.hostTree === null ? null : { ...live.hostTree, cpuPercent },
      };
    }

    it("draws the CPU icon alone, no number, when Density is Compact, whatever Metrics says", () => {
      registry.projection = liveProjection("host-b");
      useLayoutStore.getState().setRegionValues("resourceMonitor", {
        density: "compact",
        cpu: false,
        processes: true,
      });

      renderSegment({ hasExplicitPick: true });

      const icon = screen.getByTestId("status-bar-resource-cpu-icon");
      expect(icon.textContent).toBe("");
      expect(icon.querySelector("svg")).not.toBeNull();
      expect(screen.queryByTestId("resource-cpu-reading")).toBeNull();
      expect(
        screen.queryByTestId("status-bar-resource-metric-processes"),
      ).toBeNull();
      expect(screen.queryByTestId("status-bar-resource-metric-cpu")).toBeNull();
    });

    it("carries the compact CPU value in the icon's tooltip", async () => {
      registry.projection = liveProjection("host-b");
      useLayoutStore
        .getState()
        .setRegionValues("resourceMonitor", { density: "compact" });

      renderSegment({ hasExplicitPick: true });
      fireEvent.focus(screen.getByTestId("status-bar-resource-cpu-icon"));

      expect((await screen.findByRole("tooltip")).textContent).toContain(
        "CPU 12%",
      );
    });

    it("carries the compact unavailable reason in the icon's tooltip", async () => {
      registry.projection = liveProjection("host-a");
      registry.unsupported = true;
      useLayoutStore
        .getState()
        .setRegionValues("resourceMonitor", { density: "compact" });

      renderSegment({ hasExplicitPick: true });
      fireEvent.focus(screen.getByTestId("status-bar-resource-cpu-icon"));

      expect((await screen.findByRole("tooltip")).textContent).toContain(
        "Office Linux is running an older Traycer host",
      );
    });

    it.each([
      { cpuPercent: 84, warns: false },
      { cpuPercent: 85, warns: true },
      { cpuPercent: 97, warns: true },
    ])(
      "colours CPU $cpuPercent% as a warning: $warns",
      ({ cpuPercent, warns }) => {
        registry.projection = projectionWithCpu(cpuPercent);

        renderSegment({ hasExplicitPick: true });

        // The value, not its label, which keeps its own muted tone.
        const value = screen.getByTestId("status-bar-resource-metric-cpu")
          .lastElementChild?.className;
        expect(value?.includes(RUNNING_LOW_TEXT_CLASS_NAME)).toBe(warns);
      },
    );

    it("warns on the compact icon too", () => {
      registry.projection = projectionWithCpu(92);
      useLayoutStore
        .getState()
        .setRegionValues("resourceMonitor", { density: "compact" });

      renderSegment({ hasExplicitPick: true });

      expect(
        screen.getByTestId("status-bar-resource-cpu-icon").className,
      ).toContain(RUNNING_LOW_TEXT_CLASS_NAME);
    });

    it("never warns on the other metrics", () => {
      registry.projection = projectionWithCpu(99);

      renderSegment({ hasExplicitPick: true });

      expect(
        screen.getByTestId("status-bar-resource-metric-processes")
          .lastElementChild?.className,
      ).not.toContain(RUNNING_LOW_TEXT_CLASS_NAME);
    });
  });

  it("prints every metric with its label - the segment never shortens itself for a narrow window", () => {
    // The usage cluster beside it is the box that gives way, by scrolling;
    // this readout is pinned at its natural width and says the same thing at
    // every width, so a reader never has to guess which number is which.
    registry.projection = liveProjection("host-b");

    renderSegment({ hasExplicitPick: true });

    expect(metricText("cpu")).toBe("cpu12%");
    expect(metricText("processes")).toBe("procs14");
    expect(
      screen.getByTestId("status-bar-resource-segment").className,
    ).toContain("shrink-0");
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
    useLayoutStore.getState().setRegionValues("resourceMonitor", {
      cpu: false,
      memory: false,
      processes: false,
      ramShare: false,
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

  it("names every metric and its reading, so the numbers survive the label", () => {
    // The same `aria-label` rule the empty state relies on cuts the other way
    // once there IS a readout: the name REPLACES the flattened contents, so a
    // bare "Resources" hid every figure in the segment from a screen reader.
    registry.projection = liveProjection("host-b");

    renderSegment({ hasExplicitPick: true });

    const name = screen
      .getByTestId("status-bar-resource-segment")
      .getAttribute("aria-label");
    expect(name).toContain("Resources:");
    expect(name).toContain("cpu 12%");
    expect(name).toContain("procs 14");
  });

  it("names a metric it cannot read as unavailable rather than dropping it", () => {
    // `StatusBarMetric` writes that sentence as `sr-only` text INSIDE the
    // button, where the label makes it unreachable - so the name has to carry
    // it, or a reader who turned the metric on cannot tell it from one this
    // build never draws.
    registry.projection = liveProjection("host-a");

    renderSegment({ hasExplicitPick: true });

    expect(
      screen
        .getByTestId("status-bar-resource-segment")
        .getAttribute("aria-label"),
    ).toContain("cpu unavailable");
  });
});
