import { useCallback, useMemo } from "react";
import {
  queryOptions,
  useQueries,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  EnvironmentHostBinding,
  EnvironmentHostReadRequest,
} from "@traycer/protocol/host/environment/contracts";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import {
  resolveNamedHostClient,
  resolvePoolTierHostClient,
} from "@/lib/host/binding-host-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

const HOST_READ_METHOD = "environment.host.read";
const POOL_READ_METHOD = "environment.binding.read";
const EMPTY_PARAMS: EnvironmentHostReadRequest = {};
const BINDING_STALE_MS = 30_000;

/**
 * Whether this build reads a named host's binding from the server pool
 * (`environment.binding.read`) rather than asking that host for its own
 * (`environment.host.read`). A fact of the build, read from the frozen tier
 * plan and never from reachability: without a pool, a pool-only method goes
 * to the caller's host, and no host serves this one.
 */
export function readsHostBindingsFromPool(): boolean {
  return readProcessHostRpcTierPlan().pool !== null;
}

/**
 * The cache entry every reader of `hostId`'s binding shares in this build,
 * which a bind writes through: the pool's answer for this viewer, or, without
 * a pool, the host's own answer under that host's scope.
 */
export function hostEnvironmentBindingQueryKey(
  hostId: string,
  viewerUserId: string,
): QueryKey {
  if (readsHostBindingsFromPool()) {
    return hostQueryKeys.environmentBindingForViewer(
      POOL_HOST_ID,
      hostId,
      viewerUserId,
    );
  }
  return hostQueryKeys.method<HostRpcRegistry, typeof HOST_READ_METHOD>(
    hostId,
    HOST_READ_METHOD,
    EMPTY_PARAMS,
  );
}

export interface HostEnvironmentBindings {
  /** Each answering host's binding, keyed by the host it was asked of. */
  readonly byHostId: ReadonlyMap<string, EnvironmentHostBinding>;
  /**
   * Hosts whose read FAILED (refused, timed out, unreachable mid-read). They
   * are not in `byHostId`, and a surface that lists candidates by binding
   * says so rather than silently leaving them out - a host that could not be
   * asked is not a host that runs some other environment.
   */
  readonly failedHostIds: ReadonlyArray<string>;
  /** Asks the failed hosts again. A no-op when none failed. */
  readonly retryFailed: () => void;
}

/**
 * SEVERAL hosts' bindings at once - the create form's question "which of my
 * hosts run this environment?" (Tracy Bots) and Settings' host labels. One
 * query per host under {@link hostEnvironmentBindingQueryKey}, so the answer
 * coalesces with the Settings picker's read of the same host and takes its
 * bind. In a build with a pool every row is read from the pool, which needs
 * no connection to the host; without one each host is asked for its own,
 * resolved by name through the binding seam, never by borrowing the
 * subtree's ambient host identity.
 */
export function useHostEnvironmentBindings(
  hostIds: ReadonlyArray<string>,
  enabled: boolean,
): HostEnvironmentBindings {
  const binding = useHostBinding();
  const viewerUserId = useCloudChatViewerId();
  const fromPool = readsHostBindingsFromPool();
  const idsKey = hostIds.join("\n");
  const hostIdList = useMemo(
    () => idsKey.split("\n").filter((id) => id.length > 0),
    [idsKey],
  );
  const combine = useCallback(
    (
      results: Array<UseQueryResult<EnvironmentHostBinding>>,
    ): HostEnvironmentBindings => {
      const byHostId = new Map<string, EnvironmentHostBinding>();
      const failedHostIds: string[] = [];
      const failedRefetches: Array<() => Promise<unknown>> = [];
      // Positional, and safe by construction: `useQueries` returns results in
      // the order the queries were given, so index `n` is `hostIdList[n]`.
      results.forEach((result, index) => {
        if (index >= hostIdList.length) return;
        const hostId = hostIdList[index];
        if (result.data !== undefined) {
          byHostId.set(hostId, result.data);
        } else if (result.status === "error") {
          failedHostIds.push(hostId);
          failedRefetches.push(result.refetch);
        }
      });
      return {
        byHostId,
        failedHostIds,
        retryFailed: () => {
          for (const refetch of failedRefetches) void refetch();
        },
      };
    },
    [hostIdList],
  );
  return useQueries({
    queries: hostIdList.map((hostId) =>
      // `binding` only resolves the client, whose answer the key already
      // names (the pool's for this viewer, or `hostId`'s own); adding it
      // would refetch on binding identity drift alone. `fromPool` is fixed
      // for the process.
      // eslint-disable-next-line @tanstack/query/exhaustive-deps
      queryOptions({
        queryKey: hostEnvironmentBindingQueryKey(hostId, viewerUserId),
        queryFn: ({ signal }): Promise<EnvironmentHostBinding> => {
          if (fromPool) {
            return withHostQueryErrorBoundary(POOL_READ_METHOD, async () => {
              if (binding === null) {
                throw hostClientUnavailableError(POOL_READ_METHOD);
              }
              const client = resolvePoolTierHostClient(binding.hostClient);
              return client.requestWithSignal(
                POOL_READ_METHOD,
                { hostId },
                signal,
              );
            });
          }
          return withHostQueryErrorBoundary(HOST_READ_METHOD, async () => {
            const client = resolveNamedHostClient(binding, hostId);
            if (client === null) {
              throw hostClientUnavailableError(HOST_READ_METHOD);
            }
            return client.requestWithSignal(
              HOST_READ_METHOD,
              EMPTY_PARAMS,
              signal,
            );
          });
        },
        // The pool's answer is the account's: wait for the viewer it is
        // filed under.
        enabled: enabled && (!fromPool || viewerUserId.length > 0),
        staleTime: BINDING_STALE_MS,
        refetchOnWindowFocus: false,
      }),
    ),
    combine,
  });
}
