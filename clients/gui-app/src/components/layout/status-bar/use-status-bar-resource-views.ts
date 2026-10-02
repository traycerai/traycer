import { useGlobalResourcesUnsupported } from "@/hooks/resources/use-global-resources-unsupported";
import { attributedProjection } from "@/lib/resources/headline-resource-summary";
import {
  statusBarResourceMetricViews,
  statusBarResourceReading,
  type StatusBarResourceMetricView,
} from "@/lib/resources/status-bar-resource-reading";
import { CPU_WARNING_PERCENT } from "@/lib/layout/reading-density";
import { useGlobalResourceProjection } from "@/stores/resources/resources-registry";
import { useRegionValues } from "@/lib/layout-overrides";
import {
  shownResourceMetrics,
  type ResourceMetric,
} from "@/lib/layout/layout-values";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { SAMPLE_RESOURCE_VALUES } from "@/components/sample-workspace/sample-workspace-scene";

/** CPU at or above the shared threshold reads in the warning color. */
export function isCpuWarning(cpuPercent: number | null): boolean {
  return cpuPercent !== null && cpuPercent >= CPU_WARNING_PERCENT;
}

const CPU_ONLY: ReadonlyArray<ResourceMetric> = ["cpu"];

/**
 * The resource readings, as one hook every surface drawing them asks: the
 * status bar segment and the reading buttons (`ResourceMonitorPopover`), so
 * the two never derive "why is there no number" twice. Every source under it
 * is a store or context read, so a second caller pays nothing for it.
 *
 * The views plus the number behind the CPU one, which is what the warning color
 * is decided from: the view carries only the formatted string, and a rule
 * parsed back out of `"92%"` would break with the format.
 *
 * `compact` replaces the Metrics selection with CPU alone: a Compact reading is
 * the CPU icon and its percent whatever Metrics says, so the selection is not
 * consulted at all. `cpuPercent` is `null` in the sample shell, whose numbers
 * are specimens and never a warning.
 */
export function useStatusBarResourceMetrics(input: {
  /** The watched host, for the "too old to stream" verdict and its copy. */
  readonly hostId: string | null;
  readonly hostLabel: string;
  /**
   * Whether that host was PICKED rather than followed - the burden of proof the
   * projection has to meet before its numbers may be printed under this host's
   * name. See `attributedProjection`.
   */
  readonly hasExplicitPick: boolean;
  readonly compact: boolean;
}): {
  readonly views: ReadonlyArray<StatusBarResourceMetricView>;
  readonly cpuPercent: number | null;
} {
  const selected = shownResourceMetrics(useRegionValues("resourceMonitor"));
  const metrics = input.compact ? CPU_ONLY : selected;
  // Raw, and handed over raw: `statusBarResourceMetricViews` attributes it to
  // the watched host before reading a number out of it. The registry publishes
  // one projection for the window, which is not necessarily the watched host's.
  const projection = useGlobalResourceProjection();
  // Answered against this subtree's stream binding.
  const globalStreamUnsupported = useGlobalResourcesUnsupported(input.hostId);
  const sample = useSampleScene();
  const views = statusBarResourceMetricViews({
    metrics,
    projection,
    watchedHostId: input.hostId,
    hasExplicitPick: input.hasExplicitPick,
    globalStreamUnsupported,
    hostLabel: input.hostLabel,
  });
  // The sample shell prints sample readings, never the host's own (C12).
  if (sample) {
    return {
      views: views.map((view) => ({
        ...view,
        value: SAMPLE_RESOURCE_VALUES[view.metric],
        unavailableReason: null,
      })),
      cpuPercent: null,
    };
  }
  const reading = statusBarResourceReading(
    attributedProjection({
      scopeHostId: input.hostId,
      hasExplicitPick: input.hasExplicitPick,
      streamed: projection,
    }),
  );
  return { views, cpuPercent: reading.cpuPercent };
}
