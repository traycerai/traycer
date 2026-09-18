import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: (props: {
    readonly mode: { readonly kind: string; readonly activeSection?: string };
  }) => (
    <div
      data-testid="settings-sidebar-probe"
      data-active={props.mode.activeSection}
    />
  ),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ setSection: () => undefined }),
}));

// The two panels are probes: this suite is about which of them the modal
// resolves a remembered `layout` section to, not about what they draw.
vi.mock("@/components/settings/panels/layout-settings-panel", () => ({
  LayoutSettingsPanel: () => <div data-testid="layout-panel-probe" />,
}));
vi.mock("@/components/settings/panels/appearance-settings-panel", () => ({
  AppearanceSettingsPanel: () => <div data-testid="appearance-panel-probe" />,
}));

import { SettingsModalContent } from "@/components/settings/settings-modal-content";

describe("<SettingsModalContent /> Layout section", () => {
  beforeEach(() => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  });

  it("renders the Layout page with the editor off", () => {
    render(<SettingsModalContent section="layout" />);

    expect(screen.getByTestId("layout-panel-probe")).toBeTruthy();
    expect(screen.getByTestId("settings-sidebar-probe").dataset.active).toBe(
      "layout",
    );
  });

  it("opens Appearance instead when the editor has taken the page over", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    render(<SettingsModalContent section="layout" />);

    expect(screen.getByTestId("appearance-panel-probe")).toBeTruthy();
    expect(screen.queryByTestId("layout-panel-probe")).toBeNull();
    expect(screen.getByTestId("settings-sidebar-probe").dataset.active).toBe(
      "appearance",
    );
  });

  it("leaves every other section alone", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    render(<SettingsModalContent section="appearance" />);

    expect(screen.getByTestId("appearance-panel-probe")).toBeTruthy();
  });
});
