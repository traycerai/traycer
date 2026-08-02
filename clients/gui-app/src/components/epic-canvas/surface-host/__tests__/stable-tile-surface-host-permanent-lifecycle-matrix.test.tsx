import "../../../../../__tests__/test-browser-apis";
import {
  StrictMode,
  useEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatStreamClient } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  __getChatSessionRegistryForTests,
  __setChatStreamClientFactoryForTests,
} from "@/lib/registries/chat-session-registry";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { resetFocusedComposerControlsForTests } from "@/lib/commands/composer-controls-registry";
import {
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import { createEpicSessionTestHarness } from "@/components/epic-canvas/__tests__/test-epic-session-harness";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import {
  collectPanes,
  findPanePath,
  getNodeAtPath,
  type TileLayoutNode,
} from "@/stores/epics/canvas/tile-tree";
import {
  group,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { resetTileSurfaceMembershipForTesting } from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { resetTileSurfaceEnvironmentRegistryForTesting } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { resetTileSurfaceGeometryCoordinatorForTesting } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import { resetChatRemoteDeletionRegistryForTesting } from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import { StableTileSurfaceHost } from "@/components/epic-canvas/surface-host/stable-tile-surface-host";
import { renderHostedChatSurfaceBody } from "@/components/epic-canvas/surface-host/hosted-chat-surface-body";
import { TileCanvas } from "@/components/epic-canvas/canvas/tile-canvas";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { getChatsMap } from "@/stores/epics/open-epic/projection-helpers";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { pointerEvent } from "@/components/epic-canvas/canvas/__tests__/test-pointer-events";

/**
 * Ticket 21 slice 5 (jsdom half): the PERMANENT lifecycle-matrix gate for the
 * REAL `ChatTile -> ChatMessages -> LegendList` chain, routed through the
 * REAL production wiring (`TileCanvas` + a real `StableTileSurfaceHost`
 * sibling using the REAL `renderHostedChatSurfaceBody` renderer), with the
 * stable-tile-surface-host switch ON.
 *
 * This is deliberately the real-body companion to the composite lifecycle
 * test in `stable-tile-surface-host.test.tsx`, which drives the same kind of
 * structural operations but against a SYNTHETIC body and a standalone
 * `<StableTileSurfaceHost>` (no `TabGroupView`/`TileCanvas`, no switch-ON
 * routing, no real chat content). Extend THIS file, not that one, when a new
 * structural canvas operation needs lifecycle coverage against real chat
 * content.
 */

vi.mock(
  "@/components/epic-canvas/surface-host/stable-tile-surface-host-switch",
  () => ({ STABLE_TILE_SURFACE_HOST_ENABLED: true }),
);

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: () => undefined,
    listeners: undefined,
    isDragging: false,
  }),
  useDroppable: () => ({ setNodeRef: () => undefined }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: () => undefined }),
}));

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: (props: {
      readonly surface: { readonly bindingResolved: boolean };
    }) => (
      <div
        data-testid="host-workspace-selector"
        data-binding-resolved={String(props.surface.bindingResolved)}
      />
    ),
    ActiveHostWorkspaceControls: () => null,
  }),
);

const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  onChange: () => () => undefined,
};
const MOCK_HOST_ENTRY = {
  hostId: "host-test",
  label: "Test host",
  kind: "local" as const,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  streamUrl: "ws://127.0.0.1:1/stream",
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: (hostId: string) =>
    hostId === MOCK_HOST_ENTRY.hostId ? MOCK_HOST_ENTRY : null,
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
}));

/**
 * Instrumentation-only wrapper around the REAL `ChatTile` (`importOriginal`,
 * following the `ChatMessage` render-probe precedent in
 * `chat-timeline.test.tsx`): gives a real numeric mount/unmount counter per
 * `instanceId` without mocking away any real rendering.
 */
const chatTileLifecycle = vi.hoisted(() => ({
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
}));

vi.mock(
  "@/components/epic-canvas/renderers/chat-tile",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/renderers/chat-tile")
      >();

    function ChatTileWithLifecycleProbe(
      props: Parameters<typeof actual.ChatTile>[0],
    ): ReactElement {
      const instanceId = props.node.instanceId;
      useEffect(() => {
        chatTileLifecycle.mounts.set(
          instanceId,
          (chatTileLifecycle.mounts.get(instanceId) ?? 0) + 1,
        );
        return () => {
          chatTileLifecycle.unmounts.set(
            instanceId,
            (chatTileLifecycle.unmounts.get(instanceId) ?? 0) + 1,
          );
        };
      }, [instanceId]);
      return <actual.ChatTile {...props} />;
    }

    return { ...actual, ChatTile: ChatTileWithLifecycleProbe };
  },
);

