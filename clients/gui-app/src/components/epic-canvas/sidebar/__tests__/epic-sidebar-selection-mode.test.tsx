import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import type { ProviderId } from "@/components/home/data/landing-options";

interface TestTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly type:
    "spec" | "ticket" | "story" | "review" | "chat" | "terminal-agent";
  readonly status: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface TestRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: TestTreeNode["type"];
  readonly status: number | null;
  readonly hostId: string;
}

interface TestIndicatorState {
  readonly unreadFailure: boolean;
  readonly pendingApproval: boolean;
  readonly pendingInterview: boolean;
  readonly unreadDone: boolean;
}

interface TestState {
  readonly createChatMutate: Mock;
  readonly createArtifactMutate: Mock;
  readonly deleteArtifactMutateAsync: Mock;
  readonly deleteChatMutateAsync: Mock;
  readonly deleteTuiAgentMutateAsync: Mock;
  readonly exportArtifactsMutate: Mock;
  readonly localDeleteArtifact: Mock;
  readonly closeCanvasTab: Mock;
  readonly markArtifactSelfDeleted: Mock;
  readonly unmarkArtifactSelfDeleted: Mock;
  sessionReady: boolean;
  snapshotLoaded: boolean;
  activeArtifactId: string | null;
  activePanelId: "chats" | "artifacts";
  artifactFilterKinds: ReadonlyArray<string>;
  chatFilterOrigin: "all" | "gui" | "tui";
  collapsedPanelIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  unreadArtifactIds: ReadonlySet<string>;
  tree: {
    readonly rootIds: readonly string[];
    readonly childrenByParent: Readonly<Record<string, readonly string[]>>;
    readonly nodeById: Readonly<Record<string, TestTreeNode | undefined>>;
  };
  records: readonly TestRecord[];
  indicatorChats: Readonly<Record<string, TestIndicatorState>>;
  activeAgentIds: ReadonlySet<string>;
  activityTierById: Map<string, "turn" | "background">;
  chatHarnessIds: Readonly<Partial<Record<string, ProviderId>>>;
  tuiHarnessIds: Readonly<Partial<Record<string, ProviderId>>>;
  permissionRole: "owner" | "editor" | "viewer" | null;
  rowHostId: string | null;
  rowHostEntry: unknown;
  rowHostClient: unknown;
  activeHostClient: unknown;
}

const EMPTY_WORKSPACE_FOLDERS = vi.hoisted<readonly string[]>(() =>
  Object.freeze([]),
);

const testState = vi.hoisted<TestState>(() => ({
  createChatMutate: vi.fn(),
  createArtifactMutate: vi.fn(),
  deleteArtifactMutateAsync: vi.fn(),
  deleteChatMutateAsync: vi.fn(),
  deleteTuiAgentMutateAsync: vi.fn(),
  exportArtifactsMutate: vi.fn(),
  localDeleteArtifact: vi.fn(),
  closeCanvasTab: vi.fn(),
  markArtifactSelfDeleted: vi.fn(),
  unmarkArtifactSelfDeleted: vi.fn(),
  sessionReady: true,
  snapshotLoaded: true,
  activeArtifactId: null,
  activePanelId: "chats",
  artifactFilterKinds: [],
  chatFilterOrigin: "all",
  collapsedPanelIds: new Set<string>(),
  expandedIds: new Set<string>(),
  unreadArtifactIds: new Set<string>(),
  tree: {
    rootIds: [],
    childrenByParent: {},
    nodeById: {},
  },
  records: [],
  indicatorChats: {},
  activeAgentIds: new Set<string>(),
  activityTierById: new Map<string, "turn" | "background">(),
  chatHarnessIds: {},
  tuiHarnessIds: {},
  permissionRole: "owner",
  rowHostId: "host-1",
  rowHostEntry: { hostId: "host-1" },
  rowHostClient: { getActiveHostId: () => "host-1" },
  activeHostClient: { getActiveHostId: () => "host-1" },
}));

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
  ChatFilterMenu: (props: { readonly disabled: boolean }) => (
    <button type="button" disabled={props.disabled}>
      Chat filter
    </button>
  ),
  ArtifactFilterMenu: (props: { readonly disabled: boolean }) => (
    <button type="button" disabled={props.disabled}>
      Artifact filter
    </button>
  ),
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

vi.mock(
  "@/components/epic-canvas/hooks/use-terminal-agent-worktree-gate",
  () => ({
    useTerminalAgentWorktreeGate: () => ({
      isPending: false,
      requestCreate: vi.fn(),
    }),
  }),
);

vi.mock("@/components/chat/chat-progress-icon", () => ({
  ChatProgressIcon: (props: {
    readonly defaultIcon: ReactNode | undefined;
  }) => <span data-testid="chat-sidebar-spinner">{props.defaultIcon}</span>,
}));

