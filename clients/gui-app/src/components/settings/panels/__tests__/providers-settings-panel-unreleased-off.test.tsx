/**
 * The build without environments (`unreleased-features.ts`) draws Providers,
 * MCP servers and Skills as the release before them did: every page is the
 * Host picker's host's own, the MCP and Skills tabs are the host's tabs, and
 * the page says what the CLI binary choice does.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
// The page's pick is the Host picker's host, resolved from the host list.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [hostScopeOptionFixture({ hostId: "host-a" })],
      }),
  };
});
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ProviderProfileAccentColor,
  type ProviderCliCandidate,
  type ProviderCliState,
  type ProviderProfile,
  type ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderNativeCapabilities } from "@traycer/protocol/host/provider-native-schemas";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { agentGuiListHarnessesV91 } from "@traycer/protocol/host/agent/gui/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeStatus } from "@/components/settings/host-scope/host-scope-status";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  cleanup,
  render as rtlRender,
  screen,
  type RenderResult,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

function render(ui: ReactNode): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(ui, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

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

// Mirrors `AwaitLoginVariables` (`use-providers-await-login-mutation.ts`): the
// wire request plus the attempt's own `AbortSignal`.
type AwaitLoginVariables = {
  readonly request: {
    readonly providerId: ProviderCliState["providerId"];
    readonly profileId: string | null;
  };
  readonly signal: AbortSignal | undefined;
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

// `providers.setEnabled@2.2`'s request shape - typing this mock's calls lets
// tests read `.mock.calls[0]` without an unsafe `any` destructure.
type SetEnabledVariables = RequestOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;
type SetEnabledMutate = (variables: SetEnabledVariables) => void;

type CancelLoginVariables = RequestOfMethod<
  HostRpcRegistry,
  "providers.cancelLogin"
>;

// The `providers.list` envelope as this harness serves it. The flag is the
// `providers.list@10.5` key a sandbox host sets; every other host omits it.
interface ProvidersListEnvelope {
  providers: ProviderCliState[];
  credentialsManagedInAccount?: boolean;
}

const providerMocks = vi.hoisted(() => {
  const initialList: ProvidersListEnvelope = { providers: [] };
  return {
    listResult: {
      data: initialList,
      isPending: false,
      isError: false,
      isFetching: false,
      error: undefined as
        | HostRpcError
        | { message: string; code: string }
        | undefined,
      refetch: vi.fn(() => Promise.resolve({})),
    },
    setSelectionMutate: vi.fn(),
    addCustomPathMutate: vi.fn(),
    removeCustomPathMutate: vi.fn(),
    setEnabledMutate: vi.fn<SetEnabledMutate>(),
    setProfileEnabledMutate: vi.fn(),
    refreshProfileStatusMutate: vi.fn(() => Promise.resolve()),
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
      | { readonly outcome: "accepted" | "noActiveLogin" }
      | undefined,
    submitLoginCodeError: null as Error | null,
    touchLoginMutate: vi.fn(),
    touchLoginReset: vi.fn(),
    renameProfileMutate: vi.fn<RenameProfileMutate>(),
    renameProfilePending: false,
    renameProfileError: null as Error | null,
    recolorProfileMutate: vi.fn<RecolorProfileMutate>(),
    removeProfileMutate: vi.fn<RemoveProfileMutate>(),
    refreshProviders: vi.fn(() => Promise.resolve()),
    /** Host id each Refresh RESOLVED, which is the wrong-host bug's signature. */
    refreshedHostIds: [] as string[],
    /** The app-wide binding. Null unless a test opts into a distinct ambient. */
    ambientBinding: null as {
      hostClient: { getActiveHostId: () => string };
    } | null,
    refreshUsageLimits: vi.fn(() => Promise.resolve()),
    openLink: vi.fn(),
    /** What `useHostCredentialRefusal` answers; `null` is a host that takes sign-ins. */
    credentialRefusal: null as string | null,
  };
});

