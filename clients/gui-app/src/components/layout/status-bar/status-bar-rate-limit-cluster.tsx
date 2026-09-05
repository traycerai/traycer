import type { ReactNode } from "react";
import { PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import type { StatusBarDensity } from "@/components/layout/status-bar/status-bar-density";
import {
  statusBarUsageDetailCeiling,
  statusBarUsageLadderLevels,
  useStatusBarUsageLadder,
} from "@/components/layout/status-bar/status-bar-usage-ladder";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import { STATUS_BAR_MENU_EXEMPT_ATTRIBUTE } from "@/components/layout/status-bar/status-bar-visibility-menu";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";
import { useAnyRateLimitQueueTargetFetching } from "@/hooks/rate-limits/use-rate-limit-queue-target-phase";
import {
  useStatusBarRateLimitSegments,
  type StatusBarProviderSegmentModel,
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

/** One empty list for the three cluster states that draw no segments. */
const NO_SEGMENTS: ReadonlyArray<StatusBarProviderSegmentModel> = [];

/**
 * The strip's left cluster: every visible provider's usage, the one control
 * that refreshes them, and the trigger for the usage panel.
 *
 * How much of each reading it draws is decided by measurement, not by width
 * alone: the ladder drops one kind of detail at a time until what it holds fits
 * the button it holds it in, and folds whole providers into a `+N` chip once
 * there is nothing left to drop. That replaces the fade this cluster used to
 * paint over its own overflow — a fade says there is more without giving any
 * of it back, and at a laptop width with a multi-window account there was a
 * great deal more.
 *
 * Mounted only inside the bar's `scopedToOwnHost` gate and only while the
 * preference is on, so every query below is bound to the host the strip watches.
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
  const showModeWord = useLayoutStore(
    (state) => state.statusBar.rateLimits.showModeWord,
  );
  const expandedProviders = useLayoutStore(
    (state) => state.statusBar.rateLimits.expandedProviders,
  );
  const { cluster, mountTargets, refresh } = useStatusBarRateLimitSegments({
    providers: props.providers,
    profileSelection: props.profileSelection,
  });
  const segments = cluster.kind === "segments" ? cluster.segments : NO_SEGMENTS;
  const { stop, roomRef, reservedRef, contentRef } = useStatusBarUsageLadder({
    ceiling: statusBarUsageDetailCeiling(props.density),
    levels: statusBarUsageLadderLevels({ showModeWord, showBar, showTimer }),
    segmentCount: segments.length,
    // The three cluster states below draw one sentence that no rung changes.
    // Measuring them would record widths against steps that free nothing, and
    // those widths would then decide how the first frame of real segments is
    // drawn - a hide-all/unhide round trip repainting at `icon-only`.
    enabled: segments.length > 0,
  });
  const shownCount = segments.length - stop.foldedCount;

  return (
    <>
      {/*
        The box that holds the ROOM, and the only one in this cluster that
        stretches - the ladder's hysteresis records its width, and a
        shrink-to-fit box would report its own content instead the moment that
        content fits, which is a ladder that can only ever go down. It is a
        wrapper rather than the trigger itself because the trigger has to keep
        hugging its readings: its hover fill and focus ring are the strip's
        only affordance saying the usage panel is one click away, and a button
        stretched across the empty half of the bar would light up nowhere near
        the thing it opens.
      */}
      <span
        ref={roomRef}
        data-testid="status-bar-rate-limit-room"
        className="flex min-w-0 flex-1 items-center"
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            // The button's own name, not the segments' - `aria-label` overrides
            // everything inside it, so the readings have to be IN the name or
            // they are not reachable at all. Kept to one reading per provider:
            // the whole window list is what the panel this opens is for. It is
            // also the one thing the ladder never shortens - what a screen
            // reader hears cannot depend on how wide the window is.
            aria-label={triggerAccessibleName(cluster, percentMode)}
            data-testid="status-bar-rate-limit-trigger"
            data-density={props.density}
            data-usage-detail={stop.detail}
            // The bar's own right-click menu stands down over a control that is
            // itself a way into the surface the menu summarises.
            {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
            // No padding of its own: the readings inside carry it, so the
            // natural width the ladder measures is the width this button would
            // need - hover fill and focus ring included - rather than that
            // number minus a gutter it would then clip anyway.
            className="inline-flex h-6 min-w-0 items-center overflow-hidden text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {/*
              The readings at their NATURAL width, which is the other half of
              the measurement: `shrink-0` is what makes `scrollWidth` here the
              width the cluster wants rather than the width it was given, and
              the room span above reports the width it was given. It is also the
              box worth observing for change - a countdown ticking from
              `4h 15m` to `4h` moves this and nothing else.

              Not `shrink-0` when there are no segments, and that is the same
              decision as the ladder being off in that state: with nothing to
              measure, the one sentence below should behave like ordinary text
              in a box too small for it and ellipsize, which `truncate` can only
              do inside a parent that is allowed to squeeze it.
            */}
            <span
              ref={contentRef}
              data-testid="status-bar-rate-limit-content"
              className={cn(
                "inline-flex items-center gap-2 px-1.5",
                cluster.kind === "segments" ? "shrink-0" : "min-w-0",
              )}
            >
              {cluster.kind === "segments" ? (
                <>
                  {segments.slice(0, shownCount).map((segment) => (
                    <StatusBarProviderSegment
                      key={segment.providerId}
                      segment={segment}
                      detail={stop.detail}
                      expanded={expandedProviders.includes(segment.providerId)}
                      percentMode={percentMode}
                      showModeWord={showModeWord}
                      showTimer={showTimer}
                      showBar={showBar}
                    />
                  ))}
                  {stop.foldedCount === 0 ? null : (
                    <FoldedProvidersChip
                      segments={segments.slice(shownCount)}
                      percentMode={percentMode}
                    />
                  )}
                </>
              ) : (
                <span className="truncate">
                  {cluster.kind === "no-providers"
                    ? // The popover's own zero state says this at length; the
                      // strip says it once and opens that panel.
                      "Connect a supported provider to see usage here."
                    : "Usage hidden"}
                </span>
              )}
            </span>
          </button>
        </PopoverTrigger>
        {/*
          Inside the room and after the trigger, so the strip reads
          `<readings> ↻ ————— <resources>` rather than parking the control
          that refreshes these numbers a screen away from them, against the
          resource readout. Nothing here grows, so the room's spare width
          collects to the right of both, which is where the strip wants it.

          Its own box because that box is what the ladder SUBTRACTS: the
          readings may only have the room this control leaves. The `pl-1` is
          the gap between the two - carried here rather than as the room's
          `gap`, so the width being subtracted is the whole of what the
          control occupies and no separate constant has to be kept in step
          with a class it cannot see.
        */}
        <span
          ref={reservedRef}
          data-testid="status-bar-rate-limit-reserved"
          className="flex shrink-0 items-center pl-1"
        >
          <StatusBarRateLimitRefresh
            refresh={refresh}
            // Nothing to refresh is not the same as a refresh that failed, so
            // the control stays visible and says why it is off.
            disabled={cluster.kind !== "segments"}
          />
        </span>
      </span>
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
 * The providers the strip ran out of room for, as one chip.
 *
 * Folding from the right rather than dropping: the last thing a strip should do
 * with a limit it cannot fit is pretend the provider is not configured. The
 * chip sits inside the trigger, so clicking it opens the panel that lists every
 * one of them in full — the tooltip is the glance, the panel is the answer.
 *
 * A provider with no reading yet is named without one. `+2` promising two
 * numbers and delivering one would be a worse chip than one that says which
 * providers are behind it.
 */
function FoldedProvidersChip(props: {
  readonly segments: ReadonlyArray<StatusBarProviderSegmentModel>;
  readonly percentMode: PercentMode;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="status-bar-folded-providers"
          className="shrink-0 rounded-[3px] border border-border/70 px-1 leading-none"
        >
          {`+${props.segments.length}`}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <span className="flex flex-col">
          {props.segments.map((segment) => (
            <span key={segment.providerId}>
              {providerReadingText(segment, props.percentMode)}
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** One provider and its tightest reading, or the provider alone when it has none. */
function providerReadingText(
  segment: StatusBarProviderSegmentModel,
  percentMode: PercentMode,
): string {
  const name = providerDisplayName(segment.providerId);
  if (segment.tightest === null) return name;
  return `${name} ${windowPercentText(segment.tightest.usedPercent, percentMode)}`;
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
