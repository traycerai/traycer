import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProfileSyncEntryButton as ProfileSyncEntryButtonType } from "@/components/settings/panels/profile-sync/profile-sync-entry-button";

// The section's boundary with the sync entry: what it hands the button.
const entry = vi.hoisted(
  (): { props: Parameters<typeof ProfileSyncEntryButtonType>[0][] } => ({
    props: [],
  }),
);
vi.mock(
  "@/components/settings/panels/profile-sync/profile-sync-entry-button",
  () => ({
    ProfileSyncEntryButton: (
      props: Parameters<typeof ProfileSyncEntryButtonType>[0],
    ) => {
      entry.props.push(props);
      return null;
    },
  }),
);
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
          onOpenCliSettings={() => undefined}
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={() => undefined}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId={selectedProfileId}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable={false}
          profileStatusRefreshAvailable={false}
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<ProviderProfileScopedSection /> sync entry boundary", () => {
  beforeEach(() => {
    entry.props = [];
  });
  afterEach(cleanup);

  it("hands the sync entry the selected profile when profiles exist", () => {
    renderSection(state([profile("first"), profile("second")]), "second");
    const last = entry.props.at(-1);
    expect(last?.hostId).toBe("host-1");
    expect(last?.providerId).toBe("claude-code");
    expect(last?.profile?.profileId).toBe("second");
  });

  it("hands the sync entry no profile when the provider has none", () => {
    renderSection(state([]), null);
    const last = entry.props.at(-1);
    expect(last).toBeDefined();
    expect(last?.profile).toBeNull();
  });
});
