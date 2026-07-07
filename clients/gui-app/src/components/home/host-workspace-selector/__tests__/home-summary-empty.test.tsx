import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveHostWorkspaceControls } from "../host-workspace-selector";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";
import { TooltipProvider } from "@/components/ui/tooltip";

interface MockSummariesQuery {
  readonly data:
    | {
        readonly workspaces: readonly WorktreeWorkspaceSummary[];
      }
    | undefined;
  readonly isFetching: boolean;
  readonly isPending: boolean;
  readonly isLoading: boolean;
}

interface MockHostClient {
  getActiveHost(): {
    readonly hostId: string;
    readonly label: string;
    readonly kind: "local";
    readonly websocketUrl: string;
    readonly version: string;
    readonly status: "available";
  };
  getActiveHostId(): string;
  getRequestContextUserId(): string;
  request(): Promise<never>;
  onChange(): () => void;
}

function createMockHostClient(): MockHostClient {
  return {
    getActiveHost: () => ({
      hostId: "host-home",
      label: "Home Mac",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      status: "available",
    }),
    getActiveHostId: () => "host-home",
    getRequestContextUserId: () => "user-home",
    request: () => Promise.reject(new Error("unexpected request")),
    onChange: () => () => undefined,
  };
}

const mocks = vi.hoisted(() => {
  const hostClient: { current: MockHostClient | null } = {
    current: createMockHostClient(),
  };
  const resolvedWorkspace: {
    current: { readonly folders: readonly ResolvedFolder[] };
  } = {
    current: { folders: [] },
  };
  const summariesQuery: { current: MockSummariesQuery } = {
    current: {
      data: { workspaces: [] },
      isFetching: false,
      isPending: false,
      isLoading: false,
    },
  };
  return {
    pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
    selectHost: vi.fn(),
    listByWorkspacePathsForClient: vi.fn(),
    hostClient,
    resolvedWorkspace,
    summariesQuery,
  };
});

const GIT_SUMMARY: WorktreeWorkspaceSummary = {
  workspacePath: "/workspace/app",
  isGitRepo: true,
  repoIdentifier: { owner: "acme", repo: "app" },
  mainBranch: "development",
  worktrees: [
    {
      worktreePath: "/workspace/app",
      branch: "development",
      head: null,
      isMain: true,
      isLocked: false,
    },
  ],
  scripts: null,
};

const NON_GIT_SUMMARY: WorktreeWorkspaceSummary = {
  workspacePath: "/workspace/app",
  isGitRepo: false,
  repoIdentifier: null,
  mainBranch: null,
  worktrees: [],
  scripts: null,
};

vi.mock("@/components/ui/select", () => ({
  Select: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectTrigger: (props: {
    readonly children: ReactNode;
    readonly "aria-label"?: string;
    readonly "data-testid"?: string;
    readonly className?: string;
    readonly disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={props["aria-label"]}
      className={props.className}
      data-testid={props["data-testid"]}
      disabled={props.disabled ?? false}
    >
      {props.children}
    </button>
  ),
  SelectValue: (props: { readonly placeholder?: string }) => (
    <span>{props.placeholder ?? ""}</span>
  ),
  SelectContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectItem: (props: {
    readonly children: ReactNode;
    readonly value: string;
  }) => <div data-value={props.value}>{props.children}</div>,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: { selectById: mocks.selectHost },
  }),
  useHostClient: () => mocks.hostClient.current,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-home",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-home",
        label: "Home Mac",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:4917/rpc",
        version: "0.0.0-test",
        status: "available",
      },
    ],
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => mocks.resolvedWorkspace.current,
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePaths: () => ({
    data: { workspaces: [] },
    isFetching: false,
  }),
  useWorktreeListByWorkspacePathsForClient: (
    client: unknown,
    args: {
      readonly workspacePaths: readonly string[];
      readonly enabled: boolean;
    },
  ) => {
    mocks.listByWorkspacePathsForClient(client, args);
    return mocks.summariesQuery.current;
  },
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () => [],
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  preparedWorkspaceFolderToWorkspaceFolderInfo: (folder: {
    readonly workspacePath: string;
    readonly workspaceName: string;
    readonly repoIdentifier: unknown;
  }) => ({
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: folder.repoIdentifier,
  }),
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
  useWorkspaceFolderActionsForClient: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
}));

