import { useCallback, useMemo } from "react";
import {
  queryOptions,
  useQueries,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  EnvironmentHostBinding,
  EnvironmentHostReadRequest,
} from "@traycer/protocol/host/environment/contracts";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { queryKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";

const METHOD = "environment.host.read";
const EMPTY_PARAMS: EnvironmentHostReadRequest = {};
const BINDING_STALE_MS = 30_000;

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
 * `environment.host.read` asked of SEVERAL hosts at once - the create form's
 * question "which of my hosts run this environment?" (Tracy Bots). One query
 * per host under that host's own `["host", hostId, method, params]` key, so
 * the answer coalesces with the Settings picker's read of the same host and
 * is invalidated by its bind. Each host is resolved by name through the
 * binding seam, never by borrowing the subtree's ambient host identity.
 */
export function useHostEnvironmentBindings(
  hostIds: ReadonlyArray<string>,
  enabled: boolean,
): HostEnvironmentBindings {
  const binding = useHostBinding();
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
      // `binding` only resolves the client for `hostId`, which the key already
      // carries through `hostQueryKeys.scope`; adding it would refetch on
      // binding identity drift alone.
      // eslint-disable-next-line @tanstack/query/exhaustive-deps
      queryOptions({
        queryKey: queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(
          hostId,
          METHOD,
          EMPTY_PARAMS,
        ),
        queryFn: ({ signal }) =>
          withHostQueryErrorBoundary(METHOD, async () => {
            const client = resolveNamedHostClient(binding, hostId);
            if (client === null) throw hostClientUnavailableError(METHOD);
            return client.requestWithSignal(METHOD, EMPTY_PARAMS, signal);
          }),
        enabled,
        staleTime: BINDING_STALE_MS,
        refetchOnWindowFocus: false,
      }),
    ),
    combine,
  });
}
