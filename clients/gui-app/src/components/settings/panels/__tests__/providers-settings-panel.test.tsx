import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderProfileAccentColor,
  type ProviderAuth,
  type ProviderCliCandidate,
  type ProviderCliState,
  type ProviderProfile,
  type ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StartLoginVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string | null;
  readonly createProfile: {
    readonly label: string;
    readonly shareSkillsAndPlugins: boolean;
  } | null;
};
type StartLoginData = {
  readonly url: string;
  readonly started: boolean;
  readonly profileId: string | null;
};
type StartLoginOptions = {
  readonly onSuccess: (data: StartLoginData) => void;
  readonly onError: () => void;
};
type StartLoginMutate = (
  variables: StartLoginVariables,
  options: StartLoginOptions,
) => void;

type AwaitLoginVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string | null;
};
type AwaitLoginOptions = {
  readonly onSuccess: (data: unknown) => void;
  readonly onError: () => void;
};
type AwaitLoginMutate = (
  variables: AwaitLoginVariables,
  options: AwaitLoginOptions,
) => void;

type RenameProfileVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string;
  readonly label: string;
};
type MutationSuccessOptions = {
  readonly onSuccess: () => void;
};
type RenameProfileMutate = (
  variables: RenameProfileVariables,
  options: MutationSuccessOptions,
) => void;

type RemoveProfileVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string;
};
type RemoveProfileMutate = (
  variables: RemoveProfileVariables,
  options: MutationSuccessOptions,
) => void;
type RecolorProfileVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string;
  readonly accentColor: ProviderProfileAccentColor;
};
type RecolorProfileMutate = (
  variables: RecolorProfileVariables,
  options: MutationSuccessOptions,
) => void;

const providerMocks = vi.hoisted(() => ({
  listResult: {
    data: { providers: [] as ProviderCliState[] },
    isPending: false,
    isError: false,
    isFetching: false,
  },
  setSelectionMutate: vi.fn(),
  addCustomPathMutate: vi.fn(),
  removeCustomPathMutate: vi.fn(),
  setEnabledMutate: vi.fn(),
  setApiKeyMutate: vi.fn(),
  clearApiKeyMutate: vi.fn(),
  setTerminalAgentArgsMutate: vi.fn(),
  setEnvOverrideMutate: vi.fn(),
  deleteEnvOverrideMutate: vi.fn(),
  startLoginMutate: vi.fn<StartLoginMutate>(),
  awaitLoginMutate: vi.fn<AwaitLoginMutate>(),
  cancelLoginMutate: vi.fn(),
  renameProfileMutate: vi.fn<RenameProfileMutate>(),
  recolorProfileMutate: vi.fn<RecolorProfileMutate>(),
  removeProfileMutate: vi.fn<RemoveProfileMutate>(),
  refreshProviders: vi.fn(() => Promise.resolve()),
  refreshUsageLimits: vi.fn(() => Promise.resolve()),
  openExternalLink: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => providerMocks.listResult,
}));

