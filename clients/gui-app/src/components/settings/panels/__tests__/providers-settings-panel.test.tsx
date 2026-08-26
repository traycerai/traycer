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
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderNativeCapabilities } from "@traycer/protocol/host/provider-native-schemas";
import {
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeStatus } from "@/components/settings/host-scope/host-scope-status";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  act,
  cleanup,
  fireEvent,
  queries,
  render,
  screen,
  waitFor,
  within,
  type BoundFunctions,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";

// Radix Tabs activates on mouseDown (not click). Helper keeps assertions short.
function selectTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
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

// `providers.setEnabled@2.2`'s request shape - typing this mock's calls lets
// the three-way control's tests read `.mock.calls[0]` without an unsafe `any`
// destructure.
type SetEnabledVariables = RequestOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;
type SetEnabledMutate = (variables: SetEnabledVariables) => void;

const providerMocks = vi.hoisted(() => ({
  listResult: {
    data: { providers: [] as ProviderCliState[] },
    isPending: false,
    isError: false,
    isFetching: false,
    error: undefined as
      HostRpcError | { message: string; code: string } | undefined,
  },
  setSelectionMutate: vi.fn(),
  addCustomPathMutate: vi.fn(),
  removeCustomPathMutate: vi.fn(),
  setEnabledMutate: vi.fn<SetEnabledMutate>(),
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
  openExternalLink: vi.fn(),
}));

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

// Sibling ticket 11 owns the MCP tab; mock its hooks so panel tests stay isolated.
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
// mutations so this panel test keeps rendering without a QueryClientProvider.
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePack: () => ({ mutate: () => {}, isPending: false }),
}));

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

vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({
    isFetching: false,
    data: undefined,
  }),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: {
      harnesses: [
        { id: "claude", modes: ["gui", "tui"] },
        { id: "codex", modes: ["gui", "tui"] },
      ],
    },
  }),
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

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({
    mutate: providerMocks.openExternalLink,
  }),
}));

// MCP Project scope resolves workspaces via host query; this harness has no
// QueryClient, so stub a stable empty host-resolved set.
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: [],
    isLoading: false,
    isFetching: false,
  }),
}));

// Same reason: the MCP scope picker can add a workspace folder, and the real
// action hook opens with `useQueryClient()` - which THROWS, not degrades, with
// no provider above it. Every host hook in this file is stubbed the same way.
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
// The section also asks whether a read we stopped waiting for still has its
// delayed follow-up coming. That reads the queue registry through
// `useRateLimitQueueScope`, which needs the QueryClient this harness has none
// of; no target is ever enqueued here, so an idle answer is the truthful one.
vi.mock("@/hooks/rate-limits/use-rate-limit-queue-target-phase", () => ({
  useIsRateLimitReadFollowUpExhausted: () => false,
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
  return {
    useHostScope: () => ({
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
    }),
  };
});

import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";
import {
  AMBIENT_AUTH_PENDING_REPOLL_CAP,
  AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS,
} from "@/components/settings/panels/use-provider-profile-login-flow";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { redactEmail } from "@/lib/providers/redact-email";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";

import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
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

const CURSOR_TABS: ProviderNativeCapabilities = {
  supportedTabs: ["env", "mcp", "plugins", "skills"],
  mcp: {
    ...SAMPLE_MCP,
    perToolBacking: "degraded-server-level",
    instructionsSource: "none",
  },
  plugins: {
    addModes: ["read-only"],
    marketplaceBrowse: false,
    actionScopes: {
      list: ["global"],
      add: [],
      remove: [],
      setEnabled: [],
    },
    traycerSessionToolsNotice: false,
  },
  skills: {
    actionScopes: {
      list: ["global"],
      add: ["global"],
      create: ["global"],
      import: [],
      remove: ["global"],
    },
  },
  modelProviders: null,
};

const ENV_ONLY_TABS: ProviderNativeCapabilities = {
  supportedTabs: ["env"],
  mcp: null,
  plugins: null,
  skills: null,
  modelProviders: null,
};

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

function firstSetEnabledCall(): SetEnabledVariables {
  const call = providerMocks.setEnabledMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected setEnabled call.");
  return call[0];
}

function firstSubmitLoginCodeCall(): readonly [
  SubmitLoginCodeVariables,
  SubmitLoginCodeOptions,
] {
  const call = providerMocks.submitLoginCodeMutate.mock.calls.at(0);
  if (call === undefined) throw new Error("Expected submit login code call.");
  return call;
}

/** An oauth-only codex with the ambient row plus one managed "Work" profile,
 *  so a test can hand it a different `managed-1` before and after a sign-in
 *  and drive the reauth panel's changed-account branch. */
function codexWithManaged(managed: ProviderProfile): ProviderCliState {
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
        managed,
      ],
    }),
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
    },
  };
}

/** `managed-1` as a given account. The pre-sign-in address is the signed-OUT
 *  row (that is the state the row is in when its "Sign in" button shows); any
 *  other address is the authenticated result of a sign-in. */
function workProfileSignedInAs(email: string): ProviderProfile {
  return profile({
    profileId: "managed-1",
    kind: "managed",
    label: "Work",
    email,
    tier: "Pro",
    authStatus:
      email === "work@example.test" ? "unauthenticated" : "authenticated",
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
  });
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
      terminalLogin: null,
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
      terminalLogin: null,
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

// A non-null runner host so the desktop external-link path (preventDefault +
// openExternalLink) runs; host-less renders fall back to native anchor nav.
function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.example/sign-in",
    authnBaseUrl: "https://auth.example",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/**
 * Profiles render on the `usage` tab - labelled "Profiles & Limits" - not on the CLI
 * tab, so every profile assertion has to activate that tab after mounting.
 * Kept as one helper so the next time the section moves (or the label changes
 * again) this is a one-line change, not forty.
 */
function openProfilesTab(): void {
  selectTab("Profiles & Limits");
}

/**
 * The SAME tab for a provider without managed profiles, which is most of them.
 *
 * The label is per-provider now: the tab holds profiles and usage limits, and
 * for a provider that cannot have profiles it holds only the second - so
 * promising them in the rail was promising a section that is not there.
 */
function openUsageLimitsTab(): void {
  selectTab("Usage limits");
}

/**
 * The provider header and tab rail are PINNED rows; only the active tab's body
 * scrolls.
 *
 * Asserted structurally (what contains what) plus the one class that carries
 * the mechanism, because jsdom has no layout engine - it reports every element
 * as 0×0 and never computes an overflow, so "does this scroll?" has no
 * observable answer here beyond the declaration. The containment checks are the
 * load-bearing half: the regression this guards against is the rail or the
 * header drifting back INSIDE the scroll box, which is exactly a parent/child
 * relationship and is checked as one.
 */
function expectPinnedRailLayout(): void {
  const panel = screen.getByRole("tabpanel");
  expect(panel.className).toContain("overflow-y-auto");

  // The rail must be a SIBLING of the scrolling body, not a descendant of it -
  // a sticky-positioned rail inside the scroll box would satisfy neither this
  // nor the background constraint that motivated the flex layout.
  const list = screen.getByRole("tablist");
  expect(panel.contains(list)).toBe(false);

  // Same for the provider header. `openProfilesTab` has run, so the enable
  // switch is the header's stable anchor regardless of which tab is active.
  expect(panel.contains(screen.getByRole("switch"))).toBe(false);

  // ...and nothing else scrolls above it, which is what made the pin possible:
  // the column that used to own `overflow-y-auto` must have handed it over.
  const scrollers: string[] = [];
  for (
    let node: HTMLElement | null = panel.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    if (node.className.includes("overflow-y-auto")) {
      scrollers.push(node.className);
    }
  }
  // The provider rail `<nav>` is a sibling, never an ancestor, so it is not in
  // this chain.
  expect(scrollers).toEqual([]);
}

/**
 * Provider rows currently in the rail, in rendered order. Scoped to the LIST
 * rather than the nav, which also holds the search row's filter button - and
 * returns `[]` for the filtered-empty rail, where no list is rendered at all.
 */
function railProviderNames(): readonly string[] {
  const nav = screen.getByRole("navigation", { name: "Providers" });
  const list = within(nav).queryByRole("list", { name: "Providers" });
  if (list === null) return [];
  return within(list)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "");
}

/**
 * The rail row for a provider, scoped to the rail LIST like
 * `railProviderNames` above - never bare `screen`. Below `md` the
 * always-mounted `ProvidersMobileSelect` renders one item per provider under
 * the SAME display name (jsdom applies no CSS, so `md:hidden` never actually
 * hides it there), so an unscoped `getByRole("button", { name })` collides
 * with that item the moment more than one provider is in the fixture.
 * `hidden` is threaded through explicitly rather than defaulted, since the
 * one caller behind a dialog's `hideOthers` needs it true and every other
 * caller needs it false.
 */
