/**
 * Proves that the three sidebar open/close flows fixed for the back/forward
 * navigation regression commit through the route-aware opener boundary
 * (`useEpicNestedFocusNavigation` -> `prepareOpen.../prepareClose...`)
 * instead of calling raw canvas store actions directly. See the decision
 * artifact "Nested Focus Opener Boundary".
 *
 * `useEpicNestedFocusNavigation` is mocked with a spy that still invokes the
 * `prepare` callback (mirrors `file-row-navigation.test.tsx`), so each
 * assertion checks both that the boundary was called AND that the
 * underlying prepare/close logic ran with the right arguments.
 *
 * Root-create and single-delete still route through a `prepare*FocusTarget`
 * store action per item, so the canvas store mock deliberately omits raw
 * `openTileInTab`: a regression back to calling it directly throws instead
 * of silently passing.
 *
 * Bulk delete batches every close into ONE boundary call instead of one per
 * item - closing each tab through its own `prepareCloseCanvasTabFocusTarget`
 * would let an intermediate iteration's fallback focus (itself also being
 * deleted) get pushed as a route entry. Its mock backs `closeCanvasTab` /
 * `canvasByTabId` with the REAL `closeTab` reducer and the REAL
 * `getCurrentNestedFocusTarget` reader (both unmocked production code), so
 * the assertions check an actual post-batch focus target rather than a
 * canned stand-in. Revert-proofing here comes from asserting `navigateNested`
 * fires exactly ONCE per batch (a per-item loop fires N times) with a target
 * that is a genuine survivor / the unchanged current focus.
 */
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
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { closeTab } from "@/stores/epics/canvas/actions";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";

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

interface OpenArtifactLookupEntry {
  readonly paneId: string;
  readonly instanceId: string;
}

interface TestState {
  readonly navigateNested: Mock;
  readonly prepareOpenTileInTabFocusTarget: Mock;
  readonly prepareCloseCanvasTabFocusTarget: Mock;
  readonly createArtifactMutate: Mock;
  readonly deleteArtifactMutate: Mock;
  readonly deleteArtifactMutateAsync: Mock;
  readonly deleteChatMutateAsync: Mock;
  readonly deleteTuiAgentMutateAsync: Mock;
  readonly localDeleteArtifact: Mock;
  readonly markArtifactSelfDeleted: Mock;
  readonly unmarkArtifactSelfDeleted: Mock;
  readonly openArtifactByKey: Map<string, OpenArtifactLookupEntry>;
  canvasByTabId: Record<string, EpicCanvasState | undefined>;
  createdArtifactId: string;
  activeArtifactId: string | null;
  artifactFilterKinds: ReadonlyArray<string>;
  collapsedPanelIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  unreadArtifactIds: ReadonlySet<string>;
  tree: {
    readonly rootIds: readonly string[];
    readonly childrenByParent: Readonly<Record<string, readonly string[]>>;
    readonly nodeById: Readonly<Record<string, TestTreeNode | undefined>>;
  };
  records: readonly TestRecord[];
  permissionRole: "owner" | "editor" | "viewer" | null;
}

