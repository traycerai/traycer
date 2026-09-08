/**
 * `HeaderTabDragOverlay` mounts outside the strip's own
 * `NotificationIndicatorsProvider`, so it wraps `TabLeadingIcon` in its own
 * scoped provider fed by `useNotificationIndicators`. Fakes the appearance,
 * activity, and notification-feed hooks (each already covered elsewhere);
 * proves the tint threads through and the wrapping plumbs the right args so
 * server attention still reaches the icon outside strip context.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HeaderTabDragOverlay } from "../tab-strip-drag-overlay";
import type { HeaderTab } from "@/stores/tabs/types";

const mocks = vi.hoisted(() => ({
  useHeaderTabAppearance: vi.fn(),
  useEpicActivityStatus: vi.fn(),
  useRegisteredEpicTitleGenerating: vi.fn(),
  useNotificationIndicators: vi.fn(),
}));

vi.mock("@/hooks/appearance/use-header-tab-appearance", () => ({
  useHeaderTabAppearance: mocks.useHeaderTabAppearance,
}));
vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: mocks.useEpicActivityStatus,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitleGenerating: mocks.useRegisteredEpicTitleGenerating,
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: mocks.useNotificationIndicators,
}));

function epicTab(color: string): Extract<HeaderTab, { kind: "epic" }> {
  return {
    kind: "epic",
    id: "tab-1",
    epicId: "epic-1",
    hostId: "host-a",
    route: "/x",
    name: "Task",
    icon: null,
    canClose: true,
    canDuplicate: true,
    canOpenInNewWindow: true,
    repositoryIdentity: {
      color,
      icon: { kind: "emoji", value: "\u{1f680}" },
      scope: null,
      assetRefreshKey: 1,
      iconRejected: false,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HeaderTabDragOverlay: identity tint + status outside strip context", () => {
  it("threads the identity color into the chip fill and scopes its own notification feed to this epic", () => {
    const tab = epicTab("#654321");
    mocks.useHeaderTabAppearance.mockReturnValue(tab);
    mocks.useEpicActivityStatus.mockReturnValue("turn");
    mocks.useRegisteredEpicTitleGenerating.mockReturnValue(false);
    mocks.useNotificationIndicators.mockReturnValue({ epics: {}, chats: {} });

    render(<HeaderTabDragOverlay tab={tab} width={200} />);

    expect(mocks.useNotificationIndicators).toHaveBeenCalledWith({
      hostId: null,
      epicIds: ["epic-1"],
      chatIds: [],
      enabled: true,
    });
    const chip = screen.getByTestId("header-tab-drag-overlay");
    expect(chip.style.backgroundColor).toContain("654321");
    // Identity icon (emoji) and the running-activity status render together.
    expect(screen.getByText("\u{1f680}")).toBeTruthy();
    expect(screen.getByTestId("header-tab-activity-tab-1")).toBeTruthy();
  });

  it("still renders the identity icon when the epic has no live activity", () => {
    const tab = epicTab("#0a0a0a");
    mocks.useHeaderTabAppearance.mockReturnValue(tab);
    mocks.useEpicActivityStatus.mockReturnValue("idle");
    mocks.useRegisteredEpicTitleGenerating.mockReturnValue(false);
    mocks.useNotificationIndicators.mockReturnValue({ epics: {}, chats: {} });

    render(<HeaderTabDragOverlay tab={tab} width={200} />);

    expect(screen.queryByTestId("header-tab-activity-tab-1")).toBeNull();
    expect(screen.getByText("\u{1f680}")).toBeTruthy();
  });

  it("surfaces real server attention through the scoped provider, then clears it while identity stays put", () => {
    const tab = epicTab("#334455");
    mocks.useHeaderTabAppearance.mockReturnValue(tab);
    mocks.useEpicActivityStatus.mockReturnValue("idle");
    mocks.useRegisteredEpicTitleGenerating.mockReturnValue(false);
    mocks.useNotificationIndicators.mockReturnValue({
      epics: {
        "epic-1": {
          pendingApproval: true,
          pendingInterview: false,
          pendingFork: false,
          unreadFailure: false,
          unreadDone: false,
        },
      },
      chats: {},
    });

    // Real NotificationIndicatorsProvider + useSurfaceNotificationIndicatorState
    // (neither is mocked here) must actually thread this feed result down to
    // the glyph - if the provider wrapper were ever dropped, this reads the
    // context's EMPTY_INDICATORS default instead and the assertion below fails.
    const { rerender } = render(<HeaderTabDragOverlay tab={tab} width={200} />);

    expect(screen.getByTestId("header-tab-approval-tab-1")).toBeTruthy();
    expect(
      screen.getByTestId("header-tab-drag-overlay").style.backgroundColor,
    ).toContain("334455");

    mocks.useNotificationIndicators.mockReturnValue({ epics: {}, chats: {} });
    rerender(<HeaderTabDragOverlay tab={tab} width={200} />);

    expect(screen.queryByTestId("header-tab-approval-tab-1")).toBeNull();
    expect(
      screen.getByTestId("header-tab-drag-overlay").style.backgroundColor,
    ).toContain("334455");
  });
});
