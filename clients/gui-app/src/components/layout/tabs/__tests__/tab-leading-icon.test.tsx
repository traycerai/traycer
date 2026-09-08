/**
 * `TabLeadingIcon` renders a repository identity icon beside the pre-existing
 * status icon. Fakes `useAppearanceAsset` (covered by
 * `use-appearance-assets.test.tsx`) and the notification-indicator state
 * (covered by its own reducer tests); proves a missing logo falls back to a
 * neutral icon, and identity/status - including a real attention tone, not
 * just the running spinner - render and update independently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TabLeadingIcon } from "../tab-leading-icon";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { HeaderTabRepositoryIdentity } from "@/stores/tabs/types";

const mocks = vi.hoisted(() => ({
  useAppearanceAsset: vi.fn(),
  useSurfaceNotificationIndicatorState: vi.fn(),
}));

vi.mock("@/hooks/appearance/use-appearance-assets", () => ({
  useAppearanceAsset: mocks.useAppearanceAsset,
}));
vi.mock("@/components/notifications/notification-indicator-context", () => ({
  useSurfaceNotificationIndicatorState:
    mocks.useSurfaceNotificationIndicatorState,
}));

function idleState(): NotificationIndicatorState {
  return {
    unreadFailure: false,
    unreadNonTerminalFailure: false,
    unreadTerminalFailure: false,
    pendingFork: false,
    pendingApproval: false,
    pendingInterview: false,
    unreadDone: false,
  };
}

function identityWithImage(): HeaderTabRepositoryIdentity {
  return {
    color: "#112233",
    icon: { kind: "image", path: "appearance/logo.webp" },
    scope: {
      accountId: "acct-1",
      hostId: "host-a",
      canonicalSourceRoot: "/repo",
    },
    assetRefreshKey: 1,
    iconRejected: false,
  };
}

function identityWithRejectedImage(): HeaderTabRepositoryIdentity {
  return {
    color: "#112233",
    icon: { kind: "image", path: "appearance/logo.webp" },
    scope: {
      accountId: "acct-1",
      hostId: "host-a",
      canonicalSourceRoot: "/repo",
    },
    assetRefreshKey: 1,
    iconRejected: true,
  };
}

function identityWithSymbol(): HeaderTabRepositoryIdentity {
  return {
    color: "#112233",
    icon: { kind: "symbol", value: "rocket" },
    scope: null,
    assetRefreshKey: 1,
    iconRejected: false,
  };
}

beforeEach(() => {
  mocks.useSurfaceNotificationIndicatorState.mockReturnValue(idleState());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TabLeadingIcon: missing logo falls back to a neutral icon", () => {
  it("renders no <img> and no crash when the logo asset is unavailable, falling back to the tab's own icon", () => {
    mocks.useAppearanceAsset.mockReturnValue({
      url: null,
      status: "unavailable",
      reason: "not found",
      reportDecodeFailure: vi.fn(),
    });

    render(
      <TabLeadingIcon
        icon={null}
        identity={identityWithImage()}
        titleGenerationPending={false}
        activityStatus="idle"
        tabId="tab-1"
        epicId="epic-1"
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    // Folder is the documented fallback when the configured icon is an image
    // and no asset URL resolved - never a blank slot.
    expect(document.querySelector("svg")).not.toBeNull();
  });

  it("renders the resolved logo image once the asset is ready", () => {
    mocks.useAppearanceAsset.mockReturnValue({
      url: "blob:logo",
      status: "ready",
      reason: null,
      reportDecodeFailure: vi.fn(),
    });

    render(
      <TabLeadingIcon
        icon={null}
        identity={identityWithImage()}
        titleGenerationPending={false}
        activityStatus="idle"
        tabId="tab-2"
        epicId="epic-2"
      />,
    );

    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("blob:logo");
  });

  it("forwards a rejected icon's identity through to the asset layer as rejected:true", () => {
    mocks.useAppearanceAsset.mockReturnValue({
      url: null,
      status: "unavailable",
      reason: "rejected",
      reportDecodeFailure: vi.fn(),
    });

    render(
      <TabLeadingIcon
        icon={null}
        identity={identityWithRejectedImage()}
        titleGenerationPending={false}
        activityStatus="idle"
        tabId="tab-6"
        epicId="epic-6"
      />,
    );

    expect(mocks.useAppearanceAsset).toHaveBeenCalledWith(
      expect.objectContaining({ target: "icon", rejected: true }),
    );
  });
});

describe("TabLeadingIcon: identity and status coexist and update independently", () => {
  it("renders the identity icon alongside a running-activity status, and clearing activity leaves identity untouched", () => {
    const { rerender } = render(
      <TabLeadingIcon
        icon={null}
        identity={identityWithSymbol()}
        titleGenerationPending={false}
        activityStatus="turn"
        tabId="tab-3"
        epicId="epic-3"
      />,
    );

    // Identity: one symbol svg. Status: the running spinner testid.
    expect(document.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(screen.getByTestId("header-tab-activity-tab-3")).toBeTruthy();

    rerender(
      <TabLeadingIcon
        icon={null}
        identity={identityWithSymbol()}
        titleGenerationPending={false}
        activityStatus="idle"
        tabId="tab-3"
        epicId="epic-3"
      />,
    );

    // Activity indicator is gone; the identity icon survives the status change.
    expect(screen.queryByTestId("header-tab-activity-tab-3")).toBeNull();
    expect(document.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("renders the identity icon alongside a real attention tone, which wins over an idle running status", () => {
    mocks.useSurfaceNotificationIndicatorState.mockReturnValue({
      ...idleState(),
      unreadFailure: true,
      unreadNonTerminalFailure: true,
    });

    render(
      <TabLeadingIcon
        icon={null}
        identity={identityWithSymbol()}
        titleGenerationPending={false}
        activityStatus="idle"
        tabId="tab-5"
        epicId="epic-5"
      />,
    );

    expect(screen.getByTestId("header-tab-failure-tab-5")).toBeTruthy();
    // The identity symbol renders alongside the attention glyph - two svgs.
    expect(document.querySelectorAll("svg").length).toBe(2);
  });

  it("still renders a real running status when no repository identity is configured", () => {
    render(
      <TabLeadingIcon
        icon={null}
        identity={undefined}
        titleGenerationPending={false}
        activityStatus="turn"
        tabId="tab-4"
        epicId="epic-4"
      />,
    );

    // The running-activity indicator survives with no identity icon at all.
    expect(screen.getByTestId("header-tab-activity-tab-4")).toBeTruthy();
    // No identity icon requested from the asset layer at all.
    expect(mocks.useAppearanceAsset).not.toHaveBeenCalled();
  });
});