vi.mock("@/hooks/providers/use-providers-set-selection-mutation", () => ({
  useProvidersSetSelection: () => ({
    mutate: providerMocks.setSelectionMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-add-custom-path-mutation", () => ({
  useProvidersAddCustomPath: () => ({
    mutate: providerMocks.addCustomPathMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-remove-custom-path-mutation", () => ({
  useProvidersRemoveCustomPath: () => ({
    mutate: providerMocks.removeCustomPathMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-enabled-mutation", () => ({
  useProvidersSetEnabled: () => ({
    mutate: providerMocks.setEnabledMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({
    mutate: providerMocks.setApiKeyMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({
    mutate: providerMocks.clearApiKeyMutate,
    isPending: false,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-set-terminal-agent-args-mutation",
  () => ({
    useProvidersSetTerminalAgentArgs: () => ({
      mutate: providerMocks.setTerminalAgentArgsMutate,
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/providers/use-providers-set-env-override-mutation", () => ({
  useProvidersSetEnvOverride: () => ({
    mutate: providerMocks.setEnvOverrideMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-delete-env-override-mutation", () => ({
  useProvidersDeleteEnvOverride: () => ({
    mutate: providerMocks.deleteEnvOverrideMutate,
    isPending: false,
  }),
}));

// Both the plain and `*ForClient` names are exported: the inline profile
// re-auth panel calls the plain hooks (host-runtime-context-
// scoped, unchanged by S8), while `AddProviderProfileDialog` calls the
// `*ForClient` variants with an explicit client (also Settings' own host in
// this tree - see the `@/lib/host` mock below). Both resolve to the same
// recorded mock so assertions don't care which path fired.
vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => {
  const useProvidersStartLogin = () => ({
    mutate: providerMocks.startLoginMutate,
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
    mutate: providerMocks.awaitLoginMutate,
    isPending: false,
    error: null,
  });
  return {
    useHostScopedProvidersAwaitLogin: useProvidersAwaitLogin,
    useProvidersAwaitLoginForClient: useProvidersAwaitLogin,
  };
});

vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => {
  const useProvidersCancelLogin = () => ({
    mutate: providerMocks.cancelLoginMutate,
    isPending: false,
  });
  return {
    useProvidersCancelLogin,
    useProvidersCancelLoginForClient: useProvidersCancelLogin,
  };
});

vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => {
  const useRenameProviderProfile = () => ({
    mutate: providerMocks.renameProfileMutate,
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
    mutate: providerMocks.recolorProfileMutate,
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
    mutate: providerMocks.removeProfileMutate,
    isPending: false,
    error: null,
  });
  return {
    useRemoveProviderProfile,
    useRemoveProviderProfileForClient: useRemoveProviderProfile,
  };
});

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  // `ProviderDetail` resolves the add-profile dialog's host scope via
  // `useHostClient()` directly (Settings always targets the selected/default
  // host, never a tab) - this harness has no real `<HostRuntimeProvider>`, so
  // stub it the same way every other provider hook here is stubbed.
  return { ...actual, useHostClient: () => null };
});

vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({
    isFetching: false,
    data: undefined,
  }),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: { harnesses: [] },
  }),
}));

vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => providerMocks.refreshProviders,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    openExternalLink: providerMocks.openExternalLink,
  }),
}));

// The Traycer provider mounts the subscription card; stub its credits query so
// the real AuthService (which needs a host-runtime provider) isn't invoked.
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));

// Pure side-effect hook in the Traycer subscription card; no render output, and
// it needs a QueryClient this harness doesn't set up.
vi.mock("@/hooks/auth/use-refresh-credits-on-traycer-turn", () => ({
  useRefreshCreditsOnTraycerTurn: () => {},
}));

// Rate-limit usage query + its refresh hook (RateLimitView). Same reason:
// no host client/QueryClient in this harness.
vi.mock("@/hooks/host/use-host-rate-limit-usage-query", () => ({
  useHostRateLimitUsageQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn", () => ({
  useRefreshRateLimitUsageOnTraycerTurn: () => {},
}));

// Provider rate-limit query + its refresh hook (ProviderRateLimitForProvider,
// mounted for every codex/claude-code provider row). Same reason: no host
// client/QueryClient in this harness.
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
vi.mock("@/hooks/rate-limits/use-provider-rate-limit-refresh", () => ({
  useProviderRateLimitRefresh: () => ({
    refresh: providerMocks.refreshUsageLimits,
    isRefreshing: false,
  }),
}));

// Host picker plumbing: a single active host and no transient client means
// the panel renders inline (no runtime-context re-provide), and `useHostBinding`
// returns null without a `<HostRuntimeProvider>`.
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "local",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
        kind: "local",
        label: "Local host",
        status: "available",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

// The profile-scoped section's `ProfileDropdown` renders through Radix's real
// DropdownMenu, which opens on pointerdown rather than click - render it
// inline + always-open so tests can select a row without fighting
// pointer-open semantics in jsdom (mirrors the established mock in
// worktrees-settings-panel.test / folder-controls.test).
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: (props: {
      readonly children: ReactNode;
      readonly onSelect: (() => void) | undefined;
      readonly "aria-label": string | undefined;
      readonly "aria-current": "true" | undefined;
      readonly className: string | undefined;
      readonly disabled: boolean | undefined;
      readonly title: string | undefined;
    }): ReactNode => (
      <button
        type="button"
        role="menuitem"
        aria-label={props["aria-label"]}
        aria-current={props["aria-current"]}
        className={props.className}
        disabled={props.disabled}
        title={props.title}
        onClick={props.onSelect}
      >
        {props.children}
      </button>
    ),
    DropdownMenuSeparator: (): ReactNode => <div role="separator" />,
    DropdownMenuShortcut: (props: {
      readonly children: ReactNode;
      readonly "data-testid": string | undefined;
    }): ReactNode => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
});

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";
import { TooltipProvider } from "@/components/ui/tooltip";
import { redactEmail } from "@/lib/providers/redact-email";

const OPENCODE_CANDIDATES: readonly ProviderCliCandidate[] = [
  {
    kind: "bundled",
    path: "/bundled/opencode",
    version: "1.0.0",
    available: true,
    versionPending: false,
  },
  {
    kind: "path",
    path: "/usr/local/bin/opencode",
    version: "1.1.0",
    available: true,
    versionPending: false,
  },
];

