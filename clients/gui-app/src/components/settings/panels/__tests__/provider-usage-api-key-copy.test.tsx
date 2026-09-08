import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_KEY_USAGE_NOTICE_TEXT,
  USAGE_COVERAGE_SENTENCE,
} from "@/components/settings/panels/provider-rate-limit-section";

/**
 * W2-T14 item 3 (D27): the Usage tab's `authType: "apiKey"` arm renders the
 * exact gauge-area sentence and fires no rate-limit query (eligibility is
 * centralized in `lib/rate-limit-providers.ts`, never re-decided at this call
 * site); an OAuth row is unchanged; the coverage sentence always renders; and
 * `host.usage.summary`'s `profileId` filter is gated on the host's negotiated
 * major so an older host never receives the field.
 */

// Mocked, always-open dropdown - same established pattern as
// `provider-profile-switcher.test.tsx` (Radix's pointerdown-based open
// gesture doesn't cooperate with jsdom).
vi.mock("@/components/ui/dropdown-menu", async () => ({
  ...(await import("./dropdown-menu-passthrough-mock")),
}));

const providerMocks = vi.hoisted(() => ({
  listResult: {
    data: { providers: [] as ProviderCliState[] },
    isPending: false,
    isError: false,
    isFetching: false,
  },
}));
const rateLimitQueryMock = vi.hoisted(() =>
  vi.fn(
    (
      _providerId: string,
      _profileId: string | null,
      _fetchEligible: boolean,
    ) => ({
      data: undefined,
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: () => Promise.resolve({}),
    }),
  ),
);

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => providerMocks.listResult,
}));
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePack: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-set-selection-mutation", () => ({
  useProvidersSetSelection: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-add-custom-path-mutation", () => ({
  useProvidersAddCustomPath: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-remove-custom-path-mutation", () => ({
  useProvidersRemoveCustomPath: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", () => ({
  useProvidersSetEnabled: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock(
  "@/hooks/providers/use-providers-set-terminal-agent-args-mutation",
  () => ({
    useProvidersSetTerminalAgentArgs: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock("@/hooks/providers/use-providers-set-env-override-mutation", () => ({
  useProvidersSetEnvOverride: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-delete-env-override-mutation", () => ({
  useProvidersDeleteEnvOverride: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => {
  const useProvidersStartLogin = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useProvidersStartLogin,
    useProvidersStartLoginForClient: useProvidersStartLogin,
  };
});
vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => {
  const useProvidersAwaitLogin = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useHostScopedProvidersAwaitLogin: useProvidersAwaitLogin,
    useProvidersAwaitLoginForClient: useProvidersAwaitLogin,
  };
});
vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => {
  const useProvidersCancelLogin = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useProvidersCancelLogin,
    useProvidersCancelLoginForClient: useProvidersCancelLogin,
  };
});
vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => {
  const useRenameProviderProfile = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useRenameProviderProfile,
    useRenameProviderProfileForClient: useRenameProviderProfile,
  };
});
vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => {
  const useRecolorProviderProfile = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useRecolorProviderProfile,
    useRecolorProviderProfileForClient: useRecolorProviderProfile,
  };
});
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => {
  const useRemoveProviderProfile = () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  });
  return {
    useRemoveProviderProfile,
    useRemoveProviderProfileForClient: useRemoveProviderProfile,
  };
});
vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({ isFetching: false, data: undefined }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({ data: { harnesses: [] } }),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({}),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));
vi.mock("@/hooks/auth/use-refresh-credits-on-traycer-turn", () => ({
  useRefreshCreditsOnTraycerTurn: () => {},
}));
vi.mock("@/hooks/host/use-host-rate-limit-usage-query", () => ({
  useHostRateLimitUsageQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn", () => ({
  useRefreshRateLimitUsageOnTraycerTurn: () => {},
}));
vi.mock("@/hooks/host/use-host-provider-rate-limits-query", () => ({
  useHostProviderRateLimitsQuery: (
    providerId: string,
    profileId: string | null,
    fetchEligible: boolean,
  ) => rateLimitQueryMock(providerId, profileId, fetchEligible),
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-turn", () => ({
  useRefreshProviderRateLimitsOnTurn: () => {},
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => {},
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-a",
        kind: "local",
        label: "Local host",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture({ client: null }),
  };
});

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersProfileSelectionStore } from "@/stores/settings/providers-profile-selection-store";
import { providerProfileFixture } from "@/testing/provider-profile-fixture";

