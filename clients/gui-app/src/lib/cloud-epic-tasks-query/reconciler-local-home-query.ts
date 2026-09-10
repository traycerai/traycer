import { queryOptions } from "@tanstack/react-query";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  fetchCloudEpicTasksFirstPageByHostId,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query/query";

const LOCAL_HOME_LIST_METHOD = "epic.listTasks" as const;

interface EpicTabLocalHomeListQueryArgs {
  readonly hostId: string;
  readonly userId: string;
  readonly params: ListCloudTasksRequest;
  readonly cacheKeyIdentity: string;
}

/**
 * The destructive tab reconciler reads its local-home exemption through the
 * same identity-bound list boundary as History. Its query key is captured from
 * a reconciliation run, so its eventual request must fail closed rather than
 * send a later principal's page into that run's cache entry.
 */
export function epicTabLocalHomeListQueryOptions(
  args: EpicTabLocalHomeListQueryArgs,
) {
  return queryOptions<ListTasksResponse>({
    queryKey: [
      ...queryKeys.hostMethod<HostRpcRegistry, typeof LOCAL_HOME_LIST_METHOD>(
        args.hostId,
        LOCAL_HOME_LIST_METHOD,
        args.params,
      ),
      args.userId,
      args.cacheKeyIdentity,
      "local-home",
    ],
    queryFn: ({ signal }) =>
      fetchCloudEpicTasksFirstPageByHostId(args.hostId, args.userId, {
        request: args.params,
        abortSignal: signal,
        localFirstPhase: undefined,
        requestContextPolicy: "require-current",
      }),
  });
}
