import { Fragment, type ComponentPropsWithoutRef, type Ref } from "react";
import { Cpu } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useDesktopAppResourceUsage } from "@/hooks/resources/use-desktop-app-resource-usage";
import { useGlobalResourcesUnsupported } from "@/hooks/resources/use-global-resources-unsupported";
import { UNAVAILABLE_DASH } from "@/lib/resources/memory-metric";
import {
  statusBarResourceMetricViews,
  type StatusBarResourceMetricView,
} from "@/lib/resources/status-bar-resource-reading";
import { cn } from "@/lib/utils";
import { useGlobalResourceProjection } from "@/stores/resources/resources-registry";
import {
  useLayoutStore,
  type ResourceMetric,
} from "@/stores/settings/layout-store";
import type { StatusBarDensity } from "@/components/layout/status-bar/status-bar-density";

interface StatusBarResourceSegmentProps extends ComponentPropsWithoutRef<"button"> {
  readonly density: StatusBarDensity;
  /** The watched host, for the "too old to stream" verdict and its copy. */
  readonly hostId: string | null;
  readonly hostLabel: string;
  /**
   * Whether that host was PICKED rather than followed — the burden of proof the
   * projection has to meet before its numbers may be printed under this host's
   * name. See `attributedProjection`.
   */
  readonly hasExplicitPick: boolean;
  /**
   * Radix injects this through `PopoverTrigger asChild`. Declared for the same
   * reason `EpicsFilterTrigger` declares it: the slot hands the trigger's ref
   * and handlers to this component, and they have to reach the real `<button>`.
   */
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * The strip's right-hand readout, and the resource monitor's trigger.
 *
 * It renders no popover of its own: `ResourceMonitorPopover` owns the single
 * always-mounted `resources.subscribe` stream, and mounting that popover CLOSED
 * around this segment is exactly what keeps these numbers live without anybody
 * opening anything. So this is a trigger, never a second reader.
 */
export function StatusBarResourceSegment(props: StatusBarResourceSegmentProps) {
  const {
    density,
    hostId,
    hostLabel,
    hasExplicitPick,
    className,
    ...buttonProps
  } = props;
  const scope = useLayoutStore((state) => state.statusBar.resources.scope);
  const metrics = useLayoutStore((state) => state.statusBar.resources.metrics);
  // Raw, and handed over raw: `statusBarResourceMetricViews` attributes it to
  // the watched host before reading a number out of it. The registry publishes
  // one projection for the window, which is not necessarily this chip's host.
  const projection = useGlobalResourceProjection();
  const desktopApp = useDesktopAppResourceUsage();
  // Asked unconditionally, and answered against this subtree's stream binding
  // — which the bar re-provided for the watched host. It is only ever CONSULTED
  // for the host-tree scope (see the reason resolver); the desktop-app scope
  // reads a local IPC bridge and has no stream to be incompatible with.
  const globalStreamUnsupported = useGlobalResourcesUnsupported(hostId);
  const views = statusBarResourceMetricViews({
    scope,
    metrics: visibleMetrics(metrics, density),
    projection,
    watchedHostId: hostId,
    hasExplicitPick,
    desktopApp,
    globalStreamUnsupported,
    hostLabel,
  });
  const icon = <Cpu className="size-3 shrink-0" aria-hidden />;
  const noMetrics = views.length === 0;

  return (
    <button
      type="button"
      // An `aria-label` REPLACES the flattened contents in the accessible-name
      // computation, so a hidden sentence inside the button would never be
      // announced. In the empty state the readout is the only thing that could
      // have explained the glyph, and there is none — so the explanation has to
      // be the name itself.
      aria-label={noMetrics ? "Resources, no metrics selected" : "Resources"}
      data-testid="status-bar-resource-segment"
      data-density={density}
      {...buttonProps}
      className={cn(
        "inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 px-2 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      {noMetrics ? (
        // Every metric switched off is reachable from Settings, so it gets an
        // answer rather than a bare glyph: an icon alone is exactly what a
        // broken readout looks like, and the remedy — turn one back on — is not
        // guessable from it. The tooltip is the sighted half of that sentence;
        // the button's own name above is the other. The segment stays mounted
        // because it is also the resource panel's trigger, and the panel is
        // where the numbers still are.
        <TooltipWrapper
          label="No metrics selected"
          side="top"
          sideOffset={6}
          align={undefined}
        >
          <span
            className="inline-flex items-center"
            data-testid="status-bar-resource-no-metrics"
          >
            {icon}
          </span>
        </TooltipWrapper>
      ) : (
        <>
          {icon}
          {views.map((view, index) => (
            <Fragment key={view.metric}>
              {index === 0 ? null : (
                <span aria-hidden className="text-muted-foreground/60">
                  ·
                </span>
              )}
              <StatusBarMetric view={view} showLabel={density === "full"} />
            </Fragment>
          ))}
        </>
      )}
    </button>
  );
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

/**
 * `TooltipWrapper` degrades to a transparent `Slot` when its label is null, so
 * a metric with a number costs no tooltip machinery while an unavailable one
 * always carries its sentence — the dash alone cannot distinguish "no data
 * yet" from "not on this build" from "this host is too old".
 *
 * The dash is `aria-hidden` with a visually-hidden sentence beside it, the
 * repo's idiom (`MetricBlock`): an em dash is decoration, and a screen reader
 * left with it hears punctuation where a value should be.
 */
function StatusBarMetric(props: {
  readonly view: StatusBarResourceMetricView;
  readonly showLabel: boolean;
}) {
  const { view } = props;
  return (
    <TooltipWrapper
      label={view.unavailableReason}
      side="top"
      sideOffset={6}
      align={undefined}
    >
      <span
        className="inline-flex min-w-0 items-center gap-1"
        data-testid={`status-bar-resource-metric-${view.metric}`}
      >
        {props.showLabel ? (
          <span className="text-muted-foreground/80">{view.label}</span>
        ) : null}
        {view.value === null ? (
          <>
            <span aria-hidden="true">{UNAVAILABLE_DASH}</span>
            <span className="sr-only">{view.label}: unavailable</span>
          </>
        ) : (
          <span className="truncate">{view.value}</span>
        )}
      </span>
    </TooltipWrapper>
  );
}
