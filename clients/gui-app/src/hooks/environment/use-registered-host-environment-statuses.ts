import { useCallback } from "react";
import {
  queryOptions,
  useQueries,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { queryKeys } from "@/lib/query-keys";

const METHOD = "environment.status";
const EMPTY_PARAMS = {};

/**
 * Long, because the Environment dropdown is the only reader that asks every
 * registered computer: a Local row changes when a person moves that
 * computer's settings, which they do from this window or from that
 * computer's own, and the one host this window shows is polled by its page.
 */
const STATUS_STALE_MS = 5 * 60_000;

/**
 * `environment.status` for each host in `hostIds`, one Query per host
 * through that host's own requester, unpolled. The key is the one
 * `useHostQuery` files the same read under, so a page that polls one host's
 * status (the Personal frame, the Overview) keeps that host's row current
 * here, and this read never duplicates it.
 *
 * Map entries are `null` until a host answers, and for a host that cannot
 * (`connectable` false is never dialled).
 */
export function useRegisteredHostEnvironmentStatuses(
  hosts: ReadonlyArray<{
    readonly hostId: string;
    readonly connectable: boolean;
  }>,
): ReadonlyMap<string, EnvironmentStatusResponseV11 | null> {
  const binding = useHostBinding();
  const combine = useCallback(
    (
      results: Array<
        UseQueryResult<EnvironmentStatusResponseV11, HostRpcError>
      >,
    ): ReadonlyMap<string, EnvironmentStatusResponseV11 | null> =>
      new Map(
        results.map((result, index) => [
          hosts[index]?.hostId ?? "",
          result.data ?? null,
        ]),
      ),
    [hosts],
  );
  return useQueries({
    queries: hosts.map((host) =>
      // `binding` only resolves the requester, whose host the key already
      // names; adding it would refetch on binding identity drift alone.
      // eslint-disable-next-line @tanstack/query/exhaustive-deps
      queryOptions<EnvironmentStatusResponseV11, HostRpcError>({
        queryKey: queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(
          host.hostId,
          METHOD,
          EMPTY_PARAMS,
        ),
        queryFn: ({ signal }): Promise<EnvironmentStatusResponseV11> =>
          withHostQueryErrorBoundary(METHOD, async () => {
            const client = resolveNamedHostClient(binding, host.hostId);
            if (client === null) throw hostClientUnavailableError(METHOD);
            return client.requestWithSignal(METHOD, EMPTY_PARAMS, signal);
          }),
        meta: stampHostRpcMethod(undefined, METHOD),
        enabled: host.connectable && binding !== null,
        staleTime: STATUS_STALE_MS,
        refetchOnWindowFocus: false,
      }),
    ),
    combine,
  });
}
