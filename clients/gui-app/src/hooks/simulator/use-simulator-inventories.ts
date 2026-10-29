import { useCallback } from "react";
import { queryOptions, useQueries } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  SimulatorHostInstance,
  SimulatorPlatform,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import {
  useHostNegotiatedMethodVersions,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { coldSimulatorDevices } from "@/lib/simulator-view/simulator-cold-devices";
import { simulatorVerbsAreV11 } from "@/lib/simulator-view/simulator-host-version";
import type { SimulatorOpenTarget } from "./use-simulator-instance-open";

/** Resolves a requester for one named host, or `null` when it cannot. */
type ResolveClient = (hostId: string) => HostClient<HostRpcRegistry> | null;

/**
 * The refusal both reads below report when the binding cannot address the
 * host. Takes the RESOLVED client rather than the resolver: a fetcher that
 * passes `resolveClient` as a value reads to the query lint as cache identity
 * it has left out of the key, and it is deliberately not in the key - the
 * requester is resolved per call so a cached entry never pins a client.
 */
function requireClient(
  client: HostClient<HostRpcRegistry> | null,
): HostClient<HostRpcRegistry> {
  if (client === null) throw new Error("Couldn't reach this host.");
  return client;
}

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
 *
 * ONE read decides both halves, which is what makes them a partition of the
 * machine's devices rather than two answers that can disagree - see
 * {@link coldSimulatorDevices}, which holds that invariant. The two reads
 * below describe one moment only as far as two round trips can, so a device
 * that powers off between them answers booted here and is absent from the
 * instances; reading the flag for the cold half would list it in neither.
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
  const cold: SimulatorInventoryEntry[] = coldSimulatorDevices({
    simulators,
    instances,
  }).map((simulator) => ({
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
 *
 * `speaksV11` is the host's negotiated gate, and the fetcher takes it as an
 * ARGUMENT rather than re-reading the registry at dispatch: it is part of the
 * query key, and a dispatch that read a gate the key does not name would file
 * one minor's shape as the answer for the other. A gate that moves mid-flight
 * is a different key, which fetches on its own.
 */
function simulatorInventoryQuery(args: {
  readonly resolveClient: ResolveClient;
  readonly hostId: string;
  readonly epicId: string;
  readonly enabled: boolean;
  readonly speaksV11: boolean;
}) {
  const { resolveClient, hostId, epicId, enabled, speaksV11 } = args;
  return queryOptions({
    queryKey: hostQueryKeys.simulatorInventory(hostId, epicId, speaksV11),
    enabled,
    retry: false,
    queryFn: async (): Promise<readonly SimulatorInventoryEntry[]> => {
      const client = requireClient(resolveClient(hostId));
      // Deliberately its own `simulator.list`, not the contact read's cached
      // answer below: the cold rows come from this answer, so a device the
      // machine has gained or lost since - or an Android one listed under a
      // new id since - would be a row from before. WHICH devices are running
      // no longer rests on how old this answer is; that is the instance
      // read's alone (see `coldSimulatorDevices`).
      const state = await client.request("simulator.list", { epicId });
      const instances = speaksV11
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
 * The read that CONTACTS a machine, for the hosts whose simulator minor is not
 * known yet.
 *
 * The inventory read above waits for that minor, because the minor decides
 * which shape its answer has - and before this, nothing else was asking.
 * `useHostNegotiatedMethodVersions` only OBSERVES the registry, and the
 * requester is resolved inside the inventory's own fetcher, which the same
 * unanswered question had disabled. So a machine the task catalog names but
 * this client has never dialled stayed unnegotiated until some unrelated
 * surface happened to touch it, and the palette omitted it or sat on
 * "Loading simulators…". The + picker had the same defect and the same fix.
 *
 * `simulator.list` is the read a host-parametric surface reaches a machine
 * with, so DISPATCHING it is the handshake; `useSimulatorListQuery` carries
 * that contract for the picker. Withheld only from a host whose manifest
 * PROVES the method absent - merely unknown is the state this read resolves,
 * and reading it as absence is how the deadlock is spelled. Keyed exactly as
 * `useHostQuery` keys that method, through the same error boundary and method
 * stamp, so the answer is the entry every other simulator surface reads
 * rather than a private copy.
 *
 * Returns the hosts whose contact attempt FAILED while their minor is still
 * unknown: a machine that cannot be reached reports `error` instead of a
 * palette that spins on it for ever. Only while unknown, because once the
 * minor lands the inventory read's own state is the honest one and this
 * query's last error is frozen in a disabled observer.
 */
function useSimulatorHostContact(args: {
  readonly resolveClient: ResolveClient;
  readonly hostIds: readonly string[];
  readonly epicId: string;
  readonly enabled: boolean;
  readonly minorUnknown: (hostId: string) => boolean;
  readonly listSupport: ReadonlyMap<string, NegotiatedMethodVersion>;
}): ReadonlySet<string> {
  const { resolveClient, hostIds, epicId, enabled, minorUnknown, listSupport } =
    args;
  return useQueries({
    queries: hostIds.map((hostId) =>
      queryOptions({
        queryKey: hostQueryKeys.method<HostRpcRegistry, "simulator.list">(
          hostId,
          "simulator.list",
          { epicId },
        ),
        enabled:
          enabled && minorUnknown(hostId) && listSupport.get(hostId) !== false,
        retry: false,
        meta: stampHostRpcMethod(undefined, "simulator.list"),
        queryFn: () =>
          withHostQueryErrorBoundary("simulator.list", () =>
            requireClient(resolveClient(hostId)).request("simulator.list", {
              epicId,
            }),
          ),
      }),
    ),
    combine: (results) =>
      new Set(
        hostIds.filter(
          (hostId, index) => results[index].isError && minorUnknown(hostId),
        ),
      ),
  });
}

/**
 * What each of several machines offers to open, for the surfaces that list
 * more than one machine (the palette). One read per machine.
 *
 * A machine whose simulator minor is still unnegotiated is not SHAPED yet: the
 * gate decides which of the two shapes the answer has, and `null` there is
 * "not known yet", never "`@1.0`". It is still CONTACTED - see
 * {@link useSimulatorHostContact}, which is what makes the minor land - and
 * the subscription per host (`hostIds` is memoized by the caller) is what
 * starts the shaped read the moment it does.
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
  const versions = useHostNegotiatedMethodVersions(hostIds, "simulator.open");
  const listSupport = useHostNegotiatedMethodVersions(
    hostIds,
    "simulator.list",
  );
  const speaksV11 = useCallback(
    (hostId: string) => simulatorVerbsAreV11(versions.get(hostId) ?? null),
    [versions],
  );
  const minorUnknown = useCallback(
    (hostId: string) => speaksV11(hostId) === null,
    [speaksV11],
  );
  const unreachable = useSimulatorHostContact({
    resolveClient,
    hostIds,
    epicId,
    enabled,
    minorUnknown,
    listSupport,
  });
  return useQueries({
    queries: hostIds.map((hostId) =>
      simulatorInventoryQuery({
        resolveClient,
        hostId,
        epicId,
        enabled: enabled && !minorUnknown(hostId),
        speaksV11: speaksV11(hostId) === true,
      }),
    ),
    combine: (results) =>
      results.map((result, index): SimulatorHostInventory => {
        const hostId = hostIds[index];
        let status: SimulatorHostInventory["status"] = "ready";
        // A failed contact is this host's answer while the shaped read is
        // still waiting on a minor that will never arrive from it.
        if (result.isError || unreachable.has(hostId)) status = "error";
        else if (result.isPending) status = "loading";
        return { hostId, status, entries: result.data ?? [] };
      }),
  });
}
