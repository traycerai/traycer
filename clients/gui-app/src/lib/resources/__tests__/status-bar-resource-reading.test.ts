import { describe, expect, it } from "vitest";
import {
  statusBarResourceMetricViews,
  statusBarResourceReading,
  type StatusBarResourceMetricView,
} from "@/lib/resources/status-bar-resource-reading";
import {
  EMPTY_GLOBAL_RESOURCE_PROJECTION,
  type GlobalResourceProjection,
} from "@/stores/resources/resources-registry";
import type {
  AppResourceUsage,
  HostTreeResourceUsage,
} from "@/stores/resources/resources-store";
import type { ResourceMetric } from "@/lib/layout/layout-values";

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

const ALL_METRICS: ReadonlyArray<ResourceMetric> = [
  "cpu",
  "memory",
  "processes",
  "ramShare",
];

function views(input: {
  readonly metrics?: ReadonlyArray<ResourceMetric>;
  readonly projection?: GlobalResourceProjection;
  readonly watchedHostId?: string | null;
  readonly hasExplicitPick?: boolean;
  readonly globalStreamUnsupported?: boolean;
}) {
  return statusBarResourceMetricViews({
    metrics: input.metrics ?? ALL_METRICS,
    projection: input.projection ?? EMPTY_GLOBAL_RESOURCE_PROJECTION,
    watchedHostId: input.watchedHostId ?? null,
    hasExplicitPick: input.hasExplicitPick ?? false,
    globalStreamUnsupported: input.globalStreamUnsupported ?? false,
    hostLabel: "Office Linux",
  });
}

/** A live host-tree sample, as the registry would publish it for one machine. */
function liveProjection(hostId: string | null): GlobalResourceProjection {
  return projection({
    hostId,
    sampledAt: 1,
    hostTree: hostTreeSnapshot({}),
    app: appSnapshot({}),
  });
}

function valueOf(
  rendered: ReadonlyArray<StatusBarResourceMetricView>,
  metric: ResourceMetric,
): string | null {
  const view = rendered.find((candidate) => candidate.metric === metric);
  if (view === undefined) throw new Error(`${metric} was not rendered`);
  return view.value;
}

describe("statusBarResourceReading", () => {
  it("reads the watched host's whole tree", () => {
    const reading = statusBarResourceReading(
      projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({}),
      }),
    );

    expect(reading.cpuPercent).toBe(12);
    expect(reading.memoryBytes).toBe(GIB);
    expect(reading.processCount).toBe(14);
    expect(reading.ramSharePercent).toBeCloseTo(6.25, 5);
  });

  it("falls back to the host app process when a pre-@1.2 host sends no tree", () => {
    const reading = statusBarResourceReading(
      projection({ hostTree: null, app: appSnapshot({}) }),
    );

    expect(reading.cpuPercent).toBe(4);
    expect(reading.memoryBytes).toBe(256 * 1024 * 1024);
    expect(reading.processCount).toBe(3);
    // Numerator and denominator describe the same (narrower) set, which is the
    // only thing a share has to be true of.
    expect(reading.ramSharePercent).toBeCloseTo(1.5625, 5);
  });

  it("keeps CPU and process count when the host could not read memory", () => {
    // `rssBytes` is nullable from @1.5 on. One missing field must not throw
    // away the two that arrived.
    const reading = statusBarResourceReading(
      projection({
        hostTree: hostTreeSnapshot({ rssBytes: null }),
        app: appSnapshot({}),
      }),
    );

    expect(reading.cpuPercent).toBe(12);
    expect(reading.processCount).toBe(14);
    expect(reading.memoryBytes).toBeNull();
    expect(reading.ramSharePercent).toBeNull();
  });

  it("has no share to report when the host never sent a total", () => {
    const reading = statusBarResourceReading(
      projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({ hostTotalMemoryBytes: 0 }),
      }),
    );

    expect(reading.ramSharePercent).toBeNull();
  });
});

