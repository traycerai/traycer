import { useCallback, useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentHostListResponseV11,
  EnvironmentHostRecordV11,
} from "@traycer/protocol/host/environment/contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostQueries,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";

const METHOD = "environment.host.list";

export interface EnvironmentHostLists {
  /**
   * Each answered environment's machines, keyed by environment id. An
   * environment whose list has not answered (pending, failed, or not asked)
   * is absent, so a reader can tell "no such machine" from "not known".
   */
  readonly hostsByEnvironmentId: ReadonlyMap<
    string,
    ReadonlyArray<EnvironmentHostRecordV11>
  >;
  /** Environments whose last read FAILED (refused, timed out), including a
   * refetch of a list that had answered before; never in the map. */
  readonly failedEnvironmentIds: ReadonlySet<string>;
  /** Asks the failed environments again. A no-op when none failed. */
  readonly retryFailed: () => void;
}

/**
 * `environment.host.list` for several team environments at once, on one
 * client (Tracy Bots): the machines each environment's members may see -
 * its sandboxes, whoever added them, plus the caller's own bound hosts.
 *
 * `enabled` is the capability gate the caller resolved with
 * `useHostMethodSupport` on the same client's host.
 */
export function useEnvironmentHostLists(
  client: HostClient<HostRpcRegistry> | null,
  environmentIds: ReadonlyArray<string>,
  enabled: boolean,
): EnvironmentHostLists {
  const idsKey = environmentIds.join("\n");
  const ids = useMemo(
    () => idsKey.split("\n").filter((id) => id.length > 0),
    [idsKey],
  );
  const requests = useMemo(
    (): ReadonlyArray<HostRequestSpec<HostRpcRegistry, typeof METHOD>> =>
      ids.map((environmentId) => ({
        method: METHOD,
        params: { environmentId },
      })),
    [ids],
  );
  // Stable per id list, so `useQueries` hands back the same lists until an
  // answer moves rather than new ones every render.
  const combine = useCallback(
    (
      results: Array<
        UseQueryResult<EnvironmentHostListResponseV11, HostRpcError>
      >,
    ): EnvironmentHostLists => {
      const hostsByEnvironmentId = new Map<
        string,
        ReadonlyArray<EnvironmentHostRecordV11>
      >();
      const failedEnvironmentIds = new Set<string>();
      const failedRefetches: Array<() => Promise<unknown>> = [];
      // Positional: `useQueries` answers in request order.
      results.forEach((result, index) => {
        if (index >= ids.length) return;
        // Error first: a refetch that fails keeps the last answer in `data`,
        // and a list that could not be re-read is not a current answer.
        if (result.status === "error") {
          failedEnvironmentIds.add(ids[index]);
          failedRefetches.push(result.refetch);
        } else if (result.data !== undefined) {
          hostsByEnvironmentId.set(ids[index], result.data.hosts);
        }
      });
      return {
        hostsByEnvironmentId,
        failedEnvironmentIds,
        retryFailed: () => {
          for (const refetch of failedRefetches) void refetch();
        },
      };
    },
    [ids],
  );
  return useHostQueries<HostRpcRegistry, typeof METHOD, EnvironmentHostLists>({
    client,
    requests,
    cacheKeyIdentity: undefined,
    options: { enabled, refetchOnWindowFocus: false },
    combine,
  });
}
