import { useEffect } from "react";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";

/**
 * Tells the shell each time the cloud feed's rows change, a resent frame of the
 * same version included, with the account the feed is for: a notification the
 * OS still lists may just have been read or cleared on another device. The
 * app's own read marks change the rows too, which costs the shell one more
 * check. Mount once per window; a shell with no delivered-notification list
 * gets nothing.
 */
export function useDeliveredNotificationsFeedTrigger(): void {
  const { deliveredNotifications } = useRunnerHost();
  useEffect(() => {
    if (deliveredNotifications === null) return;
    return useCloudNotificationsStore.subscribe((state, previous) => {
      if (state.rows === previous.rows || !state.hasSnapshot) return;
      if (state.accountId === null) return;
      deliveredNotifications.noteCloudFeedFrame(state.accountId);
    });
  }, [deliveredNotifications]);
}