function renderControl(layout: "inline" | "stacked") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveHostWorkspaceControls
          stagingKey={{ surface: "landing", draftId: null }}
          workspaceSeed={null}
          seedIntent={null}
          layout={layout}
          hostScope={{ kind: "active" }}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("landing workspace summary empty state", () => {
  beforeEach(() => {
    mocks.pickAndPrepareFolders.mockClear();
    mocks.selectHost.mockClear();
    mocks.listByWorkspacePathsForClient.mockClear();
    mocks.hostClient.current = createMockHostClient();
    mocks.resolvedWorkspace.current = { folders: [] };
    mocks.summariesQuery.current = {
      data: { workspaces: [] },
      isFetching: false,
      isPending: false,
      isLoading: false,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("shows Add folder directly instead of a no-folder summary trigger", () => {
    const queryClient = renderControl("inline");

    expect(screen.getByTestId("home-workspace-summary-control")).toBeTruthy();
    expect(screen.getByTestId("composer-host-trigger")).toBeTruthy();
    expect(screen.queryByTestId("workspace-summary-trigger")).toBeNull();
    expect(screen.getByTestId("folder-add").textContent).toContain(
      "Add folder",
    );

    fireEvent.click(screen.getByTestId("folder-add"));
    expect(mocks.pickAndPrepareFolders).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });

  it("queries disk metadata for unresolved folders and renders them usable when git exists", () => {
    mocks.resolvedWorkspace.current = {
      folders: [
        {
          kind: "unresolved",
          path: "/workspace/app",
          name: "app",
          repoIdentifier: { owner: "acme", repo: "app" },
        },
      ],
    };
    mocks.summariesQuery.current = {
      data: { workspaces: [GIT_SUMMARY] },
      isFetching: false,
      isPending: false,
      isLoading: false,
    };

    const queryClient = renderControl("stacked");

    expect(mocks.listByWorkspacePathsForClient).toHaveBeenCalledWith(
      expect.anything(),
      { workspacePaths: ["/workspace/app"], enabled: true },
    );
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.getByTestId("folder-location-trigger").textContent).toContain(
      "New worktree",
    );

    queryClient.clear();
  });

  it("renders unresolved folders with non-git disk metadata as local-only folders", async () => {
    mocks.resolvedWorkspace.current = {
      folders: [
        {
          kind: "unresolved",
          path: "/workspace/app",
          name: "app",
          repoIdentifier: { owner: "acme", repo: "app" },
        },
      ],
    };
    mocks.summariesQuery.current = {
      data: { workspaces: [NON_GIT_SUMMARY] },
      isFetching: false,
      isPending: false,
      isLoading: false,
    };

    const queryClient = renderControl("stacked");
    const trigger = screen.getByTestId("folder-location-trigger");

    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByTestId("folder-row-locate")).toBeNull();
    expect(trigger.textContent).toContain("Local");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");

    fireEvent.focus(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Worktrees require a Git repository",
    );

    queryClient.clear();
  });

  it("shows loading while unresolved folder disk metadata is still pending", () => {
    mocks.resolvedWorkspace.current = {
      folders: [
        {
          kind: "unresolved",
          path: "/workspace/app",
          name: "app",
          repoIdentifier: { owner: "acme", repo: "app" },
        },
      ],
    };
    mocks.summariesQuery.current = {
      data: undefined,
      isFetching: true,
      isPending: true,
      isLoading: true,
    };

    const queryClient = renderControl("stacked");

    expect(screen.getByTestId("folder-row-loading").textContent).toContain(
      "Loading folder metadata",
    );
    expect(screen.queryByText("Unavailable")).toBeNull();

    queryClient.clear();
  });

  it("shows unavailable, not loading, when unresolved metadata query is disabled by a missing host client", () => {
    mocks.hostClient.current = null;
    mocks.resolvedWorkspace.current = {
      folders: [
        {
          kind: "unresolved",
          path: "/workspace/app",
          name: "app",
          repoIdentifier: { owner: "acme", repo: "app" },
        },
      ],
    };
    mocks.summariesQuery.current = {
      data: undefined,
      isFetching: false,
      isPending: true,
      isLoading: false,
    };

    const queryClient = renderControl("stacked");

    expect(screen.queryByTestId("folder-row-loading")).toBeNull();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByTestId("folder-row-locate").textContent).toContain(
      "Locate folder",
    );

    queryClient.clear();
  });
});
