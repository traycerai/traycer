import { useCallback, useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentHostListResponse,
  EnvironmentHostRecord,
} from "@traycer/protocol/host/environment/contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostQueries,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";

const METHOD = "environment.host.list";

/**
 * `environment.host.list` for several team environments at once, on one
 * client (Tracy Bots): the machines each environment's members may see -
 * its sandboxes, whoever added them, plus the caller's own bound hosts. Keyed
 * by environment id; an environment whose list has not answered (pending,
 * refused, or not asked) is absent, so a reader can tell "no such machine"
 * from "not known".
 *
 * `enabled` is the capability gate the caller resolved with
 * `useHostMethodSupport` on the same client's host.
 */
export function useEnvironmentHostLists(
  client: HostClient<HostRpcRegistry> | null,
  environmentIds: ReadonlyArray<string>,
  enabled: boolean,
): ReadonlyMap<string, ReadonlyArray<EnvironmentHostRecord>> {
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
  // Stable per id list, so `useQueries` hands back the same map until an
  // answer moves rather than a new one every render.
  const combine = useCallback(
    (
      results: Array<UseQueryResult<EnvironmentHostListResponse, HostRpcError>>,
    ): ReadonlyMap<string, ReadonlyArray<EnvironmentHostRecord>> => {
      const byEnvironmentId = new Map<
        string,
        ReadonlyArray<EnvironmentHostRecord>
      >();
      // Positional: `useQueries` answers in request order.
      results.forEach((result, index) => {
        if (index >= ids.length || result.data === undefined) return;
        byEnvironmentId.set(ids[index], result.data.hosts);
      });
      return byEnvironmentId;
    },
    [ids],
  );
  return useHostQueries<
    HostRpcRegistry,
    typeof METHOD,
    ReadonlyMap<string, ReadonlyArray<EnvironmentHostRecord>>
  >({
    client,
    requests,
    cacheKeyIdentity: undefined,
    options: { enabled, refetchOnWindowFocus: false },
    combine,
  });
}
