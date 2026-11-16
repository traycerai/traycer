import { useCallback } from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { localRowCohort } from "@/components/settings/environment/local-row-cohort";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import {
  environmentStatusMoveRunning,
  stampHostRpcMethod,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { queryKeys } from "@/lib/query-keys";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

const METHOD = "environment.status";
const EMPTY_PARAMS = {};

/**
 * Long, because the Environment dropdown is the only reader that asks every
 * computer (`isEnvironmentComputer`): a Local row changes when a person moves that
 * computer's settings, which they do from this window or from that
 * computer's own, and the one host this window shows is polled by its page.
 */
const STATUS_STALE_MS = 5 * 60_000;

/** What the key holds: the registry's answer, whatever the query types it as. */
type StatusAnswer = ResponseOfMethod<HostRpcRegistry, typeof METHOD>;

/**
 * Whether a computer's cached status asks for the status poll: its move is
 * running, or its move is done and its Local row has not turned over (the
 * host records `done` before it flips the planes the row is decided from).
 */
function movePollWanted(status: StatusAnswer | undefined): boolean {
  if (status === undefined) return false;
  return (
    environmentStatusMoveRunning(status) ||
    (status.move?.state === "done" && localRowCohort(status).kind === "local")
  );
}

/**
 * `environment.status` for each host in `hostIds`, one Query per host
 * through that host's own requester, unpolled. The key is the one
 * `useHostQuery` files the same read under, so a page that polls one host's
 * status (the Personal frame, the Overview) keeps that host's row current
 * here, and this read never duplicates it.
 *
 * A computer is polled, on the status policy's own lanes, only while its
 * cached status says its move is running or its Local row is still standing
 * after the move is done; a computer at rest is read once.
 *
 * Map entries are `null` until a host answers, and for a host that cannot
 * (`connectable` false is never dialled).
 */
export function useRegisteredHostEnvironmentStatuses(
  hosts: ReadonlyArray<{
    readonly hostId: string;
    readonly connectable: boolean;
  }>,
): ReadonlyMap<string, EnvironmentStatusResponseV12 | null> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const coordinator = getConditionPollEpisodeCoordinator(queryClient);
  const combine = useCallback(
    (
      results: Array<
        UseQueryResult<EnvironmentStatusResponseV12, HostRpcError>
      >,
    ): ReadonlyMap<string, EnvironmentStatusResponseV12 | null> =>
      new Map(
        results.map((result, index) => [
          hosts[index]?.hostId ?? "",
          result.data ?? null,
        ]),
      ),
    [hosts],
  );
  return useQueries({
    queries: hosts.map((host) => {
      const options = environmentStatusQueryOptions(
        binding,
        host.hostId,
        host.connectable && binding !== null,
      );
      const key: QueryKey = options.queryKey;
      const cached = queryClient.getQueryData<StatusAnswer>(key);
      const polling = movePollWanted(cached)
        ? coordinator.pollOptionsFor(METHOD, true)
        : {};
      return { ...options, ...polling };
    }),
    combine,
  });
}

/**
 * One host's `environment.status` read through that host's own requester,
 * unpolled, under the key `useHostQuery` files it. Shared with the binding
 * producers (`use-host-environment-bindings-query.ts`), which ask a host's
 * status before its binding.
 */
export function environmentStatusQueryOptions(
  binding: Pick<HostRuntimeBinding<HostRpcRegistry>, "hostClient"> | null,
  hostId: string,
  enabled: boolean,
) {
  // `binding` only resolves the requester, whose host the key already
  // names; adding it would refetch on binding identity drift alone.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions<EnvironmentStatusResponseV12, HostRpcError>({
    queryKey: queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(
      hostId,
      METHOD,
      EMPTY_PARAMS,
    ),
    queryFn: ({ signal }): Promise<EnvironmentStatusResponseV12> =>
      withHostQueryErrorBoundary(METHOD, async () => {
        const client = resolveNamedHostClient(binding, hostId);
        if (client === null) throw hostClientUnavailableError(METHOD);
        return client.requestWithSignal(METHOD, EMPTY_PARAMS, signal);
      }),
    meta: stampHostRpcMethod(undefined, METHOD),
    enabled,
    staleTime: STATUS_STALE_MS,
    refetchOnWindowFocus: false,
  });
}
