import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { FLEET_ACTIVE_POLL_MS } from "@/lib/host/fleet-update/fleet-poll-policy";
import {
  warrantsFastPoll,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * While — and only while — a host reports a genuinely running operation,
 * refresh its `host.status` at the active cadence.
 *
 * WHY THIS IS NOT IN THE SHARED POLL TABLE, since that is the obvious place and
 * the wrong one. `host.status`'s table entry is `{kind:"fixed", intervalMs:
 * 10_000}`, and a condition policy — the table's mechanism for "poll faster
 * while X holds" — classifies to a lane OR to `false`, where `false` means no
 * polling at all. Converting the entry would therefore delete the 10s baseline
 * for every other consumer whenever no update is running, and that baseline is
 * load-bearing elsewhere: the Overview's drain affordance sets `staleTime` to
 * 30s specifically so a healthy 10s poll keeps `isStale` false, and demotes the
 * count it destroys work with to `null` when it does not. Trading that for a
 * banner's frame rate would be a regression in the one place this codebase most
 * wants a live number.
 *
 * So the accelerator is additive and scoped. It is bounded by construction
 * rather than by a timer budget: {@link warrantsFastPoll} refuses every parked,
 * terminal and qualified view, so the fast cadence exists only during an
 * operation that is actually moving — which is finite, user-visible, and
 * exactly when everyone reading this key wants fresher data.
 *
 * Invalidating the shared key (rather than holding a private fast query) is
 * deliberate: one key, one answer, and the acceleration benefits every surface
 * reading that host identically.
 *
 * ⚠ IT IS ALSO WHAT KEEPS FRESHNESS HONEST, which is why it moved out of the
 * landing banner's hook and became shared. An observation's staleness deadline
 * is derived from the cadence its view earns — about five seconds for an active
 * operation. A surface that projects freshness properly but polls `host.status`
 * at the 10s baseline would therefore mark its own data stale between every
 * pair of polls and blink "(last known)" onto a perfectly live download twice a
 * cadence. The selected-host Overview had exactly that shape the moment its
 * synthetic infinite freshness was removed, so it now runs this too: the
 * deadline and the poll that is supposed to beat it come from one place.
 */
interface AcceleratorEntry {
  count: number;
  readonly timer: ReturnType<typeof setInterval>;
}

/**
 * One timer per (query client, host) — NOT per mounted consumer.
 *
 * The acceleration is a property of the HOST's operation, but the hook runs
 * once per surface observing it, and this hook has more than one caller by
 * design (see the note above about the Overview adopting it). With a timer per
 * instance, the landing page mounted behind the Settings modal and an Overview
 * scoped to the same host each invalidated the same `host.status` key on
 * independently-phased intervals, roughly doubling the RPC cadence for the
 * whole length of a download — and it scaled with the number of surfaces, so
 * adding a third observer would have made it worse with no code change.
 *
 * Ref-counted rather than last-one-wins: consumers mount and unmount
 * independently, so the timer must survive any one of them leaving and stop
 * only when the last does. Same shape as the borrow accounting in
 * `active-remote-sessions.ts`, for the same reason.
 *
 * Keyed by the query client FIRST, so a second client (a test, a re-provided
 * provider) never adopts a timer holding a closure over a different client's
 * cache. A `WeakMap` means a discarded client's bucket is collectable rather
 * than a leak keyed by an object nobody holds anymore.
 */
const acceleratorsByClient = new WeakMap<
  QueryClient,
  Map<string, AcceleratorEntry>
>();

function acquireAccelerator(
  queryClient: QueryClient,
  hostId: string,
): () => void {
  let byHost = acceleratorsByClient.get(queryClient);
  if (byHost === undefined) {
    byHost = new Map<string, AcceleratorEntry>();
    acceleratorsByClient.set(queryClient, byHost);
  }
  const hosts = byHost;
  const existing = hosts.get(hostId);
  if (existing !== undefined) {
    existing.count += 1;
  } else {
    hosts.set(hostId, {
      count: 1,
      timer: setInterval(() => {
        // Non-canceling, or the cadence eats its own reads: `invalidateQueries`
        // refetches active observers with TanStack's default
        // `cancelRefetch: true`, so each tick would abort the round trip the
        // previous tick started. On a link whose `host.status` RTT exceeds
        // this cadence that is not "slightly stale" — it is a poll that NEVER
        // completes, every request dying at the next tick while the wire
        // churns. Leaving the in-flight read to finish still marks the key
        // stale, so the next tick refetches: coalescing, not skipping.
        void queryClient.invalidateQueries(
          { queryKey: hostQueryKeys.methodScope(hostId, "host.status") },
          { cancelRefetch: false },
        );
      }, FLEET_ACTIVE_POLL_MS),
    });
  }
  let released = false;
  return () => {
    // Idempotent: React can invoke a cleanup more than once (StrictMode's
    // mount/unmount/remount), and a second decrement would retire a timer other
    // consumers are still relying on.
    if (released) return;
    released = true;
    const entry = hosts.get(hostId);
    if (entry === undefined) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    clearInterval(entry.timer);
    hosts.delete(hostId);
  };
}

export function useActiveUpdatePollAccelerator(input: {
  readonly hostId: string | null;
  readonly view: FleetUpdateView;
}): void {
  const queryClient = useQueryClient();
  const { hostId } = input;
  const fast = warrantsFastPoll(input.view);
  useEffect(() => {
    if (hostId === null || !fast) return;
    return acquireAccelerator(queryClient, hostId);
  }, [hostId, fast, queryClient]);
}

/** Test-only: how many consumers currently hold this host's accelerator. */
export function activeUpdateAcceleratorCountForTest(
  queryClient: QueryClient,
  hostId: string,
): number {
  return acceleratorsByClient.get(queryClient)?.get(hostId)?.count ?? 0;
}