vi.mock("@/components/worktree/worktree-owner-metadata", () => ({
  WorktreeOwnerMetadataTooltip: (props: { readonly trigger: ReactNode }) =>
    props.trigger,
}));

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: testState.indicatorChats },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { readonly children: ReactNode }) => props.children,
  DropdownMenuTrigger: (props: { readonly children: ReactNode }) =>
    props.children,
  DropdownMenuContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DropdownMenuItem: (props: {
    readonly children: ReactNode;
    readonly onSelect: () => void;
    readonly "data-testid": string;
    readonly disabled: boolean;
  }) => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: (props: { readonly children: ReactNode }) => props.children,
  TooltipTrigger: (props: { readonly children: ReactNode }) => props.children,
  TooltipContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
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
  useEpicCreateChat: () => ({
    mutate: testState.createChatMutate,
    isPending: false,
  }),
  useEpicCreateChatForHostClient: () => ({
    mutate: testState.createChatMutate,
    isPending: false,
  }),
  useEpicDeleteChat: () => ({
    mutate: vi.fn(),
    mutateAsync: testState.deleteChatMutateAsync,
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
  useHostClient: () => testState.activeHostClient,
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => testState.rowHostClient,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => testState.rowHostEntry,
}));

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicCreateArtifact: () => ({
    mutate: testState.createArtifactMutate,
    isPending: false,
  }),
  useEpicDeleteArtifact: () => ({
    mutate: vi.fn(),
    mutateAsync: testState.deleteArtifactMutateAsync,
    isPending: false,
  }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/epic/use-epic-export-artifacts-mutation", () => ({
  useEpicExportArtifacts: () => ({
    mutate: testState.exportArtifactsMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicDeleteTuiAgent: () => ({
    mutate: vi.fn(),
    mutateAsync: testState.deleteTuiAgentMutateAsync,
    isPending: false,
  }),
  useEpicRenameTuiAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => {
    if (!testState.sessionReady) {
      throw new Error(
        "useOpenEpicHandle must be called inside <EpicSessionProvider>.",
      );
    }
    return {
      epicId: "epic-1",
      store: {
        getState: () => ({
          deleteArtifact: testState.localDeleteArtifact,
          renameArtifact: vi.fn(),
        }),
        subscribe: () => () => undefined,
      },
    };
  },
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  findOpenArtifactInTab: () => null,
  useActiveEpicArtifactId: () => testState.activeArtifactId,
  useEpicCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({
      closeCanvasTab: testState.closeCanvasTab,
      markArtifactSelfDeleted: testState.markArtifactSelfDeleted,
      openTileInTab: vi.fn(),
      openTilePreviewInTab: vi.fn(),
      pendingRootCreatesByEpic: {},
      preAckRootCreatesByEpic: {},
      promotePreviewInTab: vi.fn(),
      renameArtifactInTab: vi.fn(),
      unmarkArtifactSelfDeleted: testState.unmarkArtifactSelfDeleted,
    }),
  useIsActiveEpicArtifact: () => false,
}));

vi.mock("@/stores/epics/epic-sidebar-expansion-store", () => ({
  useEpicSidebarEffectiveExpanded: () => testState.expandedIds,
  useEpicSidebarExpansionStore: (selector: (state: unknown) => unknown) =>
    selector({
      collapse: vi.fn(),
      collapseAll: vi.fn(),
      expand: vi.fn(),
    }),
}));

