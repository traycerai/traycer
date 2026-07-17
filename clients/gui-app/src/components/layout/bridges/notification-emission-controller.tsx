import { useCallback, useEffect, useRef } from "react";
import {
  displayAppLocalNotification,
  playNotificationChime,
} from "@/lib/notifications/notification-display";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { useNotificationShow } from "@/hooks/notifications/use-notifications";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  appLocalDisplayDeliveryKey,
  captureAppLocalDisplayReceiptSession,
  hasAppLocalDisplayReceipt,
  isAppLocalDisplayReceiptSessionCurrent,
  recordAppLocalDisplayReceipt,
  type AppLocalDisplayReceiptVersion,
} from "@/lib/notifications/app-local-display-receipts";

export function NotificationEmissionController(): null {
  const showNotification = useNotificationShow();
  const { activate } = useNotificationActivation();
  const inFlightVersionsRef = useRef(new Set<string>());
  const drainScheduledRef = useRef(false);
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

  const drainPendingNotifications = useCallback((): void => {
    const state = useAppLocalNotificationsStore.getState();
    const userId = state.activeUserId;
    if (userId === null) return;

    state.orderedIds
      .map((id) => state.byId[id])
      .filter((entry) => entry.readAt === null)
      .forEach((entry) => {
        // Rows persisted before display receipts existed have no field. They
        // are deliberately silent so upgrading cannot replay an unread backlog.
        if (entry.displayedUpdatedAt === undefined) return;
        const version: AppLocalDisplayReceiptVersion = {
          userId,
          notificationId: entry.id,
          updatedAt: entry.updatedAt,
        };
        const deliveryKey = appLocalDisplayDeliveryKey(version);
        if (hasAppLocalDisplayReceipt(version)) {
          state.markAsDisplayed(entry.id, entry.updatedAt);
          return;
        }
        if (entry.displayedUpdatedAt === entry.updatedAt) {
          recordAppLocalDisplayReceipt(version);
          return;
        }
        if (inFlightVersionsRef.current.has(deliveryKey)) return;
        const receiptSession = captureAppLocalDisplayReceiptSession(userId);
        inFlightVersionsRef.current.add(deliveryKey);
        void displayAppLocalNotification(
          entry,
          {
            showNotification,
            playChime: playNotificationChime,
            onToastClick,
          },
          deliveryKey,
        )
          .then(() => {
            if (!isAppLocalDisplayReceiptSessionCurrent(receiptSession)) return;
            recordAppLocalDisplayReceipt(version);
            const current = useAppLocalNotificationsStore.getState();
            if (current.activeUserId === userId) {
              current.markAsDisplayed(entry.id, entry.updatedAt);
            }
          })
          .catch(() => {
            // Keep the receipt pending so a later mount can retry native display.
          })
          .finally(() => {
            inFlightVersionsRef.current.delete(deliveryKey);
          });
      });
  }, [showNotification, onToastClick]);

  const scheduleDrain = useCallback((): void => {
    if (drainScheduledRef.current) return;
    drainScheduledRef.current = true;
    queueMicrotask(() => {
      drainScheduledRef.current = false;
      drainPendingNotifications();
    });
  }, [drainPendingNotifications]);

  useEffect(() => {
    drainPendingNotifications();
    return useAppLocalNotificationsStore.subscribe(scheduleDrain);
  }, [drainPendingNotifications, scheduleDrain]);

  return null;
}
