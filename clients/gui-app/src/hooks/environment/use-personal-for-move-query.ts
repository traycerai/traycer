import { useQuery, type UseQueryResult } from "@tanstack/react-query";
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

/**
 * The person's Personal, read on their own sign-in for the move sheet that is
 * open (`readPersonalForMove`); `null` when it could not be read. Read afresh
 * for each sheet and never kept once the sheet closes, so a sheet is never
 * drawn from an older copy. Never refetched on its own while the sheet is
 * open: the plan is drawn against this one read until the sheet asks again.
 */
export function usePersonalForMoveQuery(
  enabled: boolean,
): UseQueryResult<PersonalForMove | null, Error> {
  const cloud = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useQuery<PersonalForMove | null, Error>({
    // `cloud` is the sign-in of the viewer the key already names.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: environmentQueryKeys.personalForMove(viewerId),
    queryFn: () => (cloud === null ? null : readPersonalForMove(cloud())),
    enabled: enabled && cloud !== null && viewerId.length > 0 && authorized,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
