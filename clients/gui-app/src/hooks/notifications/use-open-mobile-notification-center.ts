import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
} from "@/lib/analytics";
import {
  useMergedNotificationUnreadCount,
  useNotificationBellState,
  useNotificationCenterHostState,
} from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

/**
 * Opens the phone's notifications sheet with the desktop bell's open telemetry
 * (notifications-bell.tsx). That bell isn't mounted on mobile, so its
 * edge-triggered open effect never fires - the callers are the sole open paths
 * here, and each is a direct UI interaction, hence entry_point "direct_ui".
 */
export function useOpenMobileNotificationCenter(): () => void {
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  const unread = useMergedNotificationUnreadCount();
  const bellState = useNotificationBellState();
  const hostState = useNotificationCenterHostState();
  return () => {
    const attentionCount = bellState.kind === "attention" ? bellState.count : 0;
    Analytics.getInstance().track(AnalyticsEvent.NotificationCenterOpened, {
      entry_point: "direct_ui",
      host_state: hostState.isPartial ? "unknown" : "exact",
      attention_bucket:
        bellState.kind === "unknown"
          ? "unknown"
          : analyticsCountBucket(attentionCount),
      unread_bucket:
        bellState.kind === "unknown" ? "unknown" : analyticsCountBucket(unread),
    });
    setOpen(true);
  };
}