// The optional "Reset provider settings" capability. `unsupportedMethods` is
// what a host that predates `providers.settingsFile.*` would not advertise;
// the status hook and reset mutation are stubbed at their module seams. The
// reset hooks' own behavior - the request, toast, and refetch - is held by
// `provider-settings-reset-action.test.tsx`.
type ResetSettingsFileMutate = (
  variables: Record<string, never>,
  options: { readonly onSettled: () => void },
) => void;

type ResetProviderSettingsMutate = (
  variables: { readonly providerId: string },
  options: { readonly onSettled: () => void },
) => void;

const settingsFileMocks = vi.hoisted(() => ({
  unsupportedMethods: new Set<string>(),
  statusData: undefined as
    | {
        readonly unreadable: boolean;
        readonly unreadableProviderIds: readonly string[];
      }
    | undefined,
  /** The `enabled` argument of every `useProvidersSettingsFileStatus` call. */
  statusEnabledArgs: [] as boolean[],
  resetMutate: vi.fn<ResetSettingsFileMutate>(),
  resetProviderMutate: vi.fn<ResetProviderSettingsMutate>(),
}));

vi.mock("@/hooks/providers/use-providers-settings-file-status-query", () => ({
  useProvidersSettingsFileStatus: (enabled: boolean) => {
    settingsFileMocks.statusEnabledArgs.push(enabled);
    return { data: enabled ? settingsFileMocks.statusData : undefined };
  },
}));

