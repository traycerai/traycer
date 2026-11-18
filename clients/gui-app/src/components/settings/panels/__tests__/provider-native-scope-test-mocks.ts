/**
 * Shared workspace/host mock state for tabs that call `useProviderNativeScope`
 * (Plugins, Skills, MCP). Each suite still declares its own `vi.mock(...)`
 * factories (Vitest hoists those to the file that contains them) and reads
 * these mutable bags from the factories.
 *
 * Mirrors the shape exercised by `provider-mcp-tab.test.tsx` so project-scope
 * picker + listWorkspaceRoot tests stay consistent across domains.
 */
export const nativeScopeWorktreeMocks = {
  workspaces: [] as Array<{
    workspacePath: string;
    isGitRepo: boolean;
    repoIdentifier: null;
    mainBranch: string | null;
    worktrees: Array<{
      worktreePath: string;
      branch: string | null;
      head: string | null;
      isMain: boolean;
      isLocked: boolean;
    }>;
    scripts: null;
  }>,
  loaded: true,
  pending: false,
};

export const nativeScopeResolvedWorkspaceMocks = {
  folders: [] as Array<{
    kind: "resolved" | "local-only" | "unresolved";
    path: string;
    name: string;
  }>,
  isLoading: false,
  isFetching: false,
};

export const nativeScopeFolderActionMocks = {
  pickAndPrepareFolders: (): Promise<null> => Promise.resolve(null),
  isPreparing: false,
};

export function resetNativeScopeTestMocks(): void {
  nativeScopeWorktreeMocks.workspaces = [];
  nativeScopeWorktreeMocks.loaded = true;
  nativeScopeWorktreeMocks.pending = false;
  nativeScopeResolvedWorkspaceMocks.folders = [
    { kind: "local-only", path: "/Users/dev/app", name: "app" },
  ];
  nativeScopeResolvedWorkspaceMocks.isLoading = false;
  nativeScopeResolvedWorkspaceMocks.isFetching = false;
  nativeScopeFolderActionMocks.pickAndPrepareFolders = () =>
    Promise.resolve(null);
  nativeScopeFolderActionMocks.isPreparing = false;
}

/**
 * Default return shape for suites that only need the Global locked path and
 * do not exercise the real scope picker. Avoids pulling host/QueryClient into
 * icon/detail/composer tests that never switch scope.
 */
export const GLOBAL_ONLY_NATIVE_SCOPE = {
  hostId: "host-1",
  targets: [] as const,
  workspaceRoot: null,
  setWorkspaceRoot: (_path: string): void => undefined,
  browseForWorkspace: (): Promise<string | null> => Promise.resolve(null),
  browsePending: false,
  multiWorkspace: false,
  multiScope: false,
  effectiveScope: "global" as const,
  setScope: (_scope: "global" | "project"): void => undefined,
  projectNeedsWorkspace: false,
  listWorkspaceRoot: null,
  listEnabled: true,
  workspacesLoading: false,
};
