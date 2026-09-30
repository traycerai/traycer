import { useCallback } from "react";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";
import {
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";

/**
 * Opens a waiting prompt's chat on its pending card through the
 * notification's own activation: the Needs you block's rows and the tasks'
 * needs-you rows both go through it. Nothing is approved or answered here.
 */
export function useNeedsYouActivation(): (row: MergedNotificationRow) => void {
  const { activate } = useNotificationActivation();
  const { markAsRead } = useMergedNotificationsActions();
  return useCallback(
    (row: MergedNotificationRow) => {
      if (row.payload === null) return;
      activate({
        payload: row.payload,
        receivedAt: Date.now(),
        feedId: row.feedId,
        originHostId: row.originHostId,
        onResult: activationResultHandler({
          row,
          feedId: row.feedId,
          surface: "strip",
          markAsRead,
          onSuccess: null,
        }),
      });
    },
    [activate, markAsRead],
  );
}
