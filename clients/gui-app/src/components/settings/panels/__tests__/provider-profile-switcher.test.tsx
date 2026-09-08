import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { resolveSelectedProfileId } from "@/stores/settings/providers-profile-selection-store";

/**
 * W2-T9: the profile switcher (D25) - render order above the tab rail,
 * Default-account-first ordering, the persisted `(hostId, providerId)`
 * selection and its invalid -> Default-account fallback, method-gated
 * Copy settings, and the focus-store deep-link ordering guarantee.
 */

// Mocked, always-open dropdown so a row can be selected without fighting
// Radix's pointerdown-based open gesture in jsdom (established pattern - see
// `profile-durability-f4-hostile-labels.test.tsx`).
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

// Panels depend on the host SCOPE, not on the hooks it composes. The default
// fixture host id is "host-a" (`hostScopeFixture`'s own default) - every
// `useHostSupportsMethod` / persisted-selection assertion below keys off it.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture({ client: null }),
  };
});

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useProvidersProfileSelectionStore } from "@/stores/settings/providers-profile-selection-store";
import { providerProfileFixture } from "@/testing/provider-profile-fixture";

const HOST_ID = "host-a";

function railProviderRow(name: string): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "Providers" });
  const list = within(nav).getByRole("list", { name: "Providers" });
  return within(list).getByRole("button", { name });
}

function renderProvidersSettingsPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
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

function managedProfile(profileId: string, label: string): ProviderProfile {
  return providerProfileFixture({
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: `${profileId}@example.test`,
      tier: null,
      accountUuid: null,
    },
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
    profiles: [...profiles],
    profilesSupported: true,
  };
}

// `claude-code` sorts before `opencode` in `PROVIDER_ID_ORDER`
// (`lib/provider-ordering.ts`), so pairing them keeps claude-code the rail's
// default (first) provider - unlike `codex`, which sorts BEFORE claude-code
// and would silently become the initial selection instead.
function opencodeStateWithProfiles(
  profiles: readonly ProviderProfile[],
): ProviderCliState {
  return { ...claudeStateWithProfiles(profiles), providerId: "opencode" };
}

beforeEach(() => {
  resetNegotiatedManifests();
  useProvidersProfileSelectionStore.setState({ selectedByHost: {} });
  useProvidersFocusStore.setState({
    focusHarnessId: null,
    focusHostId: null,
    focusTargetHostId: null,
    focusProfileId: null,
    startSignIn: false,
    focusTab: null,
  });
});
afterEach(() => cleanup());

describe("resolveSelectedProfileId", () => {
  const profiles = [ambientProfile(), managedProfile("m1", "Managed One")];

  it("keeps a remembered id that still names a profile", () => {
    expect(resolveSelectedProfileId("m1", profiles)).toBe("m1");
  });

  it("falls back to Default account (null) for a remembered id absent from profiles", () => {
    expect(resolveSelectedProfileId("gone", profiles)).toBeNull();
  });

  it("falls back to Default account (null) when nothing was ever remembered", () => {
    expect(resolveSelectedProfileId(undefined, profiles)).toBeNull();
    expect(resolveSelectedProfileId(null, profiles)).toBeNull();
  });
});

