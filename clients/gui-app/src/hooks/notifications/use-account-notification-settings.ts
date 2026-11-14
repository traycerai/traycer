import { use } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  readAccountNotificationSettings,
  saveAccountNotificationMatrix,
  saveAccountNotificationHooks,
} from "@traycer-clients/shared/environment/account-notifications";
import {
  EnvironmentCloudError,
  NEEDS_CONNECTION_MESSAGE,
  type EnvironmentCloud,
} from "@traycer-clients/shared/environment/environment-cloud";
import type {
  AccountNotificationMatrixPutRequest,
  AccountNotificationHooksPutRequest,
  AccountNotificationSettingsResponse,
} from "@traycer-clients/shared/environment/account-notification-schemas";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostBinding } from "@/lib/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { refreshConnectedAccountSettings } from "@/lib/host/refresh-connected-account-settings";
import {
  notificationsQueryKeys,
  notificationsMutationKeys,
} from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/** The account row is independent of the selected computer and the picked team. */
export function useAccountNotificationSettings() {
  const source = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useQuery<AccountNotificationSettingsResponse, EnvironmentCloudError>(
    // The session service is represented by the viewer, never serialized into a cache key.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<AccountNotificationSettingsResponse, EnvironmentCloudError>({
      queryKey: notificationsQueryKeys.accountSettings(viewerId),
      queryFn: () => {
        if (source === null)
          throw new EnvironmentCloudError(
            "no_response",
            NEEDS_CONNECTION_MESSAGE.settings,
          );
        return readAccountNotificationSettings(source());
      },
      enabled: source !== null && viewerId.length > 0 && authorized,
    }),
  );
}

/** Save on one sign-in, then ask its already-connected computers to refresh once. */
function useAccountNotificationWrite<Request>(
  mutationKey: readonly string[],
  write: (
    cloud: EnvironmentCloud,
    request: Request,
  ) => Promise<AccountNotificationSettingsResponse>,
) {
  const source = useEnvironmentCloud();
  const viewerId = useCloudChatViewerId();
  const binding = useHostBinding();
  const stream = use(StreamRuntimeContext);
  const queries = useQueryClient();
  const queryKey = notificationsQueryKeys.accountSettings(viewerId);
  return useMutation<
    AccountNotificationSettingsResponse,
    EnvironmentCloudError,
    Request
  >({
    mutationKey,
    mutationFn: async (request) => {
      if (source === null)
        throw new EnvironmentCloudError(
          "no_response",
          NEEDS_CONNECTION_MESSAGE.settings,
        );
      const cloud = source();
      const answer = await write(cloud, request);
      if (binding !== null && cloud.onOriginSignIn()) {
        await refreshConnectedAccountSettings(
          binding,
          stream,
          viewerId,
          cloud.onOriginSignIn,
        );
      }
      return answer;
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey });
    },
  });
}

export function useAccountNotificationMatrixSave() {
  return useAccountNotificationWrite<AccountNotificationMatrixPutRequest>(
    notificationsMutationKeys.accountMatrix(),
    saveAccountNotificationMatrix,
  );
}

export function useAccountNotificationHooksSave() {
  return useAccountNotificationWrite<AccountNotificationHooksPutRequest>(
    notificationsMutationKeys.accountHooks(),
    saveAccountNotificationHooks,
  );
}
