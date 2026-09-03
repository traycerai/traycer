import { describe, expect, it } from "vitest";
import {
  statusBarResourceMetricViews,
  statusBarResourceReading,
} from "@/lib/resources/status-bar-resource-reading";
import type { DesktopAppResourceUsage } from "@/lib/resources/desktop-app-resource-usage";
import {
  EMPTY_GLOBAL_RESOURCE_PROJECTION,
  type GlobalResourceProjection,
} from "@/stores/resources/resources-registry";
import type {
  AppResourceUsage,
  HostTreeResourceUsage,
} from "@/stores/resources/resources-store";
import type { ResourceMetric } from "@/stores/settings/layout-store";

const GIB = 1024 * 1024 * 1024;

function appSnapshot(overrides: Partial<AppResourceUsage>): AppResourceUsage {
  return {
    sampledAt: 1,
    hostTotalMemoryBytes: 16 * GIB,
    process: null,
    processCount: 3,
    cpuPercent: 4,
    rssBytes: 256 * 1024 * 1024,
    pssBytes: null,
    privateBytes: null,
    ...overrides,
  };
}

function hostTreeSnapshot(
  overrides: Partial<HostTreeResourceUsage>,
): HostTreeResourceUsage {
  return {
    sampledAt: 1,
    processCount: 14,
    cpuPercent: 12,
    rssBytes: GIB,
    pssBytes: null,
    privateBytes: null,
    ...overrides,
  };
}

function projection(
  overrides: Partial<GlobalResourceProjection>,
): GlobalResourceProjection {
  return { ...EMPTY_GLOBAL_RESOURCE_PROJECTION, ...overrides };
}

function desktopUsage(
  overrides: Partial<DesktopAppResourceUsage>,
): DesktopAppResourceUsage {
  const group = { cpuPercent: 0, rssBytes: 0, processCount: 0 };
  return {
    sampledAt: 1,
    cpuPercent: 7,
    rssBytes: 512 * 1024 * 1024,
    processCount: 5,
    main: group,
    renderer: group,
    other: group,
    ...overrides,
  };
}

const ALL_METRICS: ReadonlyArray<ResourceMetric> = [
  "cpu",
  "memory",
  "processes",
  "ramShare",
];

function views(input: {
  readonly scope: "host-tree" | "desktop-app";
  readonly metrics?: ReadonlyArray<ResourceMetric>;
  readonly projection?: GlobalResourceProjection;
  readonly desktopApp?: DesktopAppResourceUsage | null;
  readonly globalStreamUnsupported?: boolean;
}) {
  return statusBarResourceMetricViews({
    scope: input.scope,
    metrics: input.metrics ?? ALL_METRICS,
    projection: input.projection ?? EMPTY_GLOBAL_RESOURCE_PROJECTION,
    desktopApp: input.desktopApp ?? null,
    globalStreamUnsupported: input.globalStreamUnsupported ?? false,
    hostLabel: "Office Linux",
  });
}

function valueOf(
  rendered: ReturnType<typeof views>,
  metric: ResourceMetric,
): string | null {
  const view = rendered.find((candidate) => candidate.metric === metric);
  if (view === undefined) throw new Error(`${metric} was not rendered`);
  return view.value;
}