function railProviderRow(name: string | RegExp, hidden: boolean): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "Providers", hidden });
  const list = within(nav).getByRole("list", { name: "Providers", hidden });
  return within(list).getByRole("button", { name, hidden });
}

describe("<ProvidersSettingsPanel />", () => {
  beforeEach(() => {
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
    providerMocks.renameProfilePending = false;
    providerMocks.renameProfileError = null;
    providerMocks.recolorProfileMutate.mockReset();
    providerMocks.removeProfileMutate.mockReset();
    providerMocks.refreshProviders.mockClear();
    providerMocks.refreshUsageLimits.mockClear();
    vi.mocked(toast.success).mockClear();
    hostScopeMocks.setHostId.mockClear();
    hostScopeMocks.hostId = "host-a";
    hostScopeMocks.host = undefined;
    // Reset alongside the rest: a test that pins an unusable status would
    // otherwise leave every later one scoped to a host with no client.
    hostScopeMocks.status = undefined;
    providerMocks.refreshedHostIds.length = 0;
    providerMocks.ambientBinding = null;
    hostScopeMocks.client = null;
    useProvidersFocusStore.getState().clearFocusHarnessId();
  });

  afterEach(() => {
    // Unconditional and before `cleanup()`: the ambient re-poll tests opt into
    // fake timers mid-test, and a leaked fake clock would strand every later
    // test's timers (and Testing Library's own unmount work).
    vi.useRealTimers();
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

  it("applies a re-auth deep link's host even though the rail clears the intent on mount", () => {
    // The rail is a DESCENDANT of the panel and clears the whole focus intent
    // — host half included — in its own mount effect. React runs child passive
    // effects before the parent's, so a parent that read the store in an
    // effect saw an already-emptied store whenever the rail mounted in the
    // same commit, which is exactly what cached provider data produces. The
    // deep link then silently consumed its provider/profile intent against
    // whichever host was already on screen.
    useProvidersFocusStore.getState().setProfileFocus({
      harnessId: "opencode",
      hostId: "host-that-needs-reauth",
      profileId: "profile-1",
      startSignIn: false,
    });

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(hostScopeMocks.setHostId).toHaveBeenCalledWith(
      "host-that-needs-reauth",
    );
    // Consumed exactly once: the host half is cleared at the point of use, so
    // a later visit does not yank the scope back to a host the user has since
    // navigated away from.
    expect(useProvidersFocusStore.getState().focusHostId).toBeNull();
  });

  it("refuses a profile intent whose target host is not the one on screen", () => {
    // The target was unreachable or plan-gated, so its rail never mounted and
    // the harness/profile/sign-in halves stayed armed. Splitting the host half
    // off (so an unreachable target could not re-yank the scope forever) threw
    // away WHICH host they belonged to — and the next reachable host the user
    // picked consumed them, in the worst case starting an automatic sign-in
    // there. The retained target is what makes the remainder refusable.
    useProvidersFocusStore.setState({
      focusHarnessId: "cursor",
      focusHostId: null,
      focusTargetHostId: "host-that-needs-reauth",
      focusProfileId: "profile-1",
      startSignIn: true,
    });
    hostScopeMocks.hostId = "some-other-host";
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
          providerId: "cursor",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: CURSOR_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // Not consumed here: the pane stays on the rail's first provider rather
    // than opening the deep link's target on the wrong machine. The probe is
    // that provider's DEFAULT tab, which is the first entry of
    // PROVIDER_TAB_ORDER it supports - "Usage limits" here, since
    // FULL_TABS advertises `usage` and `providerState` leaves the API key
    // unsupported so no Account tab precedes it.
    expect(
      screen
        .getByRole("tab", { name: "Usage limits" })
        .getAttribute("data-state"),
    ).toBe("active");
    expect(screen.queryByTestId("provider-mcp-tab")).toBeNull();
    // ...and it is cancelled rather than left armed for the next host.
    expect(useProvidersFocusStore.getState().focusHarnessId).toBeNull();
    expect(useProvidersFocusStore.getState().focusProfileId).toBeNull();
    expect(useProvidersFocusStore.getState().startSignIn).toBe(false);
  });

  it("leaves the scope alone when no deep link armed a host", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(hostScopeMocks.setHostId).not.toHaveBeenCalled();
  });

  it("switches the scope BEFORE any child can consume the rest of the intent", () => {
    // Capturing the host half before children mount was necessary but not
    // sufficient: the rail consumes (and clears) the provider/profile half in
    // its own mount effect, and child passive effects run before the parent's.
    // So when the rail mounted in the same commit — cached data — it consumed
    // the intent against the OLD host, in the worst case starting a re-auth
    // sign-in there, one commit before the scope moved. The panel now holds
    // its subtree until the switch has landed, so the rail's first mount is
    // already scoped to the deep-linked host. This asserts the ORDER, which is
    // the actual contract the two narrower fixes missed.
    const order: string[] = [];
    hostScopeMocks.setHostId.mockImplementation(() => {
      order.push("scope-switched");
    });
    // The suite's beforeEach only mockClear()s this spy, which keeps the
    // implementation — drop it here so it cannot leak into later tests.
    onTestFinished(() => {
      hostScopeMocks.setHostId.mockReset();
    });
    const unsubscribe = useProvidersFocusStore.subscribe((state, prev) => {
      if (prev.focusProfileId !== null && state.focusProfileId === null) {
        order.push("intent-consumed");
      }
    });
    useProvidersFocusStore.getState().setProfileFocus({
      harnessId: "opencode",
      hostId: "host-that-needs-reauth",
      profileId: "profile-1",
      startSignIn: false,
    });

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );
    unsubscribe();

    const switched = order.indexOf("scope-switched");
    expect(switched).not.toBe(-1);
    // Whether or not the rail consumed the intent during this render, nothing
    // may have consumed it BEFORE the switch.
    const consumed = order.indexOf("intent-consumed");
    if (consumed !== -1) {
      expect(switched).toBeLessThan(consumed);
    }
  });

  it("applies a deep link armed AFTER mount — the keep-alive case", async () => {
    // The top-level keep-alive host retains this panel while its tab is
    // hidden, so a re-auth banner click arms the intent against an
    // already-mounted panel: there is no fresh mount to capture it. A
    // mount-time snapshot stayed stale, pending never rose, and Sign in
    // appeared to do nothing while the intent waited to fire against
    // whichever host a later remount happened to select.
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );
    expect(hostScopeMocks.setHostId).not.toHaveBeenCalled();

    act(() => {
      useProvidersFocusStore.getState().setProfileFocus({
        harnessId: "opencode",
        hostId: "host-armed-late",
        profileId: "profile-1",
        startSignIn: false,
      });
    });

    await waitFor(() => {
      expect(hostScopeMocks.setHostId).toHaveBeenCalledWith("host-armed-late");
    });
    expect(useProvidersFocusStore.getState().focusHostId).toBeNull();
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

  it("shows connecting copy, not the failure card, while a remote host's transport is still dialing", () => {
    hostScopeMocks.host = hostScopeOptionFixture({
      hostId: "host-a",
      isLocalMachine: false,
    });
    providerMocks.listResult.isError = true;
    // The pre-send "session not ready" rejection every host-scoped query gets
    // while the remote session's first dial is still in flight.
    providerMocks.listResult.error = new RetryableTransportError({
      code: "RPC_ERROR",
      message: "Remote session is not ready",
      requestId: "req-1",
      method: "providers.list",
      fatalDetails: null,
    });

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByText("Connecting to the remote host…")).toBeDefined();
    expect(screen.queryByText(/may need to be updated/)).toBeNull();
    expect(screen.queryByText(/Couldn't load provider state/)).toBeNull();
  });

  it("keeps an actionable failure card for an EXHAUSTED local transport failure", () => {
    // A spinner is a promise that something will refetch, and on a local host
    // nothing can keep it. The remote path has the messenger's own binding,
    // whose ready boundary invalidates this query; a local host has no such
    // binding, `useHostQuery` pins `retry: false`, and by the time this error
    // surfaces the retry wrapper has already spent its budget - its final
    // attempt rethrows unchanged, so the class says what the failure WAS, not
    // that anything is still retrying. Showing "Reconnecting…" here parked the
    // panel on a permanent spinner with no way to report the fault.
    providerMocks.listResult.isError = true;
    providerMocks.listResult.error = new RetryableTransportError({
      code: "RPC_ERROR",
      message: "Local host connection is not ready",
      requestId: "req-2",
      method: "providers.list",
      fatalDetails: null,
    });

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByText("Reconnecting to the host…")).toBeNull();
    expect(screen.queryByText("Connecting to the remote host…")).toBeNull();
    expect(screen.getByText(/Couldn't load provider state/)).toBeDefined();
  });

  it("keeps an actionable failure card for an AMBIGUOUS post-send transport drop", () => {
    providerMocks.listResult.isError = true;
    // The base class, not the retryable subclass: the request frame WAS on the
    // wire when the socket died, so nothing may assume it resolves itself.
    // `useHostQuery` pins `retry: false` and no recovery event is owed, so
    // showing this as "connecting" parks the panel on a spinner forever and
    // hides the report-issue affordance.
    providerMocks.listResult.error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "The connection dropped before a response arrived",
      requestId: "req-3",
      method: "providers.list",
      fatalDetails: null,
    });

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByText("Reconnecting to the host…")).toBeNull();
    expect(screen.queryByText("Connecting to the remote host…")).toBeNull();
    expect(screen.getByText(/Couldn't load provider state/)).toBeDefined();
  });

  it("lists OpenCode CLI candidates for Traycer and mutates Traycer selection", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(railProviderRow(/Traycer/i, false));
    // CLI candidates live on CLI & Args; Account / Profiles lead the tab order.
    selectTab("CLI & Args");

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

  it("shows the CLI & Args tab and empty-state notice for amp (no longer id-hidden)", () => {
    // hidesCliCandidates(amp||cursor) used to suppress this whole tab on the
    // premise that those two have no user-selectable binary. Both spawn the
    // Traycer-resolved binary for MCP write verbs, so the table is the only
    // route out of the F2 dead end when nothing is on PATH.
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "amp",
          selected: { kind: "path" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: {
            supportedTabs: ["general", "env", "mcp", "plugins", "skills"],
            mcp: SAMPLE_MCP,
            plugins: null,
            skills: null,
            modelProviders: null,
          },
          apiKey: { supported: true, configured: false, source: null },
        }),
      ],
    };

    render(
      <RunnerHostContext.Provider value={createRunnerHost()}>
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>
      </RunnerHostContext.Provider>,
    );

    expect(screen.getByRole("tab", { name: "CLI & Args" })).toBeDefined();
    selectTab("CLI & Args");
    expect(
      screen.getByText(
        "No Amp CLI was found on this machine, and Traycer ships no bundled copy of it. Install it, or add its path below.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Amp installation guide" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Add custom path" }),
    ).toBeDefined();
  });

  it("shows the CLI & Args tab and candidates table for cursor when a path is available", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "cursor",
          selected: { kind: "path" },
          candidates: [
            {
              kind: "path",
              path: "/usr/local/bin/cursor-agent",
              version: "0.50.0",
              available: true,
              versionPending: false,
            },
          ],
          envOverrides: [],
          nativeCapabilities: {
            supportedTabs: [
              "general",
              "env",
              "usage",
              "mcp",
              "plugins",
              "skills",
            ],
            mcp: {
              ...SAMPLE_MCP,
              perToolBacking: "degraded-server-level",
              instructionsSource: "none",
            },
            plugins: {
              addModes: ["read-only"],
              marketplaceBrowse: false,
              actionScopes: {
                list: ["global"],
                add: [],
                remove: [],
                setEnabled: [],
              },
              traycerSessionToolsNotice: true,
            },
            skills: null,
            modelProviders: null,
          },
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByRole("tab", { name: "CLI & Args" })).toBeDefined();
    selectTab("CLI & Args");
    expect(
      screen.getByRole("radio", {
        name: "Select /usr/local/bin/cursor-agent",
      }),
    ).toBeDefined();
    expect(
      screen.queryByText(/No Cursor CLI was found on this machine/),
    ).toBeNull();
  });

  it("selects Hermes' PATH candidate without rendering a bundled row", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "hermes",
          selected: { kind: "path" },
          candidates: [
            {
              kind: "path",
              path: "/usr/local/bin/hermes",
              version: "0.1.0",
              available: true,
              versionPending: false,
            },
          ],
          envOverrides: [],
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("CLI & Args");

    const pathRadio = screen.getByRole<HTMLInputElement>("radio", {
      name: "Select /usr/local/bin/hermes",
    });
    expect(pathRadio.checked).toBe(true);
    expect(
      screen.queryByRole("radio", { name: "Select bundled binary" }),
    ).toBeNull();
  });

  it("shows Hermes' PATH-only not-found guidance without a bundled row", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "hermes",
          selected: { kind: "path" },
          candidates: [],
          envOverrides: [],
        }),
      ],
    };

    render(
      <RunnerHostContext.Provider value={createRunnerHost()}>
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>
      </RunnerHostContext.Provider>,
    );

    selectTab("CLI & Args");

    expect(
      screen.getByText(
        "No Hermes Agent CLI was found on this machine, and Traycer ships no bundled copy of it. Install it, or add its path below.",
      ),
    ).toBeDefined();
    const guide = screen.getByRole("link", {
      name: "Hermes Agent installation guide",
    });
    expect(guide.getAttribute("href")).toBe(
      "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
    );
    fireEvent.click(guide);
    expect(providerMocks.openExternalLink).toHaveBeenCalledWith(
      "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
    );
    expect(
      screen.getByRole("button", { name: "Add custom path" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("radio", { name: "Select bundled binary" }),
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
    // Scoped to the LIST, not the whole nav: the nav also holds the rail's
    // search row, whose filter trigger is a button too and would otherwise
    // enter this ordering assertion as a phantom first provider.
    const list = within(nav).getByRole("list", { name: "Providers" });
    expect(
      within(list)
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

  it("narrows the rail to providers matching the search, keeping rail order", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search providers" }),
      { target: { value: "open" } },
    );

    expect(railProviderNames()).toEqual(["OpenCode", "OpenRouter"]);
  });

  it("leaves the detail pane on the selected provider when the rail hides it", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // OpenCode is selected on mount (first in rail order for this fixture).
    expect(screen.getByText("OpenCode CLI agent.")).toBeDefined();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search providers" }),
      { target: { value: "openrouter" } },
    );

    // The rail is down to one row that is NOT the selected provider, and the
    // detail pane has not followed it. Re-selecting per keystroke would throw
    // away whatever was in progress on the right - an unsaved API key, a
    // half-filled MCP form - for a keystroke that only asked to look.
    expect(railProviderNames()).toEqual(["OpenRouter"]);
    expect(screen.getByText("OpenCode CLI agent.")).toBeDefined();
  });

  it("says so when nothing matches, instead of an empty rail", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search providers" }),
      { target: { value: "no-such-provider" } },
    );

    const nav = within(screen.getByRole("navigation", { name: "Providers" }));
    expect(nav.queryByRole("list", { name: "Providers" })).toBeNull();
    expect(nav.getByRole("status").textContent).toBe("No providers match.");
    // Twice: the live region AND the visible row. The region is `sr-only`, so
    // asserting only the announcement would let the visible copy be deleted
    // and leave a sighted user staring at a blank rail.
    expect(nav.getAllByText("No providers match.")).toHaveLength(2);
  });

  it("restores every row when the search is cleared", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const input = screen.getByRole("textbox", { name: "Search providers" });
    fireEvent.change(input, { target: { value: "openrouter" } });
    expect(railProviderNames()).toEqual(["OpenRouter"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Clear provider search" }),
    );
    expect(railProviderNames()).toEqual([
      "OpenCode",
      "Traycer Inference",
      "OpenRouter",
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

    fireEvent.click(railProviderRow("Cursor", false));
    expect(screen.getByText("Could not check account status")).toBeDefined();

    fireEvent.click(railProviderRow("Qwen Code", false));
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

    fireEvent.click(railProviderRow(/Traycer/i, false));

    expect(screen.queryByText(/Disabled by/)).toBeNull();
  });

  it("lists OpenCode CLI candidates for OpenRouter and mutates OpenRouter selection", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(railProviderRow(/OpenRouter/i, false));
    selectTab("CLI & Args");

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
          nativeCapabilities: FULL_TABS,
        }),
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("Env");

    expect(screen.getByText("Environment variables")).toBeDefined();
    expect(screen.getByDisplayValue("OPENAI_API_KEY")).toBeDefined();
    expect(
      screen.getByText(/Applied when Traycer spawns the OpenCode/),
    ).toBeDefined();
  });

  // The panel used to carry its own host `Select` in the header - one of four
  // near-identical dropdowns doing one job - and then, briefly, an inert
  // readout of the scoped host. Both are gone: the sidebar owns the scope.
  //
  // Asserting on the host NAME, not on a testid. An earlier version of this
  // test checked that `host-scope-line` was absent, which is unfalsifiable -
  // that testid exists nowhere in the codebase, so the assertion passes no
  // matter what the panel renders. The name is the thing that must not
  // reappear, and the fixture puts it on screen the moment anything prints it.
  it("names no host and offers no host picker, leaving both to the sidebar", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByText("host-a")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Host" })).toBeNull();
    // The controls the header DOES own still render - so this test fails if
    // the fix that moved them inside the gate ever drops them entirely.
    expect(
      screen.getByRole("button", { name: "Refresh all providers" }),
    ).toBeDefined();
  });

  it("puts the global status on the heading row, and says it is global", () => {
    // `checkedAt` is a max over every provider and Refresh re-probes all of
    // them; at the card's top-right it sat inches from the selected provider's
    // Enabled toggle and read as that provider's own status.
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const status = screen.getByTestId("providers-global-status");
    expect(status.textContent).toContain("All providers");
    expect(
      status.contains(
        screen.getByRole("button", { name: "Refresh all providers" }),
      ),
    ).toBe(true);
    expect(document.querySelector("header")?.contains(status)).toBe(true);
  });

  it("refreshes the SELECTED host, never the ambient one", async () => {
    // The wrong-host bug's actual signature. DOM absence cannot see it: the
    // failure was never a missing control, it was a present control resolving
    // the wrong client - so this gives the two hosts distinct identities and
    // asks which one Refresh reached.
    //
    // Moving `HostRuntimeContext.Provider` back below the header - the exact
    // historical regression - makes this fail, because the header would then
    // resolve `ambient` instead of the selected host.
    providerMocks.ambientBinding = {
      hostClient: { getActiveHostId: () => "host-ambient" },
    };
    hostScopeMocks.status = "ready";
    hostScopeMocks.client = { getActiveHostId: () => "host-selected" };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh all providers" }),
    );
    await waitFor(() => {
      expect(providerMocks.refreshedHostIds).toEqual(["host-selected"]);
    });
    expect(providerMocks.refreshedHostIds).not.toContain("host-ambient");
  });

  it("mounts NO global control - and no RPC - until the scope is ready", () => {
    // The real invariant, and the reason this control was kept out of the
    // header for a round. `headerAction` is not gated, so it is only safe
    // because `HostRuntimeContext.Provider` wraps the whole shell EXACTLY when
    // the scope resolved a client. Mounted any earlier, `useHostClient()` falls
    // back to the ambient host - which is how Refresh once re-probed and
    // rewrote the provider list of a host the page was not showing.
    //
    // "Not in the header" was the wrong thing to pin: it forbids a safe
    // implementation. What must hold is that nothing renders, and nothing is
    // requested, while the scope is unresolved.
    hostScopeMocks.status = "unreachable";

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId("providers-global-status")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Refresh all providers" }),
    ).toBeNull();
  });

  it("blocks disabling the last enabled provider", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "traycer",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
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

  describe("three-way Auto/On/Off enablement control", () => {
    function singleProvider(overrides: {
      readonly enabled: boolean;
      readonly enablementMode?: "auto" | "on" | "off";
      readonly enablementSource?:
        "sticky" | "auto-detected" | "auto-undetected";
    }): void {
      providerMocks.listResult.data = {
        providers: [
          {
            ...providerState({
              providerId: "traycer",
              selected: { kind: "bundled" },
              candidates: [],
              envOverrides: [],
              nativeCapabilities: FULL_TABS,
            }),
            enabled: overrides.enabled,
            enablementMode: overrides.enablementMode,
            enablementSource: overrides.enablementSource,
          },
        ],
      };
    }

    it("with enablementMode present, renders the Auto/On/Off select instead of the binary switch and sends mode on change", () => {
      singleProvider({
        enabled: true,
        enablementMode: "auto",
        enablementSource: "auto-detected",
      });

      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );

      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.getByRole("button", { name: "Auto" })).toBeDefined();
      expect(screen.getByRole("button", { name: "On" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Off" })).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "On" }));

      expect(providerMocks.setEnabledMutate).toHaveBeenCalledWith({
        providerId: "traycer",
        // legacyEnabledForMode("on", ...) === true, required alongside mode.
        enabled: true,
        profileAction: null,
        mode: "on",
      });
    });

    it("with enablementMode absent, renders today's binary switch and sends no mode", () => {
      // Two enabled providers so the one-enabled floor doesn't block the click.
      providerMocks.listResult.data = {
        providers: [
          providerState({
            providerId: "traycer",
            selected: { kind: "bundled" },
            candidates: [],
            envOverrides: [],
            nativeCapabilities: FULL_TABS,
          }),
          providerState({
            providerId: "opencode",
            selected: { kind: "bundled" },
            candidates: OPENCODE_CANDIDATES,
            envOverrides: [],
            nativeCapabilities: FULL_TABS,
          }),
        ],
      };
      expect(providerMocks.listResult.data.providers[0]).not.toHaveProperty(
        "enablementMode",
      );

      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );

      expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
      const switchElement = screen.getByRole("switch");
      fireEvent.click(switchElement);

      expect(providerMocks.setEnabledMutate).toHaveBeenCalledTimes(1);
      const variables = firstSetEnabledCall();
      expect(variables).not.toHaveProperty("mode");
      // Default-selected provider is whichever ORDERED_PROVIDERS ranks
      // first (opencode, ahead of traycer) - the row identity isn't the
      // point of this test, the absent `mode` is.
      expect(variables).toMatchObject({
        providerId: "opencode",
        profileAction: null,
      });
    });

    it("shows 'account detected' for auto-detected and 'no account detected' for auto-undetected, and nothing for sticky", () => {
      singleProvider({
        enabled: true,
        enablementMode: "auto",
        enablementSource: "auto-detected",
      });
      const { unmount } = render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(
        screen.getByText("Auto · enabled — account detected"),
      ).toBeDefined();
      unmount();

      singleProvider({
        enabled: false,
        enablementMode: "auto",
        enablementSource: "auto-undetected",
      });
      const { unmount: unmount2 } = render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(
        screen.getByText("Auto · disabled — no account detected"),
      ).toBeDefined();
      unmount2();

      singleProvider({
        enabled: true,
        enablementMode: "on",
        enablementSource: "sticky",
      });
      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(screen.queryByText(/account detected/)).toBeNull();
    });

    it("blocks choosing Off for the last effectively-enabled provider - the floor applies to the tri-state control too", () => {
      singleProvider({
        enabled: true,
        enablementMode: "on",
        enablementSource: "sticky",
      });

      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );

      const offButton = screen.getByRole("button", { name: "Off" });
      if (!(offButton instanceof HTMLButtonElement)) {
        throw new Error("Expected the Off option to render as a button.");
      }
      expect(offButton.disabled).toBe(true);
      fireEvent.click(offButton);
      expect(providerMocks.setEnabledMutate).not.toHaveBeenCalled();
      // ...and the floor hint renders alongside it, same copy as the binary
      // switch's tooltip.
      expect(
        screen.getByText("At least one provider must stay enabled."),
      ).toBeDefined();
    });

    it("does NOT gate switching to Auto by the one-enabled floor - the outcome is the host's to compute", () => {
      singleProvider({
        enabled: true,
        enablementMode: "on",
        enablementSource: "sticky",
      });

      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Auto" }));
      expect(providerMocks.setEnabledMutate).toHaveBeenCalledWith({
        providerId: "traycer",
        // legacyEnabledForMode("auto", currentlyEnabled) === currentlyEnabled.
        enabled: true,
        profileAction: null,
        mode: "auto",
      });
    });

    it("legacyEnabledForMode: on -> true regardless of current effective value", () => {
      singleProvider({
        enabled: false,
        enablementMode: "off",
        enablementSource: "sticky",
      });
      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "On" }));
      expect(providerMocks.setEnabledMutate).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "on", enabled: true }),
      );
    });

    it("legacyEnabledForMode: off -> false regardless of current effective value", () => {
      // Two providers so the floor doesn't block reaching Off on the second.
      providerMocks.listResult.data = {
        providers: [
          {
            ...providerState({
              providerId: "traycer",
              selected: { kind: "bundled" },
              candidates: [],
              envOverrides: [],
              nativeCapabilities: FULL_TABS,
            }),
            enabled: true,
            enablementMode: "on" as const,
            enablementSource: "sticky" as const,
          },
          {
            ...providerState({
              providerId: "opencode",
              selected: { kind: "bundled" },
              candidates: OPENCODE_CANDIDATES,
              envOverrides: [],
              nativeCapabilities: FULL_TABS,
            }),
            enabled: true,
            enablementMode: "on" as const,
            enablementSource: "sticky" as const,
          },
        ],
      };
      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      // Default-selected provider is whichever ORDERED_PROVIDERS ranks first
      // (opencode, ahead of traycer).
      fireEvent.click(screen.getByRole("button", { name: "Off" }));
      expect(providerMocks.setEnabledMutate).toHaveBeenCalledWith({
        providerId: "opencode",
        enabled: false,
        profileAction: null,
        mode: "off",
      });
    });

    it("legacyEnabledForMode: auto -> forwards the CURRENT effective value, not a guess", () => {
      singleProvider({
        enabled: true,
        enablementMode: "on",
        enablementSource: "sticky",
      });
      render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Auto" }));
      const variables = firstSetEnabledCall();
      expect(variables).toMatchObject({ mode: "auto", enabled: true });
    });
  });

  describe("detail pane inert gate: mode, not effective enabled", () => {
    function singleProvider(overrides: {
      readonly enabled: boolean;
      readonly enablementMode?: "auto" | "on" | "off";
      readonly enablementSource?:
        "sticky" | "auto-detected" | "auto-undetected";
    }): void {
      providerMocks.listResult.data = {
        providers: [
          {
            ...providerState({
              providerId: "traycer",
              selected: { kind: "bundled" },
              candidates: [],
              envOverrides: [],
              nativeCapabilities: FULL_TABS,
            }),
            enabled: overrides.enabled,
            enablementMode: overrides.enablementMode,
            enablementSource: overrides.enablementSource,
          },
        ],
      };
    }

    // Load-bearing: an `auto` provider with no detected account is
    // `enabled: false` too. Gating the pane on `!state.enabled` instead of
    // the mode would re-inert exactly this row, blocking the sign-in control
    // that is the only way out of "no account detected".
    it("leaves the pane reachable for an auto-undetected provider even though enabled is false", () => {
      singleProvider({
        enabled: false,
        enablementMode: "auto",
        enablementSource: "auto-undetected",
      });
      const { container } = render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(container.querySelector("[inert]")).toBeNull();
      expect(container.querySelector(".pointer-events-none")).toBeNull();
    });

    it("makes the pane inert when the mode is explicitly Off", () => {
      singleProvider({ enabled: false, enablementMode: "off" });
      const { container } = render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(container.querySelector("[inert]")).not.toBeNull();
      expect(container.querySelector(".pointer-events-none")).not.toBeNull();
    });

    it("leaves the pane reachable when the mode is On", () => {
      singleProvider({
        enabled: true,
        enablementMode: "on",
        enablementSource: "sticky",
      });
      const { container } = render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(container.querySelector("[inert]")).toBeNull();
    });

    it("falls back to !enabled on an old host with no enablementMode", () => {
      singleProvider({ enabled: false });
      const { container, unmount } = render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(container.querySelector("[inert]")).not.toBeNull();
      unmount();

      singleProvider({ enabled: true });
      const { container: container2 } = render(
        <TooltipProvider>
          <ProvidersSettingsPanel />
        </TooltipProvider>,
      );
      expect(container2.querySelector("[inert]")).toBeNull();
    });
  });

  it("renders capability-driven tabs and hides unsupported ones", () => {
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
          providerId: "cursor",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: CURSOR_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openUsageLimitsTab();

    expect(screen.getByRole("tab", { name: "CLI & Args" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Env" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Usage limits" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "MCP" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Plugins" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Skills" })).toBeDefined();

    expectPinnedRailLayout();

    fireEvent.click(railProviderRow("Cursor", false));

    expect(screen.queryByRole("tab", { name: "CLI & Args" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Usage limits" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Env" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "MCP" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Plugins" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Skills" })).toBeDefined();
  });

  it("keeps the current tab across providers when both support it", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "opencode",
          selected: { kind: "bundled" },
          candidates: OPENCODE_CANDIDATES,
          envOverrides: [{ key: "A", value: "1" }],
          nativeCapabilities: FULL_TABS,
        }),
        providerState({
          providerId: "cursor",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [{ key: "B", value: "2" }],
          nativeCapabilities: CURSOR_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("Env");
    expect(screen.getByDisplayValue("A")).toBeDefined();

    fireEvent.click(railProviderRow("Cursor", false));
    expect(screen.getByDisplayValue("B")).toBeDefined();
    expect(
      screen.getByRole("tab", { name: "Env" }).getAttribute("data-state"),
    ).toBe("active");
  });

  // The Account tab renders the API-key field, and Radix UNMOUNTS an inactive
  // `TabsContent`. Held inside the section, a pasted key would be destroyed by
  // an ordinary tab switch - the section used to escape that by sitting outside
  // the tab bar entirely, so moving it onto a tab is what put the draft at
  // risk. A provider switch is the one case that MUST still clear it: a key
  // typed for Cursor appearing in Devin's field would be a far worse bug than
  // losing it.
  it("keeps a typed API key across tab switches, but not across providers", () => {
    const apiKeyProvider = (
      providerId: ProviderCliState["providerId"],
    ): ProviderCliState =>
      providerState({
        providerId,
        selected: { kind: "bundled" },
        candidates: [],
        envOverrides: [],
        nativeCapabilities: CURSOR_TABS,
        apiKey: { supported: true, configured: false, source: null },
      });
    providerMocks.listResult.data = {
      providers: [apiKeyProvider("cursor"), apiKeyProvider("devin")],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("Account");
    const field = (): HTMLInputElement =>
      within(screen.getByRole("tabpanel")).getByLabelText("API key");
    fireEvent.change(field(), { target: { value: "sk-live-secret" } });
    expect(field().value).toBe("sk-live-secret");

    selectTab("Env");
    selectTab("Account");
    expect(field().value).toBe("sk-live-secret");

    fireEvent.click(railProviderRow("Devin", false));
    selectTab("Account");
    expect(field().value).toBe("");
  });

  it("falls back to the first supported tab when the current tab is missing", () => {
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
          providerId: "amp",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: ENV_ONLY_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("MCP");
    expect(screen.getByTestId("provider-mcp-tab")).toBeDefined();

    fireEvent.click(railProviderRow("Amp", false));
    expect(screen.queryByRole("tab", { name: "MCP" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Env" })).toBeDefined();
    expect(screen.getByText("Environment variables")).toBeDefined();
  });

  it("deep-links focusTab once-and-clear alongside focusHarnessId", () => {
    useProvidersFocusStore.getState().setFocusHarnessId("cursor");
    useProvidersFocusStore.getState().setFocusTab("mcp");

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
          providerId: "cursor",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: CURSOR_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByTestId("provider-mcp-tab")).toBeDefined();
    expect(
      screen.getByRole("tab", { name: "MCP" }).getAttribute("data-state"),
    ).toBe("active");
    expect(useProvidersFocusStore.getState().focusHarnessId).toBeNull();
    expect(useProvidersFocusStore.getState().focusTab).toBeNull();
  });

  it("opens the FOCUSED provider's own first tab when no focusTab is given", () => {
    // The "Add API key" CTA sets `focusHarnessId` and no `focusTab`, so the
    // initial tab falls out of the default rule. That default is now
    // provider-dependent (account -> usage -> ...), which makes deriving it
    // from the RAIL'S FIRST provider actively wrong: opencode has no API key
    // and defaults to `usage`, and because amp also advertises `usage` the
    // stale value survives `resolveTabForProvider` and the pane settles on
    // the usage tab - never showing the key field the CTA exists to
    // reach.
    useProvidersFocusStore.getState().setFocusHarnessId("amp");

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
          providerId: "amp",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
          apiKey: { supported: true, configured: false, source: null },
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("tab", { name: "Account" }).getAttribute("data-state"),
    ).toBe("active");
    // Discriminating: the usage tab is rendered and selectable for amp,
    // so this is the deep link picking the right one of two live tabs rather
    // than the wrong one being absent.
    expect(
      screen
        .getByRole("tab", { name: "Usage limits" })
        .getAttribute("data-state"),
    ).toBe("inactive");
    expect(useProvidersFocusStore.getState().focusHarnessId).toBeNull();
  });

  it("ignores focusTab when the target provider does not support it", () => {
    useProvidersFocusStore.getState().setFocusHarnessId("cursor");
    useProvidersFocusStore.getState().setFocusTab("general");

    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "cursor",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: CURSOR_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("tab", { name: "CLI & Args" })).toBeNull();
    expect(
      screen.getByRole("tab", { name: "Env" }).getAttribute("data-state"),
    ).toBe("active");
  });

  it("shows Plugins tab body and Skills tab body", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("Plugins");
    // F5 replaced the "Installed plugins" heading with the shared scope
    // picker. Match the MCP suite's aria-label idiom so this both identifies
    // the Plugins tab body and covers the control the heading used to stand
    // in for.
    expect(
      screen.getByRole("button", { name: /^Plugins location/ }),
    ).toBeDefined();

    selectTab("Skills");
    expect(
      screen.getByRole("textbox", { name: "Search skills" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /^Skills location/ }),
    ).toBeDefined();
  });

  it("does not flush terminal-agent args on keystroke alone", () => {
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "claude-code",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
        }),
      ],
    };
    providerMocks.setTerminalAgentArgsMutate.mockClear();

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("CLI & Args");
    const input = screen.getByPlaceholderText("--dangerously-skip-permissions");
    fireEvent.change(input, { target: { value: "--foo" } });

    expect(providerMocks.setTerminalAgentArgsMutate).not.toHaveBeenCalled();
  });

  it("saves terminal-agent args once across the post-save remount", () => {
    // `TerminalAgentArgsSection` is keyed on `state.terminalAgentArgs`, so a
    // successful save remounts it. That remount is the dangerous moment: any
    // commit-on-unmount or commit-on-mount path would re-fire the mutation
    // with the value it just saved. The `next === saved` guard in `commit()`
    // plus having no unmount cleanup is what keeps it at exactly one call.
    const args = "--foo";
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "claude-code",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
        }),
      ],
    };
    providerMocks.setTerminalAgentArgsMutate.mockClear();

    const view = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    selectTab("CLI & Args");
    const input = screen.getByPlaceholderText("--dangerously-skip-permissions");
    fireEvent.change(input, { target: { value: args } });
    fireEvent.blur(input);

    expect(providerMocks.setTerminalAgentArgsMutate).toHaveBeenCalledTimes(1);
    expect(providerMocks.setTerminalAgentArgsMutate).toHaveBeenCalledWith({
      providerId: "claude-code",
      terminalAgentArgs: args,
    });

    // The host now reports the saved value: the key changes and the section
    // remounts with `saved === draft`.
    providerMocks.listResult.data = {
      providers: [
        providerState({
          providerId: "claude-code",
          selected: { kind: "bundled" },
          candidates: [],
          envOverrides: [],
          nativeCapabilities: FULL_TABS,
          terminalAgentArgs: args,
        }),
      ],
    };
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(providerMocks.setTerminalAgentArgsMutate).toHaveBeenCalledTimes(1);
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
    expect(addProfileButton.getAttribute("data-variant")).toBe("default");
    expect(addProfileButton.getAttribute("data-size")).toBe("sm");
    expect(screen.getByText("Profiles")).toBeDefined();
    const manageProfileButton = screen.getByRole("button", {
      name: "Manage profile",
    });
    expect(manageProfileButton.getAttribute("data-variant")).toBe("outline");
    expect(manageProfileButton.getAttribute("data-size")).toBe("xs");
    const profileSummaryActions = manageProfileButton.closest(
      '[data-slot="profile-summary-actions"]',
    );
    if (!(profileSummaryActions instanceof HTMLElement)) {
      throw new Error("Expected profile summary and actions row");
    }
    expect(within(profileSummaryActions).queryByText("No plan")).toBeNull();
    expect(
      profileSummaryActions.querySelectorAll('[data-slot="badge"]'),
    ).toHaveLength(1);
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
    expect(tooltipTextNear(removeProfileTooltipTrigger)).toBe(
      removeProfileDisabledReason,
    );
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
    // The add-profile button now sits inside the span that lets its tooltip
    // fire while it is disabled, so adjacency is measured from that span.
    // Both buttons now sit inside the span that lets their tooltip fire while
    // disabled, so adjacency is asserted between those spans.
    expect(
      addProfileButton.parentElement?.nextElementSibling?.contains(
        refreshButton,
      ),
    ).toBe(true);
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
        terminalLogin: null,
      },
    };
    const renderSection = (hostId: string): ReactNode => (
      <TooltipProvider>
        <ProviderProfileScopedSection
          state={state}
          hostId={hostId}
          isSelectedHostLocal
          canAddProfile
          signInUnavailableHint={null}
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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

    openProfilesTab();

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
    const manageProfileButton = screen.getByRole("button", {
      name: "Manage profile",
    });
    const profileSummaryActions = manageProfileButton.closest(
      '[data-slot="profile-summary-actions"]',
    );
    if (!(profileSummaryActions instanceof HTMLElement)) {
      throw new Error("Expected signed-out profile summary and actions row");
    }
    expect(
      within(profileSummaryActions).getByText("Signed out", {
        selector: '[data-slot="badge"]',
      }),
    ).toBeDefined();
    expect(
      within(profileSummaryActions).getByRole("button", { name: "Sign in" }),
    ).toBeDefined();
    expect(
      within(profileSummaryActions).getByRole("button", {
        name: "Manage profile",
      }),
    ).toBe(manageProfileButton);
    expect(within(profileSummaryActions).queryByText("No plan")).toBeNull();
    expect(
      profileSummaryActions.querySelectorAll('[data-slot="badge"]'),
    ).toHaveLength(1);
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

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    const view = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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

    openProfilesTab();

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

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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

    openProfilesTab();

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

    openProfilesTab();

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

    openProfilesTab();

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
  });

  it("ignores an in-flight ambient re-poll that resolves after the sign-in was cancelled", async () => {
    providerMocks.listResult.data = {
      providers: [codePasteReauthProviderState()],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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

    openProfilesTab();

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

    openProfilesTab();

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

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
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
    // The scope mock's `setHostId` is inert, so model the applied switch: the
    // rail consumes a profile intent only when the host on screen IS the
    // intent's target (the foreign-host case is covered separately).
    hostScopeMocks.hostId = "local";

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // The usage tab is now the default first tab for providers without an
    // API-key Account tab, so startSignIn opens the dialog immediately. That
    // dialog aria-hides the tab rail; openProfilesTab is unnecessary and would
    // fail getByRole("tab") without { hidden: true }.
    expect(
      railProviderRow("Claude Code", true).getAttribute("data-active"),
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
    // Sign-in intent, but a CHANGED account: the acknowledgment survives the
    // same-account auto-close, because this notice is the only thing telling
    // the user the profile was rebound. Nothing settled, so no toast either.
    expect(
      screen.getByRole("dialog", { name: "Sign in to Work" }),
    ).toBeDefined();
    expect(toast.success).not.toHaveBeenCalled();

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

  it("closes the whole dialog with a toast when a sign-in-intent reconnect returns the same account", async () => {
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

    // The row's own "Sign in" button - sign-in intent, so the dialog exists
    // for the sign-in and nothing else.
    fireEvent.click(screen.getByRole("menuitem", { name: "Work, Signed out" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalled();
    });
    expect(
      screen.getByRole("dialog", { name: "Sign in to Work" }),
    ).toBeDefined();

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
              // The same account the signed-out row already named.
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

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Sign in to Work" }),
      ).toBeNull();
    });
    // Not merely skipped on the way out - never rendered. The acknowledgment
    // confirmed something the host had already persisted, then stranded the
    // user on an edit form whose only exit was Cancel.
    expect(screen.queryByText("Signed in as")).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit profile" })).toBeNull();
    expect(toast.success).toHaveBeenCalledWith(
      `Signed in as ${redactEmail("work@example.test")}`,
    );
  });

  it("freezes the entry row so the header and the changed-account notice survive the list committing the new identity", async () => {
    providerMocks.listResult.data = {
      providers: [codexWithManaged(workProfileSignedInAs("work@example.test"))],
    };

    const view = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

    fireEvent.click(screen.getByRole("menuitem", { name: "Work, Signed out" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

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

    // Production ordering, which a static fixture would otherwise hide:
    // `providers.awaitLogin`'s hook-level `onSuccess` commits the fresh row
    // into the `providers.list` cache, and query-core AWAITS that before the
    // flow's own per-call `onSuccess` settles the step. So the row this panel
    // reads ALREADY names the new account by the first render of the settled
    // step - it cannot be the "before" side of the comparison.
    //
    // The re-render is the load-bearing half: mutating the fixture alone
    // changes nothing, because the settle below re-renders only the panel
    // LEAF, while the profile row is a prop from an ancestor. `setQueryData`
    // is what re-renders that ancestor in production.
    providerMocks.listResult.data = {
      providers: [
        codexWithManaged(workProfileSignedInAs("personal@example.test")),
      ],
    };
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    act(() => {
      awaitOptions.onSuccess({
        state: { profiles: [workProfileSignedInAs("personal@example.test")] },
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
    expect(
      screen.getByRole("button", { name: "Keep new account" }),
    ).toBeDefined();
    // And emphatically NOT the same-account auto-close: rebinding a profile to
    // a different account must never be the silent path.
    expect(
      screen.getByRole("dialog", { name: "Sign in to Work" }),
    ).toBeDefined();
    expect(toast.success).not.toHaveBeenCalled();
    // The header names the journey the user started, not the state the commit
    // above produced - a profile that was signed out is still "Signing in",
    // never relabelled mid-flow as an account SWITCH it never was.
    expect(screen.getByText("Signing in")).toBeDefined();
    expect(screen.queryByText("Switching account")).toBeNull();
  });

  it("closes a sign-in-intent dialog once the user acknowledges a changed account", async () => {
    providerMocks.listResult.data = {
      providers: [codexWithManaged(workProfileSignedInAs("work@example.test"))],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

    fireEvent.click(screen.getByRole("menuitem", { name: "Work, Signed out" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

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
    act(() => {
      awaitOptions.onSuccess({
        state: { profiles: [workProfileSignedInAs("personal@example.test")] },
      });
    });

    // The notice still gets its stop - that is the whole carve-out.
    fireEvent.click(screen.getByRole("button", { name: "Keep new account" }));

    // But acknowledging it ends the dialog rather than handing back an edit
    // form with nothing staged in it: the user came here to sign in, and the
    // sign-in is over however the account came back.
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Sign in to Work" }),
      ).toBeNull();
    });
    expect(screen.queryByRole("dialog", { name: "Edit profile" })).toBeNull();
    // No toast on this path: the notice they just confirmed WAS the
    // confirmation, so nothing was taken away for a toast to replace.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps the acknowledgment and the open dialog when a same-account reconnect came from Switch account", async () => {
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

    // Manage-profile intent: the name/color fields are live and uncommitted
    // until "Save changes", so this entry must land back on the form.
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

    expect(screen.getByText("Signed in as")).toBeDefined();
    expect(screen.getByRole("button", { name: "Done" })).toBeDefined();
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeDefined();
    expect(toast.success).not.toHaveBeenCalled();

    // And Done still returns to the form rather than closing over the top of
    // whatever the user was editing.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Switch account" }),
    ).toBeDefined();
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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

  it("does not offer the share-skills-and-plugins checkbox for codex (overlay layout, not a bug)", () => {
    // Codex's exclusion is CORRECT: seedManagedProfileDir honours
    // shareSkillsAndPlugins only on the partial-overlay layout branch
    // (profile-seeding.ts), and codex takes the overlay branch whose seeding
    // never reads the flag. Offering the checkbox here would send a request
    // the host silently discards. Do not "fix" this by adding codex to
    // PROVIDER_SHARES_SKILLS_AND_PLUGINS without changing the host layout.
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
        "Terminal account already uses this account and organization. Sign in again and choose a different organization.",
      ),
    ).toBeDefined();
    expect(providerMocks.recolorProfileMutate).not.toHaveBeenCalled();
    expect(providerMocks.removeProfileMutate).not.toHaveBeenCalled();

    // "Sign in again" restarts the OAuth flow so the user can pick a
    // different org in the browser picker (not a dead-end Done-only state).
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => {
      expect(providerMocks.startLoginMutate).toHaveBeenCalledTimes(2);
    });
    const retryCall = providerMocks.startLoginMutate.mock.calls.at(1);
    if (retryCall === undefined) {
      throw new Error("Expected a second start login call.");
    }
    expect(retryCall[0]).toEqual({
      providerId: "codex",
      profileId: null,
      createProfile: { label: "New profile", shareSkillsAndPlugins: false },
    });
  });

  it("holds on a post-auth naming step when the new profile shares an email with an existing one", () => {
    const ambient = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Terminal account",
      email: "shared@example.test",
      tier: "Pro",
      authStatus: "authenticated",
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
    });
    const created = profile({
      profileId: "managed-1",
      kind: "managed",
      label: "New profile",
      email: "shared@example.test",
      tier: "Team",
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
            profiles: [ambient],
          }),
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        state: { profiles: [ambient, created] },
        existingProfileId: null,
      });
    });

    // Email collision holds the dialog open on the resolved identity instead
    // of auto-finalizing - the split-by-org case that minting distinct
    // same-email profiles makes possible.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeDefined();
    expect(within(dialog).getByText("Signed in as")).toBeDefined();
    expect(
      within(dialog).getByText(redactEmail("shared@example.test")),
    ).toBeDefined();
    expect(within(dialog).getByText("Team")).toBeDefined();
    expect(
      within(dialog).getByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeDefined();
    expect(
      within(dialog).getByRole("button", { name: "Save profile" }),
    ).toBeDefined();
    expect(providerMocks.recolorProfileMutate).not.toHaveBeenCalled();
    expect(providerMocks.renameProfileMutate).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText("Profile name")).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("auto-finalizes without a naming step when the new profile's email is unique", async () => {
    const ambient = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Terminal account",
      email: "ambient@example.test",
      tier: null,
      authStatus: "authenticated",
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
    });
    const created = profile({
      profileId: "managed-1",
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
            profiles: [ambient],
          }),
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        state: { profiles: [ambient, created] },
        existingProfileId: null,
      });
    });

    // Single-account / unique-email path must keep auto-finalizing - the
    // naming step is only for the collision case.
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(
      screen.queryByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeNull();
    expect(providerMocks.renameProfileMutate).not.toHaveBeenCalled();

    const [, recolorOptions] = firstRecolorProfileCall();
    act(() => recolorOptions.onSuccess());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("saves an unedited naming-step label without calling rename", async () => {
    const ambient = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Terminal account",
      email: "shared@example.test",
      tier: null,
      authStatus: "authenticated",
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
    });
    const created = profile({
      profileId: "managed-1",
      kind: "managed",
      label: "New profile",
      email: "shared@example.test",
      tier: null,
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
            profiles: [ambient],
          }),
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        state: { profiles: [ambient, created] },
        existingProfileId: null,
      });
    });

    expect(screen.getByRole("button", { name: "Save profile" })).toBeDefined();
    // Label is still the host default - Save must finalize without a rename
    // RPC (empty labels are disabled; "New profile" is a real non-empty value).
    expect(screen.getByLabelText("Profile name")).toHaveProperty(
      "value",
      "New profile",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(providerMocks.renameProfileMutate).not.toHaveBeenCalled();
    expect(providerMocks.recolorProfileMutate).toHaveBeenCalledTimes(1);

    const [, recolorOptions] = firstRecolorProfileCall();
    act(() => recolorOptions.onSuccess());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("renames then finalizes when the naming-step label is edited before Save", async () => {
    const ambient = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Terminal account",
      email: "shared@example.test",
      tier: null,
      authStatus: "authenticated",
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
    });
    const created = profile({
      profileId: "managed-1",
      kind: "managed",
      label: "New profile",
      email: "shared@example.test",
      tier: null,
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
            profiles: [ambient],
          }),
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        state: { profiles: [ambient, created] },
        existingProfileId: null,
      });
    });

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Work org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    const [renameVariables, renameOptions] = firstRenameProfileCall();
    expect(renameVariables).toEqual({
      providerId: "codex",
      profileId: "managed-1",
      label: "Work org",
    });
    act(() => renameOptions.onSuccess());
    expect(providerMocks.recolorProfileMutate).toHaveBeenCalledTimes(1);

    const [, recolorOptions] = firstRecolorProfileCall();
    act(() => recolorOptions.onSuccess());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("keeps the naming step open with an inline error when rename fails, and allows retry", async () => {
    const ambient = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Terminal account",
      email: "shared@example.test",
      tier: null,
      authStatus: "authenticated",
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
    });
    const created = profile({
      profileId: "managed-1",
      kind: "managed",
      label: "New profile",
      email: "shared@example.test",
      tier: null,
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
            profiles: [ambient],
          }),
          loginCapability: {
            oauthArgs: ["auth", "login"],
            token: null,
            codePaste: null,
            terminalLogin: null,
          },
        },
      ],
    };

    const view = render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
    const [, awaitOptions] = firstAwaitLoginCall();
    act(() => {
      awaitOptions.onSuccess({
        state: { profiles: [ambient, created] },
        existingProfileId: null,
      });
    });

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Work org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(providerMocks.renameProfileMutate).toHaveBeenCalledTimes(1);

    // Simulate a failed rename mutation: no onSuccess, surface the error
    // the dialog reads from the rename hook, then re-render.
    act(() => {
      providerMocks.renameProfileError = new Error("rename failed");
    });
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(
      screen.getByText("Couldn't save the name. Try again."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDefined();
    expect(providerMocks.recolorProfileMutate).not.toHaveBeenCalled();

    // Retry: clear the prior error and let the second Save succeed.
    act(() => {
      providerMocks.renameProfileError = null;
    });
    view.rerender(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(providerMocks.renameProfileMutate).toHaveBeenCalledTimes(2);
    const [, retryRenameOptions] =
      providerMocks.renameProfileMutate.mock.calls.at(1) ?? [];
    if (retryRenameOptions === undefined) {
      throw new Error("Expected a second rename call.");
    }
    act(() => retryRenameOptions.onSuccess());
    expect(providerMocks.recolorProfileMutate).toHaveBeenCalledTimes(1);

    const [, recolorOptions] = firstRecolorProfileCall();
    act(() => recolorOptions.onSuccess());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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

    openProfilesTab();

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

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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
            terminalLogin: null,
          },
        },
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openProfilesTab();

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

// -----------------------------------------------------------------------------
// Mobile section picker: below `md`, `ProviderDetail` swaps the desktop tab rail
// for a dropdown (see `provider-section-select.tsx`). A separate, top-level
// `describe` rather than nesting inside the suite above - it needs its own
// narrow-viewport `beforeEach`/`afterEach` (the outer suite's tests assume the
// default 1024px width), and keeping the override scoped to these tests is what
// stops it leaking into every test above or below.
// -----------------------------------------------------------------------------

// Radix Select opens from a click on the trigger, and the trigger is named by
// its `aria-label` - which is what tells it apart from the PROVIDER select one
// row above it. Not "the only other combobox on this screen" any more: a
// provider whose `enablementMode` is set (the three-way Auto/On/Off control)
// renders a THIRD one, labelled "Availability" via its `<label htmlFor>`. No
// fixture in this describe block sets `enablementMode`, so that one never
// mounts here - but a query by name is what keeps this helper correct if a
// future fixture in this file does.
function openSectionPicker(): void {
  fireEvent.click(screen.getByRole("combobox", { name: "Section" }));
}

/**
 * The section picker's own rendered items, scoped to ITS `Select` root - not
 * `screen`, which also holds the always-mounted `ProvidersMobileSelect` one
 * row above it (same collision `railProviderRow` exists for). The mock
 * renders a `Select`'s trigger and content as siblings under one wrapping
 * element (see the `@/components/ui/select` mock), and the trigger is
 * `role="combobox"` rather than `"button"`, so scoping to that sibling group
 * and querying `role="button"` reaches exactly the section rows and nothing
 * else on the page.
 */
function sectionPicker(): BoundFunctions<typeof queries> {
  const trigger = screen.getByRole("combobox", { name: "Section" });
  const root = trigger.parentElement;
  if (root === null) {
    throw new Error("Section picker trigger has no parent element");
  }
  return within(root);
}

// `FULL_TABS` (general/env/usage/mcp/plugins/skills) has no `account` or
// `modelProviders` entry, so it cannot exercise every section row. This adds
// both, on top of the same `mcp`/`plugins`/`skills` capability blocks.
const PICKER_EIGHT_TABS: ProviderNativeCapabilities = {
  ...FULL_TABS,
  supportedTabs: [
    "general",
    "usage",
    "env",
    "modelProviders",
    "mcp",
    "plugins",
    "skills",
  ],
};

// Advertises only `general` and `mcp`; combined with `apiKey.supported` below
// this yields exactly three tabs (account, general, mcp) via
// `supportedTabsFor` - see `provider-settings-tabs.ts`.
const PICKER_THREE_TABS: ProviderNativeCapabilities = {
  supportedTabs: ["general", "mcp"],
  mcp: SAMPLE_MCP,
  plugins: null,
  skills: null,
  modelProviders: null,
};

function pickerProviderState(input: {
  readonly providerId: ProviderCliState["providerId"];
  readonly nativeCapabilities: ProviderNativeCapabilities;
}): ProviderCliState {
  return providerState({
    providerId: input.providerId,
    selected: { kind: "bundled" },
    candidates: [],
    envOverrides: [],
    nativeCapabilities: input.nativeCapabilities,
    // These fixtures need `account` among the sections, and `supportedTabsFor`
    // derives that one from the API key rather than from the advertisement.
    apiKey: { supported: true, configured: false, source: null },
  });
}

describe("<ProvidersSettingsPanel /> mobile section picker", () => {
  beforeEach(() => {
    // `useIsMobileViewport` reads `window.innerWidth` directly (not
    // `matchMedia().matches`, which the global test shim always reports as
    // `false`), so setting it before render is enough to force the phone
    // presentation.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    useProvidersFocusStore.setState({
      focusHarnessId: null,
      focusHostId: null,
      focusTargetHostId: null,
      focusProfileId: null,
      startSignIn: false,
      focusTab: null,
    });
    hostScopeMocks.setHostId.mockClear();
    hostScopeMocks.hostId = "host-a";
    hostScopeMocks.host = undefined;
    hostScopeMocks.status = undefined;
    hostScopeMocks.client = null;
    // Default fixture for the "entering a provider" tests below: a single
    // provider advertising every hub section.
    providerMocks.listResult.data = {
      providers: [
        pickerProviderState({
          providerId: "claude-code",
          nativeCapabilities: PICKER_EIGHT_TABS,
        }),
      ],
    };
    providerMocks.listResult.isError = false;
    providerMocks.listResult.error = undefined;
  });

  afterEach(() => {
    cleanup();
    // Restore before the next file's tests (or the suite above, if test order
    // ever changes) see the default desktop width again.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    useProvidersFocusStore.setState({
      focusHarnessId: null,
      focusHostId: null,
      focusTargetHostId: null,
      focusProfileId: null,
      startSignIn: false,
      focusTab: null,
    });
  });

  it("offers every supported section as a dropdown row, in the desktop order", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // The card grid this replaced was a `TabsPrimitive.List` of tab triggers,
    // and it was the whole of the phone rail. Nothing renders one now.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    openSectionPicker();

    // Same list and same labels the desktop rail draws, in `PROVIDER_TAB_ORDER`
    // - the point of the swap is that only the CONTAINER differs. Compared as
    // one ordered array rather than eight presence checks, since the order is
    // half of what is being asserted.
    expect(
      sectionPicker()
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Account",
      "Profiles & Limits",
      "CLI & Args",
      "Env",
      "Model Providers",
      "MCP",
      "Plugins",
      "Skills",
    ]);
  });

  it("shows the picked section's body without a second gesture", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openSectionPicker();
    fireEvent.click(sectionPicker().getByRole("button", { name: "Env" }));

    expect(screen.getByText("Environment variables")).toBeDefined();
    expect(screen.getByRole("tabpanel")).toBeDefined();

    // The dropdown holds the selection it was given: reopening it marks Env as
    // the checked row. Asserted through `data-state` rather than
    // `aria-selected`, which Radix only sets on the FOCUSED item.
    openSectionPicker();
    expect(
      sectionPicker()
        .getByRole("button", { name: "Env" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });

  it("keeps every inactive section pane hidden", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openSectionPicker();
    fireEvent.click(sectionPicker().getByRole("button", { name: "Env" }));

    // The dead-space regression this pins, now owned entirely by Radix. It
    // mounts EVERY pane's div - active or not - and hides the inactive ones
    // through a computed `hidden` that caller props spread over, so a phone arm
    // that passes `hidden` with `false` or `undefined` (rather than omitting
    // the key) un-hides all seven empty panes and their stacked vertical
    // paddings render as a blank band above or below the active body.
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    const mounted = screen.getAllByRole("tabpanel", { hidden: true });
    expect(mounted).toHaveLength(8);
    expect(mounted.filter((pane) => pane.hasAttribute("hidden"))).toHaveLength(
      7,
    );
  });

  it("names each section pane, since a phone renders no tab to name it after", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // Radix points a pane's `aria-labelledby` at the trigger that selects it.
    // The dropdown replaces the whole `TabsList`, so that id names an element
    // that is not rendered - the phone arm labels the pane by its section
    // instead, and clears the dangling reference.
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBeNull();
    expect(panel.getAttribute("aria-label")).toBe("Account");
  });

  it("opens a deep link straight on the requested tab", () => {
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
    useProvidersFocusStore.setState({
      focusHarnessId: "opencode",
      focusTab: "env",
    });

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // The deep link's section is the one on screen, and it is READABLE on
    // arrival rather than merely present in the DOM - a phone spends no gesture
    // on a chooser for a question the caller already answered.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText("Environment variables")).toBeDefined();
    expect(screen.getByRole("tabpanel").getAttribute("aria-label")).toBe("Env");
  });

  it("renders exactly a 3-section provider's sections, no others", () => {
    providerMocks.listResult.data = {
      providers: [
        pickerProviderState({
          providerId: "amp",
          nativeCapabilities: PICKER_THREE_TABS,
        }),
      ],
    };

    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    openSectionPicker();

    expect(
      sectionPicker()
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Account", "CLI & Args", "MCP"]);
  });

  it("keeps the same tabpanel element mounted when the active section is re-picked", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    const panel = screen.getByRole("tabpanel");

    // Re-picking the section that is already active is a no-op selection, not
    // a remount: Radix only calls `onValueChange` when the value actually
    // changes, so the body keeps its queries, scroll position and half-typed
    // fields.
    openSectionPicker();
    fireEvent.click(sectionPicker().getByRole("button", { name: "Account" }));

    expect(screen.getByRole("tabpanel")).toBe(panel);
  });

  it("does not make the section pane a scroll box on a phone", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // Checked as exact class-LIST membership rather than a substring: the
    // `md:`-prefixed class contains the unprefixed one as a substring
    // (`md:overflow-y-auto` contains `overflow-y-auto`), so a substring check
    // cannot tell "scrolls at every width" from "scrolls from md up" apart -
    // and telling those two apart is the entire point of this assertion.
    // jsdom applies no CSS and computes no layout, so the class list is the
    // only observable this test has for which breakpoint a scroll declaration
    // lives under.
    const panel = screen.getByRole("tabpanel");
    const classes = panel.className.split(" ");
    expect(classes).not.toContain("overflow-y-auto");
    expect(classes).not.toContain("min-h-0");
    expect(classes).toContain("md:overflow-y-auto");
    expect(classes).toContain("md:min-h-0");
  });

  it("drops the panel blurb on a phone so the sync line shares the heading row", () => {
    render(
      <TooltipProvider>
        <ProvidersSettingsPanel />
      </TooltipProvider>,
    );

    // The blurb's absence is what keeps the global status control on the
    // title's own line: the shell header is a wrapping row of
    // [title + description] and [action], and the description's max-content
    // width alone exceeds a phone-width row, which pushes the action onto a
    // row of its own.
    expect(screen.queryByText(/Choose the CLI binary/)).toBeNull();
    expect(screen.getByTestId("providers-global-status")).toBeDefined();
  });
});
