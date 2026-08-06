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
  within,
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
  enableLegendListBrowserScrollEvents,
  installLegendListViewportMetrics,
  setLegendListScrollContainerScrollHeightOverride,
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
import {
  getTileSurfaceEnvironment,
  publishTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
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
import {
  evictChatTabState,
  peekSavedChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import { chatTabPersistenceTabKey } from "@/stores/chats/chat-tab-persistence-key";
import { evictChatTabPersistenceForEpic } from "@/stores/chats/chat-tab-persistence-eviction";
import { resetPendingHydrationRestoreForTesting } from "@/stores/chats/chat-tab-pending-hydration-restore";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

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

const LEGEND_LIST_HEADER_PX = 40;
const LEGEND_LIST_ROW_HEIGHT_PX = 90;

function buildUserSnapshotMessage(
  chat: EpicCanvasTileRef,
  index: number,
): Message {
  return {
    role: "user",
    messageId: `${chat.id}-message-${index}`,
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `${chat.name} seed message ${index}`,
              },
            ],
          },
        ],
      },
    },
    timestamp: index + 1,
    sessionAnchor: null,
  };
}

function buildAssistantSnapshotMessage(
  chat: EpicCanvasTileRef,
  index: number,
): Message {
  return {
    role: "assistant",
    messageId: `${chat.id}-message-${index}`,
    startedAt: index + 1,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude",
      displayName: "Claude",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "text",
        blockId: `${chat.id}-block-${index}`,
        text: `${chat.name} assistant reply ${index}`,
        status: "completed",
        timestamp: index + 1,
        providerNotice: null,
      },
    ],
    timestamp: index + 1,
    turnId: `${chat.id}-turn-${index}`,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function buildLongTranscriptMessages(
  chat: EpicCanvasTileRef,
  count: number,
): Message[] {
  return Array.from({ length: count }, (_unused, index) =>
    index % 2 === 0
      ? buildUserSnapshotMessage(chat, index)
      : buildAssistantSnapshotMessage(chat, index),
  );
}

function emitChatSnapshot(
  chat: EpicCanvasTileRef,
  callbacks: ChatStreamCallbacks,
  messages: ReadonlyArray<Message> | undefined,
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
        messages: [...(messages ?? [buildUserSnapshotMessage(chat, 1)])],
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

interface ChatStreamFactoryHandle {
  /**
   * Re-emit a chat.subscribe snapshot with a new messages array. Updates the
   * seed used on later remounts as well, so growth while a same-pane tab is
   * unmounted still appears when that tab is selected again.
   */
  readonly pushMessages: (
    chatId: string,
    messages: ReadonlyArray<Message>,
  ) => void;
}

function installChatStreamFactory(
  messagesByChatId: ReadonlyMap<string, ReadonlyArray<Message>> | undefined,
): ChatStreamFactoryHandle {
  const messagesStore = new Map<string, ReadonlyArray<Message>>(
    messagesByChatId ?? [],
  );
  const callbacksByChatId = new Map<string, ChatStreamCallbacks>();

  __setChatStreamClientFactoryForTests((_epicId, chatId, callbacks) => {
    callbacksByChatId.set(chatId, callbacks);
    setTimeout(() => {
      callbacks.onConnectionStatus("open", null);
      const chat = ALL_CHATS.find((candidate) => candidate.id === chatId);
      if (chat !== undefined) {
        emitChatSnapshot(chat, callbacks, messagesStore.get(chat.id));
      }
    }, 0);
    const client: Pick<
      ChatStreamClient,
      "sendAction" | "close" | "sameTurnSteeringProtocolSupported"
    > = {
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      close: () => {
        if (callbacksByChatId.get(chatId) === callbacks) {
          callbacksByChatId.delete(chatId);
        }
      },
    };
    return client;
  });

  return {
    pushMessages: (chatId, messages) => {
      messagesStore.set(chatId, messages);
      const callbacks = callbacksByChatId.get(chatId);
      const chat = ALL_CHATS.find((candidate) => candidate.id === chatId);
      if (callbacks === undefined || chat === undefined) return;
      act(() => {
        emitChatSnapshot(chat, callbacks, messages);
      });
    },
  };
}

function createChatHarness(): { install(): void; teardown(): void } {
  return {
    install: () => {
      installChatStreamFactory(undefined);
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
  // Visibility-boundary / bottom-follow rows seed free-scrolling or
  // following-end coordinates into BOTH halves of the dual-key cache for
  // this epic's chat tiles. Clear durable (epic) AND tab-key (instance)
  // entries so later rows never inherit a leftover restore.
  evictChatTabPersistenceForEpic(EPIC_ID);
  evictChatTabState(
    ALL_CHATS.map((chat) =>
      chatTabPersistenceTabKey({ tileInstanceId: chat.instanceId }),
    ),
  );
  // Review P2: the pending-hydration registry is module-scope and private to
  // chat-messages.tsx, so it survives an ordinary cache eviction. Rows 16
  // onward reuse the fixed CHAT_TRACKED/CHAT_SIBLING instance ids - without
  // this, a missing-anchor mount in one row can leave a pending entry a
  // later row's mount still reads, even though its own visible cache was
  // cleared above.
  resetPendingHydrationRestoreForTesting();
  setLegendListScrollContainerScrollHeightOverride(null);
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
// Scroll / same-pane switch helpers (internal-tab-bottom-follow coverage)
// ---------------------------------------------------------------------------

const PILL_SHOW_DEBOUNCE_MS = 150;

function maxScrollTopFor(scrollNode: HTMLElement): number {
  return Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight);
}

function transcriptScrollHeightPx(messageCount: number): number {
  return LEGEND_LIST_HEADER_PX + messageCount * LEGEND_LIST_ROW_HEIGHT_PX + 40;
}

function isScrollToEndPillVisible(
  container: HTMLElement,
  instanceId: string,
): boolean {
  const record = queryHostedRecord(container, instanceId);
  if (record === null) return false;
  const pill = within(record).queryByRole<HTMLButtonElement>("button", {
    name: "Scroll to end",
  });
  if (pill === null) return false;
  return (
    pill.classList.contains("opacity-100") &&
    !pill.classList.contains("opacity-0")
  );
}

async function waitForPillVisible(
  container: HTMLElement,
  instanceId: string,
): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 40);
    });
  });
  await waitFor(() => {
    expect(isScrollToEndPillVisible(container, instanceId)).toBe(true);
  });
}

