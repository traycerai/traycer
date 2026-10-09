import type { ResourceMetric } from "@/lib/layout/layout-values";
import {
  formatCpuPercent,
  formatMemoryBytes,
  formatProcessCount,
} from "@/lib/resources/format-resource-usage";
import {
  attributedProjection,
  hostMemorySharePercent,
} from "@/lib/resources/headline-resource-summary";
import type { GlobalResourceProjection } from "@/stores/resources/resources-registry";

/**
 * The status bar's resource numbers, for the watched host's process tree.
 *
 * Deliberately NOT built on `combineHeadlineResourceSummary` /
 * `resolveResourceMonitorHostReading`, which the resource monitor uses and
 * which look close enough to reuse. Both ADD the local desktop shell to the
 * watched host's tree - the popover reports one machine's complete load, so
 * the Electron app belongs in its total whenever the watched host IS this
 * computer. The strip reports the host's processes and only those.
 */
export interface StatusBarResourceReading {
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly processCount: number | null;
  /**
   * Share of the machine's total RAM. `null` wherever no total-memory reading
   * exists to divide by — which is EVERY desktop-app reading, since the only
   * total the app has is the watched host's, and that host is not necessarily
   * (or even usually) the machine this window runs on.
   */
  readonly ramSharePercent: number | null;
}

const EMPTY_READING: StatusBarResourceReading = {
  cpuPercent: null,
  memoryBytes: null,
  processCount: null,
  ramSharePercent: null,
};

/** Short column headings, sized for a 24px strip rather than the panel. */
const METRIC_LABELS: Record<ResourceMetric, string> = {
  cpu: "cpu",
  memory: "mem",
  processes: "procs",
  ramShare: "ram",
};

export interface StatusBarResourceMetricView {
  readonly metric: ResourceMetric;
  readonly label: string;
  /** `null` renders the dash; `unavailableReason` then says why. */
  readonly value: string | null;
  readonly unavailableReason: string | null;
}

/**
 * The numbers, from an ALREADY-ATTRIBUTED projection — `statusBarResourceMetricViews`
 * owns that step, and nothing here can tell a foreign projection from a local
 * one. Reading the registry's raw projection through this is the mistake the
 * attribution exists to prevent, so go through the views.
 */
export function statusBarResourceReading(
  projection: GlobalResourceProjection,
): StatusBarResourceReading {
  return hostTreeReading(projection);
}

/**
 * The watched host's whole process tree.
 *
 * `hostTree` is absent on a pre-@1.2 host, which reports only its own host
 * process (`app`). Falling back to it keeps an old host showing a real, if
 * narrower, number instead of a dash that reads as "broken" — and the fallback
 * keys on the FIELD being null rather than on a negotiated stream version, so
 * this stays a pure function of the projection.
 */
function hostTreeReading(
  projection: GlobalResourceProjection,
): StatusBarResourceReading {
  const base = projection.hostTree ?? projection.app;
  if (base === null) return EMPTY_READING;
  // `rssBytes` is nullable on the wire from @1.5 on — a host that could not
  // read memory this sample still reports CPU and a process count, so the
  // metrics are resolved independently rather than the whole reading being
  // thrown away for one missing field.
  return {
    cpuPercent: base.cpuPercent,
    memoryBytes: base.rssBytes,
    processCount: base.processCount,
    // `hostTotalMemoryBytes` rides on the host `app` snapshot, so the share is
    // available even where the tree total came from the pre-@1.2 fallback
    // above — numerator and denominator then describe the same (smaller) set,
    // which is the only thing a share has to be true of.
    ramSharePercent: hostMemorySharePercent(base.rssBytes, projection.app),
  };
}

/**
 * The whole segment, in the order the store holds — which is the canonical
 * metric order, not the order the user switched things on in, so the strip
 * reads the same for everybody.
 *
 * A `null` value is always paired with a sentence, because a bare dash in a
 * 24px strip is indistinguishable between "no data yet", "not on this build"
 * and "this host is too old" — three states with three different remedies.
 */
