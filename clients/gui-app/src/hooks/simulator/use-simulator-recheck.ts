import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  INSTANCE_INVALIDATIONS,
  useSimulatorStatusQuery,
} from "@/hooks/simulator/use-simulator-mutations";
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * The reads that say which platforms `hostId` can run and what they offer.
 * The host probes for Xcode and the Android SDK on every `simulator.status`
 * and `simulator.list`, so asking again IS looking again: nothing else
 * re-reads them once the tools are settled (the status polls only while they
 * download, and the sidebar holds it for the app's life), so a toolchain
 * installed after the first read stays unseen until a switch write sweeps
 * them. The inventory pair goes with the status because the palette's
 * inventory is its own `simulator.list`, cached under the instances scope
 * (`hostQueryKeys.simulatorInventory`): sweeping the list alone left the
 * devices a newly found platform brings out of it.
 */
const RECHECK_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "simulator.status",
  ...INSTANCE_INVALIDATIONS,
];

/**
 * The person's "Check again" on `hostId`'s simulator platforms: every
 * surface reading those two answers - Settings, the sidebar's panel, a tile,
 * the pickers - takes the host's new one. `checking` is the status read in
 * flight; the hook holds that read itself, so a surface that mounts none
 * still sends it and still has a spinner to show.
 */
export function useSimulatorRecheck(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): { readonly recheck: () => void; readonly checking: boolean } {
  const queryClient = useQueryClient();
  const status = useSimulatorStatusQuery(client, hostId);
  const recheck = useCallback(() => {
    if (hostId === null) return;
    for (const method of RECHECK_INVALIDATIONS) {
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, method),
      });
    }
  }, [hostId, queryClient]);
  return { recheck, checking: status.isFetching };
}
