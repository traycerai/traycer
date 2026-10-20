import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const testState = vi.hoisted(() => ({ pathname: "/epics", mobile: false }));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
  useRouterState: ({
    select,
  }: {
    select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => select({ location: { pathname: testState.pathname } }),
}));

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => testState.mobile,
}));

// The create dialog is one shared store's one mounted copy. The real sidebar
// mounts it in every variant it renders, so its probe carries one too: a test
// that counts copies counts the sidebar's as well as the surface's.
vi.mock("@/components/hosts/sandbox-create-dialog", () => ({
  SandboxCreateDialog: () => <div data-testid="sandbox-create-dialog-probe" />,
}));

vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: (props: { readonly variant: string }) => (
    <div data-testid="settings-sidebar-probe" data-variant={props.variant}>
      <div data-testid="sandbox-create-dialog-probe" />
    </div>
  ),
}));

vi.mock("@/components/settings/settings-modal-content", () => ({
  SettingsPanelForSection: (props: { readonly section: string }) => (
    <div data-section={props.section} data-testid="settings-panel-probe" />
  ),
}));

import { SettingsSurface } from "@/components/settings/settings-surface";

describe("<SettingsSurface />", () => {
  afterEach(() => {
    cleanup();
    testState.pathname = "/epics";
    testState.mobile = false;
  });

  it("keeps its remembered section while a split partner owns the route", () => {
    render(<SettingsSurface lastPath="/settings/providers" />);

    expect(screen.getByTestId("settings-panel-probe").dataset.section).toBe(
      "providers",
    );
  });

  it("uses the route section while Settings owns the route", () => {
    testState.pathname = "/settings/appearance";
    render(<SettingsSurface lastPath="/settings/providers" />);

    expect(screen.getByTestId("settings-panel-probe").dataset.section).toBe(
      "appearance",
    );
  });

  // A page result scrolls the pane the SURFACE owns, so every section has one
  // whatever its panel renders.
  it("wraps the panel in the pane a page result scrolls to the top", () => {
    testState.pathname = "/settings/appearance";
    render(<SettingsSurface lastPath={null} />);

    expect(
      screen
        .getByTestId("settings-panel-probe")
        .closest("[data-settings-panel-pane]"),
    ).not.toBeNull();
  });
  describe("the create dialog", () => {
    function dialogCopies(): number {
      return screen.queryAllByTestId("sandbox-create-dialog-probe").length;
    }

    it("is mounted once, by the rail, on a wide layout", () => {
      testState.pathname = "/settings/appearance";
      render(<SettingsSurface lastPath={null} />);

      expect(screen.getByTestId("settings-sidebar-probe").dataset.variant).toBe(
        "rail",
      );
      expect(dialogCopies()).toBe(1);
    });

    it("is mounted by the surface itself on a phone with a section open, where there is no sidebar", () => {
      testState.mobile = true;
      testState.pathname = "/settings/appearance";
      render(<SettingsSurface lastPath={null} />);

      expect(screen.queryByTestId("settings-sidebar-probe")).toBeNull();
      expect(dialogCopies()).toBe(1);
      expect(
        screen
          .getByTestId("sandbox-create-dialog-probe")
          .closest("[data-settings-panel-pane]"),
      ).not.toBeNull();
    });

    it("is mounted exactly once on a phone at the index, by the section list", () => {
      testState.mobile = true;
      testState.pathname = "/settings";
      render(<SettingsSurface lastPath={null} />);

      expect(screen.getByTestId("settings-sidebar-probe").dataset.variant).toBe(
        "mobile-list",
      );
      expect(dialogCopies()).toBe(1);
    });
  });
});
