import type { QueryClient } from "@tanstack/react-query";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import {
  mapResponseToProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
  type RateLimitUsageResponse,
} from "@/lib/rate-limits/rate-limit-envelope";
import { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS } from "@/lib/rate-limits/rate-limit-timing";

/**
 * Shared serial fetch lane for the `ephemeralProcess` rate-limit providers
 * (codex, claude-code) - the only providers this queue serves. Each of their
 * pulls spawns a real CLI subprocess on the host, so every trigger that can
 * cause one (the interval timer, a turn completion, a manual "Refresh all")
 * routes through here to guarantee **at most one subprocess-spawning fetch is
 * in flight at a time**, no matter how many providers or how fast the clicks.
 *
 * `httpFetch` providers (openrouter, kilocode) NEVER touch this queue - they
 * poll directly via their query's own `refetchInterval`.
 *
 * The queue is a plain module holding process-wide state, wired up once from a
 * long-lived app-shell component (`RateLimitQueueProvider`) via
 * `configureRateLimitQueue`. The `QueryClient`, host client `request`, and the
 * default `hostId` are passed in from that React call site rather than reached
 * for here - `hostId` is bound at configure time (re-bound whenever the default
 * host changes) so an enqueue can't race a host swap mid-flight: a queued fetch
 * always writes into the query key of the host it was enqueued for.
 */

type RateLimitUsageParams = RequestOfMethod<
  HostRpcRegistry,
  "host.getRateLimitUsage"
>;

export type RateLimitQueueRequestFn = (
  hostId: string,
  method: "host.getRateLimitUsage",
  params: RateLimitUsageParams,
) => Promise<RateLimitUsageResponse>;

export interface RateLimitQueueConfig {
  readonly hostId: string;
  readonly queryClient: QueryClient;
  readonly request: RateLimitQueueRequestFn;
}

let deps: RateLimitQueueConfig | null = null;
// The serial lane itself: every enqueued fetch appends to the tail of this
// promise chain, so fetch N+1's `fetchQuery` cannot start until fetch N settles.
let chain: Promise<unknown> = Promise.resolve();
let inFlightCount = 0;
const drainingListeners = new Set<() => void>();

/**
 * Post-`usage_fetch_failed` cool-down: how long *automatic* enqueues (the
 * interval tick, turn-completion triggers) are suppressed for the affected
 * provider profile after a fetch resolves with that reason. The tech plan's root
 * cause is a server-side 429 on Anthropic's usage endpoint with multi-minute
 * penalty windows; a retry-once (narrowed to the OTHER arm on the host side)
 * plus continued polling on this arm can keep re-tripping the same limit. This
 * cool-down, sourced from `EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS`
 * (`rate-limit-timing.ts`, shared with `rate-limit-queue-provider.tsx`'s poll
 * interval so the two can't drift) - effectively "skip the next automatic
 * poll" - lets a tripped window drain instead.
 *
 * Scoped to `usage_fetch_failed` specifically, NOT the other transient
 * reasons the view-state retention treatment covers (`timeout`,
 * `connection_failed`) - those are probe-level failures without the same
 * server-side-penalty-window mechanics motivating this cool-down.
 *
 * A manual refresh (`force: true`) is never subject to this cool-down - it's
 * always single-shot with no retry loop of its own, so it can't itself
 * re-trip a tripped limit the way continued automatic polling can.
 */
const USAGE_FETCH_FAILURE_COOLDOWN_MS = EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS;

// Per-provider-profile cool-down expiry (epoch ms), set after a
// `usage_fetch_failed` resolution and cleared once a later fetch resolves with
// anything else. Keyed only inside the currently-bound host because the queue
// itself only ever serves one host at a time - `configureRateLimitQueue` clears
// this map whenever the bound host actually changes, so a cool-down never
// survives a swap to a different host's identically-named provider/profile.
const cooldownUntil = new Map<string, number>();

/**
 * Dev-only (Vite HMR) self-healing for this module's singleton state. An HMR
 * update that re-executes this module - an edit to it or to anything in its
 * import chain (`query-keys`, `rate-limit-providers`, `@/lib/host`, ...) -
 * creates a fresh instance with `deps = null`. `RateLimitQueueProvider`'s
 * configure effect does not re-run for a bubbled invalidation (its component
 * and effect deps are unchanged), so nothing would rebind the fresh instance:
 * every enqueue silently no-ops - buttons stop coordinating, manual refreshes
 * do nothing - until a full window reload, while the old instance keeps
 * servicing the interval timer's stale closure so data still looks live.
 * Carrying the binding across HMR generations closes that gap. Tree-shaken
 * out of production builds (`import.meta.hot` is statically false there).
 */
