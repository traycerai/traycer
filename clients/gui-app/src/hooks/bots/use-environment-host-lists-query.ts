import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useCallback, useMemo } from "react";
import {
  queryOptions,
  useQueries,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentHostListResponseV12,
  EnvironmentHostRecordV11,
} from "@traycer/protocol/host/environment/contracts";
import {
  beginEnvironmentCloudOperation,
  environmentCloudQueryKey,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

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
 * `environment.host.list` for several environments at once, each the app's
 * own read of authn on the viewer's sign-in (Tracy Bots): the machines each
 * environment's members may see - its sandboxes, whoever added them, plus
 * the caller's own bound hosts.
 *
 * Each list carries the caller's own bound hosts, so its key carries the
 * viewer and the read waits until the viewer resolves, as
 * `useEnvironmentListQuery` does: an account switch marks keys stale without
 * dropping them, and an unpartitioned entry would show the previous
 * account's machines to the next one until its refetch lands.
 */
export function useEnvironmentHostLists(
  environmentIds: ReadonlyArray<string>,
  enabled: boolean,
): EnvironmentHostLists {
  const cloud = useEnvironmentCloud();
  const viewerUserId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const idsKey = environmentIds.join("\n");
  const ids = useMemo(
    () => idsKey.split("\n").filter((id) => id.length > 0),
    [idsKey],
  );
  // Stable per id list, so `useQueries` hands back the same lists until an
  // answer moves rather than new ones every render.
  const combine = useCallback(
    (
      results: Array<
        UseQueryResult<EnvironmentHostListResponseV12, HostRpcError>
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
  return useQueries({
    queries: ids.map((environmentId) =>
      // `cloud` is the sign-in of the viewer the key already names; adding it
      // would refetch on its identity alone.
      // eslint-disable-next-line @tanstack/query/exhaustive-deps
      queryOptions<EnvironmentHostListResponseV12, HostRpcError>({
        queryKey: environmentCloudQueryKey(
          METHOD,
          { environmentId },
          viewerUserId,
          [],
        ),
        queryFn: () =>
          beginEnvironmentCloudOperation(cloud)(METHOD, { environmentId }),
        enabled:
          enabled && cloud !== null && viewerUserId.length > 0 && authorized,
        refetchOnWindowFocus: false,
      }),
    ),
    combine,
  });
}
