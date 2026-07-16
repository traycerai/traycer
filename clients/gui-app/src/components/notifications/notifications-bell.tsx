import { useCallback } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useMergedNotificationUnreadCount } from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { cn } from "@/lib/utils";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Top-level notifications trigger in the app header. Shows an unread-count
 * badge and opens the `NotificationsPopover` on click. Native toast/chime
 * emission is owned by `NotificationEmissionController` so all sources share
 * the same hold/coalescing/focus policy.
 */
export function NotificationsBell() {
  const open = useNotificationsPopoverStore((state) => state.open);
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  const unread = useMergedNotificationUnreadCount();
  useTitleBarDragSuppression("notifications", open);

  const handleNavigate = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const ariaLabel =
    unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          Analytics.getInstance().track(
            AnalyticsEvent.NotificationCenterOpened,
            null,
          );
        }
        setOpen(nextOpen);
      }}
    >
      <TooltipWrapper
        label={open ? null : "Notifications"}
        side="top"
        sideOffset={6}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="notifications-bell"
            aria-label={ariaLabel}
            className={cn("relative", open && "bg-accent")}
          >
            <Bell
              className="size-4 text-muted-foreground group-hover/button:text-foreground"
              aria-hidden
            />
            {unread > 0 && (
              <span
                data-testid="notifications-unread-badge"
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-md bg-destructive px-1 text-overline font-semibold leading-none text-destructive-foreground tabular-nums shadow-sm ring-2 ring-background"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="end"
        className="w-auto overflow-hidden p-0"
        onOpenAutoFocus={(event: Event) => event.preventDefault()}
      >
        <NotificationsPopover onNavigate={handleNavigate} />
      </PopoverContent>
    </Popover>
  );
}
