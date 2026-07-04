import type { QueryClient } from "@tanstack/react-query";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

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
type RateLimitUsageResponse = ResponseOfMethod<
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

function notifyDraining(): void {
  for (const listener of drainingListeners) listener();
}

/**
 * Bind (or, with `null`, unbind) the queue to the default host. Called once
 * from an app-shell `useEffect` that re-runs on default-host / client change,
 * and passes `null` on host loss so a stale client can't service an enqueue.
 */
export function configureRateLimitQueue(
  next: RateLimitQueueConfig | null,
): void {
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
 * Append a rate-limit pull for one `ephemeralProcess` provider to the serial
 * lane. Returns the tail of the chain so a caller ("Refresh all") can await the
 * lane draining.
 *
 * - `force: false` (interval timer, turn completion): no-op if the query's
 *   cached data is younger than `PROVIDER_RATE_LIMITS_STALE_TIME_MS`, so
 *   automatic triggers don't re-spawn a subprocess for still-fresh data.
 * - `force: true` (user-initiated refresh): always fetches, bypassing that
 *   floor - a manual refresh must never silently no-op.
 *
 * No-ops (returning the current chain) while the queue is unconfigured, mirroring
 * the host-readiness `enabled` gate the per-provider query uses.
 */
export function enqueueRateLimitFetch(
  providerId: RateLimitProviderId,
  accountContext: AccountContext,
  opts: { readonly force: boolean },
): Promise<unknown> {
  const current = deps;
  if (current === null) return chain;
  const { hostId, queryClient, request } = current;
  const params: RateLimitUsageParams = { accountContext, providerId };
  const queryKey = queryKeys.hostMethod<
    HostRpcRegistry,
    "host.getRateLimitUsage"
  >(hostId, "host.getRateLimitUsage", params);

  if (!opts.force) {
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
    if (Date.now() - updatedAt < PROVIDER_RATE_LIMITS_STALE_TIME_MS) {
      return chain;
    }
  }

  // Named request fn (not an inline closure in `queryFn`) so the host-scoped
  // key stays the sole cache identity - `request` is stable module state, not a
  // key input, and inlining it would trip the query plugin's exhaustive-deps
  // check (mirrors `resolve-artifact-by-path.ts`).
  const queryFn = (): Promise<RateLimitUsageResponse> =>
    request(hostId, "host.getRateLimitUsage", params);

  inFlightCount += 1;
  notifyDraining();
  chain = chain
    .then(() => queryClient.fetchQuery({ queryKey, queryFn }))
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
 * clean queue (no bound host, empty chain, zero in-flight, no listeners).
 */
export function __resetRateLimitQueueForTests(): void {
  deps = null;
  chain = Promise.resolve();
  inFlightCount = 0;
  drainingListeners.clear();
}
