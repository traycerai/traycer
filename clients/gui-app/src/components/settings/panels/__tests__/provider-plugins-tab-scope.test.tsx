import type {
  ProviderNativeScope,
  ProviderPlugin,
  ProvidersPluginsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderPluginsTab } from "@/components/settings/panels/provider-plugins-tab";
import {
  nativeScopeFolderActionMocks,
  nativeScopeResolvedWorkspaceMocks,
  nativeScopeWorktreeMocks,
  resetNativeScopeTestMocks,
} from "@/components/settings/panels/__tests__/provider-native-scope-test-mocks";
import { useProvidersWorkspaceSelectionStore } from "@/stores/settings/providers-workspace-selection-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

/**
 * F5: Plugins tab reuses `useProviderNativeScope` + `McpScopePicker` with
 * locationLabel "Plugins location". List and mutate must stamp the selected
 * scope and workspaceRoot — not hardcode global.
 */

const pluginMocks = vi.hoisted(() => ({
  plugins: [] as ProviderPlugin[],
  listCalls: [] as Array<{
    providerId: string;
    scope: string;
    workspaceRoot: string | null;
    enabled: boolean;
  }>,
  mutate: vi.fn(),
  mutateCalls: [] as Array<{
    providerId: string;
    scope: ProviderNativeScope;
    workspaceRoot: string | null;
    mutation: ProvidersPluginsMutateAction;
    suppressToast: boolean | undefined;
  }>,
  mutateIsPending: false,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => "host-1",
  }),
  useHostBinding: () => ({
    hostClient: {
      getActiveHostId: () => "host-1",
    },
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: nativeScopeResolvedWorkspaceMocks.folders,
    isLoading: nativeScopeResolvedWorkspaceMocks.isLoading,
    isFetching: nativeScopeResolvedWorkspaceMocks.isFetching,
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  useWorkspaceFolderActionsForClient: () => ({
    isPreparing: nativeScopeFolderActionMocks.isPreparing,
    isRemoving: false,
    prepareFoldersMutation: null,
    removeEpicRepoMutation: null,
    pickAndPrepareFolders: nativeScopeFolderActionMocks.pickAndPrepareFolders,
  }),
  preparedWorkspaceFolderToWorkspaceFolderInfo: (
    folder: { workspacePath: string; workspaceName: string },
    hostId: string | null,
  ) => ({
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: null,
    hostId,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: nativeScopeWorktreeMocks.loaded
      ? { workspaces: nativeScopeWorktreeMocks.workspaces }
      : undefined,
    isPending: nativeScopeWorktreeMocks.pending,
  }),
}));

vi.mock("@/hooks/providers/use-providers-plugins-list-query", () => ({
  useProvidersPluginsList: (args: {
    providerId: string;
    scope: string;
    workspaceRoot: string | null;
    enabled: boolean;
  }) => {
    pluginMocks.listCalls.push(args);
    if (!args.enabled) {
      return {
        data: undefined,
        isLoading: false,
        isPending: false,
        isError: false,
        error: null,
      };
    }
    return {
      data: { plugins: pluginMocks.plugins },
      isLoading: false,
      isPending: false,
      isError: false,
      error: null,
    };
  },
}));

vi.mock("@/hooks/providers/use-providers-plugins-mutate-mutation", () => ({
  useProvidersPluginsMutate: () => ({
    mutate: (
      variables: {
        providerId: string;
        scope: ProviderNativeScope;
        workspaceRoot: string | null;
        mutation: ProvidersPluginsMutateAction;
        suppressToast: boolean | undefined;
      },
      opts: {
        onSuccess: () => void;
        onError: (err: { message: string }) => void;
      },
    ) => {
      pluginMocks.mutateCalls.push(variables);
      pluginMocks.mutate(variables, opts);
    },
    isPending: pluginMocks.mutateIsPending,
  }),
}));

vi.mock("@/hooks/providers/use-providers-plugin-icon-query", () => ({
  useProvidersPluginIcon: () => ({ data: undefined }),
}));