vi.mock("@/hooks/providers/use-providers-settings-file-reset-mutation", () => ({
  useProvidersSettingsFileReset: () => ({
    mutate: settingsFileMocks.resetMutate,
    isPending: false,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-settings-file-reset-provider-mutation",
  () => ({
    useProvidersSettingsFileResetProvider: () => ({
      mutate: settingsFileMocks.resetProviderMutate,
      isPending: false,
    }),
  }),
);

// The auto-judge row the panel now renders reaches TanStack Query for the
// harness catalog and the set-judge mutation. The row is not what any test
// here asserts, so the catalog is stubbed at its query seam.
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({ data: undefined, isPending: false }),
}));

// The own-login row reads whether a refresh is in flight through
// `useIsMutatingOf`; the refresh itself is `useRefreshProviders`, stubbed below.
vi.mock("@/hooks/use-mutation-state-of", () => ({
  useIsMutatingOf: () => 0,
}));

// The provider's Limits pick reads the watched host's usage through the layout
// editor's own scope, which this suite does not stand up, so it is a marker
// here: what is held is WHERE the page mounts it. Which providers it offers a
// pick for is held by `provider-usage-limits-section.test.tsx`, and the pick
// itself by `provider-limits-choose.test.tsx`.
vi.mock("@/components/settings/panels/provider-usage-limits-section", () => ({
  ProviderUsageLimitsSection: (props: { readonly providerId: string }) => (
    <div
      data-testid="provider-usage-limits"
      data-provider-id={props.providerId}
    />
  ),
}));

vi.mock("@/hooks/providers/use-providers-set-auto-judge-mutation", () => ({
  useProvidersSetAutoJudge: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock(
  "@/hooks/providers/use-providers-set-native-subagents-mutation",
  () => ({
    useProvidersSetNativeSubagents: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => providerMocks.listResult,
}));

vi.mock("@/hooks/providers/use-providers-plugins-list-query", () => ({
  useProvidersPluginsList: () => ({
    data: { plugins: [] },
    isPending: false,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-providers-plugins-mutate-mutation", () => ({
  useProvidersPluginsMutate: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-skills-list-query", () => ({
  useProvidersSkillsList: () => ({
    data: { skills: [] },
    isPending: false,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-providers-skills-mutate-mutation", () => ({
  useProvidersSkillsMutate: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// The MCP tab is owned elsewhere; mock its hooks so panel tests stay isolated.
vi.mock("@/hooks/providers/use-providers-mcp-list-query", () => ({
  useProvidersMcpList: () => ({
    data: { servers: [] },
    isPending: false,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/providers/use-providers-mcp-mutate-mutation", () => ({
  useProvidersMcpMutate: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useProvidersMcpApplyRemedy: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-mcp-discover-mutation", () => ({
  useProvidersMcpDiscover: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-mcp-auth-mutation", () => ({
  useProvidersMcpAuth: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// The candidates table's failed-pack arm reaches `providers.ensurePack`, which
// goes through TanStack Query. Mocked here alongside the other provider
// mutations so this panel test stays focused on its provider controls.
// `AddProviderProfileDialog` also reaches this through the login flow, which
// calls `mutateAsync` before a retried start - see the `*ForClient` variant.
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => {
  const useProvidersEnsurePack = () => ({
    mutate: () => {},
    mutateAsync: () => Promise.resolve({}),
    isPending: false,
  });
  return {
    useProvidersEnsurePack,
    useProvidersEnsurePackForClient: useProvidersEnsurePack,
  };
});

// Same reason: the MCP tab's scope picker reads the host's worktree listing,
// which is a real TanStack query. This panel suite is about the tab shell, not
// worktree rows, so it reports none.
vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: { workspaces: [] },
    isPending: false,
  }),
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

// The panel's profile controls use a host-scoped TanStack mutation in
// production. Keep this suite focused on rendering and the existing provider
// mutations while the dedicated hook suite covers cache behavior.
vi.mock("@/hooks/providers/use-providers-set-profile-enabled-mutation", () => ({
  useProvidersSetProfileEnabledForClient: () => ({
    mutate: providerMocks.setProfileEnabledMutate,
    isPending: false,
  }),
  useProviderProfileEnablementPending: () => () => false,
}));

vi.mock(
  "@/hooks/providers/use-providers-refresh-profile-status-mutation",
  () => ({
    useProvidersRefreshProfileStatusForClient: () => ({
      mutateAsync: providerMocks.refreshProfileStatusMutate,
      isPending: false,
    }),
  }),
);

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
  // The login flow starts through `mutateAsync` (its promise settles even
  // where StrictMode detached the observer); this adapts it onto the
  // recorded `(variables, { onSuccess, onError })` fake every test drives.
  const useProvidersStartLogin = () => ({
    mutateAsync: (variables: StartLoginVariables) =>
      new Promise<StartLoginData>((resolve, reject) => {
        providerMocks.startLoginMutate(variables, {
          onSuccess: resolve,
          onError: reject,
        });
      }),
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
    mutateAsync: (variables: CancelLoginVariables) => {
      providerMocks.cancelLoginMutate(variables);
      return Promise.resolve({ cancelled: true });
    },
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
    isPending: providerMocks.renameProfilePending,
    error: providerMocks.renameProfileError,
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

vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-supports-method")
    >();
  return {
    ...actual,
    useHostSupportsMethod: (_hostId: string | null, method: string) =>
      !settingsFileMocks.unsupportedMethods.has(method),
  };
});

vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({
    isFetching: false,
    data: undefined,
  }),
}));

// NOTE: this is the SECOND `vi.mock` for this module in this file (see the
// stub near the top) and the one that wins, so it is the shape the suite
// actually runs against.
//
// `supportedPermissionModes` is stated rather than omitted because the panel
// derives the Permissions TAB from it now, and the real row schema defaults the
// field to every mode - a row without it is a shape the host cannot send.
//
// It includes `auto`, which is what makes this suite's "every supported
// section" case true. That matches the stance the file already takes one mock
// up: `useHostSupportsMethod` is stubbed `() => true` for every method, so this
// is a host with everything, now expressed in the catalog because that is where
// the tab's answer comes from.
//
// Held in a `vi.hoisted` holder, per-test mutable, so the Permissions-tab
// visibility tests can swap the catalog's `supportedPermissionModes` (or drop
// the catalog to `undefined` for "still loading") without a third `vi.mock`
// racing this one - mirrors `providersUpdatedAt` in
// `provider-auto-judge-section.test.tsx`.
interface CatalogHarnessFixture {
  readonly id: string;
  readonly modes: ReadonlyArray<string>;
  readonly supportedPermissionModes: ReadonlyArray<string>;
}
const DEFAULT_CATALOG_HARNESSES: ReadonlyArray<CatalogHarnessFixture> = [
  {
    id: "claude",
    modes: ["gui", "tui"],
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ],
  },
  {
    id: "codex",
    modes: ["gui", "tui"],
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ],
  },
];
const guiHarnessesCatalogMock = vi.hoisted(() => ({
  data: undefined as
    | { harnesses: ReadonlyArray<CatalogHarnessFixture> }
    | undefined,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({ data: guiHarnessesCatalogMock.data }),
}));

vi.mock("@/hooks/providers/use-refresh-providers", async () => {
  const { useContext } = await import("react");
  const { HostRuntimeContext } = await import("@/lib/host/runtime");
  return {
    // Resolves its client the way the real hook does - off
    // `HostRuntimeContext` - rather than being handed one. That is the whole
    // point: a stub that ignores context cannot tell a header inside the
    // provider from a header outside it, which is exactly the bug this suite
    // needs to be able to fail on.
    useRefreshProviders: () => {
      const binding = useContext(HostRuntimeContext);
      const hostId = binding?.hostClient.getActiveHostId() ?? "ambient";
      return async () => {
        providerMocks.refreshedHostIds.push(hostId);
        await providerMocks.refreshProviders();
      };
    },
  };
});

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => providerMocks.openLink,
}));

// The subscription section still reads the bridge for `signInUrl` (only its
// URL EGRESS moved to `openLink`), and most cases here render the panel with
// no `<RunnerHostProvider>` above it.
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://auth.example/sign-in" }),
  useRunnerHostOrNull: () => null,
}));

// Where the account-managed line's Secrets button asks Settings to go.
const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

// MCP Project scope resolves workspaces via host query; stub a stable empty
// host-resolved set because workspace rows are not under test here.
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: [],
    isLoading: false,
    isFetching: false,
  }),
}));

