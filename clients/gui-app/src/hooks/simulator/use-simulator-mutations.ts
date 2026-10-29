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
import {
  useHostMethodSupport,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import { toastFromHostError } from "@/lib/host-error-toast";
import { SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/simulator-open-response-timeout";
import {
  hostQueryKeys,
  queryKeys,
  simulatorMutationKeys,
} from "@/lib/query-keys";

/**
 * The simulator domain's unary verbs, each bound to an EXPLICIT client (the
 * tab's host inside a tile, the panel's pinned host in the sidebar) and
 * gated on that host advertising the method. Every verb is optional on the
 * wire (`degrade: unsupported`), so a surface reads `supported` before it
 * draws the control, and the mutation itself is never dispatched blind.
 *
 * Keys name the host: two tiles on two machines never share pending state.
 *
 * THE INVARIANT every simulator WRITE is held to - the verbs here, and the
 * ones sent from elsewhere (`useSimulatorInstanceOpen`,
 * `useSimulatorCatalogActions`) alike, because a read does not care which
 * module moved it: a simulator write declares exactly the reads its effect
 * moves - the host-wide inventory pair ({@link INSTANCE_INVALIDATIONS}) for
 * anything that boots, clones, powers off, switches the machine over or keeps
 * an instance running, the instances alone ({@link SESSION_INVALIDATIONS})
 * for a change to who holds one, and nothing for what the sessions stream
 * already carries - and sweeps them on SETTLE, because a lost answer still
 * leaves a host that acted.
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

const NO_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [];

/**
 * The reads a boot or a power off moves host-wide: the instances themselves,
 * and the DEVICES, which it moves too - an Android device is listed under its
 * AVD name while it is cold and under its emulator's serial while it runs, and
 * on a `@1.0` host its `booted` flag is the only thing standing in for an
 * instance at all. Dropping the devices leaves a `@1.0` host's booted one
 * offering Boot for the 60 s freshness window - the instance poll does not
 * touch that read, and the picker's pack-following effect never fires, because
 * a boot does not move the pack. It is also what makes the devices the FRESHER
 * of the two answers a surface holds for the seconds until the instance read
 * polls again, which is how a device booted from here is running on screen at
 * once rather than when that poll lands (see `splitSimulatorDevices`).
 *
 * Shared with the instance open (`useSimulatorInstanceOpen`), which sends its
 * own `simulator.open` and sweeps the same pair.
 */
export const INSTANCE_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["simulator.instances", "simulator.list"];

/**
 * The read a close moves, and the devices' is not it: ending a session takes
 * nothing off the machine, so every device is listed exactly as before. What
 * moves is who holds the instance - the host-wide read's `tasks`,
 * `otherTaskCount` and `drivenByAgent`, which is how the palette draws an
 * Agent badge and Settings names the tasks on an instance.
 *
 * The sessions stream is not an answer here: it carries THIS task's sessions,
 * where these three are the host's census across every task, so a close in
 * this window left an agent's badge on an instance no agent held any more.
 *
 * Shared with the catalog's own Close (`useSimulatorCatalogActions`), which
 * ends the agent's session beside the person's and so moves the same read.
 */
export const SESSION_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["simulator.instances"];

/**
 * A switch flip moves the pack too (off, installing), so Settings' status
 * read is asked again with it - and the pack is what there is to enumerate,
 * so both inventory reads move with it as well. Off powers every instance on
 * the machine off and leaves no device to list; on, and the tools install and
 * the devices appear; removing the tools un-enumerates them. The same write
 * carries the idle window, which moves every instance's countdown. The
 * picker's own pack-following effect sweeps only its `simulator.list` on the
 * surface that sent the flip, so without this the palette's host-wide
 * inventory served its pre-flip answer for the whole freshness window.
 */
const CONFIG_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "config.simulator.get",
  "simulator.status",
  ...INSTANCE_INVALIDATIONS,
];

/** The machine-user-global switch on `hostId`. */
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
    errorMessage: "Couldn't change the mobile simulators setting.",
    invalidateMethods: CONFIG_INVALIDATIONS,
  });
  return { mutation, supported };
}

/**
 * Removes the downloaded simulator tools from `hostId`'s store. The host
 * refuses while simulators are on or a helper still runs, and that refusal
 * toasts like any other host error; the machine's reads are asked again
 * either way (see {@link CONFIG_INVALIDATIONS}) so the row shows what is
 * left on disk and nothing goes on offering devices the tools enumerated.
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
 *
 * It sweeps the same reads a power off does, on the MUTATION's own
 * `onSettled`: this open is sent from the tile's inventory gate, which unmounts
 * the moment the session reaches the tile, and TanStack skips the per-`mutate`
 * callbacks of an observer with no listeners. Settled rather than succeeded
 * because a lost answer still leaves a host that booted the device.
 */
