import { notificationHookVariable } from "@traycer-clients/shared/environment/notification-hook-values";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import {
  EnvironmentCloudError,
  NEEDS_CONNECTION_MESSAGE,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  readAccountNotificationSettings,
  saveAccountNotificationHooks,
} from "@traycer-clients/shared/environment/account-notifications";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  StreamRuntimeContext,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import { refreshConnectedAccountSettings } from "@/lib/host/refresh-connected-account-settings";
import { NotificationHooksAccountSaveError } from "@/lib/notifications/notification-hooks-account-save-error";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { use } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  HostRpcError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  useHostScopedMutationForClient,
  type HostScopedMutationContext,
} from "@/hooks/host/use-host-scoped-mutation";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import {
  notificationsMutationKeys,
  notificationsQueryKeys,
} from "@/lib/query-keys";

export type NotificationHooksStatusQuery = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.notificationHooks.status">,
  HostRpcError
>;
export type NotificationHooksTestMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notificationHooks.test">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.notificationHooks.test">,
  { readonly hostId: string | null }
>;
interface AccountHooksSaveContext {
  readonly cloud: EnvironmentCloud | null;
  readonly binding: HostRuntimeBinding<HostRpcRegistry> | null;
  readonly stream: StreamRuntimeBinding | null;
  readonly viewerId: string;
}

export type NotificationHooksSaveMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notificationHooks.save">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.notificationHooks.save">,
  HostScopedMutationContext<AccountHooksSaveContext>
>;

export function useNotificationHooksStatus(): NotificationHooksStatusQuery {
  return useNotificationHooksStatusForClient(useHostClient());
}

export function useNotificationHooksStatusForClient(
  client: HostClient<HostRpcRegistry> | null,
): NotificationHooksStatusQuery {
  return useHostQuery<HostRpcRegistry, "host.notificationHooks.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.notificationHooks.status",
    params: {},
    options: null,
  });
}

export function useNotificationHooksTest(): NotificationHooksTestMutation {
  return useNotificationHooksTestForClient(useHostClient());
}

export function useNotificationHooksTestForClient(
  client: HostClient<HostRpcRegistry> | null,
): NotificationHooksTestMutation {
  return useHostScopedMutationForClient(client, {
    method: "host.notificationHooks.test",
    mutationKey: notificationsMutationKeys.testHook(),
    errorMessage: "Couldn't run the hook test.",
    invalidateMethods: ["host.notificationHooks.status"],
  });
}

export function useNotificationHooksSave(): NotificationHooksSaveMutation {
  return useNotificationHooksSaveForClient(useHostClient());
}

export function useNotificationHooksSaveForClient(
  client: HostClient<HostRpcRegistry> | null,
): NotificationHooksSaveMutation {
  const source = useEnvironmentCloud();
  const binding = useHostBinding();
  const stream = use(StreamRuntimeContext);
  const viewerId = useCloudChatViewerId();
  const queries = useQueryClient();
  return useHostScopedMutationForClient(client, {
    method: "host.notificationHooks.save",
    // The list is saved whole, against the revision it was read at.
    prepareRequest: (request, requester) => {
      const hostId = requester.getActiveHostId();
      const version =
        hostId === null
          ? null
          : readNegotiatedMethodVersion(hostId, "host.notificationHooks.save");
      if (
        request.configurationRevision === null &&
        (version === null || version === false || version.major >= 3)
      ) {
        throw new HostRpcError({
          code: "E_INVALID_ARGUMENT",
          requestId: "hooks-refresh-required",
          method: "host.notificationHooks.save",
          fatalDetails: null,
          message:
            "Notification hooks changed. Refresh the list before saving.",
        });
      }
      return Promise.resolve(request);
    },
    captureContext: () => ({
      cloud: source?.() ?? null,
      binding,
      stream,
      viewerId,
    }),
    onSuccess: async (response, _request, _hostId, captured) => {
      try {
        if (response.accountHooks !== null) {
          if (captured.cloud === null)
            throw new EnvironmentCloudError(
              "no_response",
              NEEDS_CONNECTION_MESSAGE.settings,
            );
          const hooks = response.accountHooks.map((hook) => {
            if (
              hook.action.type !== "http" ||
              notificationHookVariable(hook) !== null
            )
              throw new EnvironmentCloudError(
                "invalid",
                "The settings request was refused.",
              );
            return { ...hook, action: hook.action, held: false };
          });
          const current = await readAccountNotificationSettings(captured.cloud);
          await saveAccountNotificationHooks(captured.cloud, {
            hooks,
            revision: current.revision,
          });
        }
        if (
          captured.cloud !== null &&
          captured.binding !== null &&
          captured.cloud.onOriginSignIn()
        ) {
          await refreshConnectedAccountSettings(
            captured.binding,
            captured.stream,
            captured.viewerId,
            captured.cloud.onOriginSignIn,
          );
        }
      } catch (error) {
        throw new NotificationHooksAccountSaveError(
          error,
          response.configurationRevision,
        );
      }
    },
    onSettled: (_hostId, captured) => {
      void queries.invalidateQueries({
        queryKey: notificationsQueryKeys.accountSettings(captured.viewerId),
      });
    },
    mutationKey: notificationsMutationKeys.saveHooks(),
    errorMessage: "Couldn't save notification hooks.",
    invalidateMethods: ["host.notificationHooks.status"],
  });
}
