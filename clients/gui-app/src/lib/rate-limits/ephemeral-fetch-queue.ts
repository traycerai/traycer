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
import {
  EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
  RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
} from "@/lib/rate-limits/rate-limit-timing";

/**
 * Shared fetch queue for the `ephemeralProcess` rate-limit providers (codex,
 * claude-code) - the only providers this queue serves. Each pull spawns a real
 * CLI subprocess on the host, so interval timers, turn completions, and manual
 * refreshes all route through here. Queue items run one at a time, but a
 * deliberate batch (the popover's "Refresh all", the timer's per-provider
 * sweep) may fan out its distinct profile pulls in parallel inside one item.
 *
 * `httpFetch` providers (openrouter, kilocode, huggingface) NEVER touch this
 * queue - their observers opt into the table-owned fixed cadence directly.
 *
 * Ordering, and the one guardrail this deliberately trades:
 *
 * Ticket 06 ("polling scheduler") set out to keep only one subprocess-spawning
 * fetch in flight at a time, explicitly including under rapid manual clicking,
 * and #369 refined that to one TRIGGER at a time - a single trigger may fan its
 * distinct profile pulls out concurrently, while later timers, turn completions
 * and clicks queue behind it. The concern is real: each ephemeral pull spawns a
 * CLI child on the user's machine.
 *
 * What that cost, though, was paid entirely by the person waiting. A click could
 * sit behind an automatic sweep for that sweep's whole response budget, showing
 * a "Queued" label - a refresh button that truthfully reported it had not
 * refreshed. So a user-initiated item (`force: true`) now skips the lane and
 * starts on arrival, and there is no queued state left for a person to read: a
 * refresh control is either fetching or idle.
 *
 * The bound that remains is deliberately as tight as the old one minus exactly
 * that wait:
 * - AUTOMATIC items stay FIFO, one at a time - unchanged.
 * - `pump` will not START an automatic item while any forced pull is in flight,
 *   so a click does not just skip the line, it stops background work piling in
 *   behind it.
 * - `fetchQuery` dedupes against an in-flight fetch for the same key, and the
 *   host single-flights per `(provider, effective profile)`. A click while a
 *   probe for that profile is already running joins it instead of spawning a
 *   second CLI - and joining is honest rather than a silent no-op, because the
 *   host registers a read as in-flight only after its cache-serving path has
 *   returned: anything there to join is a real probe.
 *
 * Net effect on peak spawns: one click still costs what it always cost (its own
 * fan-out), plus - only when a background probe happened to already be running,
 * which cannot be un-spawned - one more. That +1 is the whole price of never
 * making a person wait on work they did not ask for.
 *
 * The queue is a plain module holding process-wide state. The long-lived app
 * shell binds its default host via `configureRateLimitQueue`, while surfaces
 * that can inspect another host pass an explicit, render-time scope through
 * `enqueueRateLimitFetchForScope`. Every entry point feeds the same lane, so
 * subprocess work stays serialized across every host scope. Each enqueue
 * snapshots its scope, so it cannot be reassigned by a later host swap and
 * always writes to the query key for the host that receives the RPC.
 */

type RateLimitUsageParams = RequestOfMethod<
  HostRpcRegistry,
  "host.getRateLimitUsage"
>;

/**
 * The transport call one queued pull makes. `responseTimeoutMs` is the
 * extended response-frame budget the queue asks for
 * (`RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS`); the binding site forwards it to
 * `HostClient.requestWithResponseTimeout` so a slow-but-successful probe is not
 * discarded at the transport's 30s default.
 */
