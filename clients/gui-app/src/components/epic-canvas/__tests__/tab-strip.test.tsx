vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/components/chat/chat-progress-icon", () => ({
  ChatProgressIcon: () => <span data-testid="chat-progress-icon" />,
}));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { LandingTerminalTabStrip } from "@/components/home/terminal-panel/landing-terminal-tab-strip";
import { PersonMembersContext } from "@/hooks/identity/use-person-identity";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
  SplitDirection,
} from "@/stores/epics/canvas/types";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { writeFieldKey } from "@/stores/epics/open-epic/write-field-key";
import type { LandingTerminalTabRef } from "@/stores/home/landing-panel-store";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";
import { NotificationConsumptionContext } from "@/components/notifications/notification-consumption-context";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { markRenameInFlight } from "@/stores/epics/open-epic/rename-in-flight";

interface CapturedDraggableInput {
  readonly id: string;
  readonly data: unknown;
}

interface CapturedDroppableInput {
  readonly id: string;
  readonly data: unknown;
}

interface TabStripTestState {
  draggableInputs: CapturedDraggableInput[];
  droppableInputs: CapturedDroppableInput[];
  isDragging: boolean;
  browserSessionsByHost: Map<string, readonly BrowserSessionInfo[]>;
}

const testState = vi.hoisted((): TabStripTestState => ({
  draggableInputs: [],
  droppableInputs: [],
  isDragging: false,
  browserSessionsByHost: new Map(),
}));

interface TerminalAuthorityTestState {
  capability: "unknown" | "legacy" | "capable";
  canMutate: boolean;
  viewModel: {
    readonly displayTitle: string;
    readonly manualTitle: string | null;
    readonly activeProcessName: string | null;
    readonly liveCwd: string | null;
  } | null;
  rename: Mock<
    (request: {
      readonly terminalId: string;
      readonly manualTitle: string;
    }) => void
  >;
  close: Mock<(request: { readonly terminalId: string }) => void>;
}

const terminalAuthorityState = vi.hoisted((): TerminalAuthorityTestState => ({
  capability: "legacy",
  canMutate: false,
  viewModel: null,
  rename:
    vi.fn<
      (request: {
        readonly terminalId: string;
        readonly manualTitle: string;
      }) => void
    >(),
  close: vi.fn<(request: { readonly terminalId: string }) => void>(),
}));

const docRenameHarness = vi.hoisted(() => ({
  enabled: false,
}));

const consumeNotificationEntity = vi.hoisted(() => vi.fn());

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (input: CapturedDraggableInput) => {
    testState.draggableInputs.push(input);
    return {
      setNodeRef: () => undefined,
      listeners: undefined,
      isDragging: testState.isDragging,
    };
  },
  useDroppable: (input: CapturedDroppableInput) => {
    testState.droppableInputs.push(input);
    return {
      setNodeRef: () => undefined,
    };
  },
}));

/**
 * The live title the strip resolves for a tile, keyed by tile id. Entries
 * stand in for the projection answering with a title; a tile without one
 * resolves to its own snapshot, as the real hook's last arm does.
 */
const liveTitlesById = vi.hoisted((): Map<string, string> => new Map());

vi.mock("@/lib/epic-selectors", () => {
  return {
    useEpicTabDisplayTitle: (node: EpicCanvasTileRef) =>
      liveTitlesById.get(node.id) ?? node.name,
    useEpicLiveArtifactTitleGenerating: () => false,
    useRegisteredEpicNodeArchived: () => false,
    useRegisteredEpicFileArtifactViewer: () => null,
    useRegisteredEpicActiveAgentIds: () => new Set<string>(),
    useMaybeEpicTuiAgentHarnessId: () => null,
  };
});

// TabItem resolves the tab's bound-host client for terminal renames; these
// tests render outside a <HostRuntimeProvider>, so stub the host seam.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/components/epic-canvas/renderers/use-browser-sessions", () => ({
  useBrowserSessionsForHost: (args: { readonly hostId: string | null }) => ({
    hostId: args.hostId,
    lifecycle: "live",
    inventoryReady: true,
    items:
      args.hostId === null
        ? []
        : (testState.browserSessionsByHost.get(args.hostId) ?? []),
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used")),
    closeTab: () => Promise.resolve(),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: () => undefined }),
}));

vi.mock("@/hooks/terminal/use-epic-terminal-authority", () => ({
  useEpicTerminalAuthority: () => ({
    capability: terminalAuthorityState.capability,
    projection:
      terminalAuthorityState.capability === "capable" ? {} : undefined,
    viewModel: terminalAuthorityState.viewModel,
    canMutate: terminalAuthorityState.canMutate,
    migrationPending: false,
    migrationError: null,
    retryMigration: () => undefined,
    ensureRunning: {},
    rename: { mutate: terminalAuthorityState.rename },
    close: {
      isPending: false,
      mutateAsync: (request: { readonly terminalId: string }) => {
        terminalAuthorityState.close(request);
        return Promise.resolve();
      },
    },
  }),
}));