// `undefined` in the union (rather than an optional marker) is the "no
// generation has stashed a binding yet" state a fresh `hot.data` object
// starts in.
interface RateLimitQueueHotData {
  rateLimitQueueDeps: RateLimitQueueConfig | null | undefined;
}
// Vite types `hot.data` as `any`; the `unknown` hop + structural guard keeps
// the read type-safe. The guard also handles Vitest, whose truthy
// `import.meta.hot` stub carries no `data` object, unlike Vite's dev server.
function isRateLimitQueueHotData(
  value: unknown,
): value is RateLimitQueueHotData {
  return typeof value === "object" && value !== null;
}
const hot = import.meta.hot;
const hotData: unknown = hot?.data;
if (hot !== undefined && isRateLimitQueueHotData(hotData)) {
  const carried = hotData.rateLimitQueueDeps;
  if (carried !== undefined) deps = carried;
  hot.dispose(() => {
    hotData.rateLimitQueueDeps = deps;
  });
}

function notifyDraining(): void {
  for (const listener of drainingListeners) listener();
}

/**
 * Bind (or, with `null`, unbind) the queue to the default host. Called once
 * from an app-shell `useEffect` that re-runs on default-host / client change,
 * and passes `null` on host loss so a stale client can't service an enqueue.
 *
 * Clears `cooldownUntil` whenever the bound host id actually changes (not on
 * every call - a client/queryClient identity change with the same host id
 * must not reset a live cool-down). `cooldownUntil` is keyed only by
 * provider id, not host id, so without this a `usage_fetch_failed` cool-down
 * picked up on one host would otherwise keep suppressing automatic polling
 * for the same-named provider (e.g. `claude-code`) after switching to a
 * different host.
 */
export function configureRateLimitQueue(
  next: RateLimitQueueConfig | null,
): void {
  const previousHostId = deps?.hostId ?? null;
  const nextHostId = next?.hostId ?? null;
  if (previousHostId !== nextHostId) cooldownUntil.clear();
  deps = next;
}

/**
 * `useSyncExternalStore`-compatible pair for the "a subprocess fetch is
 * running" signal - a bare promise chain isn't React-observable on its own.
 * The popover consumes this (via `useIsRateLimitQueueDraining`) to disable
 * "Refresh all" while the lane is draining.
 */
export function subscribeRateLimitQueueDraining(
  listener: () => void,
): () => void {
  drainingListeners.add(listener);
  return () => {
    drainingListeners.delete(listener);
  };
}

export function isRateLimitQueueDraining(): boolean {
  return inFlightCount > 0;
}

/**
 * Applies the post-fetch cool-down policy for `providerId` from the envelope a
 * fetch just resolved to: sets a `USAGE_FETCH_FAILURE_COOLDOWN_MS` window on
 * `usage_fetch_failed`, clears any standing cool-down on anything else (a good
 * reading, or a different/authoritative reason - the condition this cool-down
 * exists for is no longer the one in effect, so automatic polling should
 * resume rather than keep suppressing on a stale cause).
 */
function rateLimitQueueProfileKey(
  providerId: RateLimitProviderId,
  profileId: string | null,
): string {
  return profileId === null ? providerId : `${providerId}:profile:${profileId}`;
}

function applyCooldownPolicy(
  providerId: RateLimitProviderId,
  profileId: string | null,
  envelope: ProviderRateLimitEnvelope,
): void {
  const cooldownKey = rateLimitQueueProfileKey(providerId, profileId);
  const latest = envelope.latest;
  if (
    latest !== null &&
    !latest.available &&
    latest.reason === "usage_fetch_failed"
  ) {
    cooldownUntil.set(
      cooldownKey,
      Date.now() + USAGE_FETCH_FAILURE_COOLDOWN_MS,
    );
    return;
  }
  cooldownUntil.delete(cooldownKey);
}

function isInCooldown(
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  const until =
    cooldownUntil.get(rateLimitQueueProfileKey(providerId, profileId)) ?? 0;
  return Date.now() < until;
}