// The MCP scope picker can add a workspace folder; its action hook is
// unrelated to the provider panel, so keep it stubbed here.
vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActionsForClient: () => ({
    isPreparing: false,
    isRemoving: false,
    prepareFoldersMutation: null,
    removeEpicRepoMutation: null,
    pickAndPrepareFolders: () => Promise.resolve(null),
  }),
  preparedWorkspaceFolderToWorkspaceFolderInfo: () => ({
    path: "",
    name: "",
    repoIdentifier: null,
    hostId: null,
  }),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    // The SAME binding the `@/lib/host/runtime` mock below supplies, because
    // `@/lib/host` re-exports that symbol and the two must not disagree. They
    // used to: this returned `null` while the runtime mock returned the
    // ambient binding, and nothing noticed because the panel read the runtime
    // path. It now re-provides through `useScopedHostBinding`, which reads
    // this one - so a fixture answering `null` here silently withholds the
    // wrapper and the selected-host refresh lands on the ambient host.
    useHostBinding: () => providerMocks.ambientBinding,
    useHostClient: () => null,
    // The SPINE, a separate export since redesign P2.1.
    useHostRuntimeClient: () => null,
  };
});

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    // `HostRuntimeContext` stays REAL - the panel's provider swap is the thing
    // under test. Only the ambient binding is faked, and it is null by DEFAULT
    // so every existing test keeps the shape it was written against. A non-null
    // one is what lets the provider actually wrap the shell, which is the only
    // way the wrong-host regression can observe anything at all.
    useHostBinding: () => providerMocks.ambientBinding,
  };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

// The real hook reads the host binding's directory, which this suite's bare
// ambient binding does not carry; the hook has its own test.
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => providerMocks.credentialRefusal,
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

// A provider's Env tab reads the secrets that set its variables and writes
// through a host-scoped mutation; neither is about these cases, and both open
// with `useQueryClient()`.
vi.mock("@/components/settings/personal/use-secret-claimed-names", () => ({
  useSecretClaimedNames: () => new Map<string, string>(),
}));
vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: () => {},
    isPending: false,
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
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "local",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
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

// Once a sign-in-intent dialog closes itself on a same-account reconnect, the
// toast is the ONLY surviving success signal - so it has to be assertable
// rather than a real Sonner store write with no `<Toaster />` to land in.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

// The profile-scoped section's `ProfileDropdown` renders through Radix's real
// DropdownMenu, which opens on pointerdown rather than click - render it
// inline + always-open so tests can select a row without fighting
// pointer-open semantics in jsdom (mirrors the established mock in
// worktrees-settings-panel.test / folder-controls.test).
vi.mock("@/components/ui/dropdown-menu", async () => ({
  ...(await import("./dropdown-menu-passthrough-mock")),
}));

