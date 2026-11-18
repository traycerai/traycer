import { useCallback, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { SimulatorCatalogRecord } from "@traycer/protocol/host/simulator/catalog-contracts";
import type {
  SimulatorPlatform,
  SimulatorSession,
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { useSimulatorCatalogContext } from "@/components/epic-canvas/renderers/simulator-catalog-context";
import {
  findInstanceForKey,
  type SimulatorInstanceIdentity,
} from "@/lib/simulator-view/simulator-tile-target";
import {
  useSimulatorCloseMutation,
  useSimulatorPowerOffMutation,
  useSimulatorShutdownMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import type { HostRpcRegistry } from "@/lib/host";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

/**
 * The task catalog's live records for one instance. Every record on an
 * instance carries that instance's name and version, so any of them names it;
 * `drivenByAgent` is read across all of them, since only the sessions an
 * agent holds carry it.
 */
function identityFromRecords(
  records: readonly SimulatorCatalogRecord[],
): SimulatorInstanceIdentity | null {
  const onTheInstance = records.at(0);
  if (onTheInstance === undefined) return null;
  return {
    name: onTheInstance.name,
    version: onTheInstance.version,
    drivenByAgent: records.some((record) => record.drivenByAgent),
  };
}

/** The host's device row for the tile's own id, which a clone never has. */
function identityFromSummary(
  summary: SimulatorSummary | undefined,
): SimulatorInstanceIdentity | null {
  if (summary === undefined) return null;
  return {
    name: summary.name,
    version: summary.version,
    drivenByAgent: false,
  };
}

/**
 * What the live tile's header names. The catalog row names the instance
 * ("iPhone 17 Pro · 2") and carries its Agent badge and version, but no
 * catalog answers for every task - one read behind a pane that was never
 * visible, a task host too old to relay it, a cloud whose catalog is not on
 * yet - so the host's own nested row answers next, found by the key THIS
 * SESSION names. Only then the device row with the tile's id, which a clone
 * never has, and last the name the tile was placed with, which for a clone is
 * whatever its open named: often the source device.
 *
 * The first read that knows the instance answers for all three, rather than
 * each field taking the first read that has one: a name from the catalog
 * beside an Agent badge from the stream would describe two moments.
 */
export function useSimulatorTileIdentity(args: {
  readonly hostId: string;
  readonly node: SimulatorTileRef;
  readonly session: SimulatorSession;
  readonly state: SimulatorState;
}): {
  /** The instance the session names; null on a `@1.0` host, which has none. */
  readonly instanceKey: string | null;
  readonly simulatorName: string;
  readonly version: string;
  readonly drivenByAgent: boolean;
} {
  const { hostId, node, session, state } = args;
  const records = useSimulatorCatalogContext()?.records ?? [];
  const instanceKey = session.instanceKey ?? null;
  const identity =
    identityFromRecords(
      records.filter(
        (record) =>
          record.hostId === hostId &&
          record.endedReason === null &&
          record.instanceKey === instanceKey,
      ),
    ) ??
    (instanceKey === null
      ? null
      : findInstanceForKey(state.simulators, instanceKey)) ??
    identityFromSummary(
      state.simulators.find(
        (simulator) => simulator.simulatorId === node.simulatorId,
      ),
    );
  return {
    instanceKey,
    simulatorName: identity?.name ?? node.name,
    version: identity?.version ?? "",
    drivenByAgent: identity?.drivenByAgent ?? false,
  };
}

/**
 * The tile's Close. The tile goes first: a close the host refuses still
 * leaves the person with the tile gone, which is what they asked for. On a
 * `@1.1` host it then ends the viewer's own person session by its id,
 * whoever sent the open; on a `@1.0` host only a session this tile opened.
 */
export function useSimulatorTileClose(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly node: SimulatorTileRef;
  readonly session: SimulatorSession;
  readonly v11: boolean;
  readonly closesSession: boolean;
  readonly onCloseTile: () => void;
}): () => void {
  const { client, hostId, epicId, node, session, v11 } = args;
  const { closesSession, onCloseTile } = args;
  const close = useSimulatorCloseMutation(client, hostId, node.simulatorId);
  const closeMutate = close.mutation.mutate;
  const supported = close.supported;
  const sessionId = session.sessionId;
  return useCallback(() => {
    onCloseTile();
    if (!closesSession || !supported) return;
    if (!v11) {
      closeMutate({ epicId, simulatorId: node.simulatorId, shutdown: false });
      return;
    }
    // Without a session id a `@1.1` close would end every session the viewer
    // owns on the instance, an agent's included.
    if (sessionId === undefined) return;
    closeMutate({
      epicId,
      simulatorId: node.simulatorId,
      shutdown: false,
      sessionId,
    });
  }, [
    closeMutate,
    closesSession,
    epicId,
    node.simulatorId,
    onCloseTile,
    sessionId,
    supported,
    v11,
  ]);
}

/**
 * The tile's Power off: `simulator.powerOff` on a `@1.1` host, which asks
 * first (a `confirm-required` answer) only while an agent is mid-turn on the
 * instance; `simulator.shutdown` stays for a `@1.0` host. Either way the tile
 * closes off the mutation's OWN promise, never off `mutate`'s per-call
 * `onSuccess`: the sessions stream can drop this session before the answer,
 * which unmounts the tile and detaches the observer those callbacks reach. A
 * failure is already toasted by the mutation and leaves the tile open.
 *
 * The `@1.1` verb takes an instance KEY, and the only identity that is one is
 * the session's own: the tile's `simulatorId` is an Android serial, and merely
 * happens to be the key as well on iOS. So a `@1.1` session that names no
 * instance offers no Power off rather than sending the tile's id as a key.
 */
export function useSimulatorTilePowerOff(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly node: SimulatorTileRef;
  readonly instanceKey: string | null;
  readonly platform: SimulatorPlatform;
  readonly v11: boolean;
  readonly onCloseTile: () => void;
}): {
  readonly onPowerOff: (() => void) | null;
  readonly pending: boolean;
  readonly confirmingAgent: boolean;
  readonly setConfirmingAgent: (open: boolean) => void;
  readonly confirmAgent: () => void;
} {
  const { client, hostId, epicId, node, instanceKey, platform, v11 } = args;
  const { onCloseTile } = args;
  const shutdown = useSimulatorShutdownMutation(
    client,
    hostId,
    node.simulatorId,
  );
  const powerOff = useSimulatorPowerOffMutation(
    client,
    hostId,
    instanceKey ?? "",
  );
  const [confirmingAgent, setConfirmingAgent] = useState(false);
  const powerOffMutateAsync = powerOff.mutation.mutateAsync;
  const sendPowerOff = useCallback(
    (confirm: boolean) => {
      if (instanceKey === null) return;
      void powerOffMutateAsync({ instanceKey, confirm }).then(
        (answer) => {
          if (answer.kind === "confirm-required") {
            setConfirmingAgent(true);
            return;
          }
          onCloseTile();
        },
        () => undefined,
      );
    },
    [instanceKey, onCloseTile, powerOffMutateAsync],
  );
  const shutdownMutateAsync = shutdown.mutation.mutateAsync;
  const onShutdown = useCallback(() => {
    void shutdownMutateAsync({
      epicId,
      simulatorId: node.simulatorId,
      platform,
    }).then(onCloseTile, () => undefined);
  }, [epicId, node.simulatorId, onCloseTile, platform, shutdownMutateAsync]);
  const confirmAgent = useCallback(() => {
    setConfirmingAgent(false);
    sendPowerOff(true);
  }, [sendPowerOff]);
  let onPowerOff: (() => void) | null = null;
  if (v11 && powerOff.supported && instanceKey !== null)
    onPowerOff = () => sendPowerOff(false);
  else if (!v11 && shutdown.supported) onPowerOff = onShutdown;
  return {
    onPowerOff,
    pending: v11 ? powerOff.mutation.isPending : shutdown.mutation.isPending,
    confirmingAgent,
    setConfirmingAgent,
    confirmAgent,
  };
}
