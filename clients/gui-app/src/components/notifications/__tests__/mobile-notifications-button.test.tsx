import "../../../../__tests__/test-browser-apis";

import type { NotificationBellState } from "@/stores/notifications/merged-notifications";

const testState: { bellState: NotificationBellState; unread: number } = {
  bellState: { kind: "clear" },
  unread: 0,
};

vi.mock("@/stores/notifications/merged-notifications", async () => {
  // `notificationBellAccessibleLabel` is a pure helper on the real module -
  // keep it, so the label assertions exercise the shipped copy.
  const actual = await vi.importActual<
    typeof import("@/stores/notifications/merged-notifications")
  >("@/stores/notifications/merged-notifications");
  return {
    notificationBellAccessibleLabel: actual.notificationBellAccessibleLabel,
    useMergedNotificationUnreadCount: () => testState.unread,
    useNotificationBellState: () => testState.bellState,
    useNotificationCenterHostState: () => ({ isPartial: false }),
  };
});

vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: { NotificationCenterOpened: "NotificationCenterOpened" },
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  analyticsCountBucket: () => "none",
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNotificationsButton } from "@/components/notifications/mobile-notifications-button";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

describe("MobileNotificationsButton", () => {
  beforeEach(() => {
    testState.bellState = { kind: "clear" };
    testState.unread = 0;
    useNotificationsPopoverStore.setState({ open: false });
  });
  afterEach(() => {
    cleanup();
    useNotificationsPopoverStore.setState({ open: false });
  });

  it("opens the shared notifications surface", async () => {
    render(<MobileNotificationsButton />);
    fireEvent.click(await screen.findByTestId("mobile-notifications-button"));

    expect(useNotificationsPopoverStore.getState().open).toBe(true);
  });

  it("badges the attention count", async () => {
    testState.bellState = { kind: "attention", count: 3 };
    testState.unread = 3;
    render(<MobileNotificationsButton />);

    expect(
      (await screen.findByTestId("mobile-notifications-attention-badge"))
        .textContent,
    ).toBe("3");
  });

  // The desktop bell shows a bare dot here; on phones this is the only
  // notifications surface, so the count is worth the pixels.
  it("shows the unread count where the desktop bell shows a quiet dot", async () => {
    testState.bellState = { kind: "quietDot" };
    testState.unread = 2;
    render(<MobileNotificationsButton />);

    expect(
      (await screen.findByTestId("mobile-notifications-unread-badge"))
        .textContent,
    ).toBe("2");
    expect(screen.queryByTestId("mobile-notifications-quiet-dot")).toBeNull();
  });

  it("falls back to the dot when no count has resolved", async () => {
    testState.bellState = { kind: "quietDot" };
    render(<MobileNotificationsButton />);

    expect(
      await screen.findByTestId("mobile-notifications-quiet-dot"),
    ).not.toBeNull();
  });

  it("carries the shared accessible label", async () => {
    testState.bellState = { kind: "attention", count: 1 };
    render(<MobileNotificationsButton />);

    expect(
      (await screen.findByTestId("mobile-notifications-button")).getAttribute(
        "aria-label",
      ),
    ).toBe("Notifications, 1 notification needs attention");
  });
});