function mountCount(instanceId: string): number {
  return chatTileLifecycle.mounts.get(instanceId) ?? 0;
}
function unmountCount(instanceId: string): number {
  return chatTileLifecycle.unmounts.get(instanceId) ?? 0;
}

const EPIC_ID = "epic-lifecycle-matrix";
const VIEW_TAB_ID = "tab-1";
const HOST_ID = "host-test";

const CHAT_TRACKED: EpicCanvasTileRef = {
  id: "chat-tracked",
  instanceId: "inst-tracked",
  type: "chat",
  name: "Tracked Chat",
  hostId: HOST_ID,
};
const CHAT_SIBLING: EpicCanvasTileRef = {
  id: "chat-sibling",
  instanceId: "inst-sibling",
  type: "chat",
  name: "Sibling Chat",
  hostId: HOST_ID,
};
const CHAT_WRAP_PARTNER: EpicCanvasTileRef = {
  id: "chat-wrap-partner",
  instanceId: "inst-wrap-partner",
  type: "chat",
  name: "Wrap Partner Chat",
  hostId: HOST_ID,
};
const ALL_CHATS: ReadonlyArray<EpicCanvasTileRef> = [
  CHAT_TRACKED,
  CHAT_SIBLING,
  CHAT_WRAP_PARTNER,
];

const CHAT_RUN_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function buildChatYMap(chat: EpicCanvasTileRef): Y.Map<unknown> {
  const chatMap = new Y.Map<unknown>();
  chatMap.set("id", chat.id);
  chatMap.set("title", chat.name);
  chatMap.set("parentId", null);
  chatMap.set("createdAt", 0);
  chatMap.set("updatedAt", 0);
  const messages = new Y.Array<unknown>();
  messages.push([{ role: "user", content: `${chat.name} seed`, timestamp: 1 }]);
  chatMap.set("messages", messages);
  return chatMap;
}

function seedDocWithChats(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chatsMap = new Y.Map<unknown>();
  for (const chat of ALL_CHATS) {
    chatsMap.set(chat.id, buildChatYMap(chat));
  }
  epic.set("title", "Lifecycle Matrix Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", chatsMap);
}

/**
 * Mutation-check / row 13 helper: remote-delete a chat by removing its entry
 * from the chats map of the live epic Y.Doc.
 */
function deleteChatFromLiveDoc(chatId: string): void {
  const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
  if (handle === null) throw new Error("expected a live epic session handle");
  const chatsMap = getChatsMap(handle.doc);
  if (chatsMap === null) throw new Error("expected a live chats map");
  chatsMap.delete(chatId);
}

/** Row 13 recovery: re-insert a fresh Y.Map entry for the chat. */
function restoreChatToLiveDoc(chat: EpicCanvasTileRef): void {
  const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
  if (handle === null) throw new Error("expected a live epic session handle");
  const chatsMap = getChatsMap(handle.doc);
  if (chatsMap === null) throw new Error("expected a live chats map");
  chatsMap.set(chat.id, buildChatYMap(chat));
}

function emitChatSnapshot(
  chat: EpicCanvasTileRef,
  callbacks: ChatStreamCallbacks,
): void {
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: chat.id,
    snapshot: {
      chat: {
        id: chat.id,
        parentId: null,
        userId: "owner-1",
        hostId: chat.hostId,
        title: chat.name,
        createdAt: 0,
        updatedAt: 0,
        archivedAt: null,
        isTitleEditedByUser: false,
        settings: CHAT_RUN_SETTINGS,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [
          {
            role: "user",
            messageId: `${chat.id}-message-1`,
            sender: { type: "user", userId: "owner-1" },
            message: {
              kind: "user",
              content: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: `${chat.name} seed message` },
                    ],
                  },
                ],
              },
            },
            timestamp: 1,
            sessionAnchor: null,
          },
        ],
        events: [],
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: { entries: [] },
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
    },
  });
}

function createChatHarness(): { install(): void; teardown(): void } {
  return {
    install: () => {
      __setChatStreamClientFactoryForTests((_epicId, chatId, callbacks) => {
        setTimeout(() => {
          callbacks.onConnectionStatus("open", null);
          const chat = ALL_CHATS.find((candidate) => candidate.id === chatId);
          if (chat !== undefined) emitChatSnapshot(chat, callbacks);
        }, 0);
        const client: Pick<
          ChatStreamClient,
          "sendAction" | "close" | "sameTurnSteeringProtocolSupported"
        > = {
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          close: () => undefined,
        };
        return client;
      });
    },
    teardown: () => {
      __setChatStreamClientFactoryForTests(null);
      __getChatSessionRegistryForTests().disposeAll();
    },
  };
}