vi.mock("@/stores/epics/left-panel-store", () => ({
  DEFAULT_LEFT_PANEL_ID: "chats",
  isArtifactFilterActive: () => testState.artifactFilterKinds.length > 0,
  isChatFilterActive: () => testState.chatFilterOrigin !== "all",
  useAcknowledgedRootCreatePending: () => null,
  useActiveLeftPanelId: () => testState.activePanelId,
  useArtifactFilter: () => ({
    statuses: [],
    kinds: testState.artifactFilterKinds,
    read: "all",
  }),
  useArtifactSort: () => ({ field: "updated", direction: "desc" }),
  useChatFilter: () => ({ origin: testState.chatFilterOrigin }),
  useChatSort: () => ({ field: "updated", direction: "desc" }),
  useCommentsPanelRevealed: () => false,
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
  useLeftPanelGroups: () => [{ panelIds: [testState.activePanelId] }],
  useLeftPanelSectionCollapsed: (panelId: string) =>
    testState.collapsedPanelIds.has(panelId),
  useLocalRootCreatePending: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useAncestorIds: () => new Set<string>(),
  useChildIds: (parentId: string) =>
    testState.tree.childrenByParent[parentId] ?? [],
  useEpicActiveAgentIds: () => testState.activeAgentIds,
  // Awareness reports a tier per working agent. An agent whose host did not
  // classify it reads as "turn", so tests that only set `activeAgentIds` keep
  // their pre-tier behaviour.
  useEpicAgentActivityTiers: () =>
    new Map(
      [...testState.activeAgentIds].map((id) => [
        id,
        testState.activityTierById.get(id) ?? "turn",
      ]),
    ),
  useEpicArtifact: (artifactId: string | null) => {
    if (artifactId === null) return null;
    const node = testState.tree.nodeById[artifactId];
    if (node === undefined) return null;
    return {
      id: node.id,
      kind: node.type,
      title: node.title,
      updatedAt: node.updatedAt,
    };
  },
  useEpicArtifactRecords: () => testState.records,
  useEpicArtifactStatus: (artifactId: string) =>
    testState.tree.nodeById[artifactId]?.status ?? null,
  useEpicChatHarnessId: (nodeId: string) =>
    testState.chatHarnessIds[nodeId] ?? null,
  useEpicConnectionStatus: () => "open",
  useEpicNodeHostId: () => testState.rowHostId,
  useEpicNodeOwnerKind: () => "chat",
  // Stable empty array (reference-stable across renders) so the chat-row seed
  // effect's dependency never changes and it never seeds in these tests.
  useEpicNodeWorkspaceFolders: () => EMPTY_WORKSPACE_FOLDERS,
  useEpicPermissionRole: () => testState.permissionRole,
  useEpicSnapshotMeta: () => ({ epicLight: { title: "Test epic" } }),
  useEpicTreeIndex: () => testState.tree,
  useEpicTreeNode: (nodeId: string) => testState.tree.nodeById[nodeId] ?? null,
  useMaybeEpicTuiAgentHarnessId: (nodeId: string) =>
    testState.tuiHarnessIds[nodeId] ?? null,
  useRootIds: () => testState.tree.rootIds,
}));

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshotLoaded: testState.snapshotLoaded,
      artifacts: {
        allIds: testState.records
          .filter((record) => record.type !== "chat")
          .filter((record) => record.type !== "terminal-agent")
          .map((record) => record.id),
        byId: Object.fromEntries(
          testState.records.map((record) => [
            record.id,
            {
              id: record.id,
              kind: record.type,
              status: record.status,
              title: record.name,
              updatedAt: 1,
            },
          ]),
        ),
      },
    }),
}));

const seedEpicArtifacts = vi.hoisted(() => vi.fn());
const markRead = vi.hoisted(() => vi.fn());
const useArtifactReadStateStoreMock = vi.hoisted(() => {
  const store = Object.assign(
    vi.fn((selector: (state: unknown) => unknown) =>
      selector({
        lastSeenByArtifact: {},
        markRead,
        seedAtByEpic: {},
        seedEpicArtifacts,
      }),
    ),
    {
      getState: () => ({
        lastSeenByArtifact: {},
        markRead,
        seedAtByEpic: {},
        seedEpicArtifacts,
      }),
    },
  );
  return store;
});

