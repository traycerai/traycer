import { useEffect, useRef } from "react";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";

/**
 * One inventory refresh per live episode of the sessions stream, for a
 * surface that lists simulators.
 *
 * Subscribing to `simulator.sessions` alone never starts the hub: on a fresh
 * host the published state says "no simulators" until something runs
 * `simulator.list`, which is what starts the hub and reads the inventory. The
 * coordinator's `refresh` sends the stream's `refresh` frame, and the host
 * answers it with that same `list`. So a surface asks once when the stream is
 * live on a host that can serve the list, with simulators turned on and the
 * tools installed - and asks again after every drop and resubscribe (a host
 * restart takes the stream down and brings it back under a panel that never
 * remounted), because the hub it started is gone with the host - and again
 * whenever the pack stops being ready and becomes ready once more during one
 * live episode (simulators turned off and on, the tools reinstalled): the
 * published state says "no simulators" until something starts the hub again.
 * A re-render alone never asks: only a transition into `live` and `ready`
 * does.
 */
export function useSimulatorInventoryRefreshOnMount(args: {
  readonly hostId: string | null;
  readonly sessions: SimulatorSessionsState;
}): void {
  const { hostId, sessions } = args;
  const supported = useHostSupportsMethod(hostId, "simulator.list");
  const live = sessions.lifecycle === "live";
  const ready = supported && live && sessions.state?.packState.kind === "ready";
  const refresh = sessions.refresh;
  // A refresh is owed until it is sent while live and ready; the debt comes
  // back whenever either stops holding - the stream leaving `live`, or the
  // pack leaving `ready` (off, installing, failed) - so the next time both
  // hold again, one refresh goes out.
  const owed = useRef(true);
  useEffect(() => {
    if (!live || !ready) {
      owed.current = true;
      return;
    }
    if (!owed.current) return;
    owed.current = false;
    refresh();
  }, [live, ready, refresh]);
}
