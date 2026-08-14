import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

// Minimal harness for reaching the "file-tree" left panel's load-error state.
// Mirrors the mocking approach in epic-sidebar-selection-mode.test.tsx (dnd
// context, sidebar UI primitives, add-node-dropdown, git-diff, terminal
// sidebar, comments icon are all irrelevant noise for this panel and are
// stubbed the same way), plus the file-tree-specific hooks that test file
// does not need.

vi.mock("@/components/epic-canvas/dnd/epic-canvas-dnd-context-value", () => ({
  useEpicCanvasDnd: () => ({
    activeSource: null,
    dropPreview: null,
    interactionLocked: false,
    clearDropPreview: () => undefined,
  }),
}));

vi.mock("@/components/epic-canvas/snapshots/snapshot-loading-context", () => ({
  SnapshotGate: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/epic-canvas/add-node-dropdown", () => ({
  AddNodeDropdown: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/epic-canvas/add-node-options", () => ({
  CHAT_PANEL_EXCLUDED_TYPES: [],
  ARTIFACT_PANEL_EXCLUDED_TYPES: [],
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-filter-menu", () => ({
  ChatFilterMenu: () => null,
  ArtifactFilterMenu: () => null,
}));

vi.mock("@/components/epic-canvas/sidebar/epic-terminal-sidebar", () => ({
  TerminalsPanelActions: () => null,
  TerminalsPanelBody: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-panel-body-live", () => ({
  GitDiffPanelBodyLive: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-panel-actions", () => ({
  GitDiffPanelActions: () => null,
}));

vi.mock("@/components/chat/chat-progress-icon", () => ({
  ChatProgressIcon: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { readonly children: ReactNode }) => props.children,
  DropdownMenuTrigger: (props: { readonly children: ReactNode }) =>
    props.children,
  DropdownMenuContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DropdownMenuItem: (props: { readonly children: ReactNode }) => (
    <button type="button">{props.children}</button>
  ),
  DropdownMenuSeparator: () => null,
}));

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: (props: {
    readonly children: ReactNode;
    readonly "data-testid": string;
    readonly "data-left-panel-id": string;
  }) => (
    <aside
      data-testid={props["data-testid"]}
      data-left-panel-id={props["data-left-panel-id"]}
    >
      {props.children}
    </aside>
  ),
  SidebarContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SidebarGroup: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SidebarGroupContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: () => null,
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({
    data: { binding: null, missingWorktreePaths: [] },
    isError: false,
    isPending: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChat: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicCreateChatForHostClient: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicDeleteChat: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useEpicRenameChat: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    create: vi.fn(() => Promise.resolve(null)),
    isPending: false,
  }),
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ hostId: "host-1" }),
}));

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicCreateArtifact: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicDeleteArtifact: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicDeleteTuiAgent: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useEpicRenameTuiAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    epicId: "epic-1",
    store: {
      getState: () => ({ deleteArtifact: vi.fn(), renameArtifact: vi.fn() }),
      subscribe: () => () => undefined,
    },
  }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  findOpenArtifactInTab: () => null,
  useActiveEpicArtifactId: () => null,
  useEpicCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({
      closeCanvasTab: vi.fn(),
      markArtifactSelfDeleted: vi.fn(),
      openTileInTab: vi.fn(),
      openTilePreviewInTab: vi.fn(),
      pendingRootCreatesByEpic: {},
      preAckRootCreatesByEpic: {},
      promotePreviewInTab: vi.fn(),
      renameArtifactInTab: vi.fn(),
      unmarkArtifactSelfDeleted: vi.fn(),
      prepareOpenTilePreviewInTabFocusTarget: () => () => null,
      prepareOpenTileInTabFocusTarget: () => () => null,
    }),
  useIsActiveEpicArtifact: () => false,
}));

vi.mock("@/stores/epics/epic-sidebar-expansion-store", () => ({
  useEpicSidebarEffectiveExpanded: () => new Set<string>(),
  useEpicSidebarExpansionStore: (selector: (state: unknown) => unknown) =>
    selector({ collapse: vi.fn(), collapseAll: vi.fn(), expand: vi.fn() }),
}));