vi.mock("@/stores/epics/artifact-read-state-store", () => ({
  isArtifactUnread: (args: { readonly artifactId: string }) =>
    testState.unreadArtifactIds.has(args.artifactId),
  useArtifactReadStateStore: useArtifactReadStateStoreMock,
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
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

import {
  EpicLeftPanelHost,
  EpicLeftPanelLoadingHost,
} from "@/components/epic-canvas/sidebar/epic-sidebar";
import {
  BASE_PAD_LEFT,
  INDENT_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

const TAB_ID = "tab-1";
const EPIC_ID = "epic-1";

describe("epic sidebar selection mode", () => {
  beforeEach(() => {
    testState.deleteArtifactMutateAsync.mockResolvedValue({});
    testState.deleteChatMutateAsync.mockResolvedValue({});
    testState.deleteTuiAgentMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.sessionReady = true;
    testState.snapshotLoaded = true;
    testState.activeArtifactId = null;
    testState.activePanelId = "chats";
    testState.artifactFilterKinds = [];
    testState.chatFilterOrigin = "all";
    testState.collapsedPanelIds = new Set<string>();
    testState.expandedIds = new Set<string>();
    testState.unreadArtifactIds = new Set<string>();
    testState.tree = {
      rootIds: [],
      childrenByParent: {},
      nodeById: {},
    };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.chatHarnessIds = {};
    testState.tuiHarnessIds = {};
    testState.permissionRole = "owner";
    testState.rowHostId = "host-1";
    testState.rowHostEntry = { hostId: "host-1" };
    testState.rowHostClient = { getActiveHostId: () => "host-1" };
    testState.activeHostClient = { getActiveHostId: () => "host-1" };
  });

  it("selects chat rows explicitly and bulk-deletes topmost selected chat roots", async () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const startSelectionButton = screen.getByRole("button", {
      name: "Select agents",
    });
    expect(startSelectionButton.textContent).toBe("");
    expect(screen.queryByTestId("epic-sidebar-select-chat-root")).toBeNull();

    fireEvent.click(startSelectionButton);
    const chatCheckbox = screen.getByTestId("epic-sidebar-select-chat-root");
    expect(
      screen.getByTestId("epic-sidebar-item-chat-root").style.paddingLeft,
    ).toBe(`${BASE_PAD_LEFT}px`);
    expect(
      screen.getByTestId("epic-sidebar-item-chat-child").style.paddingLeft,
    ).toBe(`${INDENT_PX + BASE_PAD_LEFT}px`);
    expect(chatCheckbox.matches(":checked")).toBe(false);
    fireEvent.click(chatCheckbox);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-chats")
        .matches(":disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => checkbox.matches(":checked")),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("epic-sidebar-delete-selected-chats"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteChatMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        chatId: "chat-root",
      });
    });
    expect(testState.deleteChatMutateAsync).not.toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: "chat-child",
    });
    expect(testState.deleteTuiAgentMutateAsync).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      tuiAgentId: "agent-root",
    });
  });

  it("toggles the Select all button to Deselect all once everything is selected", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("button", { name: "Select agents" }));

    // Nothing selected yet: the button offers "Select all".
    expect(screen.queryByRole("button", { name: "Deselect all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => checkbox.matches(":checked")),
    ).toBe(true);
    // All selected: the button flips to "Deselect all".
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));

    // Back to nothing selected, but still in selection mode (checkboxes stay
    // rendered) and the button reverts to "Select all".
    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => !checkbox.matches(":checked")),
    ).toBe(true);
    expect(
      screen.queryByTestId("epic-sidebar-select-chat-root"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Select all" })).not.toBeNull();
  });

  it("renders loading chat and artifact panels before the epic session handle exists", () => {
    testState.sessionReady = false;

    render(
      <EpicLeftPanelLoadingHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    expect(screen.getByTestId("epic-sidebar")).not.toBeNull();
  });

  it("names the primary panel Agents and offers an interface choice when empty", () => {
    testState.activePanelId = "chats";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByText("Agents")).not.toBeNull();
    expect(screen.getByTestId("epic-chat-sidebar-empty")).not.toBeNull();
    expect(screen.getByText("No agents yet.")).not.toBeNull();
    expect(
      screen.getByText("Add an agent and choose a Chat or Terminal interface."),
    ).not.toBeNull();
    expect(screen.queryByText("No agents use this interface.")).toBeNull();
  });

  it("blames the interface filter, not the Task, when a filter hides every agent", () => {
    seedGuiChatTree();
    testState.chatFilterOrigin = "tui";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-chat-sidebar-filter-empty")).not.toBeNull();
    // The Task HAS agents - they just use the other interface. The empty state
    // must not read as "this Task has no agents".
    expect(screen.getByText("No agents use this interface.")).not.toBeNull();
    expect(screen.queryByText("No agents yet.")).toBeNull();
  });

  it("shows the empty artifact panel state when there are no artifacts", () => {
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-artifact-sidebar-empty")).not.toBeNull();
    expect(screen.getByText("No artifacts yet.")).not.toBeNull();
    expect(screen.queryByText("No artifacts match the filter.")).toBeNull();
  });

  it("shows the filtered artifact empty state when no artifacts match the filter", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.artifactFilterKinds = ["review"];

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.getByTestId("epic-artifact-sidebar-filter-empty"),
    ).not.toBeNull();
    expect(screen.getByText("No artifacts match the filter.")).not.toBeNull();
    expect(screen.queryByText("No artifacts yet.")).toBeNull();
  });

  it("hides sidebar bulk selection for viewer roles", () => {
    seedChatTree();
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByRole("button", { name: "Select agents" })).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-select-chat-root")).toBeNull();
  });

  it("uses the shared chat menu for terminal-agent row actions", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-more-agent-root")).not.toBeNull();
    expect(screen.getByTestId("epic-sidebar-rename-agent-root")).not.toBeNull();
    expect(screen.getByTestId("epic-sidebar-delete-agent-root")).not.toBeNull();
    expect(screen.getByTestId("epic-sidebar-more-chat-root")).not.toBeNull();
  });

  it("subscripts only TUI harness brands", () => {
    seedChatTree();
    testState.chatHarnessIds = {
      "chat-root": "codex",
      "chat-child": "claude",
    };
    testState.tuiHarnessIds = { "agent-root": "codex" };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByTestId("sidebar-agent-harness-chat-root")
        .getAttribute("data-agent-surface"),
    ).toBe("gui");
    expect(screen.queryByTestId("sidebar-agent-surface-chat-root")).toBeNull();
    expect(
      screen
        .getByTestId("sidebar-agent-harness-agent-root")
        .getAttribute("data-agent-surface"),
    ).toBe("tui");
    expect(
      screen
        .getByTestId("sidebar-agent-surface-agent-root")
        .getAttribute("data-agent-surface"),
    ).toBe("tui");
  });

  it("does not subscript harness brands in a GUI-only task", () => {
    seedGuiChatTree();
    testState.chatHarnessIds = {
      "chat-root": "codex",
      "chat-child": "claude",
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("sidebar-agent-surface-chat-root")).toBeNull();
    expect(screen.queryByTestId("sidebar-agent-surface-chat-child")).toBeNull();
  });

  it("subscripts harness brands in a TUI-only task", () => {
    seedTuiAgentTree();
    testState.tuiHarnessIds = { "agent-root": "codex" };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const terminalSubscript = screen.getByTestId(
      "sidebar-agent-surface-agent-root",
    );
    const terminalHarness = screen.getByTestId(
      "sidebar-agent-harness-agent-root",
    );
    expect(terminalSubscript.getAttribute("data-agent-surface")).toBe("tui");
    expect(terminalSubscript.tagName.toLowerCase()).toBe("svg");
    expect(terminalSubscript.getAttribute("stroke-width")).toBe("3");
    expect(terminalSubscript.getAttribute("class")).toContain("-right-1");
    expect(terminalSubscript.getAttribute("class")).toContain("-bottom-1.5");
    expect(terminalSubscript.getAttribute("class")).toContain(
      "text-muted-foreground",
    );
    expect(terminalSubscript.getAttribute("class")).not.toContain(
      "bg-background",
    );
    expect(terminalSubscript.getAttribute("class")).not.toContain("ring");
    expect(terminalHarness.getAttribute("class")).toContain("w-[1.125rem]");
  });

  it("keeps chat add inline and exposes ellipsis actions on right-click", async () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const chatRow = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(
      chatRow.parentElement?.querySelector('[aria-label="Add child agent"]'),
    ).not.toBeNull();
    fireEvent.contextMenu(chatRow);

    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete" })).not.toBeNull();
  });

  it("keeps artifact add inline and exposes ellipsis actions on right-click", async () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-add-spec-root")).not.toBeNull();
    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-spec-root"));

    expect(
      await screen.findByRole("menuitem", { name: "Export as Markdown" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Rename" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete" })).not.toBeNull();
  });

  it("enters chat selection mode from cmd-click on a row", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-select-chat-root")).toBeNull();

    fireEvent.click(screen.getByTestId("epic-sidebar-item-chat-root"), {
      metaKey: true,
    });

    expect(
      screen.getByTestId("epic-sidebar-select-chat-root").matches(":checked"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-chats")
        .matches(":disabled"),
    ).toBe(false);
  });

  it("clears chat selection when the section collapses", async () => {
    seedChatTree();

    const { rerender } = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-chats")
        .matches(":disabled"),
    ).toBe(false);

    testState.collapsedPanelIds = new Set(["chats"]);
    rerender(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("epic-sidebar-delete-selected-chats"),
      ).toBeNull();
    });
    expect(
      screen
        .getByRole("button", { name: "Select agents" })
        .matches(":disabled"),
    ).toBe(true);
  });

  it("disables collapsed chat header tools except add", () => {
    seedChatTree();
    testState.collapsedPanelIds = new Set(["chats"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.getByRole("button", { name: "Chat filter" }).matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Select agents" })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("epic-sidebar-collapse-all-chats")
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Add agent" }).matches(":disabled"),
    ).toBe(false);
  });

  it("disables collapsed artifact header tools except add", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.collapsedPanelIds = new Set(["artifacts"]);
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByRole("button", { name: "Artifact filter" })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Select artifacts" })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("epic-sidebar-collapse-all-artifacts")
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Mark all unread artifacts as read" })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Add artifact" }).matches(":disabled"),
    ).toBe(false);
  });

  it("hides artifact selection when there are no artifacts to select", () => {
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.queryByRole("button", { name: "Select artifacts" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add artifact" }),
    ).not.toBeNull();
  });

  it("keeps mark-all-read hidden at rest and disables it when no artifacts are unread", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    const { rerender } = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    const markAllReadButton = screen.getByRole("button", {
      name: "Mark all unread artifacts as read",
    });

    expect(markAllReadButton.matches(":disabled")).toBe(true);
    expect(markAllReadButton.className).toContain("disabled:opacity-0");
    expect(markAllReadButton.className).toContain(
      "disabled:group-hover/panel-section:opacity-50",
    );
    expect(markAllReadButton.className).toContain(
      "disabled:group-focus-within/panel-section:opacity-50",
    );

    testState.unreadArtifactIds = new Set(["ticket-child"]);
    rerender(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByRole("button", {
          name: "Mark all unread artifacts as read",
        })
        .matches(":disabled"),
    ).toBe(false);

    testState.unreadArtifactIds = new Set<string>();
    rerender(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByRole("button", {
          name: "Mark all unread artifacts as read",
        })
        .matches(":disabled"),
    ).toBe(true);
  });

  it("marks every unread artifact read from the artifact header action", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.unreadArtifactIds = new Set(["spec-root", "ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Mark all unread artifacts as read",
      }),
    );

    expect(markRead).toHaveBeenCalledWith(EPIC_ID, "spec-root", 2);
    expect(markRead).toHaveBeenCalledWith(EPIC_ID, "ticket-child", 2);
  });

  it("exports one artifact from its row actions for viewers", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(
      screen.getByTestId("epic-sidebar-export-markdown-spec-root"),
    );

    expect(testState.exportArtifactsMutate).toHaveBeenCalledWith({
      archive: false,
      archiveTitle: null,
      artifacts: [{ id: "spec-root", title: "Root spec" }],
      format: "markdown",
    });
    expect(
      screen.getByTestId("epic-sidebar-rename-spec-root").matches(":disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("epic-sidebar-delete-spec-root").matches(":disabled"),
    ).toBe(true);
  });

  it("bulk-exports every selected visible artifact, including descendants", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("button", { name: "Select artifacts" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-spec-root"));
    expect(
      screen
        .getByTestId("epic-sidebar-export-selected-markdown")
        .matches(":disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("epic-sidebar-select-ticket-child"));
    expect(
      screen
        .getByTestId("epic-sidebar-export-selected-markdown")
        .matches(":disabled"),
    ).toBe(false);
    fireEvent.click(
      screen.getByTestId("epic-sidebar-export-selected-markdown"),
    );

    expect(testState.exportArtifactsMutate).toHaveBeenCalledWith({
      archive: true,
      archiveTitle: "Test epic",
      artifacts: [
        { id: "spec-root", title: "Root spec" },
        { id: "ticket-child", title: "Child ticket" },
      ],
      format: "markdown",
    });
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-artifacts")
        .matches(":disabled"),
    ).toBe(true);
  });

  it("selects artifact rows explicitly and bulk-deletes topmost selected artifacts", async () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("button", { name: "Select artifacts" }));
    expect(
      screen.getByTestId("epic-sidebar-item-ticket-child").style.paddingLeft,
    ).toBe(`${INDENT_PX + BASE_PAD_LEFT}px`);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-artifacts")
        .matches(":disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(
      screen.getByTestId("epic-sidebar-delete-selected-artifacts"),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteArtifactMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        artifactId: "spec-root",
      });
    });
    expect(testState.deleteArtifactMutateAsync).not.toHaveBeenCalledWith({
      epicId: EPIC_ID,
      artifactId: "ticket-child",
    });
  });

  it("enters artifact selection mode from cmd-click on a row", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-select-spec-root")).toBeNull();

    fireEvent.click(screen.getByTestId("epic-sidebar-item-spec-root"), {
      metaKey: true,
    });

    expect(
      screen.getByTestId("epic-sidebar-select-spec-root").matches(":checked"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-artifacts")
        .matches(":disabled"),
    ).toBe(false);
  });

  it("renders nested unread markers inside the artifact row title area", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const row = screen.getByTestId("epic-sidebar-item-ticket-child");
    const marker = screen.getByTestId("epic-sidebar-unread-ticket-child");
    expect(row.contains(marker)).toBe(true);
    expect(marker.className).not.toContain("absolute");
    expect(marker.getAttribute("data-unread-marker")).toBe("self");
    // Solid bar (exact token, not the muted `bg-blue-500/50` descendant class)
    // for the artifact's own unread state.
    expect(marker.classList.contains("bg-blue-500")).toBe(true);
    // An expanded, read parent shows no marker (its child carries its own bar).
    expect(screen.queryByTestId("epic-sidebar-unread-spec-root")).toBeNull();
  });

  it("shows a descendant unread marker on a collapsed parent artifact", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.expandedIds = new Set<string>();
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-item-ticket-child")).toBeNull();
    const marker = screen.getByTestId("epic-sidebar-unread-spec-root");
    expect(
      screen.getByTestId("epic-sidebar-item-spec-root").contains(marker),
    ).toBe(true);
    expect(marker.getAttribute("data-unread-marker")).toBe("descendant");
    // A muted (not full-opacity) bar distinguishes "contains unread" from "is unread".
    expect(marker.className).toContain("bg-blue-500/50");
  });

  it("hides the descendant marker once the parent is expanded", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.expandedIds = new Set(["spec-root"]);
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // Expanded: the child is visible with its own marker and the parent shows
    // none (no double-signal of the same unread artifact).
    expect(
      screen.getByTestId("epic-sidebar-unread-ticket-child"),
    ).not.toBeNull();
    expect(screen.queryByTestId("epic-sidebar-unread-spec-root")).toBeNull();
  });

  it("seeds the artifact read baseline once the snapshot is loaded", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(seedEpicArtifacts).toHaveBeenCalledWith(
      EPIC_ID,
      expect.arrayContaining([
        expect.objectContaining({ id: "spec-root" }),
        expect.objectContaining({ id: "ticket-child" }),
      ]),
    );
  });

  it("does not seed the read baseline before the snapshot is loaded", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.snapshotLoaded = false;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(seedEpicArtifacts).not.toHaveBeenCalled();
  });

  it("marks the active artifact read when it is the active tile", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.activeArtifactId = "ticket-child";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(markRead).toHaveBeenCalledWith(EPIC_ID, "ticket-child", 1);
  });

  it("does not mark read when the active tile is not an artifact", () => {
    seedChatTree();
    testState.activePanelId = "chats";
    testState.activeArtifactId = "chat-root";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(markRead).not.toHaveBeenCalled();
  });
});

