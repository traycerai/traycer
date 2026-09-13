import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TabLeadingIcon } from "../tab-leading-icon";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { HeaderTabAppearance, TabIcon } from "@/stores/tabs/types";

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

const appearance: HeaderTabAppearance = { color: "#112233", icon: "🚀" };
const DefaultTabIcon: TabIcon = (props) => (
  <svg className={props.className} data-testid="default-tab-icon" />
);

afterEach(() => cleanup());

describe("TabLeadingIcon status and manual icon", () => {
  it("shows the first two graphemes of a long manual icon", () => {
    const identity: HeaderTabAppearance = {
      color: "#112233",
      icon: "TRAYCER",
    };
    render(
      <TabLeadingIcon
        icon={null}
        identity={identity}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-long-icon"
      />,
    );
    const manual = document.querySelector('[data-slot="tab-custom-icon"]');
    if (manual === null) throw new Error("expected manual icon slot");
    expect(manual.textContent).toBe("TR");
    expect(identity.icon).toBe("TRAYCER");
  });

  it.each([
    ["a family ZWJ emoji", "👨‍👩‍👧‍👦"],
    ["a flag emoji", "🇺🇸"],
  ])("keeps %s together as one manual icon", (_name, icon) => {
    render(
      <TabLeadingIcon
        icon={null}
        identity={{ color: "#112233", icon }}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-grapheme-icon"
      />,
    );
    const manual = document.querySelector('[data-slot="tab-custom-icon"]');
    if (manual === null) throw new Error("expected manual icon slot");
    expect(manual.textContent).toBe(icon);
  });

  it("keeps the status slot first and the readable manual icon second", () => {
    render(
      <TabLeadingIcon
        icon={null}
        identity={appearance}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-order"
      />,
    );
    const status = document.querySelector('[data-slot="tab-status-icon"]');
    const manual = document.querySelector('[data-slot="tab-custom-icon"]');
    expect(status).not.toBeNull();
    expect(manual).not.toBeNull();
    if (status === null || manual === null)
      throw new Error("expected leading icon slots");
    expect(
      Boolean(
        status.compareDocumentPosition(manual) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(screen.getByText("🚀")).toBeTruthy();
  });

  it("keeps the status slot mounted while idle content changes from loading to the default icon", () => {
    const { rerender } = render(
      <TabLeadingIcon
        icon={DefaultTabIcon}
        identity={null}
        titleGenerationPending
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-status"
      />,
    );
    const status = document.querySelector('[data-slot="tab-status-icon"]');
    expect(
      screen.getByTestId("header-tab-title-generating-tab-status"),
    ).toBeTruthy();
    rerender(
      <TabLeadingIcon
        icon={DefaultTabIcon}
        identity={null}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={idleState()}
        tabId="tab-status"
      />,
    );
    expect(document.querySelector('[data-slot="tab-status-icon"]')).toBe(
      status,
    );
    expect(screen.getByTestId("default-tab-icon")).toBeTruthy();
  });

  it("keeps the manual icon alongside running activity and attention status", () => {
    const { rerender } = render(
      <TabLeadingIcon
        icon={null}
        identity={appearance}
        titleGenerationPending={false}
        activityStatus="turn"
        indicatorState={idleState()}
        tabId="tab-3"
      />,
    );
    expect(screen.getByText("🚀")).toBeTruthy();
    expect(screen.getByTestId("header-tab-activity-tab-3")).toBeTruthy();
    rerender(
      <TabLeadingIcon
        icon={null}
        identity={appearance}
        titleGenerationPending={false}
        activityStatus="idle"
        indicatorState={{
          ...idleState(),
          unreadFailure: true,
          unreadNonTerminalFailure: true,
        }}
        tabId="tab-3"
      />,
    );
    expect(screen.queryByTestId("header-tab-activity-tab-3")).toBeNull();
    expect(screen.getByTestId("header-tab-failure-tab-3")).toBeTruthy();
    expect(screen.getByText("🚀")).toBeTruthy();
  });

  it("renders running status with no manual icon", () => {
    render(
      <TabLeadingIcon
        icon={null}
        identity={null}
        titleGenerationPending={false}
        activityStatus="turn"
        indicatorState={idleState()}
        tabId="tab-4"
      />,
    );
    expect(screen.getByTestId("header-tab-activity-tab-4")).toBeTruthy();
    expect(document.querySelector('[data-slot="tab-custom-icon"]')).toBeNull();
  });
});
