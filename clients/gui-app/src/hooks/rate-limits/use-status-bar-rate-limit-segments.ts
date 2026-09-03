import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import {
  classifyProviderRateLimitWindow,
  isProviderRateLimitWindowLive,
} from "@traycer/protocol/host/rate-limit";
import {
  useHostQueriesWithResponseMap,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";
import {
  providerRateLimitQueryOptions,
  type ProviderRateLimitTanstackOptions,
} from "@/hooks/host/provider-rate-limit-query-options";
import {
  PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS,
  useVisibleRateLimitProviders,
  type ConfiguredRateLimitProvider,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import {
  resolveRateLimitProfileId,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { sortProviderStatesByProviderOrder } from "@/lib/provider-ordering";
import {
  isRateLimitProfileFetchEligible,
  type RateLimitFetchLane,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import {
  envelopeDegradedReason,
  mapResponseToProviderRateLimitEnvelope,
  resolveRetainedProviderRateLimits,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  isWindowedRateLimitProvider,
  providerWindowEntries,
  type RateLimitWindowKind,
} from "@/lib/rate-limits/rate-limit-window-catalog";
import type { RateLimitWindowSeverity } from "@/lib/rate-limits/window-severity";
import { useSampledNow } from "@/lib/relative-time";
import { useLayoutStore } from "@/stores/settings/layout-store";

/**
 * The status bar's left cluster, from the watched host's provider inventory to
 * the exact windows each segment draws.
 *
 * Generalises `useHeaderRateLimitBars`: every windowed provider rather than two,
 * every window the catalog reports rather than a fixed pair, and the layout
 * store's two deny-lists applied on top. Everything about a provider that is
 * NOT a display preference (which profile is read, whether that profile may
 * fetch, which lane it fetches on) is resolved exactly as the header hook and
 * the popover resolve it, so the three surfaces cannot disagree about what they
 * are describing.
 */

/**
 * What a segment is currently able to say.
 *
 * - `cold`: nothing has ever arrived for this provider. Neutral track, never a
 *   spinner - the reading is not loading, it simply has not been taken.
 * - `unavailable`: the provider answered and the answer was not a reading
 *   (`cli_not_found`, `rate_limits_not_available`, ...). Usually authoritative
 *   about the account, but a FIRST read that merely timed out lands here too -
 *   there is no retained reading for it to be shown beside, and a dash is the
 *   honest rendering either way. The tooltip names which it was.
 * - `degraded`: the latest attempt failed transiently and a last-known-good
 *   reading is being shown in its place.
 * - `live`: the reading is the latest one.
 */
export type StatusBarProviderSegmentState =
  | "cold"
  | "unavailable"
  | "degraded"
  | "live";

export interface StatusBarRateLimitWindow {
  readonly windowKey: string;
  /** The catalog's static name, for when no countdown is being shown. */
  readonly label: string;
  /**
   * Whether that name is only the window's length, and so may be replaced by a
   * live countdown rather than joined to one. The catalog decides it; see
   * `RateLimitWindowEntry.labelIsDuration` for why nothing downstream can.
   */
  readonly labelIsDuration: boolean;
  readonly kind: RateLimitWindowKind;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly severity: RateLimitWindowSeverity;
}

export interface StatusBarProviderSegmentModel {
  readonly providerId: RateLimitProviderId;
  readonly state: StatusBarProviderSegmentState;
  /**
   * Why this segment is degraded or unavailable, when the provider named a
   * reason. `null` for a live or cold segment, and also for a segment degraded
   * only because the query itself threw - that failure has no wire reason to
   * report and gets the generic sentence.
   */
  readonly reason: RateLimitUnavailableReason | null;
  /**
   * Visible, live windows in catalog order. A `degraded` segment carries the
   * retained reading's windows - dimming them is the whole point - while `cold`
   * and `unavailable` have none to carry.
   */
  readonly windows: ReadonlyArray<StatusBarRateLimitWindow>;
  /** The window this provider is judged by when there is room for only one. */
  readonly tightest: StatusBarRateLimitWindow | null;
}

/** One provider's cold-start trigger, for the queue-routed mount refresh. */
export interface StatusBarRateLimitMountTarget {
  readonly providerId: RateLimitProviderId;
  readonly profileId: string | null;
  readonly usageUpdatedAt: number | null;
  readonly hasCachedValue: boolean;
}

/** Everything the one `↻` needs to fan out over the cluster's providers. */
export interface StatusBarRateLimitRefreshModel {
  /** Eligible `ephemeralProcess` targets, refreshed as ONE queued batch. */
  readonly queueTargets: ReadonlyArray<{
    readonly providerId: RateLimitProviderId;
    readonly profileId: string | null;
  }>;
  /** Eligible `httpFetch` observers, refreshed through their own queries. */
  readonly httpRefetches: ReadonlyArray<() => Promise<unknown>>;
  /** Whether any of those http observers is fetching right now. */
  readonly httpFetching: boolean;
}

/**
 * The cluster as a whole. The three non-segment arms are distinct on purpose:
 * "no provider reports windows" and "you hid them all" have different remedies,
 * and a single empty state would send a user to Settings ▸ Providers to fix
 * something they did in Settings ▸ Layout.
 */
export type StatusBarRateLimitCluster =
  | { readonly kind: "no-providers" }
  | { readonly kind: "hidden" }
  | {
      readonly kind: "segments";
      readonly segments: ReadonlyArray<StatusBarProviderSegmentModel>;
    };

export interface StatusBarRateLimitSegments {
  readonly cluster: StatusBarRateLimitCluster;
  readonly mountTargets: ReadonlyArray<StatusBarRateLimitMountTarget>;
  readonly refresh: StatusBarRateLimitRefreshModel;
}

/**
 * The watched host's windowed providers, in `ORDERED_PROVIDERS` order.
 *
 * Split out from the segments below because it answers a question the bar has
 * to ask ABOVE the cluster: the right-click menu wraps the whole strip, and it
 * names providers rather than readings. Resolving it once here is what keeps
 * the menu's list and the segments beside it from ever naming different sets -
 * the same reason the bar resolves its host scope once and passes it down.
 *
 * Nothing here can fetch a reading: `useVisibleRateLimitProviders` observes the
 * usage cache with `PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS` (`enabled: false`) and
 * otherwise reads `providers.list`, which the app-shell queue already keeps
 * subscribed on this window's host.
 */
export function useStatusBarWindowedProviders(): ReadonlyArray<ConfiguredRateLimitProvider> {
  const visibleProviders = useVisibleRateLimitProviders();
  return sortProviderStatesByProviderOrder(
    visibleProviders.filter((provider) =>
      isWindowedRateLimitProvider(provider.providerId),
    ),
  );
}

interface StatusBarRateLimitTarget {
  readonly provider: ConfiguredRateLimitProvider;
  readonly profileId: string | null;
  readonly fetchEligible: boolean;
  readonly usageUpdatedAt: number | null;
  readonly lane: RateLimitFetchLane;
}

/**
 * Which profile this provider's segment describes, and whether that profile may
 * pull. Same resolution as `useHeaderRateLimitBars`: the focused chat's own
 * settings win for their harness, then per-harness memory, then ambient - and a
 * profile that resolved to nothing inherits the provider's ambient eligibility.
 */
function resolveTarget(
  provider: ConfiguredRateLimitProvider,
  profileSelection: RateLimitProfileSelection,
): StatusBarRateLimitTarget {
  const profileId = resolveRateLimitProfileId(
    profileSelection,
    provider.providerId,
    provider.profiles,
  );
  const selectedProfile = provider.profiles.find(
    (profile) =>
      (profile.kind === "ambient" ? null : profile.profileId) === profileId,
  );
  return {
    provider,
    profileId,
    fetchEligible:
      selectedProfile === undefined
        ? provider.fetchEligibility.ambient
        : isRateLimitProfileFetchEligible(
            provider.fetchEligibility,
            selectedProfile,
          ),
    usageUpdatedAt: selectedProfile?.usageUpdatedAt ?? null,
    // The provider's OWN lane, not a second call to the classifier. Re-deriving
    // it would make this the one place the batch split disagrees with the
    // inventory it was built from, and it would leave every test's `lane`
    // fixture dead input - green while proving nothing about the split.
    lane: provider.lane,
  };
}

/**
 * The options one batch of targets shares.
 *
 * `useHostQueriesWithResponseMap` applies ONE options object to every request in
 * its batch, and `providerRateLimitQueryOptions` answers a single question:
 * `lane === "httpFetch" && fetchEligible`. So there are only TWO option shapes,
 * and two batches would be enough to carry them.
 *
 * There are three anyway, and the extra split is deliberate. The two disabled
 * batches produce identical options but mean different things - one is a lane
 * that may never fetch here, the other a credential that cannot fetch anywhere -
 * and only the first is a queue lane. Keeping them apart is what lets
 * `mountTargets` be a plain index join over the queue batch rather than a filter
 * over a mixed one, and it is what makes the lane split legible at the call site
 * instead of an emergent property of an equality nobody restates.
 */
function batchOptions(
  targets: ReadonlyArray<StatusBarRateLimitTarget>,
): ProviderRateLimitTanstackOptions {
  const first = targets.at(0);
  if (first === undefined) return PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS;
  return providerRateLimitQueryOptions(
    first.provider.providerId,
    first.profileId,
    first.fetchEligible,
  ).options;
}

function requestsFor(
  targets: ReadonlyArray<StatusBarRateLimitTarget>,
): Array<HostRequestSpec<HostRpcRegistry, "host.getRateLimitUsage">> {
  return targets.map((target) => {
    const { method, params } = providerRateLimitQueryOptions(
      target.provider.providerId,
      target.profileId,
      target.fetchEligible,
    );
    return { method, params };
  });
}

/**
 * Whether `candidate` binds this provider harder than `incumbent` does: the
 * higher used percentage, then the sooner reset, then whichever the catalog
 * reported first.
 *
 * A window with no `resetsAt` loses that second comparison to one that has a
 * reset instant, rather than being treated as infinitely far away - "soonest"
 * is a question an unknown reset cannot answer, and preferring the window that
 * CAN answer it is what keeps the compact form informative.
 */
function isTighterWindow(
  candidate: StatusBarRateLimitWindow,
  incumbent: StatusBarRateLimitWindow,
): boolean {
  if (candidate.usedPercent !== incumbent.usedPercent) {
    return candidate.usedPercent > incumbent.usedPercent;
  }
  if (candidate.resetsAt === null) return false;
  if (incumbent.resetsAt === null) return true;
  return candidate.resetsAt < incumbent.resetsAt;
}

function tightestWindow(
  windows: ReadonlyArray<StatusBarRateLimitWindow>,
): StatusBarRateLimitWindow | null {
  return windows.reduce<StatusBarRateLimitWindow | null>(
    (tightest, window) =>
      tightest === null || isTighterWindow(window, tightest)
        ? window
        : tightest,
    null,
  );
}

function segmentState(
  rateLimits: ProviderRateLimits | null,
  envelope: ProviderRateLimitEnvelope | null,
  isError: boolean,
): {
  readonly state: StatusBarProviderSegmentState;
  readonly reason: RateLimitUnavailableReason | null;
} {
  if (rateLimits === null) return { state: "cold", reason: null };
  if (!rateLimits.available) {
    return { state: "unavailable", reason: rateLimits.reason };
  }
  const degradedReason = envelopeDegradedReason(envelope);
  if (degradedReason !== null) {
    return { state: "degraded", reason: degradedReason };
  }
  // A query that threw retains its data too, and the strip has to say so - but
  // a thrown fetch carries no wire reason, so the tooltip falls back to the
  // generic sentence rather than inventing one.
  if (isError) return { state: "degraded", reason: null };
  return { state: "live", reason: null };
}

function visibleWindows(
  rateLimits: ProviderRateLimits | null,
  hiddenWindowKeys: ReadonlyArray<string>,
  now: number,
): ReadonlyArray<StatusBarRateLimitWindow> {
  if (rateLimits === null) return [];
  return providerWindowEntries(rateLimits).flatMap((entry) => {
    if (hiddenWindowKeys.includes(entry.windowKey)) return [];
    // A window whose reset instant has passed describes a period that has
    // already rolled; printing its percentage would report spent usage as
    // current.
    if (!isProviderRateLimitWindowLive(entry.window, now)) return [];
    return [
      {
        windowKey: entry.windowKey,
        label: entry.label,
        labelIsDuration: entry.labelIsDuration,
        kind: entry.kind,
        usedPercent: entry.window.usedPercent,
        resetsAt: entry.window.resetsAt,
        severity: classifyProviderRateLimitWindow(entry.window),
      },
    ];
  });
}

/** Whether a segment has anything to draw beyond an icon nobody can read. */
function hasContent(segment: StatusBarProviderSegmentModel): boolean {
  return segment.windows.length > 0 || segment.state !== "live";
}

/**
 * One batch's targets folded together with that batch's results, which arrive
 * in the order the requests were passed.
 */
function toSegments(
  targets: ReadonlyArray<StatusBarRateLimitTarget>,
  queries: ReadonlyArray<
    UseQueryResult<ProviderRateLimitEnvelope, HostRpcError>
  >,
  hiddenWindowKeys: ReadonlyArray<string>,
  now: number,
): ReadonlyArray<StatusBarProviderSegmentModel> {
  return targets.map((target, index) => {
    const query = queries[index];
    const envelope = query.data ?? null;
    // The retained view - a fresh reading, or the last good one while a
    // transient failure is being ridden out. Resolved once and handed to both
    // halves, so the state a segment reports and the windows it draws can never
    // describe two different snapshots.
    const retained = resolveRetainedProviderRateLimits(envelope);
    const windows = visibleWindows(retained, hiddenWindowKeys, now);
    return {
      providerId: target.provider.providerId,
      ...segmentState(retained, envelope, query.isError),
      windows,
      tightest: tightestWindow(windows),
    };
  });
}

/**
 * Which of the three empty states applies, if any. A provider inventory that is
 * empty is the host's answer; segments that all dropped out of the draw are the
 * user's own deny-lists (or, rarely, every window having expired at once).
 */
function clusterFor(
  providerCount: number,
  segments: ReadonlyArray<StatusBarProviderSegmentModel>,
): StatusBarRateLimitCluster {
  if (providerCount === 0) return { kind: "no-providers" };
  if (segments.length === 0) return { kind: "hidden" };
  return { kind: "segments", segments };
}

/**
 * The cluster's render model, over the providers the bar resolved.
 *
 * **Two lanes, three batches, never one mixed batch.** `ephemeralProcess`
 * providers (codex, claude-code, grok) spawn a CLI subprocess to read usage, so
 * the serial queue owns every fetch of theirs and the observer here must stay
 * passive. `providerRateLimitQueryOptions` disables it by LANE, which is why the
 * ephemeral batch passes each target's real `fetchEligible` rather than a
 * hardcoded `false`: even an eligible ephemeral target observes. Passing
 * `options: null` instead would be the bug this shape exists to prevent -
 * `use-host-queries.ts` defaults a missing `enabled` to `true` and calls the
 * host directly, which for these providers means a subprocess spawned outside
 * the queue.
 *
 * The `httpFetch` lane splits once more, on eligibility, for the same
 * one-options-per-batch reason: an ineligible target sharing the polling batch's
 * options would inherit `enabled: true` and spend a round trip on a credential
 * the host does not have.
 */
export function useStatusBarRateLimitSegments(input: {
  readonly providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly profileSelection: RateLimitProfileSelection;
}): StatusBarRateLimitSegments {
  const client = useHostClient();
  const rateLimits = useLayoutStore((state) => state.statusBar.rateLimits);
  // The shared 60s clock, so a window that expires while the strip is on screen
  // drops out of it within the minute rather than at the next fetch.
  const now = useSampledNow();

  const targets = input.providers
    .filter(
      (provider) => !rateLimits.hiddenProviders.includes(provider.providerId),
    )
    .map((provider) => resolveTarget(provider, input.profileSelection));
  const queueObserved = targets.filter(
    (target) => target.lane === "ephemeralProcess",
  );
  const httpPolling = targets.filter(
    (target) => target.lane === "httpFetch" && target.fetchEligible,
  );
  const httpObserved = targets.filter(
    (target) => target.lane === "httpFetch" && !target.fetchEligible,
  );

  const queueObservedQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    requests: requestsFor(queueObserved),
    options: batchOptions(queueObserved),
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
  const httpPollingQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    requests: requestsFor(httpPolling),
    options: batchOptions(httpPolling),
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });
  const httpObservedQueries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    requests: requestsFor(httpObserved),
    options: batchOptions(httpObserved),
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });

  // Each batch is paired with its own results by index, then the three are put
  // back into catalog order - rather than the targets being looked up in
  // whichever batch happens to hold them, which is the same join written with a
  // fallback branch that can never run.
  const segments = sortProviderStatesByProviderOrder([
    ...toSegments(
      queueObserved,
      queueObservedQueries,
      rateLimits.hiddenWindowKeys,
      now,
    ),
    ...toSegments(
      httpPolling,
      httpPollingQueries,
      rateLimits.hiddenWindowKeys,
      now,
    ),
    ...toSegments(
      httpObserved,
      httpObservedQueries,
      rateLimits.hiddenWindowKeys,
      now,
    ),
  ]).filter(hasContent);

  return {
    cluster: clusterFor(input.providers.length, segments),
    // Only the queue lane: an `httpFetch` observer is enabled and fetches its
    // own cold start on mount, so routing it through the mount hook as well
    // would put two fetches on one key.
    mountTargets: queueObserved.flatMap((target, index) => {
      if (!target.fetchEligible) return [];
      const envelope = queueObservedQueries[index].data;
      return [
        {
          providerId: target.provider.providerId,
          profileId: target.profileId,
          usageUpdatedAt: target.usageUpdatedAt,
          hasCachedValue: envelope !== undefined && envelope.lastGood !== null,
        },
      ];
    }),
    refresh: {
      queueTargets: queueObserved.flatMap((target) =>
        target.fetchEligible
          ? [
              {
                providerId: target.provider.providerId,
                profileId: target.profileId,
              },
            ]
          : [],
      ),
      httpRefetches: httpPollingQueries.map((query) => query.refetch),
      httpFetching: httpPollingQueries.some((query) => query.isFetching),
    },
  };
}
