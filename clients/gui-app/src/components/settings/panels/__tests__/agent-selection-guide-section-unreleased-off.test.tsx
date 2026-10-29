/**
 * The build without environments (`unreleased-features.ts`) words the guide
 * editor as the release before them did: the description paragraph shows and
 * the revert button says "Revert".
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/components/settings/panels/host-environment-section", () => ({
  HostEnvironmentSection: () => <div data-testid="host-environment-section" />,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "local",
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [
          hostScopeOptionFixture({ hostId: "local", name: "Local host" }),
        ],
      }),
  };
});
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => {
    const host = hostScopeOptionFixture({
      hostId: "local",
      name: "Local host",
      isLocalMachine: true,
      isActive: true,
    });
    return hostScopeFixture({
      hosts: [host],
      host,
      hostId: "local",
      hostLabel: "Local host",
      activeHost: host,
      isViewingActive: true,
      status: "ready",
      client: { getActiveHostId: () => "local" } as never,
    });
  };
  return { useHostScope, usePersonalHostScope: useHostScope };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const react = await import("react");
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  const defaultBinding = {
    hostClient: { getActiveHostId: () => "local" },
    directory: { refresh: () => Promise.resolve([]) },
  };
  const useHostBinding = () =>
    react.useContext(actual.HostRuntimeContext) ?? defaultBinding;
  return {
    ...actual,
    useHostBinding,
    useHostClient: () => useHostBinding().hostClient,
  };
});
vi.mock("@/hooks/agent/use-agent-selection-guide-global-query", () => ({
  useAgentSelectionGuideGlobalQuery: () => ({
    data: { content: "claude guide", generatedDefaultContent: "codex guide" },
    isError: false,
  }),
}));
vi.mock("@/hooks/agent/use-agent-selection-guide-set-global-mutation", () => ({
  useAgentSelectionGuideSetGlobalMutation: () => ({
    mutateAsync: vi.fn(),
  }),
}));
vi.mock(
  "@/hooks/agent/use-agent-selection-guide-reset-global-mutation",
  () => ({
    useAgentSelectionGuideResetGlobalMutation: () => ({
      mutateAsync: vi.fn(),
    }),
  }),
);

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionGuideSection } from "@/components/settings/panels/agent-selection-guide-section";

afterEach(() => {
  cleanup();
});

describe("<AgentSelectionGuideSection /> without environments", () => {
  it("shows the guide's description and a Revert button", () => {
    render(<AgentSelectionGuideSection />);

    expect(
      screen.getByText(/^Instructions for choosing Traycer agents'/),
    ).toBeTruthy();
    expect(
      screen.getByTestId("agents-selection-guide-revert").textContent,
    ).toBe("Revert to default");
  });

  it("titles the revert confirmation 'Revert to default instructions?'", () => {
    render(<AgentSelectionGuideSection />);

    fireEvent.click(screen.getByTestId("agents-selection-guide-revert"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Revert to default instructions?");
    expect(screen.getByTestId("confirm-action").textContent).toBe(
      "Revert to default",
    );
  });
});