// Radix's Select needs a pointer-capable layout to open its listbox, which
// jsdom does not provide. Mirrors the stand-in
// `provider-model-provider-connect-dialog.test.tsx` uses: same element
// structure, every option always rendered, `onValueChange` forwarded so a
// test can pick an option by clicking it - plus `disabled` forwarding on both
// `Select` and `SelectItem`, which that mock doesn't need but the enablement
// floor here does (the "Off" item disables itself rather than vanishing).
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const ValueChangeContext = createContext<(value: string) => void>(() => {});
  // The currently-selected value, threaded down to `SelectItem` so it can
  // report `data-state` the way real Radix does. Absent from the mock until
  // the mobile section picker's "reopening marks the picked row as checked"
  // test needed it - every other consumer just clicks an item and never reads
  // this attribute back.
  const SelectedValueContext = createContext<string | undefined>(undefined);
  return {
    Select: (props: {
      readonly children: ReactNode;
      readonly value?: string;
      readonly onValueChange?: (value: string) => void;
      readonly disabled?: boolean;
    }) => (
      <ValueChangeContext.Provider
        value={
          props.disabled === true
            ? () => {}
            : (props.onValueChange ?? (() => {}))
        }
      >
        <SelectedValueContext.Provider value={props.value}>
          <div>{props.children}</div>
        </SelectedValueContext.Provider>
      </ValueChangeContext.Provider>
    ),
    // `role="combobox"` and the forwarded `aria-label` mirror real Radix
    // (`SelectPrimitive.Trigger` sets `role="combobox"`; the trigger's
    // `aria-label` prop passes straight through). Without both, every
    // `getByRole("combobox", { name: ... })` query this file already had
    // before this mock existed - the mobile provider/section pickers - would
    // find a plain unnamed `role="button"` element instead.
    SelectTrigger: (props: {
      readonly children: ReactNode;
      readonly id?: string;
      readonly "aria-label"?: string;
    }) => (
      <button
        type="button"
        role="combobox"
        id={props.id}
        aria-label={props["aria-label"]}
        aria-expanded={false}
        aria-controls="select-mock-content"
      >
        {props.children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    SelectItem: (props: {
      readonly children: ReactNode;
      readonly value: string;
      readonly disabled?: boolean;
    }) => {
      const onValueChange = useContext(ValueChangeContext);
      const selectedValue = useContext(SelectedValueContext);
      return (
        <button
          type="button"
          data-value={props.value}
          data-state={props.value === selectedValue ? "checked" : "unchecked"}
          disabled={props.disabled ?? false}
          onClick={() => onValueChange(props.value)}
        >
          {props.children}
        </button>
      );
    },
  };
});
/**
 * The only thing the panel calls on a scope client, so the only thing a stub
 * has to be. Named rather than asserted: the real `HostClient` is far wider
 * than this test needs, and casting to it would be claiming a shape nothing
 * here provides.
 */
type ScopeClientStub = { readonly getActiveHostId: () => string };

const hostScopeMocks: {
  status: HostScopeStatus | undefined;
  client: ScopeClientStub | null;
  setHostId: Mock<(hostId: string) => void>;
  hostId: string;
  host: HostScopeOption | undefined;
} = vi.hoisted(() => ({
  status: undefined,
  client: null,
  setHostId: vi.fn<(hostId: string) => void>(),
  hostId: "host-a",
  host: undefined,
}));

// Panels depend on the host SCOPE, not on the six hooks it composes, so this
// mocks at that boundary rather than re-mocking the scope's internals.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => ({
    ...hostScopeFixture({
      setHostId: hostScopeMocks.setHostId,
      hostId: hostScopeMocks.hostId,
      // `host: undefined` must be OMITTED, not passed: the fixture's final
      // spread would clobber its default host with the explicit undefined.
      ...(hostScopeMocks.host === undefined
        ? {}
        : { host: hostScopeMocks.host }),
      // Same omit-don't-pass rule as `host`: an explicit undefined would
      // clobber the fixture's derived status.
      ...(hostScopeMocks.status === undefined
        ? {}
        : { status: hostScopeMocks.status }),
    }),
    // Spread OUTSIDE the fixture call: the stub satisfies what the panel
    // uses, not the full `HostClient` the fixture's type demands.
    client: hostScopeMocks.client,
  });
  return {
    useHostScope,
    usePersonalHostScope: useHostScope,
  };
});

