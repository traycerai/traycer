import { useCallback } from "react";
import { toast } from "sonner";
import type { SimulatorSummary } from "@traycer/protocol/host/simulator/schemas";
import {
  hostLabelAtSentenceStart,
  useHostReachability,
} from "@/hooks/agent/use-host-reachability";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { requestSimulatorConnect } from "@/lib/simulator-view/simulator-connect-requests";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

export interface OpenSimulatorTile {
  /**
   * Hands the caller a tile ref for `simulator` to place, at once, with a
   * one-shot connect request filed for that tile. The tile itself attaches
   * to the session the task already holds or sends the `simulator.open`
   * (booting a cold simulator) - a boot can outlast the RPC frame timeout,
   * so no surface waits on it before showing anything.
   */
  readonly open: (
    simulator: SimulatorSummary,
    place: (ref: SimulatorTileRef) => void,
  ) => void;
  /** Whether the host offers `simulator.open`, which the tile needs to connect. */
  readonly supported: boolean;
}

/**
 * The one open path every surface takes - the sidebar group, the open menu,
 * the tile's own inventory - with the same host-reachability check at open
 * that browser tiles make: a host the directory cannot reach is refused with
 * a toast rather than opening a tile that can only show "unreachable".
 *
 * The ref carries the simulator id the HOST lists today. An Android AVD takes
 * a serial on boot; the tile's own connect path opens the serial's tile
 * beside this one when that happens.
 */
export function useOpenSimulatorTile(args: {
  readonly hostId: string | null;
}): OpenSimulatorTile {
  const { hostId } = args;
  const reachability = useHostReachability(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const supported = useHostSupportsMethod(hostId, "simulator.open");
  const open = useCallback(
    (simulator: SimulatorSummary, place: (ref: SimulatorTileRef) => void) => {
      if (hostId === null) return;
      if (reachability.status === "unreachable") {
        toast.error(
          `${hostLabelAtSentenceStart(reachability.hostLabel)} is unreachable right now.`,
        );
        return;
      }
      const ref = makeSimulatorTileRef({
        hostId,
        simulatorId: simulator.simulatorId,
        platform: simulator.platform,
        name: simulator.name,
        // A device row names no instance; the tile's own open answers with one
        // and places that instance's tile itself when the id turns out to
        // differ.
        instanceKey: null,
      });
      // Filed before the tile exists: the gate reads it on mount, or at once
      // when the row's tile is already open and showing its inventory.
      requestSimulatorConnect(ref.id);
      place(ref);
    },
    [hostId, reachability.hostLabel, reachability.status],
  );
  return { open, supported };
}
