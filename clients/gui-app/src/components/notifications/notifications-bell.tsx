import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useNotificationCenterGeometry } from "@/hooks/notifications/use-notification-center-geometry";
import { useNotificationCenterOpenLifecycle } from "@/hooks/notifications/use-notification-center-open-lifecycle";
import {
  notificationBellAccessibleLabel,
  useMergedNotificationUnreadCount,
  useNotificationBellState,
  useNotificationCenterHostState,
} from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import {
  chordMatchesEvent,
  formatChordForDisplay,
} from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { cn } from "@/lib/utils";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
  type AnalyticsNotificationEntryPoint,
} from "@/lib/analytics";

const NOTIFICATION_CENTER_SELECTOR = "[data-notification-center]";

/** Native toast/chime emission is owned by `NotificationEmissionController` so all sources share the same
 * hold/coalescing/focus policy. */
export function NotificationsBell() {
  const open = useNotificationsPopoverStore((state) => state.open);
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  const bellState = useNotificationBellState();
  const hostState = useNotificationCenterHostState();
  const unreadCount = useMergedNotificationUnreadCount();
  useTitleBarDragSuppression("notifications", open);

  const geometry = useNotificationCenterGeometry({
    open,
    isColdOpen: hostState.isPartial,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lifecycle = useNotificationCenterOpenLifecycle({
    triggerRef,
    headingRef,
  });

  const handleNavigate = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  // The outside-pointerdown guard below reads this ref at dispatch time to decide whether the menu still needs a
  // synthetic Escape or has already dismissed itself first.
  const nestedMenuOpenRef = useRef(false);
  const handleFilterMenuOpenChange = useCallback((menuOpen: boolean) => {
    nestedMenuOpenRef.current = menuOpen;
  }, []);

  // Reset after every consumed open cycle so a later bell-less open never inherits a stale "direct_ui" value.
  const openEntryPointRef =
    useRef<AnalyticsNotificationEntryPoint>("notification");
  const onTriggerPointerDown = useCallback(() => {
    openEntryPointRef.current = "direct_ui";
    lifecycle.onTriggerPointerDown();
  }, [lifecycle]);
  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        openEntryPointRef.current = "direct_ui";
      }
      lifecycle.onTriggerKeyDown(event);
    },
    [lifecycle],
  );

  const chord = useBindingForAction("app.notifications.open");
  const markKeyboardDismiss = lifecycle.markKeyboardDismiss;
  // A chord open is a deliberate interaction with the app, so it is attributed to `direct_ui` like a bell click
  // - `notification` means "arrived from a native notification", which would be a false claim here.
  useEffect(
    () =>
      registerDynamicActionHandler("app.notifications.open", () => {
        openEntryPointRef.current = "direct_ui";
        useNotificationsPopoverStore.getState().setOpen(true);
      }),
    [],
  );

  // That question is asked of the focused element itself (`data-notification-center`, set by the popover) rather
  // than of the shell ref, which belongs to the geometry lock and must not be read from render.
  useEffect(() => {
    if (!open || chord === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!chordMatchesEvent(chord, event)) return;
      event.preventDefault();
      event.stopPropagation();
      const active = document.activeElement;
      if (active !== null && active.closest(NOTIFICATION_CENTER_SELECTOR)) {
        markKeyboardDismiss();
      }
      useNotificationsPopoverStore.getState().setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [chord, markKeyboardDismiss, open]);

  // Fires exactly once per open cycle - edge-triggered on the `open` boolean's false -> true transition.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const attentionCount =
        bellState.kind === "attention" ? bellState.count : 0;
      Analytics.getInstance().track(AnalyticsEvent.NotificationCenterOpened, {
        entry_point: openEntryPointRef.current,
        host_state: hostState.isPartial ? "unknown" : "exact",
        attention_bucket:
          bellState.kind === "unknown"
            ? "unknown"
            : analyticsCountBucket(attentionCount),
        unread_bucket:
          bellState.kind === "unknown"
            ? "unknown"
            : analyticsCountBucket(unreadCount),
      });
      openEntryPointRef.current = "notification";
    }
    wasOpenRef.current = open;
  }, [open, bellState, hostState.isPartial, unreadCount]);

  const ariaLabel = notificationBellAccessibleLabel(bellState);
  const tooltip =
    chord === null
      ? "Notifications"
      : `Notifications (${formatChordForDisplay(chord)})`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={open ? null : tooltip}
        side="top"
        sideOffset={6}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="notifications-bell"
            aria-label={ariaLabel}
            onPointerDown={onTriggerPointerDown}
            onKeyDown={onTriggerKeyDown}
            className={cn("relative", open && "bg-accent")}
          >
            <Bell
              className="size-4 text-muted-foreground group-hover/button:text-foreground"
              aria-hidden
            />
            {bellState.kind === "attention" && (
              <span
                data-testid="notifications-attention-badge"
                aria-hidden
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-md bg-destructive px-1 text-overline font-semibold leading-none text-destructive-foreground tabular-nums shadow-sm ring-2 ring-background"
              >
                {bellState.count}
              </span>
            )}
            {bellState.kind === "quietDot" && (
              <span
                data-testid="notifications-quiet-dot"
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
              />
            )}
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="end"
        className="w-auto overflow-hidden p-0"
        onOpenAutoFocus={lifecycle.onContentOpenAutoFocus}
        onEscapeKeyDown={lifecycle.onContentEscapeKeyDown}
        onCloseAutoFocus={lifecycle.onContentCloseAutoFocus}
        // A nested modal menu (the filter menu) traps focus into its own portal, outside this Content's DOM subtree -
        // without this guard, Radix's DismissableLayer reads that as focus leaving the popover and dismisses it.
        onFocusOutside={(event) => event.preventDefault()}
        // Real-browser-only bug (jsdom's fireEvent bypasses hit-testing and never reproduced it): while the modal
        // filter menu is open, its pointer/scroll barrier sets `body.style.pointerEvents = "none"`.
        onPointerDownOutside={(event) => {
          const shell = geometry.shellRef.current;
          if (shell === null) return;
          const { clientX, clientY } = event.detail.originalEvent;
          const rect = shell.getBoundingClientRect();
          const isInsideShell =
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom;
          if (isInsideShell) {
            event.preventDefault();
            if (nestedMenuOpenRef.current) {
              document.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "Escape",
                  bubbles: true,
                  cancelable: true,
                }),
              );
            }
          }
        }}
      >
        <NotificationsPopover
          onNavigate={handleNavigate}
          headingRef={headingRef}
          shellRef={geometry.shellRef}
          shellStyle={geometry.style}
          onFilterMenuOpenChange={handleFilterMenuOpenChange}
        />
      </PopoverContent>
    </Popover>
  );
}
