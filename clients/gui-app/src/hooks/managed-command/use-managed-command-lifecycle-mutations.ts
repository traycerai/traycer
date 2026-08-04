import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { withHostRpcErrorBoundary } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useHostClient,
  useHostDirectory,
  type HostRpcRegistry,
} from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import {
  hostClientUnavailableError,
  withHostMutationLifecycleBoundary,
} from "@/hooks/host/use-host-query";
import { managedCommandMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * The three human capabilities over a managed command (`UI.md` §2): start,
 * stop, delete. There is deliberately no create or edit - authoring is the
 * agent's job.
 *
 * Each pins a transient client to the command's OWN host rather than the app
 * default, the way `resources.kill` does: these act on a specific process on a
 * specific machine, and a host switch mid-flight must not redirect them. The
 * list stream pushes the resulting state to every subscriber, so there is
 * nothing to invalidate on success.
 */
export interface ManagedCommandLifecycleVariables {
  readonly hostId: string;
  readonly epicId: string;
  readonly commandId: string;
}

type LifecycleMethod =
  "managedCommand.start" | "managedCommand.stop" | "managedCommand.delete";

function useManagedCommandLifecycleMutation<Method extends LifecycleMethod>(
  method: Method,
  mutationKey: readonly string[],
  errorMessage: string,
  // The three methods share a request shape but not a type: `client.request`
  // resolves its argument from the literal method, so each caller passes the
  // concrete call rather than widening it here.
  send: (
    client: HostClient<HostRpcRegistry>,
    variables: ManagedCommandLifecycleVariables,
  ) => Promise<ResponseOfMethod<HostRpcRegistry, Method>>,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation(
    withHostMutationLifecycleBoundary(method, {
      mutationKey,
      mutationFn: (variables: ManagedCommandLifecycleVariables) =>
        withHostRpcErrorBoundary(method, () => {
          const entry = directory.findById(variables.hostId);
          const client: HostClient<HostRpcRegistry> | null =
            entry === null
              ? null
              : buildTransientHostClient(defaultClient, entry);
          if (client === null) {
            return Promise.reject(hostClientUnavailableError(method));
          }
          return send(client, variables);
        }),
      onError: (error: HostRpcError) => toastFromHostError(error, errorMessage),
    }),
  );
}

export function useManagedCommandStart(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.start">,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  return useManagedCommandLifecycleMutation(
    "managedCommand.start",
    managedCommandMutationKeys.start(),
    "Couldn't start it.",
    (client, variables) =>
      client.request("managedCommand.start", {
        epicId: variables.epicId,
        commandId: variables.commandId,
      }),
  );
}

export function useManagedCommandStop(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.stop">,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  return useManagedCommandLifecycleMutation(
    "managedCommand.stop",
    managedCommandMutationKeys.stop(),
    "Couldn't stop it.",
    (client, variables) =>
      client.request("managedCommand.stop", {
        epicId: variables.epicId,
        commandId: variables.commandId,
      }),
  );
}

export function useManagedCommandDelete(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.delete">,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  return useManagedCommandLifecycleMutation(
    "managedCommand.delete",
    managedCommandMutationKeys.delete(),
    "Couldn't delete it.",
    (client, variables) =>
      client.request("managedCommand.delete", {
        epicId: variables.epicId,
        commandId: variables.commandId,
      }),
  );
}
