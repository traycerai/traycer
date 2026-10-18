import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  EnvironmentHostBinding,
  EnvironmentHostBindRequest,
  EnvironmentHostListResponse,
} from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

const HOST_LIST_METHOD = "environment.host.list";

interface BindContext {
  readonly hostId: string | null;
  /** The environments the host was in before the bind, as cached. */
  readonly previousEnvironmentIds: ReadonlyArray<string>;
}

/**
 * Binds the host behind `client` to one of the user's environments
 * (`environment.host.bind`). Binding to the personal environment removes the
 * binding; the host refuses an environment the user does not belong to, and
 * refuses any rebind while a live bot of another environment is bound to it.
 *
 * No toast: the refusal is the picker's own inline notice, because the reason
 * ("a bot of another environment is still bound here") is an instruction the
 * reader acts on next to the control, not an interruption. `hostId` is the
 * host the client addresses, captured so the read query it refreshes is the
 * same host's whatever the scope does during the round trip.
 *
 * A bind or unbind also moves the host between environments' machine lists
 * (`environment.host.list`): out of the one it was in, into the one it joins.
 * Those lists are cloud-backed and the same through every host, so the two
 * environments' lists are invalidated on every host scope - Settings' machine
 * list and Home's row states both read them - and no other environment's.
 * The environment it leaves is read before the bind overwrites the cache:
 * from this host's cached `environment.host.read`, and from any cached list
 * that names the host.
 */
export function useEnvironmentHostBindMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): UseMutationResult<
  EnvironmentHostBinding,
  HostRpcError,
  EnvironmentHostBindRequest,
  BindContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "environment.host.bind", BindContext>(
    {
      client,
      method: "environment.host.bind",
      mapVariables: (variables) => variables,
      options: {
        mutationKey: environmentMutationKeys.hostBind(),
        onMutate: () => ({
          hostId,
          previousEnvironmentIds: cachedEnvironmentIdsOfHost(
            queryClient,
            hostId,
          ),
        }),
        onSuccess: (binding, variables, ctx) => {
          queryClient.setQueriesData<EnvironmentHostBinding>(
            {
              queryKey: hostQueryKeys.methodScope(
                ctx.hostId,
                "environment.host.read",
              ),
            },
            binding,
          );
          const affected = new Set([
            ...ctx.previousEnvironmentIds,
            variables.environmentId,
            binding.environment.environmentId,
          ]);
          void queryClient.invalidateQueries({
            predicate: (query) => {
              const environmentId = hostListEnvironmentId(query.queryKey);
              return environmentId !== null && affected.has(environmentId);
            },
          });
        },
      },
    },
  );
}

/** Every environment the cache says `hostId` is in now. */
function cachedEnvironmentIdsOfHost(
  queryClient: QueryClient,
  hostId: string | null,
): ReadonlyArray<string> {
  if (hostId === null) return [];
  const ids = new Set<string>();
  for (const [, binding] of queryClient.getQueriesData<EnvironmentHostBinding>({
    queryKey: hostQueryKeys.methodScope(hostId, "environment.host.read"),
  })) {
    if (binding !== undefined) ids.add(binding.environment.environmentId);
  }
  for (const [
    queryKey,
    list,
  ] of queryClient.getQueriesData<EnvironmentHostListResponse>({
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, HOST_LIST_METHOD),
  })) {
    const environmentId = hostListEnvironmentId(queryKey);
    if (
      environmentId !== null &&
      list?.hosts.some((host) => host.hostId === hostId) === true
    ) {
      ids.add(environmentId);
    }
  }
  return [...ids];
}

/**
 * The environment an `environment.host.list` key asks about, under any host
 * scope (`["host", hostId?, method, { environmentId }, ...]`); `null` for any
 * other key.
 */
function hostListEnvironmentId(queryKey: readonly unknown[]): string | null {
  if (!hostQueryKeys.matchesMethodOnAnyHost(queryKey, HOST_LIST_METHOD)) {
    return null;
  }
  const params = queryKey[queryKey.indexOf(HOST_LIST_METHOD) + 1];
  if (
    typeof params === "object" &&
    params !== null &&
    "environmentId" in params &&
    typeof params.environmentId === "string"
  ) {
    return params.environmentId;
  }
  return null;
}