export type RateLimitQueueRequestFn = (
  hostId: string,
  method: "host.getRateLimitUsage",
  params: RateLimitUsageParams,
  responseTimeoutMs: number,
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

interface RateLimitQueueFetch {
  /** Pending-key of the profile this fetch writes (see `isRateLimitFetchPending`). */
  readonly pendingKey: string;
  readonly run: () => Promise<ProviderRateLimitEnvelope | undefined>;
}

interface RateLimitQueueItem {
  readonly fetches: ReadonlyArray<RateLimitQueueFetch>;
  /** Resolves the promise handed back to the enqueuer once this item settles. */
  readonly settle: () => void;
}

let deps: RateLimitQueueConfig | null = null;
// The lane, for AUTOMATIC items only: at most one runs at a time; the rest wait
// here in run order.
const waitingItems: RateLimitQueueItem[] = [];
let runningItem: RateLimitQueueItem | null = null;
// User-initiated items, which skip the lane and run on arrival. Tracked so the
// pending/draining signals still see them - never to make anything wait.
const runningForcedItems = new Set<RateLimitQueueItem>();
// How many waiting-or-running items include a fetch for each pending-key.
// Backs the per-profile "queued or refreshing" signal the popover rows show,
// so a row reflects a click the moment it is enqueued rather than only once
// its own `fetchQuery` finally starts behind an earlier item.
const pendingKeyCounts = new Map<string, number>();
const listeners = new Set<() => void>();

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

function notify(): void {
  for (const listener of listeners) listener();
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
 * `useSyncExternalStore`-compatible subscription for the per-profile pending
 * signal (`isRateLimitFetchPending`) - a bare promise chain isn't
 * React-observable on its own. Surfaces read that signal for the profiles they
 * actually name (via `useIsRateLimitFetchPending` /
 * `useIsAnyRateLimitFetchPending`) to show a row as refreshing from the moment
 * of the click.
 */
export function subscribeRateLimitQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether ANY pull is in flight or waiting, anywhere in this process.
 *
 * Deliberately not exposed to the UI as a hook: a lane-wide flag wired into a
 * control means one wedged probe for one profile disables every refresh button
 * in the app, which is precisely the failure this module's forced-bypass exists
 * to end. Surfaces scope to the profiles they name via
 * `isRateLimitFetchPending`. This predicate is the lane's own invariant, and
 * exists for the tests that assert automatic items never overlap.
 */
export function isRateLimitQueueDraining(): boolean {
  return (
    runningItem !== null ||
    waitingItems.length > 0 ||
    runningForcedItems.size > 0
  );
}

/**
 * The pending-key for one host/provider/profile pull - the identity both the
 * cool-down map and the pending-count map are keyed by. The host id is part of
 * it because the shared lane can service the app-shell default host and an
 * explicitly Settings-selected host.
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

/**
 * Whether a pull for exactly this host/provider/profile is running, or waiting
 * in the automatic lane. True from the moment it is enqueued until its item
 * settles (or its automatic pull is skipped as still-fresh at its turn), so a
 * row can show "Refreshing" for a click immediately rather than on the next tick
 * once `fetchQuery` has flipped the query's own `isFetching`.
 */
export function isRateLimitFetchPending(
  hostId: string,
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  return (
    (pendingKeyCounts.get(
      rateLimitQueueProfileKey(hostId, providerId, profileId),
    ) ?? 0) > 0
  );
}

/**
 * Applies the post-fetch cool-down policy for `providerId` from the envelope a
 * fetch just resolved to: sets a `USAGE_FETCH_FAILURE_COOLDOWN_MS` window on
 * `usage_fetch_failed`, clears any standing cool-down on anything else (a good
 * reading, or a different/authoritative reason - the condition this cool-down
 * exists for is no longer the one in effect, so automatic polling should
 * resume rather than keep suppressing on a stale cause).
 */
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
 * Append one `ephemeralProcess` provider/profile pull to the lane. Resolves once
 * this pull's item has settled (success, failure, or skipped as still-fresh).
 *
 * - `force: false` (interval timer, turn completion, open-time refresh): no-ops
 *   if the query's cached data is younger than
 *   `PROVIDER_RATE_LIMITS_STALE_TIME_MS`, so automatic triggers don't re-spawn
 *   a subprocess for still-fresh data; ALSO no-ops while this provider is in
 *   its post-`usage_fetch_failed` cool-down (`USAGE_FETCH_FAILURE_COOLDOWN_MS`),
 *   so a tripped server-side rate limit drains instead of being re-tripped
 *   every poll. Both checks re-run when the item reaches the front of the lane.
 *   A pull that survives both still travels as `force: false`, so the host may
 *   answer from its own per-profile gauge rather than spawning - this window
 *   knowing nothing about a profile says nothing about how recently the host
 *   read it.
 * - `force: true` (user-initiated refresh): always fetches, bypassing the
 *   freshness floor, the cool-down, and the host's gauge - a manual refresh
 *   must never silently no-op, and is always single-shot with no retry loop of
 *   its own. Starts on arrival without entering the lane, so it never waits on
 *   automatic work.
 *
 * No-ops (resolving immediately) while the queue is unconfigured, mirroring
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
 * all" action and the background timer's per-provider sweep so profiles do not
 * wait top-to-bottom, while later timers, turn completions, and clicks still
 * wait for the whole round to settle.
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
  if (scope === null) return Promise.resolve();
  const { hostId, queryClient, request } = scope;
  const fetches = targets
    .map((target): RateLimitQueueFetch | null => {
      // Cache identity for this pull - deliberately WITHOUT `force`. Every
      // trigger for one profile (open-time, timer, click) has to address the
      // same cache entry, or the row a person is looking at would observe the
      // automatic lane's slot while their click wrote a second one. `force` is
      // a statement about this attempt's cadence, not about which reading is
      // being addressed, so it rides the request only (see `queryFn`).
      const params: RateLimitUsageParams = {
        accountContext: target.accountContext,
        providerId: target.providerId,
        profileId: target.profileId,
      };
      const queryKey = queryKeys.hostMethod<
        HostRpcRegistry,
        "host.getRateLimitUsage"
      >(hostId, "host.getRateLimitUsage", params);

      function isFresh(): boolean {
        const updatedAt =
          queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
        return Date.now() - updatedAt < PROVIDER_RATE_LIMITS_STALE_TIME_MS;
      }
      function shouldSkipAutomatic(): boolean {
        return (
          !opts.force &&
          (isFresh() ||
            isInCooldown(hostId, target.providerId, target.profileId))
        );
      }
      if (shouldSkipAutomatic()) return null;

      // Named request fn (not an inline closure in `queryFn`) so the host-scoped
      // key stays the sole cache identity - `request` is stable module state, not
      // a key input, and inlining it would trip the query plugin's exhaustive-deps
      // check (mirrors `resolve-artifact-by-path.ts`). Boundary-wrapped: this
      // writes the same cache slot the `HostRpcError`-typed provider observers
      // read, so mapper/cool-down throws must not leak a foreign error shape.
      function queryFn(): Promise<ProviderRateLimitEnvelope> {
        return withHostQueryErrorBoundary(
          "host.getRateLimitUsage",
          async () => {
            // `force` reaches the host only here. An automatic pull sends
            // `false`, which lets the host answer from its own per-profile
            // gauge when a passive live-turn capture (or another caller's
            // pull) already refreshed it inside that lane's floor - no CLI
            // spawn for a number we effectively just read. A click sends
            // `true` and always spawns. Absent (an older negotiated line, or
            // a peer that never learned the field) means force, so this can
            // only ever remove work, never stale a reading.
            const response = await request(
              hostId,
              "host.getRateLimitUsage",
              { ...params, force: opts.force },
              RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
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
          },
        );
      }

      function run(): Promise<ProviderRateLimitEnvelope | undefined> {
        // Re-checked when this item reaches the front of the lane: an earlier
        // item may have refreshed this exact profile (or entered it into
        // cool-down) while this item waited.
        if (shouldSkipAutomatic()) return Promise.resolve(undefined);
        // `staleTime: 0` is load-bearing: `fetchQuery` inherits the app
        // QueryClient's GLOBAL `staleTime` default (60s in `query-client.ts`)
        // and otherwise serves still-fresh cache without fetching at all.
        return queryClient.fetchQuery({
          queryKey,
          queryFn,
          // This observer-free writer shares a host query key with builder
          // observers. Preserve their latched identity rather than allowing
          // fetchQuery to replace its meta with an unstamped option set.
          meta: stampHostRpcMethod(undefined, "host.getRateLimitUsage"),
          staleTime: 0,
          // Some managed-profile entries are filled by the app-level queue
          // before any surface observes them, so the observer-level Infinity
          // in `providerRateLimitQueryOptions` cannot protect those entries.
          // Keep them until a later fetch replaces them with verified state.
          gcTime: Infinity,
        });
      }

      return {
        pendingKey: rateLimitQueueProfileKey(
          hostId,
          target.providerId,
          target.profileId,
        ),
        run,
      };
    })
    .filter((fetch): fetch is RateLimitQueueFetch => fetch !== null);
  if (fetches.length === 0) return Promise.resolve();

  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const item: RateLimitQueueItem = { fetches, settle };
  for (const fetch of fetches) {
    pendingKeyCounts.set(
      fetch.pendingKey,
      (pendingKeyCounts.get(fetch.pendingKey) ?? 0) + 1,
    );
  }
  if (opts.force) {
    // Straight past the lane - a person is waiting on this one.
    startForcedItem(item);
  } else {
    waitingItems.push(item);
    notify();
    pump();
  }
  return settled;
}

/**
 * Runs one item's pulls concurrently. Every fetch is caught individually so one
 * profile's failure never blocks the rest of its own batch (nor, for a lane
 * item, a later item), and the per-fetch response budget bounds how long a
 * wedged probe can last.
 */
function runFetches(item: RateLimitQueueItem): Promise<unknown> {
  return Promise.all(
    item.fetches.map((fetch) => fetch.run().catch(() => undefined)),
  );
}

/** Drops an item's pending counts and resolves its enqueuer's promise. */
function release(item: RateLimitQueueItem): void {
  for (const fetch of item.fetches) {
    const remaining = (pendingKeyCounts.get(fetch.pendingKey) ?? 1) - 1;
    if (remaining <= 0) pendingKeyCounts.delete(fetch.pendingKey);
    else pendingKeyCounts.set(fetch.pendingKey, remaining);
  }
  item.settle();
}

/**
 * Runs a user-initiated item immediately, outside the lane. Registered before it
 * starts so the notification its own click observes already reports the profile
 * as pending.
 */
function startForcedItem(item: RateLimitQueueItem): void {
  runningForcedItems.add(item);
  notify();
  void runFetches(item).finally(() => {
    runningForcedItems.delete(item);
    release(item);
    notify();
    // Automatic work deferred while this ran may now start.
    pump();
  });
}

/**
 * Starts the next waiting automatic item if the lane is idle AND nothing a
 * person asked for is in flight - background spawns must not stack up behind a
 * click. Automatic items re-check freshness at their turn, so a forced pull that
 * just refreshed the same profile makes the deferred one skip outright.
 */
function pump(): void {
  if (runningItem !== null || runningForcedItems.size > 0) return;
  const next = waitingItems.shift();
  if (next === undefined) return;
  runningItem = next;
  void runFetches(next).finally(() => {
    runningItem = null;
    release(next);
    notify();
    pump();
  });
}

/**
 * Test-only reset of the module-global lane state so each test starts from a
 * clean queue (no bound host, empty lane, nothing pending, no listeners, no
 * standing cool-downs).
 */
export function __resetRateLimitQueueForTests(): void {
  deps = null;
  waitingItems.length = 0;
  runningItem = null;
  runningForcedItems.clear();
  pendingKeyCounts.clear();
  listeners.clear();
  cooldownUntil.clear();
}
