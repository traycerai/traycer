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
 * Whether a provider-pull failure is transient - a fetch problem on THIS
 * attempt, not a statement about the account's capability to ever report usage
 * - so a retained last-good reading may survive alongside it.
 *
 * Delegates to the protocol's own classifier rather than repeating the reason
 * set: the host's gauge cache retains its last known reading under exactly this
 * rule, and a renderer that disagreed about which reasons are transient would
 * dim a reading the host had already replaced (or blank one it still holds).
 * Re-exported under this module's name so the retention rule reads locally at
 * the call sites below.
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
 * Some Codex refreshes report the authoritative reset-credit count without
 * repeating the optional per-credit detail list. Keep the last detailed list
 * only while that count is unchanged: `credits: null` means "details omitted",
 * whereas `credits: []` is an explicit detailed response. A changed count can
 * mean a reset was granted, consumed, or expired, so retaining the old list in
 * that case would be actively misleading.
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
 * Renderer-memory envelope the `host.getRateLimitUsage` provider-pull query
 * cache entry holds (replacing the raw wire response as the cached `data`),
 * so a transient fetch failure (Core Flows: "couldn't fetch usage - will
 * retry") doesn't blank a real, recent reading the way replacing `data`
 * outright would.
 *
 * - `latest`: the most recent provider snapshot exactly as the wire reported
 *   it (its own `available` arm decides what the CURRENT attempt says).
 * - `lastGood`: the most recent `available: true` snapshot, retained across a
 *   transient failure. `null` once an authoritative unavailable reason
 *   arrives (that reason replaces the picture entirely - see
 *   `buildProviderRateLimitEnvelope`) or before any successful read has ever
 *   happened (cold start / after a reload - this is renderer-memory only).
 * - `lastGoodAt` / `lastFailureAt`: epoch-ms timestamps for the two events
 *   above, `null` until they've happened at least once in this envelope's
 *   lifetime.
 * - `episode`: which RUN OF FAILURES this reading belongs to, as an opaque
 *   identity. An answer ABOUT THE ACCOUNT - a reading, or an authoritative
 *   reason - starts a run by minting a value no other envelope has. A
 *   transient failure is not an answer and carries the value over, so one run
 *   shares one, and no two runs share one. The one exception is a failure that
 *   came back under a different credential than the reading behind it
 *   (OpenCode's generation): that is a run of its own, because the run before
 *   it describes a credential this account no longer uses. A surface that owes a transient
 *   account one action per run (the strip's single re-read,
 *   `rate-limit-read-ledger.ts`) records this value with the action and
 *   compares before owing again. The identity lives in the reading rather
 *   than in what was rendered, because the answer that ends a run usually
 *   lands where nothing is drawing the account: a background poll, a read from
 *   a different surface, a hidden window.
 */
export interface ProviderRateLimitEnvelope {
  readonly latest: ProviderRateLimits | null;
  readonly lastGood: AvailableProviderRateLimits | null;
  readonly lastGoodAt: number | null;
  readonly lastFailureAt: number | null;
  readonly episode: number;
}

/**
 * No run of failures: what a key with no envelope at all names, for a reader
 * that has to name something. Never minted, so no envelope carries it.
 */
export const NO_EPISODE = 0;

/**
 * The episodes handed out in this window, in order. Deliberately NOT a clock
 * reading: two answers can share a millisecond, and a wall clock corrected
 * backwards can date a genuinely later answer at a value it has already used -
 * either of which makes two runs of failures look like one and silently costs
 * the second run the read it was promised. A counter cannot do that. It needs
 * no persistence: nothing persists an envelope either, so a reload starts
 * every key cold and every identity fresh together.
 */
let episodesMinted = NO_EPISODE;

function nextEpisode(): number {
  episodesMinted += 1;
  return episodesMinted;
}

/**
 * Whether `response` carries a snapshot for a provider whose `providers.list`
 * profile rows report cached `rateLimitStatus` for managed profiles:
 * claude-code, codex, grok, or antigravity.
 * Openrouter/kilocode/traycer-aperture reads gate out here so a convergence
 * invalidation isn't spent on a provider that could never affect the
 * switch-prompt banner. Failed probes (`available: false` - timeout,
 * cli_not_found, ...) gate out too: they carry no usage the host's gauge cache
 * could have captured, so `providers.list` has nothing new to converge on.
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
      provider.provider === "grok" ||
      provider.provider === "antigravity")
  );
}

/**
 * Converges the composer's rate-limit switch-prompt banner (which reads
 * `providers.list`) with whatever this `host.getRateLimitUsage` fetch just
 * learned: a profile the popover or the background poll just observed
 * crossing into (or out of) near/hard limit should not wait for
 * `providers.list`'s own unrelated refetch cadence to reflect that.
 *
 * Invalidated by a broad key-prefix predicate rather than one exact `hostId`:
 * this fetch's own host (the default host, or whichever host the fetch's scope
 * names) is not necessarily the tab host the banner's
 * `providers.list` query is scoped to, and `providers.list` is a cheap
 * cache-only host read (no subprocess, no account probe), so invalidating it
 * across every currently-cached host scope is safe.
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
 * Pure accumulator: folds a fresh wire response into the envelope built from
 * `previous` (the envelope this same query key held before this fetch, or
 * `undefined` on a cold cache - the first fetch ever, or after a reload, since
 * this envelope is renderer-memory only).
 *
 * - `available: true` -> becomes the new `lastGood` outright.
 * - `available: false` with a transient reason -> `latest` reflects the
 *   failure, but `lastGood`/`lastGoodAt` carry over unchanged from `previous`
 *   (retention). OpenCode retains only a matching credential generation.
 *   `lastFailureAt` advances to `now`.
 * - `available: false` with an authoritative reason (`rate_limits_not_available`
 *   and friends), or no provider snapshot at all (`providerRateLimits: null` -
 *   an aperture-only call; never expected for the provider-pull branch this
 *   envelope serves, but handled the same way defensively) -> replaces the
 *   picture entirely: `lastGood`/`lastGoodAt`/`lastFailureAt` all reset to
 *   `null`. An authoritative "this account can't see usage" reading must
 *   never be shown dimmed alongside a stale good one.
 *
 * `episode` is minted fresh by a reading and by an authoritative reason, since
 * both are answers about the account, and carries over unchanged through a
 * transient failure and through a response with no snapshot, which are not. A
 * failure with no previous envelope mints one as well: that is the start of a
 * run too, and it is reachable - a cold cache, and an entry collected while
 * its provider was hidden.
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

/**
 * Which credential a snapshot was read with, where the wire says so - OpenCode
 * reports one on both arms, required on a reading and optional on a failure,
 * and no other provider reports one at all.
 */
function openCodeGeneration(
  snapshot: ProviderRateLimits | null | undefined,
): string | null {
  if (snapshot === null || snapshot === undefined) return null;
  if (snapshot.provider !== "opencode") return null;
  if (snapshot.available) return snapshot.credentialGeneration;
  return snapshot.credentialGeneration ?? null;
}

/**
 * Whether this failure came back under a DIFFERENT credential than the attempt
 * before it. The comparison is against the last generation this envelope SAW,
 * from either arm, because a rotation that fails leaves no reading behind to
 * compare the one after it against - and successive rotations are exactly the
 * case that matters.
 *
 * Only when the wire names both. A failure that reports no generation has not
 * said the credential changed, and treating silence as a change would start a
 * run per failure - which is also why this is a narrower question than whether
 * the READING may be retained: showing a reading from a credential that might
 * be gone is worth refusing on a maybe, while ending a run of failures on one
 * costs the account an extra read every time it fails.
 */
function credentialGenerationChanged(
  previous: ProviderRateLimitEnvelope | undefined,
  latest: UnavailableProviderRateLimits,
): boolean {
  if (latest.provider !== "opencode") return false;
  const latestGeneration = latest.credentialGeneration;
  const previousGeneration =
    openCodeGeneration(previous?.latest) ??
    openCodeGeneration(previous?.lastGood);
  if (latestGeneration === undefined || previousGeneration === null) {
    return false;
  }
  return previousGeneration !== latestGeneration;
}

/**
 * What a transient failure keeps of the run before it: the retained reading
 * where that is allowed, nothing where it is not, and the identity of the run
 * it continues. A credential rotation keeps NEITHER - its predecessor's
 * readings are another credential's, and so is whatever that run has already
 * spent - so it starts a run, exactly as an answer would.
 */
function carriedRun(
  previous: ProviderRateLimitEnvelope | undefined,
  latest: UnavailableProviderRateLimits,
): Pick<ProviderRateLimitEnvelope, "lastGood" | "lastGoodAt" | "episode"> {
  if (credentialGenerationChanged(previous, latest)) {
    return { lastGood: null, lastGoodAt: null, episode: nextEpisode() };
  }
  const episode = previous?.episode ?? nextEpisode();
  if (!canRetainPreviousRateLimits(previous, latest)) {
    return { lastGood: null, lastGoodAt: null, episode };
  }
  return {
    lastGood: previous?.lastGood ?? null,
    lastGoodAt: previous?.lastGoodAt ?? null,
    episode,
  };
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
      episode: nextEpisode(),
    };
  }

  if (latest !== null && isTransientUnavailableReason(latest.reason)) {
    return {
      latest,
      // The identity comes from here too, because one fact decides both: a
      // transient failure says nothing about the account, so it does not close
      // the run of failures this identity names - unless it came back under
      // another credential, which is the one case that invalidates the reading
      // and the run together. With no previous envelope it IS the start of a
      // run, so it mints.
      ...carriedRun(previous, latest),
      lastFailureAt: now,
    };
  }

  // No snapshot at all is no answer about the account either, so that carries
  // the identity over too; an authoritative reason below IS one.
  if (latest === null) {
    return {
      latest,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
      episode: previous?.episode ?? nextEpisode(),
    };
  }

  return {
    latest,
    lastGood: null,
    lastGoodAt: null,
    lastFailureAt: null,
    episode: nextEpisode(),
  };
}