const epicHarness = createEpicSessionTestHarness(EPIC_ID);
const chatHarness = createChatHarness();

function resetSurfaceHostModules(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
  resetTileSurfaceGeometryCoordinatorForTesting();
  resetChatRemoteDeletionRegistryForTesting();
}

beforeEach(() => {
  installLegendListViewportMetrics();
  window.localStorage.clear();
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "owner-1",
      userName: "Owner",
      email: "owner@example.com",
    },
    contextMetadata: { userId: "owner-1", username: "Owner" },
  });
  useComposerDraftStore.setState({ drafts: {} });
  useComposerRunSettingsStore.getState().resetForTests();
  useComposerHarnessMemoryStore.getState().resetForTests();
  useSettingsStore.setState({
    steerOnModEnterEnabled: true,
    defaultSelection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
  });
  resetFocusedComposerControlsForTests();
  chatTileLifecycle.mounts.clear();
  chatTileLifecycle.unmounts.clear();
  resetSurfaceHostModules();
  epicHarness.install(seedDocWithChats, "editor");
  chatHarness.install();
});

afterEach(() => {
  cleanup();
  chatHarness.teardown();
  epicHarness.teardown();
  __getOpenEpicRegistryForTests().disposeAll();
  resetFocusedComposerControlsForTests();
  resetSurfaceHostModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Canvas / tab-strip seeding
// ---------------------------------------------------------------------------

function seedCanvas(
  root: TileLayoutNode,
  tiles: ReadonlyArray<EpicCanvasTileRef>,
  activePaneId: string,
): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: EPIC_ID,
        name: "Lifecycle Matrix",
      },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        root,
        activePaneId,
        tilesByInstanceId: Object.fromEntries(
          tiles.map((tile) => [tile.instanceId, tile]),
        ),
        sizesByGroupId: {},
      },
    },
    openTabOrder: [VIEW_TAB_ID],
    activeTabId: VIEW_TAB_ID,
  });
  useTabsStore.setState((state) => ({
    ...state,
    items: [
      {
        kind: "tab" as const,
        id: `tab:epic:${VIEW_TAB_ID}`,
        ref: { kind: "epic" as const, id: VIEW_TAB_ID },
      },
    ],
    activeItemId: `tab:epic:${VIEW_TAB_ID}`,
    stripOrder: [{ kind: "epic" as const, id: VIEW_TAB_ID }],
  }));
}

function currentCanvas(): EpicCanvasState {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
  if (canvas === undefined) throw new Error("expected canvas");
  return canvas;
}

// ---------------------------------------------------------------------------
// Render tree - the REAL production wiring
// ---------------------------------------------------------------------------

/**
 * A pane goes empty (and mounts the real PaneOpener, which needs a
 * CommandPaletteRouterContext) whenever a structural op vacates a pane -
 * the flat/wrap split rows and the tear-off row all do this. Navigation
 * itself is irrelevant to tile-identity assertions, so this is a no-op
 * stub matching the precedent in search-run-view.test.tsx (same
 * epic-canvas/canvas/__tests__ directory), not a defeated real dependency.
 */
function noopKeybindingRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

function renderMatrix(options: { readonly strictMode: boolean } | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree: ReactNode = (
    <TestRouterProvider>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={
            new MockRunnerHost({
              signInUrl: "https://example.com",
              authnBaseUrl: "https://auth.example.com",
              localHost: null,
              hosts: [],
              workspaceFolderPickerPaths: undefined,
              hasLocalHost: undefined,
              traycerCli: undefined,
            })
          }
        >
          <TooltipProvider>
            <CommandPaletteRouterContext.Provider
              value={noopKeybindingRouter()}
            >
              <TestEpicSessionWrapper epicId={EPIC_ID}>
                <SnapshotLoadingProvider
                  value={{ snapshotLoaded: true, snapshotFetchError: null }}
                >
                  <TileCanvas epicId={EPIC_ID} tabId={VIEW_TAB_ID} />
                  <StableTileSurfaceHost
                    renderRecordBody={renderHostedChatSurfaceBody}
                  />
                </SnapshotLoadingProvider>
              </TestEpicSessionWrapper>
            </CommandPaletteRouterContext.Provider>
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>
  );
  return render(
    options?.strictMode === true ? <StrictMode>{tree}</StrictMode> : tree,
  );
}

// ---------------------------------------------------------------------------
// DOM accessors, scoped to a hosted record so a query can never
// accidentally cross into an unrelated instance subtree.
// ---------------------------------------------------------------------------

function hostedRecord(container: HTMLElement, instanceId: string): HTMLElement {
  const element = container.querySelector(
    `[${HOSTED_TILE_INSTANCE_ID_ATTRIBUTE}="${instanceId}"]`,
  );
  if (element === null) {
    throw new Error(`expected a hosted record for ${instanceId}`);
  }
  return element as HTMLElement;
}

