import { useCallback, useRef, type ReactNode } from "react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

/**
 * Notifications surface for phones. Reuses the exact `NotificationsPopover`
 * list + actions (heading, filter, mark-all, settings, feed, load-older),
 * presented as a drag-dismissable bottom sheet - the same `vaul` drawer the
 * epic tile switcher and composer options use.
 *
 * A sheet rather than a full-bleed surface because notifications is a peek,
 * not a destination: History and Settings are places you navigate to and stay
 * in, while this one you scan and leave. Stopping short of the top leaves the
 * page you came from visible, which is the return affordance - so the sheet
 * needs no close button of its own, and the popover's own header is the only
 * header.
 *
 * Opened from the header's `MobileNotificationsButton` and shares the popover's
 * open state, so there is a single source of truth.
 *
 * Renders nothing on desktop, where the header bell + anchored popover stay
 * exactly as before.
 */
export function NotificationsMobileSheet(): ReactNode {
  const isMobile = useIsMobileViewport();
  const open = useNotificationsPopoverStore((state) => state.open);
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  // main's popover is purely presentational: the caller owns outer sizing via
  // `shellRef`/`shellStyle` and supplies `headingRef`. On mobile there is no
  // anchored Radix popover, so we hand it plain refs and an inline style that
  // overrides the popover's fixed desktop width to fill the sheet.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  // No ancestor popover to keep open here, so the filter menu's open state is
  // irrelevant - the sheet owns its own dismissal.
  const handleFilterMenuOpenChange = useCallback(() => undefined, []);
  if (!isMobile) return null;
  return (
    <Drawer direction="bottom" open={open} onOpenChange={setOpen}>
      <DrawerContent
        data-testid="notifications-mobile-sheet"
        data-mobile-shell-touch-scope=""
        aria-describedby={undefined}
        // The primitive imposes no height (see drawer.tsx), so the composing
        // surface caps it. 85dvh leaves the strip of the underlying page that
        // makes this read as dismissable; the bottom inset keeps the popover's
        // "Load older activity" footer clear of the home indicator.
        className="h-[85dvh] pb-safe-bottom"
      >
        {/* The visible "Notifications" heading comes from the reused popover,
            so the dialog title here is screen-reader only to avoid duplication
            - Radix still requires one. */}
        <DrawerTitle className="sr-only">Notifications</DrawerTitle>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <NotificationsPopover
            onNavigate={() => setOpen(false)}
            headingRef={headingRef}
            shellRef={shellRef}
            shellStyle={{ width: "100%", height: "100%" }}
            onFilterMenuOpenChange={handleFilterMenuOpenChange}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
