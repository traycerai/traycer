import { useDesktopAppResourceUsage } from "@/hooks/resources/use-desktop-app-resource-usage";
import { useGlobalResourcesUnsupported } from "@/hooks/resources/use-global-resources-unsupported";
import { getDesktopDiagnosticsBridge } from "@/lib/resources/desktop-app-resource-usage";
import {
  statusBarResourceMetricViews,
  type StatusBarResourceMetricView,
} from "@/lib/resources/status-bar-resource-reading";
import { useGlobalResourceProjection } from "@/stores/resources/resources-registry";
import { useLayoutStore } from "@/stores/settings/layout-store";

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
 * Every source under it is a store or context read except two, neither of which
 * a second caller pays twice for: `useDesktopAppResourceUsage` subscribes to a
 * shared, refcounted sampler, so a second caller costs no extra IPC, and
 * `getDesktopDiagnosticsBridge()` is a synchronous property read of the object
 * the preload injected.
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
  // Whether the SHELL is there, which the reading above cannot answer: it is
  // `null` for a browser build, for a first sample still in flight, and for a
  // rejected one alike, and only the first of those three is a build without a
  // desktop shell. Read at render rather than subscribed to because the bridge
  // is injected by the preload before the first paint and never appears or
  // leaves mid-session, so there is no change for a subscription to deliver.
  const desktopBridgePresent = getDesktopDiagnosticsBridge() !== null;
  // Asked unconditionally, and answered against this subtree's stream binding.
  // It is only ever CONSULTED for the host-tree scope (see the reason
  // resolver); the desktop-app scope reads a local IPC bridge and has no
  // stream to be incompatible with.
  const globalStreamUnsupported = useGlobalResourcesUnsupported(input.hostId);
  return statusBarResourceMetricViews({
    scope,
    metrics,
    projection,
    watchedHostId: input.hostId,
    hasExplicitPick: input.hasExplicitPick,
    desktopApp,
    desktopBridgePresent,
    globalStreamUnsupported,
    hostLabel: input.hostLabel,
  });
}
