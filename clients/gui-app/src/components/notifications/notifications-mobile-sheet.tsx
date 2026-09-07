import { useCallback, useRef, type ReactNode } from "react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

/** A sheet rather than a full-bleed surface because notifications is a peek, not a destination: History and
 * Settings are places you navigate to and stay in, while this one you scan and leave. */
export function NotificationsMobileSheet(): ReactNode {
  const isMobile = useIsMobileViewport();
  const open = useNotificationsPopoverStore((state) => state.open);
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  // main's popover is purely presentational: the caller owns outer sizing via `shellRef`/`shellStyle` and
  // supplies `headingRef`.
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
        // The primitive imposes no height (see drawer.tsx), so the composing surface caps it.
        className="h-[85dvh] pb-safe-bottom"
      >
        {/* The visible "Notifications" heading comes from the reused popover, so the dialog title here is screen-reader
           only to avoid duplication - Radix still requires one. */}
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
