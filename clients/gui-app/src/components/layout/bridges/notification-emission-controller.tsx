import { useEffect } from "react";
import {
  displayAppLocalNotification,
  playNotificationChime,
} from "@/lib/notifications/notification-display";
import { useNotificationShow } from "@/hooks/notifications/use-notifications";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";

export function NotificationEmissionController(): null {
  const showNotification = useNotificationShow();

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
        });
      }
    });
  }, [showNotification]);

  return null;
}
