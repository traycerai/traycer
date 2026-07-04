import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth/auth-store";

const windowHost = window as { runnerHost?: unknown };

vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div data-testid="tab-strip" />,
}));

// Router-dependent like TabStrip: the app-variant header mounts these arrows
// inside the router tree, but this AppShell unit test renders without a
// RouterProvider, so stub them out the same way.
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => <div data-testid="history-nav-buttons" />,
}));

vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => <button type="button">History</button>,
}));

vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));

vi.mock("@/components/open-folder-dialog", () => ({
  OpenFolderDialog: () => <div data-testid="open-folder-dialog" />,
}));

vi.mock("@/components/layout/bridges/quit-intercept-bridge", () => ({
  QuitInterceptBridge: () => <div data-testid="quit-intercept-bridge" />,
}));

vi.mock("@/components/layout/find-in-page-bar", () => ({
  FindInPageBar: () => <div data-testid="legacy-find-in-page-bar" />,
}));

vi.mock("@/components/epic-canvas/tile-find/tile-find-owner-bridge", () => ({
  TileFindOwnerBridge: () => <div data-testid="tile-find-owner-bridge" />,
}));

vi.mock("@/components/migration/migration-run-controller", () => ({
  MigrationRunController: () => null,
}));

vi.mock("@/components/layout/dialogs/migration-blocking-modal-host", () => ({
  MigrationBlockingModalHost: () => null,
}));

vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => <div data-testid="notifications-bell" />,
}));

vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => <div data-testid="rate-limit-header-button" />,
}));

vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

import { AppShell } from "@/components/layout/app-shell";

describe("<AppShell />", () => {
  beforeEach(() => {
    windowHost.runnerHost = {};
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "Test User", email: "test@example.com" },
        { userId: "user-1", username: "test-user" },
        [],
      );
  });

  afterEach(() => {
    cleanup();
    delete windowHost.runnerHost;
    useAuthStore.getState().setSignedOut();
  });

  it("renders the signed-in app shell around routed children", () => {
    render(
      <AppShell>
        <div data-testid="app-shell-child" />
      </AppShell>,
    );

    expect(screen.getByTestId("user-menu")).not.toBeNull();
    expect(screen.getByTestId("app-shell-child")).not.toBeNull();
    expect(screen.getByTestId("tile-find-owner-bridge")).not.toBeNull();
    expect(screen.queryByTestId("legacy-find-in-page-bar")).toBeNull();
    // Host status footer was removed; the combined chip on the
    // composer is now the host-state surface.
    expect(screen.queryByTestId("host-status-footer")).toBeNull();
  });

  it("makes the capped tab strip leftover a desktop drag region", () => {
    render(
      <AppShell>
        <div data-testid="app-shell-child" />
      </AppShell>,
    );

    const tabRegion = screen.getByTestId("tab-strip").parentElement;
    expect(tabRegion).not.toBeNull();
    expect(tabRegion?.className).toContain("[-webkit-app-region:drag]");
  });
});
