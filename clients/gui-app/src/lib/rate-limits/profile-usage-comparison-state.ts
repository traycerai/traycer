import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProviderRateLimits } from "@traycer/protocol/host/rate-limit";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";

/**
 * Per-profile comparison-state contract the model picker's profile selector consumes (T3): one shape combining a target host's cached rate-limit envelope with the cheap per-profile host summary (`rateLimitStatus`, `usageUpdatedAt`) into the states the Core.
 */

/**
 * `providerProfileRateLimitStatusSchema` narrowed to the two warning values - "ok"/"unknown" never produce a semantic-only reading (see `deriveProfileUsageDetailState`).
 */
export type ProfileUsageSemanticWarning = "near_limit" | "hard_limit";

export type ProfileUsageRefreshStatus = "idle" | "queued" | "refreshing";
type UnavailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: false }
>;

/**
 * Detail-cache classification for one profile, independent of refresh status: which state-treatment table row a consumer should render.
 */
export type ProfileUsageDetailState =
  | { readonly kind: "never-checked" }
  | {
      readonly kind: "semantic-only";
      readonly status: ProfileUsageSemanticWarning;
    }
  | {
      readonly kind: "fresh" | "stale";
      readonly usage: AvailableProviderRateLimits;
      readonly asOf: number;
    }
  | {
      readonly kind: "failed-with-last-good";
      readonly usage: AvailableProviderRateLimits;
      readonly asOf: number;
      readonly failedAt: number;
    }
  | {
      readonly kind: "unavailable";
      readonly usage: UnavailableProviderRateLimits;
    }
  | { readonly kind: "failed-no-last-good"; readonly failedAt: number | null };

export interface ProfileUsageHostSummary {
  readonly rateLimitStatus: "ok" | "near_limit" | "hard_limit" | "unknown";
  readonly usageUpdatedAt: number | null;
}

export interface ProfileUsageComparisonEntry {
  /** `profileCommitId(profile)` - `null` for the ambient profile. */
  readonly profileId: string | null;
  readonly providerId: ProviderId;
  readonly detail: ProfileUsageDetailState;
  /** Whether this exact target currently has usable credentials for a refresh. */
  readonly fetchEligible: boolean;
  readonly refreshStatus: ProfileUsageRefreshStatus;
  /** Addresses exactly this `(host, provider, profile)` - see
   *  `useProfileUsageComparison`'s doc comment for routing/serialization. */
  readonly refresh: () => Promise<void>;
  /**
   * Non-forced sibling of `refresh` for AUTOMATIC callers (the composer banner's single unknown-destination check).
   * On the queue-backed `ephemeralProcess` lane (claude-code / codex / grok - the providers with managed profiles, so the only ones this automatic check ever runs on) it passes `force: false`, so it no-ops on still-fresh cache and honors the.
   */
  readonly ensureFresh: () => Promise<void>;
}

function isSemanticWarning(
  status: ProfileUsageHostSummary["rateLimitStatus"],
): status is ProfileUsageSemanticWarning {
  return status === "near_limit" || status === "hard_limit";
}

function unavailableDetailState(
  envelope: ProviderRateLimitEnvelope | undefined,
): Extract<ProfileUsageDetailState, { kind: "unavailable" }> | null {
  if (envelope === undefined) return null;
  const latest = envelope.latest;
  if (latest === null || latest.available || envelope.lastGood !== null) {
    return null;
  }
  return { kind: "unavailable", usage: latest };
}

function queryFailureDetailState(
  envelope: ProviderRateLimitEnvelope | undefined,
  queryFailureAt: number | null,
  now: number,
): Extract<
  ProfileUsageDetailState,
  { kind: "failed-with-last-good" | "failed-no-last-good" }
> | null {
  if (queryFailureAt === null) return null;
  if (envelope?.lastGood !== null && envelope?.lastGood !== undefined) {
    return {
      kind: "failed-with-last-good",
      usage: envelope.lastGood,
      asOf: envelope.lastGoodAt ?? now,
      failedAt: queryFailureAt,
    };
  }
  return { kind: "failed-no-last-good", failedAt: queryFailureAt };
}

/**
 * Pure classifier: folds a target-host cache-only `ProviderRateLimitEnvelope` (`undefined` when this renderer's cache has never observed this exact `(host, provider, profile)` key) together with the cheap host summary into one detail state.
 */
export function deriveProfileUsageDetailState(
  envelope: ProviderRateLimitEnvelope | undefined,
  hostSummary: ProfileUsageHostSummary,
  queryFailureAt: number | null,
  now: number,
): ProfileUsageDetailState {
  const queryFailure = queryFailureDetailState(envelope, queryFailureAt, now);
  if (queryFailure !== null) return queryFailure;
  const unavailable = unavailableDetailState(envelope);
  if (unavailable !== null) return unavailable;
  if (envelope !== undefined && envelope.latest !== null) {
    if (envelope.lastGood !== null) {
      if (!envelope.latest.available) {
        // The envelope invariant guarantees `lastFailureAt` is set whenever a transient failure retained `lastGood` (see `buildProviderRateLimitEnvelope`) - the `?? now` fallback only satisfies the wider `number | null` field type.
        return {
          kind: "failed-with-last-good",
          usage: envelope.lastGood,
          asOf: envelope.lastGoodAt ?? now,
          failedAt: envelope.lastFailureAt ?? now,
        };
      }
      const asOf = envelope.lastGoodAt ?? now;
      const isStale = now - asOf >= PROVIDER_RATE_LIMITS_STALE_TIME_MS;
      return {
        kind: isStale ? "stale" : "fresh",
        usage: envelope.lastGood,
        asOf,
      };
    }
    return { kind: "never-checked" };
  }

  if (isSemanticWarning(hostSummary.rateLimitStatus)) {
    return { kind: "semantic-only", status: hostSummary.rateLimitStatus };
  }
  return { kind: "never-checked" };
}

/**
 * Pure classifier for the refresh axis, orthogonal to `detail`: whether THIS profile's own query key is actively fetching (`refreshing`), waiting its turn behind another entry in the shared serial queue (`queued` - only a concept for the `ephemeralProcess`.
 */
export function deriveProfileUsageRefreshStatus(args: {
  readonly isFetchingThisProfile: boolean;
  readonly queueDraining: boolean;
  readonly lane: "httpFetch" | "ephemeralProcess" | null;
}): ProfileUsageRefreshStatus {
  if (args.isFetchingThisProfile) return "refreshing";
  if (args.lane === "ephemeralProcess" && args.queueDraining) return "queued";
  return "idle";
}
