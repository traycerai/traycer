import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";

function profile(profileId: string): ProviderCliState["profiles"][number] {
  return {
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function state(profiles: ProviderCliState["profiles"]): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles,
  };
}

function renderSection(
  providerState: ProviderCliState,
  selectedProfileId: string | null,
): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ProviderProfileScopedSection
          state={providerState}
          hostId="host-1"
          isSelectedHostLocal
          canAddProfile
          credentialRefusal={null}
          onOpenCliSettings={() => undefined}
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={() => undefined}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId={selectedProfileId}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable={false}
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<ProviderProfileScopedSection /> without a sync entry", () => {
  beforeEach(() => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-1", hostName: "Studio" },
    });
  });
  afterEach(() => {
    cleanup();
    useSettingsEnvironmentPickStore.setState({ pick: null });
  });

  it("offers no Sync profiles on a Local row that has profiles, only Add a profile", () => {
    renderSection(state([profile("first"), profile("second")]), "second");

    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(screen.queryByText("Sync profiles")).toBeNull();
  });

  it("draws no Profiles card, and so no Sync profiles, on a Local row with zero profiles", () => {
    renderSection(state([]), null);

    expect(screen.queryByText("Profiles")).toBeNull();
    expect(screen.queryByText("Sync profiles")).toBeNull();
    expect(screen.queryByText("No profiles on this device.")).toBeNull();
  });

  it("offers no Sync profiles on Personal, which already carries every profile to its computers", () => {
    useSettingsEnvironmentPickStore.setState({ pick: null });
    renderSection(state([profile("first"), profile("second")]), "second");

    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(screen.queryByText("Sync profiles")).toBeNull();
  });
});
