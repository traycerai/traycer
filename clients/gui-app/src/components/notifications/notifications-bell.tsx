import { useCallback, useEffect, useRef } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import {
  useNotificationsList,
  useNotificationsUnread,
} from "@/hooks/notifications/use-notifications-stream";
import { useNotificationShow } from "@/hooks/notifications/use-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { buildPayloadFromEvent } from "@/lib/notifications";
import { formatNotification } from "@traycer/protocol/notifications/notification-formatter";
import type { NotificationEntry } from "@traycer/protocol/notifications/notification-entry";
import { cn } from "@/lib/utils";

/**
 * Top-level notifications trigger in the app header. Shows an unread-count
 * badge, opens the `NotificationsPopover` on click, and bridges new unread
 * arrivals to OS toasts (with a typed routing payload) when the popover is
 * closed.
 */
export function NotificationsBell() {
  const open = useNotificationsPopoverStore((state) => state.open);
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  const unread = useNotificationsUnread();
  const entries = useNotificationsList();
  const notify = useNotificationShow();
  const lastSeenIdsRef = useRef<Set<string> | null>(null);
  useTitleBarDragSuppression("notifications", open);
  const getLastSeenIds = useCallback(() => {
    if (lastSeenIdsRef.current === null) {
      lastSeenIdsRef.current = new Set();
    }
    return lastSeenIdsRef.current;
  }, []);
  const initialized = useRef(false);

  // OS toast bridge: fire `notifications.show(...)` for every newly-arrived
  // unread entry whose id we have not observed before, but only when the
  // popover is closed. Suppression while open matches the T7 brief.
  useEffect(() => {
    const lastSeenIds = getLastSeenIds();
    if (!initialized.current) {
      initialized.current = true;
      for (const entry of entries) {
        lastSeenIds.add(entry.id);
      }
      return;
    }
    if (open) {
      // Sync the seen-set without firing toasts so closing the popover
      // later doesn't replay older entries.
      for (const entry of entries) {
        lastSeenIds.add(entry.id);
      }
      return;
    }
    for (const entry of entries) {
      if (lastSeenIds.has(entry.id)) continue;
      lastSeenIds.add(entry.id);
      if (entry.readAt !== null) continue;
      void fireToast(notify, entry);
    }
  }, [entries, open, notify, getLastSeenIds]);

  const handleNavigate = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const ariaLabel =
    unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <NotificationsPopover onNavigate={handleNavigate} />
      </PopoverContent>
    </Popover>
  );
}

async function fireToast(
  notify: (title: string, body: string, payload: unknown) => Promise<void>,
  entry: NotificationEntry,
): Promise<void> {
  const title = "Traycer";
  const body = formatNotification(entry.event, undefined);
  const payload = buildPayloadFromEvent(entry.event);
  try {
    await notify(title, body, payload);
  } catch {
    // Silent failure mode per T7: the bell already shows the unread count;
    // a failed OS toast is not user-visible beyond the missed popup.
  }
}
