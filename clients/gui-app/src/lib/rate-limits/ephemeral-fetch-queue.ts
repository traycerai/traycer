import type { QueryClient } from "@tanstack/react-query";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
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
 * Shared fetch queue for the `ephemeralProcess` rate-limit providers (codex,
 * claude-code) - the only providers this queue serves. Each pull spawns a real
 * CLI subprocess on the host, so interval timers, turn completions, and manual
 * refreshes all route through here. Queue items run serially, but a deliberate
 * batch (the popover's "Refresh all") may fan out its distinct profile pulls in
 * parallel before the next queue item begins.
 *
 * `httpFetch` providers (openrouter, kilocode, huggingface) NEVER touch this
 * queue - their
 * observers opt into the table-owned fixed cadence directly.
 *
 * The queue is a plain module holding process-wide state. The long-lived app
 * shell binds its default host via `configureRateLimitQueue`, while surfaces
 * that can inspect another host pass an explicit, render-time scope through
 * `enqueueRateLimitFetchForScope`. New targets append to the same promise chain
 * while duplicate host/provider/profile targets join their pending promise, so
 * work remains ordered without redundant rounds. Each enqueue snapshots its
 * scope, so it cannot be reassigned by a later host swap and always writes to
 * the query key for the host that receives the RPC.
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

export interface RateLimitQueueBatchTarget {
  readonly providerId: RateLimitProviderId;
  readonly accountContext: AccountContext;
  readonly profileId: string | null;
}

let deps: RateLimitQueueConfig | null = null;
// The serial lane itself: every queue item appends to the tail of this promise
// chain. An item normally contains one fetch, while an explicit batch may
// contain several profile fetches that run concurrently inside that item.
let chain: Promise<unknown> = Promise.resolve();
let inFlightCount = 0;
let queueGeneration = 0;
const drainingListeners = new Set<() => void>();
const targetListeners = new Set<() => void>();

export type RateLimitQueueTargetPhase = "queued" | "fetching";

interface PendingRateLimitTarget {
  readonly key: string;
  phase: RateLimitQueueTargetPhase;
  force: boolean;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly shouldSkipAutomatic: () => boolean;
  readonly fetch: () => Promise<ProviderRateLimitEnvelope>;
}

const pendingTargets = new Map<string, PendingRateLimitTarget>();

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

// Per-host/provider/profile cool-down expiry (epoch ms), set after a
// `usage_fetch_failed` resolution and cleared once a later fetch resolves with
// anything else. The host id is part of the key because the shared lane can
// service the app-shell default host and an explicitly Settings-selected host.
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

function notifyTargets(): void {
  for (const listener of targetListeners) listener();
}

/**
 * Bind (or, with `null`, unbind) the app-shell default scope. Called from an
 * effect that re-runs on default-host/client changes. Explicit host scopes do
 * not replace this binding; they only snapshot their own dependencies for one
 * enqueue onto the same ordered lane.
 */
export function configureRateLimitQueue(
  next: RateLimitQueueConfig | null,
): void {
  deps = next;
}

/**
 * `useSyncExternalStore`-compatible pair for the "subprocess work is queued or
 * running" signal - a bare promise chain isn't React-observable on its own. The
 * popover consumes this (via `useIsRateLimitQueueDraining`) to disable "Refresh
 * all" while the lane is draining.
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
  hostId: string,
  providerId: RateLimitProviderId,
  profileId: string | null,
): string {
  return profileId === null
    ? `${hostId}:${providerId}`
    : `${hostId}:${providerId}:profile:${profileId}`;
}

export function getRateLimitQueueTargetPhase(
  hostId: string,
  providerId: RateLimitProviderId,
  profileId: string | null,
): RateLimitQueueTargetPhase | null {
  return (
    pendingTargets.get(rateLimitQueueProfileKey(hostId, providerId, profileId))
      ?.phase ?? null
  );
}

export function subscribeRateLimitQueueTargets(
  listener: () => void,
): () => void {
  targetListeners.add(listener);
  return () => {
    targetListeners.delete(listener);
  };
}

function applyCooldownPolicy(
  hostId: string,
  providerId: RateLimitProviderId,
  profileId: string | null,
  envelope: ProviderRateLimitEnvelope,
): void {
  const cooldownKey = rateLimitQueueProfileKey(hostId, providerId, profileId);
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
  hostId: string,
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  const until =
    cooldownUntil.get(
      rateLimitQueueProfileKey(hostId, providerId, profileId),
    ) ?? 0;
  return Date.now() < until;
}

/**
 * Append or join one `ephemeralProcess` provider/profile pull on the serial
 * lane. Returns a promise for this target's pending episode.
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
  return enqueueRateLimitFetchForScope(deps, providerId, accountContext, opts);
}

/**
 * Append one queue item whose distinct provider/profile pulls start together
 * when that item reaches the front of the lane. Used by the popover's "Refresh
 * all" action so profiles do not wait top-to-bottom, while later timers, turn
 * completions, and clicks still wait for the whole refresh round to settle.
 */
export function enqueueRateLimitFetchBatch(
  targets: ReadonlyArray<RateLimitQueueBatchTarget>,
  opts: { readonly force: boolean },
): Promise<unknown> {
  return enqueueRateLimitFetchBatchForScope(deps, targets, opts);
}

/**
 * Append a provider pull for an explicit host/client/cache scope. The scope is
 * captured at call time and never mutates the app-shell default binding. A
 * `null` scope is the same readiness no-op as an unconfigured default queue.
 */
export function enqueueRateLimitFetchForScope(
  scope: RateLimitQueueConfig | null,
  providerId: RateLimitProviderId,
  accountContext: AccountContext,
  opts: { readonly force: boolean; readonly profileId: string | null },
): Promise<unknown> {
  return enqueueRateLimitFetchBatchForScope(
    scope,
    [{ providerId, accountContext, profileId: opts.profileId }],
    { force: opts.force },
  );
}

function createPendingPromise(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function settlePendingTarget(target: PendingRateLimitTarget): void {
  if (pendingTargets.get(target.key) === target) {
    pendingTargets.delete(target.key);
    notifyTargets();
  }
  target.resolve();
}

async function runPendingTarget(target: PendingRateLimitTarget): Promise<void> {
  if (!target.force && target.shouldSkipAutomatic()) {
    settlePendingTarget(target);
    return;
  }

  target.phase = "fetching";
  notifyTargets();
  try {
    await target.fetch();
  } catch {
    // TanStack keeps the normalized failure on this target's cache entry.
    // Swallow it here so one profile cannot poison the shared serial lane.
  } finally {
    settlePendingTarget(target);
  }
}

/**
 * The batch form of `enqueueRateLimitFetchForScope`, for a caller that already
 * holds its own scope. The popover's "Refresh all" is the reason it is
 * exported: it may be reading a host other than the app-wide default, and the
 * unscoped `enqueueRateLimitFetchBatch` above resolves to whatever host the
 * app shell configured - which would refresh one host while the panel that
 * spun to say so displayed another.
 */
export function enqueueRateLimitFetchBatchForScope(
  scope: RateLimitQueueConfig | null,
  targets: ReadonlyArray<RateLimitQueueBatchTarget>,
  opts: { readonly force: boolean },
): Promise<unknown> {
  if (scope === null || targets.length === 0) return chain;
  const { hostId, queryClient, request } = scope;
  const joinedPromises: Promise<void>[] = [];
  const newTargets: PendingRateLimitTarget[] = [];

  for (const target of targets) {
    const targetKey = rateLimitQueueProfileKey(
      hostId,
      target.providerId,
      target.profileId,
    );
    const pending = pendingTargets.get(targetKey);
    if (pending !== undefined) {
      // Manual intent upgrades queued automatic work in place. Once a fetch is
      // already running, joining it is sufficient: its result will be fresh.
      if (opts.force && pending.phase === "queued") pending.force = true;
      joinedPromises.push(pending.promise);
      continue;
    }

    const params: RateLimitUsageParams = {
      accountContext: target.accountContext,
      providerId: target.providerId,
      profileId: target.profileId,
    };
    const queryKey = queryKeys.hostMethod<
      HostRpcRegistry,
      "host.getRateLimitUsage"
    >(hostId, "host.getRateLimitUsage", params);

    function shouldSkipAutomatic(): boolean {
      const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
      return (
        Date.now() - updatedAt < PROVIDER_RATE_LIMITS_STALE_TIME_MS ||
        isInCooldown(hostId, target.providerId, target.profileId)
      );
    }
    if (!opts.force && shouldSkipAutomatic()) continue;

    // Named request fn (not an inline closure in `queryFn`) so the host-scoped
    // key stays the sole cache identity. Boundary-wrapped because this writes
    // the same cache slot HostRpcError-typed observers read.
    function queryFn(): Promise<ProviderRateLimitEnvelope> {
      return withHostQueryErrorBoundary("host.getRateLimitUsage", async () => {
        const response = await request(
          hostId,
          "host.getRateLimitUsage",
          params,
        );
        const envelope = mapResponseToProviderRateLimitEnvelope({
          response,
          queryClient,
          queryKey,
        });
        applyCooldownPolicy(
          hostId,
          target.providerId,
          target.profileId,
          envelope,
        );
        return envelope;
      });
    }

    const deferred = createPendingPromise();
    const queuedTarget: PendingRateLimitTarget = {
      key: targetKey,
      phase: "queued",
      force: opts.force,
      promise: deferred.promise,
      resolve: deferred.resolve,
      shouldSkipAutomatic,
      fetch: () =>
        queryClient.fetchQuery({
          queryKey,
          queryFn,
          // The registry owns freshness and force semantics. Once a target
          // reaches this point, TanStack must invoke queryFn.
          staleTime: 0,
          meta: stampHostRpcMethod(undefined, "host.getRateLimitUsage"),
          gcTime: Infinity,
        }),
    };
    pendingTargets.set(targetKey, queuedTarget);
    joinedPromises.push(queuedTarget.promise);
    newTargets.push(queuedTarget);
  }

  if (newTargets.length === 0) {
    return joinedPromises.length === 0
      ? chain
      : Promise.all(joinedPromises).then(() => undefined);
  }

  inFlightCount += 1;
  notifyDraining();
  notifyTargets();
  const generation = queueGeneration;
  chain = chain
    .then(() =>
      Promise.all(newTargets.map(runPendingTarget)).then(() => undefined),
    )
    .catch(() => undefined)
    .finally(() => {
      if (generation !== queueGeneration) return;
      inFlightCount = Math.max(0, inFlightCount - 1);
      notifyDraining();
    });
  return Promise.all(joinedPromises).then(() => undefined);
}

/**
 * Test-only reset of the module-global lane state so each test starts from a
 * clean queue (no bound host, empty chain, zero in-flight, no listeners, no
 * standing cool-downs).
 */
export function __resetRateLimitQueueForTests(): void {
  queueGeneration += 1;
  for (const target of pendingTargets.values()) target.resolve();
  pendingTargets.clear();
  deps = null;
  chain = Promise.resolve();
  inFlightCount = 0;
  drainingListeners.clear();
  targetListeners.clear();
  cooldownUntil.clear();
}