/**
 * Real gesture to strict bottom: leave the end first (so this is not just the
 * fresh-mount bootstrap default), then land at max scrollTop.
 */
async function gestureToTrueBottom(scrollNode: HTMLElement): Promise<void> {
  act(() => {
    scrollNode.scrollTop = 1000;
  });
  await settleLegendList();
  expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
  act(() => {
    scrollNode.scrollTop = maxScrollTopFor(scrollNode);
  });
  await settleLegendList();
  expect(scrollNode.dataset.scrollMode).toBe("following-end");
}

/**
 * Seed the mount-time clamped free-scrolling restore race (row 16): a saved
 * free-scrolling anchor that is missing from `messages` arms convergence
 * that used to trap `restorePersistencePendingRef` when the reader reached
 * true bottom mid-flight. Call BEFORE first mount of that instance.
 */
function seedMissingFreeScrollingAnchor(
  chat: EpicCanvasTileRef,
  anchorIndex: number,
): void {
  saveChatTabState({
    identity: {
      tileInstanceId: chat.instanceId,
      epicId: EPIC_ID,
      chatId: chat.id,
      hostId: chat.hostId,
    },
    mode: "free-scrolling",
    anchorMessageId: "totally-missing-id",
    anchorIndex,
    offset: 12,
  });
}

/**
 * Race the mount-time free-restore: keep forcing true bottom across frames
 * until mode flips to following-end, then settle. Pair with
 * `seedMissingFreeScrollingAnchor` + a mount that has NOT yet settled.
 */
async function raceTrueBottomPastInFlightFreeRestore(
  scrollNode: HTMLElement,
): Promise<void> {
  for (let frame = 0; frame < 8; frame += 1) {
    act(() => {
      scrollNode.scrollTop = maxScrollTopFor(scrollNode);
    });
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    if (scrollNode.dataset.scrollMode === "following-end") break;
  }
  await settleLegendList();
  expect(scrollNode.dataset.scrollMode).toBe("following-end");
}

async function switchSamePaneTab(
  container: HTMLElement,
  toInstanceId: string,
  options: { readonly settle: boolean } | undefined,
): Promise<void> {
  act(() => {
    useEpicCanvasStore
      .getState()
      .setActiveTileTab(VIEW_TAB_ID, "p1", toInstanceId);
  });
  if (options?.settle === false) {
    await waitFor(() => {
      expect(queryHostedRecord(container, toInstanceId)).not.toBeNull();
    });
    return;
  }
  await waitForHostedChatLoaded(container, toInstanceId);
}

function appendLongTranscriptTail(
  chat: EpicCanvasTileRef,
  existing: ReadonlyArray<Message>,
  extraCount: number,
): Message[] {
  const start = existing.length;
  const extras = Array.from({ length: extraCount }, (_unused, offset) => {
    const index = start + offset;
    return index % 2 === 0
      ? buildUserSnapshotMessage(chat, index)
      : buildAssistantSnapshotMessage(chat, index);
  });
  return [...existing, ...extras];
}

