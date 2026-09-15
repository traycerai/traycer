import {
  hashKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { providersMutationKeys, queryKeys } from "@/lib/query-keys";

/**
 * Per-host receipts for the welcome modal's roster (`useWelcomeRoster`):
 * how many `providers.setEnabled` calls aimed at a host have succeeded
 * (`required`), which of those the host's `providers.list` has been read
 * AFTER (`satisfied`), and the bookkeeping between.
 *
 * Driven by the query client's own caches, not by React. A tracker attaches
 * to a client's mutation and query caches while anyone is subscribed and
 * folds their events:
 *
 * - a `setEnabled` mutation reaching `success` whose captured context names
 *   host H bumps `required[H]` - a counter this module owns, so the cache
 *   garbage-collecting old mutations cannot lower it;
 * - the list query for H starting a fetch stamps `fetchStart[H] =
 *   required[H]`; that fetch completing successfully sets `satisfied[H] =
 *   fetchStart[H]` - a fetch credits the generation it STARTED under, so a
 *   toggle that lands while it is in flight is still owed a read.
 *
 * Cache events are delivered whether or not React renders in between, so a
 * fetch that starts and lands inside one render interval is still receipted.
 *
 * The refetch a toggle invalidates into starts inside the mutation's
 * `onSuccess`, before its status flips, so it is stamped with the previous
 * generation and is not a receipt. The tracker asks for one more fetch
 * itself once the list is idle again - once per `required` value, never
 * over an error (the page's Retry is the move there), guarded here so the
 * two hook instances (the modal and its page) cannot double-ask.
 *
 * In memory, per query client, and reset when the last subscriber leaves:
 * a receipt is a fact about a cache while something is watching it.
 */
export interface WelcomeRosterFreshness {
  /** Successful toggles aimed at this host since the tracker attached. */
  readonly required: number;
  /** The generation the most recent fetch of this host's list started under. */
  readonly fetchStart: number;
  /** The generation the most recent SUCCESSFUL fetch had started under. */
  readonly satisfied: number;
  /** The `required` value the tracker last asked for a fetch of its own for. */
  readonly nudgedFor: number;
}

const UNTOUCHED: WelcomeRosterFreshness = {
  required: 0,
  fetchStart: 0,
  satisfied: 0,
  nudgedFor: 0,
};

/** The roster query's key: the app-wide `providers.list` for `hostId`. */
export function welcomeRosterQueryKey(hostId: string): QueryKey {
  return queryKeys.hostMethod<HostRpcRegistry, "providers.list">(
    hostId,
    "providers.list",
    { native: null },
  );
}

const SET_ENABLED_MUTATION_HASH = hashKey(providersMutationKeys.setEnabled());

/**
 * The host a `useHostScopedMutation` captured at `onMutate` - its context is
 * `{ hostId, captured }` - read without trusting the shape: a mutation that
 * carries none names no host and counts for no roster.
 */
function contextHostId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  if (!("hostId" in context)) return null;
  const { hostId } = context;
  return typeof hostId === "string" ? hostId : null;
}

class WelcomeRosterFreshnessTracker {
  private readonly byHost = new Map<string, WelcomeRosterFreshness>();
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;

  constructor(private readonly queryClient: QueryClient) {}

  read(hostId: string | null): WelcomeRosterFreshness {
    if (hostId === null) return UNTOUCHED;
    return this.byHost.get(hostId) ?? UNTOUCHED;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.detach === null) this.attach();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0 || this.detach === null) return;
      this.detach();
      this.detach = null;
      this.byHost.clear();
    };
  }

  private attach(): void {
    const mutations = this.queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") {
        return;
      }
      const key = event.mutation.options.mutationKey;
      if (key === undefined || hashKey(key) !== SET_ENABLED_MUTATION_HASH) {
        return;
      }
      const hostId = contextHostId(event.mutation.state.context);
      if (hostId === null) return;
      const current = this.read(hostId);
      this.write(hostId, { ...current, required: current.required + 1 });
      this.nudgeIfOwed(hostId);
    });
    const queries = this.queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const hostId = rosterHostOf(event.query.queryKey);
      if (hostId === null) return;
      if (event.query.queryHash !== hashKey(welcomeRosterQueryKey(hostId))) {
        return;
      }
      const current = this.read(hostId);
      switch (event.action.type) {
        // A start, and a resumption: a fetch paused offline has read nothing
        // yet, so what it reads once it continues is what it is stamped by.
        case "fetch":
        case "continue":
          this.write(hostId, { ...current, fetchStart: current.required });
          return;
        case "success":
          // `setQueryData` is a success action too (`manual`), and it is
          // not a read of the host.
          if (event.action.manual === true) return;
          this.write(hostId, { ...current, satisfied: current.fetchStart });
          this.nudgeIfOwed(hostId);
          return;
        case "error":
          this.nudgeIfOwed(hostId);
          return;
        default:
          return;
      }
    });
    this.detach = () => {
      mutations();
      queries();
    };
  }

  /**
   * Ask for the one fetch the receipt rule cannot get from the invalidation
   * refetch (see the module comment). Only when nothing is in flight and
   * the last read did not fail, only once per `required` value, and never
   * when a fetch stamped with the current generation has already started.
   */
  private nudgeIfOwed(hostId: string): void {
    const current = this.read(hostId);
    if (current.required <= current.satisfied) return;
    if (current.fetchStart >= current.required) return;
    if (current.nudgedFor >= current.required) return;
    const query = this.queryClient
      .getQueryCache()
      .find({ queryKey: welcomeRosterQueryKey(hostId), exact: true });
    if (query === undefined) return;
    if (query.state.fetchStatus !== "idle" || query.state.status === "error") {
      return;
    }
    this.write(hostId, { ...current, nudgedFor: current.required });
    void this.queryClient.refetchQueries({
      queryKey: welcomeRosterQueryKey(hostId),
      exact: true,
    });
  }

  private write(hostId: string, next: WelcomeRosterFreshness): void {
    this.byHost.set(hostId, next);
    for (const listener of this.listeners) listener();
  }
}

/**
 * `["host", hostId, "providers.list", …]` → hostId; anything else → null.
 * Takes `unknown`: the cache event's query is untyped, and a key is only a
 * key once it has been looked at.
 */
function rosterHostOf(queryKey: unknown): string | null {
  if (!Array.isArray(queryKey)) return null;
  const key: ReadonlyArray<unknown> = queryKey;
  if (key[0] !== "host" || key[2] !== "providers.list") return null;
  const hostId = key[1];
  return typeof hostId === "string" ? hostId : null;
}

const trackers = new WeakMap<QueryClient, WelcomeRosterFreshnessTracker>();

/** One tracker per query client, created on first use. */
export function welcomeRosterFreshnessFor(
  queryClient: QueryClient,
): Pick<WelcomeRosterFreshnessTracker, "read" | "subscribe"> {
  const existing = trackers.get(queryClient);
  if (existing !== undefined) return existing;
  const created = new WelcomeRosterFreshnessTracker(queryClient);
  trackers.set(queryClient, created);
  return created;
}
