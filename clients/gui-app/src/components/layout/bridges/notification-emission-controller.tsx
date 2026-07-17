import { useCallback, useEffect } from "react";
import {
  displayAppLocalNotification,
  playNotificationChime,
} from "@/lib/notifications/notification-display";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { useNotificationShow } from "@/hooks/notifications/use-notifications";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";

export function NotificationEmissionController(): null {
  const showNotification = useNotificationShow();
  const { activate } = useNotificationActivation();
  const onToastClick = useCallback(
    (row: MergedNotificationRow, activatedAt: number): void => {
      if (row.payload === null) return;
      activate({
        payload: row.payload,
        receivedAt: activatedAt,
        onActivated: null,
      });
    },
    [activate],
  );

  useEffect(() => {
    return useAppLocalNotificationsStore.subscribe((state, previous) => {
      const newUnreadEntries = state.orderedIds
        .map((id) => state.byId[id])
        .filter((entry) => entry.readAt === null)
        .filter((entry) => !Object.hasOwn(previous.byId, entry.id));
      for (const entry of newUnreadEntries) {
        displayAppLocalNotification(entry, {
          showNotification,
          playChime: playNotificationChime,
          onToastClick,
        });
      }
    });
  }, [showNotification, onToastClick]);

  return null;
}
