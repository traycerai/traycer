import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { simulatorMutationKeys } from "@/lib/query-keys";

/**
 * The simulator domain's unary verbs, each bound to an EXPLICIT client (the
 * tab's host inside a tile, the panel's pinned host in the sidebar) and
 * gated on that host advertising the method. Every verb is optional on the
 * wire (`degrade: unsupported`), so a surface reads `supported` before it
 * draws the control, and the mutation itself is never dispatched blind.
 *
 * Keys name the host: two tiles on two machines never share pending state.
 */

type SimulatorMutation<Method extends keyof HostRpcRegistry & string> =
  UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    { readonly hostId: string | null; readonly captured: undefined }
  >;

export interface GatedSimulatorMutation<
  Method extends keyof HostRpcRegistry & string,
> {
  readonly mutation: SimulatorMutation<Method>;
  /** Whether `hostId` advertised the method in its last handshake. */
  readonly supported: boolean;
}

const CONFIG_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "config.simulator.get",
];

const NO_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [];

/** The two machine-user-global switches on `hostId`. */
export function useSimulatorConfigQuery(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "config.simulator.get">,
  HostRpcError
> {
  const supported = useHostSupportsMethod(hostId, "config.simulator.get");
  return useHostQuery<HostRpcRegistry, "config.simulator.get">({
    cacheKeyIdentity: undefined,
    client: supported ? client : null,
    method: "config.simulator.get",
    params: {},
    options: null,
  });
}

export function useSimulatorConfigSetMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): GatedSimulatorMutation<"config.simulator.set"> {
  const supported = useHostSupportsMethod(hostId, "config.simulator.set");
  const mutation = useHostScopedMutationForClient(client, {
    method: "config.simulator.set",
    mutationKey: simulatorMutationKeys.configSet(hostId ?? ""),
    errorMessage: "Couldn't change the simulator setting.",
    invalidateMethods: CONFIG_INVALIDATIONS,
  });
  return { mutation, supported };
}

/**
 * Boots (or attaches to) one simulator. Keyed by host alone: the row that is
 * booting reads `variables.simulatorId` off the pending mutation, and the
 * host's own `booting` list says the same thing to every other window.
 */
export function useSimulatorOpenMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): GatedSimulatorMutation<"simulator.open"> {
  const supported = useHostSupportsMethod(hostId, "simulator.open");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.open",
    mutationKey: simulatorMutationKeys.open(hostId ?? "", "*"),
    errorMessage: "Couldn't open the simulator.",
    invalidateMethods: NO_INVALIDATIONS,
  });
  return { mutation, supported };
}

export function useSimulatorCloseMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  simulatorId: string,
): GatedSimulatorMutation<"simulator.close"> {
  const supported = useHostSupportsMethod(hostId, "simulator.close");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.close",
    mutationKey: simulatorMutationKeys.close(hostId ?? "", simulatorId),
    errorMessage: "Couldn't close the simulator.",
    invalidateMethods: NO_INVALIDATIONS,
  });
  return { mutation, supported };
}

export function useSimulatorShutdownMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  simulatorId: string,
): GatedSimulatorMutation<"simulator.shutdown"> {
  const supported = useHostSupportsMethod(hostId, "simulator.shutdown");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.shutdown",
    mutationKey: simulatorMutationKeys.shutdown(hostId ?? "", simulatorId),
    errorMessage: "Couldn't power the simulator off.",
    invalidateMethods: NO_INVALIDATIONS,
  });
  return { mutation, supported };
}

export function useSimulatorScreenshotMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  simulatorId: string,
): GatedSimulatorMutation<"simulator.screenshot"> {
  const supported = useHostSupportsMethod(hostId, "simulator.screenshot");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.screenshot",
    mutationKey: simulatorMutationKeys.screenshot(hostId ?? "", simulatorId),
    errorMessage: "Couldn't take a screenshot.",
    invalidateMethods: NO_INVALIDATIONS,
  });
  return { mutation, supported };
}

/** One typed action; the tile uses it for an Android rotate. */
export function useSimulatorActionMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  simulatorId: string,
): GatedSimulatorMutation<"simulator.action"> {
  const supported = useHostSupportsMethod(hostId, "simulator.action");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.action",
    mutationKey: simulatorMutationKeys.action(hostId ?? "", simulatorId),
    errorMessage: "The simulator didn't take that.",
    invalidateMethods: NO_INVALIDATIONS,
  });
  return { mutation, supported };
}