function seedSamePaneLongPair(
  trackedMessages: ReadonlyArray<Message>,
  siblingMessages: ReadonlyArray<Message>,
): ChatStreamFactoryHandle {
  setLegendListScrollContainerScrollHeightOverride(
    Math.max(
      transcriptScrollHeightPx(trackedMessages.length),
      transcriptScrollHeightPx(siblingMessages.length),
    ),
  );
  enableLegendListBrowserScrollEvents();
  const stream = installChatStreamFactory(
    new Map([
      [CHAT_TRACKED.id, trackedMessages],
      [CHAT_SIBLING.id, siblingMessages],
    ]),
  );
  seedCanvas(
    pane("p1", [CHAT_TRACKED.instanceId, CHAT_SIBLING.instanceId]),
    [CHAT_TRACKED, CHAT_SIBLING],
    "p1",
  );
  return stream;
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

  it("row 14 - production visibility boundary: topLevelVisible handoff through real hosted chain restores free-reading position", async () => {
    // Fixup requirement 3 / review P2: every existing visibility-handoff
    // case in `chat-messages.test.tsx` drives `ChatMessages.visible` via a
    // direct prop re-render, so a broken
    // `environment.presentation.topLevelVisible` bridge would still pass.
    // This row is the only gate that flips visibility through the REAL
    // production chain:
    //   publishTileSurfaceEnvironment(presentation.topLevelVisible)
    //   -> StableTileSurfaceHost record (subscribes via environment registry)
    //   -> HostedChatSurfaceContextBridge (re-provides PaneVisibilityContext)
    //   -> ChatTile (usePaneVisible() && useTabBodySelected() -> surfaceVisible)
    //   -> ChatMessages visible prop
    //
    // jsdom cannot reproduce the real geometry-coordinator 0x0 loss:
    // `installLegendListViewportMetrics` reads every dimension from element
    // ROLE (not CSS/inline style), and the global ResizeObserver mock never
    // fires. Keep the same terminal-symptom injection the unit handoff tests
    // use (`scrollTop = 0` on the scroll node) for the browser-zeroing
    // symptom; the NEW coverage here is that the production
    // `topLevelVisible` publish is what drives `visible` false/true.
    const messageCount = 80;
    const anchorIndex = 20;
    const savedViewOffset = 24;
    const longMessages = buildLongTranscriptMessages(
      CHAT_TRACKED,
      messageCount,
    );
    const anchorMessageId = longMessages[anchorIndex]?.messageId ?? null;
    expect(anchorMessageId).toBeTruthy();

    installChatStreamFactory(new Map([[CHAT_TRACKED.id, longMessages]]));
    setLegendListScrollContainerScrollHeightOverride(
      LEGEND_LIST_HEADER_PX + messageCount * LEGEND_LIST_ROW_HEIGHT_PX + 40,
    );
    saveChatTabState({
      identity: {
        tileInstanceId: CHAT_TRACKED.instanceId,
        epicId: EPIC_ID,
        chatId: CHAT_TRACKED.id,
        hostId: CHAT_TRACKED.hostId,
      },
      mode: "free-scrolling",
      anchorMessageId,
      anchorIndex,
      offset: savedViewOffset,
    });

    seedCanvas(pane("p1", [CHAT_TRACKED.instanceId]), [CHAT_TRACKED], "p1");
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    // Second settle covers restore-promise + double-rAF quiet window so the
    // free-scroll landing has fully validated (and the last-visible mirror
    // is populated) before we hide.
    await settleLegendList();

    const scrollNode = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    const beforeHide = scrollNode.scrollTop;
    expect(beforeHide).toBeGreaterThan(0);

    const readyEnvironment = getTileSurfaceEnvironment(CHAT_TRACKED.instanceId);
    if (readyEnvironment === null) {
      throw new Error(
        "expected a published ReadyTileSurfaceEnvironment for the tracked chat",
      );
    }
    expect(readyEnvironment.presentation.topLevelVisible).toBe(true);

    // Terminal symptom only: real browser zeroes scrollTop when the hosted
    // record becomes 0x0; jsdom cannot drive that via the geometry
    // coordinator (see block comment above).
    act(() => {
      scrollNode.scrollTop = 0;
    });
    act(() => {
      publishTileSurfaceEnvironment({
        ...readyEnvironment,
        presentation: {
          topLevelVisible: false,
          topLevelFocused: false,
        },
      });
    });
    await settleLegendList();
    expect(messagesScroll(container, CHAT_TRACKED.instanceId).scrollTop).toBe(
      0,
    );
    expect(
      getTileSurfaceEnvironment(CHAT_TRACKED.instanceId)?.presentation
        .topLevelVisible,
    ).toBe(false);

    act(() => {
      publishTileSurfaceEnvironment({
        ...readyEnvironment,
        presentation: {
          topLevelVisible: true,
          topLevelFocused: readyEnvironment.presentation.topLevelFocused,
        },
      });
    });
    await settleLegendList();

    const restored = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(restored.scrollTop).toBe(beforeHide);
    expect(restored.dataset.scrollMode).toBe("free-scrolling");
    expect(
      getTileSurfaceEnvironment(CHAT_TRACKED.instanceId)?.presentation
        .topLevelVisible,
    ).toBe(true);
    // Content identity must survive the visibility cycle (keep-alive, not
    // remount-and-restore).
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
  });

  it("row 15 - internal-tab-bottom-follow: same-pane switch preserves strict bottom-follow", async () => {
    const longMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    installChatStreamFactory(new Map([[CHAT_TRACKED.id, longMessages]]));
    setLegendListScrollContainerScrollHeightOverride(
      LEGEND_LIST_HEADER_PX +
        longMessages.length * LEGEND_LIST_ROW_HEIGHT_PX +
        40,
    );
    enableLegendListBrowserScrollEvents();
    seedCanvas(
      pane("p1", [CHAT_TRACKED.instanceId, CHAT_SIBLING.instanceId]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    // Real gesture: leave the bottom, then scroll back down to the true max -
    // not just the untouched fresh-mount bootstrap default.
    act(() => {
      trackedScroll.scrollTop = 1000;
    });
    await settleLegendList();
    expect(trackedScroll.dataset.scrollMode).toBe("free-scrolling");
    act(() => {
      trackedScroll.scrollTop =
        trackedScroll.scrollHeight - trackedScroll.clientHeight;
    });
    await settleLegendList();
    expect(trackedScroll.dataset.scrollMode).toBe("following-end");
    const bottomTop = trackedScroll.scrollTop;
    expect(bottomTop).toBeGreaterThan(0);

    act(() => {
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(VIEW_TAB_ID, "p1", CHAT_SIBLING.instanceId);
    });
    await waitFor(() => {
      expect(queryHostedRecord(container, CHAT_TRACKED.instanceId)).toBeNull();
    });
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);

    act(() => {
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(VIEW_TAB_ID, "p1", CHAT_TRACKED.instanceId);
    });
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    const restoredScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(restoredScroll.dataset.scrollMode).toBe("following-end");
    expect(restoredScroll.scrollTop).toBe(bottomTop);
  });

  it("row 16 - internal-tab-bottom-follow: reaching true bottom past an in-flight clamped free-scrolling restore releases persistence", async () => {
    // Regression for the live-Electron identity-pinned P1: a saved
    // free-scrolling anchor that is missing from `messages` at mount
    // (branch edit / suffix removal) arms a mount-time clamped restore
    // convergence AND `pendingHydrationRestoreAnchorIdRef`. If the reader
    // reaches strict bottom (a real, demonstrably-past-the-clamped-target
    // scroll) WHILE that convergence is still in flight, its own
    // `isAborted` fires - and `settleChatTimelineNavigation`'s abort path
    // calls neither `onSettledValid` nor `onSettledInvalid`, so nothing
    // else ever released `restorePersistencePendingRef` for this mount.
    // Every later persist (scroll mirror, unmount save) then silently
    // no-ops, leaving the STALE free-scrolling entry in the tab-key cache
    // across the next same-pane remount - reproducing the live evidence's
    // stable, repeatable detached landing (identical scrollTop every
    // cycle, since the cache is never touched again).
    const longMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    installChatStreamFactory(new Map([[CHAT_TRACKED.id, longMessages]]));
    setLegendListScrollContainerScrollHeightOverride(
      LEGEND_LIST_HEADER_PX +
        longMessages.length * LEGEND_LIST_ROW_HEIGHT_PX +
        40,
    );
    enableLegendListBrowserScrollEvents();
    saveChatTabState({
      identity: {
        tileInstanceId: CHAT_TRACKED.instanceId,
        epicId: EPIC_ID,
        chatId: CHAT_TRACKED.id,
        hostId: CHAT_TRACKED.hostId,
      },
      mode: "free-scrolling",
      anchorMessageId: "totally-missing-id",
      anchorIndex: 40,
      offset: 12,
    });
    seedCanvas(
      pane("p1", [CHAT_TRACKED.instanceId, CHAT_SIBLING.instanceId]),
      [CHAT_TRACKED, CHAT_SIBLING],
      "p1",
    );
    const { container } = renderMatrix(undefined);
    // Deliberately NOT waitForHostedChatLoaded/settleLegendList here: the
    // mount-time clamped free-scrolling restore convergence must still be
    // IN FLIGHT when the reader reaches true bottom, to reproduce the abort
    // race (isAborted fires once mode flips away from "free-scrolling").
    await waitFor(() => {
      const record = queryHostedRecord(container, CHAT_TRACKED.instanceId);
      expect(record).not.toBeNull();
      expect(record?.querySelector("[data-message-id]")).not.toBeNull();
    });
    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    // The mount-time clamped free-scrolling restore's own bounded
    // validate/retry loop is racing to land at row 40. Keep re-asserting the
    // true-bottom scrollTop across several frames so a real scroll to bottom
    // wins at least one settle-check before that loop's own reissue would
    // otherwise keep winning.
    for (let frame = 0; frame < 8; frame += 1) {
      act(() => {
        trackedScroll.scrollTop =
          trackedScroll.scrollHeight - trackedScroll.clientHeight;
      });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      if (trackedScroll.dataset.scrollMode === "following-end") break;
    }
    await settleLegendList();
    expect(trackedScroll.dataset.scrollMode).toBe("following-end");

    act(() => {
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(VIEW_TAB_ID, "p1", CHAT_SIBLING.instanceId);
    });
    await waitFor(() => {
      expect(queryHostedRecord(container, CHAT_TRACKED.instanceId)).toBeNull();
    });
    await waitForHostedChatLoaded(container, CHAT_SIBLING.instanceId);

    act(() => {
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(VIEW_TAB_ID, "p1", CHAT_TRACKED.instanceId);
    });
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    const restoredScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(restoredScroll.dataset.scrollMode).toBe("following-end");
  });

  it("row 17 - internal-tab-bottom-follow: A bottom survives 3+ A↔B round trips without drift", async () => {
    // Lock the race across repeated cache round-trips: seed the missing
    // free-scrolling anchor, race true bottom past the in-flight restore,
    // then thrash A↔B. Without the isDemonstrablyPastTarget gate release,
    // every cycle reloads the stale free entry (live A_bottom evidence).
    const trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 80);
    seedMissingFreeScrollingAnchor(CHAT_TRACKED, 40);
    seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitFor(() => {
      const record = queryHostedRecord(container, CHAT_TRACKED.instanceId);
      expect(record).not.toBeNull();
      expect(record?.querySelector("[data-message-id]")).not.toBeNull();
    });
    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    await raceTrueBottomPastInFlightFreeRestore(trackedScroll);
    const baselineTop = trackedScroll.scrollTop;
    expect(baselineTop).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);
      const restored = messagesScroll(container, CHAT_TRACKED.instanceId);
      expect(restored.dataset.scrollMode).toBe("following-end");
      expect(restored.scrollTop).toBe(baselineTop);
    }
  });

  it("row 18 - internal-tab-bottom-follow: B bottom survives 3+ B↔A round trips (not A-specific)", async () => {
    const trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 80);
    seedMissingFreeScrollingAnchor(CHAT_SIBLING, 40);
    seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    // Select B without a full settle so the missing-anchor free restore is
    // still converging when we race true bottom.
    act(() => {
      useEpicCanvasStore
        .getState()
        .setActiveTileTab(VIEW_TAB_ID, "p1", CHAT_SIBLING.instanceId);
    });
    await waitFor(() => {
      const record = queryHostedRecord(container, CHAT_SIBLING.instanceId);
      expect(record).not.toBeNull();
      expect(record?.querySelector("[data-message-id]")).not.toBeNull();
    });
    const siblingScroll = messagesScroll(container, CHAT_SIBLING.instanceId);
    await raceTrueBottomPastInFlightFreeRestore(siblingScroll);
    const baselineTop = siblingScroll.scrollTop;
    expect(baselineTop).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);
      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
      const restored = messagesScroll(container, CHAT_SIBLING.instanceId);
      expect(restored.dataset.scrollMode).toBe("following-end");
      expect(restored.scrollTop).toBe(baselineTop);
    }
  });

  it("row 19 - internal-tab-bottom-follow: independent A free-scrolling + B following-end survive mixed cycles", async () => {
    const trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 80);
    const freeAnchorIndex = 20;
    const freeViewOffset = 24;
    const freeAnchorId = trackedMessages[freeAnchorIndex]?.messageId ?? null;
    expect(freeAnchorId).toBeTruthy();
    const freeMidTop =
      LEGEND_LIST_HEADER_PX +
      freeAnchorIndex * LEGEND_LIST_ROW_HEIGHT_PX -
      freeViewOffset;
    // Deterministic free-reading seed (row 14 style) - avoids gesture
    // flakiness after earlier bottom-follow race rows in the same file.
    saveChatTabState({
      identity: {
        tileInstanceId: CHAT_TRACKED.instanceId,
        epicId: EPIC_ID,
        chatId: CHAT_TRACKED.id,
        hostId: CHAT_TRACKED.hostId,
      },
      mode: "free-scrolling",
      anchorMessageId: freeAnchorId,
      anchorIndex: freeAnchorIndex,
      offset: freeViewOffset,
    });
    seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    // Second settle covers restore-promise + quiet window (row 14 precedent).
    await settleLegendList();

    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(trackedScroll.dataset.scrollMode).toBe("free-scrolling");
    expect(trackedScroll.scrollTop).toBe(freeMidTop);

    await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
    const siblingScroll = messagesScroll(container, CHAT_SIBLING.instanceId);
    await gestureToTrueBottom(siblingScroll);
    const siblingBottomTop = siblingScroll.scrollTop;

    for (let cycle = 0; cycle < 2; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);
      const restoredA = messagesScroll(container, CHAT_TRACKED.instanceId);
      expect(restoredA.dataset.scrollMode).toBe("free-scrolling");
      expect(restoredA.scrollTop).toBe(freeMidTop);

      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
      const restoredB = messagesScroll(container, CHAT_SIBLING.instanceId);
      expect(restoredB.dataset.scrollMode).toBe("following-end");
      expect(restoredB.scrollTop).toBe(siblingBottomTop);
    }
  });

  it("row 20 - internal-tab-bottom-follow: rapid A↔B thrash without full settle keeps following-end", async () => {
    const trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 80);
    seedMissingFreeScrollingAnchor(CHAT_TRACKED, 40);
    seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitFor(() => {
      const record = queryHostedRecord(container, CHAT_TRACKED.instanceId);
      expect(record).not.toBeNull();
      expect(record?.querySelector("[data-message-id]")).not.toBeNull();
    });
    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    await raceTrueBottomPastInFlightFreeRestore(trackedScroll);

    // Mirror the live thrash dimension: switch faster than restore
    // convergence / settleLegendList can finish between hops.
    for (let thrash = 0; thrash < 6; thrash += 1) {
      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_SIBLING.instanceId, {
        settle: false,
      });
      // eslint-disable-next-line no-await-in-loop
      await switchSamePaneTab(container, CHAT_TRACKED.instanceId, {
        settle: false,
      });
    }

    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    const restored = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(restored.dataset.scrollMode).toBe("following-end");
    expect(restored.scrollTop).toBe(maxScrollTopFor(restored));
  });

  it("row 21 - internal-tab-bottom-follow: visible stream growth then same-pane switch keeps following at NEW bottom", async () => {
    let trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 60);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 40);
    seedMissingFreeScrollingAnchor(CHAT_TRACKED, 30);
    const stream = seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitFor(() => {
      const record = queryHostedRecord(container, CHAT_TRACKED.instanceId);
      expect(record).not.toBeNull();
      expect(record?.querySelector("[data-message-id]")).not.toBeNull();
    });

    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    await raceTrueBottomPastInFlightFreeRestore(trackedScroll);
    const beforeGrowthTop = trackedScroll.scrollTop;

    trackedMessages = appendLongTranscriptTail(
      CHAT_TRACKED,
      trackedMessages,
      20,
    );
    setLegendListScrollContainerScrollHeightOverride(
      transcriptScrollHeightPx(trackedMessages.length),
    );
    stream.pushMessages(CHAT_TRACKED.id, trackedMessages);
    await settleLegendList();

    const grownScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(grownScroll.dataset.scrollMode).toBe("following-end");
    expect(grownScroll.scrollTop).toBeGreaterThan(beforeGrowthTop);
    expect(grownScroll.scrollTop).toBe(maxScrollTopFor(grownScroll));
    const postGrowthTop = grownScroll.scrollTop;

    await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
    await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);

    const restored = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(restored.dataset.scrollMode).toBe("following-end");
    expect(restored.scrollTop).toBe(postGrowthTop);
    expect(restored.scrollTop).toBe(maxScrollTopFor(restored));
    expect(isScrollToEndPillVisible(container, CHAT_TRACKED.instanceId)).toBe(
      false,
    );
  });

  it("row 22 - internal-tab-bottom-follow: free-reading mid + tail growth then switch does not reattach to bottom", async () => {
    let trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 40);
    const freeAnchorIndex = 20;
    const freeViewOffset = 24;
    const freeAnchorId = trackedMessages[freeAnchorIndex]?.messageId ?? null;
    expect(freeAnchorId).toBeTruthy();
    const freeMidTop =
      LEGEND_LIST_HEADER_PX +
      freeAnchorIndex * LEGEND_LIST_ROW_HEIGHT_PX -
      freeViewOffset;
    saveChatTabState({
      identity: {
        tileInstanceId: CHAT_TRACKED.instanceId,
        epicId: EPIC_ID,
        chatId: CHAT_TRACKED.id,
        hostId: CHAT_TRACKED.hostId,
      },
      mode: "free-scrolling",
      anchorMessageId: freeAnchorId,
      anchorIndex: freeAnchorIndex,
      offset: freeViewOffset,
    });
    const stream = seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await settleLegendList();

    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(trackedScroll.dataset.scrollMode).toBe("free-scrolling");
    expect(trackedScroll.scrollTop).toBe(freeMidTop);
    await waitForPillVisible(container, CHAT_TRACKED.instanceId);

    trackedMessages = appendLongTranscriptTail(
      CHAT_TRACKED,
      trackedMessages,
      24,
    );
    setLegendListScrollContainerScrollHeightOverride(
      transcriptScrollHeightPx(trackedMessages.length),
    );
    stream.pushMessages(CHAT_TRACKED.id, trackedMessages);
    await settleLegendList();

    const afterGrowth = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(afterGrowth.dataset.scrollMode).toBe("free-scrolling");
    expect(afterGrowth.scrollTop).toBe(freeMidTop);
    expect(afterGrowth.scrollTop).toBeLessThan(
      maxScrollTopFor(afterGrowth) - 1,
    );

    await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
    await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);

    const restored = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(restored.dataset.scrollMode).toBe("free-scrolling");
    expect(restored.scrollTop).toBe(freeMidTop);
    await waitForPillVisible(container, CHAT_TRACKED.instanceId);
  });

  it("row 23 - internal-tab-bottom-follow: growth while switched-away keeps pill coherent with restored mode", async () => {
    let trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 40);
    const freeAnchorIndex = 18;
    const freeViewOffset = 12;
    const freeAnchorId = trackedMessages[freeAnchorIndex]?.messageId ?? null;
    expect(freeAnchorId).toBeTruthy();
    const freeMidTop =
      LEGEND_LIST_HEADER_PX +
      freeAnchorIndex * LEGEND_LIST_ROW_HEIGHT_PX -
      freeViewOffset;
    saveChatTabState({
      identity: {
        tileInstanceId: CHAT_TRACKED.instanceId,
        epicId: EPIC_ID,
        chatId: CHAT_TRACKED.id,
        hostId: CHAT_TRACKED.hostId,
      },
      mode: "free-scrolling",
      anchorMessageId: freeAnchorId,
      anchorIndex: freeAnchorIndex,
      offset: freeViewOffset,
    });
    const stream = seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);
    await settleLegendList();

    // Case A: free-scrolling park, growth while unmounted, restore stays free
    // with pill visible.
    expect(
      messagesScroll(container, CHAT_TRACKED.instanceId).dataset.scrollMode,
    ).toBe("free-scrolling");
    expect(messagesScroll(container, CHAT_TRACKED.instanceId).scrollTop).toBe(
      freeMidTop,
    );
    await waitForPillVisible(container, CHAT_TRACKED.instanceId);

    await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
    trackedMessages = appendLongTranscriptTail(
      CHAT_TRACKED,
      trackedMessages,
      16,
    );
    setLegendListScrollContainerScrollHeightOverride(
      Math.max(
        transcriptScrollHeightPx(trackedMessages.length),
        transcriptScrollHeightPx(siblingMessages.length),
      ),
    );
    // Unmounted: pushMessages only updates the seed; remount consumes it.
    stream.pushMessages(CHAT_TRACKED.id, trackedMessages);

    await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);
    const freeRestored = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(freeRestored.dataset.scrollMode).toBe("free-scrolling");
    expect(freeRestored.scrollTop).toBe(freeMidTop);
    await waitForPillVisible(container, CHAT_TRACKED.instanceId);

    // Case B: reach true bottom, growth while away, restore following-end with
    // pill hidden (must track the NEW true bottom, not a stale free entry).
    await gestureToTrueBottom(freeRestored);
    expect(isScrollToEndPillVisible(container, CHAT_TRACKED.instanceId)).toBe(
      false,
    );

    await switchSamePaneTab(container, CHAT_SIBLING.instanceId, undefined);
    trackedMessages = appendLongTranscriptTail(
      CHAT_TRACKED,
      trackedMessages,
      12,
    );
    setLegendListScrollContainerScrollHeightOverride(
      Math.max(
        transcriptScrollHeightPx(trackedMessages.length),
        transcriptScrollHeightPx(siblingMessages.length),
      ),
    );
    stream.pushMessages(CHAT_TRACKED.id, trackedMessages);

    await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);
    const bottomRestored = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(bottomRestored.dataset.scrollMode).toBe("following-end");
    expect(bottomRestored.scrollTop).toBe(maxScrollTopFor(bottomRestored));
    expect(isScrollToEndPillVisible(container, CHAT_TRACKED.instanceId)).toBe(
      false,
    );
  });

  it("row 24 - internal-tab-bottom-follow: same-group reorder (no remount) preserves following-end", async () => {
    // Row 2's precedent: moveTabOnTabStrip within one pane never remounts.
    // Bottom-follow must hold live without a cache round-trip.
    // Do not pin firstMessageRow identity: virtualization recycles which
    // message is the first mounted shell after a true-bottom park.
    const trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 40);
    seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    await gestureToTrueBottom(trackedScroll);
    const chatTileBefore = chatTileRoot(container, CHAT_TRACKED.instanceId);
    const scrollBefore = messagesScroll(container, CHAT_TRACKED.instanceId);
    const bottomTop = trackedScroll.scrollTop;
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);

    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p1",
        targetIndex: 1,
      });
    });
    await settleLegendList();

    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expect(chatTileRoot(container, CHAT_TRACKED.instanceId)).toBe(
      chatTileBefore,
    );
    expect(messagesScroll(container, CHAT_TRACKED.instanceId)).toBe(
      scrollBefore,
    );
    const afterReorder = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(afterReorder.dataset.scrollMode).toBe("following-end");
    expect(afterReorder.scrollTop).toBe(bottomTop);
  });

  it("row 25 - internal-tab-bottom-follow: edge-drop split (stable-host no remount) preserves following-end", async () => {
    // Residual-risk matrix documents paint/edge-drop as remount-class under
    // the pre-stable-host mental model. With STABLE_TILE_SURFACE_HOST_ENABLED
    // this suite's rows 4-7 prove the painted body does NOT remount - so the
    // contract here is live following-end survival (not a cache round-trip).
    // Same-pane remount round-trip is covered by rows 15-20.
    const trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 80);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 40);
    seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitForHostedChatLoaded(container, CHAT_TRACKED.instanceId);

    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    await gestureToTrueBottom(trackedScroll);
    const chatTileBefore = chatTileRoot(container, CHAT_TRACKED.instanceId);
    const scrollBefore = messagesScroll(container, CHAT_TRACKED.instanceId);
    const bottomTop = trackedScroll.scrollTop;

    act(() => {
      useEpicCanvasStore.getState().splitPaneWithTab(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p1",
        position: "right",
      });
    });
    await settleLegendList();

    const after = currentCanvas();
    if (after.root === null || after.root.kind !== "group") {
      throw new Error("expected the split to wrap the bare root pane");
    }
    expect(mountCount(CHAT_TRACKED.instanceId)).toBe(1);
    expect(unmountCount(CHAT_TRACKED.instanceId)).toBe(0);
    expect(chatTileRoot(container, CHAT_TRACKED.instanceId)).toBe(
      chatTileBefore,
    );
    expect(messagesScroll(container, CHAT_TRACKED.instanceId)).toBe(
      scrollBefore,
    );
    const afterSplit = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(afterSplit.dataset.scrollMode).toBe("following-end");
    expect(afterSplit.scrollTop).toBe(bottomTop);
  });

  it("row 26 - internal-tab-bottom-follow: reorder then immediate inner-tab switch under growth", async () => {
    let trackedMessages = buildLongTranscriptMessages(CHAT_TRACKED, 70);
    const siblingMessages = buildLongTranscriptMessages(CHAT_SIBLING, 50);
    seedMissingFreeScrollingAnchor(CHAT_TRACKED, 35);
    const stream = seedSamePaneLongPair(trackedMessages, siblingMessages);
    const { container } = renderMatrix(undefined);
    await waitFor(() => {
      const record = queryHostedRecord(container, CHAT_TRACKED.instanceId);
      expect(record).not.toBeNull();
      expect(record?.querySelector("[data-message-id]")).not.toBeNull();
    });

    const trackedScroll = messagesScroll(container, CHAT_TRACKED.instanceId);
    await raceTrueBottomPastInFlightFreeRestore(trackedScroll);

    // Growth still in flight while we reorder + thrash the active tab.
    trackedMessages = appendLongTranscriptTail(
      CHAT_TRACKED,
      trackedMessages,
      18,
    );
    setLegendListScrollContainerScrollHeightOverride(
      Math.max(
        transcriptScrollHeightPx(trackedMessages.length),
        transcriptScrollHeightPx(siblingMessages.length),
      ),
    );
    stream.pushMessages(CHAT_TRACKED.id, trackedMessages);

    act(() => {
      useEpicCanvasStore.getState().moveTabOnTabStrip(VIEW_TAB_ID, {
        sourcePaneId: "p1",
        tabId: CHAT_TRACKED.instanceId,
        targetPaneId: "p1",
        targetIndex: 1,
      });
    });
    // Immediate same-pane switch without waiting for growth settle.
    await switchSamePaneTab(container, CHAT_SIBLING.instanceId, {
      settle: false,
    });
    await switchSamePaneTab(container, CHAT_TRACKED.instanceId, undefined);

    const restored = messagesScroll(container, CHAT_TRACKED.instanceId);
    expect(restored.dataset.scrollMode).toBe("following-end");
    expect(restored.scrollTop).toBe(maxScrollTopFor(restored));
    expect(
      peekSavedChatTabState({
        tileInstanceId: CHAT_TRACKED.instanceId,
        epicId: EPIC_ID,
        chatId: CHAT_TRACKED.id,
        hostId: CHAT_TRACKED.hostId,
      })?.mode,
    ).toBe("following-end");
  });
});
