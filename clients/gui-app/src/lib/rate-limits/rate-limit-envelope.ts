import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import { isTransientRateLimitUnavailableReason } from "@traycer/protocol/host";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";

const PROVIDERS_LIST_METHOD_DISCRIMINATOR = "providers.list";

/** The `available: true` arm of `ProviderRateLimits` - the only shape worth retaining. */
export type AvailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: true }
>;
type UnavailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: false }
>;

/** The raw wire response for `host.getRateLimitUsage` at whatever version the GUI currently negotiates. */
export type RateLimitUsageResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.getRateLimitUsage"
>;

/**
 * Whether a provider-pull failure is transient - a fetch problem on THIS attempt, not a statement about the account's capability to ever report usage
 */
export const isTransientUnavailableReason =
  isTransientRateLimitUnavailableReason;

function canRetainPreviousRateLimits(
  previous: ProviderRateLimitEnvelope | undefined,
  latest: UnavailableProviderRateLimits,
): boolean {
  if (latest.provider !== "opencode") return true;
  return (
    latest.credentialGeneration !== undefined &&
    previous?.lastGood?.provider === "opencode" &&
    previous.lastGood.credentialGeneration === latest.credentialGeneration
  );
}

/**
 * Some Codex refreshes report the authoritative reset-credit count without repeating the optional per-credit detail list.
 * Keep the last detailed list only while that count is unchanged: `credits: null` means "details omitted", whereas `credits: []` is an explicit detailed response.
 */
function retainCodexResetCreditDetails(
  previous: ProviderRateLimitEnvelope | undefined,
  latest: AvailableProviderRateLimits,
): AvailableProviderRateLimits {
  if (latest.provider !== "codex") return latest;
  const latestResetCredits = latest.resetCredits;
  if (latestResetCredits === null || latestResetCredits.credits !== null) {
    return latest;
  }

  const previousCodex = previous?.lastGood;
  if (previousCodex === undefined || previousCodex === null) return latest;
  if (previousCodex.provider !== "codex") return latest;
  const previousResetCredits = previousCodex.resetCredits;
  if (
    previousResetCredits === null ||
    previousResetCredits.credits === null ||
    previousResetCredits.availableCount !== latestResetCredits.availableCount
  ) {
    return latest;
  }

  return {
    ...latest,
    resetCredits: {
      ...latestResetCredits,
      credits: previousResetCredits.credits,
    },
  };
}

/**
 * Renderer-memory envelope the `host.getRateLimitUsage` provider-pull query cache entry holds (replacing the raw wire response as the cached `data`), so a transient fetch failure (Core Flows: "couldn't fetch usage - will retry") doesn't blank a real, recent.
 */
export interface ProviderRateLimitEnvelope {
  readonly latest: ProviderRateLimits | null;
  readonly lastGood: AvailableProviderRateLimits | null;
  readonly lastGoodAt: number | null;
  readonly lastFailureAt: number | null;
}

/**
 * Whether `response` carries a snapshot for a provider whose `providers.list` profile rows report cached `rateLimitStatus`: claude-code, codex, or grok.
 * Openrouter/kilocode/traycer-aperture reads gate out here so a convergence invalidation isn't spent on a provider that could never affect the switch-prompt banner.
 */
function isManagedProfileCapableRateLimitsResponse(
  response: RateLimitUsageResponse,
): boolean {
  const provider = response.providerRateLimits;
  return (
    provider !== null &&
    provider.available &&
    (provider.provider === "codex" ||
      provider.provider === "claude-code" ||
      provider.provider === "grok")
  );
}

/**
 * Converges the composer's rate-limit switch-prompt banner (which reads `providers.list`) with whatever this `host.getRateLimitUsage` fetch just learned: a profile the popover/queue just observed crossing into (or out of) near/hard limit should not wait for.
 */
function invalidateProvidersListForConvergence(
  queryClient: QueryClient,
  response: RateLimitUsageResponse,
): void {
  if (!isManagedProfileCapableRateLimitsResponse(response)) return;
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey.includes(PROVIDERS_LIST_METHOD_DISCRIMINATOR),
  });
}

/**
 * Pure accumulator: folds a fresh wire response into the envelope built from `previous` (the envelope this same query key held before this fetch, or `undefined` on a cold cache - the first fetch ever, or after a reload, since this envelope is renderer-memory.
 */
export function buildProviderRateLimitEnvelope(
  previous: ProviderRateLimitEnvelope | undefined,
  response: RateLimitUsageResponse,
  now: number,
): ProviderRateLimitEnvelope {
  return buildProviderRateLimitEnvelopeFromSnapshot(
    previous,
    response.providerRateLimits,
    now,
  );
}

export function buildProviderRateLimitEnvelopeFromSnapshot(
  previous: ProviderRateLimitEnvelope | undefined,
  latest: ProviderRateLimits | null,
  now: number,
): ProviderRateLimitEnvelope {
  if (latest !== null && latest.available) {
    const retainedLatest = retainCodexResetCreditDetails(previous, latest);
    return {
      latest: retainedLatest,
      lastGood: retainedLatest,
      lastGoodAt: now,
      lastFailureAt: previous?.lastFailureAt ?? null,
    };
  }

  if (latest !== null && isTransientUnavailableReason(latest.reason)) {
    const canRetainPrevious = canRetainPreviousRateLimits(previous, latest);
    return {
      latest,
      lastGood: canRetainPrevious ? (previous?.lastGood ?? null) : null,
      lastGoodAt: canRetainPrevious ? (previous?.lastGoodAt ?? null) : null,
      lastFailureAt: now,
    };
  }

  return { latest, lastGood: null, lastGoodAt: null, lastFailureAt: null };
}

/**
 * The shared fetch wrapper both `host.getRateLimitUsage` provider-pull write lanes fold their fresh response through before handing it to TanStack as the cached `data`: the `ephemeralProcess` serial queue (`ephemeral-fetch-queue.ts`, which fetches via its.
 */
export function mapResponseToProviderRateLimitEnvelope(args: {
  readonly response: RateLimitUsageResponse;
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
}): ProviderRateLimitEnvelope {
  const previous = args.queryClient.getQueryData<ProviderRateLimitEnvelope>(
    args.queryKey,
  );
  invalidateProvidersListForConvergence(args.queryClient, args.response);
  return buildProviderRateLimitEnvelope(previous, args.response, Date.now());
}

/**
 * What a consumer should currently render for a provider: the retained `lastGood` reading when the latest attempt is a transient failure with one available, otherwise exactly what the latest attempt reported (a good reading, an authoritative unavailable.
 */
export function resolveRetainedProviderRateLimits(
  envelope: ProviderRateLimitEnvelope | null,
): ProviderRateLimits | null {
  if (envelope === null) return null;
  const { latest, lastGood } = envelope;
  if (latest === null) return null;
  if (latest.available) return latest;
  if (isTransientUnavailableReason(latest.reason) && lastGood !== null) {
    return lastGood;
  }
  return latest;
}

/**
 * Whether the CURRENT retained view (`resolveRetainedProviderRateLimits`) is a dimmed last-known-good reading rather than a fresh one - true only when the latest attempt itself is a transient failure and a `lastGood` reading is being shown in its place.
 */
export function envelopeDegradedReason(
  envelope: ProviderRateLimitEnvelope | null,
): RateLimitUnavailableReason | null {
  if (envelope === null) return null;
  const { latest, lastGood } = envelope;
  if (latest === null || latest.available) return null;
  if (isTransientUnavailableReason(latest.reason) && lastGood !== null) {
    return latest.reason;
  }
  return null;
}