describe("chat descendant status rollup", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = {
      rootIds: [],
      childrenByParent: {},
      nodeById: {},
    };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.chatFilterOrigin = "all";
  });

  function seedNestedChatTree(): void {
    const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
    const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
    const chatGrandchild = treeNode(
      "chat-grandchild",
      "chat-child",
      "Grandchild chat",
      "chat",
    );
    const agentChild = treeNode(
      "agent-child",
      "chat-root",
      "Terminal agent",
      "terminal-agent",
    );
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = {
      rootIds: ["chat-root"],
      childrenByParent: {
        "chat-root": ["chat-child", "agent-child"],
        "chat-child": ["chat-grandchild"],
      },
      nodeById: {
        "chat-root": chatRoot,
        "chat-child": chatChild,
        "chat-grandchild": chatGrandchild,
        "agent-child": agentChild,
      },
    };
    testState.records = [chatRoot, chatChild, chatGrandchild, agentChild].map(
      recordFromNode,
    );
  }

  function indicator(
    overrides: Partial<TestIndicatorState>,
  ): TestIndicatorState {
    return {
      unreadFailure: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
      ...overrides,
    };
  }

  it("bubbles a hidden grandchild's needs-attention status onto the collapsed root", () => {
    seedNestedChatTree();
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    // The grandchild's row is not even mounted, yet its status reaches the
    // collapsed root as the rollup badge.
    expect(
      screen.queryByTestId("epic-sidebar-item-chat-grandchild"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();

    // Expanding the root moves the rollup down to the still-collapsed child.
    testState.expandedIds = new Set(["chat-root"]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeTruthy();

    // Fully expanded: the grandchild presents its own status, no rollups left.
    testState.expandedIds = new Set(["chat-root", "chat-child"]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeNull();
    expect(
      screen.getByTestId("epic-sidebar-item-chat-grandchild"),
    ).toBeTruthy();
  });

  it("rolls an active terminal-agent descendant up as running, outranked by failure", () => {
    seedNestedChatTree();
    testState.activeAgentIds = new Set(["agent-child"]);
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadDone: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    // Running outranks unread completion...
    expect(
      screen.getByTestId("chat-descendant-status-running-chat-root"),
    ).toBeTruthy();

    // ...and a failure anywhere below outranks running.
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadDone: true }),
      "chat-child": indicator({ unreadFailure: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();
  });

  it("lets a hidden failure take the slot from a merely-running parent, with a breakdown tooltip", () => {
    seedNestedChatTree();
    testState.activeAgentIds = new Set(["chat-root", "agent-child"]);
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
      "chat-child": indicator({ unreadDone: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // The parent is running (rank below failure), so the nested failure owns
    // the icon slot - rendered as the muted variant in place of the parent's
    // own icon, with the tooltip carrying the full nested breakdown.
    const nested = screen.getByTestId(
      "chat-descendant-status-failure-chat-root",
    );
    expect(nested.getAttribute("title")).toBe(
      "Nested: 1 needs attention · 1 running · 1 completed",
    );
    expect(screen.queryByTestId("chat-sidebar-spinner")).toBeNull();
  });

  it("keeps the slot with the parent when its own status is at least as urgent", () => {
    seedNestedChatTree();
    // Parent's own failure vs a nested running agent: parent outranks.
    testState.activeAgentIds = new Set(["agent-child"]);
    testState.indicatorChats = {
      "chat-root": indicator({ unreadFailure: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();
    expect(screen.getByTestId("chat-sidebar-spinner")).toBeTruthy();

    // Equal tiers: the tie goes to the parent's own (solid) presentation.
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.indicatorChats = {
      "chat-root": indicator({ pendingApproval: true }),
      "chat-grandchild": indicator({ pendingApproval: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-approval-chat-root"),
    ).toBeNull();
    expect(screen.getByTestId("chat-sidebar-spinner")).toBeTruthy();
  });

  it("distinguishes a background-only descendant from one mid-turn", () => {
    seedNestedChatTree();
    // The grandchild is non-idle, but only because a background task
    // (run_in_background / Monitor / a scheduled wakeup) is keeping it alive -
    // the agent itself is not executing. Before the awareness tier existed
    // this was indistinguishable from a live turn.
    testState.activeAgentIds = new Set(["chat-grandchild"]);
    testState.activityTierById = new Map([["chat-grandchild", "background"]]);

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    const backgroundIcon = screen.getByTestId(
      "chat-descendant-status-background-chat-root",
    );
    expect(backgroundIcon).toBeTruthy();
    expect(backgroundIcon.getAttribute("class")).toContain("opacity-60");
    expect(
      backgroundIcon.querySelector(".lucide-message-square-clock"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();

    // Same descendant, now genuinely mid-turn: the busier tier takes the slot.
    testState.activityTierById = new Map([["chat-grandchild", "turn"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("chat-descendant-status-running-chat-root"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("chat-descendant-status-background-chat-root"),
    ).toBeNull();
  });

  it("ranks a descendant's turn above a descendant's background work", () => {
    seedNestedChatTree();
    testState.activeAgentIds = new Set(["chat-child", "chat-grandchild"]);
    testState.activityTierById = new Map([
      ["chat-child", "background"],
      ["chat-grandchild", "turn"],
    ]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    const icon = screen.getByTestId("chat-descendant-status-running-chat-root");
    expect(icon).toBeTruthy();
    // The tooltip breaks the aggregate down across both tiers.
    expect(icon.getAttribute("title")).toContain("1 running");
    expect(icon.getAttribute("title")).toContain("1 in background");
  });

  it("lets a descendant's turn outrank the parent's own background work", () => {
    seedNestedChatTree();
    // Parent is non-idle but only in background; a hidden descendant is
    // actually mid-turn, so the busier nested tier must win the slot rather
    // than being masked by the parent's own (lower) tier.
    testState.activeAgentIds = new Set(["chat-root", "chat-grandchild"]);
    testState.activityTierById = new Map([
      ["chat-root", "background"],
      ["chat-grandchild", "turn"],
    ]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expect(
      screen.getByTestId("chat-descendant-status-running-chat-root"),
    ).toBeTruthy();
  });

  it("shows an unread-done rollup and nothing when descendants are idle", () => {
    seedNestedChatTree();
    testState.indicatorChats = {
      "chat-child": indicator({ unreadDone: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("chat-descendant-status-done-chat-root"),
    ).toBeTruthy();

    testState.indicatorChats = {};
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-done-chat-root"),
    ).toBeNull();
  });

  it("ranks interview above approval, both outranked by failure", () => {
    seedNestedChatTree();
    testState.indicatorChats = {
      "chat-child": indicator({ pendingApproval: true }),
      "chat-grandchild": indicator({ pendingInterview: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("chat-descendant-status-interview-chat-root"),
    ).toBeTruthy();

    testState.indicatorChats = {
      ...testState.indicatorChats,
      "chat-child": indicator({ unreadFailure: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-interview-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();
  });

  it("excludes a filter-hidden subtree from the rollup while keeping a visible descendant's status", () => {
    seedNestedChatTree();
    // GUI-only origin filter hides the terminal-agent descendant entirely -
    // its active-run state must not leak into the rollup as "running" - while
    // the chat subtree (still reachable under the filter) keeps surfacing.
    testState.chatFilterOrigin = "gui";
    testState.activeAgentIds = new Set(["agent-child"]);
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();
  });
});

function seedChatTree(): void {
  const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
  const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
  const agentRoot = treeNode(
    "agent-root",
    null,
    "Terminal agent",
    "terminal-agent",
  );
  testState.activePanelId = "chats";
  testState.expandedIds = new Set(["chat-root"]);
  testState.tree = {
    rootIds: ["chat-root", "agent-root"],
    childrenByParent: { "chat-root": ["chat-child"] },
    nodeById: {
      "agent-root": agentRoot,
      "chat-child": chatChild,
      "chat-root": chatRoot,
    },
  };
  testState.records = [chatRoot, chatChild, agentRoot].map(recordFromNode);
}

function seedGuiChatTree(): void {
  const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
  const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
  testState.activePanelId = "chats";
  testState.expandedIds = new Set(["chat-root"]);
  testState.tree = {
    rootIds: ["chat-root"],
    childrenByParent: { "chat-root": ["chat-child"] },
    nodeById: {
      "chat-child": chatChild,
      "chat-root": chatRoot,
    },
  };
  testState.records = [chatRoot, chatChild].map(recordFromNode);
}

function seedTuiAgentTree(): void {
  const agentRoot = treeNode(
    "agent-root",
    null,
    "Terminal agent",
    "terminal-agent",
  );
  testState.activePanelId = "chats";
  testState.tree = {
    rootIds: ["agent-root"],
    childrenByParent: {},
    nodeById: { "agent-root": agentRoot },
  };
  testState.records = [recordFromNode(agentRoot)];
}

function seedArtifactTree(): void {
  const specRoot = treeNode("spec-root", null, "Root spec", "spec");
  const ticketChild = treeNode(
    "ticket-child",
    "spec-root",
    "Child ticket",
    "ticket",
  );
  testState.expandedIds = new Set(["spec-root"]);
  testState.tree = {
    rootIds: ["spec-root"],
    childrenByParent: { "spec-root": ["ticket-child"] },
    nodeById: {
      "spec-root": specRoot,
      "ticket-child": ticketChild,
    },
  };
  testState.records = [specRoot, ticketChild].map(recordFromNode);
}

function treeNode(
  id: string,
  parentId: string | null,
  title: string,
  type: TestTreeNode["type"],
): TestTreeNode {
  return {
    id,
    parentId,
    title,
    type,
    status: type === "ticket" ? 0 : null,
    createdAt: 1,
    updatedAt: 2,
  };
}

function recordFromNode(node: TestTreeNode): TestRecord {
  return {
    id: node.id,
    parentId: node.parentId,
    name: node.title,
    type: node.type,
    status: node.status,
    hostId: "host-1",
  };
}
