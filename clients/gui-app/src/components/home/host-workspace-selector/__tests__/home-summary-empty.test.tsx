import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveHostWorkspaceControls } from "../host-workspace-selector";
import type { WorktreeWorkspaceSummaryV13 } from "@traycer/protocol/host/worktree-schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import {
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  useSettingsStore,
} from "@/stores/settings/settings-store";

interface MockSummariesQuery {
  readonly data:
    | {
        readonly workspaces: readonly WorktreeWorkspaceSummaryV13[];
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
  request(method: string, payload: unknown): Promise<unknown>;
  onChange(): () => void;
}

function createMockHostClient(
  request: (method: string, payload: unknown) => Promise<unknown>,
): MockHostClient {
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
    request,
    onChange: () => () => undefined,
  };
}

const mocks = vi.hoisted(() => {
  const request =
    vi.fn<(method: string, payload: unknown) => Promise<unknown>>();
  const hostClient: { current: MockHostClient | null } = {
    current: createMockHostClient(request),
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
    hostQueries: vi.fn(),
    navigate: vi.fn(),
    request,
    hostClient,
    resolvedWorkspace,
    summariesQuery,
  };
});

const GIT_REPO_IDENTIFIER = { owner: "acme", repo: "app" };

const GIT_SUMMARY: WorktreeWorkspaceSummaryV13 = {
  workspacePath: "/workspace/app",
  isGitRepo: true,
  repoIdentifier: GIT_REPO_IDENTIFIER,
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
  resolvedAt: 1,
};

const NON_GIT_SUMMARY: WorktreeWorkspaceSummaryV13 = {
  workspacePath: "/workspace/app",
  isGitRepo: false,
  repoIdentifier: null,
  mainBranch: null,
  worktrees: [],
  scripts: null,
  resolvedAt: 1,
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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({
    create: () => Promise.resolve(),
    isPending: false,
  }),
}));

vi.mock("@/lib/composer/landing-image-store", () => ({
  sessionImageBytes: () => null,
  getImageBytes: () => Promise.resolve(undefined),
  imageHashKeys: () => Promise.resolve([]),
}));

vi.mock("@/lib/composer/landing-image-gc", () => ({
  markLandingDraftsReady: () => undefined,
  scheduleLandingImageReconcile: () => undefined,
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
  useHostQueries: (args: unknown) => {
    mocks.hostQueries(args);
    return [];
  },
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  preparedWorkspaceFolderToWorkspaceFolderInfo: (
    folder: {
      readonly workspacePath: string;
      readonly workspaceName: string;
      readonly repoIdentifier: unknown;
    },
    hostId: string | null,
  ) => ({
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: folder.repoIdentifier,
    hostId,
  }),
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
  useWorkspaceFolderActionsForClient: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
}));

// Deterministic auto-default branch names so next-use prefix assertions can
// pin exact composed values instead of matching a random friendly slug.
vi.mock("@/lib/worktree/random-friendly-name", () => ({
  pickFriendlyBranchSuffix: () => "swift-otter",
}));

function renderControl(layout: "inline" | "stacked") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveHostWorkspaceControls
          disabled={false}
          stagingKey={{ surface: "landing", draftId: null }}
          workspaceSeed={null}
          seedIntent={null}
          seedIntentOverride={null}
          layout={layout}
          hostScope={{ kind: "active" }}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function DelayedBranchValidationHarness() {
  const actions = useLandingComposerActions();
  return (
    <>
      <ActiveHostWorkspaceControls
        disabled={false}
        stagingKey={{ surface: "landing", draftId: null }}
        workspaceSeed={null}
        seedIntent={null}
        seedIntentOverride={null}
        layout="stacked"
        hostScope={{ kind: "active" }}
      />
      <button
        type="button"
        onClick={() => {
          actions.submit({
            draftId: null,
            editor: editorHandleForPrompt("Investigate the worktree race"),
            slashCatalog: null,
            toolbar: {
              selection: {
                harnessId: "codex",
                modelSlug: "gpt-5-codex",
                profileId: null,
              },
              reasoning: "high",
              serviceTier: "",
              permission: "supervised",
            },
          });
        }}
      >
        Create task
      </button>
    </>
  );
}