describe("statusBarResourceReading", () => {
  it("reads the watched host's whole tree in the host-tree scope", () => {
    const reading = statusBarResourceReading({
      scope: "host-tree",
      projection: projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({}),
      }),
      // Present, and deliberately NOT folded in: the two scopes are subjects
      // the user picks between, not a total plus a component of it.
      desktopApp: desktopUsage({}),
    });

    expect(reading.cpuPercent).toBe(12);
    expect(reading.memoryBytes).toBe(GIB);
    expect(reading.processCount).toBe(14);
    expect(reading.ramSharePercent).toBeCloseTo(6.25, 5);
  });

  it("falls back to the host app process when a pre-@1.2 host sends no tree", () => {
    const reading = statusBarResourceReading({
      scope: "host-tree",
      projection: projection({ hostTree: null, app: appSnapshot({}) }),
      desktopApp: null,
    });

    expect(reading.cpuPercent).toBe(4);
    expect(reading.memoryBytes).toBe(256 * 1024 * 1024);
    expect(reading.processCount).toBe(3);
    // Numerator and denominator describe the same (narrower) set, which is the
    // only thing a share has to be true of.
    expect(reading.ramSharePercent).toBeCloseTo(1.5625, 5);
  });

  it("reads THIS desktop app in the desktop-app scope, whatever the host reports", () => {
    const reading = statusBarResourceReading({
      scope: "desktop-app",
      projection: projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({}),
      }),
      desktopApp: desktopUsage({}),
    });

    expect(reading.cpuPercent).toBe(7);
    expect(reading.memoryBytes).toBe(512 * 1024 * 1024);
    expect(reading.processCount).toBe(5);
    // The watched host's total is the wrong denominator — it may not even be
    // this machine — so the share is refused rather than approximated.
    expect(reading.ramSharePercent).toBeNull();
  });

  it("keeps CPU and process count when the host could not read memory", () => {
    // `rssBytes` is nullable from @1.5 on. One missing field must not throw
    // away the two that arrived.
    const reading = statusBarResourceReading({
      scope: "host-tree",
      projection: projection({
        hostTree: hostTreeSnapshot({ rssBytes: null }),
        app: appSnapshot({}),
      }),
      desktopApp: null,
    });

    expect(reading.cpuPercent).toBe(12);
    expect(reading.processCount).toBe(14);
    expect(reading.memoryBytes).toBeNull();
    expect(reading.ramSharePercent).toBeNull();
  });

  it("has no share to report when the host never sent a total", () => {
    const reading = statusBarResourceReading({
      scope: "host-tree",
      projection: projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({ hostTotalMemoryBytes: 0 }),
      }),
      desktopApp: null,
    });

    expect(reading.ramSharePercent).toBeNull();
  });
});

describe("statusBarResourceMetricViews", () => {
  it("renders the stored metrics in the stored order and nothing else", () => {
    const rendered = views({
      scope: "host-tree",
      metrics: ["memory", "cpu"],
      projection: projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({}),
      }),
    });

    expect(rendered.map((view) => view.metric)).toEqual(["memory", "cpu"]);
    expect(rendered.map((view) => view.label)).toEqual(["mem", "cpu"]);
    expect(valueOf(rendered, "cpu")).toBe("12%");
    expect(valueOf(rendered, "memory")).toBe("1.0 GB");
  });

  it("formats process counts and the RAM share", () => {
    const rendered = views({
      scope: "host-tree",
      projection: projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({}),
      }),
    });

    expect(valueOf(rendered, "processes")).toBe("14");
    expect(valueOf(rendered, "ramShare")).toBe("6.3%");
  });

  it("dashes RAM share in the desktop-app scope and says which denominator is missing", () => {
    const rendered = views({
      scope: "desktop-app",
      desktopApp: desktopUsage({}),
    });

    // `formatCpuPercent`'s own rule: one decimal below 10, whole above.
    expect(valueOf(rendered, "cpu")).toBe("7.0%");
    expect(valueOf(rendered, "memory")).toBe("512 MB");
    expect(valueOf(rendered, "ramShare")).toBeNull();
    const share = rendered.find((view) => view.metric === "ramShare");
    expect(share?.unavailableReason).toContain("total-memory reading");
    // Every other metric has a number, so none of them carries a sentence.
    expect(
      rendered
        .filter((view) => view.metric !== "ramShare")
        .every((view) => view.unavailableReason === null),
    ).toBe(true);
  });

  it("says 'desktop app only' for every metric in a build with no shell bridge", () => {
    const rendered = views({ scope: "desktop-app", desktopApp: null });

    expect(rendered.every((view) => view.value === null)).toBe(true);
    for (const view of rendered) {
      expect(view.unavailableReason).toContain("Desktop app only");
    }
    // The scope-level cause outranks RAM share's own limitation: in a browser
    // build every metric is missing for the same reason, and naming the share's
    // denominator there would explain the wrong thing.
    const share = rendered.find((view) => view.metric === "ramShare");
    expect(share?.unavailableReason).not.toContain("total-memory reading");
  });

  it("names the host's age when it cannot serve a global stream", () => {
    const rendered = views({
      scope: "host-tree",
      globalStreamUnsupported: true,
    });

    for (const view of rendered) {
      expect(view.value).toBeNull();
      expect(view.unavailableReason).toContain("older Traycer host");
      expect(view.unavailableReason).toContain("Office Linux");
    }
  });

  it("waits, rather than blaming the host, before the first sample lands", () => {
    const rendered = views({ scope: "host-tree" });

    for (const view of rendered) {
      expect(view.value).toBeNull();
      expect(view.unavailableReason).toBe("Waiting for resource data.");
    }
  });
});