vi.mock("@/stores/epics/left-panel-store", () => ({
  DEFAULT_LEFT_PANEL_ID: "chats",
  isArtifactFilterActive: () => false,
  isChatFilterActive: () => false,
  useAcknowledgedRootCreatePending: () => null,
  useActiveLeftPanelId: () => "file-tree",
  useArtifactFilter: () => ({ statuses: [], kinds: [], read: "all" }),
  useArtifactSort: () => ({ field: "updated", direction: "desc" }),
  useChatFilter: () => ({ origin: "all", ownership: "all" }),
  useChatSort: () => ({ field: "updated", direction: "desc" }),
  useCommentsPanelRevealed: () => false,
  usePanelVisibilityOverrides: () => ({}),
  useEpicLeftPanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      clearAcknowledgedRootCreatePending: vi.fn(),
      clearLocalRootCreatePending: vi.fn(),
      panelSectionCollapsedByPanelId: {},
      setAcknowledgedRootCreatePending: vi.fn(),
      setActivePanelId: vi.fn(),
      setLocalRootCreatePending: vi.fn(),
      setPanelSectionWeights: vi.fn(),
      togglePanelSectionCollapsed: vi.fn(),
    }),
  useLeftPanelGroups: () => [{ panelIds: ["file-tree"] }],
  useLeftPanelSectionCollapsed: () => false,
  useLocalRootCreatePending: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useAncestorIds: () => new Set<string>(),
  useChildIds: () => [],
  useEpicActiveAgentIds: () => new Set<string>(),
  useEpicAgentRoleClaims: () => [],
  useEpicArtifact: () => null,
  useEpicArtifactRecords: () => [],
  useEpicArtifactStatus: () => null,
  useEpicConnectionStatus: () => "open",
  useEpicNodeHostId: () => "host-1",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
  useEpicPermissionRole: () => "owner",
  useEpicTreeIndex: () => ({ rootIds: [], childrenByParent: {}, nodeById: {} }),
  useEpicTreeNode: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useRootIds: () => [],
}));

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshotLoaded: true,
      artifacts: { allIds: [], byId: {} },
    }),
}));

vi.mock("@/stores/epics/artifact-read-state-store", () => ({
  isArtifactUnread: () => false,
  useArtifactReadStateStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        lastSeenByArtifact: {},
        markRead: vi.fn(),
        seedAtByEpic: {},
        seedEpicArtifacts: vi.fn(),
      }),
    {
      getState: () => ({
        lastSeenByArtifact: {},
        markRead: vi.fn(),
        seedAtByEpic: {},
        seedEpicArtifacts: vi.fn(),
      }),
    },
  ),
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      diffViewerPreferences: { ignoreWhitespace: false },
      artifactIconColorMode: "none",
      artifactIconColors: {
        chat: undefined,
        review: undefined,
        spec: undefined,
        story: undefined,
        ticket: undefined,
        "terminal-agent": undefined,
      },
    }),
}));

// File-tree-panel-specific dependencies.
vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: {
      rows: [
        {
          runningDir: "/work/repo",
          disabledReason: null,
        },
      ],
    },
  }),
}));

vi.mock("@/hooks/workspace/use-list-file-tree-query", () => ({
  useWorkspaceListFileTree: () => ({
    data: undefined,
    error: new Error("secret-token-should-never-render /Users/hostile/path"),
    isLoading: false,
  }),
}));

// The path-search hook is replaced with a real, permanently-disabled TanStack
// query: this panel test only exercises the browse/error state, and standing up
// the true hook would need a full `HostClient` (readiness snapshot + change
// subscription), not this harness's minimal stub. Delegating to `useQuery`
// yields a COMPLETE idle `UseQueryResult` - status, isPending, refetch and the
// rest - so the mock cannot drift from the production query contract the way a
// hand-listed subset would. The module's real echo guard stays in the graph.
vi.mock(
  "@/hooks/workspace/use-workspace-search-paths-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/workspace/use-workspace-search-paths-query")
      >();
    const { useQuery } = await import("@tanstack/react-query");
    return {
      ...actual,
      useWorkspaceSearchPaths: () =>
        useQuery({
          queryKey: ["test", "workspace.searchPaths", "disabled"],
          // Never invoked (the query is permanently disabled), but it must
          // resolve to a non-undefined value to satisfy the TanStack lint rule.
          queryFn: () => Promise.resolve(null),
          enabled: false,
        }),
    };
  },
);

vi.mock("@pierre/trees/react", () => ({
  FileTree: () => <div data-testid="pierre-file-tree-stub" />,
  // No filtering in these tests: a static idle snapshot keeps the panel's
  // zero-match empty state out of the picture.
  useFileTreeSearch: () => ({ isOpen: false, value: "", matchingPaths: [] }),
  useFileTree: () => ({
    model: {
      setSearch: () => undefined,
      setGitStatus: () => undefined,
      resetPaths: () => undefined,
    },
  }),
}));

vi.mock("@/components/worktree/workspace-picker-with-opener", () => ({
  WorkspacePickerWithOpener: () => null,
}));

vi.mock("@/components/epic-canvas/sidebar/file-tree-workspace-picker", () => ({
  FileTreeWorkspacePicker: () => null,
}));

import { EpicLeftPanelHost } from "@/components/epic-canvas/sidebar/epic-sidebar";

const TAB_ID = "tab-1";
const EPIC_ID = "epic-1";

describe("epic sidebar file-tree load failure report action", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("hides the report action when the support capability is unavailable", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    screen.getByText("Unable to load files.");
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context, never the raw file-tree host error", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Unable to load files",
        message: "The workspace file tree could not be loaded.",
        code: null,
        source: "File tree",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("/Users/hostile/path");
  });
});