export function useSimulatorOpenMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): GatedSimulatorMutation<"simulator.open"> {
  const supported = useHostSupportsMethod(hostId, "simulator.open");
  const queryClient = useQueryClient();
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
      mutationKey: simulatorMutationKeys.open(hostId ?? ""),
      onMutate: () => ({
        hostId: client?.getActiveHostId() ?? null,
        captured: undefined,
      }),
      onError: (error) => {
        toastFromHostError(error, "Couldn't open the simulator.");
      },
      onSettled: (_data, _error, _variables, context) => {
        const sentOn = context?.hostId ?? null;
        if (sentOn === null) return;
        for (const method of INSTANCE_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(sentOn, method),
          });
        }
      },
    },
  });
  return { mutation, supported };
}

/**
 * Ends one session on `simulatorId`, leaving the instance up: the tile's own
 * Close. It sweeps {@link SESSION_INVALIDATIONS} - the instance is still
 * there, but this task no longer holds it.
 */
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
    invalidateMethods: SESSION_INVALIDATIONS,
  });
  return { mutation, supported };
}

/**
 * The whole power off on a `@1.0` host, which has no `simulator.powerOff`:
 * the device is off host-wide and every session on it in this epic is gone.
 * So it sweeps the same reads {@link useSimulatorPowerOffMutation} does - the
 * one surface that sends it is the tile, whose own path is the sessions
 * stream, and neither inventory read follows that.
 */
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
    invalidateMethods: INSTANCE_INVALIDATIONS,
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
 *
 * A send that did NOT answer has no read to put there, and the host may well
 * have taken the action anyway - an answer lost on the wire, a timeout - so
 * the drawer asks for the detail again instead of leaving the control showing
 * the value from before the send with an error beside it. One read, and it
 * says which way the send went.
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
      onSettled: (_detail, error, _variables, context) => {
        const sentOn = context?.hostId ?? null;
        if (error === null || sentOn === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(sentOn, "simulator.detail"),
        });
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

/**
 * Every instance booted on `hostId`, host-wide. `live` polls it while the
 * surface is on screen: an idle countdown or a holder moves with no push.
 */
export function useSimulatorInstancesQuery(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  live: boolean,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "simulator.instances">,
  HostRpcError
> {
  const supported = useHostSupportsMethod(hostId, "simulator.instances");
  return useHostQuery<HostRpcRegistry, "simulator.instances">({
    cacheKeyIdentity: undefined,
    client: supported ? client : null,
    method: "simulator.instances",
    params: {},
    options: { poll: live },
  });
}

/**
 * `hostId`'s devices and this task's sessions there, as one read.
 *
 * Gated on known ABSENCE, not on the fail-closed boolean the other verbs use:
 * this read is the one a host-parametric surface reaches a machine with, and
 * the handshake that records the manifest happens on its dispatch. Withheld
 * while the manifest is merely unknown, a surface naming a machine it has not
 * addressed could never learn anything about it - the read that would answer
 * the question is the one the unanswered question suppresses.
 */
export function useSimulatorListQuery(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  epicId: string,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "simulator.list">,
  HostRpcError
> {
  const support = useHostMethodSupport(hostId, "simulator.list");
  return useHostQuery<HostRpcRegistry, "simulator.list">({
    cacheKeyIdentity: undefined,
    client: support === false ? null : client,
    method: "simulator.list",
    params: { epicId },
    options: null,
  });
}

/**
 * Powers one instance off host-wide. The answer may be `confirm-required`
 * (a mid-turn agent holds it); the caller asks and sends `confirm: true`.
 */
export function useSimulatorPowerOffMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  instanceKey: string,
): GatedSimulatorMutation<"simulator.powerOff"> {
  const supported = useHostSupportsMethod(hostId, "simulator.powerOff");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.powerOff",
    mutationKey: simulatorMutationKeys.powerOff(hostId ?? "", instanceKey),
    errorMessage: "Couldn't power the simulator off.",
    invalidateMethods: INSTANCE_INVALIDATIONS,
  });
  return { mutation, supported };
}

export function useSimulatorSetKeepRunningMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  instanceKey: string,
): GatedSimulatorMutation<"simulator.setKeepRunning"> {
  const supported = useHostSupportsMethod(hostId, "simulator.setKeepRunning");
  const mutation = useHostScopedMutationForClient(client, {
    method: "simulator.setKeepRunning",
    mutationKey: simulatorMutationKeys.setKeepRunning(
      hostId ?? "",
      instanceKey,
    ),
    errorMessage: "Couldn't change whether the simulator keeps running.",
    invalidateMethods: INSTANCE_INVALIDATIONS,
  });
  return { mutation, supported };
}
