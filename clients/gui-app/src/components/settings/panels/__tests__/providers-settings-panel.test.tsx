import "../../../../../__tests__/test-browser-apis";
import type {
  ProviderAuth,
  ProviderCliCandidate,
  ProviderCliState,
  ProviderProfile,
  ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import {
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
  readonly profileId: string | null;
};
type StartLoginOptions = {
  readonly onSuccess: (data: StartLoginData) => void;
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
  readonly onSettled: () => void;
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
  removeProfileMutate: vi.fn<RemoveProfileMutate>(),
  refreshProviders: vi.fn(() => Promise.resolve()),
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

vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => ({
  useProvidersStartLogin: () => ({
    mutate: providerMocks.startLoginMutate,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => ({
  useHostScopedProvidersAwaitLogin: () => ({
    mutate: providerMocks.awaitLoginMutate,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => ({
  useProvidersCancelLogin: () => ({
    mutate: providerMocks.cancelLoginMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => ({
    mutate: providerMocks.renameProfileMutate,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: providerMocks.removeProfileMutate,
    isPending: false,
    error: null,
  }),
}));

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

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

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

function profile(input: {
  readonly profileId: string;
  readonly kind: ProviderProfile["kind"];
  readonly label: string;
  readonly email: string | null;
  readonly tier: string | null;
  readonly authStatus: ProviderProfile["auth"]["status"];
  readonly duplicateOfProfileId: string | null;
  readonly ambientDriftNotice: ProviderProfile["ambientDriftNotice"];
}): ProviderProfile {
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
    accentColor: null,
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
    providerMocks.removeProfileMutate.mockReset();
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
              label: "Ambient",
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

    expect(screen.getByText("Profiles")).toBeDefined();
    expect(screen.getAllByText("Terminal account").length).toBeGreaterThan(0);
    // The identity line redacts the email by default (reveal toggle tested
    // separately) - "current@example.test" -> "c•••@e…".
    expect(screen.getAllByText("c•••@e…").length).toBeGreaterThan(0);
    expect(screen.getByText("Pro")).toBeDefined();
    expect(screen.getByText("Same account as Terminal account")).toBeDefined();
    expect(
      screen.getByText(
        // Drift notice redacts both emails - "current@example.test" ->
        // "c•••@e…", "previous@example.test" -> "p•••@e…".
        "Terminal account is now c•••@e…; was p•••@e….",
      ),
    ).toBeDefined();
    expect(screen.getByText("Not authenticated")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss terminal account change notice",
      }),
    );

    expect(
      screen.queryByText(
        // Drift notice redacts both emails - "current@example.test" ->
        // "c•••@e…", "previous@example.test" -> "p•••@e…".
        "Terminal account is now c•••@e…; was p•••@e….",
      ),
    ).toBeNull();
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
              label: "Ambient",
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
                label: "Ambient",
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
    fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));

    const [startVariables, startOptions] = firstStartLoginCall();
    expect(startVariables).toEqual({
      providerId: "codex",
      profileId: null,
      createProfile: { label: "Profile 2", shareSkillsAndPlugins: false },
    });
    expect(typeof startOptions.onSuccess).toBe("function");

    startOptions.onSuccess({
      url: "https://login.example.test",
      profileId: "managed-1",
    });

    const [awaitVariables, awaitOptions] = firstAwaitLoginCall();
    expect(awaitVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
    });
    expect(typeof awaitOptions.onSuccess).toBe("function");
    expect(typeof awaitOptions.onSettled).toBe("function");
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
                label: "Ambient",
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
    expect(screen.queryByText("Share skills and plugins")).toBeNull();
  });

  it("offers the share-skills-and-plugins checkbox for claude, off by default, and forwards it once checked", () => {
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
                label: "Ambient",
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
    const checkbox = screen.getByRole("checkbox", {
      name: "Share skills and plugins with the terminal account",
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));

    const [startVariables] = firstStartLoginCall();
    expect(startVariables).toEqual({
      providerId: "claude-code",
      profileId: null,
      createProfile: { label: "Profile 2", shareSkillsAndPlugins: true },
    });
  });

  it("redacts the newly created profile's email in the sign-in success message", async () => {
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
                label: "Ambient",
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
    fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));

    const [, startOptions] = firstStartLoginCall();
    startOptions.onSuccess({
      url: "https://login.example.test",
      profileId: "managed-1",
    });

    const [, awaitOptions] = firstAwaitLoginCall();
    awaitOptions.onSuccess({
      state: {
        profiles: [
          {
            profileId: "managed-1",
            identity: {
              email: "alice@domain.com",
              tier: null,
              accountUuid: null,
            },
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("a•••@d…")).toBeDefined();
    });
    expect(screen.queryByText("alice@domain.com")).toBeNull();
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
              label: "Ambient",
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

    fireEvent.click(screen.getByRole("button", { name: "Rename Work" }));
    fireEvent.change(screen.getByDisplayValue("Work"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile name" }));

    const [renameVariables, renameOptions] = firstRenameProfileCall();
    expect(renameVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
      label: "Personal",
    });
    expect(typeof renameOptions.onSuccess).toBe("function");

    fireEvent.click(screen.getByRole("button", { name: "Remove Work" }));
    fireEvent.click(screen.getByTestId("confirm-action"));

    const [removeVariables, removeOptions] = firstRemoveProfileCall();
    expect(removeVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
    });
    expect(typeof removeOptions.onSuccess).toBe("function");
  });
});