vi.mock("@/hooks/epic/use-terminal-agent-doc-rename", () => ({
  useTerminalAgentDocRename: () => docRenameHarness.enabled,
}));

const VIEW_TAB_ID = "view-tab-1";

const TAB: EpicNodeRef = {
  id: "workspace-file:host-A:/repo:a.md",
  instanceId: "inst-tab-a",
  type: "workspace-file",
  name: "a.md",
  hostId: "host-A",
  workspacePath: "/repo",
  filePath: "a.md",
};

const ARTIFACT_TAB: EpicNodeRef = {
  id: "spec-1",
  instanceId: "inst-spec-1",
  type: "spec",
  name: "Architecture",
  hostId: "host-A",
};

const TERMINAL_TAB: EpicNodeRef = {
  id: "terminal-1",
  instanceId: "inst-terminal-1",
  type: "terminal",
  name: "Local presentation",
  titleSource: "manual",
  hostId: "host-A",
  cwd: "/repo",
};

const terminalDirectory = new Map<
  string,
  { readonly displayName: string; readonly avatarUrl: string | null }
>();
const terminalDirectoryResolver: BotMemberResolver = (userId) =>
  terminalDirectory.get(userId) ?? null;

const CHAT_TAB: EpicNodeRef = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat",
  name: "Agent chat",
  hostId: "host-B",
};

const TERMINAL_AGENT_TAB: EpicNodeRef = {
  id: "terminal-agent-tab",
  instanceId: "inst-terminal-agent-tab",
  type: "terminal-agent",
  name: "Registry agent",
  hostId: "host-B",
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function browserSessionsState(
  items: readonly BrowserSessionInfo[],
): BrowserSessionsState {
  return {
    hostId: "host-A",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 0,
    items,
    viewports: {},
    setViewport: () => Promise.reject(new Error("not used")),
    reportViewport: () => undefined,
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used")),
    prepareOpenTab: () => {
      throw new Error("not used");
    },
    closeTab: () => Promise.resolve(),
    attachTab: () => Promise.reject(new Error("not used")),
    moveTab: () => Promise.reject(new Error("not used")),
  };
}

// TabItem reads its active/preview/globally-active state from the canvas store
// (via `useTabActivation`), not from props, so seed a tab whose lone group has
// `TAB` as the active + preview tab.
function seedActivePreviewTab(
  tab: EpicCanvasTileRef,
  additionalTabs: readonly EpicCanvasTileRef[],
): void {
  const tabs = [tab, ...additionalTabs];
  const tilesByInstanceId: Record<string, EpicCanvasTileRef> = {};
  for (const item of tabs) tilesByInstanceId[item.instanceId] = item;
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: "epic-1",
        name: "Epic 1",
      },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        activePaneId: "group-1",
        root: {
          kind: "pane",
          id: "group-1",
          tabInstanceIds: tabs.map((item) => item.instanceId),
          activeTabId: tab.instanceId,
          previewTabId: tab.instanceId,
          activationHistory: [tab.instanceId],
        },
        tilesByInstanceId,
        sizesByGroupId: {},
      },
    },
  });
}

function renderTabStrip(input: {
  readonly onClose: (groupId: string, tabId: string) => void;
  readonly onMenuClose?: (groupId: string, tabId: string) => void;
  readonly onPromotePreview: (groupId: string) => void;
  readonly onOpenBlankTab: (groupId: string) => void;
  readonly onSplit:
    | ((groupId: string, direction: SplitDirection) => void)
    | undefined;
}) {
  renderTabStripForTab(TAB, input, []);
}

function renderTabStripForTab(
  tab: EpicCanvasTileRef,
  input: {
    readonly inactive?: boolean;
    readonly onClose: (groupId: string, tabId: string) => void;
    readonly onMenuClose?: (groupId: string, tabId: string) => void;
    readonly onPromotePreview: (groupId: string) => void;
    readonly onOpenBlankTab: (groupId: string) => void;
    readonly onSplit:
      | ((groupId: string, direction: SplitDirection) => void)
      | undefined;
  },
  browserSessions: readonly BrowserSessionInfo[],
) {
  renderTabStripWithSession(tab, input, {
    browserSessions,
    session: null,
    additionalTabs: [],
  });
}