function queryHostedRecord(
  container: HTMLElement,
  instanceId: string,
): HTMLElement | null {
  return container.querySelector(
    `[${HOSTED_TILE_INSTANCE_ID_ATTRIBUTE}="${instanceId}"]`,
  );
}

function chatTileRoot(container: HTMLElement, instanceId: string): HTMLElement {
  const element = hostedRecord(container, instanceId).querySelector(
    '[data-testid="chat-tile"]',
  );
  if (element === null) {
    throw new Error(`expected a loaded chat-tile root for ${instanceId}`);
  }
  return element as HTMLElement;
}

function messagesScroll(
  container: HTMLElement,
  instanceId: string,
): HTMLElement {
  const element = hostedRecord(container, instanceId).querySelector(
    '[data-testid="chat-messages-scroll"]',
  );
  if (element === null) {
    throw new Error(`expected a chat-messages-scroll node for ${instanceId}`);
  }
  return element as HTMLElement;
}

function firstMessageRow(
  container: HTMLElement,
  instanceId: string,
): HTMLElement {
  const element = hostedRecord(container, instanceId).querySelector(
    "[data-message-id]",
  );
  if (element === null) {
    throw new Error(`expected at least one message row for ${instanceId}`);
  }
  return element as HTMLElement;
}

/**
 * Waits for the REAL `ChatTile -> ChatMessages -> LegendList` chain to
 * finish loading for `instanceId`: the loading marker is gone, the real
 * `chat-tile` wrapper has replaced it, and at least one real message row is
 * in the DOM. Only AFTER this resolves is a captured DOM node reference
 * meaningful (`chat-tile` also labels the pre-handle loading wrapper, a
 * different element, so capturing before this settles would pin the wrong
 * node identity).
 */
async function waitForHostedChatLoaded(
  container: HTMLElement,
  instanceId: string,
): Promise<void> {
  await waitFor(() => {
    const record = queryHostedRecord(container, instanceId);
    expect(record).not.toBeNull();
    expect(
      record?.querySelector('[data-testid="chat-tile-loading"]'),
    ).toBeNull();
    expect(record?.querySelector('[data-testid="chat-tile"]')).not.toBeNull();
    expect(record?.querySelector("[data-message-id]")).not.toBeNull();
  });
  await settleLegendList();
}

interface TrackedRefs {
  readonly chatTile: HTMLElement;
  readonly messagesScroll: HTMLElement;
  readonly firstRow: HTMLElement;
}

function captureRefs(container: HTMLElement, instanceId: string): TrackedRefs {
  return {
    chatTile: chatTileRoot(container, instanceId),
    messagesScroll: messagesScroll(container, instanceId),
    firstRow: firstMessageRow(container, instanceId),
  };
}

