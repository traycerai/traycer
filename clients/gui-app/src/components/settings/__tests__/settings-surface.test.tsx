import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const testState = vi.hoisted(() => ({ pathname: "/epics" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => select({ location: { pathname: testState.pathname } }),
}));

vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: () => <div data-testid="settings-sidebar-probe" />,
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
});