/**
 * The shared fetch wrapper both `host.getRateLimitUsage` provider-pull write
 * lanes fold their fresh response through before handing it to TanStack as
 * the cached `data`: the `ephemeralProcess` lane
 * (`provider-rate-limit-fetch.ts`, which fetches via its own
 * `queryClient.fetchQuery` call) and the `httpFetch` lane (`use-host-provider-rate-limits-query.ts` /
 * `use-status-bar-rate-limit-segments.ts` / the popover's "Refresh all" button, all via
 * `useHostQueryWithResponseMap` / `useHostQueriesWithResponseMap`). Both write
 * into the same query-key family, so routing every write through this one
 * function is what keeps the envelope shape consistent no matter which lane's
 * fetch actually lands - see those hooks' own doc comments for why a bespoke
 * wrapper was necessary instead of the plain `useHostQuery` path.
 *
 * Reads `previous` from the exact cache slot the caller is about to write
 * (`queryClient.getQueryData(queryKey)`) - synchronous, and always up to date
 * for this purpose because it runs inside the same queryFn invocation that
 * will overwrite that slot.
 *
 * Also the single point where a resolved codex/claude-code/grok fetch converges
 * `providers.list` (`invalidateProvidersListForConvergence`) - every real
 * `host.getRateLimitUsage` fetch for those providers folds through this
 * function (`fetchProviderRateLimits`'s own `queryFn`; every other observer of
 * these providers' query key stays `enabled: false`), so this is exactly
 * "whenever a rate-limit usage fetch resolves" without duplicating the
 * invalidation at each call site.
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
 * What a consumer should currently render for a provider: the retained
 * `lastGood` reading when the latest attempt is a transient failure with one
 * available, otherwise exactly what the latest attempt reported (a good
 * reading, an authoritative unavailable reason, or `null` if no provider
 * snapshot has ever arrived). Shared by both resolvers in
 * `provider-rate-limit-content.ts` and by the usage readings
 * (`use-status-bar-rate-limit-segments.ts`), so every surface retains
 * identically.
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
 * Whether the CURRENT retained view (`resolveRetainedProviderRateLimits`) is a
 * dimmed last-known-good reading rather than a fresh one - true only when the
 * latest attempt itself is a transient failure and a `lastGood` reading is
 * being shown in its place. Distinct from a query-level `isError` degrade
 * (TanStack retaining old data across a thrown fetch exception): that case
 * has no specific wire reason to report and stays the caller's own generic
 * "refresh failed" treatment.
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
