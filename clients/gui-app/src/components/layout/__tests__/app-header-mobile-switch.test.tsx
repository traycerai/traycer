import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/layout/header/app-header";

// Drive the viewport switch directly; the desktop-only header children need
// host/query/auth providers, so stub them (and both branch markers) to keep
// the test to the switch itself.
const mobileState = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => mobileState.value,
  isMobileViewport: () => mobileState.value,
}));
vi.mock("@/components/layout/header/mobile-app-header", () => ({
  MobileAppHeader: () => (
    <button type="button" aria-label="Open menu">
      menu
    </button>
  ),
}));
vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div role="tablist" aria-label="Open tabs" />,
}));
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => null,
}));
vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => null,
}));
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => null,
}));
vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => null,
}));
vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => null,
}));
vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => null,
}));
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => null,
}));

describe("AppHeader mobile/desktop switch", () => {
  beforeEach(() => {
    mobileState.value = false;
  });
  afterEach(() => {
    cleanup();
  });

  it("renders the mobile hamburger header below md", () => {
    mobileState.value = true;
    render(<AppHeader variant="app" />);
    expect(screen.getByRole("button", { name: "Open menu" })).not.toBeNull();
    expect(screen.queryByRole("tablist", { name: "Open tabs" })).toBeNull();
  });

  it("renders the desktop tab-strip header at >=md", () => {
    mobileState.value = false;
    render(<AppHeader variant="app" />);
    expect(screen.getByRole("tablist", { name: "Open tabs" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });

  it("keeps the desktop header for the host-loading variant even below md", () => {
    mobileState.value = true;
    render(<AppHeader variant="host-loading" />);
    // host-loading never shows the tab strip, but it must NOT switch to the
    // mobile hamburger header either.
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });
});
