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
import { cn } from "@/lib/utils";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
  type AnalyticsNotificationEntryPoint,
} from "@/lib/analytics";

/**
 * Top-level notifications trigger in the app header. Shows an unread-count
 * badge and opens the `NotificationsPopover` on click. Native toast/chime
 * emission is owned by `NotificationEmissionController` so all sources share
 * the same hold/coalescing/focus policy.
 *
 * Owns every Radix-Popover-specific concern for the center - anchoring,
 * the one-time geometry lock, and open/close focus lifecycle - so
 * `NotificationsPopover` stays purely presentational.
 */
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

  // Whether the nested filter menu is logically open right now, per Radix's
  // own onOpenChange notification - not derived from the DOM, since the menu
  // portals to document.body (so it isn't a shell descendant to query) and
  // its data-state can briefly read "closed" while still mounted mid-exit-
  // animation. The outside-pointerdown guard below reads this ref at
  // dispatch time to decide whether the menu still needs a synthetic Escape
  // or has already dismissed itself first - see the guard's own comment for
  // why that ordering isn't guaranteed.
  const nestedMenuOpenRef = useRef(false);
  const handleFilterMenuOpenChange = useCallback((menuOpen: boolean) => {
    nestedMenuOpenRef.current = menuOpen;
  }, []);

  // Analytics-only entry-point tracking, independent of the T04 focus-
  // modality ref above: a direct bell interaction sets this just before the
  // open transition; anything that flips `open` without going through the
  // trigger (native-notification bridge opens, including the
  // origin-unavailable state) keeps the "notification" default. Reset after
  // every consumed open cycle so a later bell-less open never inherits a
  // stale "direct_ui" value.
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

  // Fires exactly once per open cycle - edge-triggered on the `open`
  // boolean's false -> true transition, so it covers every way the center
  // can open (bell click/keyboard AND a native-notification-driven
  // programmatic open) rather than only the ones that go through Radix's own
  // onOpenChange handler.
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
            {bellState.kind === "unknown" && (
              <span
                data-testid="notifications-unknown-indicator"
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-muted-foreground/50 ring-2 ring-background"
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
        // A nested modal menu (the filter menu) traps focus into its own
        // portal, outside this Content's DOM subtree - without this guard,
        // Radix's DismissableLayer reads that as focus leaving the popover
        // and dismisses it. Escape still closes the popover normally; this
        // only turns off the focus-outside path, which nothing else in the
        // T04 focus contract depends on.
        onFocusOutside={(event) => event.preventDefault()}
        // Real-browser-only bug (jsdom's fireEvent bypasses hit-testing and
        // never reproduced it): while the modal filter menu is open, its
        // pointer/scroll barrier sets `body.style.pointerEvents = "none"`.
        // A click landing inside the popover but outside the menu is then
        // NOT hit-tested onto the clicked element at all - the browser skips
        // every inert (pointer-events:none) node under it and resolves
        // `event.target` to <html>. `event.target` can't be trusted to tell
        // "inside the popover" from "truly outside" while that lock is
        // active, so this checks the click's real screen position against
        // the shell's own rect instead. Genuinely outside still closes
        // everything normally.
        //
        // Inside the shell, this must decide whether the filter menu still
        // needs a synthetic Escape to close it, or already closed itself -
        // Radix's own DismissableLayer defers cross-layer
        // onPointerDownOutside delivery (`deferPointerDownOutside`), so the
        // menu's own outside-pointerdown handling and this popover-level
        // handler are NOT guaranteed to run in a fixed order relative to
        // each other. When the menu's handler runs first, it has already
        // closed the menu by the time this fires; dispatching Escape then
        // would hit the popover itself as the new topmost layer and close
        // it too - reproduced live in headless Chrome. Reading
        // `nestedMenuOpenRef` (updated synchronously by the menu's own
        // onOpenChange, which always completes before this deferred handler
        // runs, since it fires on an earlier event in the same gesture)
        // makes the decision correct in both orderings: dispatch Escape only
        // if the menu is still open; otherwise it already closed itself, so
        // do nothing and leave the popover open.
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