const testState = vi.hoisted<TestState>(() => ({
  navigateNested: vi.fn(
    (
      _epicId: string,
      _tabId: string,
      prepare: () => NestedFocusTarget | null,
    ) => prepare(),
  ),
  prepareOpenTileInTabFocusTarget: vi.fn((): NestedFocusTarget => ({
    paneId: "pane-new",
    tileInstanceId: "instance-new",
  })),
  prepareCloseCanvasTabFocusTarget: vi.fn((): NestedFocusTarget => ({
    paneId: "fallback-pane",
    tileInstanceId: "fallback-instance",
  })),
  createArtifactMutate: vi.fn(),
  deleteArtifactMutate: vi.fn(),
  deleteArtifactMutateAsync: vi.fn(),
  deleteChatMutateAsync: vi.fn(),
  deleteTuiAgentMutateAsync: vi.fn(),
  localDeleteArtifact: vi.fn(),
  markArtifactSelfDeleted: vi.fn(),
  unmarkArtifactSelfDeleted: vi.fn(),
  openArtifactByKey: new Map<string, OpenArtifactLookupEntry>(),
  canvasByTabId: {},
  createdArtifactId: "new-spec-1",
  activeArtifactId: null,
  artifactFilterKinds: [],
  collapsedPanelIds: new Set<string>(),
  expandedIds: new Set<string>(),
  unreadArtifactIds: new Set<string>(),
  tree: {
    rootIds: [],
    childrenByParent: {},
    nodeById: {},
  },
  records: [],
  permissionRole: "owner",
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => testState.navigateNested,
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
  AddNodeDropdown: (props: {
    readonly children: ReactNode;
    readonly onAdd: (type: string) => void;
  }) => (
    <div>
      {props.children}
      <button
        type="button"
        data-testid="epic-sidebar-add-artifact-root-spec"
        onClick={() => props.onAdd("spec")}
      >
        Add spec
      </button>
    </div>
  ),
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
  ChatProgressIcon: () => <span data-testid="chat-sidebar-spinner" />,
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
  useEpicCreateChat: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicCreateChatForHostClient: () => ({
    mutate: vi.fn(),
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
  useHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({ getActiveHostId: () => "host-1" }),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ hostId: "host-1" }),
}));

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicCreateArtifact: () => ({
    mutate: (
      variables: {
        readonly epicId: string;
        readonly parentId: string | null;
        readonly artifactType: string;
        readonly title: string;
      },
      options: {
        readonly onSuccess: (result: { readonly artifactId: string }) => void;
        readonly onError: () => void;
      },
    ) => {
      testState.createArtifactMutate(variables);
      options.onSuccess({ artifactId: testState.createdArtifactId });
    },
    isPending: false,
  }),
  useEpicDeleteArtifact: () => ({
    mutate: (
      variables: { readonly epicId: string; readonly artifactId: string },
      options: {
        readonly onSuccess: () => void;
        readonly onError: () => void;
      },
    ) => {
      testState.deleteArtifactMutate(variables);
      options.onSuccess();
    },
    mutateAsync: testState.deleteArtifactMutateAsync,
    isPending: false,
  }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
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
  useOpenEpicHandle: () => ({
    epicId: "epic-1",
    store: {
      getState: () => ({
        deleteArtifact: testState.localDeleteArtifact,
        renameArtifact: vi.fn(),
        chats: { byId: {} },
        tuiAgents: { byId: {} },
        artifacts: {
          byId: {
            [testState.createdArtifactId]: {
              id: testState.createdArtifactId,
              kind: "spec",
              title: "Spec",
            },
          },
        },
      }),
      subscribe: () => () => undefined,
    },
  }),
}));

// Deliberately omits raw `openTileInTab`: a regression back to calling it
// directly instead of the `prepare*FocusTarget` boundary throws (`... is not
// a function`) instead of silently passing. `closeCanvasTab` IS present here
// (the bulk-delete boundary batches through it deliberately - see file
// header), backed by the real `closeTab` reducer against `canvasByTabId` so
// `getCurrentNestedFocusTarget` in production code computes a real result.
vi.mock("@/stores/epics/canvas/store", () => ({
  findOpenArtifactInTab: (tabId: string, nodeId: string) => {
    const mapped = testState.openArtifactByKey.get(`${tabId}:${nodeId}`);
    if (mapped !== undefined) return mapped;
    const canvas = testState.canvasByTabId[tabId];
    if (
      canvas === undefined ||
      canvas.root === null ||
      canvas.root.kind !== "pane"
    ) {
      return null;
    }
    for (const instanceId of canvas.root.tabInstanceIds) {
      const tile = canvas.tilesByInstanceId[instanceId];
      if (tile !== undefined && tile.id === nodeId) {
        return { paneId: canvas.root.id, instanceId };
      }
    }
    return null;
  },
  useActiveEpicArtifactId: () => testState.activeArtifactId,
  useEpicCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeCanvasTab: (tabId: string, paneId: string, tileTabId: string) => {
          const current = testState.canvasByTabId[tabId];
          if (current === undefined) return;
          testState.canvasByTabId[tabId] = closeTab(current, paneId, tileTabId);
        },
        markArtifactSelfDeleted: testState.markArtifactSelfDeleted,
        openTilePreviewInTab: vi.fn(),
        pendingRootCreatesByEpic: {},
        preAckRootCreatesByEpic: {},
        promotePreviewInTab: vi.fn(),
        prepareOpenTileInTabFocusTarget:
          testState.prepareOpenTileInTabFocusTarget,
        prepareCloseCanvasTabFocusTarget:
          testState.prepareCloseCanvasTabFocusTarget,
        renameArtifactInTab: vi.fn(),
        unmarkArtifactSelfDeleted: testState.unmarkArtifactSelfDeleted,
      }),
    {
      getState: () => ({
        canvasByTabId: testState.canvasByTabId,
      }),
    },
  ),
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
  DEFAULT_LEFT_PANEL_ID: "artifacts",
  isArtifactFilterActive: () => testState.artifactFilterKinds.length > 0,
  isChatFilterActive: () => false,
  useAcknowledgedRootCreatePending: () => null,
  useActiveLeftPanelId: () => "artifacts",
  useArtifactFilter: () => ({
    statuses: [],
    kinds: testState.artifactFilterKinds,
    read: "all",
  }),
  useArtifactSort: () => ({ field: "updated", direction: "desc" }),
  useChatFilter: () => ({ origin: "all" }),
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
  useLeftPanelGroups: () => [{ panelIds: ["artifacts"] }],
  useLeftPanelSectionCollapsed: (panelId: string) =>
    testState.collapsedPanelIds.has(panelId),
  useLocalRootCreatePending: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useAncestorIds: () => new Set<string>(),
  useChildIds: (parentId: string) =>
    testState.tree.childrenByParent[parentId] ?? [],
  useEpicActiveAgentIds: () => new Set<string>(),
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
  useEpicConnectionStatus: () => "open",
  useEpicNodeHostId: () => "host-1",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
  useEpicPermissionRole: () => testState.permissionRole,
  useEpicTreeIndex: () => testState.tree,
  useEpicTreeNode: (nodeId: string) => testState.tree.nodeById[nodeId] ?? null,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useRootIds: () => testState.tree.rootIds,
}));

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshotLoaded: true,
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

