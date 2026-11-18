import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AppHeader } from "@/components/layout/header/app-header";
import { useTabStripPlacement } from "@/components/layout/tabs/use-tab-strip-placement";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useLayoutStore } from "@/stores/layout/layout-store";

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
vi.mock("@/hooks/appearance/use-header-tab-appearance", () => ({
  useHeaderTabAppearance: () => null,
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

function createDesktopHost(): MockRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  Object.assign(host, {
    menu: {
      platform: "linux",
      onCommand: (_handler: (payload: DesktopMenuCommandPayload) => void) => ({
        dispose: () => undefined,
      }),
      getSnapshot: () =>
        Promise.resolve({
          revision: 1,
          menus: [
            { id: "file", label: "File", items: [] },
            { id: "edit", label: "Edit", items: [] },
            { id: "view", label: "View", items: [] },
            { id: "window", label: "Window", items: [] },
            { id: "help", label: "Help", items: [] },
          ],
        }),
      executeItem: () => Promise.resolve(),
      onChange: (_handler: () => void) => ({ dispose: () => undefined }),
      openTopLevel: () => Promise.resolve(),
    },
  });
  return host;
}

// The effective placement the shell reads, drawn where a query can see it.
function PlacementProbe(): ReactNode {
  return <span data-testid="placement">{useTabStripPlacement()}</span>;
}

describe("AppHeader mobile/desktop switch", () => {
  beforeEach(() => {
    mobileState.value = false;
    useLayoutStore.setState({ arrangement: DEFAULT_ARRANGEMENT });
  });
  afterEach(() => {
    cleanup();
  });

  it("renders the mobile hamburger header below md, forcing the top placement", () => {
    mobileState.value = true;
    useLayoutStore.setState({
      arrangement: { ...DEFAULT_ARRANGEMENT, tabStripPlacement: "left" },
    });
    render(
      <>
        <AppHeader variant="app" />
        <PlacementProbe />
      </>,
    );
    expect(screen.getByRole("button", { name: "Open menu" })).not.toBeNull();
    expect(screen.queryByRole("tablist", { name: "Open tabs" })).toBeNull();
    expect(screen.getByTestId("placement").textContent).toBe("top");
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

  it("keeps the shared desktop menu, tab row and stored placement at a narrow Linux window", () => {
    mobileState.value = true;
    useLayoutStore.setState({
      arrangement: { ...DEFAULT_ARRANGEMENT, tabStripPlacement: "left" },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RunnerHostProvider runnerHost={createDesktopHost()}>
          <AppHeader variant="app" />
          <PlacementProbe />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(
      screen.getAllByRole("navigation", { name: "Application menu" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect(screen.getByRole("tablist", { name: "Open tabs" })).not.toBeNull();
    expect(screen.getByTestId("placement").textContent).toBe("left");
  });
});
