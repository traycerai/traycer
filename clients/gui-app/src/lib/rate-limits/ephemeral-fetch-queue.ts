import type { QueryClient } from "@tanstack/react-query";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { isRateLimitReadStillRunningOnHost } from "@/lib/rate-limits/rate-limit-read-status";
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
  RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS,
  RATE_LIMIT_READ_FOLLOW_UP_LIMIT,
  RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
} from "@/lib/rate-limits/rate-limit-timing";

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

/**
 * The transport call one queued pull makes. `responseTimeoutMs` is the frame
 * budget this lane needs (`RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS`); the binding
 * site forwards it to `requestWithResponseTimeout`, because the transport's
 * 30s default is exactly the host's *default* probe budget and so discarded
 * every slow-but-successful claude probe client-side.
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
  /** Re-read this target from the host gauge cache. See `scheduleReadFollowUp`. */
  readonly followUp: () => void;
}

const pendingTargets = new Map<string, PendingRateLimitTarget>();

/**
 * Targets whose next pull is a FOLLOW-UP to a read we stopped waiting for, and
 * must therefore ignore the freshness floor. Without this the follow-up
 * silently no-ops whenever the last successful read is still inside the floor -
 * precisely the impatient-refresh case it exists to rescue.
 */
const followUpDue = new Set<string>();

/** Consecutive follow-ups spent per target; cleared on any completed read. */
const followUpAttempts = new Map<string, number>();
// `window.setTimeout` (not the ambient one) so the handle is a plain number,
// matching how the poll interval is held in `rate-limit-queue-provider`.
const followUpTimers = new Map<string, number>();

function scheduleReadFollowUp(
  target: PendingRateLimitTarget,
  error: unknown,
): void {
  if (!isRateLimitReadStillRunningOnHost(error)) return;
  if (followUpTimers.has(target.key)) return;
  const spent = followUpAttempts.get(target.key) ?? 0;
  if (spent >= RATE_LIMIT_READ_FOLLOW_UP_LIMIT) return;

  followUpAttempts.set(target.key, spent + 1);
  const timer = window.setTimeout(() => {
    followUpTimers.delete(target.key);
    target.followUp();
  }, RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS);
  followUpTimers.set(target.key, timer);
}

/** Drop any pending follow-up for a key whose read has since completed. */
function clearReadFollowUp(key: string): void {
  const timer = followUpTimers.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    followUpTimers.delete(key);
  }
  followUpAttempts.delete(key);
}

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

/**
 * Whether this target's queued pull is ALREADY forced - i.e. a user asked for
 * it, rather than the background sweep enqueuing it.
 *
 * A control uses this to tell the two queued states apart. An automatic queued
 * item must stay clickable, because that click is what promotes it
 * (`pending.force = true`) and stops the pull being skipped by its second
 * freshness/cool-down check or served from the host gauge cache. Once it IS
 * forced, a further click can add nothing, so the control should show pending
 * instead of sitting idle while the user waits behind the lane.
 */
export function isRateLimitQueueTargetForced(
  hostId: string,
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  return (
    pendingTargets.get(rateLimitQueueProfileKey(hostId, providerId, profileId))
      ?.force ?? false
  );
}

/**
 * Whether this target's follow-up budget is spent with nothing left in flight -
 * i.e. we stopped waiting on a read, already spent the one delayed collection
 * `scheduleReadFollowUp` allows, and that collection ALSO came back unheard.
 *
 * This is the limit of the "something will come back for it" reasoning that
 * lets `isRateLimitQueryFailure` hide a still-running read. Once
 * `scheduleReadFollowUp` declines a further attempt, nothing is scheduled to
 * collect the answer, so continuing to suppress would leave a stale reading on
 * screen looking healthy until some later poll happens along - the same
 * silent-staleness the `queueOwned` arm rules out for the `httpFetch` lanes,
 * one level deeper.
 *
 * Derived from the three registries rather than a fourth flag, so it cannot
 * drift from the scheduler that owns the budget. Each clause is what keeps the
 * transitions from flashing a failure the moment before a retry:
 *
 * - `attempts >= LIMIT` - the budget is spent. Absent (0) on a first failure,
 *   which is why the initial "still running" read stays suppressed.
 * - `!followUpTimers.has` - the delayed collection is not still waiting to run.
 * - `!pendingTargets.has` - and it is not on the wire right now. Without this
 *   the window between the timer firing and the follow-up settling would read
 *   as exhausted and surface a failure DURING its own retry.
 *
 * So it turns true only after the follow-up has settled unheard, which
 * `settlePendingTarget` publishes via `notifyTargets`. A `null` scope at
 * follow-up time never enqueues, so the key never reappears in `pendingTargets`
 * and this reports exhausted - correct, since an unconfigured queue is exactly
 * the case where nothing is coming back.
 */
