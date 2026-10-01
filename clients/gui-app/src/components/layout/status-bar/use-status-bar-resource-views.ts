import { useGlobalResourcesUnsupported } from "@/hooks/resources/use-global-resources-unsupported";
import {
  statusBarResourceMetricViews,
  type StatusBarResourceMetricView,
} from "@/lib/resources/status-bar-resource-reading";
import { useGlobalResourceProjection } from "@/stores/resources/resources-registry";
import { useRegionValues } from "@/lib/layout-overrides";
import { shownResourceMetrics } from "@/lib/layout/layout-values";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { SAMPLE_RESOURCE_VALUES } from "@/components/sample-workspace/sample-workspace-scene";

/**
 * The resource segment's readings, as a hook two surfaces can ask for.
 *
 * The segment draws them; the Settings preview needs the same list a second
 * time, because a preview frame is `inert` and a tooltip inside it can never
 * open - so the reason a dash has no number must be reachable OUTSIDE the
 * frame. Reading it from here rather than lifting it out of the segment keeps
 * the caption and the segment describing one computation: a second derivation
 * of "why is there no number" is exactly how a preview ends up disagreeing
 * with the thing it previews.
 *
 * Every source under it is a store or context read, so a second caller pays
 * nothing for it.
 */
export function useStatusBarResourceMetricViews(input: {
  /** The watched host, for the "too old to stream" verdict and its copy. */
  readonly hostId: string | null;
  readonly hostLabel: string;
  /**
   * Whether that host was PICKED rather than followed - the burden of proof the
   * projection has to meet before its numbers may be printed under this host's
   * name. See `attributedProjection`.
   */
  readonly hasExplicitPick: boolean;
}): ReadonlyArray<StatusBarResourceMetricView> {
  const metrics = shownResourceMetrics(useRegionValues("resourceMonitor"));
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
  if (!sample) return views;
  return views.map((view) => ({
    ...view,
    value: SAMPLE_RESOURCE_VALUES[view.metric],
    unavailableReason: null,
  }));
}
