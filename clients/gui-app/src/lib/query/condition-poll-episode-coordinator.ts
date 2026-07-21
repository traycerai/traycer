import {
  CancelledError,
  type QueryCacheNotifyEvent,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { backoffFor } from "@traycer-clients/shared/host-transport/backoff";
import {
  HOST_METHOD_POLL_TABLE,
  type ConditionPollLane,
  type ErasedConditionPollPolicy,
} from "@/lib/host-rpc-policy/host-method-policy-table";

type HostRpcMethod = keyof typeof HOST_METHOD_POLL_TABLE;
type CacheQuery = QueryCacheNotifyEvent["query"];
type CacheObserver = Extract<
  QueryCacheNotifyEvent,
  { type: "observerAdded" }
>["observer"];

export type ConditionPollRefetchInterval = (
  query: CacheQuery,
) => number | false | undefined;

type EpisodeState = {
  readonly subscribedObservers: Set<CacheObserver>;
  readonly activeObservers: Set<CacheObserver>;
  readonly laneAttempts: Map<string, number>;
  currentLaneId: string | null;
  currentDelayMs: number | false;
  lastDataUpdateCount: number;
  lastErrorUpdateCount: number;
};

const coordinatorByClient = new WeakMap<
  QueryClient,
  ConditionPollEpisodeCoordinator
>();

const shouldAssertPolicy =
  import.meta.env.DEV || import.meta.env.MODE === "test";

/**
 * Owns condition-poll attempts for one QueryClient. Query metadata is only
 * used to latch a query's method once; aggregate polling ownership lives in
 * QueryCache observer events so unmount/remount transitions remain visible.
 */
export class ConditionPollEpisodeCoordinator {
  private readonly latchedMethods = new WeakMap<CacheQuery, HostRpcMethod>();
  private readonly episodes = new Map<CacheQuery, EpisodeState>();
  private readonly intervalByMethod = new Map<
    HostRpcMethod,
    ConditionPollRefetchInterval
  >();
  private readonly brandedMethodByInterval = new WeakMap<
    ConditionPollRefetchInterval,
    HostRpcMethod
  >();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly client: QueryClient) {
    this.unsubscribe = client
      .getQueryCache()
      .subscribe((event) => this.handleCacheEvent(event));
  }

  /**
   * Returns the only condition-poll interval callback accepted by this
   * coordinator for a table method. Its implementation is a pure delay read.
   */
  refetchIntervalFor(method: HostRpcMethod): ConditionPollRefetchInterval {
    this.requireConditionPolicy(method);

    const existing = this.intervalByMethod.get(method);
    if (existing !== undefined) return existing;

    const interval: ConditionPollRefetchInterval = (query) =>
      this.currentDelayFor(query, method);
    this.intervalByMethod.set(method, interval);
    this.brandedMethodByInterval.set(interval, method);
    return interval;
  }

  /** Resets one query before an explicit refresh is submitted. */
  resetQuery(query: CacheQuery): void {
    const method = this.latchedMethods.get(query);
    const episode = this.episodes.get(query);
    if (method === undefined || episode === undefined) return;
    if (episode.activeObservers.size === 0) return;

    this.beginEpisode(query, episode, this.requireConditionPolicy(method));
  }

  /**
   * Query-key form of resetQuery for imperative refresh producers that do not
   * retain the Query instance.
   */
  resetQueryByKey(queryKey: QueryKey): void {
    const query = this.client.getQueryCache().find({ queryKey, exact: true });
    if (query !== undefined) this.resetQuery(query);
  }

  /**
   * Clears active host-scoped condition episodes when the host/auth authority
   * domain changes. `null` follows hostQueryKeys.scope(null): all host keys.
   */
  resetHostScope(hostId: string | null): void {
    this.episodes.forEach((episode, query) => {
      if (!matchesHostScope(query.queryKey, hostId)) return;
      if (episode.activeObservers.size === 0) return;

      const method = this.latchedMethods.get(query);
      if (method === undefined) return;
      this.beginEpisode(query, episode, this.requireConditionPolicy(method));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.episodes.clear();
    this.intervalByMethod.clear();
    if (coordinatorByClient.get(this.client) === this) {
      coordinatorByClient.delete(this.client);
    }
  }

  private handleCacheEvent(event: QueryCacheNotifyEvent): void {
    if (this.disposed) return;

    if (event.type === "removed") {
      this.latchedMethods.delete(event.query);
      this.episodes.delete(event.query);
      return;
    }

    // Removal changes aggregate ownership only. It must not re-read mutable
    // meta and turn cleanup after an already-surfaced identity violation into
    // another assertion failure.
    if (event.type === "observerRemoved") {
      this.handleObserverRemoved(event.query, event.observer);
      return;
    }

    const method = this.latchMethod(event.query);

    switch (event.type) {
      case "observerAdded":
        this.handleObserverAdded(event.query, event.observer, method);
        return;
      case "observerOptionsUpdated":
        this.handleObserverOptionsUpdated(event.query, event.observer, method);
        return;
      case "updated":
        this.handleSettlement(event.query, method);
        return;
      default:
        return;
    }
  }

  private latchMethod(query: CacheQuery): HostRpcMethod | undefined {
    const stampedMethod = readStampedHostRpcMethod(query);
    const latchedMethod = this.latchedMethods.get(query);

    if (latchedMethod === undefined) {
      if (stampedMethod !== undefined) {
        this.latchedMethods.set(query, stampedMethod);
      }
      return stampedMethod;
    }

    // The latch - not the stamp - is the stable identity. `query.options.meta`
    // is TanStack last-writer state, so a later UNSTAMPED writer on the same
    // hash (a raw `useQueries` leg like worktree enrichment's batched transport,
    // or an imperative `fetchQuery`/`ensureQueryData`) legitimately clears it to
    // `undefined`. That is an absent opinion, not a changed method: fall back to
    // the latch. Only a DIFFERENT concrete method - reachable solely via a
    // custom `cacheKeyIdentity` that drops the method from the hash - is a real
    // one-hash-two-methods violation worth crashing on.
    this.assertPolicy(
      stampedMethod === undefined || stampedMethod === latchedMethod,
      `Query ${query.queryHash} changed hostRpcMethod from ${latchedMethod} to ${stampedMethod}. A query hash maps to exactly one host RPC method.`,
    );
    return latchedMethod;
  }

  private handleObserverAdded(
    query: CacheQuery,
    observer: CacheObserver,
    method: HostRpcMethod | undefined,
  ): void {
    this.assertObserverPolicy(query, observer, method);

    const brandedMethod = this.brandedMethodFor(observer);
    if (method === undefined) return;
    const policy = HOST_METHOD_POLL_TABLE[method].poll;
    if (policy === null || policy.kind !== "condition") return;
    if (brandedMethod !== undefined && brandedMethod !== method) return;

    const episode = this.getEpisode(query);
    episode.subscribedObservers.add(observer);
    this.updateObserverActivity(query, observer, episode, method);
  }

  private handleObserverRemoved(
    query: CacheQuery,
    observer: CacheObserver,
  ): void {
    const episode = this.episodes.get(query);
    if (episode === undefined) return;

    const wasActive = episode.activeObservers.size > 0;
    episode.subscribedObservers.delete(observer);
    episode.activeObservers.delete(observer);
    if (wasActive && episode.activeObservers.size === 0) {
      // Preserve counters while dormant. A real 0 -> 1 remount clears them.
      episode.currentDelayMs = false;
    }
  }

  private handleObserverOptionsUpdated(
    query: CacheQuery,
    observer: CacheObserver,
    method: HostRpcMethod | undefined,
  ): void {
    this.assertObserverPolicy(query, observer, method);

    const episode = this.episodes.get(query);
    if (episode === undefined) return;
    if (!episode.subscribedObservers.has(observer)) return;

    const brandedMethod = this.brandedMethodFor(observer);
    if (brandedMethod === undefined || method === undefined) {
      this.updateObserverActivity(query, observer, episode, undefined);
      return;
    }
    this.updateObserverActivity(query, observer, episode, method);
  }

  private updateObserverActivity(
    query: CacheQuery,
    observer: CacheObserver,
    episode: EpisodeState,
    method: HostRpcMethod | undefined,
  ): void {
    const wasActive = episode.activeObservers.size > 0;
    const brandedMethod = this.brandedMethodFor(observer);
    const isActive =
      method !== undefined &&
      brandedMethod === method &&
      isObserverEnabled(observer, query);

    if (isActive) {
      episode.activeObservers.add(observer);
    } else {
      episode.activeObservers.delete(observer);
    }

    if (
      !wasActive &&
      episode.activeObservers.size > 0 &&
      method !== undefined
    ) {
      this.beginEpisode(query, episode, this.requireConditionPolicy(method));
    }

    if (wasActive && episode.activeObservers.size === 0) {
      // A dormant episode never schedules work until a branded observer owns it.
      episode.currentDelayMs = false;
    }
  }

  private handleSettlement(
    query: CacheQuery,
    method: HostRpcMethod | undefined,
  ): void {
    if (method === undefined) return;
    const episode = this.episodes.get(query);
    if (episode === undefined) return;

    this.advanceUnprocessedSettlement(query, method, episode);
  }

  /**
   * Advances at most once per Query version. QueryObserver reads the branded
   * interval before QueryCache emits `updated`, so both paths call this helper:
   * the interval read applies the current settlement's delay to TanStack's
   * timer, and the cache event remains an idempotent fallback.
   */
  private advanceUnprocessedSettlement(
    query: CacheQuery,
    method: HostRpcMethod,
    episode: EpisodeState,
  ): void {
    const policy = HOST_METHOD_POLL_TABLE[method].poll;
    if (policy === null || policy.kind !== "condition") return;
    if (episode.activeObservers.size === 0) return;

    const dataUpdateCount = query.state.dataUpdateCount;
    const errorUpdateCount = query.state.errorUpdateCount;
    const dataChanged = dataUpdateCount !== episode.lastDataUpdateCount;
    const errorChanged = errorUpdateCount !== episode.lastErrorUpdateCount;
    if (!dataChanged && !errorChanged) return;

    episode.lastDataUpdateCount = dataUpdateCount;
    episode.lastErrorUpdateCount = errorUpdateCount;

    if (errorChanged) {
      this.advanceErrorSettlement(query, episode, policy);
      return;
    }

    if (dataChanged) this.advanceDataSettlement(query, episode, policy);
  }

  private advanceErrorSettlement(
    query: CacheQuery,
    episode: EpisodeState,
    policy: ErasedConditionPollPolicy<HostRpcMethod>,
  ): void {
    if (query.state.error === null) return;
    if (isExpectedControlFlowError(query.state.error)) return;

    const lane =
      query.state.data === undefined
        ? policy.initialErrorLane
        : policy.staleDataErrorLane;
    if (query.state.data === undefined && episode.currentLaneId !== lane.id) {
      this.clearEpisodeCounters(episode);
    }
    this.enterLane(episode, lane, policy);
  }

  private advanceDataSettlement(
    query: CacheQuery,
    episode: EpisodeState,
    policy: ErasedConditionPollPolicy<HostRpcMethod>,
  ): void {
    if (query.state.data === undefined) return;
    const lane = policy.classify(query.state.data);
    if (lane === false) {
      this.clearEpisodeCounters(episode);
      return;
    }
    this.enterLane(episode, lane, policy);
  }

  private beginEpisode(
    query: CacheQuery,
    episode: EpisodeState,
    policy: ErasedConditionPollPolicy<HostRpcMethod>,
  ): void {
    this.clearEpisodeCounters(episode);
    episode.lastDataUpdateCount = query.state.dataUpdateCount;
    episode.lastErrorUpdateCount = query.state.errorUpdateCount;

    if (query.state.data !== undefined) {
      const lane = policy.classify(query.state.data);
      if (lane !== false) this.primeLane(episode, lane);
      return;
    }

    if (
      query.state.error !== null &&
      !isExpectedControlFlowError(query.state.error)
    ) {
      this.primeLane(episode, policy.initialErrorLane);
    }
  }

  /**
   * Starts a fresh episode from already-cached state without consuming an
   * attempt. The next new Query version is therefore still attempt zero.
   */
  private primeLane(episode: EpisodeState, lane: ConditionPollLane): void {
    episode.currentLaneId = lane.id;
    episode.currentDelayMs = backoffFor(
      0,
      lane.initialDelayMs,
      lane.maxDelayMs,
    );
  }

  private enterLane(
    episode: EpisodeState,
    lane: ConditionPollLane,
    policy: ErasedConditionPollPolicy<HostRpcMethod>,
  ): void {
    if (policy.resetLaneIds.has(lane.id)) {
      this.clearEpisodeCounters(episode);
    }

    const previousAttempt = episode.laneAttempts.get(lane.id);
    const attempt = previousAttempt === undefined ? 0 : previousAttempt + 1;
    episode.laneAttempts.set(lane.id, attempt);
    episode.currentLaneId = lane.id;
    episode.currentDelayMs = backoffFor(
      attempt,
      lane.initialDelayMs,
      lane.maxDelayMs,
    );
  }

  private clearEpisodeCounters(episode: EpisodeState): void {
    episode.laneAttempts.clear();
    episode.currentLaneId = null;
    episode.currentDelayMs = false;
  }

  private currentDelayFor(
    query: CacheQuery,
    method: HostRpcMethod,
  ): number | false {
    if (this.latchedMethods.get(query) !== method) return false;

    const episode = this.episodes.get(query);
    if (episode === undefined || episode.activeObservers.size === 0) {
      return false;
    }
    this.advanceUnprocessedSettlement(query, method, episode);
    return episode.currentDelayMs;
  }

  private brandedMethodFor(observer: CacheObserver): HostRpcMethod | undefined {
    const interval = observer.options.refetchInterval;
    return typeof interval === "function"
      ? this.brandedMethodByInterval.get(interval)
      : undefined;
  }

  private assertObserverPolicy(
    query: CacheQuery,
    observer: CacheObserver,
    method: HostRpcMethod | undefined,
  ): void {
    if (
      !isHostPrefixedQuery(query) ||
      !isPollingInterval(observer.options.refetchInterval)
    ) {
      return;
    }

    this.assertPolicy(
      method !== undefined,
      `Polling host query ${query.queryHash} is missing a hostRpcMethod stamp.`,
    );
    if (method === undefined) return;

    const brandedMethod = this.brandedMethodFor(observer);
    if (brandedMethod !== undefined) {
      this.assertPolicy(
        method === brandedMethod,
        `Branded condition poller on ${query.queryHash} is missing a matching hostRpcMethod stamp.`,
      );
      this.assertPolicy(
        observer.options.retry === false,
        `Condition poller ${brandedMethod} on ${query.queryHash} must set retry: false.`,
      );
      return;
    }

    const policy = HOST_METHOD_POLL_TABLE[method].poll;
    if (policy === null) {
      this.assertPolicy(
        false,
        `Host query ${method} on ${query.queryHash} does not declare polling.`,
      );
      return;
    }

    if (policy.kind === "condition") {
      this.assertPolicy(
        false,
        `Condition poller ${method} on ${query.queryHash} must use its coordinator-branded refetchInterval.`,
      );
      return;
    }

    this.assertPolicy(
      observer.options.refetchInterval === policy.intervalMs &&
        observer.options.refetchIntervalInBackground === false,
      `Fixed poller ${method} on ${query.queryHash} must use its table interval and refetchIntervalInBackground: false.`,
    );
  }

  private getEpisode(query: CacheQuery): EpisodeState {
    const existing = this.episodes.get(query);
    if (existing !== undefined) return existing;

    const episode: EpisodeState = {
      subscribedObservers: new Set(),
      activeObservers: new Set(),
      laneAttempts: new Map(),
      currentLaneId: null,
      currentDelayMs: false,
      lastDataUpdateCount: 0,
      lastErrorUpdateCount: 0,
    };
    this.episodes.set(query, episode);
    return episode;
  }

  private requireConditionPolicy(
    method: HostRpcMethod,
  ): ErasedConditionPollPolicy<HostRpcMethod> {
    const policy = HOST_METHOD_POLL_TABLE[method].poll;
    if (policy === null || policy.kind !== "condition") {
      throw new Error(`${method} does not declare condition polling.`);
    }
    return policy;
  }

  private assertPolicy(condition: boolean, message: string): void {
    if (shouldAssertPolicy && !condition) {
      throw new Error(`[condition-poll] ${message}`);
    }
  }
}

/** Returns the QueryClient-scoped coordinator, installing it exactly once. */
export function getConditionPollEpisodeCoordinator(
  client: QueryClient,
): ConditionPollEpisodeCoordinator {
  const existing = coordinatorByClient.get(client);
  if (existing !== undefined) return existing;

  const coordinator = new ConditionPollEpisodeCoordinator(client);
  coordinatorByClient.set(client, coordinator);
  return coordinator;
}

export const installConditionPollEpisodeCoordinator =
  getConditionPollEpisodeCoordinator;

function readStampedHostRpcMethod(
  query: CacheQuery,
): HostRpcMethod | undefined {
  const meta = query.options.meta;
  if (!isRecord(meta)) return undefined;

  const method = meta.hostRpcMethod;
  return isHostRpcMethod(method) ? method : undefined;
}

function isHostRpcMethod(value: unknown): value is HostRpcMethod {
  return (
    typeof value === "string" && Object.hasOwn(HOST_METHOD_POLL_TABLE, value)
  );
}

function isObserverEnabled(
  observer: CacheObserver,
  query: CacheQuery,
): boolean {
  const { enabled } = observer.options;
  return typeof enabled === "function" ? enabled(query) : enabled !== false;
}

function isPollingInterval(value: unknown): boolean {
  return (
    typeof value === "function" || (typeof value === "number" && value > 0)
  );
}

function isHostPrefixedQuery(query: CacheQuery): boolean {
  return hasHostScopePrefix(query.queryKey);
}

function hasHostScopePrefix(queryKey: unknown): boolean {
  return Array.isArray(queryKey) && queryKey[0] === "host";
}

function isExpectedControlFlowError(error: unknown): boolean {
  if (error instanceof CancelledError) return true;
  return error instanceof Error && error.name === "AbortError";
}

function matchesHostScope(queryKey: unknown, hostId: string | null): boolean {
  if (!Array.isArray(queryKey)) return false;
  if (queryKey[0] !== "host") return false;
  return hostId === null || queryKey[1] === hostId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