function providerState(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
  readonly envOverrides: ProviderCliState["envOverrides"];
  readonly profiles?: readonly ProviderProfile[];
}): ProviderCliState {
  return {
    providerId: input.providerId,
    enabled: true,
    disabledBy: null,
    selected: input.selected,
    candidates: [...input.candidates],
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
    envOverrides: [...input.envOverrides],
    loginCapability: null,
    availabilityPending: false,
    profiles: [...(input.profiles ?? [])],
  };
}

function providerStateWithAuth(
  input: {
    readonly providerId: ProviderCliState["providerId"];
    readonly selected: ProviderSelection;
    readonly candidates: readonly ProviderCliCandidate[];
    readonly envOverrides: ProviderCliState["envOverrides"];
  },
  auth: ProviderAuth,
  authPending: boolean,
): ProviderCliState {
  return { ...providerState(input), auth, authPending };
}

type TestProfileInput = {
  readonly profileId: string;
  readonly kind: ProviderProfile["kind"];
  readonly label: string;
  readonly email: string | null;
  readonly tier: string | null;
  readonly authStatus: ProviderProfile["auth"]["status"];
  readonly duplicateOfProfileId: string | null;
  readonly ambientDriftNotice: ProviderProfile["ambientDriftNotice"];
};

function profile(input: TestProfileInput): ProviderProfile {
  return profileWithAccent(input, null);
}

function profileWithAccent(
  input: TestProfileInput,
  accentColor: ProviderProfileAccentColor | null,
): ProviderProfile {
  return {
    profileId: input.profileId,
    kind: input.kind,
    authType: "oauth",
    label: input.label,
    auth: {
      status: input.authStatus,
      badgeText: null,
      label: null,
      detail: null,
    },
    identity:
      input.email === null && input.tier === null
        ? null
        : {
            email: input.email,
            tier: input.tier,
            accountUuid: null,
          },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: input.duplicateOfProfileId,
    ambientDriftNotice: input.ambientDriftNotice,
    accentColor,
  };
}

function firstStartLoginCall(): readonly [
  StartLoginVariables,
  StartLoginOptions,
] {
  const call = providerMocks.startLoginMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected start login call.");
  return call;
}

function firstAwaitLoginCall(): readonly [
  AwaitLoginVariables,
  AwaitLoginOptions,
] {
  const call = providerMocks.awaitLoginMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected await login call.");
  return call;
}

function firstRenameProfileCall(): readonly [
  RenameProfileVariables,
  MutationSuccessOptions,
] {
  const call = providerMocks.renameProfileMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected rename profile call.");
  return call;
}

function firstRecolorProfileCall(): readonly [
  RecolorProfileVariables,
  MutationSuccessOptions,
] {
  const call = providerMocks.recolorProfileMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected recolor profile call.");
  return call;
}

function firstRemoveProfileCall(): readonly [
  RemoveProfileVariables,
  MutationSuccessOptions,
] {
  const call = providerMocks.removeProfileMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected remove profile call.");
  return call;
}

