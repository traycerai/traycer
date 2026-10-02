import { SAMPLE_USAGE_USED_PERCENT } from "@/components/sample-workspace/sample-workspace-scene";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import type { ReactNode } from "react";
import { PopoverTrigger } from "@/components/ui/popover";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { UsageGlyph } from "@/components/layout/header/rate-limit-icon";
import {
  STATUS_BAR_USAGE_CONTENT_CLASS,
  statusBarUsageTriggerName,
  useStatusBarUsageDisplay,
  type StatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { StatusBarUsageScroller } from "@/components/layout/status-bar/status-bar-usage-scroller";
import { STATUS_BAR_MENU_EXEMPT_ATTRIBUTE } from "@/components/layout/status-bar/status-bar-visibility-menu";
import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useProviderRateLimitFetchScope } from "@/hooks/rate-limits/use-provider-rate-limit-fetch-scope";
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
import { useRegionDensity } from "@/lib/layout-overrides";
import { resolveReadingDensity } from "@/lib/layout/reading-density";
import { fetchProviderRateLimits } from "@/lib/rate-limits/provider-rate-limit-fetch";
import { cn } from "@/lib/utils";

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
  const compact =
    resolveReadingDensity(useRegionDensity("usageLimits"), "status-bar") ===
    "compact";
  const sampleCold = useSampleScene();
  const requestRevealProfile = useRateLimitPopoverStore(
    (state) => state.requestRevealProfile,
  );
  const { cluster, mountTargets, refresh } = useStatusBarRateLimitSegments({
    providers: props.providers,
    profileSelection: props.profileSelection,
    // The strip is the surface that OWNS the fetching for these keys: the http
    // lane polls here, the ephemeral lane takes its cold start here, and the `↻`
    // below fans out from here. Every other reader observes what this one wrote.
    mode: "live",
    editing: props.editing,
    sample: sampleCold,
  });
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
        cluster={cluster}
        testId="status-bar-rate-limit-scroller"
      >
        <StatusBarUsageTrigger
          cluster={cluster}
          sampleLabel={sampleCold ? cluster.kind !== "hidden" : false}
          display={display}
          compact={compact}
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
      {/* The refresh affordance is not a customizable region, so it dims with
          the rest of the passive chrome while a layout session is live (4.2). */}
      <span data-layout-passive className="flex shrink-0 items-center pl-1">
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
  /** Density resolved to Compact: the glyph instead of the readings. */
  readonly compact: boolean;
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
            : `${props.sampleLabel ? "Sample readings · " : ""}${statusBarUsageTriggerName(cluster, display.percentMode)}`
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
        // On a phone it may shrink as far as the readings' own floor (see
        // the scroller), which is where the account names truncate.
        className="inline-flex h-6 shrink-0 items-center text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-md:shrink"
      >
        <span
          data-testid="status-bar-rate-limit-content"
          className={cn(STATUS_BAR_USAGE_CONTENT_CLASS, "max-md:shrink")}
        >
          {props.sampleLabel ? (
            <span className="text-ui-xs">Sample</span>
          ) : null}
          <UsageTriggerReadings
            cluster={cluster}
            display={display}
            sample={props.sampleLabel}
            compact={props.compact}
          />
        </span>
      </button>
    </PopoverTrigger>
  );
}

/**
 * What the trigger wears: the sample sentence while the sample scene has no
 * provider to draw, the glyph in Compact, otherwise the Detailed readings.
 */
function UsageTriggerReadings(props: {
  readonly cluster: StatusBarRateLimitClusterModel;
  readonly display: StatusBarUsageDisplay;
  readonly sample: boolean | undefined;
  readonly compact: boolean;
}): ReactNode {
  const { cluster, display } = props;
  if (props.sample && cluster.kind === "no-providers") {
    return (
      <span>
        Usage ·{" "}
        {display.percentMode === "remaining"
          ? `${100 - SAMPLE_USAGE_USED_PERCENT}% left`
          : `${SAMPLE_USAGE_USED_PERCENT}% used`}
      </span>
    );
  }
  // The same glyph the tab strip draws, unboxed at the bar's height. With no
  // provider it draws empty tracks and the panel it opens carries the setup
  // sentence; only the "hidden" state keeps its own words.
  if (props.compact && cluster.kind !== "hidden") {
    return <UsageGlyph cluster={cluster} />;
  }
  return <StatusBarUsageReadings cluster={cluster} display={display} />;
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
 * The cluster's `↻`, fanning out over every provider it is showing.
 *
 * The ephemeral lane goes out as one forced fetch per target, all at once: how
 * many of those probes run together is the host's call, not this control's.
 * The http lane refetches its own observers, which are the only enabled ones
 * in the cluster.
 */
function StatusBarRateLimitRefresh(props: {
  readonly refresh: StatusBarRateLimitRefreshModel;
  readonly disabled: boolean;
}): ReactNode {
  const fetchScope = useProviderRateLimitFetchScope();
  const hasTarget =
    props.refresh.ephemeralTargets.length > 0 ||
    props.refresh.httpRefetches.length > 0;
  // Fire-and-forget, exactly as the popover's Refresh all is: the spinner is
  // driven by the observers' own fetching state, not by awaiting a round whose
  // slowest target would hold every other one's spinner.
  const refreshAll = (): Promise<void> => {
    props.refresh.ephemeralTargets.forEach((target) => {
      void fetchProviderRateLimits(
        fetchScope,
        {
          providerId: target.providerId,
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          profileId: target.profileId,
        },
        { force: true },
      );
    });
    props.refresh.httpRefetches.forEach((refetch) => {
      void refetch();
    });
    return Promise.resolve();
  };
  return (
    <RefreshIconButton
      onRefresh={refreshAll}
      label="Refresh usage"
      refreshing={props.refresh.ephemeralFetching || props.refresh.httpFetching}
      disabledReason={
        props.disabled || !hasTarget ? "nothing to refresh" : undefined
      }
      className="size-5 rounded-md"
    />
  );
}

/**
 * One target's cold-start pull, through `fetchProviderRateLimits`.
 *
 * Exported for the tab strip's usage reading, which owns the fetching the
 * same way whenever the reading lives there instead (G6).
 *
 * Its own component so the hook count stays fixed while the provider list
 * changes. This is the only automatic fetch the cluster initiates for the
 * ephemeral lane, and it is deliberate: those observers are disabled by lane,
 * so without it a strip watching a host the app-shell poll does not cover
 * would sit cold forever. `refetch: null` keeps it on the fetch function - a
 * direct refetch would send no `force`, which the wire reads as forced, and
 * spawn a probe the host could have answered from its gauge.
 */
export function StatusBarProviderMountRefresh(props: {
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
