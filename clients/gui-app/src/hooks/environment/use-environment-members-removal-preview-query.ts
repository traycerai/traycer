import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  readConfigurationRemovalPreview,
  type ConfigurationRemovalPreview,
} from "@traycer-clients/shared/environment/configuration-members";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const OPERATION = "environment.members.removalPreview";

/**
 * What authn says removing `userId` changes for the team, read on the
 * person's sign-in while the removal confirm names them (`null` reads
 * nothing). Not kept once the confirm closes, and not retried behind the
 * person's back: a refused read is the query's error, which the confirm
 * offers to read again.
 */
export function useEnvironmentMembersRemovalPreviewQuery(
  environmentId: string,
  userId: string | null,
): UseQueryResult<ConfigurationRemovalPreview, HostRpcError> {
  const cloud = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useQuery(
    // `cloud` is the sign-in of the viewer the key already names; adding it
    // would refetch on its identity alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<ConfigurationRemovalPreview, HostRpcError>({
      queryKey: environmentQueryKeys.removalPreview(
        environmentId,
        userId ?? "",
        viewerId,
      ),
      queryFn: () =>
        withHostQueryErrorBoundary(OPERATION, async () => {
          cloudVerdictPreflight(OPERATION)();
          if (cloud === null || userId === null) {
            throw hostClientUnavailableError(OPERATION);
          }
          try {
            return await readConfigurationRemovalPreview(
              cloud(),
              environmentId,
              userId,
            );
          } catch (error) {
            throw environmentCloudHostError(OPERATION, error);
          }
        }),
      enabled:
        userId !== null && cloud !== null && viewerId.length > 0 && authorized,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    }),
  );
}