describe("<ProvidersSettingsPanel />", () => {
  beforeEach(() => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "opencode",
          selected: { kind: "bundled" },
          candidates: OPENCODE_CANDIDATES,
          envOverrides: [],
        }),
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "openrouter",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };
    providerMocks.setSelectionMutate.mockClear();
    providerMocks.setEnabledMutate.mockClear();
    providerMocks.setEnvOverrideMutate.mockClear();
    providerMocks.deleteEnvOverrideMutate.mockClear();
    providerMocks.startLoginMutate.mockReset();
    providerMocks.awaitLoginMutate.mockReset();
    providerMocks.cancelLoginMutate.mockReset();
    providerMocks.renameProfileMutate.mockReset();
    providerMocks.recolorProfileMutate.mockReset();
    providerMocks.removeProfileMutate.mockReset();
    providerMocks.refreshProviders.mockClear();
    providerMocks.refreshUsageLimits.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("lists OpenCode CLI candidates for Traycer and mutates Traycer selection", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Traycer/i }));

    expect(screen.getByText("/usr/local/bin/opencode")).toBeDefined();

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Select /usr/local/bin/opencode",
      }),
    );

    expect(providerMocks.setSelectionMutate).toHaveBeenCalledWith({
      providerId: "traycer",
      selection: { kind: "path" },
    });
  });

  it("hides the CLI-candidates picker for Amp - a selected path is never consulted", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "amp",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Add custom path" }),
    ).toBeNull();
  });

  it("orders the provider rail by the default provider order", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "openrouter",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "qwen",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "codex",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "cursor",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "droid",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "kilocode",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "claude-code",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
        providerState({
          providerId: "copilot",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Providers" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Codex",
      "Claude Code",
      "OpenRouter",
      "Droid",
      "Cursor",
      "Copilot",
      "Kilo Code",
      "Qwen Code",
    ]);
  });

  it("renders configured, unavailable, and pending auth statuses", () => {
    providerMocks.listResult.data = {
      providers: [
        providerStateWithAuth(
          {
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          },
          {
            status: "configured",
            badgeText: "Codex API Key",
            label: null,
            detail: null,
          },
          false,
        ),
        providerStateWithAuth(
          {
            providerId: "cursor",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          },
          {
            status: "unavailable",
            badgeText: null,
            label: null,
            detail: "network failed",
          },
          false,
        ),
        providerStateWithAuth(
          {
            providerId: "qwen",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          },
          {
            status: "authenticated",
            badgeText: null,
            label: "Authenticated as qwen@example.test",
            detail: null,
          },
          true,
        ),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByText("Configured, not verified")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
    expect(screen.getByText("Could not check account status")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Qwen Code" }));
    expect(screen.getByText("Checking account")).toBeDefined();
  });

  it("does not render disabled attribution for providers", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          }),
          enabled: false,
          disabledBy: {
            userId: "a7f4dd6c-7f20-44c2-b83b-fdc71c258b80",
            handle: "teammate",
            at: 1,
          },
        },
        {
          ...providerState({
            providerId: "traycer",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
          }),
          enabled: false,
          disabledBy: {
            userId: "0c8cedd2-b928-4980-bf87-fb9f948c23e5",
            handle: null,
            at: 1,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByText(/Disabled by/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Traycer/i }));

    expect(screen.queryByText(/Disabled by/)).toBeNull();
  });

  it("lists OpenCode CLI candidates for OpenRouter and mutates OpenRouter selection", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/i }));

    expect(screen.getByText("/usr/local/bin/opencode")).toBeDefined();

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Select /usr/local/bin/opencode",
      }),
    );

    expect(providerMocks.setSelectionMutate).toHaveBeenCalledWith({
      providerId: "openrouter",
      selection: { kind: "path" },
    });
  });

  it("shows provider-scoped environment controls from provider state", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "opencode",
          selected: { kind: "bundled" },
          candidates: OPENCODE_CANDIDATES,
          envOverrides: [{ key: "OPENAI_API_KEY", value: null }],
        }),
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByText("Environment variables")).toBeDefined();
    expect(screen.getByDisplayValue("OPENAI_API_KEY")).toBeDefined();
    expect(
      screen.getByText(/Applied when Traycer spawns the OpenCode/),
    ).toBeDefined();
  });

  it("renders the host picker in the header (like Worktrees)", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByRole("combobox", { name: "Host" })).toBeDefined();
  });

  it("blocks disabling the last enabled provider", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const switchElement = screen.getByRole("switch");
    if (!(switchElement instanceof HTMLButtonElement)) {
      throw new Error("Expected provider switch to render as a button.");
    }

    expect(switchElement.disabled).toBe(true);
    fireEvent.click(switchElement);

    expect(providerMocks.setEnabledMutate).not.toHaveBeenCalled();
  });

  it("does not render profile management when the host reports no profiles", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByText("Profiles")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add profile" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Create new profile" }),
    ).toBeNull();
  });

  it("uses the shared profile switcher and combined refresh when only the terminal profile exists", async () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Codex profile: Terminal account" }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "Terminal account" }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Add profile" })).toBeDefined();
    expect(screen.getByText("Profiles")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Edit Terminal account profile" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Refresh usage limits" }),
    ).toBeNull();

    const addProfileButton = screen.getByRole("button", {
      name: "Add profile",
    });
    const refreshButton = screen.getByRole("button", {
      name: "Refresh profile statuses and usage limits",
    });
    expect(addProfileButton.nextElementSibling).toBe(refreshButton);
    fireEvent.click(refreshButton);
    await waitFor(() => {
      expect(providerMocks.refreshProviders).toHaveBeenCalledTimes(1);
      expect(providerMocks.refreshUsageLimits).toHaveBeenCalledTimes(1);
    });
  });

  it("edits and switches the default account", async () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: "Pro",
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Terminal account profile" }),
    );
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Default" },
    });

    const accentColor = PROVIDER_PROFILE_ACCENT_COLORS[4];
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${accentColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const [renameVariables, renameOptions] = firstRenameProfileCall();
    expect(renameVariables).toEqual({
      providerId: "codex",
      profileId: "ambient",
      label: "Default",
    });
    act(() => renameOptions.onSuccess());

    const [recolorVariables, recolorOptions] = firstRecolorProfileCall();
    expect(recolorVariables).toEqual({
      providerId: "codex",
      profileId: "ambient",
      accentColor,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(providerMocks.renameProfileMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.recolorProfileMutate).toHaveBeenCalledTimes(2);
    act(() => recolorOptions.onSuccess());

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Terminal account profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    expect(firstStartLoginCall()[0]).toEqual({
      providerId: "codex",
      profileId: "ambient",
      createProfile: null,
    });
  });

  it("resets the edit draft when reopening the same or a different profile", () => {
    const ambientColor = PROVIDER_PROFILE_ACCENT_COLORS[0];
    const workColor = PROVIDER_PROFILE_ACCENT_COLORS[1];
    const staleColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profileWithAccent(
                {
                  profileId: "ambient",
                  kind: "ambient",
                  label: "Terminal account",
                  email: "ambient@example.test",
                  tier: null,
                  authStatus: "authenticated",
                  duplicateOfProfileId: null,
                  ambientDriftNotice: null,
                },
                ambientColor,
              ),
              profileWithAccent(
                {
                  profileId: "managed-1",
                  kind: "managed",
                  label: "Work",
                  email: "work@example.test",
                  tier: "Pro",
                  authStatus: "authenticated",
                  duplicateOfProfileId: null,
                  ambientDriftNotice: null,
                },
                workColor,
              ),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Terminal account profile" }),
    );
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Unsaved name" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${staleColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Terminal account profile" }),
    );
    const reopenedNameInput = screen.getByLabelText("Profile name");
    if (!(reopenedNameInput instanceof HTMLInputElement)) {
      throw new Error("Expected profile name input");
    }
    expect(reopenedNameInput.value).toBe("Terminal account");
    expect(
      screen
        .getByRole("button", { name: `Use color ${ambientColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: `Use color ${staleColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));

    const nameInput = screen.getByLabelText("Profile name");
    if (!(nameInput instanceof HTMLInputElement)) {
      throw new Error("Expected profile name input");
    }
    expect(nameInput.value).toBe("Work");
    expect(
      screen
        .getByRole("button", { name: `Use color ${workColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: `Use color ${staleColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("starts a fresh editor session when the selected host changes with cached profile data", () => {
    const ambientColor = PROVIDER_PROFILE_ACCENT_COLORS[0];
    const state = {
      ...providerState({
        providerId: "codex",
        selected: { kind: "bundled" },
        candidates: [],
        envOverrides: [],
        profiles: [
          profileWithAccent(
            {
              profileId: "ambient",
              kind: "ambient",
              label: "Terminal account",
              email: "ambient@example.test",
              tier: null,
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            },
            ambientColor,
          ),
        ],
      }),
      loginCapability: { oauthArgs: ["auth", "login"], token: null },
    };
    const renderSection = (hostId: string): ReactNode => (
      <TooltipProvider>
        <ProviderProfileScopedSection
          state={state}
          hostId={hostId}
          isSelectedHostLocal
          canAddProfile
          failedAttempt={null}
          onAddProfile={vi.fn()}
          onDismissFailedAttempt={vi.fn()}
          selectedProfileId={null}
          onSelectedProfileIdChange={vi.fn()}
        />
      </TooltipProvider>
    );
    const { rerender } = render(renderSection("host-b"));

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Terminal account profile" }),
    );
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Host B draft" },
    });

    rerender(renderSection("host-c"));

    const nameInput = screen.getByLabelText("Profile name");
    if (!(nameInput instanceof HTMLInputElement)) {
      throw new Error("Expected profile name input");
    }
    expect(nameInput.value).toBe("Terminal account");
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(providerMocks.renameProfileMutate).not.toHaveBeenCalled();
  });

  it("resets the add-profile draft when it is reopened", () => {
    const ambientColor = PROVIDER_PROFILE_ACCENT_COLORS[0];
    const availableColor = PROVIDER_PROFILE_ACCENT_COLORS[1];
    const staleColor = PROVIDER_PROFILE_ACCENT_COLORS[4];
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profileWithAccent(
                {
                  profileId: "ambient",
                  kind: "ambient",
                  label: "Terminal account",
                  email: "ambient@example.test",
                  tier: null,
                  authStatus: "authenticated",
                  duplicateOfProfileId: null,
                  ambientDriftNotice: null,
                },
                ambientColor,
              ),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Unsaved profile" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${staleColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    const nameInput = screen.getByLabelText("Profile name");
    if (!(nameInput instanceof HTMLInputElement)) {
      throw new Error("Expected profile name input");
    }
    expect(nameInput.value).toBe("New profile");
    expect(
      screen
        .getByRole("button", { name: `Use color ${availableColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: `Use color ${staleColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("renders profile rows with duplicate, drift, and unauthenticated states", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "codex",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          profiles: [
            profile({
              profileId: "ambient",
              kind: "ambient",
              label: "Terminal account",
              email: "current@example.test",
              tier: "Pro",
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: {
                previousEmail: "previous@example.test",
                changedAt: 100,
              },
            }),
            profile({
              profileId: "managed-1",
              kind: "managed",
              label: "Work",
              email: "current@example.test",
              tier: "Team",
              authStatus: "authenticated",
              duplicateOfProfileId: "ambient",
              ambientDriftNotice: null,
            }),
            profile({
              profileId: "managed-2",
              kind: "managed",
              label: "Signed out",
              email: null,
              tier: null,
              authStatus: "unauthenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // Defaults to the ambient profile and shows its persisted label, along
    // with its drift notice, tier, and redacted email.
    expect(screen.getAllByText("Terminal account").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        // Drift notice redacts both emails - "current@example.test" ->
        // "c•••@e…", "previous@example.test" -> "p•••@e…".
        "Terminal account is now c•••@e…; was p•••@e….",
      ),
    ).toBeDefined();
    expect(screen.getByText("Pro")).toBeDefined();
    // The identity line redacts the email by default (reveal toggle tested
    // separately) - "current@example.test" -> "c•••@e…".
    expect(screen.getAllByText("c•••@e…").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss ambient account change notice",
      }),
    );
    expect(
      screen.queryByText("Terminal account is now c•••@e…; was p•••@e…."),
    ).toBeNull();

    // Select "Work" - its own duplicate-account warning and tier.
    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(screen.getByText("Same account as Terminal account")).toBeDefined();
    expect(screen.getByText("Team")).toBeDefined();

    // Select "Signed out" - its own unauthenticated status.
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Signed out, Signed out" }),
    );
    expect(screen.getAllByText("Signed out").length).toBeGreaterThan(0);
  });

  it("redacts a profile's email by default and reveals it on toggle", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "codex",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          profiles: [
            profile({
              profileId: "ambient",
              kind: "ambient",
              label: "Terminal account",
              email: null,
              tier: null,
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
            profile({
              profileId: "managed-1",
              kind: "managed",
              label: "Work",
              email: "alice@domain.com",
              tier: null,
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // Defaults to the ambient profile - select "Work" to bring its email
    // into view.
    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));

    expect(screen.getByText("a•••@d…")).toBeDefined();
    expect(screen.queryByText("alice@domain.com")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Reveal email for Work" }),
    );
    expect(screen.getByText("alice@domain.com")).toBeDefined();
    expect(screen.queryByText("a•••@d…")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Hide email for Work" }),
    );
    expect(screen.getByText("a•••@d…")).toBeDefined();
    expect(screen.queryByText("alice@domain.com")).toBeNull();
  });

  it("starts a managed-profile login then awaits the returned profile id", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    const [startVariables, startOptions] = firstStartLoginCall();
    expect(startVariables).toEqual({
      providerId: "codex",
      profileId: null,
      createProfile: { label: "New profile", shareSkillsAndPlugins: false },
    });
    expect(typeof startOptions.onSuccess).toBe("function");

    startOptions.onSuccess({
      url: "https://login.example.test",
      started: true,
      profileId: "managed-1",
    });

    const [awaitVariables, awaitOptions] = firstAwaitLoginCall();
    expect(awaitVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
    });
    expect(typeof awaitOptions.onSuccess).toBe("function");
  });

  it("keeps a cancelled profile creation mounted until its minted id is cleaned up", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    const [, startOptions] = firstStartLoginCall();

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));

    expect(providerMocks.cancelLoginMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add profile" })).toBeDefined();
    expect(screen.getByText("Cancelling sign-in")).toBeDefined();

    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-pending",
      });
    });

    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "managed-pending",
    });
    expect(providerMocks.awaitLoginMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Add profile" })).toBeNull();
  });

  it("cancels a waiting managed-profile login exactly once", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    const [, startOptions] = firstStartLoginCall();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));

    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "managed-1",
    });
  });

  it("cancels the known re-auth profile while its initial start is pending", async () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
              profile({
                profileId: "managed-1",
                kind: "managed",
                label: "Work",
                email: "work@example.test",
                tier: "Pro",
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
    });
    const [, startOptions] = firstStartLoginCall();

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));

    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "managed-1",
    });
    expect(screen.queryByText("Switching account")).toBeNull();

    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.awaitLoginMutate).not.toHaveBeenCalled();
  });

  it("cancels the known re-auth profile while a retry start is pending", async () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
              profile({
                profileId: "managed-1",
                kind: "managed",
                label: "Work",
                email: "work@example.test",
                tier: "Pro",
                authStatus: "unauthenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work, Signed out" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
    });
    const [, initialStartOptions] = firstStartLoginCall();
    act(() => initialStartOptions.onError());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(2);
    const retryCall = providerMocks.startLoginMutate.mock.calls.at(1);
    if (retryCall === undefined) throw new Error("Expected retry login call.");

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));

    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "managed-1",
    });
    act(() => {
      retryCall[1].onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.awaitLoginMutate).not.toHaveBeenCalled();
  });

  it("signs in again for an existing profile, states when a different account was applied, and can cancel the restart", async () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
              profile({
                profileId: "managed-1",
                kind: "managed",
                label: "Work",
                email: "work@example.test",
                tier: "Pro",
                authStatus: "unauthenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // Defaults to the ambient profile - select "Work" (signed out) first.
    fireEvent.click(screen.getByRole("menuitem", { name: "Work, Signed out" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeDefined();
    expect(screen.getByLabelText("Profile name")).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Cancel sign-in" }),
    ).toBeDefined();
    const [startVariables, startOptions] = firstStartLoginCall();
    expect(startVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
      createProfile: null,
    });

    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    const [awaitVariables, awaitOptions] = firstAwaitLoginCall();
    expect(awaitVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
    });
    act(() => {
      awaitOptions.onSuccess({
        state: {
          profiles: [
            profile({
              profileId: "managed-1",
              kind: "managed",
              label: "Work",
              email: "personal@example.test",
              tier: "Pro",
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        },
      });
    });

    expect(
      screen.getByText((content) =>
        content.includes(
          `Work is now signed in as ${redactEmail("personal@example.test")} ` +
            `(was ${redactEmail("work@example.test")})`,
        ),
      ),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Keep new account" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(2);
    });
    const retryCall = providerMocks.startLoginMutate.mock.calls.at(1);
    if (retryCall === undefined) {
      throw new Error("Expected retry start login call.");
    }
    expect(retryCall[0]).toEqual({
      providerId: "codex",
      profileId: "managed-1",
      createProfile: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "managed-1",
    });

    act(() => {
      retryCall[1].onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(1);
  });

  it("does not show a stale identity step after cancelling a re-auth during waiting and reopening", async () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
              profile({
                profileId: "managed-1",
                kind: "managed",
                label: "Work",
                email: "work@example.test",
                tier: "Pro",
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    const [, startOptions] = firstStartLoginCall();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    const [, awaitOptions] = firstAwaitLoginCall();

    // Cancel while still on the waiting step.
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);

    // Cancelling kills the host's login child, which makes the in-flight
    // awaitLogin resolve (not reject) - simulate that late resolution racing
    // the inline flow's unmount.
    act(() => {
      awaitOptions.onSuccess({
        state: {
          profiles: [
            profile({
              profileId: "managed-1",
              kind: "managed",
              label: "Work",
              email: "work@example.test",
              tier: "Pro",
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        },
      });
    });

    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    expect(screen.queryByText("Signed in as")).toBeNull();
    expect(screen.getByText("Waiting for browser sign-in")).toBeDefined();
  });

  it("does not offer the share-skills-and-plugins checkbox for a provider without the overlay mechanism (codex)", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    expect(screen.queryByText("Use terminal skills and plugins")).toBeNull();
  });

  it("offers the share-skills-and-plugins checkbox for claude, on by default, and lets users opt out", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "claude-code",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    const checkbox = screen.getByRole("checkbox", {
      name: "Use terminal account skills and plugins",
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Use terminal skills and plugins")).toBeDefined();

    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    const [startVariables] = firstStartLoginCall();
    expect(startVariables).toEqual({
      providerId: "claude-code",
      profileId: null,
      createProfile: { label: "New profile", shareSkillsAndPlugins: false },
    });
  });

  it("forwards Claude profile skills-and-plugins sharing by default", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "claude-code",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    const [startVariables] = firstStartLoginCall();
    expect(startVariables).toEqual({
      providerId: "claude-code",
      profileId: null,
      createProfile: { label: "New profile", shareSkillsAndPlugins: true },
    });
  });

  it("does not create a second profile when the linked account already exists", async () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    const [, startOptions] = firstStartLoginCall();
    startOptions.onSuccess({
      url: "https://login.example.test",
      started: true,
      profileId: "managed-1",
    });

    const [, awaitOptions] = firstAwaitLoginCall();
    awaitOptions.onSuccess({
      state: {
        profiles: [
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Terminal account",
            email: "ambient@example.test",
            tier: null,
            authStatus: "authenticated",
            duplicateOfProfileId: null,
            ambientDriftNotice: null,
          }),
        ],
      },
      existingProfileId: "ambient",
    });

    await waitFor(() => {
      expect(screen.getByText("Account already linked")).toBeDefined();
    });
    expect(
      screen.getByText(
        "This account is already linked to Terminal account. No new profile was created.",
      ),
    ).toBeDefined();
    expect(providerMocks.recolorProfileMutate).not.toHaveBeenCalled();
    expect(providerMocks.removeProfileMutate).not.toHaveBeenCalled();
  });

  it("warns when the selected accent color is already used by the ambient terminal account", () => {
    const ambientColor = PROVIDER_PROFILE_ACCENT_COLORS[0];
    const ambient = profileWithAccent(
      {
        profileId: "ambient",
        kind: "ambient",
        label: "Terminal account",
        email: "ambient@example.test",
        tier: null,
        authStatus: "authenticated",
        duplicateOfProfileId: null,
        ambientDriftNotice: null,
      },
      ambientColor,
    );
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [ambient],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    const ambientColorButton = screen.getByRole("button", {
      name: `Use color ${ambientColor}`,
    });
    expect(ambientColorButton.className).toContain("rounded-full");
    expect(ambientColorButton.className).toContain("size-6");
    fireEvent.click(ambientColorButton);

    expect(
      screen.getByText(
        "Terminal account already uses this color. You can keep it, but matching colors may be harder to scan.",
      ),
    ).toBeDefined();
  });

  it("renders the plan-tier badge once even when the host's auth badge text repeats it", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "codex",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          profiles: [
            {
              profileId: "managed-1",
              kind: "managed",
              authType: "oauth",
              label: "Work",
              auth: {
                status: "authenticated",
                badgeText: "ChatGPT Pro 20x Subscription",
                label: null,
                detail: null,
              },
              identity: {
                email: "work@example.test",
                tier: "ChatGPT Pro 20x Subscription",
                accountUuid: null,
              },
              usageUpdatedAt: null,
              rateLimitStatus: "unknown",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
              accentColor: null,
            },
          ],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getAllByText("ChatGPT Pro 20x Subscription").length).toBe(1);
  });

  it("renames and confirms removal through the profile row controls", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "codex",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          profiles: [
            profile({
              profileId: "ambient",
              kind: "ambient",
              label: "Terminal account",
              email: "ambient@example.test",
              tier: null,
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
            profile({
              profileId: "managed-1",
              kind: "managed",
              label: "Work",
              email: "work@example.test",
              tier: null,
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // Defaults to the ambient profile - select "Work" to bring its editable
    // details dialog (name field, actions) into view.
    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const [renameVariables, renameOptions] = firstRenameProfileCall();
    expect(renameVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
      label: "Personal",
    });
    expect(typeof renameOptions.onSuccess).toBe("function");
    act(() => renameOptions.onSuccess());

    fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));
    expect(
      screen.getByText(
        "Chats that ran on Work will show it as removed. Running sessions on this profile must be stopped first.",
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByTestId("confirm-action"));

    const [removeVariables, removeOptions] = firstRemoveProfileCall();
    expect(removeVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
    });
    expect(typeof removeOptions.onSuccess).toBe("function");
  });

  it("automatically finalizes the chosen color after account linking", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Work" },
    });
    const selectedColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${selectedColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    expect(firstStartLoginCall()[0]).toEqual({
      providerId: "codex",
      profileId: null,
      createProfile: {
        label: "Work",
        shareSkillsAndPlugins: false,
      },
    });

    const [, startOptions] = firstStartLoginCall();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        state: {
          profiles: [
            profile({
              profileId: "managed-1",
              kind: "managed",
              label: "Work",
              email: "alice@domain.com",
              tier: null,
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        },
        existingProfileId: null,
      });
    });

    const [recolorVariables, recolorOptions] = firstRecolorProfileCall();
    expect(recolorVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
      accentColor: selectedColor,
    });
    act(() => recolorOptions.onSuccess());

    expect(providerMocks.removeProfileMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Add profile" })).toBeNull();
  });

  it("closes immediately when the host already assigned the chosen color", () => {
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [
              profile({
                profileId: "ambient",
                kind: "ambient",
                label: "Terminal account",
                email: "ambient@example.test",
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              }),
            ],
          }),
          loginCapability: { oauthArgs: ["auth", "login"], token: null },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    const [, startOptions] = firstStartLoginCall();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });
    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        state: {
          profiles: [
            profileWithAccent(
              {
                profileId: "managed-1",
                kind: "managed",
                label: "New profile",
                email: null,
                tier: null,
                authStatus: "authenticated",
                duplicateOfProfileId: null,
                ambientDriftNotice: null,
              },
              PROVIDER_PROFILE_ACCENT_COLORS[0],
            ),
          ],
        },
        existingProfileId: null,
      });
    });

    expect(providerMocks.recolorProfileMutate).not.toHaveBeenCalled();
    expect(providerMocks.removeProfileMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Add profile" })).toBeNull();
  });
});