export function statusBarResourceMetricViews(input: {
  readonly metrics: ReadonlyArray<ResourceMetric>;
  /** Straight from the registry — attributed here, before a number is read. */
  readonly projection: GlobalResourceProjection;
  /** The host the strip is WATCHING, and `hasExplicitPick` beside it. */
  readonly watchedHostId: string | null;
  readonly hasExplicitPick: boolean;
  /** The watched host cannot serve a global `resources.subscribe` at all. */
  readonly globalStreamUnsupported: boolean;
  readonly hostLabel: string;
}): ReadonlyArray<StatusBarResourceMetricView> {
  // The strip prints numbers ABOUT a watched host with nothing on screen naming
  // it, so attribution is the only thing between the reader and another
  // machine's figures — it owes the same proof the resource panel does, and
  // owes it harder. The global projection is a module singleton that outlives
  // any one transport: a host that cannot serve a global stream has no entry at
  // all, and the registry then falls through to the per-epic aggregate, which
  // rides the AMBIENT transport. Read raw, that publishes the active host's
  // cpu/mem/procs under a pick the reader cannot see — and, because a reason is
  // only consulted for a null value, it also swallows the "this host is too
  // old" sentence by supplying numbers in exactly the state that sentence was
  // written for.
  const projection = attributedProjection({
    scopeHostId: input.watchedHostId,
    hasExplicitPick: input.hasExplicitPick,
    streamed: input.projection,
  });
  const reading = statusBarResourceReading(projection);
  return input.metrics.map((metric) => {
    const value = formatStatusBarMetric(metric, reading);
    return {
      metric,
      label: METRIC_LABELS[metric],
      value,
      unavailableReason:
        value === null
          ? unavailableReason({
              metric,
              globalStreamUnsupported: input.globalStreamUnsupported,
              // A sample from the watched host DID arrive; this one field is
              // not in it. Attributed, so a foreign projection cannot pass for
              // one.
              hasSample: projection.sampledAt !== null,
              // A host either reports its total memory or it never does, so
              // the share's two failures are a passing one and a permanent
              // one and cannot share a sentence.
              hostTotalMemoryKnown:
                projection.app !== null &&
                projection.app.hostTotalMemoryBytes > 0,
              hostLabel: input.hostLabel,
            })
          : null,
    };
  });
}

function formatStatusBarMetric(
  metric: ResourceMetric,
  reading: StatusBarResourceReading,
): string | null {
  switch (metric) {
    case "cpu":
      return reading.cpuPercent === null
        ? null
        : formatCpuPercent(reading.cpuPercent);
    case "memory":
      return reading.memoryBytes === null
        ? null
        : formatMemoryBytes(reading.memoryBytes);
    case "processes":
      return reading.processCount === null
        ? null
        : formatProcessCount(reading.processCount);
    case "ramShare":
      // Percent formatting, not memory formatting: `formatCpuPercent` is the
      // app's percent formatter and the resource monitor's own RAM share reads
      // through it too, so the two surfaces round identically.
      return reading.ramSharePercent === null
        ? null
        : formatCpuPercent(reading.ramSharePercent);
  }
}

/** What a host failed to report, in the words the strip's label abbreviates. */
const METRIC_SUBJECTS: Record<ResourceMetric, string> = {
  cpu: "CPU usage",
  memory: "memory usage",
  processes: "a process count",
  // Reached only when the host DID report a total: the share is then missing
  // its numerator, which is this sample's memory reading.
  ramShare: "the memory reading a RAM share divides",
};

/**
 * Why one metric has no number, most specific cause first.
 *
 * "Waiting" is reserved for a reading that has NOT arrived, which is a
 * different claim from one that never will.
 *
 * On the host-tree side a sample can land with one field missing — `rssBytes`
 * is nullable on the wire from @1.5 on, and `hostTotalMemoryBytes` is `0` on a
 * host that never reported a total — and `hostTreeReading` resolves the fields
 * independently precisely so the two that did arrive still show. Telling
 * someone to wait for data, beside two numbers from the sample that already
 * came, names the one cause that is certainly not it.
 *
 * Those two missing fields are not the same KIND of missing, either. A null
 * `rssBytes` is this sample's; a zero `hostTotalMemoryBytes` is the host's, and
 * every later sample will be missing it too — so "in this sample" would promise
 * a next one that reads no differently.
 */
function unavailableReason(input: {
  readonly metric: ResourceMetric;
  readonly globalStreamUnsupported: boolean;
  /** A projection attributed to the watched host exists. */
  readonly hasSample: boolean;
  /** That projection carries a total-memory figure to divide by. */
  readonly hostTotalMemoryKnown: boolean;
  readonly hostLabel: string;
}): string {
  if (input.globalStreamUnsupported) {
    return `${input.hostLabel} is running an older Traycer host, which doesn't stream resource usage. Update it to see its processes here.`;
  }
  if (input.hasSample) {
    if (input.metric === "ramShare" && !input.hostTotalMemoryKnown) {
      return `${input.hostLabel} doesn't report how much memory it has, so there is no total to take a share of.`;
    }
    return `${input.hostLabel} didn't report ${METRIC_SUBJECTS[input.metric]} in this sample.`;
  }
  return "Waiting for resource data.";
}

/**
 * The button's whole accessible name: what it is, then each metric the strip is
 * showing and what it currently reads.
 *
 * `label: value` per metric, in the order they are drawn, so the name matches
 * the readout left to right. An unavailable metric says so rather than being
 * dropped - a name that silently omitted it would leave a reader who turned
 * the metric on with no way to tell it from one this build never draws.
 */
export function statusBarResourceSegmentLabel(
  views: ReadonlyArray<StatusBarResourceMetricView>,
): string {
  if (views.length === 0) return "Resources, no metrics selected";
  const readings = views
    .map((view) => `${view.label} ${view.value ?? "unavailable"}`)
    .join(", ");
  return `Resources: ${readings}`;
}