describe("statusBarResourceMetricViews", () => {
  it("renders the stored metrics in the stored order and nothing else", () => {
    const rendered = views({
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
      projection: projection({
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({}),
      }),
    });

    expect(valueOf(rendered, "processes")).toBe("14");
    expect(valueOf(rendered, "ramShare")).toBe("6.3%");
  });

  it("names the host's age when it cannot serve a global stream", () => {
    const rendered = views({ globalStreamUnsupported: true });

    for (const view of rendered) {
      expect(view.value).toBeNull();
      expect(view.unavailableReason).toContain("older Traycer host");
      expect(view.unavailableReason).toContain("Office Linux");
    }
  });

  it("waits, rather than blaming the host, before the first sample lands", () => {
    const rendered = views({});

    for (const view of rendered) {
      expect(view.value).toBeNull();
      expect(view.unavailableReason).toBe("Waiting for resource data.");
    }
  });

  it("says which field the sample was missing, rather than telling you to wait for it", () => {
    // The sample ARRIVED - `rssBytes` is nullable on the wire from @1.5 on, and
    // the reading resolves fields independently so the two that came still
    // show. "Waiting for resource data." beside `cpu 12%` names the one cause
    // that is certainly not it.
    const rendered = views({
      projection: projection({
        hostId: "host-b",
        sampledAt: 1,
        hostTree: hostTreeSnapshot({ rssBytes: null }),
        app: appSnapshot({}),
      }),
    });

    expect(valueOf(rendered, "cpu")).toBe("12%");
    expect(valueOf(rendered, "processes")).toBe("14");
    const memory = rendered.find((view) => view.metric === "memory");
    expect(memory?.unavailableReason).toBe(
      "Office Linux didn't report memory usage in this sample.",
    );
    // The share went with it, and for the same passing reason - the host DID
    // report a total, so only the numerator is missing.
    const share = rendered.find((view) => view.metric === "ramShare");
    expect(share?.unavailableReason).toBe(
      "Office Linux didn't report the memory reading a RAM share divides in this sample.",
    );
  });

  it("speaks of a missing total as the host's property, not this sample's", () => {
    // `hostTotalMemoryBytes` is 0 on a host that never reports one, so "in this
    // sample" would promise a next sample that reads no differently.
    const rendered = views({
      projection: projection({
        hostId: "host-b",
        sampledAt: 1,
        hostTree: hostTreeSnapshot({}),
        app: appSnapshot({ hostTotalMemoryBytes: 0 }),
      }),
    });

    const share = rendered.find((view) => view.metric === "ramShare");
    expect(share?.value).toBeNull();
    expect(share?.unavailableReason).toBe(
      "Office Linux doesn't report how much memory it has, so there is no total to take a share of.",
    );
    // The metrics that did arrive are untouched by it.
    expect(valueOf(rendered, "memory")).toBe("1.0 GB");
  });
});

describe("statusBarResourceMetricViews · host attribution", () => {
  it("publishes nothing from a projection belonging to another machine", () => {
    // Nothing in the strip names the host these numbers are about, so this
    // proof is the only thing standing between the reader and another
    // machine's figures. The registry's global projection is one per WINDOW: a
    // picked host that cannot serve a global stream has no entry, and the
    // fallback per-epic aggregate rides the AMBIENT transport - the active
    // host's numbers, one frame from being drawn for a pick nobody can see.
    const rendered = views({
      projection: liveProjection("host-a"),
      watchedHostId: "host-b",
      hasExplicitPick: true,
    });

    for (const view of rendered) {
      expect(view.value).toBeNull();
    }
  });

  it("lets the 'host too old' sentence through once the foreign numbers are gone", () => {
    // The regression this pins: a reason is only consulted for a NULL value, so
    // an unattributed projection supplying numbers hid the copy in exactly the
    // state it was written for.
    const rendered = views({
      projection: liveProjection("host-a"),
      watchedHostId: "host-b",
      hasExplicitPick: true,
      globalStreamUnsupported: true,
    });

    for (const view of rendered) {
      expect(view.unavailableReason).toContain("older Traycer host");
    }
  });

  it("reads a projection that names the picked host", () => {
    const rendered = views({
      projection: liveProjection("host-b"),
      watchedHostId: "host-b",
      hasExplicitPick: true,
    });

    expect(valueOf(rendered, "cpu")).toBe("12%");
    expect(valueOf(rendered, "processes")).toBe("14");
  });

  it("refuses only what is provably foreign while following the active host", () => {
    // Nothing on screen names a machine the user chose, and an unattributed
    // projection is every cold start - demanding proof there would blank a
    // working strip on every launch.
    const unattributed = views({
      projection: liveProjection(null),
      watchedHostId: "host-b",
    });
    expect(valueOf(unattributed, "cpu")).toBe("12%");

    const foreign = views({
      projection: liveProjection("host-a"),
      watchedHostId: "host-b",
    });
    expect(valueOf(foreign, "cpu")).toBeNull();
  });
});
