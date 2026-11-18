import { useCallback } from "react";
import {
  useNotificationEntries,
  useNotificationUnreadCount,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import type { NotificationEntry } from "@traycer/protocol/notifications/notification-entry";

export interface NotificationsActions {
  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
}

export function useNotificationsActions(): NotificationsActions {
  const markAsRead = useNotificationsStore((s) => s.markAsRead);
  const markAllAsRead = useNotificationsStore((s) => s.markAllAsRead);
  const clearAll = useNotificationsStore((s) => s.clearAll);

  return {
    markAsRead: useCallback((id: string) => markAsRead(id), [markAsRead]),
    markAllAsRead: useCallback(() => markAllAsRead(), [markAllAsRead]),
    clearAll: useCallback(() => clearAll(), [clearAll]),
  };
}

export function useNotificationsList(): ReadonlyArray<NotificationEntry> {
  return useNotificationEntries();
}

export function useNotificationsUnread(): number {
  return useNotificationUnreadCount();
}