import { EpicLeftPanelHost } from "@/components/epic-canvas/sidebar/epic-sidebar";

const TAB_ID = "tab-1";
const EPIC_ID = "epic-1";

describe("sidebar navigation boundary (back/forward regression fixes)", () => {
  beforeEach(() => {
    testState.deleteArtifactMutateAsync.mockResolvedValue({});
    testState.deleteChatMutateAsync.mockResolvedValue({});
    testState.deleteTuiAgentMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activeArtifactId = null;
    testState.artifactFilterKinds = [];
    testState.collapsedPanelIds = new Set<string>();
    testState.expandedIds = new Set<string>();
    testState.unreadArtifactIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.permissionRole = "owner";
    testState.openArtifactByKey.clear();
    testState.canvasByTabId = {};
    testState.createdArtifactId = "new-spec-1";
  });

  it("routes root-create-then-open through navigateNested + prepareOpenTileInTabFocusTarget", () => {
    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByTestId("epic-sidebar-add-artifact-root-spec"));

    expect(testState.createArtifactMutate).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: EPIC_ID, parentId: null }),
    );
    // The boundary must be the thing that opens the freshly-created tile -
    // asserting only on `prepareOpenTileInTabFocusTarget` would also pass a
    // raw `openTileInTab(...)` call reached via some other path, so both the
    // boundary call and the prepare call underneath it are checked.
    expect(testState.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      TAB_ID,
      expect.any(Function),
    );
    expect(testState.prepareOpenTileInTabFocusTarget).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({
        id: testState.createdArtifactId,
        type: "spec",
      }),
    );
  });

  it("routes single artifact delete-close through navigateNested + prepareCloseCanvasTabFocusTarget", async () => {
    seedSingleArtifact();
    testState.openArtifactByKey.set(`${TAB_ID}:spec-root`, {
      paneId: "pane-1",
      instanceId: "instance-1",
    });

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByTestId("epic-sidebar-more-spec-root"));
    fireEvent.click(screen.getByTestId("epic-sidebar-delete-spec-root"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteArtifactMutate).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        artifactId: "spec-root",
      });
    });
    expect(testState.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      TAB_ID,
      expect.any(Function),
    );
    expect(testState.prepareCloseCanvasTabFocusTarget).toHaveBeenCalledWith(
      TAB_ID,
      "pane-1",
      "instance-1",
    );
  });

  it("batches bulk delete of 3 open tabs (including the active one) into one navigateNested call that focuses the surviving tile", async () => {
    seedArtifactTriple();
    testState.canvasByTabId[TAB_ID] = buildCanvasWithTiles(
      [
        { instanceId: "tab-d", contentId: "spec-d", name: "D" },
        { instanceId: "tab-a", contentId: "spec-a", name: "A" },
        { instanceId: "tab-b", contentId: "spec-b", name: "B" },
        { instanceId: "tab-c", contentId: "spec-c", name: "C" },
      ],
      "tab-a",
    );

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("button", { name: "Select artifacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(
      screen.getByTestId("epic-sidebar-delete-selected-artifacts"),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteArtifactMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        artifactId: "spec-c",
      });
    });

    // Exactly ONE route write for the whole batch - a per-item loop through
    // `prepareCloseCanvasTabFocusTarget` would fire 3 times and let an
    // intermediate iteration's fallback (itself also being deleted) leak
    // into history.
    expect(testState.navigateNested).toHaveBeenCalledTimes(1);
    expect(testState.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      TAB_ID,
      expect.any(Function),
    );
    // All 3 deleted tabs are gone; only the untouched 4th tile (D) survives,
    // and the single prepared target - read from real post-batch canvas
    // state via `getCurrentNestedFocusTarget`, not a per-item fallback -
    // must point at that survivor, never at a deleted id.
    const finalCanvas = testState.canvasByTabId[TAB_ID];
    expect(finalCanvas.tilesByInstanceId["tab-a"]).toBeUndefined();
    expect(finalCanvas.tilesByInstanceId["tab-b"]).toBeUndefined();
    expect(finalCanvas.tilesByInstanceId["tab-c"]).toBeUndefined();
    expect(finalCanvas.tilesByInstanceId["tab-d"]).toBeDefined();
    expect(testState.navigateNested.mock.results[0]?.value).toEqual({
      paneId: "pane-1",
      tileInstanceId: "tab-d",
    });
  });

  it("batches bulk delete of only inactive open tabs into one navigateNested call whose target is the unchanged active tile", async () => {
    seedArtifactPair();
    testState.canvasByTabId[TAB_ID] = buildCanvasWithTiles(
      [
        { instanceId: "tab-d", contentId: "spec-d", name: "D" },
        { instanceId: "tab-b", contentId: "spec-b", name: "B" },
        { instanceId: "tab-c", contentId: "spec-c", name: "C" },
      ],
      "tab-d",
    );

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("button", { name: "Select artifacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(
      screen.getByTestId("epic-sidebar-delete-selected-artifacts"),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteArtifactMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        artifactId: "spec-c",
      });
    });

    expect(testState.navigateNested).toHaveBeenCalledTimes(1);
    // Neither closed tab was active, so the post-batch current focus equals
    // what it already was - the boundary still fires once (closes did
    // happen), and this unchanged target is what lets the real
    // `navigateNestedFocus` duplicate-suppression turn it into a no-op
    // route write; the sidebar code must not special-case this itself.
    expect(testState.navigateNested.mock.results[0]?.value).toEqual({
      paneId: "pane-1",
      tileInstanceId: "tab-d",
    });
    const finalCanvas = testState.canvasByTabId[TAB_ID];
    expect(finalCanvas.tilesByInstanceId["tab-b"]).toBeUndefined();
    expect(finalCanvas.tilesByInstanceId["tab-c"]).toBeUndefined();
    expect(finalCanvas.tilesByInstanceId["tab-d"]).toBeDefined();
    expect(
      finalCanvas.root?.kind === "pane" ? finalCanvas.root.activeTabId : null,
    ).toBe("tab-d");
  });
});

