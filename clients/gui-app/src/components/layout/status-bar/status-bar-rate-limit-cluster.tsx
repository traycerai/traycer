import type { ReactNode } from "react";
import { PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import {
  useStatusBarContentOverflow,
  type StatusBarDensity,
} from "@/components/layout/status-bar/status-bar-density";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import { STATUS_BAR_MENU_EXEMPT_ATTRIBUTE } from "@/components/layout/status-bar/status-bar-visibility-menu";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { useAnyRateLimitQueueTargetFetching } from "@/hooks/rate-limits/use-rate-limit-queue-target-phase";
import {
  useStatusBarRateLimitSegments,
  type StatusBarRateLimitCluster as StatusBarRateLimitClusterModel,
  type StatusBarRateLimitMountTarget,
  type StatusBarRateLimitRefreshModel,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { providerDisplayName } from "@/lib/provider-ordering";
import { enqueueRateLimitFetchBatchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
import { cn } from "@/lib/utils";
import {
  useLayoutStore,
  type PercentMode,
} from "@/stores/settings/layout-store";

/**
 * The strip's left cluster: every visible provider's usage, the one control
 * that refreshes them, and the trigger for the usage panel.
 *
 * Mounted only inside the bar's `scopedToOwnHost` gate and only while the
 * preference is on, so every query below is bound to the host the chip names.
 * Two things it deliberately does NOT own: the providers, resolved above it
 * because the right-click menu lists the same set and two resolutions could
 * name two different ones; and the panel itself, which outlives every state
 * that hides these segments and is therefore anchored by the strip.
 */
export function StatusBarRateLimitCluster(props: {
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly density: StatusBarDensity;
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  const percentMode = useLayoutStore(
    (state) => state.statusBar.rateLimits.percentMode,
  );
  const showTimer = useLayoutStore(
    (state) => state.statusBar.rateLimits.showTimer,
  );
  const showBar = useLayoutStore((state) => state.statusBar.rateLimits.showBar);
  const { cluster, mountTargets, refresh } = useStatusBarRateLimitSegments({
    providers: props.providers,
    profileSelection: props.profileSelection,
  });
  const measureClip = useStatusBarContentOverflow();

  // The same sentence twice on purpose: the button's accessible name, and -
  // when the strip runs out of room - the tooltip on the fade that gives back
  // what the clip took.
  const summary = triggerAccessibleName(cluster, percentMode);
  return (
    <>
      <PopoverTrigger asChild>
        <button
          ref={measureClip}
          type="button"
          // The button's own name, not the segments' - `aria-label` overrides
          // everything inside it, so the readings have to be IN the name or
          // they are not reachable at all. Kept to one reading per provider:
          // the whole window list is what the panel this opens is for.
          aria-label={summary}
          data-testid="status-bar-rate-limit-trigger"
          data-density={props.density}
          // The bar's own right-click menu stands down over a control that is
          // itself a way into the surface the menu summarises.
          {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
          className={cn(
            "group relative inline-flex h-6 min-w-0 items-center gap-2 overflow-hidden px-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            // A hard clip at the button's edge reads as a rendering fault; a
            // fade reads as "there is more", which is true and is what the
            // tooltip and the panel are for. Paint only - it cannot change
            // the width it was measured from.
            "data-[clipped=true]:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]",
            "data-[clipped=true]:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]",
          )}
        >
          {cluster.kind === "segments" ? (
            cluster.segments.map((segment) => (
              <StatusBarProviderSegment
                key={segment.providerId}
                segment={segment}
                density={props.density}
                percentMode={percentMode}
                showTimer={showTimer}
                showBar={showBar}
              />
            ))
          ) : (
            <span className="truncate">
              {cluster.kind === "no-providers"
                ? // The popover's own zero state says this at length; the
                  // strip says it once and opens that panel.
                  "Connect a supported provider to see usage here."
                : "Usage hidden"}
            </span>
          )}
          {/*
           The clipped summary hangs off the fade REGION, not off the
           button, and the two hover targets have to stay disjoint. Every
           segment inside this trigger carries its own tooltip naming the
           provider and why it is dimmed; a summary anchored to the whole
           button would open on top of one of those on almost every hover,
           two labels a few pixels apart answering one gesture. Anchoring
           it here means hovering a provider explains that provider and
           hovering the fade says what the fade is hiding.

           Deliberately invisible rather than an ellipsis glyph: it sits
           UNDER the mask, so anything drawn here would be faded out by the
           very gradient it is meant to explain. The fade is the visual
           affordance; this is only its hit area. Clicks fall through to
           the button and open the panel, which is the same answer at
           greater length.

           Always mounted, and hoverable only while the button says it is
           clipping - the measurement publishes a DOM attribute rather than
           React state, so CSS is what turns this on. With no clip there is
           nothing hidden to explain, and a live hit area here would swallow
           hovers meant for the segment underneath it.
          */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-hidden
                data-testid="status-bar-rate-limit-clip-affordance"
                className="pointer-events-none absolute inset-y-0 right-0 w-6 group-data-[clipped=true]:pointer-events-auto"
              />
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {summary}
            </TooltipContent>
          </Tooltip>
        </button>
      </PopoverTrigger>
      <StatusBarRateLimitRefresh
        refresh={refresh}
        // Nothing to refresh is not the same as a refresh that failed, so the
        // control stays visible and says why it is off.
        disabled={cluster.kind !== "segments"}
      />
      {mountTargets.map((target) => (
        <StatusBarProviderMountRefresh
          key={`${target.providerId}:${target.profileId ?? ""}`}
          target={target}
        />
      ))}
    </>
  );
}

/**
 * What a screen reader hears on the trigger: the strip's headline, then the
 * tightest reading for each provider it is showing.
 *
 * One reading per provider rather than every window, because this is a control
 * name and a name is read in full before anything else can happen. The tightest
 * window is the one the compact densities already choose to show for the same
 * reason - it is the number that decides whether the panel is worth opening.
 */
function triggerAccessibleName(
  cluster: StatusBarRateLimitClusterModel,
  percentMode: PercentMode,
): string {
  if (cluster.kind !== "segments") return "Usage limits";
  const readings = cluster.segments.flatMap((segment) =>
    segment.tightest === null
      ? []
      : [
          `${providerDisplayName(segment.providerId)} ${windowPercentText(
            segment.tightest.usedPercent,
            percentMode,
          )}`,
        ],
  );
  if (readings.length === 0) return "Usage limits";
  return `Usage limits: ${readings.join(", ")}`;
}

/**
 * The cluster's `↻`, fanning out over every provider it is showing.
 *
 * The queue lane goes out as ONE batch item rather than one per provider: a
 * batch fans its targets out together before the next queue item begins, which
 * is what makes "refresh everything on this strip" a single wait instead of a
 * serial walk. The http lane refetches its own observers, which are the only
 * enabled ones in the cluster.
 */
function StatusBarRateLimitRefresh(props: {
  readonly refresh: StatusBarRateLimitRefreshModel;
  readonly disabled: boolean;
}): ReactNode {
  const queueScope = useRateLimitQueueScope();
  const queueFetching = useAnyRateLimitQueueTargetFetching(
    props.refresh.queueTargets,
  );
  const hasTarget =
    props.refresh.queueTargets.length > 0 ||
    props.refresh.httpRefetches.length > 0;
  // Fire-and-forget, exactly as the popover's Refresh all is: the spinner is
  // driven by the queue phase and the observers' own fetching state, not by
  // awaiting work whose whole point is that it is serialized elsewhere.
  const refreshAll = (): Promise<void> => {
    void enqueueRateLimitFetchBatchForScope(
      queueScope,
      props.refresh.queueTargets.map((target) => ({
        providerId: target.providerId,
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: target.profileId,
      })),
      { force: true },
    );
    props.refresh.httpRefetches.forEach((refetch) => {
      void refetch();
    });
    return Promise.resolve();
  };
  return (
    <RefreshIconButton
      onRefresh={refreshAll}
      label="Refresh usage"
      refreshing={queueFetching || props.refresh.httpFetching}
      disabledReason={
        props.disabled || !hasTarget ? "nothing to refresh" : undefined
      }
      className="size-5 rounded-md"
    />
  );
}

/**
 * One provider's cold-start pull, routed through the serial queue.
 *
 * Its own component so the hook count stays fixed while the provider list
 * changes. This is the only fetch the cluster initiates for the queue lane, and
 * it is deliberate: those observers are disabled by lane, so without it a strip
 * watching a host the app-shell queue is not bound to would sit cold forever.
 * `refetch: null` keeps it on the queue path — a direct refetch is the exact
 * subprocess race the lane's disabled observer exists to prevent.
 */
function StatusBarProviderMountRefresh(props: {
  readonly target: StatusBarRateLimitMountTarget;
}): ReactNode {
  useRefreshProviderRateLimitsOnMount({
    providerId: props.target.providerId,
    profileId: props.target.profileId,
    usageUpdatedAt: props.target.usageUpdatedAt,
    hasCachedValue: props.target.hasCachedValue,
    fetchEligible: true,
    refetch: null,
  });
  return null;
}
