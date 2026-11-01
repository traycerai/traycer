import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileStripFormContext } from "@/components/layout/tabs/mobile-strip-form-context";
import { NotificationsMobileSheet } from "@/components/notifications/notifications-mobile-sheet";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

const shell = vi.hoisted((): { mobile: boolean } => ({ mobile: true }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => shell.mobile,
}));
// The center's own content needs a host runtime; the sheet around it is what
// these cases read.
vi.mock("@/components/notifications/notifications-popover", () => ({
  NotificationsPopover: () => <div data-testid="notifications-center" />,
}));

describe("NotificationsMobileSheet", () => {
  beforeEach(() => {
    shell.mobile = true;
    useNotificationsPopoverStore.getState().setOpen(true);
  });
  afterEach(() => {
    cleanup();
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

  it("draws nothing on desktop", () => {
    shell.mobile = false;
    render(<NotificationsMobileSheet />);

    expect(screen.queryByTestId("notifications-center")).toBeNull();
  });
});
