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

type SubmitLoginCodeVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string | null;
  readonly code: string;
};
type SubmitLoginCodeOptions = {
  readonly onSuccess: (data: {
    readonly outcome: "accepted" | "noActiveLogin";
  }) => void;
  readonly onError: () => void;
};
type SubmitLoginCodeMutate = (
  variables: SubmitLoginCodeVariables,
  options: SubmitLoginCodeOptions,
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
    error: undefined as { message: string; code: string } | undefined,
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
  cancelLoginPending: false,
  submitLoginCodeMutate: vi.fn<SubmitLoginCodeMutate>(),
  submitLoginCodeReset: vi.fn(),
  submitLoginCodePending: false,
  submitLoginCodeSuccess: false,
  submitLoginCodeData: undefined as
    { readonly outcome: "accepted" | "noActiveLogin" } | undefined,
  submitLoginCodeError: null as Error | null,
  touchLoginMutate: vi.fn(),
  touchLoginReset: vi.fn(),
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
    isPending: providerMocks.cancelLoginPending,
  });
  return {
    useProvidersCancelLogin,
    useProvidersCancelLoginForClient: useProvidersCancelLogin,
  };
});

vi.mock("@/hooks/providers/use-providers-submit-login-code-mutation", () => {
  const useProvidersSubmitLoginCode = () => ({
    mutate: providerMocks.submitLoginCodeMutate,
    isPending: providerMocks.submitLoginCodePending,
    isSuccess: providerMocks.submitLoginCodeSuccess,
    data: providerMocks.submitLoginCodeData,
    error: providerMocks.submitLoginCodeError,
    reset: providerMocks.submitLoginCodeReset,
  });
  return {
    useProvidersSubmitLoginCode,
    useProvidersSubmitLoginCodeForClient: useProvidersSubmitLoginCode,
  };
});

vi.mock("@/hooks/providers/use-providers-touch-login-mutation", () => {
  const useProvidersTouchLogin = () => ({
    mutate: providerMocks.touchLoginMutate,
    isPending: false,
    error: null,
    reset: providerMocks.touchLoginReset,
  });
  return {
    useProvidersTouchLogin,
    useProvidersTouchLoginForClient: useProvidersTouchLogin,
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

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({
    mutate: providerMocks.openExternalLink,
  }),
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
import {
  AMBIENT_AUTH_PENDING_REPOLL_CAP,
  AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS,
} from "@/components/settings/panels/use-provider-profile-login-flow";
import { TooltipProvider } from "@/components/ui/tooltip";
import { redactEmail } from "@/lib/providers/redact-email";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";

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
    rateLimitLimitedScopes: null,
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

function firstSubmitLoginCodeCall(): readonly [
  SubmitLoginCodeVariables,
  SubmitLoginCodeOptions,
] {
  const call = providerMocks.submitLoginCodeMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected submit login code call.");
  return call;
}

function codePasteReauthProviderState(): ProviderCliState {
  return {
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
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      codePaste: {},
    },
  };
}

/**
 * An `awaitLogin` response for the ambient row taken while the host's auth
 * probe is still in flight: the login runner evicts the ambient auth-cache
 * entry when the login child closes, so the row can read non-definitive with
 * `authPending` set even though the sign-in landed. The flow must treat this
 * as unsettled, never as a failed sign-in.
 */
function pendingAmbientAwaitResponse(): unknown {
  return {
    codeRejected: false,
    existingProfileId: null,
    state: {
      authPending: true,
      auth: {
        status: "unknown",
        badgeText: null,
        label: null,
        detail: null,
      },
      profiles: [
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
          email: null,
          tier: null,
          authStatus: "unknown",
          duplicateOfProfileId: null,
          ambientDriftNotice: null,
        }),
      ],
    },
  };
}

