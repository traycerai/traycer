import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentMembersSeatsResponse } from "@traycer/protocol/host/environment/contracts";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  beginEnvironmentCloudOperation,
  environmentCloudQueryKey,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const METHOD = "environment.members.seats";

/**
 * `environment.members.seats` for the invite sheet, the app's own read of
 * authn on the person's sign-in, made while the sheet is open. Not kept once
 * the sheet closes, so each opening reads the seats as they are then, and
 * not retried behind the person's back: a refused read is the query's error,
 * which the sheet offers to read again.
 */
export function useEnvironmentMembersSeatsQuery(
  environmentId: string,
  enabled: boolean,
): UseQueryResult<EnvironmentMembersSeatsResponse, HostRpcError> {
  const cloud = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const queryClient = useQueryClient();
  const tablePolling = getConditionPollEpisodeCoordinator(
    queryClient,
  ).pollOptionsFor(METHOD, true);
  return useQuery(
    // `cloud` is the sign-in of the viewer the key already names; adding it
    // would refetch on its identity alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<EnvironmentMembersSeatsResponse, HostRpcError>({
      ...tablePolling,
      queryKey: environmentCloudQueryKey(
        METHOD,
        { environmentId },
        viewerId,
        [],
      ),
      queryFn: () =>
        beginEnvironmentCloudOperation(cloud)(METHOD, { environmentId }),
      meta: stampHostRpcMethod(undefined, METHOD),
      enabled: enabled && cloud !== null && viewerId.length > 0 && authorized,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    }),
  );
}
