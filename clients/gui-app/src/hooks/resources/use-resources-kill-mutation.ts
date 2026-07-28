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
import { resourcesMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export interface ResourcesKillVariables {
  /** The host owning the process tree(s) - the resource row's `owner.hostId`. */
  readonly hostId: string;
  /**
   * Root pids to kill; each is terminated together with its entire descendant
   * tree. An owner row passes all of its `rootPids`; a process row passes one
   * `pid`. The host validates every pid against its live tracked set before
   * signalling, so stray/stale pids are dropped rather than trusted.
   */
  readonly pids: readonly number[];
}

/**
 * Host-routed `resources.kill` mutation for the resource monitor. Destructive,
 * so it pins a transient client to the row's own `hostId` (never the app
 * default) - a host switch mid-flight can't redirect the kill. The live
 * `resources.subscribe` stream reflects the processes disappearing, so there is
 * nothing to invalidate on success.
 */
export function useResourcesKill(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "resources.kill">,
  HostRpcError,
  ResourcesKillVariables
> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation(
    withHostMutationLifecycleBoundary("resources.kill", {
      mutationKey: resourcesMutationKeys.kill(),
      mutationFn: (variables) =>
        withHostRpcErrorBoundary("resources.kill", () => {
          const entry = directory.findById(variables.hostId);
          const client: HostClient<HostRpcRegistry> | null =
            entry === null
              ? null
              : buildTransientHostClient(defaultClient, entry);
          if (client === null) {
            return Promise.reject(hostClientUnavailableError("resources.kill"));
          }
          return client.request("resources.kill", {
            pids: [...variables.pids],
          });
        }),
      onError: (error) => toastFromHostError(error, "Failed to kill processes"),
    }),
  );
}
