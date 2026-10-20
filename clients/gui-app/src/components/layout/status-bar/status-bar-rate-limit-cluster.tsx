import { SAMPLE_USAGE_USED_PERCENT } from "@/components/sample-workspace/sample-workspace-scene";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { useEffect, useEffectEvent, type ReactNode } from "react";
import { PopoverTrigger } from "@/components/ui/popover";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { UsageGlyph } from "@/components/layout/header/rate-limit-icon";
import {
  statusBarClusterSegments,
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
  type StatusBarRateLimitHttpRefetch,
  type StatusBarRateLimitMountTarget,
  type StatusBarRateLimitRefreshModel,
  type StatusBarRateLimitRetryTarget,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import {
  useRateLimitPopoverStore,
  type RateLimitPopoverRevealTarget,
} from "@/stores/rate-limits/rate-limit-popover-store";
import { useRegionDensity } from "@/lib/layout-overrides";
import { resolveReadingDensity } from "@/lib/layout/reading-density";
import {
  collectProviderRateLimits,
  fetchProviderRateLimits,
  type ProviderRateLimitFetchScope,
} from "@/lib/rate-limits/provider-rate-limit-fetch";
import {
  manualRateLimitRetryWithheld,
  rateLimitAccountLedgerKey,
  recordManualRateLimitRetry,
  recordScheduledTransientRead,
} from "@/lib/rate-limits/rate-limit-read-ledger";
import { rateLimitFetchLane } from "@/lib/rate-limit-providers";
import { TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS } from "@/lib/rate-limits/rate-limit-timing";
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
  const fetchScope = useProviderRateLimitFetchScope();
  const { cluster, mountTargets, retryTargets, refresh } =
    useStatusBarRateLimitSegments({
      providers: props.providers,
      profileSelection: props.profileSelection,
      // The strip is the surface that OWNS the fetching for these keys: the
      // http lane polls here, the ephemeral lane takes its cold start here, and
      // the `↻` below fans out from here. Every other reader observes what this
      // one wrote.
      mode: "live",
      editing: props.editing,
      sample: sampleCold,
      // This strip is the one placement whose segment click reads again, and
      // `fetchScope` is the host it reads from - the same scope the `↻` below
      // forces against, so the bound a retry writes names the host the read
      // actually went to.
      retryHostId: fetchScope?.hostId ?? null,
    });
  // A person asking for one account's reading, from the segment that said it
  // could not load one. Forced, which is what tells the host this is not an
  // automatic caller: it passes the read floors that exist to keep automatic
  // callers off a penalized endpoint, and nothing else - the read still joins
  // one already in flight for this account and still waits for the provider's
  // usage-probe slot.
  //
  // The bound on asking is stamped when the read SETTLES, not when it starts:
  // a probe that fails after ninety seconds has to be bounded from its
  // failure, and until then the segment is already saying `Retrying...` and
  // offering nothing. A click while that read runs is coalesced onto it by
  // `fetchProviderRateLimits`' own registry, so a second one cannot overtake
  // the stamp either.
  const retryNow = (target: StatusBarRateLimitRetryTarget): void => {
    const hostId = fetchScope?.hostId ?? null;
    if (hostId === null) return;
    const key = rateLimitAccountLedgerKey(
      hostId,
      target.providerId,
      target.profileId,
    );
    // The bound is checked HERE, not only where the affordance was drawn: an
    // offer on screen is as old as the render that drew it, and a sibling
    // window's read can settle against this same account in between. This is
    // the gate; the affordance is an invitation.
    if (manualRateLimitRetryWithheld(key, Date.now())) return;
    void readOneAccount({
      fetchScope,
      httpRefetches: refresh.httpRefetches,
      target,
      force: true,
    }).then(() => {
      recordManualRateLimitRetry(key, Date.now());
    });
  };
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
          onRetry={retryNow}
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
      {fetchScope === null
        ? null
        : retryTargets.map((target) => (
            // Keyed by the HOST as well as the account: the strip can be
            // pointed at a different host while the same account is transient
            // on both, and a timer that outlived that move would fire a read
            // of the host it was started for against the scope of the one it
            // ended up on.
            <StatusBarTransientRetry
              key={`${fetchScope.hostId}:${target.providerId}:${target.profileId ?? ""}`}
              target={target}
              reading={statusBarSegmentIsReading(cluster, target)}
              httpRefetches={refresh.httpRefetches}
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
  /**
   * Read one account again, for the one state that offers it. Called only for a
   * segment whose model says `retryOffered`, so the affordance the words carry
   * and the click that honours it cannot come apart.
   */
  readonly onRetry: (target: StatusBarRateLimitRetryTarget) => void;
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
        //
        // A segment that is offering a retry also reads again on the way in.
        // The deep link is kept rather than replaced: the panel's own card is
        // where the reading lands, and a click that silently did something
        // else on one state would be a second meaning for the same gesture.
        // Mouse only, as the deep link above already is - the keyboard opens
        // the panel, whose per-account control is the retry there.
        onClick={(event) => {
          const target = statusBarSegmentAtClick(event.target);
          if (target === null) return;
          props.onRevealProfile(target);
          if (statusBarSegmentOffersRetry(cluster, target)) {
            props.onRetry(target);
          }
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
 * Whether the segment a click landed in is currently offering a retry.
 *
 * Read from the segment MODEL rather than from the DOM: the words, the
 * underline and this answer then all come from the one field
 * (`StatusBarProviderSegmentModel.retryOffered`), which is what keeps a click
 * from reading again while the segment says nothing about retrying.
 */
function statusBarSegmentOffersRetry(
  cluster: StatusBarRateLimitClusterModel,
  target: RateLimitPopoverRevealTarget,
): boolean {
  return statusBarClusterSegments(cluster).some(
    (segment) =>
      segment.retryOffered &&
      segment.providerId === target.providerId &&
      segment.profileId === target.profileId,
  );
}

/**
 * One account's read, on the lane that account's provider reads on.
 *
 * `ephemeralProcess` goes through `fetchProviderRateLimits`, the only way the
 * GUI reads that lane - a bare refetch there sends no `force` at all, which the
 * wire reads as forced. `httpFetch` refetches its own observer, the enabled one
 * in the cluster. The same split `useProviderRateLimitRefresh` makes for the
 * panel's per-account control, applied to a segment instead.
 *
 * `force` is the whole difference between this function's two callers: a
 * person's click passes the host's read floors, and the one automatic re-read
 * does not, leaving the host free to answer it from its gauge.
 */
function readOneAccount(args: {
  readonly fetchScope: ProviderRateLimitFetchScope | null;
  readonly httpRefetches: ReadonlyArray<StatusBarRateLimitHttpRefetch>;
  readonly target: StatusBarRateLimitRetryTarget;
  readonly force: boolean;
}): Promise<void> {
  const params = {
    providerId: args.target.providerId,
    accountContext: DEFAULT_ACCOUNT_CONTEXT,
    profileId: args.target.profileId,
  };
  if (rateLimitFetchLane(args.target.providerId) === "ephemeralProcess") {
    // Unforced reads go through `collectProviderRateLimits`, not
    // `fetchProviderRateLimits`: this renderer's own freshness guard would
    // answer the scheduled re-read of a transient failure from the cache
    // entry that failure wrote, and the host would never hear the question.
    return args.force
      ? fetchProviderRateLimits(args.fetchScope, params, { force: true })
      : collectProviderRateLimits(args.fetchScope, params);
  }
  const observer = args.httpRefetches.find(
    (candidate) =>
      candidate.providerId === args.target.providerId &&
      candidate.profileId === args.target.profileId,
  );
  if (observer === undefined) return Promise.resolve();
  return observer.refetch().then(() => undefined);
}

/**
 * One `transient` segment's single re-read.
 *
 * The state says a retry is coming, so one has to happen: the next automatic
 * attempt is otherwise the app-shell poll's, up to
 * `EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS` away. Exactly one per entry into the
 * state - this mounts when the segment becomes transient and unmounts when it
 * leaves, so a re-read that fails again leaves the segment as it was and the
 * poll owns the cadence from there.
 *
 * Its own component, like the mount pull above, so the hook count stays fixed
 * while the transient set changes.
 */
function StatusBarTransientRetry(props: {
  readonly target: StatusBarRateLimitRetryTarget;
  /** Whether a read of this account is in flight right now. */
  readonly reading: boolean;
  readonly httpRefetches: ReadonlyArray<StatusBarRateLimitHttpRefetch>;
}): ReactNode {
  const fetchScope = useProviderRateLimitFetchScope();
  const read = useEffectEvent((): void => {
    if (fetchScope === null) return;
    // Spent here, before anything else: the episode promised ONE scheduled
    // read, and the hook stops listing this account the moment it is spent, so
    // nothing re-arms a timer while the account keeps failing.
    recordScheduledTransientRead(
      rateLimitAccountLedgerKey(
        fetchScope.hostId,
        props.target.providerId,
        props.target.profileId,
      ),
    );
    // A read already in flight IS the retry the words promise, so this one
    // stands down rather than overtaking it. On the `httpFetch` lane it would
    // refetch that account's observer, and TanStack cancels the request in
    // flight - aborting a person's own forced read and starting it over.
    if (props.reading) return;
    void readOneAccount({
      fetchScope,
      httpRefetches: props.httpRefetches,
      target: props.target,
      force: false,
    });
  });
  // No dependencies: the caller keys this component by its account, so a
  // different account is a different instance with its own single timer, and
  // the episode's one-shot is not this component's to re-arm.
  useEffect(() => {
    const timer = window.setTimeout(read, TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}

/** Whether a read of this account is in flight, from the segment model. */
function statusBarSegmentIsReading(
  cluster: StatusBarRateLimitClusterModel,
  target: StatusBarRateLimitRetryTarget,
): boolean {
  return statusBarClusterSegments(cluster).some(
    (segment) =>
      segment.fetching &&
      segment.providerId === target.providerId &&
      segment.profileId === target.profileId,
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
    props.refresh.httpRefetches.forEach((entry) => {
      void entry.refetch();
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
