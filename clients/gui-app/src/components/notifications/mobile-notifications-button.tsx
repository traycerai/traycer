import { type ReactNode } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
} from "@/lib/analytics";
import {
  notificationBellAccessibleLabel,
  useMergedNotificationUnreadCount,
  useNotificationBellState,
  useNotificationCenterHostState,
} from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

/**
 * Notifications trigger for the phone header, sitting alongside the other
 * global status controls. The desktop `NotificationsBell` owns an anchored
 * Radix popover; on mobile the center is the full-screen
 * `NotificationsMobileSheet` driven by the same store, so this is a plain
 * button that flips it open.
 */
export function MobileNotificationsButton(): ReactNode {
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  const unread = useMergedNotificationUnreadCount();
  const bellState = useNotificationBellState();
  const hostState = useNotificationCenterHostState();

  const handleOpen = () => {
    // Mirror the desktop bell's open telemetry (notifications-bell.tsx). That
    // bell isn't mounted on mobile, so its edge-triggered open effect never
    // fires - this button is the sole open path here, and it's a direct UI
    // interaction, hence entry_point "direct_ui".
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

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={notificationBellAccessibleLabel(bellState)}
      data-testid="mobile-notifications-button"
      className="relative shrink-0 text-muted-foreground hover:text-foreground"
      onClick={handleOpen}
    >
      <Bell className="size-4" aria-hidden />
      {bellState.kind === "attention" && (
        <span
          data-testid="mobile-notifications-attention-badge"
          aria-hidden
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-md bg-destructive px-1 text-overline font-semibold leading-none text-destructive-foreground tabular-nums shadow-sm ring-2 ring-background"
        >
          {bellState.count > 99 ? "99+" : bellState.count}
        </span>
      )}
      {/* Unlike the desktop bell's quiet dot, show the unread count - this is
          the only notifications surface on phones, so the count carries real
          signal here. Dot only when the merged count hasn't resolved to a
          number yet. */}
      {bellState.kind === "quietDot" && unread > 0 && (
        <span
          data-testid="mobile-notifications-unread-badge"
          aria-hidden
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-md bg-primary px-1 text-overline font-semibold leading-none text-primary-foreground tabular-nums shadow-sm ring-2 ring-background"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
      {bellState.kind === "quietDot" && unread === 0 && (
        <span
          data-testid="mobile-notifications-quiet-dot"
          aria-hidden
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
        />
      )}
    </Button>
  );
}
