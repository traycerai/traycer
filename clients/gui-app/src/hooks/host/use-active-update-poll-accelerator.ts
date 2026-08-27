import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
export function useActiveUpdatePollAccelerator(input: {
  readonly hostId: string | null;
  readonly view: FleetUpdateView;
}): void {
  const queryClient = useQueryClient();
  const { hostId } = input;
  const fast = warrantsFastPoll(input.view);
  useEffect(() => {
    if (hostId === null || !fast) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, "host.status"),
      });
    }, FLEET_ACTIVE_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [hostId, fast, queryClient]);
}
