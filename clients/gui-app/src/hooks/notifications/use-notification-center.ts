import {
  useCallback,
  useEffect,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Popover } from "@/components/ui/popover";
import { useNotificationCenterGeometry } from "@/hooks/notifications/use-notification-center-geometry";
import { useNotificationCenterOpenLifecycle } from "@/hooks/notifications/use-notification-center-open-lifecycle";
import {
  useMergedNotificationUnreadCount,
  useNotificationBellState,
  useNotificationCenterHostState,
  type NotificationBellState,
} from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { chordMatchesEvent, type ChordString } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
  type AnalyticsNotificationEntryPoint,
} from "@/lib/analytics";

/** The center's own surface, marked by `NotificationsPopover`. */
const NOTIFICATION_CENTER_SELECTOR = "[data-notification-center]";

/** The center's `Popover` open-change callback, reasons and all. */
type PopoverOpenChange = NonNullable<
  ComponentProps<typeof Popover>["onOpenChange"]
>;

export interface NotificationCenter {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly bellState: NotificationBellState;
  readonly chord: ChordString | null;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onTriggerPointerDown: () => void;
  readonly onTriggerKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** The center's `Popover` `onOpenChange`: the dismissal guards, then the store. */
  readonly onOpenChange: PopoverOpenChange;
  /** Spread onto the center's `PopoverContent`. */
  readonly contentHandlers: {
    readonly initialFocus: () => HTMLElement | false;
    readonly finalFocus: () => HTMLElement | false;
  };
  /** Spread onto `NotificationsPopover`. */
  readonly popoverProps: {
    readonly onNavigate: () => void;
    readonly headingRef: RefObject<HTMLHeadingElement | null>;
    readonly shellRef: RefObject<HTMLDivElement | null>;
    readonly shellStyle: CSSProperties;
    readonly onFilterMenuOpenChange: (open: boolean) => void;
  };
}

/**
 * Everything the notification center's Popover needs apart from its
 * trigger: the shared open state, the `app.notifications.open` binding, the
 * one-time geometry lock, the open/close focus lifecycle and the open
 * analytics. The header's bell and the strip's Notifications drawer each own one
 * trigger around it; only one of the two is ever mounted.
 */
export function useNotificationCenter(): NotificationCenter {
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

  // Whether the nested filter menu is logically open right now, per the menu's
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
  // modality ref above: a direct trigger interaction sets this just before
  // the open transition; anything that flips `open` without going through the
  // trigger (native-notification bridge opens, including the
  // origin-unavailable state) keeps the "notification" default. Reset after
  // every consumed open cycle so a later trigger-less open never inherits a
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

  const chord = useBindingForAction("app.notifications.open");
  const markKeyboardDismiss = lifecycle.markKeyboardDismiss;
  // Opening goes through the normal dispatch path. A chord open is a
  // deliberate interaction with the app, so it is attributed to `direct_ui`
  // like a trigger click - `notification` means "arrived from a native
  // notification", which would be a false claim here.
  useEffect(
    () =>
      registerDynamicActionHandler("app.notifications.open", () => {
        openEntryPointRef.current = "direct_ui";
        useNotificationsPopoverStore.getState().setOpen(true);
      }),
    [],
  );

  // Closing does NOT: an open popover is a `role="dialog"`, and the
  // keybinding provider deliberately stops dispatching chords behind one
  // (`isAnyDialogOpen`), so the dynamic handler above can never see the
  // second press. This window listener is mounted only while the center is
  // open and matches the live binding itself, which also keeps the toggle
  // working when the center was opened by pointer or by a native-notification
  // click (focus outside the surface, so no in-surface handler would fire).
  //
  // Focus returns to the trigger only when the center's own surface still
  // holds it: a pointer-opened center leaves focus wherever the user was
  // typing, and yanking that into the chrome would be the worse bug. That
  // question is asked of the focused element itself
  // (`data-notification-center`, set by the popover) rather than of the shell
  // ref, which belongs to the geometry lock and must not be read from render.
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

  // Fires exactly once per open cycle - edge-triggered on the `open`
  // boolean's false -> true transition, so it covers every way the center
  // can open (trigger click/keyboard AND a native-notification-driven
  // programmatic open) rather than only the ones that go through the
  // popover's own onOpenChange handler.
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

  return {
    open,
    setOpen,
    bellState,
    chord,
    triggerRef,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange: (next, details) => {
      // A nested modal menu (the filter menu) owns focus in its own portal,
      // outside this popover's subtree, without dismissing it. Escape still
      // closes the popover normally.
      if (!next && details.reason === "focus-out") details.cancel();
      if (!next && details.reason === "escape-key") markKeyboardDismiss();
      if (!next && details.reason === "outside-press") {
        // While the nested filter menu is open its barrier can retarget a
        // press inside the popover to <html>, so `event.target` cannot tell
        // "inside" from "truly outside": the press's position against the
        // shell's own rect can. Inside the shell, the menu may or may not
        // have closed itself first, so Escape is sent only while it is
        // still open - never to the popover itself as the new top layer.
        const shell = geometry.shellRef.current;
        const event = details.event;
        if (shell !== null && "clientX" in event && "clientY" in event) {
          const rect = shell.getBoundingClientRect();
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            details.cancel();
            if (nestedMenuOpenRef.current)
              document.dispatchEvent(
                new globalThis.KeyboardEvent("keydown", {
                  key: "Escape",
                  bubbles: true,
                  cancelable: true,
                }),
              );
          }
        }
      }
      if (details.isCanceled) return;
      setOpen(next);
    },
    contentHandlers: {
      initialFocus: lifecycle.initialFocus,
      finalFocus: lifecycle.finalFocus,
    },
    popoverProps: {
      onNavigate: handleNavigate,
      headingRef,
      shellRef: geometry.shellRef,
      shellStyle: geometry.style,
      onFilterMenuOpenChange: handleFilterMenuOpenChange,
    },
  };
}
