import {
  useIsMutating,
  useMutation,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  HostRpcError,
  withHostRpcErrorBoundary,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
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

export interface ManagedCommandStopAllVariables {
  readonly hostId: string;
  readonly epicId: string;
  readonly commandIds: readonly string[];
}

/**
 * Whether ANY Stop all batch is in flight, across every mounted panel. A
 * mutation result's own `isPending` is per-observer, and the same chat can be
 * open in two canvas tiles - a second tile's button must go dead the moment
 * the first tile's batch starts, or it re-submits the same command ids.
 */
export function useManagedCommandStopAllIsPending(chatId: string): boolean {
  return (
    useIsMutating({ mutationKey: managedCommandMutationKeys.stopAll(chatId) }) >
    0
  );
}

/**
 * Several commands stopped as ONE action, for a "Stop all" that has to reach
 * host-supervised commands alongside the harness's own background work.
 *
 * Fanning {@link useManagedCommandStop} out instead judged each stop on its
 * own, so the usual cause of a failure here - a host that went away - put one
 * identical toast on screen per row. This sends every stop, waits for all of
 * them, and says the outcome once. Its pending flag covers the whole span, so
 * the button a caller disables on it cannot re-send the set mid-flight.
 */
export function useManagedCommandStopAll(
  chatId: string,
): UseMutationResult<void, Error, ManagedCommandStopAllVariables> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation<void, Error, ManagedCommandStopAllVariables>({
    mutationKey: managedCommandMutationKeys.stopAll(chatId),
    mutationFn: async (variables) => {
      const entry = directory.findById(variables.hostId);
      const client: HostClient<HostRpcRegistry> | null =
        entry === null ? null : buildTransientHostClient(defaultClient, entry);
      // No host client means every stop would fail identically, so fail once
      // with the real reason instead of manufacturing N rejections that
      // collapse into an uninformative "couldn't stop N of N" count.
      if (client === null) {
        throw hostClientUnavailableError("managedCommand.stop");
      }
      const outcomes = await Promise.allSettled(
        variables.commandIds.map((commandId) =>
          withHostRpcErrorBoundary("managedCommand.stop", () =>
            client.request("managedCommand.stop", {
              epicId: variables.epicId,
              commandId,
            }),
          ),
        ),
      );
      const rejections = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (rejections.length === 0) return;
      // A batch that failed WHOLESALE almost always failed for one systemic
      // reason (revoked access, host gone, method unsupported). Throw the
      // typed error so the standard host-error policy - recoverable-
      // unauthorized suppression, upgrade/reconnect guidance, dedup - applies
      // exactly as it does on the per-row path. A partial failure has mixed
      // causes, so the honest summary there is the count.
      const representative: unknown = rejections[0].reason;
      if (
        rejections.length === outcomes.length &&
        representative instanceof HostRpcError
      ) {
        throw representative;
      }
      throw new Error(
        `Couldn't stop ${rejections.length} of ${outcomes.length} monitors and shells.`,
      );
    },
    onError: (error) => {
      if (error instanceof HostRpcError) {
        toastFromHostError(error, "Couldn't stop them.");
        return;
      }
      toast.error(error.message);
    },
  });
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
