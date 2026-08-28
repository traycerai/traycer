import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TabSurfaceActivityProvider } from "@/components/layout/tab-surface-activity";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";

// No epic route match anywhere in this suite: that is the phone cold-restore
// state, where the layout has restored the tab but the router is still on the
// landing route it booted at.
vi.mock("@tanstack/react-router", () => ({
  useMatch: () => undefined,
}));

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewport.mobile,
}));

vi.mock("@/providers/epic-session-provider", () => ({
  EpicSessionProvider: (props: {
    readonly children: ReactNode;
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
      data-testid="epic-session-boundary"
    >
      {props.children}
    </div>
  ),
}));

vi.mock("@/components/epic-canvas/epic-route-session-body", () => ({
  EpicRouteSessionBody: (props: { readonly tabId: string }) => (
    <div data-testid={`epic-canvas-body-${props.tabId}`} />
  ),
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-column", () => ({
  EpicSidebarColumn: (props: {
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <aside
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
      data-testid="epic-sidebar-column"
    />
  ),
}));

import { EpicSurface } from "@/components/epic-tabs/epic-surface";

describe("<EpicSurface />", () => {
  afterEach(() => {
    cleanup();
    viewport.mobile = false;
    useMobileHeaderStore.setState({
      rightActions: null,
      rightActionsOwner: null,
    });
  });

  it("keeps two split Epic panes under independent session and sidebar boundaries", () => {
    render(
      <>
        <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
          <EpicSurface epicId="epic-a" tabId="tab-a" />
        </TabSurfaceActivityProvider>
        <TabSurfaceActivityProvider
          activity={{ visible: true, focused: false }}
        >
          <EpicSurface epicId="epic-b" tabId="tab-b" />
        </TabSurfaceActivityProvider>
      </>,
    );

    const sessions = screen.getAllByTestId("epic-session-boundary");
    const sidebars = screen.getAllByTestId("epic-sidebar-column");
    expect(sessions.map((element) => element.dataset.tabId)).toEqual([
      "tab-a",
      "tab-b",
    ]);
    expect(sidebars.map((element) => element.dataset.epicId)).toEqual([
      "epic-a",
      "epic-b",
    ]);
    expect(screen.getByTestId("epic-canvas-body-tab-a")).not.toBeNull();
    expect(screen.getByTestId("epic-canvas-body-tab-b")).not.toBeNull();
  });

  // Tab focus, not the route: the switcher trigger has to reach the header on a
  // cold restore, when no epic route match exists yet.
  it("fills the mobile header slot from the focused pane", () => {
    viewport.mobile = true;
    render(
      <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
        <EpicSurface epicId="epic-a" tabId="tab-a" />
      </TabSurfaceActivityProvider>,
    );

    render(<>{useMobileHeaderStore.getState().rightActions}</>);
    expect(screen.getByTestId("mobile-epic-switcher-trigger")).not.toBeNull();
  });

  // Only the focused pane writes, so the single-cell slot keeps one owner even
  // while a second Epic pane stays mounted beside it.
  it("leaves the mobile header slot alone from an unfocused pane", () => {
    viewport.mobile = true;
    render(
      <TabSurfaceActivityProvider activity={{ visible: true, focused: false }}>
        <EpicSurface epicId="epic-b" tabId="tab-b" />
      </TabSurfaceActivityProvider>,
    );

    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });

  it("leaves the mobile header slot empty on desktop", () => {
    viewport.mobile = false;
    render(
      <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
        <EpicSurface epicId="epic-a" tabId="tab-a" />
      </TabSurfaceActivityProvider>,
    );

    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });
});
