import { useDesktopAppResourceUsage } from "@/hooks/resources/use-desktop-app-resource-usage";
import { useGlobalResourcesUnsupported } from "@/hooks/resources/use-global-resources-unsupported";
import {
  statusBarResourceMetricViews,
  type StatusBarResourceMetricView,
} from "@/lib/resources/status-bar-resource-reading";
import { useGlobalResourceProjection } from "@/stores/resources/resources-registry";
import {
  useLayoutStore,
  type ResourceMetric,
} from "@/stores/settings/layout-store";
import type { StatusBarDensity } from "@/components/layout/status-bar/status-bar-density";

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
 * Every source under it is a store or context read except
 * `useDesktopAppResourceUsage`, which subscribes to a shared, refcounted
 * sampler - so a second caller costs no extra IPC.
 */
export function useStatusBarResourceMetricViews(input: {
  readonly density: StatusBarDensity;
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
  const scope = useLayoutStore((state) => state.statusBar.resources.scope);
  const metrics = useLayoutStore((state) => state.statusBar.resources.metrics);
  // Raw, and handed over raw: `statusBarResourceMetricViews` attributes it to
  // the watched host before reading a number out of it. The registry publishes
  // one projection for the window, which is not necessarily the watched host's.
  const projection = useGlobalResourceProjection();
  // Only the desktop-app scope reads this, and subscribing is what starts a
  // once-a-second IPC poll of the shell. The strip is on screen for the life of
  // the window, so asking for it under the default host-tree scope would run
  // that poll all session for a number nothing renders.
  const desktopApp = useDesktopAppResourceUsage(scope === "desktop-app");
  // Asked unconditionally, and answered against this subtree's stream binding.
  // It is only ever CONSULTED for the host-tree scope (see the reason
  // resolver); the desktop-app scope reads a local IPC bridge and has no
  // stream to be incompatible with.
  const globalStreamUnsupported = useGlobalResourcesUnsupported(input.hostId);
  return statusBarResourceMetricViews({
    scope,
    metrics: visibleMetrics(metrics, input.density),
    projection,
    watchedHostId: input.hostId,
    hasExplicitPick: input.hasExplicitPick,
    desktopApp,
    globalStreamUnsupported,
    hostLabel: input.hostLabel,
  });
}

/**
 * `icon-only` keeps memory because it is the reading a glance is usually for,
 * and it is the one metric whose absence would make the segment read as broken
 * rather than as compact.
 *
 * A user who turned memory OFF keeps their first selected metric instead of an
 * empty segment: the density is the app narrowing its own chrome, and it has no
 * business emptying a control the user configured. `compact` drops labels, not
 * metrics, so it takes the selection whole.
 */
function visibleMetrics(
  metrics: ReadonlyArray<ResourceMetric>,
  density: StatusBarDensity,
): ReadonlyArray<ResourceMetric> {
  if (density !== "icon-only") return metrics;
  if (metrics.includes("memory")) return ["memory"];
  return metrics.slice(0, 1);
}
