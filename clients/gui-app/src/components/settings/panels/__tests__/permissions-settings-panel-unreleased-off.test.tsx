/**
 * The build without environments (`unreleased-features.ts`) shows Permissions
 * as the release before them did: four tabs, and the general subtitle.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture({});
  return { useHostScope, usePersonalHostScope: useHostScope };
});
// The page's pick is the Host picker's host, resolved from the host list.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [hostScopeOptionFixture({ hostId: "host-picked" })],
      }),
  };
});
vi.mock("@/components/settings/panels/permissions/judge-tab", () => ({
  JudgeTab: () => <div data-testid="judge-body" />,
}));
vi.mock("@/components/settings/panels/permissions/rules-tab", () => ({
  RulesTab: () => <div data-testid="rules-body" />,
}));
vi.mock("@/components/settings/panels/permissions/activity-tab", () => ({
  ActivityTab: () => <div data-testid="activity-body" />,
}));

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionsSettingsPanel } from "@/components/settings/panels/permissions-settings-panel";

afterEach(() => {
  cleanup();
});

describe("<PermissionsSettingsPanel /> without environments", () => {
  it("has no Browser tab and the general subtitle", () => {
    render(<PermissionsSettingsPanel />);

    expect(screen.queryByTestId("permissions-tab-browser")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(
      screen.getByText(
        "How much an agent may do on its own, and who reviews the rest.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/running Personal/)).toBeNull();
  });
});
