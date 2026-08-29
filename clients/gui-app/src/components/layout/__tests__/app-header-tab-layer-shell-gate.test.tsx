import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/layout/header/app-header";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { shellSurfaces } from "../../../../__tests__/shell-surfaces";

// The header's other children need host/query/auth providers; stub them so
// this suite is about one decision - whether the tab layer is drawn.
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
  isMobileViewport: () => false,
}));
vi.mock("@/components/layout/header/windows-menu-bar", () => ({
  WindowsMenuBar: () => null,
}));
vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div role="tablist" aria-label="Open tabs" />,
}));
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => (
    <button type="button" aria-label="Go back">
      back
    </button>
  ),
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
vi.mock("@/components/auth/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => null,
}));

/**
 * Stated per shell rather than read off the fixture's own `hasAppTabs`.
 *
 * Deriving the expectation from the value under test would pass for ANY
 * value that value happened to hold - including the one this change exists
 * to flip. Naming the four shells here is what makes a wrong answer for one
 * of them a failure rather than a tautology.
 */
const EXPECTED_TAB_LAYER: Readonly<Record<string, boolean>> = {
  desktop: true,
  "installed mobile": true,
  webapp: false,
  "browser dev": false,
};

describe("app header tab layer, per shell", () => {
  afterEach(() => {
    cleanup();
  });

  for (const shell of shellSurfaces()) {
    const expected = EXPECTED_TAB_LAYER[shell.name];

    it(`${expected ? "draws" : "does not draw"} the tab layer on ${shell.name}`, () => {
      render(
        <RunnerHostProvider runnerHost={shell.runnerHost}>
          <AppHeader variant="app" />
        </RunnerHostProvider>,
      );

      const strip = screen.queryByRole("tablist", { name: "Open tabs" });
      if (expected) {
        expect(strip).not.toBeNull();
      } else {
        expect(strip).toBeNull();
      }
    });
  }

  it("keeps router history controls on a shell that draws no tab layer", () => {
    const webapp = shellSurfaces().find((shell) => shell.name === "webapp");
    expect(webapp).toBeDefined();
    if (webapp === undefined) return;

    render(
      <RunnerHostProvider runnerHost={webapp.runnerHost}>
        <AppHeader variant="app" />
      </RunnerHostProvider>,
    );

    // Suppressing the tab layer is not the same as suppressing navigation:
    // these move the router's own history, which exists either way.
    expect(screen.getByRole("button", { name: "Go back" })).not.toBeNull();
    expect(screen.queryByRole("tablist", { name: "Open tabs" })).toBeNull();
  });

  it("leaves no fixed-width tab gutter behind on a shell without the layer", () => {
    const webapp = shellSurfaces().find((shell) => shell.name === "webapp");
    const desktop = shellSurfaces().find((shell) => shell.name === "desktop");
    expect(webapp).toBeDefined();
    expect(desktop).toBeDefined();
    if (webapp === undefined || desktop === undefined) return;

    const spacerClasses = (runnerHost: typeof webapp.runnerHost): string => {
      cleanup();
      render(
        <RunnerHostProvider runnerHost={runnerHost}>
          <AppHeader variant="app" />
        </RunnerHostProvider>,
      );
      const header = screen.getByTestId("app-header");
      const spacers = header.querySelectorAll('[aria-hidden="true"]');
      // One spacer on a browser shell: the frameless drag handle is desktop-only.
      expect(spacers.length).toBe(1);
      return spacers[0].className;
    };

    // The gutter beside a strip is a reserved fixed width. With no strip there
    // is nothing to reserve it for, so the same element has to become ordinary
    // free space rather than a gap the layout still pays for.
    expect(spacerClasses(desktop.runnerHost)).toContain("basis-[clamp(");
    const webSpacer = spacerClasses(webapp.runnerHost);
    expect(webSpacer).toContain("flex-1");
    expect(webSpacer).not.toContain("basis-[clamp(");
  });

  it("never draws the tab layer on the host-loading variant", () => {
    const desktop = shellSurfaces().find((shell) => shell.name === "desktop");
    expect(desktop).toBeDefined();
    if (desktop === undefined) return;

    render(
      <RunnerHostProvider runnerHost={desktop.runnerHost}>
        <AppHeader variant="host-loading" />
      </RunnerHostProvider>,
    );

    expect(screen.queryByRole("tablist", { name: "Open tabs" })).toBeNull();
  });
});