import {
  McpServersSettingsPanel,
  ProvidersSettingsPanel,
  SkillsSettingsPanel,
} from "@/components/settings/panels/providers-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "sonner";
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
  readonly nativeCapabilities?: ProviderNativeCapabilities;
  readonly profiles?: readonly ProviderProfile[];
  readonly terminalAgentArgs?: string;
  readonly apiKey?: ProviderCliState["apiKey"];
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
    apiKey: input.apiKey ?? {
      supported: false,
      configured: false,
      source: null,
    },
    terminalAgentArgs: input.terminalAgentArgs ?? "",
    envOverrides: [...input.envOverrides],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities:
      input.nativeCapabilities ?? DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [...(input.profiles ?? [])],
  };
}

const BOTH_SCOPES = ["global", "project"] as const;

const SAMPLE_MCP: NonNullable<ProviderNativeCapabilities["mcp"]> = {
  transports: ["stdio", "http"],
  authTypes: ["none", "header"],
  authActions: ["login", "logout"],
  actionScopes: {
    list: [...BOTH_SCOPES],
    add: [...BOTH_SCOPES],
    update: [...BOTH_SCOPES],
    remove: [...BOTH_SCOPES],
    toggleServer: [...BOTH_SCOPES],
    toggleTool: [...BOTH_SCOPES],
    discover: [...BOTH_SCOPES],
    auth: [...BOTH_SCOPES],
  },
  addServer: "cli",
  removeServer: "cli",
  updateServer: "patch",
  perToolBacking: "native",
  statusSource: "probe",
  toolsSource: "probe",
  schemasSource: "probe",
  instructionsSource: "probe",
  traycerSessionsOnlyEnforcement: false,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: true,
};

const FULL_TABS: ProviderNativeCapabilities = {
  supportedTabs: ["general", "env", "usage", "mcp", "plugins", "skills"],
  mcp: SAMPLE_MCP,
  plugins: {
    addModes: ["cli-source"],
    marketplaceBrowse: false,
    // Both scopes so the F5 scope picker renders (global-only contracts get a
    // plain "every workspace" line instead of a trigger with locationLabel).
    actionScopes: {
      list: [...BOTH_SCOPES],
      add: [...BOTH_SCOPES],
      remove: [...BOTH_SCOPES],
      setEnabled: [...BOTH_SCOPES],
    },
    traycerSessionToolsNotice: false,
    openChatsApplyNextMessage: false,
  },
  skills: {
    actionScopes: {
      list: [...BOTH_SCOPES],
      add: [...BOTH_SCOPES],
      create: [...BOTH_SCOPES],
      import: [],
      remove: [...BOTH_SCOPES],
    },
  },
  modelProviders: null,
};

vi.mock(
  "@/components/settings/environment/environment-provider-mcp-tab",
  () => ({
    EnvironmentProviderMcpTab: (props: { readonly providerId: string }) => (
      <div data-testid="environment-mcp-tab">{props.providerId}</div>
    ),
  }),
);
vi.mock(
  "@/components/settings/environment/environment-skills",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/environment/environment-skills")
    >()),
    EnvironmentProviderSkillsTab: (props: { readonly providerId: string }) => (
      <div data-testid="environment-skills-tab">{props.providerId}</div>
    ),
  }),
);
vi.mock(
  "@/components/settings/environment/configuration-source-boundary",
  () => ({
    ConfigurationSourceBoundary: (props: {
      readonly target: { readonly kind: string };
      readonly children: ReactNode;
    }) => (
      <div data-testid={`boundary-${props.target.kind}`}>{props.children}</div>
    ),
  }),
);

