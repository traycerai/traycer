import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

import {
  STATUS_BAR_MENU_EXEMPT_ATTRIBUTE,
  StatusBarVisibilityMenu,
  type StatusBarMenuProvider,
} from "@/components/layout/status-bar/status-bar-visibility-menu";

function resetStore(): void {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  window.localStorage.clear();
}

const PROVIDERS: ReadonlyArray<StatusBarMenuProvider> = [
  { providerId: "codex", label: "Codex" },
  { providerId: "claude-code", label: "Claude Code" },
];

function renderMenu(providers = PROVIDERS) {
  return render(
    <StatusBarVisibilityMenu providers={providers}>
      <div data-testid="status-bar-trigger">status bar</div>
    </StatusBarVisibilityMenu>,
  );
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByTestId("status-bar-trigger"));
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  navigateToSettingsSectionMock.mockClear();
  resetStore();
});

describe("<StatusBarVisibilityMenu />", () => {
  it("reflects store state: every passed provider checked, none hidden by default", () => {
    renderMenu();
    openMenu();

    for (const provider of PROVIDERS) {
      expect(
        screen
          .getByRole("menuitemcheckbox", { name: provider.label })
          .getAttribute("aria-checked"),
      ).toBe("true");
    }
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Resource monitor" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("unchecks a provider already in the hidden deny-list", () => {
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          hiddenProviders: ["codex"],
        },
      },
    });
    renderMenu();
    openMenu();

    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Codex" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Claude Code" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("unchecks the resource-monitor item when resources are disabled", () => {
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        resources: { ...DEFAULT_STATUS_BAR_LAYOUT.resources, enabled: false },
      },
    });
    renderMenu();
    openMenu();

    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Resource monitor" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("toggles a provider's membership in the hidden deny-list on click", () => {
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Codex" }));

    expect(useLayoutStore.getState().statusBar.rateLimits.hiddenProviders).toEqual(
      ["codex"],
    );
  });

  it("navigates to the layout settings section from 'Status bar settings…'", () => {
    renderMenu();
    openMenu();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Status bar settings…" }),
    );

    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("layout");
  });

  it("'Move to header' sets placement to header", () => {
    useLayoutStore.getState().setStatusBarPlacement("status-bar");
    renderMenu();
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Move to header" }));

    expect(useLayoutStore.getState().statusBar.placement).toBe("header");
  });

  it("does not open the menu for a right-click on an exempt subtree", () => {
    render(
      <StatusBarVisibilityMenu providers={PROVIDERS}>
        <div data-testid="status-bar-trigger">
          <button
            type="button"
            data-testid="exempt-child"
            {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
          >
            host switcher
          </button>
        </div>
      </StatusBarVisibilityMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("exempt-child"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("still opens the menu for a right-click elsewhere in the trigger", () => {
    render(
      <StatusBarVisibilityMenu providers={PROVIDERS}>
        <div data-testid="status-bar-trigger">
          <button
            type="button"
            data-testid="exempt-child"
            {...{ [STATUS_BAR_MENU_EXEMPT_ATTRIBUTE]: "" }}
          >
            host switcher
          </button>
          <span data-testid="plain-region">plain</span>
        </div>
      </StatusBarVisibilityMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("plain-region"));
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
