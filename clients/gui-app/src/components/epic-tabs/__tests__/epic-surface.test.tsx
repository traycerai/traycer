import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TabSurfaceActivityProvider } from "@/components/layout/tab-surface-activity";

vi.mock("@tanstack/react-router", () => ({
  useMatch: () => undefined,
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
});