export function isRateLimitReadFollowUpExhausted(
  hostId: string,
  providerId: RateLimitProviderId,
  profileId: string | null,
): boolean {
  const key = rateLimitQueueProfileKey(hostId, providerId, profileId);
  return (
    (followUpAttempts.get(key) ?? 0) >= RATE_LIMIT_READ_FOLLOW_UP_LIMIT &&
    !followUpTimers.has(key) &&
    !pendingTargets.has(key)
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
  // One-shot: the bypass covers exactly the pull it was set for.
  followUpDue.delete(target.key);
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
    clearReadFollowUp(target.key);
  } catch (error) {
    // TanStack keeps the normalized failure on this target's cache entry.
    // Swallow it here so one profile cannot poison the shared serial lane.
    //
    // A response timeout is not a failed read though - the host is still
    // running the probe and will capture it. Collect it shortly rather than
    // leaving the user with a refresh that visibly failed and silently
    // succeeded later.
    scheduleReadFollowUp(target, error);
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
      // Manual intent upgrades QUEUED automatic work in place - it has not
      // reached the wire yet, so flipping the flag is enough.
      if (opts.force && pending.phase === "queued") {
        if (!pending.force) {
          pending.force = true;
          // Publish it. Subscribers snapshot this flag through
          // `subscribeRateLimitQueueTargets` (`useIsRateLimitQueueTargetForced`),
          // and mutating in place without notifying leaves a promoted target
          // still reading as unforced - so the control that was just clicked
          // stays "clickable, nothing pending" until some unrelated queue event
          // happens to notify. The phase does not change here, which is exactly
          // why nothing else publishes it for us.
          notifyTargets();
        }
        joinedPromises.push(pending.promise);
        continue;
      }

      // Past that point the request is on the wire, so what matters is what IT
      // carries, not what phase it is in.
      //
      // Joining an already-FORCED pull stays correct: its result is a real
      // probe, which is exactly what this caller asked for, and reissuing would
      // spawn a redundant CLI subprocess for an answer already coming. That is
      // the remount/double-click case the serial lane exists to collapse.
      //
      // Joining an AUTOMATIC one is not. It travels as `force: false`, so a v4
      // host may answer it from its gauge cache - handing back a reading up to
      // the host read floor old when the caller asked to bypass exactly that.
      // The refresh controls disable while their own target is fetching, but a
      // non-button caller still reaches here: consuming a Codex rate-limit
      // reset credit forces a re-read, and answering THAT from cache shows the
      // pre-reset numbers the user just paid to clear.
      //
      // So chain a fresh forced pull behind an automatic one.
      // `settlePendingTarget` deletes the registry entry BEFORE resolving this
      // promise, so the continuation always finds an empty slot and enqueues a
      // real item rather than re-joining this branch.
      if (opts.force && !pending.force) {
        joinedPromises.push(
          pending.promise
            .then(() =>
              enqueueRateLimitFetchBatchForScope(scope, [target], {
                force: true,
              }),
            )
            .then(() => undefined),
        );
        continue;
      }

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
      // A follow-up is collecting a probe we already paid for, so neither the
      // freshness floor nor the cool-down applies: both exist to stop
      // SPECULATIVE automatic work, and this reading is already sitting in the
      // host's gauge cache waiting to be picked up.
      if (followUpDue.has(targetKey)) return false;
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
        // `force` reaches the host only here - deliberately NOT in `params`,
        // which is this pull's cache identity above. Were it keyed, a user's
        // forced click would occupy a different slot from the automatic lane's
        // and the two would stop de-duplicating. Read from the registry rather
        // than the captured `opts` so a pull promoted to forced while queued
        // (see `pending.force = true`) travels as forced. An absent field on a
        // released peer that never learned it still means force, so an older
        // host is unaffected.
        const forced = pendingTargets.get(targetKey)?.force ?? opts.force;
        const response = await request(
          hostId,
          "host.getRateLimitUsage",
          { ...params, force: forced },
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
      followUp: () => {
        followUpDue.add(targetKey);
        void enqueueRateLimitFetchBatchForScope(scope, [target], {
          force: false,
        });
      },
      fetch: () =>
        queryClient.fetchQuery({
          queryKey,
          queryFn,
          // The registry owns freshness and force semantics. Once a target
          // reaches this point, TanStack must invoke queryFn.
          staleTime: 0,
          // This queue owns recovery, so TanStack must not also attempt it.
          // The app-wide default retries every non-`RetryableTransportError`
          // once, and the failure this lane expects most - the response budget
          // elapsing on a read the host is still running - is exactly that. A
          // retry there re-sends the SAME forced CLI probe while the first may
          // still be completing, holds the serial lane for up to another full
          // budget, and only then reaches the catch that schedules the single
          // delayed gauge read. One cheap cache read is the recovery; a second
          // subprocess is the thing this lane exists to prevent.
          retry: false,
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
  for (const timer of followUpTimers.values()) window.clearTimeout(timer);
  followUpTimers.clear();
  followUpAttempts.clear();
  followUpDue.clear();
}
