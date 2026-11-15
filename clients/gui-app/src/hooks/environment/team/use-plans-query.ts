import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  readConfigurationPlanUnlinkPreview,
  type ConfigurationPlanUnlinkPreview,
} from "@traycer-clients/shared/environment/configuration-settings";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  useEnvironmentCloud,
  useEnvironmentCloudQuery,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const UNLINK_PREVIEW_OPERATION = "environment.plans.unlinkPreview";

export function useConfigurationPlansQuery(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "environment.plans.list">,
  HostRpcError
> {
  const source = useConfigurationSource();
  return useEnvironmentCloudQuery({
    method: "environment.plans.list",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    cacheKeyIdentity: [],
    mapResponse: (response) => response,
    enabled: source.kind === "pool",
    poll: true,
  });
}

/**
 * What authn says still works for the team once `profileId` is unlinked,
 * read on the person's sign-in when Unlink opens (`null` reads nothing), so
 * the confirm can mount on current consequences. Each opening (`previewId`)
 * reads afresh. Not kept once the confirm closes, and not retried behind the
 * person's back: a refused read is the query's error, which the confirm
 * offers to read again. The turns running on the plan are the window's own
 * team computer's count (`useTeamComputerWorkNow`).
 */
export function useConfigurationPlanUnlinkPreview(
  profileId: string | null,
  previewId: string | null,
): UseQueryResult<ConfigurationPlanUnlinkPreview, HostRpcError> {
  const source = useConfigurationSource();
  const cloud = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const environmentId = source.kind === "pool" ? source.environmentId : "";
  return useQuery(
    // `cloud` is the sign-in of the viewer the key already names; adding it
    // would refetch on its identity alone.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<ConfigurationPlanUnlinkPreview, HostRpcError>({
      queryKey: environmentQueryKeys.planUnlinkPreview(
        environmentId,
        profileId ?? "",
        viewerId,
        previewId ?? "",
      ),
      queryFn: () =>
        withHostQueryErrorBoundary(UNLINK_PREVIEW_OPERATION, async () => {
          cloudVerdictPreflight(UNLINK_PREVIEW_OPERATION)();
          if (cloud === null || profileId === null) {
            throw hostClientUnavailableError(UNLINK_PREVIEW_OPERATION);
          }
          try {
            return await readConfigurationPlanUnlinkPreview(
              cloud(),
              environmentId,
              profileId,
            );
          } catch (error) {
            throw environmentCloudHostError(UNLINK_PREVIEW_OPERATION, error);
          }
        }),
      enabled:
        source.kind === "pool" &&
        profileId !== null &&
        cloud !== null &&
        viewerId.length > 0 &&
        authorized,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    }),
  );
}
