import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsMobileSheet } from "@/components/notifications/notifications-mobile-sheet";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

const shell = vi.hoisted(
  (): { mobile: boolean; level1: "drawer" | "rail" | "expanded" } => ({
    mobile: true,
    level1: "drawer",
  }),
);
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => shell.mobile,
}));
vi.mock("@/hooks/ui/use-mobile-layout-form", () => ({
  useMobileLayoutForm: () => ({
    level1: shell.level1,
    level2: "bar",
    tiles: 1,
  }),
}));
// The center's own content needs a host runtime; the sheet around it is what
// these cases read.
vi.mock("@/components/notifications/notifications-popover", () => ({
  NotificationsPopover: () => <div data-testid="notifications-center" />,
}));

describe("NotificationsMobileSheet", () => {
  beforeEach(() => {
    shell.mobile = true;
    shell.level1 = "drawer";
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
    (level1) => {
      shell.level1 = level1;
      render(<NotificationsMobileSheet />);

      expect(screen.queryByTestId("notifications-center")).toBeNull();
    },
  );

  it("draws nothing on desktop", () => {
    shell.mobile = false;
    render(<NotificationsMobileSheet />);

    expect(screen.queryByTestId("notifications-center")).toBeNull();
  });
});