function renderTabStripWithSession(
  tab: EpicCanvasTileRef,
  input: {
    readonly inactive?: boolean;
    readonly onClose: (groupId: string, tabId: string) => void;
    readonly onMenuClose?: (groupId: string, tabId: string) => void;
    readonly onPromotePreview: (groupId: string) => void;
    readonly onOpenBlankTab: (groupId: string) => void;
    readonly onSplit:
      | ((groupId: string, direction: SplitDirection) => void)
      | undefined;
  },
  context: {
    readonly browserSessions: readonly BrowserSessionInfo[];
    readonly session: OpenEpicStoreHandle | null;
    readonly additionalTabs: readonly EpicCanvasTileRef[];
  },
) {
  const { browserSessions, session, additionalTabs } = context;
  for (const session of browserSessions) {
    const current = testState.browserSessionsByHost.get(session.hostId) ?? [];
    testState.browserSessionsByHost.set(session.hostId, [...current, session]);
  }
  seedActivePreviewTab(tab, additionalTabs);
  if (input.inactive === true) {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined) throw new Error("Expected seeded canvas");
    if (canvas.root?.kind !== "pane") {
      throw new Error("Expected a seeded root pane");
    }
    useEpicCanvasStore.setState({
      canvasByTabId: {
        [VIEW_TAB_ID]: {
          ...canvas,
          root: {
            ...canvas.root,
            activeTabId: null,
            previewTabId: null,
          },
        },
      },
    });
  }
  const queryClient = createQueryClient();
  const onSplit = input.onSplit === undefined ? () => undefined : input.onSplit;
  const strip = (
    <TabStrip
      epicId="epic-1"
      tabId={VIEW_TAB_ID}
      groupId="group-1"
      tabs={[tab, ...additionalTabs]}
      activeTabId={tab.instanceId}
      onSelectTab={() => undefined}
      onCloseTab={input.onClose}
      onPromotePreview={input.onPromotePreview}
      onSplit={onSplit}
      onCloseGroup={() => undefined}
      onOpenBlankTab={input.onOpenBlankTab}
      canRenameTabs
      menuHandlers={{
        onClose: input.onMenuClose ?? (() => undefined),
        onCloseOthers: () => undefined,
        onCloseRight: () => undefined,
        onCloseAll: () => undefined,
        onSplit: () => undefined,
        onRevealInSidebar: () => undefined,
        onRename: () => undefined,
      }}
    />
  );
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={browserSessionsState(browserSessions)}
      >
        <NotificationConsumptionContext.Provider
          value={consumeNotificationEntity}
        >
          <TooltipProvider delayDuration={0}>
            <PersonMembersContext.Provider value={terminalDirectoryResolver}>
              <EpicSessionContext.Provider value={session}>
                {strip}
              </EpicSessionContext.Provider>
            </PersonMembersContext.Provider>
          </TooltipProvider>
        </NotificationConsumptionContext.Provider>
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

const occupiedArtifactTabs = [
  {
    id: "artifact-a",
    instanceId: "artifact-a-instance",
    type: "spec",
    name: "Spec A",
    hostId: "host-A",
  },
  {
    id: "artifact-b",
    instanceId: "artifact-b-instance",
    type: "ticket",
    name: "Ticket B",
    hostId: "host-A",
  },
] satisfies readonly EpicCanvasTileRef[];

const openedTestSessions: OpenedStoreForTest[] = [];

async function openOccupiedArtifactTabSession(): Promise<OpenedStoreForTest> {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const streamClientFactory: EpicStreamClientFactory = (_epicId, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: "epic-1",
    userId: null,
    factories: { streamClientFactory, laneSelection: null },
    writeCommand: () =>
      new Promise<{ readonly hostId: string }>(() => undefined),
  });
  if (captured.value === null) throw new Error("stream factory not invoked");

  const seed = new Y.Doc();
  const epic = seed.getMap<unknown>("epic");
  const artifacts = new Y.Map<unknown>();
  for (const tab of occupiedArtifactTabs) {
    const entry = new Y.Map<unknown>();
    entry.set("id", tab.id);
    entry.set("kind", tab.type);
    entry.set("title", tab.name);
    entry.set("parentId", null);
    entry.set("createdAt", 1);
    entry.set("updatedAt", 2);
    artifacts.set(tab.id, entry);
  }
  epic.set("title", "Tab strip fixture");
  epic.set("artifacts", artifacts);
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
  const meta: SnapshotMetaEpic = {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
      title: "Tab strip fixture",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 1,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "fixture",
      version: "1",
    },
    permissionRole: "owner",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: btoa(
      String.fromCharCode(...Y.encodeStateVector(seed)),
    ),
  };
  captured.value.onConnectionStatus("open", null, true, null);
  captured.value.onSnapshot(meta, Y.encodeStateAsUpdate(seed));
  seed.destroy();

  const submission = handle.store.getState().submitWriteCommand({
    kind: "rename-artifact",
    artifactId: occupiedArtifactTabs[0].id,
    title: "Busy artifact title",
  });
  if (submission === "busy")
    throw new Error("the tab strip fixture's first rename was refused");
  const commandId = await submission;
  if (commandId === null) throw new Error("expected artifact rename admission");
  await handle.flush();
  const busyKey = writeFieldKey("rename", occupiedArtifactTabs[0].id);
  if (handle.store.getState().occupiedWriteFields[busyKey] !== true)
    throw new Error("the tab strip fixture did not retain occupied membership");
  openedTestSessions.push(handle);
  return handle;
}