const BOTH_SCOPES: readonly ProviderNativeScope[] = ["global", "project"];

function multiScopeCaps(over: {
  readonly add: readonly ProviderNativeScope[] | undefined;
  readonly remove: readonly ProviderNativeScope[] | undefined;
  readonly setEnabled: readonly ProviderNativeScope[] | undefined;
  readonly addModes:
    | Array<"read-only" | "cli-source" | "marketplace" | "file-drop" | "patch">
    | undefined;
}): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["plugins"],
      mcp: null,
      plugins: {
        addModes: over.addModes ?? ["cli-source"],
        marketplaceBrowse: false,
        traycerSessionToolsNotice: false,
        actionScopes: {
          list: [...BOTH_SCOPES],
          add: [...(over.add ?? BOTH_SCOPES)],
          remove: [...(over.remove ?? BOTH_SCOPES)],
          setEnabled: [...(over.setEnabled ?? BOTH_SCOPES)],
        },
      },
      skills: null,
      modelProviders: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

function defaultMultiScopeCaps(): ProviderCliState {
  return multiScopeCaps({
    add: undefined,
    remove: undefined,
    setEnabled: undefined,
    addModes: undefined,
  });
}

function plugin(over: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: "pdf@openai",
    name: "pdf",
    version: "1.0.0",
    enabled: true,
    source: "openai",
    readOnly: false,
    description: null,
    displayName: "PDF",
    hasIcon: false,
    hasDarkIcon: false,
    ...over,
  };
}

function seedWorkspace(): void {
  useWorkspaceFoldersStore.setState({
    byHost: {
      "host-1": {
        folders: ["/Users/dev/app"],
        folderInfoByPath: {
          "/Users/dev/app": {
            path: "/Users/dev/app",
            name: "app",
            repoIdentifier: null,
            hostId: "host-1",
          },
        },
        primaryPath: null,
      },
    },
  });
  nativeScopeResolvedWorkspaceMocks.folders = [
    { kind: "local-only", path: "/Users/dev/app", name: "app" },
  ];
  useProvidersWorkspaceSelectionStore.setState({
    selectedByHostId: {},
  });
}

function scopeTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^Plugins location/ });
}

function chooseScopeOption(name: RegExp): void {
  fireEvent.click(scopeTrigger());
  fireEvent.click(screen.getByRole("option", { name }));
}

