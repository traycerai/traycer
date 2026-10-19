import { useCallback } from "react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { SimulatorSummary } from "@traycer/protocol/host/simulator/schemas";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useSimulatorOpenMutation } from "@/hooks/simulator/use-simulator-mutations";
import type { HostRpcRegistry } from "@/lib/host";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

export interface OpenSimulatorTile {
  /**
   * Opens `simulator` on the host (booting it when it is cold) and, once the
   * host has answered, hands the caller a tile ref to place. The ref's
   * `simulatorId` is the HOST's: an Android AVD name becomes a serial on
   * boot, and the tile must point at what the stream will answer to.
   */
  readonly open: (
    simulator: SimulatorSummary,
    place: (ref: SimulatorTileRef) => void,
  ) => void;
  /** Whether the host offers `simulator.open` at all. */
  readonly supported: boolean;
  /** The simulator an open is in flight for, so its row alone spins. */
  readonly openingSimulatorId: string | null;
}

/**
 * The one open path every surface takes - the sidebar group, the open menu,
 * the tile's own inventory - with the same host-reachability check at open
 * that browser tiles make: a host the directory cannot reach is refused with
 * a toast rather than opening a tile that can only show "unreachable".
 */
export function useOpenSimulatorTile(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly epicId: string;
}): OpenSimulatorTile {
  const { client, hostId, epicId } = args;
  const reachability = useHostReachability(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const { mutation, supported } = useSimulatorOpenMutation(client, hostId);
  const { mutate, isPending, variables } = mutation;
  const open = useCallback(
    (simulator: SimulatorSummary, place: (ref: SimulatorTileRef) => void) => {
      if (hostId === null) return;
      if (reachability.status === "unreachable") {
        toast.error(`${reachability.hostLabel} is unreachable right now.`);
        return;
      }
      mutate(
        {
          epicId,
          simulatorId: simulator.simulatorId,
          platform: simulator.platform,
          boot: true,
        },
        {
          onSuccess: (response) => {
            place(
              makeSimulatorTileRef({
                hostId,
                simulatorId: response.simulator.simulatorId,
                platform: response.simulator.platform,
                name: response.simulator.name,
              }),
            );
          },
        },
      );
    },
    [epicId, hostId, mutate, reachability.hostLabel, reachability.status],
  );
  return {
    open,
    supported,
    openingSimulatorId: isPending ? variables.simulatorId : null,
  };
}
