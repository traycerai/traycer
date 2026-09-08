import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * W2-T14 item 5 (D21): every wave-2 method must be gated by
 * `useHostSupportsMethod`, which fails closed. This is the one check that
 * keeps "old host -> today's panel unchanged" true after six GUI tickets
 * land independently - it renders the whole Providers panel against a
 * manifest containing only today's released-floor methods and asserts none
 * of the six wave-2 affordances appear, plus that `providers.resolveLaunchEnv`
 * (loopback-only, D24) has no GUI call site at all.
 */

// Mocked, always-open dropdown - same established pattern as
// `provider-profile-switcher.test.tsx` / `provider-usage-api-key-copy.test.tsx`
// (Radix's pointerdown-based open gesture doesn't cooperate with jsdom).
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
vi.mock("@/hooks/providers/use-providers-submit-login-code-mutation", () => ({
  useProvidersSubmitLoginCodeForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    data: undefined,
    error: null,
    reset: vi.fn(),
  }),
}));
vi.mock("@/hooks/providers/use-providers-touch-login-mutation", () => ({
  useProvidersTouchLoginForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
}));
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
vi.mock(
  "@/hooks/providers/use-providers-create-api-key-profile-mutation",
  () => ({
    useProvidersCreateApiKeyProfileForClient: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  }),
);
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
  useHostProviderRateLimitsQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
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
// Account tab's apiKey arm (D21 `providers.getProfileConfig` /
// `setProfileConfig` / `testProfileConnection`) - mocked at the hook
// boundary the same way `profile-account-tab.test.tsx` does, so the real
// `useHostSupportsMethod` gate (exercised for real below, against the floor
// manifest) is what decides which arm renders, not a network round-trip.
vi.mock("@/hooks/providers/use-providers-profile-config-query", () => ({
  useProvidersProfileConfig: () => ({ data: undefined, isPending: false }),
}));
vi.mock(
  "@/hooks/providers/use-providers-set-profile-endpoint-mutation",
  () => ({
    useProvidersSetProfileEndpoint: () => ({
      mutate: vi.fn(),
      isPending: false,
      error: null,
    }),
  }),
);
vi.mock(
  "@/hooks/providers/use-providers-test-profile-connection-mutation",
  () => ({
    useProvidersTestProfileConnection: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock(
  "@/hooks/providers/use-providers-set-profile-ownership-mutation",
  () => ({
    useProvidersSetProfileOwnership: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  }),
);
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { CategoryOwnershipToggle } from "@/components/settings/panels/category-ownership-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersProfileSelectionStore } from "@/stores/settings/providers-profile-selection-store";
import { providerProfileFixture } from "@/testing/provider-profile-fixture";

const HOST_ID = "host-a";
const PROVIDER_ID = "claude-code";

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
    // Non-null so `providerCanStartProfileOauth` admits the Add-profile
    // gesture the API-key-tab-gating test drives - a null capability would
    // disable "Create new profile" for an unrelated reason (no sign-in
    // route at all) and mask what this suite is checking.
    loginCapability: {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
    },
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

beforeEach(() => {
  resetNegotiatedManifests();
  // Floor-only manifest: exactly what an older, already-released host
  // negotiates. None of the wave-2 methods this ticket gates
  // (`getProfileConfig`, `setProfileConfig`, `setProfileOwnership`,
  // `createApiKeyProfile`, `testProfileConnection`,
  // `previewCopySettings`/`applyCopySettings`) are on this list.
  recordNegotiatedHostMethods(HOST_ID, RELEASED_FLOOR_METHOD_NAMES);
  useProvidersProfileSelectionStore.setState({ selectedByHost: {} });
  providerMocks.listResult = {
    data: {
      providers: [claudeStateWithProfiles([ambientProfile(), apiKeyProfile()])],
    },
    isPending: false,
    isError: false,
    isFetching: false,
  };
});
afterEach(() => cleanup());

describe("old-host sweep: floor-only manifest hides every wave-2 affordance", () => {
  it("hides the Copy settings… entry", () => {
    selectProfile("m1");
    renderProvidersSettingsPanel();

    expect(screen.queryByRole("button", { name: "Copy settings…" })).toBeNull();
  });

  it("hides the endpoint form and Test connection, showing the old-host fallback instead", async () => {
    selectProfile("m1");
    renderProvidersSettingsPanel();

    // "Account" leads `PROVIDER_TAB_ORDER` and is always advertised (D05), so
    // it is already the default tab - clicked anyway to stay explicit and
    // resilient to a future default-tab change (same discipline as
    // `openUsageTab` in `provider-usage-api-key-copy.test.tsx`).
    await userEvent.click(screen.getByRole("tab", { name: "Account" }));

    expect(
      screen.getByText(
        "This host does not support editing profile endpoints yet.",
      ),
    ).not.toBeNull();
    expect(screen.queryByLabelText(/base url/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Test connection" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("hides the API key tab in the Add profile dialog", async () => {
    // Two profiles => the switcher renders the dropdown, not the
    // single-profile "Add profile" chip - `ProfileDropdown`'s own
    // "Create new profile" row is the entry point (`profile-dropdown.tsx`).
    selectProfile("m1");
    renderProvidersSettingsPanel();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    await userEvent.type(screen.getByLabelText("Profile name"), "New one");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("tab", { name: "Sign in" })).not.toBeNull();
    expect(screen.queryByRole("tab", { name: "API key" })).toBeNull();
  });
});

describe("old-host sweep: ownership toggle", () => {
  it("renders nothing once providers.setProfileOwnership is ungated (floor manifest)", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <CategoryOwnershipToggle
          hostId={HOST_ID}
          providerId={PROVIDER_ID}
          profileId="m1"
          category="skills"
          ownership="own"
          entryCount={3}
        />
      </QueryClientProvider>,
    );

    expect(container.innerHTML).toBe("");
  });
});

describe("old-host sweep: providers.resolveLaunchEnv has no GUI call site", () => {
  it("never appears in gui-app source outside the RPC policy bookkeeping table", () => {
    const srcRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const offenders: string[] = [];
    // The RPC policy table's own bookkeeping entry (`host-method-policy-table.ts`,
    // scheduling metadata only, never a call site) and this file's own doc
    // comments/assertion text are the only sanctioned mentions.
    const allowedFiles = new Set([
      join(srcRoot, "lib", "host-rpc-policy", "host-method-policy-table.ts"),
      join(import.meta.dirname, "providers-panel-old-host-gating.test.tsx"),
    ]);

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (allowedFiles.has(full)) continue;
        const contents = readFileSync(full, "utf8");
        if (contents.includes("resolveLaunchEnv")) {
          offenders.push(full);
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});