describe("<ProviderPluginsTab /> scope (F5)", () => {
  beforeEach(() => {
    pluginMocks.plugins = [];
    pluginMocks.listCalls = [];
    pluginMocks.mutate.mockReset();
    pluginMocks.mutateCalls = [];
    pluginMocks.mutateIsPending = false;
    resetNativeScopeTestMocks();
    seedWorkspace();
  });

  afterEach(() => {
    cleanup();
  });

  it("lists with global scope and null workspaceRoot by default", () => {
    pluginMocks.plugins = [plugin({})];
    render(<ProviderPluginsTab state={defaultMultiScopeCaps()} />);

    const globalCall = pluginMocks.listCalls.find(
      (c) => c.scope === "global" && c.enabled,
    );
    expect(globalCall).toBeDefined();
    expect(globalCall?.workspaceRoot).toBeNull();
    expect(globalCall?.providerId).toBe("codex");
    expect(screen.getByText("PDF")).toBeDefined();
  });

  it("labels the scope picker Plugins location (not MCP)", () => {
    render(<ProviderPluginsTab state={defaultMultiScopeCaps()} />);

    expect(scopeTrigger().getAttribute("aria-label")).toMatch(
      /^Plugins location:/,
    );
    expect(
      screen.queryByRole("button", { name: /^MCP config location/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Skills location/ }),
    ).toBeNull();
  });

  it("switches to project scope and stamps workspaceRoot on list", () => {
    pluginMocks.plugins = [plugin({})];
    render(<ProviderPluginsTab state={defaultMultiScopeCaps()} />);

    chooseScopeOption(/app/);

    const projectCall = pluginMocks.listCalls.find(
      (c) =>
        c.scope === "project" &&
        c.enabled &&
        c.workspaceRoot === "/Users/dev/app",
    );
    expect(projectCall).toBeDefined();
    expect(scopeTrigger().textContent).toContain("app");
  });

  it("carries the selected project scope on remove mutate", () => {
    pluginMocks.plugins = [plugin({})];
    render(
      <ProviderPluginsTab
        state={multiScopeCaps({
          add: undefined,
          remove: BOTH_SCOPES,
          setEnabled: [],
          addModes: undefined,
        })}
      />,
    );

    chooseScopeOption(/app/);
    // aria-label uses install `name` ("pdf"), not displayName ("PDF").
    fireEvent.click(screen.getByRole("button", { name: /Remove pdf/ }));
    const confirm = screen.getByTestId("confirm-destructive-dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));

    expect(pluginMocks.mutateCalls).toEqual([
      {
        providerId: "codex",
        scope: "project",
        workspaceRoot: "/Users/dev/app",
        mutation: { action: "remove", id: "pdf@openai" },
        suppressToast: true,
      },
    ]);
  });

  it("carries the selected project scope on add mutate", () => {
    pluginMocks.plugins = [];
    render(
      <ProviderPluginsTab
        state={multiScopeCaps({
          add: BOTH_SCOPES,
          remove: undefined,
          setEnabled: undefined,
          addModes: ["cli-source"],
        })}
      />,
    );

    chooseScopeOption(/app/);
    fireEvent.click(screen.getByRole("button", { name: /Add from source/ }));
    fireEvent.change(screen.getByLabelText(/Source/), {
      target: { value: "demo@marketplace" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Install$/ }));

    expect(pluginMocks.mutateCalls).toEqual([
      {
        providerId: "codex",
        scope: "project",
        workspaceRoot: "/Users/dev/app",
        mutation: { action: "add", source: "demo@marketplace" },
        suppressToast: true,
      },
    ]);
  });

  it("shows project-needs-workspace empty state when project has no root", () => {
    // Zero host workspaces + project selected (via locked project-only caps)
    // is the empty state; multi-scope with no selection falls back carefully.
    useWorkspaceFoldersStore.setState({
      byHost: {
        "host-1": {
          folders: [],
          folderInfoByPath: {},
          primaryPath: null,
        },
      },
    });
    nativeScopeResolvedWorkspaceMocks.folders = [];
    useProvidersWorkspaceSelectionStore.setState({
      selectedByHostId: {},
    });

    const projectOnly: ProviderCliState = {
      ...defaultMultiScopeCaps(),
      nativeCapabilities: {
        supportedTabs: ["plugins"],
        mcp: null,
        plugins: {
          addModes: ["cli-source"],
          marketplaceBrowse: false,
          traycerSessionToolsNotice: false,
          actionScopes: {
            list: ["project"],
            add: ["project"],
            remove: ["project"],
            setEnabled: ["project"],
          },
        },
        skills: null,
        modelProviders: null,
      },
    };

    render(<ProviderPluginsTab state={projectOnly} />);

    expect(screen.getByText("Select a workspace")).toBeDefined();
    expect(
      screen.getByText(
        "Choose a project workspace above to manage project-scoped plugins on this host.",
      ),
    ).toBeDefined();
    // List must not run without a root.
    expect(pluginMocks.listCalls.every((c) => !c.enabled)).toBe(true);
  });

  it("hides Add when only global add is advertised and Project is selected", () => {
    pluginMocks.plugins = [plugin({})];
    render(
      <ProviderPluginsTab
        state={multiScopeCaps({
          add: ["global"],
          remove: undefined,
          setEnabled: undefined,
          addModes: ["cli-source"],
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Add from source/ }),
    ).toBeDefined();
    chooseScopeOption(/app/);
    expect(
      screen.queryByRole("button", { name: /Add from source/ }),
    ).toBeNull();
  });
});