function seedSingleArtifact(): void {
  const specRoot = treeNode("spec-root", null, "Root spec", "spec");
  testState.tree = {
    rootIds: ["spec-root"],
    childrenByParent: {},
    nodeById: { "spec-root": specRoot },
  };
  testState.records = [recordFromNode(specRoot)];
}

function seedArtifactTriple(): void {
  const nodes = [
    treeNode("spec-a", null, "A", "spec"),
    treeNode("spec-b", null, "B", "spec"),
    treeNode("spec-c", null, "C", "spec"),
  ];
  testState.tree = {
    rootIds: nodes.map((node) => node.id),
    childrenByParent: {},
    nodeById: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
  testState.records = nodes.map(recordFromNode);
}

function seedArtifactPair(): void {
  const nodes = [
    treeNode("spec-b", null, "B", "spec"),
    treeNode("spec-c", null, "C", "spec"),
  ];
  testState.tree = {
    rootIds: nodes.map((node) => node.id),
    childrenByParent: {},
    nodeById: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
  testState.records = nodes.map(recordFromNode);
}

interface CanvasTileFixture {
  readonly instanceId: string;
  readonly contentId: string;
  readonly name: string;
}

/** Builds a real single-pane `EpicCanvasState` (all `tiles` in one pane) so
 * `closeTab` / `getCurrentNestedFocusTarget` (both real, unmocked production
 * code) compute genuine results against it. */
function buildCanvasWithTiles(
  tiles: ReadonlyArray<CanvasTileFixture>,
  activeInstanceId: string,
): EpicCanvasState {
  return {
    root: {
      kind: "pane",
      id: "pane-1",
      tabInstanceIds: tiles.map((tile) => tile.instanceId),
      activeTabId: activeInstanceId,
      previewTabId: null,
      activationHistory: [],
    },
    activePaneId: "pane-1",
    tilesByInstanceId: Object.fromEntries(
      tiles.map((tile) => [
        tile.instanceId,
        {
          id: tile.contentId,
          instanceId: tile.instanceId,
          type: "spec",
          name: tile.name,
          hostId: "host-1",
        },
      ]),
    ),
    sizesByGroupId: {},
  };
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
    status: null,
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
