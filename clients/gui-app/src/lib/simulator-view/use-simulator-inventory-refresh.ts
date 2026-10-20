import { useEffect, useRef } from "react";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";

/**
 * One inventory refresh when a surface that lists simulators appears.
 *
 * Subscribing to `simulator.sessions` alone never starts the hub: on a fresh
 * host the published state says "no simulators" until something runs
 * `simulator.list`, which is what starts the hub and reads the inventory. The
 * coordinator's `refresh` sends the stream's `refresh` frame, and the host
 * answers it with that same `list`. So a surface that mounts on a host that
 * can serve the list, with simulators turned on and the tools installed,
 * asks once - and once only per mount, so a panel that is shown and hidden
 * does not re-run discovery each time.
 */
export function useSimulatorInventoryRefreshOnMount(args: {
  readonly hostId: string | null;
  readonly sessions: SimulatorSessionsState;
}): void {
  const { hostId, sessions } = args;
  const supported = useHostSupportsMethod(hostId, "simulator.list");
  const ready =
    supported &&
    sessions.lifecycle === "live" &&
    sessions.state?.packState.kind === "ready";
  const refresh = sessions.refresh;
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current || !ready) return;
    requested.current = true;
    refresh();
  }, [ready, refresh]);
}