function codePasteCreateProviderState(): ProviderCliState {
  return {
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
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      codePaste: {},
    },
  };
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
    providerMocks.listResult.isError = false;
    providerMocks.listResult.error = undefined;
    providerMocks.setSelectionMutate.mockClear();
    providerMocks.setEnabledMutate.mockClear();
    providerMocks.setEnvOverrideMutate.mockClear();
    providerMocks.deleteEnvOverrideMutate.mockClear();
    providerMocks.startLoginMutate.mockReset();
    providerMocks.awaitLoginMutate.mockReset();
    providerMocks.cancelLoginMutate.mockReset();
    providerMocks.cancelLoginPending = false;
    providerMocks.submitLoginCodeMutate.mockReset();
    providerMocks.submitLoginCodePending = false;
    providerMocks.submitLoginCodeSuccess = false;
    providerMocks.submitLoginCodeData = undefined;
    providerMocks.submitLoginCodeError = null;
    providerMocks.submitLoginCodeMutate.mockImplementation(() => {
      providerMocks.submitLoginCodePending = true;
      providerMocks.submitLoginCodeSuccess = false;
      providerMocks.submitLoginCodeData = undefined;
      providerMocks.submitLoginCodeError = null;
    });
    providerMocks.submitLoginCodeReset.mockReset();
    providerMocks.submitLoginCodeReset.mockImplementation(() => {
      providerMocks.submitLoginCodePending = false;
      providerMocks.submitLoginCodeSuccess = false;
      providerMocks.submitLoginCodeData = undefined;
      providerMocks.submitLoginCodeError = null;
    });
    providerMocks.touchLoginMutate.mockReset();
    providerMocks.touchLoginReset.mockClear();
    providerMocks.openExternalLink.mockClear();
    providerMocks.renameProfileMutate.mockReset();
    providerMocks.recolorProfileMutate.mockReset();
    providerMocks.removeProfileMutate.mockReset();
    providerMocks.refreshProviders.mockClear();
    providerMocks.refreshUsageLimits.mockClear();
    useProvidersFocusStore.getState().clearFocusHarnessId();
  });

  afterEach(() => {
    // Unconditional and before `cleanup()`: the ambient re-poll tests opt into
    // fake timers mid-test, and a leaked fake clock would strand every later
    // test's timers (and Testing Library's own unmount work).
    vi.useRealTimers();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("gates the provider-list-error report action on capability and never forwards the raw host error", () => {
    providerMocks.listResult.isError = true;
    providerMocks.listResult.error = {
      message: "secret-token-should-never-render",
      code: "RPC_ERROR",
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByText(/secret-token-should-never-render/)).toBeNull();
    // Capability-gated off by default.
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load provider state",
        message: null,
        code: "RPC_ERROR",
        source: "Providers",
      },
    });
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: "Codex profile: Terminal account, Terminal",
      }),
    ).toBeDefined();
    const terminalProfileRow = screen.getByRole("menuitem", {
      name: "Terminal account, Terminal",
    });
    expect(
      within(terminalProfileRow).getByText("Terminal", {
        selector: '[data-slot="badge"]',
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    ).toBeDefined();
    const addProfileButton = screen.getByRole("button", {
      name: "Add profile",
    });
    expect(addProfileButton.getAttribute("data-variant")).toBe("outline");
    expect(addProfileButton.getAttribute("data-size")).toBe("xs");
    expect(screen.getByText("Profiles")).toBeDefined();
    const manageProfileButton = screen.getByRole("button", {
      name: "Manage profile",
    });
    expect(manageProfileButton.getAttribute("data-variant")).toBe("outline");
    expect(manageProfileButton.getAttribute("data-size")).toBe("xs");
    const profileSummaryActions = manageProfileButton.closest(".flex-wrap");
    if (!(profileSummaryActions instanceof HTMLElement)) {
      throw new Error("Expected profile summary and actions row");
    }
    expect(within(profileSummaryActions).getByText("No plan")).toBeDefined();
    fireEvent.focus(manageProfileButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Change the profile name and accent color, sign in again, or remove this profile.",
    );
    fireEvent.click(manageProfileButton);
    const editProfileDialog = screen.getByRole("dialog", {
      name: "Edit profile",
    });
    const removeProfileButton = within(editProfileDialog).getByRole("button", {
      name: /Remove profile/,
    });
    if (!(removeProfileButton instanceof HTMLButtonElement)) {
      throw new Error("Expected remove profile button");
    }
    expect(removeProfileButton.disabled).toBe(true);
    expect(
      within(editProfileDialog).queryByText("Terminal", {
        selector: '[data-slot="badge"]',
      }),
    ).toBeNull();
    const removeProfileTooltipTrigger = removeProfileButton.parentElement;
    if (!(removeProfileTooltipTrigger instanceof HTMLElement)) {
      throw new Error("Expected remove profile tooltip trigger");
    }
    const removeProfileDisabledReason =
      "This profile uses your default CLI login and cannot be removed.";
    expect(removeProfileTooltipTrigger.title).toBe(removeProfileDisabledReason);
    expect(removeProfileButton.getAttribute("aria-label")).toBe(
      `Remove profile. ${removeProfileDisabledReason}`,
    );
    fireEvent.click(
      within(editProfileDialog).getByRole("button", { name: "Cancel" }),
    );
    expect(
      screen.queryByRole("button", { name: "Refresh usage limits" }),
    ).toBeNull();

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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Unsaved name" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${staleColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));

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
      loginCapability: {
        oauthArgs: ["auth", "login"],
        token: null,
        codePaste: null,
      },
    };
    const renderSection = (hostId: string): ReactNode => (
      <TooltipProvider>
        <ProviderProfileScopedSection
          state={state}
          hostId={hostId}
          isSelectedHostLocal
          canAddProfile
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={vi.fn()}
          onDismissFailedAttempt={vi.fn()}
          selectedProfileId={null}
          onSelectedProfileIdChange={vi.fn()}
        />
      </TooltipProvider>
    );
    const { rerender } = render(renderSection("host-b"));

    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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

  it("does not render the paste field until the flow reaches waiting (fixup review finding 2)", () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: {},
          },
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

    // Still `starting` - `startLogin` hasn't resolved yet, so there is no
    // profileId/child for a paste to reach. The field must not render (a
    // paste here would silently lock the field without ever being sent).
    expect(screen.queryByLabelText("Paste the code")).toBeNull();

    const [, startOptions] = firstStartLoginCall();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    // Now `waiting` - the field appears.
    expect(screen.getByLabelText("Paste the code")).toBeDefined();
  });

  it("does not resubmit when Enter is pressed after an auto-submitted paste locks the field (fixup review finding 4)", () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: {},
          },
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

    const input = screen.getByLabelText("Paste the code");

    // The browser is the primary path and code paste is a visible fallback,
    // never a numbered second step.
    expect(screen.getByText("Didn't return automatically?")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open browser again" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open browser again" }));
    expect(providerMocks.openExternalLink).toHaveBeenCalledWith(
      "https://login.example.test",
    );

    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });
    expect(providerMocks.submitLoginCodeMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.submitLoginCodeMutate).toHaveBeenCalledWith(
      { providerId: "codex", profileId: "managed-1", code: "abc123#xyz789" },
      expect.anything(),
    );

    // The field is now locked/masked from the auto-submit - Enter must not
    // fire a second, duplicate submit.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(providerMocks.submitLoginCodeMutate).toHaveBeenCalledTimes(1);
  });

  it("resets the submit mutation state on every fresh attempt so a restart never renders the previous attempt's error (statefulness fixup)", async () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: {},
          },
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
    // A rejected code drives a restart - the underlying mutation objects
    // must be reset before the fresh attempt's field ever renders, or the
    // remounted (key-changed) field would still show the previous attempt's
    // stale error/pending state off the shared mutation.
    act(() => {
      awaitOptions.onSuccess({ codeRejected: true });
    });

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(2);
    });
    // Reset fires on every fresh attempt (the initial one and the restart),
    // so two `startLogin` calls means two resets.
    expect(providerMocks.submitLoginCodeReset).toHaveBeenCalledTimes(2);
    expect(providerMocks.touchLoginReset).toHaveBeenCalledTimes(2);
  });

  it("locks the field while submitting, then shows a verifying header once the relay is accepted and the exchange is still pending (statefulness fixup)", () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: {},
          },
        },
      ],
    };

    const view = render(
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

    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    // The real mutation subscription rerenders the parent. The lightweight
    // mock stores its flags outside React, so explicitly replay that render.
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // "submitting": mutation.isPending locks the field immediately and owns
    // the visible status.
    expect(input).toHaveProperty("readOnly", true);
    expect(screen.getByText("Sending the code…")).toBeDefined();

    const [, submitOptions] = firstSubmitLoginCodeCall();
    act(() => {
      providerMocks.submitLoginCodePending = false;
      providerMocks.submitLoginCodeSuccess = true;
      providerMocks.submitLoginCodeData = { outcome: "accepted" };
      submitOptions.onSuccess({ outcome: "accepted" });
    });
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // "verifying": the relay succeeded, but `awaitLogin` hasn't settled this
    // attempt yet - the real exchange window `submitPending` alone never
    // covered. The header must say so instead of still claiming to be
    // waiting on the browser.
    expect(screen.getByText("Checking approval…")).toBeDefined();
    expect(input).toHaveProperty("readOnly", true);
    expect(
      screen.queryByRole("button", { name: "Open browser again" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Cancel sign-in" }),
    ).toHaveProperty("disabled", true);

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(providerMocks.cancelLoginMutate).not.toHaveBeenCalled();
  });

  it("keeps cancellation and dismissal available when no login child accepted the code", () => {
    providerMocks.listResult.data = {
      providers: [codePasteCreateProviderState()],
    };
    const view = render(
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

    fireEvent.paste(screen.getByLabelText("Paste the code"), {
      clipboardData: { getData: () => "abc123#xyz789" },
    });
    const [, submitOptions] = firstSubmitLoginCodeCall();
    act(() => {
      providerMocks.submitLoginCodePending = false;
      providerMocks.submitLoginCodeSuccess = true;
      providerMocks.submitLoginCodeData = { outcome: "noActiveLogin" };
      submitOptions.onSuccess({ outcome: "noActiveLogin" });
    });
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByText("Checking approval…")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Cancel sign-in" }),
    ).toHaveProperty("disabled", false);

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("submits exactly once when a retry paste is followed by Enter before the pending render", () => {
    providerMocks.listResult.data = {
      providers: [codePasteCreateProviderState()],
    };
    const view = render(
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

    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "first-code#first-state" },
    });
    const [, firstSubmitOptions] = firstSubmitLoginCodeCall();
    act(() => {
      providerMocks.submitLoginCodePending = false;
      providerMocks.submitLoginCodeSuccess = false;
      providerMocks.submitLoginCodeData = undefined;
      providerMocks.submitLoginCodeError = new Error("relay failed");
      firstSubmitOptions.onError();
    });
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const retryInput = screen.getByLabelText("Paste the code");
    fireEvent.paste(retryInput, {
      clipboardData: { getData: () => "retry-code#retry-state" },
    });
    fireEvent.keyDown(retryInput, { key: "Enter" });

    expect(providerMocks.submitLoginCodeMutate).toHaveBeenCalledTimes(2);
    expect(providerMocks.submitLoginCodeMutate.mock.calls[1]?.[0]).toEqual({
      providerId: "codex",
      profileId: "managed-1",
      code: "retry-code#retry-state",
    });
  });

  it("shows the Cancel button's pending state per the AGENTS.md recipe (disabled, unchanged label, inline spinner)", () => {
    providerMocks.cancelLoginPending = true;
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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

    const cancelButton = screen.getByRole("button", { name: "Cancel sign-in" });
    // Never a swapped label - "Cancel" stays exactly as-is, just disabled
    // with an inline spinner alongside it while the mutation is pending.
    expect(cancelButton.textContent).toContain("Cancel");
    expect(cancelButton).toHaveProperty("disabled", true);
  });

  it("proceeds to identity when awaitLogin succeeds after an earlier noActiveLogin submit response (fixup review finding 1, submit-first ordering)", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    const view = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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

    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Cancel sign-in" }),
    ).toHaveProperty("disabled", true);

    const [, submitOptions] = firstSubmitLoginCodeCall();
    const [, awaitOptions] = firstAwaitLoginCall();

    // The submit response says no active login for this child...
    act(() => submitOptions.onSuccess({ outcome: "noActiveLogin" }));
    // ...but the in-flight `awaitLogin` re-probe is authoritative and finds
    // the profile signed in - it must win over the earlier `noActiveLogin`.
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

    expect(screen.getByText("Signed in as")).toBeDefined();
    // No restart fired off the earlier `noActiveLogin` - still exactly one
    // `startLogin` call for the whole flow.
    expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
  });

  it("keeps an authenticated profile result terminal even when awaitLogin also reports codeRejected", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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

    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    const [, submitOptions] = firstSubmitLoginCodeCall();
    const [, awaitOptions] = firstAwaitLoginCall();

    // `awaitLogin` resolves successfully first.
    act(() => {
      awaitOptions.onSuccess({
        codeRejected: true,
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
    expect(screen.getByText("Signed in as")).toBeDefined();

    // A late submit result cannot undo the already-terminal authenticated
    // verdict either.
    act(() => submitOptions.onSuccess({ outcome: "noActiveLogin" }));

    expect(screen.getByText("Signed in as")).toBeDefined();
    expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
  });

  it("re-polls awaitLogin instead of failing when the ambient row is still authPending after the login completes (terminal-account switch)", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Terminal account, Terminal" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    const [startVariables, startOptions] = firstStartLoginCall();
    expect(startVariables).toEqual({
      providerId: "codex",
      profileId: "ambient",
      createProfile: null,
    });
    // From here on the re-poll's timer is the only thing being waited on -
    // drive it deterministically instead of sleeping out the real delay.
    vi.useFakeTimers();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "ambient",
      });
    });

    // The sign-in landed, but the host assembled the response right after
    // the login runner evicted the ambient auth-cache entry: the ambient row
    // reads non-definitive with the probe still in flight (`authPending`).
    // That must resolve as "not settled yet" - never as a failed sign-in.
    const [awaitVariables, awaitOptions] = firstAwaitLoginCall();
    expect(awaitVariables).toEqual({
      providerId: "codex",
      profileId: "ambient",
    });
    act(() => {
      awaitOptions.onSuccess(pendingAmbientAwaitResponse());
    });

    expect(screen.queryByText("Sign-in did not finish. Try again.")).toBeNull();

    // The bounded re-poll fires after its short delay; its re-probed state
    // is authoritative and resolves the switch to the identity step.
    act(() => {
      vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
    });
    expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(2);
    const repollCall = providerMocks.awaitLoginMutate.mock.calls.at(1);
    if (repollCall === undefined) {
      throw new Error("Expected re-poll await login call.");
    }
    expect(repollCall[0]).toEqual({
      providerId: "codex",
      profileId: "ambient",
    });
    act(() => {
      repollCall[1].onSuccess({
        codeRejected: false,
        existingProfileId: null,
        state: {
          authPending: false,
          profiles: [
            profile({
              profileId: "ambient",
              kind: "ambient",
              label: "Terminal account",
              email: "personal@example.test",
              tier: null,
              authStatus: "authenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        },
      });
    });

    expect(screen.getByText("Signed in as")).toBeDefined();
    // Exactly one login child for the whole switch - re-polling never
    // restarts the OAuth flow.
    expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("ignores an in-flight ambient re-poll that resolves after the sign-in was cancelled", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Terminal account, Terminal" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    const [, startOptions] = firstStartLoginCall();
    vi.useFakeTimers();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "ambient",
      });
    });

    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess(pendingAmbientAwaitResponse());
    });

    // The re-poll is dispatched...
    act(() => {
      vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
    });
    expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(2);
    const repollCall = providerMocks.awaitLoginMutate.mock.calls.at(1);
    if (repollCall === undefined) {
      throw new Error("Expected re-poll await login call.");
    }

    // ...and the user cancels while it is still in flight. Clearing the timer
    // cannot recall an already-dispatched RPC, and cancelling leaves the
    // attempt id untouched, so the late resolution must be ignored outright -
    // otherwise it settles a cancelled attempt, and a still-pending verdict
    // would arm yet another re-poll for a sign-in the user already abandoned.
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "ambient",
    });

    act(() => {
      repollCall[1].onSuccess(pendingAmbientAwaitResponse());
    });

    // No third await: the cancelled attempt must not keep re-polling. Advanced
    // well past the delay so any scheduled tick would have fired.
    act(() => {
      vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS * 3);
    });
    expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(2);
    expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
  });

  it("stops re-polling when an in-flight ambient re-poll resolves after the flow unmounted", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    const view = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Terminal account, Terminal" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    const [, startOptions] = firstStartLoginCall();
    vi.useFakeTimers();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "ambient",
      });
    });

    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess(pendingAmbientAwaitResponse());
    });
    act(() => {
      vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
    });
    expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(2);
    const repollCall = providerMocks.awaitLoginMutate.mock.calls.at(1);
    if (repollCall === undefined) {
      throw new Error("Expected re-poll await login call.");
    }

    // The flow goes away with its re-poll still in flight - no cancel involved
    // (the in-chat banner unmounts on its own the moment its reauth gate
    // clears). Clearing the scheduled timer is not enough: the dispatched RPC
    // still resolves, and a still-pending verdict must not arm a fresh timer on
    // a dead hook.
    act(() => {
      view.unmount();
    });
    act(() => {
      repollCall[1].onSuccess(pendingAmbientAwaitResponse());
    });
    act(() => {
      vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS * 3);
    });

    expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(2);
  });

  it("fails after the ambient authPending re-poll budget is exhausted without a definitive verdict", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Terminal account, Terminal" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    const [, startOptions] = firstStartLoginCall();
    vi.useFakeTimers();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "ambient",
      });
    });

    // The initial await plus every budgeted re-poll keeps reporting the
    // probe as still pending - after the budget is spent the flow must land
    // on the ordinary not-finished failure instead of re-polling forever.
    for (
      let attempt = 0;
      attempt < AMBIENT_AUTH_PENDING_REPOLL_CAP + 1;
      attempt += 1
    ) {
      expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(attempt + 1);
      const awaitCall = providerMocks.awaitLoginMutate.mock.calls.at(attempt);
      if (awaitCall === undefined) {
        throw new Error("Expected await login call.");
      }
      act(() => {
        awaitCall[1].onSuccess(pendingAmbientAwaitResponse());
      });
      act(() => {
        vi.advanceTimersByTime(AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
      });
    }

    expect(
      screen.getByText("Sign-in did not finish. Try again."),
    ).toBeDefined();
    expect(providerMocks.awaitLoginMutate).toHaveBeenCalledTimes(
      AMBIENT_AUTH_PENDING_REPOLL_CAP + 1,
    );
    expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
  });

  it("restarts with a session-expired notice when awaitLogin also fails after a noActiveLogin submit response (fixup review finding 1, genuine restart)", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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

    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    const [, submitOptions] = firstSubmitLoginCodeCall();
    const [, awaitOptions] = firstAwaitLoginCall();

    act(() => submitOptions.onSuccess({ outcome: "noActiveLogin" }));
    // The await re-probe agrees no profile is signed in - restart, not a
    // generic failure, and with the session-expired notice, not the
    // rejected-code one.
    act(() => {
      awaitOptions.onSuccess({ state: { profiles: [] } });
    });

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(2);
    });
    const retryCall = providerMocks.startLoginMutate.mock.calls.at(1);
    if (retryCall === undefined) {
      throw new Error("Expected retry start login call.");
    }
    act(() => {
      retryCall[1].onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    expect(
      screen.getByText("That sign-in link expired - a new one was generated."),
    ).toBeDefined();
  });

  it("restarts with a session-expired notice when awaitLogin resolves without a promoted profile before a late noActiveLogin submit response arrives (fixup settlement join, create mode await-first ordering)", async () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: {},
          },
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

    const input = screen.getByLabelText("Paste the code");
    fireEvent.paste(input, {
      clipboardData: { getData: () => "abc123#xyz789" },
    });

    const [, submitOptions] = firstSubmitLoginCodeCall();
    const [, awaitOptions] = firstAwaitLoginCall();

    // `awaitLogin` resolves first with no promoted profile - previously
    // this landed on the generic failure immediately, dropping the later
    // `noActiveLogin` verdict on the floor instead of restarting.
    act(() => {
      awaitOptions.onSuccess({ state: { profiles: [] } });
    });
    // The submit's verdict arrives late and must still settle the attempt.
    act(() => submitOptions.onSuccess({ outcome: "noActiveLogin" }));

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(2);
    });
    const retryCall = providerMocks.startLoginMutate.mock.calls.at(1);
    if (retryCall === undefined) {
      throw new Error("Expected retry start login call.");
    }
    act(() => {
      retryCall[1].onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    expect(
      screen.getByText("That sign-in link expired - a new one was generated."),
    ).toBeDefined();
  });

  it("does not resolve to identity when the resolved reauth profile row exists but is not authenticated (fixup settlement join, finding 2)", () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    const [, startOptions] = firstStartLoginCall();
    act(() => {
      startOptions.onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-1",
      });
    });

    const [, awaitOptions] = firstAwaitLoginCall();
    // The re-probed row for this profile is present but still signed out -
    // `providers.list` keeps a profile's row even when its account is not
    // authenticated, so presence alone must not resolve to identity.
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
              authStatus: "unauthenticated",
              duplicateOfProfileId: null,
              ambientDriftNotice: null,
            }),
          ],
        },
      });
    });

    expect(screen.queryByText("Signed in as")).toBeNull();
    expect(
      screen.getByText("Sign-in did not finish. Try again."),
    ).toBeDefined();
  });

  it("gates the add-profile failure report action on capability and reports only fixed generic context", () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
    act(() => startOptions.onError());

    screen.getByText(
      "Sign-in did not start. You can retry when the provider is available.",
    );
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Provider sign-in failed",
        message: null,
        code: null,
        source: "Add profile",
      },
    });
  });

  it("clears the sign-in failure banner when a new attempt starts and stays clear through its success", async () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // First attempt fails after the await phase - the section banner appears.
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
    act(() => awaitOptions.onError());
    screen.getByText("Sign-in did not finish. Retry when you are ready.");

    // Close the failed dialog - the banner persists behind it.
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    screen.getByText(/Sign-in did not finish for/);

    // The banner's Retry reopens the dialog; STARTING the next attempt must
    // clear the banner instead of letting it sit next to a sign-in that
    // then succeeds.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    expect(screen.queryByText(/Sign-in did not finish for/)).toBeNull();

    const retryStart = providerMocks.startLoginMutate.mock.calls.at(1);
    if (retryStart === undefined) {
      throw new Error("Expected a second start login call.");
    }
    act(() => {
      retryStart[1].onSuccess({
        url: "https://login.example.test",
        started: true,
        profileId: "managed-2",
      });
    });
    const retryAwait = providerMocks.awaitLoginMutate.mock.calls.at(1);
    if (retryAwait === undefined) {
      throw new Error("Expected a second await login call.");
    }
    // The real awaitLogin success merges the fresh provider state into the
    // providers.list cache - mirror that so the completed profile resolves
    // once the panel re-renders.
    const createdProfile = profile({
      profileId: "managed-2",
      kind: "managed",
      label: "New profile",
      email: "fresh@example.test",
      tier: "Pro",
      authStatus: "authenticated",
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
    });
    providerMocks.listResult.data = {
      providers: [
        {
          ...providerState({
            providerId: "codex",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            profiles: [createdProfile],
          }),
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };
    act(() => {
      retryAwait[1].onSuccess({
        state: { profiles: [createdProfile] },
      });
    });

    // The unique-identity path finalizes by recoloring; completing it closes
    // the dialog with the banner still clear.
    const recolor = providerMocks.recolorProfileMutate.mock.calls.at(0);
    if (recolor === undefined) {
      throw new Error("Expected a recolor call for the created profile.");
    }
    act(() => recolor[1].onSuccess());

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByText(/Sign-in did not finish for/)).toBeNull();
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
    expect(screen.getByRole("dialog")).toBeDefined();
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
    expect(screen.queryByRole("dialog")).toBeNull();
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.cancelLoginMutate).toHaveBeenCalledWith({
      providerId: "codex",
      profileId: "managed-1",
    });
    expect(screen.queryByRole("dialog", { name: "Add profile" })).toBeNull();
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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

  it("gates the reauth-failure report action on capability and reports only fixed generic context", async () => {
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(1);
    });
    const [, startOptions] = firstStartLoginCall();
    act(() => startOptions.onError());

    screen.getByText("Sign-in did not start. Try again when ready.");
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Provider reauthentication failed",
        message: null,
        code: null,
        source: "Provider reauth",
      },
    });
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work, Signed out" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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

  it("opens a signed-out profile deep link on the exact provider and starts sign-in", async () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "codex",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
        }),
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
              profile({
                profileId: "work-profile",
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };
    useProvidersFocusStore.getState().setProfileFocus({
      harnessId: "claude",
      hostId: "local",
      profileId: "work-profile",
      startSignIn: true,
    });

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(
      screen
        .getByRole("button", { name: "Claude Code", hidden: true })
        .getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitem", {
          name: "Work, Signed out",
          hidden: true,
        })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByRole("dialog", { name: "Sign in to Work" }),
    ).toBeDefined();
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledWith(
        {
          providerId: "claude-code",
          profileId: "work-profile",
          createProfile: null,
        },
        expect.anything(),
      );
    });
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      screen.getByRole("dialog", { name: "Sign in to Work" }),
    ).toBeDefined();
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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
    expect(screen.getByText("Opening the sign-in page…")).toBeDefined();
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
              rateLimitLimitedScopes: null,
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
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));
    expect(
      screen.getByText(
        "Agents that ran on Work will show it as removed. Running sessions on this profile must be stopped first.",
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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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

    // Identity is a real committed render before the finalize effect settles.
    // Implicit dismissal must neither close nor delete the authenticated
    // profile during that transient window.
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(providerMocks.removeProfileMutate).not.toHaveBeenCalled();

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
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
          },
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
