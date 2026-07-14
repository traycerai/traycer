import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";

/**
 * Per-profile comparison-state contract the model picker's profile selector
 * consumes (T3): one shape combining a target host's cached rate-limit
 * envelope with the cheap per-profile host summary (`rateLimitStatus`,
 * `usageUpdatedAt`) into the states the Core Flows state-treatment table
 * names, so no consumer re-derives this classification independently.
 */

/** `providerProfileRateLimitStatusSchema` narrowed to the two warning
 *  values - "ok"/"unknown" never produce a semantic-only reading (see
 *  `deriveProfileUsageDetailState`). */
export type ProfileUsageSemanticWarning = "near_limit" | "hard_limit";

export type ProfileUsageRefreshStatus = "idle" | "queued" | "refreshing";

/**
 * Detail-cache classification for one profile, independent of refresh
 * status: which state-treatment table row a consumer should render.
 *
 * - `never-checked`: no envelope in this renderer's cache, and the host
 *   summary reports no warning either - an empty, neutral track.
 * - `semantic-only`: no envelope in cache, but the host summary already
 *   knows the profile is running low or limited - an empty track tinted by
 *   `status`, never a fabricated percentage.
 * - `fresh` / `stale`: a retained `usage` reading exists and the current
 *   attempt (if any) is not itself a failure; `stale` once `asOf` is older
 *   than `PROVIDER_RATE_LIMITS_STALE_TIME_MS`.
 * - `failed-with-last-good`: the current attempt is a failure, but a prior
 *   `usage` reading is retained and dimmed alongside it.
 * - `failed-no-last-good`: the current attempt is a failure and no reading
 *   has ever been retained - nothing to show but the error/empty state.
 */
export type ProfileUsageDetailState =
  | { readonly kind: "never-checked" }
  | { readonly kind: "semantic-only"; readonly status: ProfileUsageSemanticWarning }
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
  readonly refreshStatus: ProfileUsageRefreshStatus;
  /** Addresses exactly this `(host, provider, profile)` - see
   *  `useProfileUsageComparison`'s doc comment for routing/serialization. */
  readonly refresh: () => Promise<void>;
}

function isSemanticWarning(
  status: ProfileUsageHostSummary["rateLimitStatus"],
): status is ProfileUsageSemanticWarning {
  return status === "near_limit" || status === "hard_limit";
}

/**
 * Pure classifier: folds a target-host cache-only `ProviderRateLimitEnvelope`
 * (`undefined` when this renderer's cache has never observed this exact
 * `(host, provider, profile)` key) together with the cheap host summary into
 * one detail state. Never fabricates a percentage - a warning with no
 * retained reading stays `semantic-only`, never a synthesized `fresh`/`stale`
 * fill.
 */
export function deriveProfileUsageDetailState(
  envelope: ProviderRateLimitEnvelope | undefined,
  hostSummary: ProfileUsageHostSummary,
  now: number,
): ProfileUsageDetailState {
  if (envelope !== undefined && envelope.latest !== null) {
    if (envelope.lastGood !== null) {
      if (!envelope.latest.available) {
        // The envelope invariant guarantees `lastFailureAt` is set whenever
        // a transient failure retained `lastGood` (see
        // `buildProviderRateLimitEnvelope`) - the `?? now` fallback only
        // satisfies the wider `number | null` field type.
        return {
          kind: "failed-with-last-good",
          usage: envelope.lastGood,
          asOf: envelope.lastGoodAt ?? now,
          failedAt: envelope.lastFailureAt ?? now,
        };
      }
      const asOf = envelope.lastGoodAt ?? now;
      const isStale = now - asOf >= PROVIDER_RATE_LIMITS_STALE_TIME_MS;
      return { kind: isStale ? "stale" : "fresh", usage: envelope.lastGood, asOf };
    }
    return { kind: "failed-no-last-good", failedAt: envelope.lastFailureAt };
  }

  if (isSemanticWarning(hostSummary.rateLimitStatus)) {
    return { kind: "semantic-only", status: hostSummary.rateLimitStatus };
  }
  return { kind: "never-checked" };
}

/**
 * Pure classifier for the refresh axis, orthogonal to `detail`: whether THIS
 * profile's own query key is actively fetching (`refreshing`), waiting its
 * turn behind another entry in the shared serial queue (`queued` - only a
 * concept for the `ephemeralProcess` lane, which the caller passes as
 * `lane`), or neither (`idle`). Mirrors `useProviderRateLimitRefresh`'s
 * existing `isFetching || (lane === "ephemeralProcess" && draining)` fold,
 * split into three states instead of two booleans so callers can render
 * "queued" and "refreshing" distinctly.
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
