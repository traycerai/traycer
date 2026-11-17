import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  displayAppLocalNotification,
  displayForwardedForegroundNotification,
  playNotificationChime,
} from "@/lib/notifications/notification-display";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useNotificationNotifies } from "@/hooks/notifications/use-notification-notifies";
import { usePushMutedSeveritiesQuery } from "@/hooks/runner/use-push-muted-severities-query";
import { usePushPermissionQuery } from "@/hooks/runner/use-push-permission-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  APP_LOCAL_NOTIFICATION_SEVERITY,
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import {
  useNotificationForegroundDisplay,
  useNotificationShow,
} from "@/hooks/notifications/use-notifications";
import {
  parseForegroundAppLocalNotificationEntry,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { useNotificationEventsStore } from "@/stores/notifications/notification-events-store";
import type { NotificationForegroundDisplay } from "@traycer-clients/shared/platform/runner-host";
import {
  appLocalDisplayDeliveryKey,
  captureAppLocalDisplayReceiptSession,
  hasAppLocalDisplayReceipt,
  hasAppLocalDisplayRefusal,
  isAppLocalDisplayReceiptSessionCurrent,
  recordAppLocalDisplayReceipt,
  recordAppLocalDisplayRefusal,
  type AppLocalDisplayReceiptVersion,
} from "@/lib/notifications/app-local-display-receipts";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";

export function NotificationEmissionController(): ReactNode {
  const { pushPermission } = useRunnerHost();
  const showNotification = useNotificationShow();
  const notifies = useNotificationNotifies();
  const { activate } = useNotificationActivation();
  const actions = useMergedNotificationsActions();
  const inFlightVersionsRef = useRef(new Set<string>());
  const drainScheduledRef = useRef(false);
  const onForegroundDisplay = useCallback(
    (display: NotificationForegroundDisplay): void => {
      const foregroundAppLocal = display.foregroundAppLocal;
      if (foregroundAppLocal !== null) {
        const state = useAppLocalNotificationsStore.getState();
        const entry = parseForegroundAppLocalNotificationEntry(
          foregroundAppLocal.entry,
        );
        if (
          entry === null ||
          state.activeUserId !== foregroundAppLocal.userId
        ) {
          return;
        }
        const version: AppLocalDisplayReceiptVersion = {
          userId: foregroundAppLocal.userId,
          notificationId: entry.id,
          updatedAt: entry.updatedAt,
        };
        recordAppLocalDisplayReceipt(version);
        state.mergeForegroundDisplayed(entry);
        // Relayed for this window's bell only: the sender's device does not
        // let the kind interrupt, so there is nothing to show or sound.
        if (foregroundAppLocal.inboxOnly) return;
      }
      displayForwardedForegroundNotification(display, {
        playChime: playNotificationChime,
        onToastClick: (payload) =>
          useNotificationEventsStore
            .getState()
            .recordInAppClick(payload, Date.now()),
        notifies,
      });
    },
    [notifies],
  );
  useNotificationForegroundDisplay(onForegroundDisplay);
  const onToastClick = useCallback(
    (row: MergedNotificationRow): void => {
      if (row.payload === null) return;
      activate({
        payload: row.payload,
        originHostId: row.originHostId,
        receivedAt: row.createdAt,
        feedId: row.feedId,
        onResult: activationResultHandler({
          row,
          feedId: row.feedId,
          surface: "toast",
          markAsRead: actions.markAsRead,
          onSuccess: null,
        }),
      });
    },
    [activate, actions],
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
        // Decided once per version and kept: a refused one whose relay fails
        // is retried inbox-only, even if its kind has been turned on since.
        const inboxOnly =
          hasAppLocalDisplayRefusal(version) ||
          !notifies(APP_LOCAL_NOTIFICATION_SEVERITY);
        if (inboxOnly) recordAppLocalDisplayRefusal(version);
        const receiptSession = captureAppLocalDisplayReceiptSession(userId);
        inFlightVersionsRef.current.add(deliveryKey);
        void displayAppLocalNotification(
          entry,
          {
            showNotification,
            playChime: playNotificationChime,
            onToastClick,
            notifies,
          },
          { deliveryKey, userId, inboxOnly },
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
  }, [showNotification, onToastClick, notifies]);

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

  return pushPermission === null ? null : <PushMuteReads />;
}

/**
 * Keeps the phone's push permission and muted set read for the whole session,
 * not only while Settings → Alerts is open, because the toast gate
 * (`useNotificationNotifies`) reads them at every arrival. Each read re-runs
 * when the phone says it may have changed. Mounted only on a shell with push.
 */
function PushMuteReads(): null {
  usePushPermissionQuery();
  usePushMutedSeveritiesQuery();
  return null;
}
