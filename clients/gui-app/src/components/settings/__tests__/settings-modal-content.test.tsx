import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: () => <div data-testid="settings-sidebar-probe" />,
}));

// The modal's section setter drives the router, which this suite is not
// about; the panel is a probe so the only real thing mounted is the surface's
// own frame around it.
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ setSection: () => undefined }),
}));

vi.mock("@/components/settings/panels/usage-settings-panel", () => ({
  UsageSettingsPanel: () => <div data-testid="settings-panel-probe" />,
}));

// The Personal pages' frame reads the host runtime and has its own suite.
vi.mock("@/components/settings/personal/personal-page-frame", () => ({
  PersonalPageFrame: (props: { readonly children: React.ReactNode }) =>
    props.children,
}));
vi.mock("@/components/settings/panels/agents-settings-panel", () => ({
  AgentsSettingsPanel: () => <div data-testid="agents-page-probe" />,
}));
vi.mock("@/components/settings/panels/permissions-settings-panel", () => ({
  PermissionsSettingsPanel: () => <div data-testid="permissions-page-probe" />,
}));

import { SettingsModalContent } from "@/components/settings/settings-modal-content";

describe("<SettingsModalContent />", () => {
  afterEach(() => {
    cleanup();
  });

  // A page result scrolls the pane the SURFACE owns, so every section has one
  // whatever its panel renders.
  it("wraps the panel in the pane a page result scrolls to the top", () => {
    render(<SettingsModalContent section="usage" />);

    expect(
      screen
        .getByTestId("settings-panel-probe")
        .closest("[data-settings-panel-pane]"),
    ).not.toBeNull();
  });

  it("opens the Agents page for a modal opened on the retired Agent definitions", () => {
    render(<SettingsModalContent section="agent-definitions" />);

    expect(screen.getByTestId("agents-page-probe")).toBeTruthy();
  });

  it("opens the Permissions page for a modal opened on the retired Browser agent access", () => {
    render(<SettingsModalContent section="browser-agent-access" />);

    expect(screen.getByTestId("permissions-page-probe")).toBeTruthy();
  });
});