// The panel's LocalRowNote owns the move affordance, which has its own suite.
// Keep its status read independent of the host runtime and real environment
// queries in this providers-focused harness.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/environment/use-environment-reads", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/environment/use-environment-reads")
    >();
  return {
    ...actual,
    useEnvironmentStatusRead: () => ({
      supported: null,
      data: null,
      isError: false,
    }),
  };
});

describe("<ProvidersSettingsPanel />", () => {
  beforeEach(() => {
    // The Permissions tab reads the NEGOTIATED `agent.gui.listHarnesses` line
    // (see `permissionsTab`), through the real manifest registry - only the
    // scope's host id is mocked. `9.1` is the line `auto` became expressible
    // on, so this is the ordinary auto-capable host; the cases about the gate
    // record their own manifest over it.
    recordNegotiatedHostManifest(hostScopeMocks.hostId, {
      "agent.gui.listHarnesses": agentGuiListHarnessesV91.schemaVersion,
    });
    guiHarnessesCatalogMock.data = { harnesses: DEFAULT_CATALOG_HARNESSES };
    useProvidersFocusStore.setState({
      focusHarnessId: null,
      focusTab: null,
    });
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "opencode",
          selected: { kind: "bundled" },
          candidates: OPENCODE_CANDIDATES,
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
        }),
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
        }),
        providerState({
          providerId: "openrouter",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
        }),
      ],
    };
    providerMocks.listResult.isError = false;
    providerMocks.listResult.error = undefined;
    providerMocks.listResult.refetch.mockClear();
    providerMocks.setSelectionMutate.mockClear();
    navigateToSettingsSectionMock.mockClear();
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
    providerMocks.openLink.mockClear();
    providerMocks.renameProfileMutate.mockReset();
    providerMocks.renameProfilePending = false;
    providerMocks.renameProfileError = null;
    providerMocks.recolorProfileMutate.mockReset();
    providerMocks.removeProfileMutate.mockReset();
    providerMocks.refreshProviders.mockClear();
    providerMocks.refreshUsageLimits.mockClear();
    settingsFileMocks.unsupportedMethods.clear();
    settingsFileMocks.statusData = undefined;
    settingsFileMocks.statusEnabledArgs.length = 0;
    settingsFileMocks.resetMutate.mockReset();
    settingsFileMocks.resetProviderMutate.mockReset();
    vi.mocked(toast.success).mockClear();
    hostScopeMocks.setHostId.mockClear();
    hostScopeMocks.hostId = "host-a";
    hostScopeMocks.host = undefined;
    // Reset alongside the rest: a test that pins an unusable status would
    // otherwise leave every later one scoped to a host with no client.
    hostScopeMocks.status = undefined;
    providerMocks.refreshedHostIds.length = 0;
    providerMocks.ambientBinding = null;
    providerMocks.credentialRefusal = null;
    hostScopeMocks.client = null;
    useProvidersFocusStore.getState().clearFocusHarnessId();
  });

  afterEach(() => {
    // Unconditional and before `cleanup()`: the ambient re-poll tests opt into
    // fake timers mid-test, and a leaked fake clock would strand every later
    // test's timers (and Testing Library's own unmount work).
    vi.useRealTimers();
    resetNegotiatedManifests();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    cleanup();
    useProvidersFocusStore.setState({
      focusHarnessId: null,
      focusHostId: null,
      focusProfileId: null,
      startSignIn: false,
      focusTab: null,
    });
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("describes the page by what choosing a CLI binary does", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(
      screen.getByText(
        "Choose the CLI binary Traycer runs for each coding agent. Pick the bundled binary, one found on your PATH, or a custom install. Disable a provider to hide it when creating an agent.",
      ),
    ).toBeDefined();
  });

  it("draws the host's own MCP tab, not Personal's", () => {
    render(
      <TooltipProvider>
        <McpServersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByTestId("provider-mcp-tab")).toBeDefined();
    expect(screen.queryByTestId("environment-mcp-tab")).toBeNull();
  });

  it("draws the host's own Skills tab, not Personal's", () => {
    render(
      <TooltipProvider>
        <SkillsSettingsPanel />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("textbox", { name: "Search skills" }),
    ).toBeDefined();
    expect(screen.queryByTestId("environment-skills-tab")).toBeNull();
  });
});
