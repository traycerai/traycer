import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { PushSeverity } from "@traycer-clients/shared/platform/runner-host";
import type { PushPermissionStatus } from "@/hooks/runner/use-push-permission-query";
import type { NotificationChimeEventType } from "@/lib/notifications/notification-chime";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

export type NotificationNotifies = (
  eventType: NotificationChimeEventType,
) => boolean;

/**
 * Whether a kind of notification may interrupt on this device, as Settings →
 * Alerts sets it. Read at each arrival, so a change applies to the next one.
 *
 * A computer answers from its own Notify switches. A phone answers from its
 * Push switches instead, the set it has muted for the signed-in account: one
 * switch decides both the push while the app is away and the toast while it
 * is in front. Until that set is known, or while push is not on (when the
 * switches cannot be changed either), every kind interrupts, as it did before
 * the switches existed. `NotificationEmissionController` keeps the phone's
 * two reads current app-wide; this only reads what they cached.
 */
export function useNotificationNotifies(): NotificationNotifies {
  const pushPermission = useRunnerHostOrNull()?.pushPermission ?? null;
  const queryClient = useQueryClient();
  return useCallback(
    (eventType) =>
      pushPermission === null
        ? useSettingsStore.getState().notificationNotify[eventType]
        : !phoneMutes(queryClient, eventType),
    [pushPermission, queryClient],
  );
}

function phoneMutes(
  queryClient: QueryClient,
  eventType: NotificationChimeEventType,
): boolean {
  const status = queryClient.getQueryData<PushPermissionStatus>(
    runnerQueryKeys.pushPermission(),
  );
  if (status?.permission !== "granted" || status.registration !== "registered")
    return false;
  const userId = useAuthStore.getState().contextMetadata?.userId ?? null;
  const muted = queryClient.getQueryData<readonly PushSeverity[]>(
    runnerQueryKeys.pushMutedSeverities(userId),
  );
  return muted?.includes(eventType) === true;
}
