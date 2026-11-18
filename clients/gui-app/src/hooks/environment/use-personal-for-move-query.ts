import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  readPersonalForMove,
  type PersonalForMove,
} from "@traycer-clients/shared/environment/personal-for-move";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { environmentQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/** Read afresh per sheet, never kept or refetched: the plan is drawn against this one read. */
export function usePersonalForMoveQuery(
  enabled: boolean,
): UseQueryResult<PersonalForMove | null> {
  const cloud = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useQuery(
    // `cloud` is the sign-in of the viewer the key already names; adding it
    // would refetch on its identity alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<PersonalForMove | null>({
      queryKey: environmentQueryKeys.personalForMove(viewerId),
      queryFn: () => (cloud === null ? null : readPersonalForMove(cloud())),
      enabled: enabled && cloud !== null && viewerId.length > 0 && authorized,
      staleTime: (query) =>
        query.state.data === null ? 0 : Number.POSITIVE_INFINITY,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  );
}
