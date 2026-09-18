import { SAMPLE_USAGE_USED_PERCENT } from "@/components/sample-workspace/sample-workspace-scene";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { statusBarPreviewSample } from "@/components/sample-workspace/sample-rate-limit-readings";
import { useSampledNow } from "@/lib/relative-time";
import type { ReactNode } from "react";
import { PopoverTrigger } from "@/components/ui/popover";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import {
  STATUS_BAR_USAGE_CONTENT_CLASS,
  statusBarSegmentName,
  useStatusBarUsageDisplay,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { StatusBarUsageScroller } from "@/components/layout/status-bar/status-bar-usage-scroller";
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
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import {
  useRateLimitPopoverStore,
  type RateLimitPopoverRevealTarget,
} from "@/stores/rate-limits/rate-limit-popover-store";
import { enqueueRateLimitFetchBatchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
import type { PercentMode } from "@/stores/settings/layout-store";

/**
 * The strip's left cluster: every visible provider's usage, the one control
 * that refreshes them, and the trigger for the usage panel.
 *
 * It draws everything that is switched on, at every width. Which accounts
 * appear and how much each reading says are both the user's choices - the
 * panel's per-account switches, the Layout page's display switches - and a
 * strip that quietly hid one of them to fit a window would be overriding a
 * choice it was asked to show. So when the readings outgrow the strip they
 * SCROLL (`StatusBarUsageScroller`), with a fade on whichever edge hides
 * something, and the trigger keeps its natural width inside that scroller.
 *
 * Mounted only inside the bar's `scopedToOwnHost` gate and only while the
 * preference is on, so every query below is bound to the host the strip watches.
 * Two things it deliberately does NOT own: the providers, resolved above it
 * because the right-click menu lists the same set and two resolutions could
 * name two different ones; and the panel itself, which outlives every state
 * that hides these segments and is therefore anchored by the strip.
 */
export function StatusBarRateLimitCluster(props: {
  /** The watched host, whose readings these are. */
  readonly hostId: string | null;
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly profileSelection: RateLimitProfileSelection;
  /** Whether a Customize session is live - hidden providers stay clickable. */
  readonly editing: boolean;
}): ReactNode {
  const display = useStatusBarUsageDisplay();
  const sampleCold = useSampleScene();
  const now = useSampledNow();
  const requestRevealProfile = useRateLimitPopoverStore(
    (state) => state.requestRevealProfile,
  );
  const { cluster, mountTargets, refresh } = useStatusBarRateLimitSegments({
    providers: props.providers,
    profileSelection: props.profileSelection,
    // The strip is the surface that OWNS the fetching for these keys: the http
    // lane polls here, the queue lane takes its cold start here, and the `↻`
    // below fans out from here. Every other reader observes what this one wrote.
    mode: "live",
    editing: props.editing,
  });

  const sample = sampleCold ? statusBarPreviewSample(cluster, now) : null;
  const displayed = sample?.cluster ?? cluster;
  return (
    <>
      {/*
        The scroller is a wrapper around the trigger rather than the trigger
        itself, for two reasons. A `<button>` is not a reliable scroll
        container - WebKit and Firefox do not scroll one - so the box that
        scrolls has to be a plain element. And the trigger has to keep hugging
        its readings: its hover fill and focus ring are the strip's only
        affordance saying the usage panel is one click away, and a button
        stretched across the empty half of the bar would light up nowhere near
        the thing it opens.
      */}
      <StatusBarUsageScroller
        hostId={props.hostId}
        cluster={displayed}
        testId="status-bar-rate-limit-scroller"
      >
        <StatusBarUsageTrigger
          cluster={displayed}
          sampleLabel={
            sample !== null || (sampleCold && cluster.kind === "no-providers")
          }
          display={display}
          onRevealProfile={requestRevealProfile}
        />
      </StatusBarUsageScroller>
      {/*
        After the scroller rather than inside it, so the strip reads
        `<readings> ↻ ————— <resources>` and the control that refreshes these
        numbers never scrolls away with them. Nothing here grows, so the
        scroller takes the room and this stays pinned beside its right edge.
        The `pl-1` is the gap between the two.
      */}
      <span className="flex shrink-0 items-center pl-1">
        <StatusBarRateLimitRefresh
          refresh={refresh}
          // Nothing to refresh is not the same as a refresh that failed, so
          // the control stays visible and says why it is off.
          disabled={cluster.kind !== "segments"}
        />
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
 * The usage panel's trigger, wearing the readings.
 *
 * Its own component, taking what it draws as props, because it is the one
 * piece of the cluster a layout check has to render on its own: whether the
 * scroller overflows at a given width, and where the fade lands, is a fact
 * about THIS button at its natural width inside the scroller - and the hooks
 * the cluster resolves its readings through cannot run without a host.
 *
 * It must sit inside a `Popover`: `PopoverTrigger` throws outside one.
 */
export function StatusBarUsageTrigger(props: {
  readonly sampleLabel?: boolean;
  readonly cluster: StatusBarRateLimitClusterModel;
  readonly display: StatusBarUsageDisplay;
  readonly onRevealProfile: (target: RateLimitPopoverRevealTarget) => void;
}): ReactNode {
  const { cluster, display } = props;
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        // The button's own name, not the segments' - `aria-label` overrides
        // everything inside it, so the readings have to be IN the name or
        // they are not reachable at all. Kept to one reading per segment:
        // the whole window list is what the panel this opens is for, and
        // a segment scrolled out of view is still in the name.
        aria-label={
          props.sampleLabel && cluster.kind === "no-providers"
            ? `Sample usage · ${SAMPLE_USAGE_USED_PERCENT}% used, ${100 - SAMPLE_USAGE_USED_PERCENT}% remaining`
            : `${props.sampleLabel ? "Sample readings · " : ""}${triggerAccessibleName(cluster, display.percentMode)}`
        }
        data-testid="status-bar-rate-limit-trigger"
        // The bar's own right-click menu stands down over a control that is
        // itself a way into the surface the menu summarises.
        {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
        // A click ON a segment is a deep link to that account's card; the
        // panel still opens through the trigger's own toggle, this only
        // arms which card it opens on. A click beside the segments, or
        // the keyboard, opens the panel where it was.
        onClick={(event) => {
          const target = statusBarSegmentAtClick(event.target);
          if (target !== null) props.onRevealProfile(target);
        }}
        // Natural width and no overflow rule of its own: the scroller
        // around it is the box that clips, and a trigger that clipped or
        // shrank would hide readings the scroller exists to reach. No
        // padding either - the readings inside carry it, so the hover
        // fill and focus ring end where the last reading does.
        className="inline-flex h-6 shrink-0 items-center text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span
          data-testid="status-bar-rate-limit-content"
          className={STATUS_BAR_USAGE_CONTENT_CLASS}
        >
          {props.sampleLabel ? (
            <span className="text-ui-xs">Sample</span>
          ) : null}
          {props.sampleLabel && cluster.kind === "no-providers" ? (
            <span>
              Usage ·{" "}
              {display.percentMode === "remaining"
                ? `${100 - SAMPLE_USAGE_USED_PERCENT}% left`
                : `${SAMPLE_USAGE_USED_PERCENT}% used`}
            </span>
          ) : (
            <StatusBarUsageReadings
              cluster={cluster}
              display={display}
              interactive
            />
          )}
        </span>
      </button>
    </PopoverTrigger>
  );
}

/**
 * The account segment a click on the trigger landed in, if any. Read from the
 * segment's own `data-*` naming rather than from a handler on the segment,
 * because the segment is a `span` inside a button: the button is the control,
 * and the segment saying what it is lets the control answer for it.
 */
function statusBarSegmentAtClick(
  target: EventTarget,
): RateLimitPopoverRevealTarget | null {
  if (!(target instanceof Element)) return null;
  const segment = target.closest("[data-provider-id]");
  if (segment === null) return null;
  const providerId = rateLimitCapableProviderIdSchema.safeParse(
    segment.getAttribute("data-provider-id"),
  );
  if (!providerId.success) return null;
  const profileId = segment.getAttribute("data-profile-id") ?? "";
  return {
    providerId: providerId.data,
    profileId: profileId === "" ? null : profileId,
  };
}

/**
 * What a screen reader hears on the trigger: the strip's headline, then the
 * tightest reading for each segment it is showing - named by provider, and by
 * account too where the provider has more than one.
 *
 * One reading per segment rather than every window, because this is a control
 * name and a name is read in full before anything else can happen. The tightest
 * window is the one the segment model selects by default for the same reason -
 * it is the number that decides whether the panel is worth opening. Every
 * segment is in the name whether or not it is currently scrolled into view:
 * what a screen reader hears cannot depend on where the strip is scrolled to.
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
          `${statusBarSegmentName(segment)} ${windowPercentText(
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
