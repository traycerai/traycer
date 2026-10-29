/**
 * The build without the unreleased features (`unreleased-features.ts`) never
 * draws a page it does not offer: a section it hides draws its replacement,
 * else General.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: () => <div data-testid="settings-sidebar-probe" />,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ setSection: () => undefined }),
}));
vi.mock("@/components/settings/personal/personal-page-frame", () => ({
  PersonalPageFrame: (props: { readonly children: React.ReactNode }) =>
    props.children,
}));
vi.mock("@/components/settings/panels/general-settings-panel", () => ({
  GeneralSettingsPanel: () => <div data-testid="general-page-probe" />,
}));
vi.mock("@/components/settings/panels/browser-settings-panel", () => ({
  BrowserSettingsPanel: () => <div data-testid="browser-page-probe" />,
}));

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanelForSection } from "@/components/settings/settings-modal-content";

afterEach(() => {
  cleanup();
});

describe("<SettingsPanelForSection /> without the unreleased features", () => {
  it("draws General's panel for the hidden Sandboxes section", () => {
    render(<SettingsPanelForSection section="sandboxes" />);

    expect(screen.getByTestId("general-page-probe")).toBeTruthy();
  });

  it("draws the Browser panel for Browser agent access", () => {
    render(<SettingsPanelForSection section="browser-agent-access" />);

    expect(screen.getByTestId("browser-page-probe")).toBeTruthy();
  });
});