describe("profile switcher (W2-T9)", () => {
  it("renders above the tab rail", () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            managedProfile("m1", "Managed One"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    renderProvidersSettingsPanel();

    const eyebrow = screen.getByText("Profile");
    const tabList = screen.getByRole("tablist");
    // DOCUMENT_POSITION_FOLLOWING (4): `tabList` comes after `eyebrow` in the
    // document.
    expect(
      eyebrow.compareDocumentPosition(tabList) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("lists Default account first, then managed profiles in wire order", () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            managedProfile("m1", "Managed One"),
            managedProfile("m2", "Managed Two"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    renderProvidersSettingsPanel();

    const rows = screen.getAllByRole("menuitem");
    // The mocked dropdown's rows carry every profile row PLUS "Create new
    // profile"; only the first three are profile rows.
    expect(rows[0]?.textContent).toContain("Default account");
    expect(rows[1]?.textContent).toContain("Managed One");
    expect(rows[2]?.textContent).toContain("Managed Two");
  });

  it("persists a selection per (hostId, providerId), and does not leak it to a different provider", () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            managedProfile("m1", "Managed One"),
          ]),
          opencodeStateWithProfiles([
            ambientProfile(),
            managedProfile("o1", "OpenCode Managed"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    renderProvidersSettingsPanel();

    // Default selection is Default account (Terminal account).
    expect(
      screen
        .getByRole("menuitem", { name: "Default account, Default account" })
        .getAttribute("aria-current"),
    ).toBe("true");

    // Select the managed profile for claude-code (the active provider).
    fireEvent.click(screen.getByRole("menuitem", { name: "Managed One" }));
    expect(
      screen
        .getByRole("menuitem", { name: "Managed One" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      useProvidersProfileSelectionStore.getState().selectedByHost[HOST_ID]?.[
        "claude-code"
      ],
    ).toBe("m1");

    // Re-render at the SAME (hostId, providerId): the selection is restored.
    cleanup();
    renderProvidersSettingsPanel();
    expect(
      screen
        .getByRole("menuitem", { name: "Managed One" })
        .getAttribute("aria-current"),
    ).toBe("true");

    // Switch to a DIFFERENT provider (opencode): its own selection - Default
    // account - is unaffected by claude-code's remembered pick.
    fireEvent.click(railProviderRow("OpenCode"));
    expect(
      screen
        .getByRole("menuitem", { name: "Default account, Default account" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      useProvidersProfileSelectionStore.getState().selectedByHost[HOST_ID]?.[
        "opencode"
      ],
    ).toBeUndefined();
  });

  it("hides Copy settings… on a host that has not negotiated providers.previewCopySettings/applyCopySettings, and leaves the tab set unchanged", () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            managedProfile("m1", "Managed One"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    renderProvidersSettingsPanel();

    expect(screen.queryByRole("button", { name: "Copy settings…" })).toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Account",
      "Usage",
      "CLI & Args",
      "Env",
    ]);
  });

  it("hides Copy settings… when only one of providers.previewCopySettings/applyCopySettings is negotiated", () => {
    recordNegotiatedHostMethods(HOST_ID, ["providers.previewCopySettings"]);
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            managedProfile("m1", "Managed One"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    renderProvidersSettingsPanel();

    expect(screen.queryByRole("button", { name: "Copy settings…" })).toBeNull();
  });

  it("shows Copy settings… once the host negotiates both providers.previewCopySettings and providers.applyCopySettings", () => {
    recordNegotiatedHostMethods(HOST_ID, [
      "providers.previewCopySettings",
      "providers.applyCopySettings",
    ]);
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            managedProfile("m1", "Managed One"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    renderProvidersSettingsPanel();

    expect(
      screen.getByRole("button", { name: "Copy settings…" }),
    ).not.toBeNull();
  });

  it("opens the Account tab with the deep-linked profile selected on first paint", () => {
    providerMocks.listResult = {
      data: {
        providers: [
          claudeStateWithProfiles([
            ambientProfile(),
            managedProfile("m1", "Managed One"),
          ]),
        ],
      },
      isPending: false,
      isError: false,
      isFetching: false,
    };
    // `hostId: null` - no host in particular, so the (only) rail consumes
    // the intent directly rather than round-tripping through the deep-link
    // host switch.
    const focus = useProvidersFocusStore.getState();
    focus.setProfileFocus({
      harnessId: "claude",
      hostId: null,
      profileId: "m1",
      startSignIn: false,
    });
    focus.setFocusTab("account");

    renderProvidersSettingsPanel();

    // No intermediate render against the default (Default account / first
    // tab): the Account tab is active and Managed One is selected on the
    // very first paint.
    expect(
      screen.getByRole("tab", { name: "Account" }).getAttribute("data-state"),
    ).toBe("active");
    expect(
      screen
        .getByRole("menuitem", { name: "Managed One" })
        .getAttribute("aria-current"),
    ).toBe("true");
  });
});