describe("<TabStrip />", () => {
  afterEach(() => {
    cleanup();
    for (const handle of openedTestSessions.splice(0)) handle.dispose();
    terminalDirectory.clear();
    docRenameHarness.enabled = false;
    vi.unstubAllGlobals();
    testState.draggableInputs = [];
    testState.droppableInputs = [];
    testState.isDragging = false;
    testState.browserSessionsByHost.clear();
    terminalAuthorityState.capability = "legacy";
    terminalAuthorityState.canMutate = false;
    terminalAuthorityState.viewModel = null;
    terminalAuthorityState.rename.mockReset();
    terminalAuthorityState.close.mockReset();
    consumeNotificationEntity.mockReset();
    liveTitlesById.clear();
    useSelectionAuthorityStore.getState().reset();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useEpicDndStore.setState(useEpicDndStore.getInitialState(), true);
  });

  it("draws no pictures of attached people in the canvas tab strip", () => {
    terminalDirectory.set("member-a", {
      displayName: "Member A",
      avatarUrl: "https://images.example.test/member-a.png",
    });
    terminalDirectory.set("member-b", {
      displayName: "Member B",
      avatarUrl: "https://images.example.test/member-b.png",
    });
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    expect(screen.getByTestId("tab-title-inst-terminal-1")).toBeTruthy();
    expect(screen.queryByTestId("terminal-viewers")).toBeNull();
    expect(screen.queryByTestId("terminal-viewers-more")).toBeNull();
    expect(screen.queryAllByTestId("person-avatar")).toHaveLength(0);
  });

  it("draws no pictures of attached people in the landing panel's terminal tab", () => {
    terminalDirectory.set("landing-viewer", {
      displayName: "Landing Viewer",
      avatarUrl: "https://images.example.test/landing-viewer.png",
    });
    const landingTab: LandingTerminalTabRef = {
      kind: "terminal",
      instanceId: "landing-terminal-viewers",
      sessionId: "landing-viewers-session",
      hostId: "host-A",
      cwd: "/repo",
      name: "Team terminal",
      titleSource: "default",
    };

    render(
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider delayDuration={0}>
          <PersonMembersContext.Provider value={terminalDirectoryResolver}>
            <LandingTerminalTabStrip
              tabs={[landingTab]}
              placeholder={null}
              activeInstanceId={landingTab.instanceId}
              addTooltip="New tab"
              onAdd={() => undefined}
              onActivate={() => undefined}
              onClose={() => undefined}
              onDismissPlaceholder={() => undefined}
              onCloseAll={() => undefined}
              onRename={() => undefined}
              canRename={() => false}
              terminalViewModels={{}}
              browserViewModels={{}}
            />
          </PersonMembersContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Team terminal")).toBeTruthy();
    expect(screen.queryByTestId("terminal-viewers")).toBeNull();
    expect(screen.queryAllByTestId("person-avatar")).toHaveLength(0);
  });

  it("writes a chat tile's resolved title into its persisted name snapshot", () => {
    const openedUntitled: EpicNodeRef = { ...CHAT_TAB, name: "Untitled agent" };
    liveTitlesById.set(CHAT_TAB.id, "Side - what is design language");
    renderTabStripForTab(
      openedUntitled,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
        ?.tilesByInstanceId[CHAT_TAB.instanceId]?.name,
    ).toBe("Side - what is design language");
  });

  it("holds the snapshot write while a rename of the tile is in flight, and writes once it settles", () => {
    const openedUntitled: EpicNodeRef = { ...CHAT_TAB, name: "Untitled agent" };
    // The optimistic overlay: the strip resolves the requested title before
    // the host has answered.
    liveTitlesById.set(CHAT_TAB.id, "Requested title");
    const release = markRenameInFlight("epic-1", CHAT_TAB.id);
    try {
      renderTabStripForTab(
        openedUntitled,
        {
          onClose: () => undefined,
          onPromotePreview: () => undefined,
          onOpenBlankTab: () => undefined,
          onSplit: undefined,
        },
        [],
      );
      const snapshotName = () =>
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
          ?.tilesByInstanceId[CHAT_TAB.instanceId]?.name;
      expect(snapshotName()).toBe("Untitled agent");

      act(() => release());

      expect(snapshotName()).toBe("Requested title");
    } finally {
      // Idempotent: a no-op after the release above, frees the mark when an
      // assertion fails first.
      release();
    }
  });

  it("leaves a terminal tile's name snapshot to the terminal rename path", () => {
    liveTitlesById.set(TERMINAL_TAB.id, "zsh · build");
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
        ?.tilesByInstanceId[TERMINAL_TAB.instanceId],
    ).toBe(TERMINAL_TAB);
  });

  it("shows the insertion separator when returning a tile to its own strip", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    act(() => {
      useEpicDndStore.getState().canvasDragStarted(
        {
          kind: "artifact-tab",
          epicId: "epic-1",
          viewTabId: VIEW_TAB_ID,
          sourceGroupId: "group-1",
          tabId: TAB.instanceId,
          isPreview: false,
        },
        TAB,
      );
      useEpicDndStore.getState().dropPreviewChanged({
        kind: "artifact-tab-strip",
        groupId: "group-1",
        index: 0,
      });
    });

    expect(screen.getByTestId("tab-strip-drop-indicator")).toBeTruthy();
  });

  it("retains a dimmed source tab in its strip while dragging", () => {
    testState.isDragging = true;
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const frame = screen
      .getByTestId(`tab-item-${TAB.instanceId}`)
      .closest("[data-tile-item-id]");
    if (!(frame instanceof HTMLElement)) {
      throw new Error("Expected the tab item frame to be an HTMLElement");
    }
    expect(frame.style.opacity).toBe("0.36");
  });

  it("uses the live browser tab title, URL, and favicon", () => {
    const browserTab: EpicCanvasTileRef = {
      id: "browser-session:session-1:browser-tab-1",
      instanceId: "browser-instance-1",
      type: "browser-session",
      name: "Browser",
      hostId: "host-A",
      sessionId: "session-1",
      tabId: "browser-tab-1",
      viewportPreset: "responsive",
    };
    renderTabStripForTab(
      browserTab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: () => undefined,
      },
      [
        sessionInfo({
          sessionId: "session-1",
          hostId: "host-A",
          lastActivityAt: 2,
          runtime: { kind: "electron", revision: 0 },
          tabs: [
            tabInfo({
              tabId: "browser-tab-1",
              url: "https://thepier5.com/",
              originTier: "external",
              title: "Waterfront Hotel in Baltimore | Pier 5 Hotel",
              viewed: true,
            }),
          ],
        }),
      ],
    );

    const tab = screen.getByRole("tab", {
      name: /Waterfront Hotel in Baltimore \| Pier 5 Hotel/,
    });
    expect(
      tooltipTextFor(screen.getByTestId("tab-title-browser-instance-1")),
    ).toContain("https://thepier5.com/");
    expect(tab.querySelector("img")?.getAttribute("src")).toBe(
      "https://thepier5.com/favicon.ico",
    );
  });

  it("uses the browser tab's host inventory for cross-host presentation", () => {
    const browserTab: EpicCanvasTileRef = {
      id: "browser-session:session-1:browser-tab-1",
      instanceId: "browser-instance-1",
      type: "browser-session",
      name: "Browser",
      hostId: "host-B",
      sessionId: "session-1",
      tabId: "browser-tab-1",
      viewportPreset: "responsive",
    };
    testState.browserSessionsByHost.set("host-B", [
      sessionInfo({
        sessionId: "session-1",
        hostId: "host-B",
        lastActivityAt: 2,
        runtime: { kind: "electron", revision: 0 },
        tabs: [
          tabInfo({
            tabId: "browser-tab-1",
            url: "https://thepier5.com/",
            originTier: "external",
            title: "Waterfront Hotel in Baltimore | Pier 5 Hotel",
            viewed: true,
          }),
        ],
      }),
    ]);
    renderTabStripForTab(
      browserTab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: () => undefined,
      },
      [],
    );

    const tab = screen.getByRole("tab", {
      name: /Waterfront Hotel in Baltimore \| Pier 5 Hotel/,
    });
    expect(
      tooltipTextFor(screen.getByTestId("tab-title-browser-instance-1")),
    ).toContain("https://thepier5.com/");
    expect(tab.querySelector("img")?.getAttribute("src")).toBe(
      "https://thepier5.com/favicon.ico",
    );
  });

  it("renders preview tabs with an overlaid close button that does not reserve flex space", () => {
    const onClose = vi.fn();
    renderTabStrip({
      onClose,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const tab = screen.getByRole("tab", { name: /a\.md/ });
    expect(tab.getAttribute("data-preview")).toBe("true");
    expect(tab.querySelector(".italic")).toBeTruthy();

    const closeButton = screen.getByRole("button", { name: "Close a.md" });
    expect(closeButton.className).toContain("absolute");
    expect(closeButton.className).not.toContain("ml-1");

    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledWith("group-1", TAB.instanceId);
  });

  it("promotes preview tabs on double click", () => {
    const onPromotePreview = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onPromotePreview).toHaveBeenCalledWith("group-1");
  });

  it("marks the clicked active chat tab's host-qualified notifications read", () => {
    renderTabStripForTab(
      CHAT_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.click(screen.getByRole("tab", { name: /Agent chat/ }));

    expect(consumeNotificationEntity).toHaveBeenCalledWith({
      originHostId: "host-B",
      entity: { epicId: "epic-1", chatId: "chat-1" },
    });
  });

  it("marks an inactive chat tab's notifications read when selecting it", () => {
    renderTabStripForTab(
      CHAT_TAB,
      {
        inactive: true,
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.click(screen.getByRole("tab", { name: /Agent chat/ }));

    expect(consumeNotificationEntity).toHaveBeenCalledWith({
      originHostId: "host-B",
      entity: { epicId: "epic-1", chatId: "chat-1" },
    });
  });

  it("copies the absolute file path from a workspace-file tab context menu", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.contextMenu(screen.getByTestId(`tab-item-${TAB.instanceId}`));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy File Path" }));

    expect(writeText).toHaveBeenCalledWith("/repo/a.md");
  });

  it("does not offer the file-path action for non-file tabs", () => {
    renderTabStripForTab(
      ARTIFACT_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${ARTIFACT_TAB.instanceId}`),
    );

    expect(
      screen.queryByRole("menuitem", { name: "Copy File Path" }),
    ).toBeNull();
  });

  it.each([
    {
      name: "before readiness",
      capability: "unknown" as const,
      canMutate: false,
      viewModel: null,
      title: "Local presentation",
    },
    {
      name: "after PTY startup",
      capability: "capable" as const,
      canMutate: true,
      viewModel: {
        displayTitle: "Manual title",
        manualTitle: "Manual title",
        activeProcessName: "bun",
        liveCwd: "/repo/live",
      },
      title: "Manual title",
    },
  ])(
    "closes a terminal tab $name as a local presentation only",
    ({ capability, canMutate, viewModel, title }) => {
      terminalAuthorityState.capability = capability;
      terminalAuthorityState.canMutate = canMutate;
      terminalAuthorityState.viewModel = viewModel;
      const onClose = vi.fn((groupId: string, instanceId: string): void => {
        useEpicCanvasStore
          .getState()
          .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
      });
      renderTabStripForTab(
        TERMINAL_TAB,
        {
          onClose,
          onPromotePreview: () => undefined,
          onOpenBlankTab: () => undefined,
          onSplit: undefined,
        },
        [],
      );

      expect(
        screen.getByTestId(`tab-title-${TERMINAL_TAB.instanceId}`).textContent,
      ).toBe(title);

      fireEvent.click(screen.getByRole("button", { name: `Close ${title}` }));

      expect(terminalAuthorityState.close).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledWith("group-1", TERMINAL_TAB.instanceId);
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
          ?.tilesByInstanceId[TERMINAL_TAB.instanceId],
      ).toBeUndefined();
    },
  );

  it("offers Edit Title for a capable terminal tab", () => {
    terminalAuthorityState.capability = "capable";
    terminalAuthorityState.canMutate = true;
    terminalAuthorityState.viewModel = {
      displayTitle: "Manual title",
      manualTitle: "Manual title",
      activeProcessName: "bun",
      liveCwd: "/repo/live",
    };
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${TERMINAL_TAB.instanceId}`),
    );
    expect(screen.getByRole("menuitem", { name: "Edit Title" })).not.toBeNull();
  });

  it("keeps registry-backed Rename unavailable on the pool until its owner serves", () => {
    const authority = mountTestSelectionAuthority({
      hosts: [{ hostId: "host-B", kind: "remote", teamOwned: false }],
    });
    renderTabStripForTab(
      TERMINAL_AGENT_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    const tabItem = screen.getByTestId(
      `tab-item-${TERMINAL_AGENT_TAB.instanceId}`,
    );
    fireEvent.contextMenu(tabItem);
    const unavailableEditTitle = screen.getByRole("menuitem", {
      name: "Edit Title",
    });
    expect(unavailableEditTitle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(unavailableEditTitle);
    fireEvent.keyDown(unavailableEditTitle, { key: "Enter", code: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();

    act(() => {
      authority.connectComputer("host-B");
      authority.finishReturnDamping();
    });
    fireEvent.contextMenu(tabItem);
    const editTitle = screen.getByRole("menuitem", { name: "Edit Title" });
    expect(editTitle.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(editTitle);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("keeps occupied artifact Edit Title visible-disabled while a sibling can still enter rename", async () => {
    const session = await openOccupiedArtifactTabSession();
    const [occupiedTab, siblingTab] = occupiedArtifactTabs;

    renderTabStripWithSession(
      occupiedTab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      {
        browserSessions: [],
        session,
        additionalTabs: [siblingTab],
      },
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${occupiedTab.instanceId}`),
    );
    const occupiedEdit = await screen.findByRole("menuitem", {
      name: "Edit Title",
    });
    expect(occupiedEdit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(occupiedEdit);
    fireEvent.keyDown(occupiedEdit, { key: "Enter", code: "Enter" });
    expect(
      screen.queryByTestId(`tab-title-input-${occupiedTab.instanceId}`),
    ).toBeNull();

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${siblingTab.instanceId}`),
    );
    const siblingEdit = await screen.findByRole("menuitem", {
      name: "Edit Title",
    });
    expect(siblingEdit.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(siblingEdit);
    expect(
      await screen.findByTestId(`tab-title-input-${siblingTab.instanceId}`),
    ).toBeTruthy();
  });

  it("keeps doc-resident terminal-agent Rename available on the pool", () => {
    docRenameHarness.enabled = true;
    mountTestSelectionAuthority({ hosts: [] });
    renderTabStripForTab(
      TERMINAL_AGENT_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${TERMINAL_AGENT_TAB.instanceId}`),
    );
    const editTitle = screen.getByRole("menuitem", { name: "Edit Title" });
    expect(editTitle.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(editTitle);
    expect(
      screen.getByTestId(`tab-title-input-${TERMINAL_AGENT_TAB.instanceId}`),
    ).toBeTruthy();
  });

  it("closes a capable terminal tab from middle-click without a lifetime mutation", () => {
    terminalAuthorityState.capability = "capable";
    terminalAuthorityState.canMutate = true;
    terminalAuthorityState.viewModel = {
      displayTitle: "Manual title",
      manualTitle: "Manual title",
      activeProcessName: "bun",
      liveCwd: "/repo/live",
    };
    const onClose = vi.fn((groupId: string, instanceId: string): void => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
    });
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent(
      screen.getByTestId(`tab-item-${TERMINAL_TAB.instanceId}`),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );

    expect(terminalAuthorityState.close).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("group-1", TERMINAL_TAB.instanceId);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
        ?.tilesByInstanceId[TERMINAL_TAB.instanceId],
    ).toBeUndefined();
  });

  it.each([
    {
      name: "provider-login",
      tab: {
        id: "term-signin",
        instanceId: "inst-signin",
        type: "terminal" as const,
        name: "Copilot sign-in",
        titleSource: "manual" as const,
        hostId: "host-A",
        cwd: "~",
        origin: "provider-login" as const,
        originProviderId: "copilot" as const,
      },
    },
    {
      name: "setup",
      tab: {
        id: "term-setup",
        instanceId: "inst-setup",
        type: "terminal" as const,
        name: "Setup: traycer",
        titleSource: "manual" as const,
        hostId: "host-A",
        cwd: "/repo",
        origin: "setup" as const,
      },
    },
  ])(
    "closes a capable-host $name ref through the legacy coordinator branch",
    ({ tab }) => {
      // Import-exempt refs report capability: "legacy" from
      // useEpicTerminalAuthority even against a capable host, so the
      // coordinator can close them locally. Projection stays undefined.
      terminalAuthorityState.capability = "legacy";
      terminalAuthorityState.canMutate = true;
      const onClose = vi.fn((groupId: string, instanceId: string): void => {
        useEpicCanvasStore
          .getState()
          .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
      });
      renderTabStripForTab(
        tab,
        {
          onClose,
          onPromotePreview: () => undefined,
          onOpenBlankTab: () => undefined,
          onSplit: undefined,
        },
        [],
      );

      fireEvent.click(
        screen.getByRole("button", { name: `Close ${tab.name}` }),
      );
      expect(onClose).toHaveBeenCalledWith("group-1", tab.instanceId);
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
          ?.tilesByInstanceId[tab.instanceId],
      ).toBeUndefined();
      expect(terminalAuthorityState.close).not.toHaveBeenCalled();
    },
  );

  it("fails closed for unknown-capability terminal rename and still closes the presentation", () => {
    terminalAuthorityState.capability = "unknown";
    terminalAuthorityState.canMutate = false;
    const onMenuClose = vi.fn((groupId: string, instanceId: string): void => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
    });
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose: () => undefined,
        onMenuClose,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${TERMINAL_TAB.instanceId}`),
    );

    expect(screen.queryByRole("menuitem", { name: "Edit Title" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(onMenuClose).toHaveBeenCalledWith(
      "group-1",
      TERMINAL_TAB.instanceId,
    );
    expect(terminalAuthorityState.close).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
        ?.tilesByInstanceId[TERMINAL_TAB.instanceId],
    ).toBeUndefined();
  });

  it("opens a blank tab when the empty strip area is double-clicked", () => {
    const onOpenBlankTab = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab,
      onSplit: undefined,
    });

    // Double-clicking the strip-end container itself (not a tab) opens a blank.
    fireEvent.doubleClick(screen.getByTestId("tab-strip-end"));

    expect(onOpenBlankTab).toHaveBeenCalledWith("group-1");
  });

  it("maps vertical wheel movement to horizontal scroll when task tabs overflow", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const scroller = screen.getByTestId("tab-strip-end");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
    });

    fireEvent.wheel(scroller, { deltaY: 80, deltaMode: 0 });

    expect(scroller.scrollLeft).toBe(80);
  });

  it("does not open a blank tab when an existing tab is double-clicked", () => {
    const onOpenBlankTab = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab,
      onSplit: undefined,
    });

    // The guard (target === currentTarget) keeps tab double-clicks from
    // bubbling into a blank-tab open.
    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onOpenBlankTab).not.toHaveBeenCalled();
  });

  it("splits right by default and down when Shift is held for the click", () => {
    const onSplit = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit,
    });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.click(splitButton);
    fireEvent.click(splitButton, { shiftKey: true });

    expect(onSplit).toHaveBeenNthCalledWith(1, "group-1", "horizontal");
    expect(onSplit).toHaveBeenNthCalledWith(2, "group-1", "vertical");
  });

  it("shows the down-split affordance when focus arrives with Shift held", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.focus(splitButton);

    expect(splitButton.getAttribute("aria-label")).toBe("Split group down");
    expect(splitButton.getAttribute("data-split-direction")).toBe("vertical");
  });

  it("keeps the default affordance while neither hovered nor focused", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    expect(splitButton.getAttribute("data-split-direction")).toBe("horizontal");
  });

  it("updates the split affordance and tooltip while Shift is held", async () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.focus(splitButton);

    expect(splitButton.getAttribute("aria-label")).toBe("Split group right");
    expect(splitButton.getAttribute("data-split-direction")).toBe("horizontal");
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Shift+click to split down");
    expect(tooltip.querySelector('[data-slot="kbd"]')).not.toBeNull();

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });

    expect(splitButton.getAttribute("aria-label")).toBe("Split group down");
    expect(splitButton.getAttribute("data-split-direction")).toBe("vertical");
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Release Shift to split right",
    );
  });

  it("shows repository hierarchy in Git bundle titles and structured tooltips", async () => {
    const gitTab = makeGitBundleDiffTile({
      hostId: "host-A",
      runningDir: "/worktrees/right-click-context-menu/traycer",
      bundleGroup: "changes",
      repositoryContext: {
        workspaceLabel: "traycer-internal",
        repositoryLabel: "traycer",
      },
    });
    renderTabStripForTab(
      gitTab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    const title = screen.getByTestId(`tab-title-${gitTab.instanceId}`);
    expect(title.textContent).toBe("traycer-internal › traycer · Changes");

    fireEvent.focus(title);

    const tooltips = await screen.findAllByTestId(
      `git-diff-tab-tooltip-${gitTab.instanceId}`,
    );
    const tooltip = within(tooltips[0]);
    expect(tooltip.getByTestId("git-diff-tooltip-workspace").textContent).toBe(
      "Foldertraycer-internal",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-repository").textContent).toBe(
      "Repositorytraycer",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-scope").textContent).toBe(
      "DiffChanges",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-path").textContent).toBe(
      "Path/worktrees/right-click-context-menu/traycer",
    );
  });
});

