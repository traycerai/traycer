import { type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useIsMobile } from "@/hooks/ui/use-mobile";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

/**
 * Full-screen notifications surface for phones. Reuses the exact
 * `NotificationsPopover` list + actions, presented full-bleed (mirroring how
 * History/Settings present full-screen below md) instead of the desktop bell
 * popover. Opened from the mobile hamburger drawer's Notifications row and
 * shares the popover's open state, so there is a single source of truth.
 *
 * Renders nothing on desktop, where the header bell + anchored popover stay
 * exactly as before - the mobile shell simply drops the bell and reaches this
 * surface through the drawer instead.
 */
export function NotificationsMobileSheet(): ReactNode {
  const isMobile = useIsMobile();
  const open = useNotificationsPopoverStore((state) => state.open);
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  if (!isMobile) return null;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-black/30 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          data-testid="notifications-mobile-sheet"
          data-mobile-shell-touch-scope=""
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          {/* Close lives on the left so it never collides with the popover
              header's own top-right actions (mark all / clear / settings). The
              visible "Notifications" heading comes from the reused popover, so
              the dialog title here is screen-reader only to avoid duplication. */}
          <header className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-secondary px-2 py-2">
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close notifications"
                data-testid="notifications-mobile-close"
              >
                <X />
              </Button>
            </DialogPrimitive.Close>
            <DialogPrimitive.Title className="sr-only">
              Notifications
            </DialogPrimitive.Title>
          </header>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <NotificationsPopover
              onNavigate={() => setOpen(false)}
              frameClassName="h-full w-full"
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
