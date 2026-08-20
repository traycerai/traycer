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
import { useFileTreeStore } from "@/stores/file-tree/file-tree-store";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";

// Minimal harness for reaching the "file-tree" left panel's load-error state.
// Mirrors the mocking approach in epic-sidebar-selection-mode.test.tsx (dnd
// context, sidebar UI primitives, add-node-dropdown, git-diff, terminal
// sidebar, comments icon are all irrelevant noise for this panel and are
// stubbed the same way), plus the file-tree-specific hooks that test file
// does not need.

// The panel re-provides its own `StreamRuntimeContext` for the host its pin
// resolved to. `null` is that hook's FOLLOWING answer, so the panel falls back
// to the ambient binding this suite supplies - the client every assertion here
// is about. Which transport the pin resolves to is a different question, and
// it has its own suite: `use-surface-host-stream-binding.test.tsx`.
// The hook returns the value to PROVIDE: the ambient binding while following
// (this suite's), the pin's own once built, null while pending. Following here.
vi.mock("@/hooks/host/use-surface-host-stream-binding", async () => {
  const { use } = await import("react");
  const { StreamRuntimeContext } =
    await import("@/lib/host/stream-runtime-context");
  return { useSurfaceHostStreamBinding: () => use(StreamRuntimeContext) };
});

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

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

// The surface pin (`useSurfaceHostPin` -> `useEffectiveHostId`, redesign
// P1.2) resolves against this, not the directory's active-host hook.
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-1",
}));

// `usePinnedSurfaceDead`/its dead-state screen are gone (D6: a pinned host
// that dies auto-follows to `effective` instead). These two mocks are now
// vestigial for this suite's own render tree, but are left in place as
// harmless stubs in case a sibling hook in the chain still reaches them.
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "host-1",
    unavailability: null,
  }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [{ hostId: "host-1" }],
    fetchStatus: "idle",
  }),
}));

// `useSurfaceHostClient` (also reached from `FileTreePanelBodyLive`, same
// P0.2 pin chain) resolves via this hook's real implementation, which needs
// a full `HostClient` shape (`resolveHostById`, `getActiveHost`) this
// suite's `@/lib/host/runtime` stub never carried - stub it directly, same
// pattern the sibling picker suites use.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
  // The failure state names the host it could not reach, so the panel reads
  // the directory entry for its resolved host.
  useHostDirectoryEntryForHostId: (hostId: string | null) =>
    hostId === null ? undefined : { hostId, label: "Host One" },
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
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => ({ getActiveHostId: () => "host-1" }),
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
// Configurable so one arm can drive the ZERO-ROW read a host that cannot
// answer produces - the state `useFileTreeWorkspaceSelection` resolves to a
// null workspace path from, and therefore the panel's empty state.
// `error` carries the CLASS, not just the fact of failure: only
// `HostTransportFailureError` means the host never answered, and the panel
// tells a different story for anything else.
const fileTreeBindingsState = vi.hoisted(() => ({
  rows: [] as Array<{
    readonly runningDir: string;
    readonly disabledReason: string | null;
  }>,
  error: null as HostRpcError | null,
  refetch: vi.fn<() => Promise<unknown>>(),
}));

function fileTreeBindingsResult() {
  return {
    data:
      fileTreeBindingsState.error === null
        ? { rows: fileTreeBindingsState.rows }
        : undefined,
    error: fileTreeBindingsState.error,
    refetch: fileTreeBindingsState.refetch,
  };
}

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => fileTreeBindingsResult(),
  // `useFileTreeWorkspaceSelection` (also reached from the P0.2 pin chain)
  // calls the host-client-parametric variant, not the app-wide one above.
  useWorktreeListBindingsForEpicForClient: () => fileTreeBindingsResult(),
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

// Rendered rather than nulled: whether this survives the panel's empty state
// is the assertion, and a stub that renders nothing cannot make it. It still
// renders its `picker` slot so the inner picker's presence is observable too -
// that is the one carrying `WorktreePickerHostSection`.
vi.mock("@/components/worktree/workspace-picker-with-opener", () => ({
  WorkspacePickerWithOpener: (props: { readonly picker: ReactNode }) => (
    <div data-testid="mock-workspace-picker-with-opener">{props.picker}</div>
  ),
}));

// `data-selected-path` distinguishes a NULL selection from an empty string:
// collapsing both to "" would make the "renders with no workspace chosen"
// assertion below unable to tell them apart, and "" is a path the picker could
// in principle be handed.
vi.mock("@/components/epic-canvas/sidebar/file-tree-workspace-picker", () => ({
  FileTreeWorkspacePicker: (props: {
    readonly selectedPath: string | null;
  }) => (
    <div
      data-testid="mock-file-tree-workspace-picker"
      data-selected-path={
        props.selectedPath === null ? "<null>" : props.selectedPath
      }
    />
  ),
}));

