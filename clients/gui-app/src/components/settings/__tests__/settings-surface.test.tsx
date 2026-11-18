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

vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: (props: { readonly variant: string }) => (
    <div data-testid="settings-sidebar-probe" data-variant={props.variant} />
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

  it("renders the rail on a wide layout and no sidebar on a phone with a section open", () => {
    testState.pathname = "/settings/appearance";
    const wide = render(<SettingsSurface lastPath={null} />);
    expect(screen.getByTestId("settings-sidebar-probe").dataset.variant).toBe(
      "rail",
    );
    wide.unmount();

    testState.mobile = true;
    render(<SettingsSurface lastPath={null} />);
    expect(screen.queryByTestId("settings-sidebar-probe")).toBeNull();
  });

  it("renders the section list on a phone at the index", () => {
    testState.mobile = true;
    testState.pathname = "/settings";
    render(<SettingsSurface lastPath={null} />);

    expect(screen.getByTestId("settings-sidebar-probe").dataset.variant).toBe(
      "mobile-list",
    );
  });
});