const HOST_ID = "host-a";
const PROVIDER_ID = "claude-code";

/** D25's persisted `(hostId, providerId)` selection - matches how
 *  `provider-profile-switcher.test.tsx` selects a non-default profile. */
function selectProfile(profileId: string): void {
  useProvidersProfileSelectionStore.setState({
    selectedByHost: { [HOST_ID]: { [PROVIDER_ID]: profileId } },
  });
}

function renderProvidersSettingsPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function ambientProfile(): ProviderProfile {
  return providerProfileFixture({
    profileId: "ambient",
    enabled: true,
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
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
  });
}

function apiKeyProfile(): ProviderProfile {
  return providerProfileFixture({
    profileId: "m1",
    enabled: true,
    kind: "managed",
    authType: "apiKey",
    label: "API Key One",
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
  });
}

function oauthProfile(): ProviderProfile {
  return providerProfileFixture({
    profileId: "m2",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "OAuth One",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: "m2@example.test", tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  });
}

function claudeStateWithProfiles(
  profiles: readonly ProviderProfile[],
): ProviderCliState {
  return {
    providerId: PROVIDER_ID,
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
    profiles: [...profiles],
    profilesSupported: true,
  };
}

async function openUsageTab(): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name: "Usage" }));
}

beforeEach(() => {
  resetNegotiatedManifests();
  rateLimitQueryMock.mockClear();
  useProvidersProfileSelectionStore.setState({ selectedByHost: {} });
});
afterEach(() => cleanup());

describe("Usage tab API-key copy (D27)", () => {
  it("renders exactly the API-key sentence and fires no rate-limit query", async () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([ambientProfile(), apiKeyProfile()]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    selectProfile("m1");
    renderProvidersSettingsPanel();
    await openUsageTab();

    expect(screen.getByText(API_KEY_USAGE_NOTICE_TEXT)).not.toBeNull();
    expect(rateLimitQueryMock).not.toHaveBeenCalled();
  });

  it("leaves an OAuth row unchanged", async () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([ambientProfile(), oauthProfile()]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    selectProfile("m2");
    renderProvidersSettingsPanel();
    await openUsageTab();

    expect(screen.queryByText(API_KEY_USAGE_NOTICE_TEXT)).toBeNull();
    expect(rateLimitQueryMock).toHaveBeenCalled();
  });

  it("renders the coverage sentence", async () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([ambientProfile(), apiKeyProfile()]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    selectProfile("m1");
    renderProvidersSettingsPanel();
    await openUsageTab();

    expect(screen.getByText(USAGE_COVERAGE_SENTENCE)).not.toBeNull();
  });
});

describe("Usage tab per-profile totals (W5-T2, D21/D27)", () => {
  it("shows an update notice for both authType arms when the host has not negotiated the profileId filter", async () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            apiKeyProfile(),
            oauthProfile(),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };

    selectProfile("m1");
    renderProvidersSettingsPanel();
    await openUsageTab();
    expect(
      screen.getByTestId("provider-usage-totals-unsupported"),
    ).toBeTruthy();

    selectProfile("m2");
    cleanup();
    renderProvidersSettingsPanel();
    await openUsageTab();
    expect(
      screen.getByTestId("provider-usage-totals-unsupported"),
    ).toBeTruthy();
  });

  it("stops showing the update notice once the host negotiates host.usage.summary@2", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "host.usage.summary": { major: 2, minor: 0 },
    });
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([ambientProfile(), oauthProfile()]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    selectProfile("m2");
    renderProvidersSettingsPanel();
    await openUsageTab();

    // No live client is wired in this suite (`@/lib/host`'s `useHostClient`
    // is mocked to `null`), so `host.usage.summary` never actually fires and
    // the section falls through to its "data unavailable" branch - this
    // still proves the GATE flips on a negotiated major, which is the one
    // thing this suite can prove without standing up a live host client.
    expect(
      screen.queryByTestId("provider-usage-totals-unsupported"),
    ).toBeNull();
    expect(
      screen.getByTestId("provider-usage-totals-unavailable"),
    ).toBeTruthy();
  });
});