/**
 * A shell's tab used to draw lucide `Activity` - a glyph no other shell surface
 * uses - so the strip was the one place a watcher did not look like a watcher.
 * It reads the same live record the tab TITLE already resolves, so the icon and
 * the name in one tab can never disagree.
 */
describe("<TabStrip /> shell output tabs", () => {
  const EPIC_ID = "epic-1";
  const CHAT_ID = "chat-shell";
  const HOST_ID = "host-A";

  afterEach(() => {
    cleanup();
    disposeManagedCommandChatSessions();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  function renderShellTab(monitoring: boolean | null): void {
    const tab = makeManagedCommandOutputTileRef({
      commandId: "cmd-1",
      hostId: HOST_ID,
    });
    if (monitoring !== null) {
      const session = installManagedCommandChatSession({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      });
      session.setCommands([
        managedCommandSchema.parse({
          id: "cmd-1",
          monitoring,
          description: "deploy watcher",
          command: "tail -f deploy.log",
          cwd: "/work/repo",
          cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
          status: { state: "running", pid: 41, startedAtMs: 1 },
          chatId: CHAT_ID,
          relaunchOnHostRestart: false,
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      ]);
    }
    renderTabStripForTab(
      tab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );
  }

  it("draws the shared shell glyph, following the live monitor flag", () => {
    renderShellTab(true);
    expect(document.querySelector("[data-monitor-icon='on']")).not.toBeNull();
  });

  it("draws the quiet glyph for a shell that is not watching", () => {
    renderShellTab(false);
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
  });

  it("falls back to the quiet glyph when the owning chat has no live session", () => {
    // A restored tab whose chat was never opened resolves to no record. A
    // watcher announces itself the moment its record lands; guessing "on"
    // meanwhile would be the strip inventing state.
    renderShellTab(null);
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
  });

  it("ignores a same-id shell living on another host", () => {
    // A cross-host clone keeps the source transcript's command ids. The tab is
    // bound to its own host for life, so a watching shell of the same id over
    // on the source host must not lend this tab its glyph - the tab cannot
    // open that shell's output at all.
    const session = installManagedCommandChatSession({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: "host-source",
    });
    session.setCommands([
      managedCommandSchema.parse({
        id: "cmd-1",
        monitoring: true,
        description: "deploy watcher",
        command: "tail -f deploy.log",
        cwd: "/work/repo",
        cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
        status: { state: "running", pid: 41, startedAtMs: 1 },
        chatId: CHAT_ID,
        relaunchOnHostRestart: false,
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    ]);
    renderTabStripForTab(
      makeManagedCommandOutputTileRef({ commandId: "cmd-1", hostId: HOST_ID }),
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    expect(document.querySelector("[data-monitor-icon='on']")).toBeNull();
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
    // ...and the title stays the tile's own name rather than the other host's
    // shell: the glyph and the name read the same lookup.
    expect(screen.queryByText("Monitor · deploy watcher")).toBeNull();
  });
});
