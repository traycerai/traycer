import { useCallback } from "react";
import { queryOptions, useQueries } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  SimulatorHostInstance,
  SimulatorPlatform,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { simulatorHostSpeaksV11 } from "@/lib/simulator-view/simulator-host-version";
import type { SimulatorOpenTarget } from "./use-simulator-instance-open";

/** One row a list of machines offers: watch an instance, or boot a device. */
export interface SimulatorInventoryEntry {
  readonly key: string;
  readonly hostId: string;
  readonly kind: "instance" | "device";
  /** The instance's key for Watch; null for a cold device. */
  readonly instanceKey: string | null;
  readonly target: SimulatorOpenTarget;
  readonly drivenByAgent: boolean;
}

export interface SimulatorHostInventory {
  readonly hostId: string;
  readonly status: "loading" | "error" | "ready";
  readonly entries: readonly SimulatorInventoryEntry[];
}

function target(args: {
  readonly simulatorId: string;
  readonly platform: SimulatorPlatform;
  readonly name: string;
  readonly version: string;
}): SimulatorOpenTarget {
  return {
    simulatorId: args.simulatorId,
    platform: args.platform,
    name: args.name,
    version: args.version,
  };
}

/**
 * A machine's entries: on a `@1.1` host every instance (`simulator.instances`)
 * then every cold device; on a `@1.0` host, which has no instances, its
 * booted devices stand in for them.
 */
export function simulatorInventoryEntries(args: {
  readonly hostId: string;
  readonly simulators: readonly SimulatorSummary[];
  readonly instances: readonly SimulatorHostInstance[] | null;
}): readonly SimulatorInventoryEntry[] {
  const { hostId, simulators, instances } = args;
  const running: SimulatorInventoryEntry[] =
    instances === null
      ? simulators
          .filter((simulator) => simulator.booted)
          .map((simulator) => ({
            key: JSON.stringify([hostId, "instance", simulator.simulatorId]),
            hostId,
            kind: "instance",
            instanceKey: simulator.simulatorId,
            target: target(simulator),
            drivenByAgent: false,
          }))
      : instances.map((instance) => ({
          key: JSON.stringify([hostId, "instance", instance.instanceKey]),
          hostId,
          kind: "instance",
          instanceKey: instance.instanceKey,
          target: target(instance),
          drivenByAgent: instance.drivenByAgent,
        }));
  const cold: SimulatorInventoryEntry[] = simulators
    .filter((simulator) => !simulator.booted && !simulator.physical)
    .map((simulator) => ({
      key: JSON.stringify([hostId, "device", simulator.simulatorId]),
      hostId,
      kind: "device",
      instanceKey: null,
      target: target(simulator),
      drivenByAgent: false,
    }));
  return [...running, ...cold];
}

/**
 * One machine's read: `simulator.list`, and `simulator.instances` on a `@1.1`
 * host. The requester is resolved per call from the binding, so a cached
 * entry never pins a client.
 */
function simulatorInventoryQuery(args: {
  readonly resolveClient: (hostId: string) => HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly enabled: boolean;
}) {
  const { resolveClient, hostId, epicId, enabled } = args;
  return queryOptions({
    queryKey: hostQueryKeys.simulatorInventory(hostId, epicId),
    enabled,
    retry: false,
    queryFn: async (): Promise<readonly SimulatorInventoryEntry[]> => {
      const client = resolveClient(hostId);
      if (client === null) throw new Error("Couldn't reach this host.");
      const state = await client.request("simulator.list", { epicId });
      const instances =
        simulatorHostSpeaksV11(hostId) === true
          ? (await client.request("simulator.instances", {})).instances
          : null;
      return simulatorInventoryEntries({
        hostId,
        simulators: state.simulators,
        instances,
      });
    },
  });
}

/**
 * What each of several machines offers to open, for the surfaces that list
 * more than one machine (the palette). One read per machine.
 */
export function useSimulatorInventories(args: {
  readonly hostIds: readonly string[];
  readonly epicId: string;
  readonly enabled: boolean;
}): readonly SimulatorHostInventory[] {
  const { hostIds, epicId, enabled } = args;
  const binding = useHostBinding();
  const resolveClient = useCallback(
    (hostId: string) => resolveNamedHostClient(binding, hostId),
    [binding],
  );
  return useQueries({
    queries: hostIds.map((hostId) =>
      simulatorInventoryQuery({ resolveClient, hostId, epicId, enabled }),
    ),
    combine: (results) =>
      results.map((result, index): SimulatorHostInventory => {
        let status: SimulatorHostInventory["status"] = "ready";
        if (result.isError) status = "error";
        else if (result.isPending) status = "loading";
        return {
          hostId: hostIds[index],
          status,
          entries: result.data ?? [],
        };
      }),
  });
}
