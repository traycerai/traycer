import {
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostMutation,
  useHostMutationWithResponseTimeout,
  useHostQuery,
} from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { toastFromHostError } from "@/lib/host-error-toast";
import { SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/simulator-open-response-timeout";
import { queryKeys, simulatorMutationKeys } from "@/lib/query-keys";

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

// A switch flip moves the pack too (off, installing), so Settings' status
// read is asked again with it.
const CONFIG_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "config.simulator.get",
  "simulator.status",
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
 * Removes the downloaded simulator tools from `hostId`'s store. The host
 * refuses while simulators are on or a helper still runs, and that refusal
 * toasts like any other host error; Settings' status read is asked again
 * either way so the row shows what is left on disk.
 */
export function useSimulatorRemoveToolsMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): GatedSimulatorMutation<"simulator.removeTools"> {
  const supported = useHostSupportsMethod(hostId, "simulator.removeTools");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.removeTools",
    mutationKey: simulatorMutationKeys.removeTools(hostId ?? ""),
    errorMessage: "Couldn't remove the simulator tools.",
    invalidateMethods: CONFIG_INVALIDATIONS,
  });
  return { mutation, supported };
}

/**
 * Boots (or attaches to) one simulator. Keyed by host alone: the host's own
 * `booting` list says which simulator is booting to every window.
 *
 * `useHostMutationWithResponseTimeout`, NOT a plain host mutation: a cold
 * open answers after the boot, and the host bounds the boot at three minutes
 * (see {@link SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS}). The policy table's row is
 * only the permission for that budget; passing the constant here is what
 * applies it. A real error - the host's own boot deadline included - still
 * surfaces as a toast.
 */
export function useSimulatorOpenMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): GatedSimulatorMutation<"simulator.open"> {
  const supported = useHostSupportsMethod(hostId, "simulator.open");
  const mutation = useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "simulator.open",
    { readonly hostId: string | null; readonly captured: undefined }
  >({
    client,
    method: "simulator.open",
    mapVariables: (variables) => variables,
    responseTimeoutMs: SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS,
    signalFor: null,
    options: {
      mutationKey: simulatorMutationKeys.open(hostId ?? "", "*"),
      onMutate: () => ({
        hostId: client?.getActiveHostId() ?? null,
        captured: undefined,
      }),
      onError: (error) => {
        toastFromHostError(error, "Couldn't open the simulator.");
      },
    },
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

/**
 * Platform availability and the tools' install on `hostId`, with no task:
 * what Settings shows. The policy table polls it while the tools download.
 */
export function useSimulatorStatusQuery(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "simulator.status">,
  HostRpcError
> {
  const supported = useHostSupportsMethod(hostId, "simulator.status");
  return useHostQuery<HostRpcRegistry, "simulator.status">({
    cacheKeyIdentity: undefined,
    client: supported ? client : null,
    method: "simulator.status",
    params: {},
    options: null,
  });
}

/** One simulator's settings as last read; the drawer's source of truth. */
export function useSimulatorDetailQuery(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  epicId: string,
  simulatorId: string,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "simulator.detail">,
  HostRpcError
> {
  const supported = useHostSupportsMethod(hostId, "simulator.detail");
  return useHostQuery<HostRpcRegistry, "simulator.detail">({
    cacheKeyIdentity: undefined,
    client: supported ? client : null,
    method: "simulator.detail",
    params: { epicId, simulatorId },
    options: null,
  });
}

/**
 * The drawer's actions. Unlike {@link useSimulatorActionMutation} a failure
 * is not toasted: the drawer prints it beside the control that sent it. The
 * answer IS the fresh read, so it replaces the detail query's data rather
 * than asking again.
 */
export function useSimulatorDrawerActionMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  simulatorId: string,
): GatedSimulatorMutation<"simulator.action"> {
  const supported = useHostSupportsMethod(hostId, "simulator.action");
  const queryClient = useQueryClient();
  const mutation = useHostMutation<
    HostRpcRegistry,
    "simulator.action",
    { readonly hostId: string | null; readonly captured: undefined }
  >({
    client,
    method: "simulator.action",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: simulatorMutationKeys.action(hostId ?? "", simulatorId),
      onMutate: () => ({
        hostId: client?.getActiveHostId() ?? null,
        captured: undefined,
      }),
      onSuccess: (detail, variables, ctx) => {
        if (ctx.hostId === null) return;
        queryClient.setQueryData(
          queryKeys.hostMethod<HostRpcRegistry, "simulator.detail">(
            ctx.hostId,
            "simulator.detail",
            { epicId: variables.epicId, simulatorId: variables.simulatorId },
          ),
          detail,
        );
      },
    },
  });
  return { mutation, supported };
}

const UNAVAILABLE_PREFIX = /^simulator action unavailable \([^)]*\): /;
const OPERATION_FAILED_PREFIX = /^simulator [A-Za-z]+ failed: /;

/**
 * The sentence a drawer row prints for a refused action. The host's message
 * leads with a machine-readable bracket (`operation=`, `platform=`,
 * `reason=`) that is for logs, not for the person.
 */
export function simulatorActionErrorText(error: HostRpcError): string {
  const text = error.message
    .replace(UNAVAILABLE_PREFIX, "")
    .replace(OPERATION_FAILED_PREFIX, "");
  if (text.length === 0) return "The simulator didn't take that.";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