import { EpicLeftPanelHost } from "@/components/epic-canvas/sidebar/epic-sidebar";

const TAB_ID = "tab-1";
const EPIC_ID = "epic-1";

describe("epic sidebar file-tree load failure report action", () => {
  beforeEach(() => {
    cleanup();
    fileTreeBindingsState.rows = [
      { runningDir: "/work/repo", disabledReason: null },
    ];
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

describe("epic sidebar file-tree workspace picker persistence", () => {
  beforeEach(() => {
    cleanup();
    fileTreeBindingsState.rows = [
      { runningDir: "/work/repo", disabledReason: null },
    ];
    fileTreeBindingsState.error = null;
    fileTreeBindingsState.refetch.mockReset();
    fileTreeBindingsState.refetch.mockResolvedValue(undefined);
    // The selected workspace is STORE state, not fixture state, so without
    // this the second test inherits whatever the first resolved and the order
    // of these cases becomes load-bearing.
    useFileTreeStore.setState({ selectedWorkspaceByEpicAndHost: {} });
  });

  afterEach(() => {
    cleanup();
  });

  function renderPanel(): void {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it("keeps the picker when NO workspace resolves", () => {
    // Zero rows is what a host that cannot answer resolves to, so the panel
    // falls to "No workspace linked." The picker used to live in that
    // conditional's OTHER arm, which meant choosing a host that could not
    // answer removed the control that could choose a different one - and the
    // pin is persisted, so it survived a reload. Same defect the git-diff
    // panel had; `NewTerminalPickerBody` never had it.
    fileTreeBindingsState.rows = [];

    renderPanel();

    expect(screen.getByTestId("epic-file-tree-empty")).toBeDefined();
    expect(
      screen.getByTestId("mock-workspace-picker-with-opener"),
    ).toBeDefined();
    const picker = screen.getByTestId("mock-file-tree-workspace-picker");
    // Rendered with a NULL selection rather than being skipped - the picker
    // already models "no workspace chosen" ("Select workspace").
    expect(picker.getAttribute("data-selected-path")).toBe("<null>");
  });

  it("does not claim 'No workspace linked' when the host never ANSWERED", () => {
    // A failed read and an answered-but-empty read both leave the selection
    // null, so the panel used to tell one story for both. "No workspace
    // linked." is a claim about the agent; this is a fact about the
    // connection, and only one of them has a remedy the user can act on.
    fileTreeBindingsState.rows = [];
    fileTreeBindingsState.error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "dial failed",
      requestId: "req-test",
      method: "worktree.listBindingsForEpic",
      fatalDetails: null,
    });

    renderPanel();

    expect(
      screen.getByTestId("file-tree-workspaces-unavailable"),
    ).toBeDefined();
    expect(screen.queryByTestId("epic-file-tree-empty")).toBeNull();
    // The picker still outlives it - the same invariant as the empty state.
    expect(
      screen.getByTestId("mock-workspace-picker-with-opener"),
    ).toBeDefined();
  });

  it("offers a retry, because nothing else re-reads the bindings", () => {
    fileTreeBindingsState.rows = [];
    fileTreeBindingsState.error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "dial failed",
      requestId: "req-test",
      method: "worktree.listBindingsForEpic",
      fatalDetails: null,
    });

    renderPanel();
    fireEvent.click(
      screen.getByTestId("file-tree-workspaces-unavailable-retry"),
    );

    // Host-scoped queries disable retry, polling and focus/reconnect refetch,
    // so without this button the panel sits there until the tab is reloaded.
    expect(fileTreeBindingsState.refetch).toHaveBeenCalled();
  });

  it("shows the host's own reason when it ANSWERED with a refusal", () => {
    fileTreeBindingsState.rows = [];
    fileTreeBindingsState.error = new HostRpcError({
      code: "RPC_ERROR",
      message: "not authorized",
      requestId: "req-test",
      method: "worktree.listBindingsForEpic",
      fatalDetails: null,
    });

    renderPanel();

    expect(
      screen.getByTestId("file-tree-workspaces-unavailable-reason").textContent,
    ).toBe("not authorized");
  });

  it("still renders the picker once a workspace resolves", () => {
    renderPanel();

    expect(screen.queryByTestId("epic-file-tree-empty")).toBeNull();
    expect(
      screen
        .getByTestId("mock-file-tree-workspace-picker")
        .getAttribute("data-selected-path"),
    ).toBe("/work/repo");
  });
});