function renderDelayedBranchValidationHarness(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queryClient.setQueryData(
    hostQueryKeys.method<HostRpcRegistry, "worktree.listByWorkspacePaths">(
      "host-home",
      "worktree.listByWorkspacePaths",
      {
        workspacePaths: [GIT_SUMMARY.workspacePath],
        scriptRefs: [],
        forceRefresh: false,
      },
    ),
    { workspaces: [GIT_SUMMARY], scriptsAtRefs: [] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DelayedBranchValidationHarness />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("landing workspace summary empty state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.pickAndPrepareFolders.mockClear();
    mocks.selectHost.mockClear();
    mocks.listByWorkspacePathsForClient.mockClear();
    mocks.hostQueries.mockClear();
    mocks.navigate.mockClear();
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({ roomInfo: null });
    mocks.hostClient.current = createMockHostClient(mocks.request);
    mocks.resolvedWorkspace.current = { folders: [] };
    mocks.summariesQuery.current = {
      data: { workspaces: [] },
      isFetching: false,
      isPending: false,
      isLoading: false,
    };
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
    useWorktreeIntentMemoryStore.getState().resetForTests();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSettingsStore.setState({
      worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
    });
  });

  afterEach(() => {
    cleanup();
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
    useWorktreeIntentMemoryStore.getState().resetForTests();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSettingsStore.setState({
      worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
    });
    window.localStorage.clear();
  });

  it("shows Add folder directly instead of a no-folder summary trigger", () => {
    const queryClient = renderControl("inline");

    expect(screen.getByTestId("home-workspace-summary-control")).toBeTruthy();
    expect(screen.getByTestId("composer-host-trigger")).toBeTruthy();
    expect(
      screen
        .getByTestId("composer-host-local-chip-host-home")
        .className.includes("[[data-slot=select-trigger]_&]:hidden"),
    ).toBe(true);
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

  it("keeps create and import affordances disabled while a schema-safe row is unresolved", () => {
    mocks.resolvedWorkspace.current = {
      folders: [
        {
          kind: "resolved",
          path: "/workspace/app",
          name: "app",
          repoIdentifier: { owner: "acme", repo: "app" },
        },
      ],
    };
    mocks.summariesQuery.current = {
      data: {
        workspaces: [{ ...GIT_SUMMARY, resolvedAt: null }],
      },
      isFetching: false,
      isPending: false,
      isLoading: false,
    };

    const queryClient = renderControl("stacked");

    expect(screen.getByTestId("folder-row-loading").textContent).toContain(
      "Loading folder metadata",
    );
    expect(screen.queryByTestId("folder-location-trigger")).toBeNull();

    queryClient.clear();
  });

  it("submits the displayed New worktree intent while remembered-branch validation is delayed", async () => {
    mocks.resolvedWorkspace.current = {
      folders: [
        {
          kind: "resolved",
          path: GIT_SUMMARY.workspacePath,
          name: "app",
          repoIdentifier: GIT_REPO_IDENTIFIER,
        },
      ],
    };
    mocks.summariesQuery.current = {
      data: { workspaces: [GIT_SUMMARY] },
      isFetching: false,
      isPending: false,
      isLoading: false,
    };
    useWorkspaceFoldersStore.setState({
      folders: [GIT_SUMMARY.workspacePath],
      folderInfoByPath: {
        [GIT_SUMMARY.workspacePath]: {
          path: GIT_SUMMARY.workspacePath,
          name: "app",
          repoIdentifier: GIT_SUMMARY.repoIdentifier,
          hostId: null,
        },
      },
      primaryPath: GIT_SUMMARY.workspacePath,
    });
    useWorktreeIntentMemoryStore.getState().setFolderIntent(
      {
        kind: "worktree",
        scripts: null,
        workspacePath: GIT_SUMMARY.workspacePath,
        repoIdentifier: GIT_SUMMARY.repoIdentifier,
        isPrimary: true,
        branch: {
          type: "new",
          name: "investigate-worktree-race",
          source: "main",
          carryUncommittedChanges: false,
        },
      },
      1,
    );

    const queryClient = renderDelayedBranchValidationHarness();

    expect(screen.getByTestId("folder-location-trigger").textContent).toContain(
      "New worktree",
    );
    expect(mocks.hostQueries).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [
          {
            method: "worktree.listBranches",
            params: {
              workspacePath: GIT_SUMMARY.workspacePath,
              includeRemote: true,
            },
          },
        ],
      }),
    );
    expect(
      readStagedWorktreeIntent({ surface: "landing", draftId: null }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(
        mocks.request.mock.calls.some(([method]) => method === "epic.create"),
      ).toBe(true);
    });
    const createEpicCall = mocks.request.mock.calls.find(
      ([method]) => method === "epic.create",
    );
    const createEpicPayload = createEpicCall?.[1];
    expect(createEpicPayload).toBeDefined();
    if (
      typeof createEpicPayload !== "object" ||
      createEpicPayload === null ||
      !("chat" in createEpicPayload) ||
      typeof createEpicPayload.chat !== "object" ||
      createEpicPayload.chat === null ||
      !("worktreeIntent" in createEpicPayload.chat)
    ) {
      throw new Error(
        "epic.create payload did not include chat.worktreeIntent",
      );
    }
    expect(createEpicPayload.chat.worktreeIntent).not.toBeNull();

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

  // Next-use-only contract for worktreeBranchPrefix:
  // 1) a folder that resolves under the default seeds with traycer/<suffix>
  // 2) changing the setting mid-session does NOT retrofit already-seeded names
  // 3) a folder that resolves AFTER the change seeds with the new prefix
  it("applies worktree branch prefix next-use-only across mid-session resolves", async () => {
    const folderAPath = GIT_SUMMARY.workspacePath;
    const folderBPath = "/workspace/lib";
    const folderBRepo = { owner: "acme", repo: "lib" };
    const folderBSummary: WorktreeWorkspaceSummaryV13 = {
      workspacePath: folderBPath,
      isGitRepo: true,
      repoIdentifier: folderBRepo,
      mainBranch: "development",
      worktrees: [
        {
          worktreePath: folderBPath,
          branch: "development",
          head: null,
          isMain: true,
          isLocked: false,
        },
      ],
      scripts: null,
      resolvedAt: 1,
    };

    // Mount with default prefix; only folder A is resolved.
    mocks.resolvedWorkspace.current = {
      folders: [
        {
          kind: "resolved",
          path: folderAPath,
          name: "app",
          repoIdentifier: GIT_REPO_IDENTIFIER,
        },
      ],
    };
    mocks.summariesQuery.current = {
      data: { workspaces: [GIT_SUMMARY] },
      isFetching: false,
      isPending: false,
      isLoading: false,
    };
    useWorkspaceFoldersStore.setState({
      folders: [folderAPath],
      folderInfoByPath: {
        [folderAPath]: {
          path: folderAPath,
          name: "app",
          repoIdentifier: GIT_REPO_IDENTIFIER,
          hostId: null,
        },
      },
      primaryPath: folderAPath,
    });

    const queryClient = renderControl("stacked");
    const stagingKey = { surface: "landing" as const, draftId: null };

    await waitFor(() => {
      const staged = readStagedWorktreeIntent(stagingKey);
      expect(staged?.entries).toHaveLength(1);
      expect(staged?.entries[0]).toMatchObject({
        kind: "worktree",
        workspacePath: folderAPath,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
        },
      });
    });

    // Mid-session prefix change must leave folder A's staged name alone.
    act(() => {
      useSettingsStore.setState({ worktreeBranchPrefix: "anurag/" });
    });

    expect(readStagedWorktreeIntent(stagingKey)?.entries[0]).toMatchObject({
      kind: "worktree",
      workspacePath: folderAPath,
      branch: {
        type: "new",
        name: "traycer/swift-otter",
      },
    });

    // Folder B resolves after the change → seeds under the new prefix.
    // With two git folders present, composition inserts the repo slug
    // (`lib-swift-otter`); folder A stays on its original single-folder seed.
    act(() => {
      mocks.resolvedWorkspace.current = {
        folders: [
          {
            kind: "resolved",
            path: folderAPath,
            name: "app",
            repoIdentifier: GIT_REPO_IDENTIFIER,
          },
          {
            kind: "resolved",
            path: folderBPath,
            name: "lib",
            repoIdentifier: folderBRepo,
          },
        ],
      };
      mocks.summariesQuery.current = {
        data: { workspaces: [GIT_SUMMARY, folderBSummary] },
        isFetching: false,
        isPending: false,
        isLoading: false,
      };
      useWorkspaceFoldersStore.setState({
        folders: [folderAPath, folderBPath],
        folderInfoByPath: {
          [folderAPath]: {
            path: folderAPath,
            name: "app",
            repoIdentifier: GIT_REPO_IDENTIFIER,
            hostId: null,
          },
          [folderBPath]: {
            path: folderBPath,
            name: "lib",
            repoIdentifier: folderBRepo,
            hostId: null,
          },
        },
        primaryPath: folderAPath,
      });
    });

    await waitFor(() => {
      const staged = readStagedWorktreeIntent(stagingKey);
      expect(staged?.entries).toHaveLength(2);
      const entryA = staged?.entries.find(
        (entry) => entry.workspacePath === folderAPath,
      );
      const entryB = staged?.entries.find(
        (entry) => entry.workspacePath === folderBPath,
      );
      expect(entryA).toMatchObject({
        branch: { type: "new", name: "traycer/swift-otter" },
      });
      expect(entryB).toMatchObject({
        kind: "worktree",
        workspacePath: folderBPath,
        branch: {
          type: "new",
          name: "anurag/lib-swift-otter",
        },
      });
    });

    queryClient.clear();
  });
});

function editorHandleForPrompt(prompt: string): ComposerPromptEditorHandle {
  const content: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => prompt.length === 0,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}