function expectRefsStable(
  container: HTMLElement,
  instanceId: string,
  before: TrackedRefs,
): void {
  expect(chatTileRoot(container, instanceId)).toBe(before.chatTile);
  expect(messagesScroll(container, instanceId)).toBe(before.messagesScroll);
  expect(firstMessageRow(container, instanceId)).toBe(before.firstRow);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe("StableTileSurfaceHost permanent lifecycle matrix (real store/coordinator, real ChatTile/ChatMessages/LegendList body)", () => {
  it("row 1 - background-tab add: an inert background tab never mounts, tracked active chat is untouched", async () => {
    seedCanvas(pane("p1", [CHAT_TRACKED.instanceId]), [CHAT_TRACKED], "p1");
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    const before = captureRefs(container, CHAT_TRACKED.instanceId);
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);

    act(() => {
      useEpicCanvasStore
        .getState()
        .openTileInBackgroundTab(VIEW_TAB_ID, CHAT_SIBLING);
    });

    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, before);
    // A background-only tab never becomes the active tab of its pane, so it
    // is never mounted at all (no keep-alive for chat tabs, see
    // `remountsOnTabSwitch` in `use-mounted-pane-tabs.ts`).
    expect(queryHostedRecord(container, CHAT_SIBLING.instanceId)).toBeNull();
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(0);
  });

  it("row 2 - same-pane reorder: real moveTabOnTabStrip action leaves the tracked chat mounted exactly once", async () => {
    seedCanvas(
      pane("p1", [CHAT_TRACKED.instanceId, CHAT_SIBLING.instanceId]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    const before = captureRefs(container, CHAT_TRACKED.instanceId);

    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p1",
        targetIndex: 1,
      });
    });

    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, before);
    expect(currentCanvas().root).not.toBeNull();
  });

  it("row 3 - cross-pane move: tracked chat AND an unrelated bystander pane both survive without remounting", async () => {
    // Three panes, not two: p2 hosts an unrelated bystander chat that is
    // NEITHER the move source NOR the move target, so this row is a clean
    // test of cross-pane geometry-move stability in isolation. (A two-pane
    // version where the target pane already has an active tab conflates
    // this with decision #17's real, INTENDED remount-on-deactivation
    // policy - see row 11's negative control - because dropping a tab onto
    // a pane makes the dropped tab that pane's new active tab, which
    // legitimately unmounts whatever was active there before.)
    seedCanvas(
      group("root-g", "horizontal", [
        pane("p1", [CHAT_TRACKED.instanceId]),
        pane("p2", [CHAT_SIBLING.instanceId]),
        pane("p3", []),
      ]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);
    const trackedBefore = captureRefs(container, CHAT_TRACKED.instanceId);
    const siblingBefore = captureRefs(container, CHAT_SIBLING.instanceId);

    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p3",
        targetIndex: 0,
      });
    });

    // Content: zero remounts for either instance.
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, trackedBefore);
    expectRefsStable(container, CHAT_SIBLING.instanceId, siblingBefore);

    // Thin-wrapper allowance: the pane-id attribute owned by the hosted
    // record is allowed (expected) to update, that is the geometry/env
    // republish this whole ticket exists to make cheap. Only the CONTENT
    // identity above is pinned to zero remounts.
    expect(
      hostedRecord(container, CHAT_TRACKED.instanceId).getAttribute(
        HOSTED_TILE_PANE_ID_ATTRIBUTE,
      ),
    ).toBe("p3");
  });

  it("row 3b - two-pane occupied-target move: the dragged chat survives, the displaced destination chat gets its one intended decision-17 remount, and the emptied source pane dissolves", async () => {
    // Review finding 2: row 3 only drives an empty-target move; row 11 only
    // drives `setActiveTileTab` (a plain in-pane switch), never
    // `moveTabOnTabStrip` across two panes. Neither composes the real drop's
    // three simultaneous consequences a genuine drag-onto-an-occupied-pane
    // produces. This row does.
    seedCanvas(
      group("root-g", "horizontal", [
        pane("pA", [CHAT_TRACKED.instanceId]),
        pane("pB", [CHAT_SIBLING.instanceId]),
      ]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "pA",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);
    const draggedBefore = captureRefs(container, CHAT_TRACKED.instanceId);
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(0);

    // Drag TRACKED (pA's only tab) onto pB, which already has SIBLING
    // active. `moveTabAcrossPanes` both makes TRACKED the new active tab of
    // pB (displacing SIBLING) and, since pA is now empty, closes pA -
    // dissolving the 2-child root group down to pB alone.
    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip(VIEW_TAB_ID, {
        sourcePaneId: "pA",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "pB",
        targetIndex: 0,
      });
    });

    // (a) The dragged chat: content continuity through the drop.
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, draggedBefore);

    // (b) The displaced destination chat: exactly the ONE intended
    // decision-17 remount (no longer pB's active tab -> chat tabs never
    // keep-alive when inactive -> real unmount), not a leaked hosted body.
    await waitFor(() => {
      expect(queryHostedRecord(container, CHAT_SIBLING.instanceId)).toBeNull();
    });
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(1);

    // (c) Source-pane dissolve: pA had only TRACKED, so the move empties
    // and closes it, collapsing the 2-child root group down to pB as the
    // bare root pane.
    const after = currentCanvas();
    if (after.root === null || after.root.kind !== "pane") {
      throw new Error(
        "expected the emptied source pane to dissolve, promoting pB to the bare root",
      );
    }
    expect(after.root.id).toBe("pB");
    // Dropped at targetIndex 0: TRACKED lands ahead of SIBLING in the strip.
    expect(after.root.tabInstanceIds).toEqual([
      CHAT_TRACKED.instanceId,
      CHAT_SIBLING.instanceId,
    ]);
    expect(after.root.activeTabId).toBe(CHAT_TRACKED.instanceId);
  });

  it("row 4 - edge/new-pane move: tracked chat moves into its own new pane without remounting", async () => {
    seedCanvas(
      pane("p1", [CHAT_TRACKED.instanceId, CHAT_SIBLING.instanceId]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    const before = captureRefs(container, CHAT_TRACKED.instanceId);
    const rootPaneId =
      currentCanvas().root?.kind === "pane" ? currentCanvas().root?.id : null;
    expect(rootPaneId).toBe("p1");

    act(() => {
      useEpicCanvasStore.getState().splitPaneWithTab(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p1",
        position: "right",
      });
    });

    const after = currentCanvas();
    if (after.root === null || after.root.kind !== "group") {
      throw new Error("expected the split to wrap the bare root pane");
    }
    expect(after.root.children).toHaveLength(2);
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, before);
  });

  it("row 5 - same-axis flat split: the MOVED chat survives the flat insertion, with the untouched tracked chat as an additional bystander check", async () => {
    seedCanvas(
      group("root-g", "horizontal", [
        pane("p1", [CHAT_TRACKED.instanceId]),
        pane("p2", [CHAT_SIBLING.instanceId]),
      ]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);
    const trackedBefore = captureRefs(container, CHAT_TRACKED.instanceId);
    // The chat the flat split actually MOVES - this is the row's real
    // subject. Review finding 1: an earlier version of this row loaded and
    // asserted only the untouched bystander (tracked), so it never proved
    // content continuity through the same-axis insertion it claims to
    // cover - a `Suspense` boundary keyed by `environment.placement.paneId`
    // could silently remount the moved chat's body and this row would still
    // pass. Capturing and re-asserting the SIBLING's own refs below is what
    // catches that.
    const siblingBefore = captureRefs(container, CHAT_SIBLING.instanceId);

    // The parent group of p2 (root-g) is already horizontal and "right" is
    // also horizontal, so per `insertPaneAtEdge` this is the FLAT branch:
    // the new pane splices into root-g as a third sibling; the identity of
    // root-g and the rest of the tree (in particular p1, tracked) stay
    // untouched. Verified by the tree-shape assertions below; this row
    // currently has zero existing DOM-level real-action coverage anywhere
    // else in the suite.
    act(() => {
      useEpicCanvasStore.getState().splitPaneWithTab(VIEW_TAB_ID, {
        sourcePaneId: "p2",
        tabId: CHAT_SIBLING.instanceId,
        targetPaneId: "p2",
        position: "right",
      });
    });

    const after = currentCanvas();
    if (after.root === null || after.root.kind !== "group") {
      throw new Error("expected the root group to survive flat");
    }
    expect(after.root.id).toBe("root-g");
    expect(after.root.children).toHaveLength(3);
    expect(
      after.root.children.some(
        (child) => child.kind === "pane" && child.id === "p1",
      ),
    ).toBe(true);

    // The MOVED chat: content continuity through the flat insertion.
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_SIBLING.instanceId, siblingBefore);

    // The untouched bystander, in the pane the split never touched.
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, trackedBefore);
  });

  it("row 6 + row 7 - perpendicular wrap then sibling-close dissolve/promotion: tracked chat and an unrelated real sibling both survive", async () => {
    seedCanvas(
      group("root-g", "horizontal", [
        pane("p1", [CHAT_TRACKED.instanceId]),
        pane("p2", [CHAT_SIBLING.instanceId]),
      ]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);
    const trackedBefore = captureRefs(container, CHAT_TRACKED.instanceId);
    const siblingBefore = captureRefs(container, CHAT_SIBLING.instanceId);

    // --- Row 6: perpendicular wrap around p1 (the wrap partner rides
    // along and is never asserted on directly). ---
    act(() => {
      useEpicCanvasStore
        .getState()
        .openTileInBackgroundTab(VIEW_TAB_ID, CHAT_WRAP_PARTNER);
    });
    act(() => {
      useEpicCanvasStore.getState().splitPaneWithTab(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_WRAP_PARTNER.instanceId,
        targetPaneId: "p1",
        position: "bottom",
      });
    });

    const afterWrap = currentCanvas();
    if (afterWrap.root === null) throw new Error("expected canvas root");
    const wrapPath = findPanePath(afterWrap.root, "p1");
    if (wrapPath === null || wrapPath.length === 0) {
      throw new Error("expected p1 to be nested under a fresh wrap group");
    }
    const wrapParent = getNodeAtPath(afterWrap.root, wrapPath.slice(0, -1));
    if (wrapParent.kind !== "group") throw new Error("expected a group");
    expect(wrapParent.id).not.toBe("root-g");
    expect(wrapParent.direction).toBe("vertical");
    expect(wrapParent.children).toHaveLength(2);

    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, trackedBefore);
    expectRefsStable(container, CHAT_SIBLING.instanceId, siblingBefore);

    // --- Row 7: close the wrap partner pane, dissolving the wrap group
    // and promoting p1 back into the slot under root-g. ---
    const wrapPartnerPane = collectPanes(afterWrap.root).find((candidate) =>
      candidate.tabInstanceIds.includes(CHAT_WRAP_PARTNER.instanceId),
    );
    if (wrapPartnerPane === undefined) {
      throw new Error("expected a pane for the wrap partner");
    }
    act(() => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(
          VIEW_TAB_ID,
          wrapPartnerPane.id,
          CHAT_WRAP_PARTNER.instanceId,
        );
    });

    const afterDissolve = currentCanvas();
    if (afterDissolve.root === null || afterDissolve.root.kind !== "group") {
      throw new Error("expected the outer group to survive the dissolve");
    }
    expect(afterDissolve.root.id).toBe("root-g");
    expect(
      afterDissolve.root.children.some(
        (child) => child.kind === "pane" && child.id === "p1",
      ),
    ).toBe(true);

    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, trackedBefore);
    expectRefsStable(container, CHAT_SIBLING.instanceId, siblingBefore);
  });

  it("row 8 - divider-drag store commit (resizeSplitInTab): zero effect on either pane chat content identity", async () => {
    seedCanvas(
      group("root-g", "horizontal", [
        pane("p1", [CHAT_TRACKED.instanceId]),
        pane("p2", [CHAT_SIBLING.instanceId]),
      ]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);
    const trackedBefore = captureRefs(container, CHAT_TRACKED.instanceId);
    const siblingBefore = captureRefs(container, CHAT_SIBLING.instanceId);

    // This is literally the `onResizeGroup` callback body of `TileCanvas`,
    // a divider-drag commit, called directly on the store the same way
    // production calls it. Zero existing coverage of this action through
    // the real store prior to this row.
    act(() => {
      useEpicCanvasStore
        .getState()
        .resizeSplitInTab(VIEW_TAB_ID, "root-g", [0.3, 0.7]);
    });

    expect(currentCanvas().sizesByGroupId["root-g"]).toEqual([0.3, 0.7]);
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, trackedBefore);
    expectRefsStable(container, CHAT_SIBLING.instanceId, siblingBefore);
  });

  it("row 8b - divider-drag REAL pointer sequence (switch ON): the drag actually commits through usePointerDragCommit, not just the store action", async () => {
    seedCanvas(
      group("root-g", "horizontal", [
        pane("p1", [CHAT_TRACKED.instanceId]),
        pane("p2", [CHAT_SIBLING.instanceId]),
      ]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);
    const trackedBefore = captureRefs(container, CHAT_TRACKED.instanceId);
    const siblingBefore = captureRefs(container, CHAT_SIBLING.instanceId);

    const split = container.querySelector('[data-testid="tile-split"]');
    if (split === null) throw new Error("expected the root split container");
    vi.spyOn(split, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1000, 600),
    );
    const handle = container.querySelector(
      '[data-testid="split-resize-handle"]',
    );
    if (handle === null) throw new Error("expected the split resize handle");

    // Row 1's live-pass fix: move/up are delivered via window listeners once
    // a drag starts, so they no longer need to target the handle itself.
    // Dispatching them on a stand-in element proves the REAL production
    // wiring (not just the isolated hook) tolerates that.
    const decoy = document.createElement("div");
    document.body.appendChild(decoy);
    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 7,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      decoy,
      pointerEvent("pointermove", {
        pointerId: 7,
        clientX: 300,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      decoy,
      pointerEvent("pointerup", {
        pointerId: 7,
        clientX: 300,
        clientY: 10,
        button: 0,
      }),
    );
    document.body.removeChild(decoy);

    expect(currentCanvas().sizesByGroupId["root-g"]).toEqual([0.3, 0.7]);
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expect(mountCount(CHAT_SIBLING.instanceId)).toBe(1);
    expect(unmountCount(CHAT_SIBLING.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, trackedBefore);
    expectRefsStable(container, CHAT_SIBLING.instanceId, siblingBefore);
  });

  it("row 9 - header tear-off: the real two-commit coordinator transaction never remounts the tracked chat", async () => {
    seedCanvas(pane("p1", [CHAT_TRACKED.instanceId]), [CHAT_TRACKED], "p1");
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    const before = captureRefs(container, CHAT_TRACKED.instanceId);

    act(() => {
      tabCommandCoordinator.createSourceRefAtStripIndex(0, () => {
        const newTabId = useEpicCanvasStore
          .getState()
          .tearOffTabIntoNewHeaderTab({
            sourceTabId: VIEW_TAB_ID,
            sourcePaneId: "p1",
            sourceTileTabId: CHAT_TRACKED.instanceId,
            insertIndex: 0,
          });
        return newTabId === null ? null : { kind: "epic", id: newTabId };
      });
    });

    // The tile moved to a BRAND NEW top-level view tab (a completely
    // different `EpicCanvasStore` root than the one `<TileCanvas>` above is
    // bound to). The hosted body survives this only because its content
    // lives in the plane owned by `StableTileSurfaceHost`, decoupled from
    // which `TileCanvas` is currently showing it.
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expectRefsStable(container, CHAT_TRACKED.instanceId, before);
  });

  it("row 10 - close: the real closeCanvasTab action fully unmounts the closed instance and removes its hosted DOM record", async () => {
    seedCanvas(pane("p1", [CHAT_TRACKED.instanceId]), [CHAT_TRACKED], "p1");
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);

    act(() => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(VIEW_TAB_ID, "p1", CHAT_TRACKED.instanceId);
    });

    await waitFor(() => {
      expect(queryHostedRecord(container, CHAT_TRACKED.instanceId)).toBeNull();
    });
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(container.querySelector('[data-testid="chat-tile"]')).toBeNull();
  });

  it("row 11 - NEGATIVE CONTROL (decision #17): switching the active inner tab away then back is the ONE intentional remount", async () => {
    seedCanvas(
      pane("p1", [CHAT_TRACKED.instanceId, CHAT_SIBLING.instanceId]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);

    act(() => {
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(VIEW_TAB_ID, "p1", CHAT_SIBLING.instanceId);
    });
    await waitFor(() => {
      expect(queryHostedRecord(container, CHAT_TRACKED.instanceId)).toBeNull();
    });
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(1);

    act(() => {
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(VIEW_TAB_ID, "p1", CHAT_TRACKED.instanceId);
    });
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    // Exactly one fresh mount, one prior unmount: proves the mount-count
    // assertions in this matrix are meaningful (they would correctly flag a
    // real remount) rather than vacuously always passing.
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(2);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(1);
  });

  it("row 12 - StrictMode replay: a representative move/split/resize subset settles to no net-new remount beyond the one-time double-invoke performed by StrictMode itself", async () => {
    seedCanvas(
      group("root-g", "horizontal", [
        pane("p1", [CHAT_TRACKED.instanceId]),
        pane("p2", [CHAT_SIBLING.instanceId]),
      ]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix({ strictMode: true });
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    // StrictMode (dev-only) double-invokes the passive effects of the
    // initial mount (mount -> cleanup -> mount), so this counting wrapper
    // does not necessarily start its baseline at 1/0 after initial settle;
    // see the StrictMode test in `stable-tile-surface-host.test.tsx` for
    // the same codebase precedent of not asserting a literal
    // post-StrictMode count. The real invariant under test is that the
    // STRUCTURAL OPERATIONS below add no ADDITIONAL mount/unmount beyond
    // whatever the one-time double-invoke performed by StrictMode itself
    // already produced, captured here as a baseline and then reasserted
    // unchanged after each op.
    const mountBaseline = mountCount(CHAT_TRACKED.instanceId);
    const unmountBaseline = unmountCount(CHAT_TRACKED.instanceId);
    const before = captureRefs(container, CHAT_TRACKED.instanceId);

    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p2",
        targetIndex: 1,
      });
    });
    act(() => {
      useEpicCanvasStore.getState().splitPaneWithTab(VIEW_TAB_ID, {
        sourcePaneId: "p2",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p2",
        position: "right",
      });
    });
    const afterSplit = currentCanvas();
    const trackedPane = collectPanes(afterSplit.root).find((candidate) =>
      candidate.tabInstanceIds.includes(CHAT_TRACKED.instanceId),
    );
    if (trackedPane === undefined) throw new Error("expected tracked pane");
    const rootGroupId =
      afterSplit.root?.kind === "group" ? afterSplit.root.id : null;
    if (rootGroupId === null) throw new Error("expected a root group");
    act(() => {
      useEpicCanvasStore
        .getState()
        .resizeSplitInTab(VIEW_TAB_ID, rootGroupId, [0.4, 0.3, 0.3]);
    });

    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(mountBaseline);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(unmountBaseline);
    expectRefsStable(container, CHAT_TRACKED.instanceId, before);
  });

  it("row 13 - remote-delete ownership handoff: real artifact deletion unmounts the hosted body; recovery republishes a fresh one", async () => {
    seedCanvas(pane("p1", [CHAT_TRACKED.instanceId]), [CHAT_TRACKED], "p1");
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);

    act(() => {
      deleteChatFromLiveDoc(CHAT_TRACKED.id);
    });

    await waitFor(() => {
      expect(queryHostedRecord(container, CHAT_TRACKED.instanceId)).toBeNull();
      expect(
        container.querySelector('[data-testid="deleted-node-body"]'),
      ).not.toBeNull();
    });
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(1);

    act(() => {
      restoreChatToLiveDoc(CHAT_TRACKED);
    });

    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    expect(
      container.querySelector('[data-testid="deleted-node-body"]'),
    ).toBeNull();
    // Recovery is a genuine fresh mount, not a no-op: the point of this row
    // is that a real remount happens here, unlike every survives row above.
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(2);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(1);
  });
});
