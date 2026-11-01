import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileStripFormContext } from "@/components/layout/tabs/mobile-strip-form-context";
import { MobileStripFormScope } from "@/components/layout/tabs/mobile-strip-form-scope";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { NotificationsMobileSheet } from "@/components/notifications/notifications-mobile-sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

const shell = vi.hoisted((): { mobile: boolean; desktopMenus: boolean } => ({
  mobile: true,
  desktopMenus: false,
}));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => shell.mobile,
}));
// Windows and Linux with their native menu row, which keeps the desktop header
// at any width.
vi.mock("@/components/layout/header/use-desktop-menu-bar-active", () => ({
  useDesktopMenuBarActive: () => shell.desktopMenus,
}));
// The desktop bell's host readings; its popover is what the narrow case reads.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => null,
  useNotificationResolveHost: () => ({ hostId: null, client: null }),
}));
// The center's own content needs a host runtime; the sheet around it is what
// these cases read.
vi.mock("@/components/notifications/notifications-popover", () => ({
  NotificationsPopover: () => <div data-testid="notifications-center" />,
}));

describe("NotificationsMobileSheet", () => {
  beforeEach(() => {
    shell.mobile = true;
    shell.desktopMenus = false;
    useNotificationsPopoverStore.getState().setOpen(true);
  });
  afterEach(() => {
    cleanup();
    document.getElementById("root")?.remove();
    useNotificationsPopoverStore.getState().setOpen(false);
  });

  it("draws the center in a sheet on a phone whose level 1 is the drawer", async () => {
    render(<NotificationsMobileSheet />);

    expect(await screen.findByTestId("notifications-center")).not.toBeNull();
  });

  it.each(["rail", "expanded"] as const)(
    "draws nothing where the strip stands at level 1 (%s)",
    (form) => {
      render(
        <MobileStripFormContext.Provider value={form}>
          <NotificationsMobileSheet />
        </MobileStripFormContext.Provider>,
      );

      expect(screen.queryByTestId("notifications-center")).toBeNull();
    },
  );

  it("leaves the popover as the only center in a narrow window with desktop chrome", async () => {
    shell.desktopMenus = true;
    const root = document.createElement("div");
    root.id = "root";
    root.getBoundingClientRect = () => new DOMRect(0, 0, 750, 402);
    document.body.append(root);
    render(
      <MobileStripFormScope>
        <TooltipProvider>
          <NotificationsBell />
        </TooltipProvider>
        <NotificationsMobileSheet />
      </MobileStripFormScope>,
    );

    expect(await screen.findAllByTestId("notifications-center")).toHaveLength(
      1,
    );
    expect(screen.queryByTestId("notifications-mobile-sheet")).toBeNull();
  });

  it("draws nothing on desktop", () => {
    shell.mobile = false;
    render(<NotificationsMobileSheet />);

    expect(screen.queryByTestId("notifications-center")).toBeNull();
  });
});
