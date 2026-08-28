import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { ProviderPluginsTab } from "@/components/settings/panels/provider-plugins-tab";
import {
  nativeScopeFolderActionMocks,
  nativeScopeResolvedWorkspaceMocks,
  nativeScopeWorktreeMocks,
} from "@/components/settings/panels/__tests__/provider-native-scope-test-mocks";

/*
 * The Plugins tab calls `useProviderNativeScope`, which reaches three host
 * queries. Without these the render dies on "No QueryClient set" before any
 * notice is on screen - the failure is in the scope hook, not in the notice
 * this suite is about. Mocked rather than wrapped in a QueryClientProvider so
 * the suite keeps testing the notice against a fixed scope, matching the
 * convention in provider-plugins-tab-scope.test.tsx.
 */
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
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
  useProvidersPluginsList: () => ({
    data: { plugins: [] },
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-providers-plugins-mutate-mutation", () => ({
  useProvidersPluginsMutate: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-plugin-icon-query", () => ({
  useProvidersPluginIcon: () => ({ data: undefined }),
}));

const SESSION_NOTICE =
  "Plugin tools may not appear in Traycer-launched sessions. They load for this provider's own CLI, but not for the session stream Traycer drives.";

function pluginsState(
  providerId: ProviderCliState["providerId"],
  traycerSessionToolsNotice: boolean,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["plugins"],
      mcp: null,
      plugins: {
        addModes: ["read-only"],
        marketplaceBrowse: false,
        traycerSessionToolsNotice,
        actionScopes: {
          list: ["global"],
          add: [],
          remove: [],
          setEnabled: [],
        },
      },
      skills: null,
      modelProviders: null,
    },
    selected: { kind: "path" },
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

afterEach(() => {
  cleanup();
});

describe("ProviderPluginsTab session-tools notice", () => {
  it("renders the notice when caps.traycerSessionToolsNotice is true", () => {
    render(<ProviderPluginsTab state={pluginsState("cursor", true)} />);
    expect(screen.getByText(SESSION_NOTICE)).toBeDefined();
  });

  it("renders no notice when caps.traycerSessionToolsNotice is false", () => {
    render(<ProviderPluginsTab state={pluginsState("cursor", false)} />);
    expect(screen.queryByText(SESSION_NOTICE)).toBeNull();
  });

  it("uses one sentence driven solely by the flag, not by provider id", () => {
    // The cursor-specific arm is gone. Amp with the same flag must get the
    // same sentence - there is no provider-id branch left to diverge.
    const { unmount } = render(
      <ProviderPluginsTab state={pluginsState("cursor", true)} />,
    );
    const cursorText = screen.getByText(SESSION_NOTICE).textContent;
    unmount();

    render(<ProviderPluginsTab state={pluginsState("amp", true)} />);
    expect(screen.getByText(SESSION_NOTICE).textContent).toBe(cursorText);
  });
});