/**
 * Append a rate-limit pull for one `ephemeralProcess` provider to the serial
 * lane. Returns the tail of the chain so a caller ("Refresh all") can await the
 * lane draining.
 *
 * - `force: false` (interval timer, turn completion): no-ops if the query's
 *   cached data is younger than `PROVIDER_RATE_LIMITS_STALE_TIME_MS`, so
 *   automatic triggers don't re-spawn a subprocess for still-fresh data; ALSO
 *   no-ops while this provider is in its post-`usage_fetch_failed` cool-down
 *   (`USAGE_FETCH_FAILURE_COOLDOWN_MS`), so a tripped server-side rate limit
 *   drains instead of being re-tripped every poll.
 * - `force: true` (user-initiated refresh): always fetches, bypassing both the
 *   freshness floor and the cool-down - a manual refresh must never silently
 *   no-op, and is always single-shot with no retry loop of its own.
 *
 * No-ops (returning the current chain) while the queue is unconfigured, mirroring
 * the host-readiness `enabled` gate the per-provider query uses.
 */
export function enqueueRateLimitFetch(
  providerId: RateLimitProviderId,
  accountContext: AccountContext,
  opts: { readonly force: boolean; readonly profileId: string | null },
): Promise<unknown> {
  const current = deps;
  if (current === null) return chain;
  const { hostId, queryClient, request } = current;
  const params: RateLimitUsageParams = {
    accountContext,
    providerId,
    profileId: opts.profileId,
  };
  const queryKey = queryKeys.hostMethod<
    HostRpcRegistry,
    "host.getRateLimitUsage"
  >(hostId, "host.getRateLimitUsage", params);

  const isFresh = (): boolean => {
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
    return Date.now() - updatedAt < PROVIDER_RATE_LIMITS_STALE_TIME_MS;
  };
  const shouldSkipAutomatic = (): boolean =>
    !opts.force && (isFresh() || isInCooldown(providerId, opts.profileId));
  if (shouldSkipAutomatic()) return chain;

  // Named request fn (not an inline closure in `queryFn`) so the host-scoped
  // key stays the sole cache identity - `request` is stable module state, not a
  // key input, and inlining it would trip the query plugin's exhaustive-deps
  // check (mirrors `resolve-artifact-by-path.ts`).
  const queryFn = async (): Promise<ProviderRateLimitEnvelope> => {
    const response = await request(hostId, "host.getRateLimitUsage", params);
    const envelope = mapResponseToProviderRateLimitEnvelope({
      response,
      queryClient,
      queryKey,
    });
    applyCooldownPolicy(providerId, opts.profileId, envelope);
    return envelope;
  };

  inFlightCount += 1;
  notifyDraining();
  chain = chain
    .then(() => {
      // Re-checked at this fetch's turn in the lane (not just at enqueue time):
      // an earlier fetch in the same round may have just refreshed this exact
      // provider (or just entered it into cool-down), and an automatic trigger
      // must not re-spawn a subprocess for data that became fresh - or a
      // provider that entered cool-down - while it waited in the queue.
      if (shouldSkipAutomatic()) return undefined;
      // `staleTime: 0` is load-bearing: `fetchQuery` inherits the app
      // QueryClient's GLOBAL `staleTime` default (60s in `query-client.ts`)
      // and serves still-fresh cache without fetching at all. The popover's
      // open-time refresh keeps this data younger than 60s, so without the
      // override a user's `force: true` refresh silently no-oped - resolving
      // from cache in a microtask, spawning no subprocess, flipping
      // `draining` for under a frame - while the httpFetch lane's
      // `invalidateQueries` (which always refetches) visibly spun. Freshness
      // policy for automatic triggers lives in the explicit `isFresh` checks
      // above, never in `fetchQuery`'s own staleness short-circuit.
      return queryClient.fetchQuery({ queryKey, queryFn, staleTime: 0 });
    })
    // One provider's failure must not block the next provider's turn in the
    // lane, and must not reject the shared chain (which every future enqueue
    // builds on).
    .catch(() => undefined)
    .finally(() => {
      inFlightCount -= 1;
      notifyDraining();
    });
  return chain;
}

/**
 * Test-only reset of the module-global lane state so each test starts from a
 * clean queue (no bound host, empty chain, zero in-flight, no listeners, no
 * standing cool-downs).
 */
export function __resetRateLimitQueueForTests(): void {
  deps = null;
  chain = Promise.resolve();
  inFlightCount = 0;
  drainingListeners.clear();
  cooldownUntil.clear();
}
