import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { useCallback, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backgroundItemSchema,
  chatApprovalStateSchema,
  type BackgroundItem,
  type ChatActiveTurn,
  type ChatApprovalState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import {
  useVoiceView,
  VoiceViewPaletteItems,
  type VoiceViewHandle,
} from "@/hooks/voice/use-voice-view";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { setMobileApp } from "@/lib/mobile-app";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  __getOpenEpicRegistryForTests,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { publishComposerSendState } from "@/lib/chats/composer-send-gates";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import type { VoicePaletteRow } from "@/lib/voice/page-acts";
import { NO_PALETTE_ITEMS, type VoiceView } from "@/lib/voice/view";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection } from "@/stores/epics/open-epic/types";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabsStoreState } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import {
  createUnavailableTileFindAdapter,
  useTileFindStore,
  type TileFindAdapter,
} from "@/stores/tile-find";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/**
 * The view the voice router is shown, composed against the app's real stores:
 * the tabs store, the task canvas, the tile-find store that decides the
 * active tile, a real chat session in the real registry, and the real
 * palette sources. Only the host boundary is faked: the task history, which
 * a host serves.
 */

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({ data: undefined }),
}));

const EPIC_ID = "epic-1";
const HOST_ID = "host-a";

const AGENT: EpicNodeRef = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat",
  name: "Main agent",
  hostId: HOST_ID,
};
const SPEC: EpicNodeRef = {
  id: "spec-1",
  instanceId: "inst-spec-1",
  type: "spec",
  name: "Plan",
  hostId: HOST_ID,
};

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const KEYBINDING_ROUTER: KeybindingRouter = {
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

const initialVoiceSession = useVoiceSessionStore.getInitialState();
const initialTracySurface = useTracySurfaceStore.getInitialState();

function approval(overrides: Partial<ChatApprovalState>): ChatApprovalState {
  return chatApprovalStateSchema.parse({
    approvalId: "ap-1",
    toolName: "bash",
    description: "Run bun install",
    input: null,
    requestedAt: 1,
    kind: "tool",
    planId: null,
    actions: [],
    reason: null,
    reviewing: null,
    ...overrides,
  });
}

function activeTurn(turnId: string): ChatActiveTurn {
  return {
    turnId,
    status: "running",
    harnessId: "claude",
    model: "model-a",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    userMessageId: null,
    startedAt: 1,
    updatedAt: 1,
    sameTurnSteeringSupported: true,
  };
}

function chatProjection(node: EpicNodeRef): ChatProjection {
  return {
    id: node.id,
    title: node.name,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId: "viewer",
    ownedByViewer: true,
    hostId: HOST_ID,
    isTitleEditedByUser: false,
    docResident: false,
    settings: null,
    archivedAt: null,
  };
}

function chatSession() {
  return __getChatSessionRegistryForTests().acquire(
    {
      epicId: EPIC_ID,
      chatId: AGENT.id,
      hostId: HOST_ID,
      scopeKey: "voice-view-test",
    },
    () =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId: AGENT.id,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      }),
  );
}

/** The task's session in the open-epic registry, holding the agent in its projection. */
function openEpicSession(): void {
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handleHostIds.set(handle, HOST_ID);
  handle.store.setState({
    chats: { allIds: [AGENT.id], byId: { [AGENT.id]: chatProjection(AGENT) } },
  });
  __getOpenEpicRegistryForTests().acquireMounted(EPIC_ID, () => handle);
}

function stripOf(
  refs: ReadonlyArray<TabRef>,
  active: TabRef | null,
): Partial<TabsStoreState> {
  return {
    version: 2,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: tabItemId(ref),
      ref,
    })),
    activeItemId: active === null ? null : tabItemId(active),
    stripOrder: [...refs],
    systemTabs: { history: null, settings: null },
  };
}

const SETTINGS_TAB: TabRef = { kind: "settings", id: "settings" };
const HISTORY_TAB: TabRef = { kind: "history", id: "history" };

interface TaskTab {
  readonly ref: TabRef;
  readonly tabId: string;
}

/** A task tab holding the agent's chat tile and a spec, in the canvas store. */
function openTaskTab(): TaskTab {
  const canvas = useEpicCanvasStore.getState();
  const tabId = canvas.openEpicTab(EPIC_ID, "Tracy Bots");
  canvas.openTileInTab(tabId, AGENT);
  canvas.openTileInTab(tabId, SPEC);
  return { ref: { kind: "epic", id: tabId }, tabId };
}

/** Makes the tile the active tile of the focused pane; returns how to give it up. */
function activateTile(task: TaskTab, tile: EpicNodeRef): () => void {
  return useTileFindStore.getState().registerTarget({
    tileInstanceId: tile.instanceId,
    contentId: `${tile.instanceId}-content`,
    viewTabId: task.tabId,
    tileId: `${tile.instanceId}-pane`,
    epicId: EPIC_ID,
    tileKind: tile.type === "chat" ? "chat" : "spec",
    isEligible: true,
    adapter: createUnavailableTileFindAdapter({
      tileInstanceId: tile.instanceId,
      tileKind: tile.type === "chat" ? "chat" : "spec",
      message: null,
    }),
  });
}

function generation(): number {
  return useVoiceSessionStore.getState().viewGeneration;
}

function actionsOf(view: VoiceView): ReadonlyArray<string> {
  return view.rows.map((row) => row.action);
}

/** What the palette's publisher last handed the handle: the key and context its rows were composed for. */
interface Published {
  readonly composedFor: string | null;
  readonly ctx: CommandContext | null;
}

interface Mounted {
  readonly handle: () => VoiceViewHandle;
  readonly published: () => Published;
  readonly router: { readonly history: RouterHistory };
  readonly update: (props: ProbeProps) => void;
}

interface ProbeProps {
  readonly enabled: boolean;
  readonly palette: boolean;
}

function makeRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function mount(initialPath: string, props: ProbeProps): Mounted {
  const router = makeRouter(initialPath);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let captured: VoiceViewHandle | null = null;
  let published: Published = { composedFor: null, ctx: null };
  function Probe(probe: ProbeProps): ReactNode {
    const handle = useVoiceView(probe.enabled);
    useEffect(() => {
      captured = handle;
    }, [handle]);
    const onItems = useCallback<VoiceViewHandle["setPaletteItems"]>(
      (items, composedFor, ctx) => {
        published = { composedFor, ctx };
        handle.setPaletteItems(items, composedFor, ctx);
      },
      [handle],
    );
    return probe.palette ? <VoiceViewPaletteItems onItems={onItems} /> : null;
  }
  function Tree(tree: ProbeProps): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={router}>
          <CommandPaletteRouterContext.Provider value={KEYBINDING_ROUTER}>
            <Probe enabled={tree.enabled} palette={tree.palette} />
          </CommandPaletteRouterContext.Provider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  }
  const rendered = render(<Tree {...props} />);
  return {
    handle: () => {
      if (captured === null) throw new Error("the hook never mounted");
      return captured;
    },
    published: () => published,
    router,
    update: (next) => {
      rendered.rerender(<Tree {...next} />);
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useTabsStore.setState(stripOf([], null));
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useVoiceSessionStore.setState(initialVoiceSession, true);
  useTracySurfaceStore.setState(initialTracySurface, true);
});

afterEach(() => {
  cleanup();
  useTileFindStore.getState().resetForTests();
  __getOpenEpicRegistryForTests().disposeAll();
  disposeAllChatSessions();
  setMobileApp(false);
});

/** A task in front with its agent in the active tile and a running turn. */
function taskWithWorkingAgent(): TaskTab {
  const task = openTaskTab();
  openEpicSession();
  const session = chatSession();
  session.store.setState({
    runStatus: "running",
    turnInProgress: true,
    activeTurn: activeTurn("turn-1"),
  });
  useTabsStore.setState(stripOf([task.ref], task.ref));
  activateTile(task, AGENT);
  return task;
}

describe("the view of a task with a working agent", () => {
  it("offers to tell and stop the agent, and to open the task's tiles", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });

    const view = mounted.handle().current();

    expect(view.page).toEqual({
      kind: "task",
      title: "Tracy Bots",
      tile: "Main agent",
    });
    expect(view.agent).toEqual({
      chatId: "chat-1",
      title: "Main agent",
      state: "working",
      waitingOn: null,
      turnId: "turn-1",
    });
    expect(actionsOf(view)).toEqual(
      expect.arrayContaining([
        "agent.tell:chat-1",
        "agent.stop:chat-1",
        "open:chats:chat-1",
      ]),
    );
    expect(view.rows.find((row) => row.action === "open:chats:chat-1")).toEqual(
      {
        action: "open:chats:chat-1",
        label: "Open tab: Main agent",
        takesWords: false,
        confirm: false,
      },
    );
  });

  it("names the turn on the wire, and none once the chat has none", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });
    expect(mounted.handle().current().agent?.turnId).toBe("turn-1");

    act(() => {
      chatSession().store.setState({ activeTurn: null });
    });
    expect(mounted.handle().current().agent?.turnId).toBeNull();
  });

  it("is bound to the generation the store holds", () => {
    taskWithWorkingAgent();
    useVoiceSessionStore.getState().viewChanged();
    const mounted = mount("/", { enabled: true, palette: true });

    expect(mounted.handle().current().generation).toBe(1);
  });

  it("stops offering to stop the agent once its turn is over", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });

    act(() => {
      chatSession().store.setState({ runStatus: "idle" });
    });

    const view = mounted.handle().current();
    expect(view.agent?.state).toBe("idle");
    expect(actionsOf(view)).toContain("agent.tell:chat-1");
    expect(actionsOf(view)).not.toContain("agent.stop:chat-1");
  });

  it("shows no agent while the active tile is not a chat", () => {
    const task = taskWithWorkingAgent();
    useTileFindStore.getState().resetForTests();
    activateTile(task, SPEC);
    const mounted = mount("/", { enabled: true, palette: true });

    const view = mounted.handle().current();

    expect(view.page).toMatchObject({ kind: "task", tile: "Plan" });
    expect(view.agent).toBeNull();
    expect(actionsOf(view).some((id) => id.startsWith("agent."))).toBe(false);
  });
});

describe("the tell row of an agent whose sandbox rests", () => {
  const retractions: Array<() => void> = [];

  afterEach(() => {
    for (const retract of retractions.splice(0)) retract();
  });

  /** A composer for the agent's chat in the tile `tileInstanceId`, as the composer publishes it. */
  function publishComposer(tileInstanceId: string, restingSandbox: boolean) {
    retractions.push(
      publishComposerSendState(HOST_ID, AGENT.id, tileInstanceId, {
        sendDisabled: false,
        workspaceBlocked: false,
        imagesUnsupported: false,
        attachmentPreparationPending: false,
        restingSandbox,
        submit: () => false,
        modelSlug: () => "model-a",
        runSettings: () => ({
          ultracode: false,
          harnessId: "claude",
          model: "model-a",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        }),
      }),
    );
  }

  function tellRow(view: VoiceView) {
    return view.rows.find((row) => row.action === "agent.tell:chat-1");
  }

  it("asks for a yes when the composer in the active tile says the sandbox rests", () => {
    taskWithWorkingAgent();
    publishComposer(AGENT.instanceId, true);
    const mounted = mount("/", { enabled: true, palette: true });

    expect(tellRow(mounted.handle().current())?.confirm).toBe(true);
  });

  it("asks for nothing when the composer in the active tile says it is awake", () => {
    taskWithWorkingAgent();
    publishComposer(AGENT.instanceId, false);
    const mounted = mount("/", { enabled: true, palette: true });

    expect(tellRow(mounted.handle().current())?.confirm).toBe(false);
  });

  it("asks for nothing on account of a resting composer in another tile showing the same chat", () => {
    taskWithWorkingAgent();
    publishComposer("inst-chat-elsewhere", true);
    const mounted = mount("/", { enabled: true, palette: true });

    expect(tellRow(mounted.handle().current())?.confirm).toBe(false);
  });
});

describe("the approvals on the agent's chat", () => {
  it("offers to approve and decline one, and shows the agent waiting on it", () => {
    taskWithWorkingAgent();
    chatSession().store.setState({ pendingApprovals: [approval({})] });
    const mounted = mount("/", { enabled: true, palette: true });

    const view = mounted.handle().current();

    expect(view.agent).toMatchObject({
      state: "waiting",
      waitingOn: "approval",
    });
    expect(view.approvals).toEqual([
      { id: "ap-1", summary: "Run bun install" },
    ]);
    expect(actionsOf(view)).toEqual(
      expect.arrayContaining([
        "approval.approve:ap-1",
        "approval.decline:ap-1",
      ]),
    );
  });

  it.each([
    {
      name: "one a judge is still deciding",
      overrides: { reviewing: "checking" },
    },
    { name: "a plan", overrides: { kind: "plan" } },
  ] as const)("offers nothing to answer for $name", ({ overrides }) => {
    taskWithWorkingAgent();
    chatSession().store.setState({
      pendingApprovals: [approval(overrides)],
    });
    const mounted = mount("/", { enabled: true, palette: true });

    const view = mounted.handle().current();

    expect(view.approvals).toEqual([]);
    expect(view.agent).toMatchObject({ state: "working", waitingOn: null });
    expect(actionsOf(view).some((id) => id.startsWith("approval."))).toBe(
      false,
    );
  });
});

describe("the view while Settings is in front", () => {
  it("offers the other sections and names the one shown, leaving out the current one's row", () => {
    const task = openTaskTab();
    useTabsStore.setState(stripOf([task.ref, SETTINGS_TAB], SETTINGS_TAB));
    const mounted = mount("/settings/appearance", {
      enabled: true,
      palette: true,
    });

    const view = mounted.handle().current();

    const appearance = SETTINGS_SECTIONS.find(
      (section) => section.id === "appearance",
    );
    expect(view.page).toEqual({
      kind: "settings",
      section: appearance?.label,
    });
    expect(actionsOf(view)).toContain("nav:settings/keybindings");
    expect(actionsOf(view)).not.toContain("nav:settings/appearance");
  });

  it("offers no section rows to a task", () => {
    const task = openTaskTab();
    useTabsStore.setState(stripOf([task.ref], task.ref));
    const mounted = mount("/", { enabled: true, palette: true });

    expect(
      actionsOf(mounted.handle().current()).some((id) =>
        id.startsWith("nav:settings/"),
      ),
    ).toBe(false);
  });
});

describe("the view on Home", () => {
  it("has no agent and no tiles though the canvas still holds an active task behind it", () => {
    const task = taskWithWorkingAgent();
    useTabsStore.setState(stripOf([task.ref], null));
    const mounted = mount("/", { enabled: true, palette: true });

    const view = mounted.handle().current();

    expect(useEpicCanvasStore.getState().tabsById[task.tabId]).toBeDefined();
    expect(view.page).toEqual({ kind: "home" });
    expect(view.agent).toBeNull();
    expect(view.approvals).toEqual([]);
    expect(
      actionsOf(view).filter(
        (id) => id.startsWith("agent.") || id.startsWith("open:"),
      ),
    ).toEqual([]);
  });
});

describe("the view on the Tracy surface", () => {
  it("names the selected channel and the thread the voice is in", () => {
    useTabsStore.setState(
      stripOf([{ kind: "tracy", id: "tracy" }], { kind: "tracy", id: "tracy" }),
    );
    useTracySurfaceStore.setState({ open: true, botId: "bot_tracy" });
    useVoiceSessionStore.getState().setFocus({
      botId: "bot_tracy",
      hostId: HOST_ID,
      threadId: "thr-1",
      anchorMessageId: "msg-1",
      anchorThread: null,
    });
    const mounted = mount("/", { enabled: true, palette: false });

    expect(mounted.handle().current().page).toEqual({
      kind: "tracy",
      botId: "bot_tracy",
      threadId: "thr-1",
    });
  });
});

describe("the desktop-only rows", () => {
  it("offers them on desktop", () => {
    const mounted = mount("/", { enabled: true, palette: true });

    expect(actionsOf(mounted.handle().current())).toContain(
      "action:app.status-bar.toggle",
    );
  });

  it("leaves them out in the mobile app", () => {
    setMobileApp(true);
    const mounted = mount("/", { enabled: true, palette: true });

    const actions = actionsOf(mounted.handle().current());
    expect(actions).toContain("action:app.history.open");
    expect(actions).not.toContain("action:app.status-bar.toggle");
  });
});

describe("the chord actions the voice offers", () => {
  it("leaves out a keyboard gesture the actions source lists, and keeps one that means something said aloud", () => {
    const mounted = mount("/", { enabled: true, palette: true });

    const actions = actionsOf(mounted.handle().current());

    expect(actions).toContain("action:app.history.open");
    expect(actions).not.toContain("action:group.focus.up");
  });
});

describe("the palette rows", () => {
  it("are gone once the palette items unmount, leaving the agent's rows", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });
    expect(actionsOf(mounted.handle().current()).length).toBeGreaterThan(2);

    mounted.update({ enabled: true, palette: false });

    expect(actionsOf(mounted.handle().current())).toEqual([
      "agent.tell:chat-1",
      "agent.stop:chat-1",
    ]);
  });
});

describe("the view's generation", () => {
  it("moves once per change of the focused tab", () => {
    const task = taskWithWorkingAgent();
    mount("/", { enabled: true, palette: false });
    const before = generation();

    act(() => {
      useTabsStore.setState(stripOf([task.ref, HISTORY_TAB], HISTORY_TAB));
    });
    expect(generation()).toBe(before + 1);

    act(() => {
      useTabsStore.setState(stripOf([task.ref, HISTORY_TAB], task.ref));
    });
    expect(generation()).toBe(before + 2);
  });

  it("moves once per change of the active tile's owner, once the tile-find store has settled", async () => {
    const task = taskWithWorkingAgent();
    mount("/", { enabled: true, palette: false });
    const before = generation();

    await act(() => {
      activateTile(task, SPEC);
      return Promise.resolve();
    });

    expect(generation()).toBe(before + 1);
  });

  it("hands a route made in the same tick the moved generation, and moves it once", async () => {
    const task = taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: false });
    const before = generation();
    const seen: Array<{ view: VoiceView; generation: number }> = [];

    await act(() => {
      activateTile(task, SPEC);
      const view = mounted.handle().current();
      seen.push({ view, generation: generation() });
      return Promise.resolve();
    });

    expect(seen.at(0)?.view.page).toMatchObject({ kind: "task", tile: "Plan" });
    expect(seen.at(0)?.view.generation).toBe(before + 1);
    expect(seen.at(0)?.generation).toBe(before + 1);
    // The microtask that follows finds the owner already counted.
    expect(generation()).toBe(before + 1);
  });

  it("moves once per change of the Settings section, and not for a route change while Settings is behind", async () => {
    const task = openTaskTab();
    useTabsStore.setState(stripOf([task.ref, SETTINGS_TAB], task.ref));
    const mounted = mount("/", { enabled: true, palette: false });
    const before = generation();

    await act(() => {
      mounted.router.history.push("/settings/appearance");
      return Promise.resolve();
    });
    expect(generation()).toBe(before);

    act(() => {
      useTabsStore.setState(stripOf([task.ref, SETTINGS_TAB], SETTINGS_TAB));
    });
    expect(generation()).toBe(before + 1);

    await act(() => {
      mounted.router.history.push("/settings/keybindings");
      return Promise.resolve();
    });
    expect(generation()).toBe(before + 2);
  });

  it("does not move for a change in the tabs store that leaves the page as it is", () => {
    const task = taskWithWorkingAgent();
    mount("/", { enabled: true, palette: false });
    const before = generation();

    act(() => {
      useTabsStore.setState(stripOf([task.ref, HISTORY_TAB], task.ref));
    });

    expect(generation()).toBe(before);
  });

  it("does not move for a write to the tile-find store that leaves the owner as it is", async () => {
    taskWithWorkingAgent();
    mount("/", { enabled: true, palette: false });
    const before = generation();

    await act(() => {
      useTileFindStore.getState().setQuery(AGENT.instanceId, "needle");
      return Promise.resolve();
    });

    expect(useTileFindStore.getState().activeOwner?.tileInstanceId).toBe(
      AGENT.instanceId,
    );
    expect(generation()).toBe(before);
  });

  it("does not move while the voice is not running, and picks up again when it is", () => {
    const task = taskWithWorkingAgent();
    const mounted = mount("/", { enabled: false, palette: false });
    const before = generation();

    act(() => {
      useTabsStore.setState(stripOf([task.ref, HISTORY_TAB], HISTORY_TAB));
    });
    expect(generation()).toBe(before);

    mounted.update({ enabled: true, palette: false });
    act(() => {
      useTabsStore.setState(stripOf([task.ref, HISTORY_TAB], task.ref));
    });
    expect(generation()).toBe(before + 1);
  });
});

describe("a tile's find registration", () => {
  function Adapter(props: { adapter: TileFindAdapter }): null {
    useRegisterTileFindAdapter(props.adapter);
    return null;
  }

  function Scope(props: {
    tile: EpicNodeRef;
    task: TaskTab;
    adapter: TileFindAdapter;
  }): ReactNode {
    return (
      <TileFindScope
        node={props.tile}
        viewTabId={props.task.tabId}
        tileId={`${props.tile.instanceId}-pane`}
        epicId={EPIC_ID}
        isActive
      >
        <Adapter adapter={props.adapter} />
      </TileFindScope>
    );
  }

  function adapterFor(tile: EpicNodeRef): TileFindAdapter {
    return createUnavailableTileFindAdapter({
      tileInstanceId: tile.instanceId,
      tileKind: tile.type === "chat" ? "chat" : "spec",
      message: null,
    });
  }

  function ownerId(): string | null {
    return useTileFindStore.getState().activeOwner?.tileInstanceId ?? null;
  }

  /** A task in front, the hook running, and the agent's tile mounted under its real find scope. */
  async function mountedScope() {
    const task = openTaskTab();
    useTabsStore.setState(stripOf([task.ref], task.ref));
    const mounted = mount("/", { enabled: true, palette: false });
    const agentScope = render(
      <Scope tile={AGENT} task={task} adapter={adapterFor(AGENT)} />,
    );
    await act(() => Promise.resolve());
    return { task, mounted, agentScope };
  }

  it("keeps the generation when the tile replaces its adapter, as a diff refresh does", async () => {
    const { task, agentScope } = await mountedScope();
    expect(ownerId()).toBe(AGENT.instanceId);
    const before = generation();

    await act(() => {
      agentScope.rerender(
        <Scope tile={AGENT} task={task} adapter={adapterFor(AGENT)} />,
      );
      return Promise.resolve();
    });

    expect(ownerId()).toBe(AGENT.instanceId);
    expect(generation()).toBe(before);
  });

  it("moves the generation for each change of owner across ticks, A to B and back to A", async () => {
    const { task, agentScope } = await mountedScope();
    const before = generation();

    await act(() => {
      render(<Scope tile={SPEC} task={task} adapter={adapterFor(SPEC)} />);
      return Promise.resolve();
    });
    expect(ownerId()).toBe(SPEC.instanceId);
    expect(generation()).toBe(before + 1);

    await act(() => {
      agentScope.rerender(
        <Scope tile={AGENT} task={task} adapter={adapterFor(AGENT)} />,
      );
      return Promise.resolve();
    });
    expect(ownerId()).toBe(AGENT.instanceId);
    expect(generation()).toBe(before + 2);
  });
});

describe("rows composed for a page that has since changed", () => {
  it("are not offered after the focused tab changes and before the palette publishes again, and the generation is the new page's", () => {
    const task = taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });
    const before = generation();
    expect(actionsOf(mounted.handle().current())).toContain(
      "open:chats:chat-1",
    );
    const seen: VoiceView[] = [];

    act(() => {
      useTabsStore.setState(stripOf([task.ref, HISTORY_TAB], HISTORY_TAB));
      // Before React has re-rendered the palette for History.
      seen.push(mounted.handle().current());
    });

    expect(seen.at(0)).toMatchObject({
      page: { kind: "history" },
      agent: null,
      rows: [],
      generation: before + 1,
    });

    const republished = mounted.handle().current();
    expect(actionsOf(republished)).toContain("action:app.history.open");
    expect(
      actionsOf(republished).filter((id) => id.startsWith("open:chats:")),
    ).toEqual([]);
    expect(republished.generation).toBe(before + 1);
    expect(generation()).toBe(before + 1);
  });

  it("are not offered after the Settings section changes and before the palette publishes again", async () => {
    const task = openTaskTab();
    useTabsStore.setState(stripOf([task.ref, SETTINGS_TAB], SETTINGS_TAB));
    const mounted = mount("/settings/appearance", {
      enabled: true,
      palette: true,
    });
    const before = generation();
    expect(actionsOf(mounted.handle().current())).toContain(
      "nav:settings/keybindings",
    );
    const seen: VoiceView[] = [];

    await act(() => {
      mounted.router.history.push("/settings/keybindings");
      seen.push(mounted.handle().current());
      return Promise.resolve();
    });

    expect(seen.at(0)?.rows).toEqual([]);
    expect(seen.at(0)?.page).toMatchObject({ kind: "settings" });
    const republished = mounted.handle().current();
    expect(actionsOf(republished)).toContain("nav:settings/appearance");
    expect(actionsOf(republished)).not.toContain("nav:settings/keybindings");
    expect(generation()).toBe(before + 1);
  });
});

describe("how the agent's turn is read", () => {
  function backgroundItem(kind: BackgroundItem["kind"]): BackgroundItem {
    return backgroundItemSchema.parse({
      taskId: `bg-${kind}`,
      title: `a ${kind}`,
      blockId: "block-1",
      parentTaskId: null,
      kind,
      scheduledFor: null,
      individualStopUnavailable: null,
    });
  }

  it.each([
    { name: "a command", kind: "command" },
    { name: "a monitor", kind: "monitor" },
    // The activity indicator reads this one as the agent's own work, which is
    // why the view reads the turn first: there is still no turn to stop.
    { name: "a subagent", kind: "subagent" },
  ] as const)(
    "shows the agent in the background, with nothing to stop, once its turn is over and $name still runs",
    ({ kind }) => {
      taskWithWorkingAgent();
      chatSession().store.setState({
        runStatus: "running",
        turnInProgress: false,
        backgroundItems: [backgroundItem(kind)],
      });
      const mounted = mount("/", { enabled: true, palette: true });

      const view = mounted.handle().current();

      expect(view.agent).toMatchObject({
        state: "background",
        waitingOn: null,
      });
      expect(actionsOf(view)).toContain("agent.tell:chat-1");
      expect(actionsOf(view)).not.toContain("agent.stop:chat-1");
    },
  );

  it.each([
    {
      name: "a running turn",
      state: { runStatus: "running", turnInProgress: true },
      agent: "working",
      stoppable: true,
    },
    {
      name: "a turn being stopped",
      state: { runStatus: "stopping", turnInProgress: true },
      agent: "working",
      stoppable: false,
    },
    {
      name: "nothing running",
      state: { runStatus: "idle" },
      agent: "idle",
      stoppable: false,
    },
  ] as const)(
    "reads $name as $agent, and offers to stop it: $stoppable",
    ({ state, agent, stoppable }) => {
      taskWithWorkingAgent();
      chatSession().store.setState(state);
      const mounted = mount("/", { enabled: true, palette: true });

      const view = mounted.handle().current();

      expect(view.agent?.state).toBe(agent);
      expect(actionsOf(view).includes("agent.stop:chat-1")).toBe(stoppable);
    },
  );

  it("offers no stop while a send has not started its turn, though the agent reads as working, and offers it once the turn starts", () => {
    taskWithWorkingAgent();
    chatSession().store.setState({ activeTurn: null });
    const mounted = mount("/", { enabled: true, palette: true });

    const pending = mounted.handle().current();
    expect(pending.agent).toMatchObject({ state: "working", turnId: null });
    expect(actionsOf(pending)).toContain("agent.tell:chat-1");
    expect(actionsOf(pending)).not.toContain("agent.stop:chat-1");

    act(() => {
      chatSession().store.setState({ activeTurn: activeTurn("turn-1") });
    });

    const started = mounted.handle().current();
    expect(started.agent).toMatchObject({
      state: "working",
      turnId: "turn-1",
    });
    expect(actionsOf(started)).toContain("agent.stop:chat-1");
  });

  it("shows the agent waiting on an approval, with nothing to stop, though the host still calls the run running", () => {
    taskWithWorkingAgent();
    chatSession().store.setState({
      runStatus: "running",
      turnInProgress: false,
      pendingApprovals: [approval({})],
    });
    const mounted = mount("/", { enabled: true, palette: true });

    const view = mounted.handle().current();

    expect(view.agent).toMatchObject({
      state: "waiting",
      waitingOn: "approval",
    });
    expect(actionsOf(view)).not.toContain("agent.stop:chat-1");
  });
});

function plainItem(id: string, extra: Partial<CommandItem>): CommandItem {
  return {
    id,
    label: id,
    description: null,
    keywords: [],
    group: "actions",
    scope: "actions",
    shortcut: null,
    actionId: null,
    run: () => undefined,
    subpage: null,
    ...extra,
  };
}

describe("the palette row behind an action", () => {
  it("is the item the palette offered, with the context it was composed for", () => {
    const task = taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });

    const row = mounted.handle().paletteRow("open:chats:chat-1");

    expect(row?.item.id).toBe("open:chats:chat-1");
    expect(row?.ctx).toEqual({
      pathname: "/",
      router: KEYBINDING_ROUTER,
      activeTabId: task.tabId,
      activeEpicId: EPIC_ID,
      focusedComposerKind: null,
      targetGroupId:
        useEpicCanvasStore.getState().canvasByTabId[task.tabId]?.activePaneId ??
        null,
    });
  });

  it("is gone for a page that has since changed, and back for the page that replaced it", () => {
    const task = taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });
    const seen: Array<VoicePaletteRow | null> = [];

    act(() => {
      useTabsStore.setState(stripOf([task.ref, HISTORY_TAB], HISTORY_TAB));
      // Before React has re-rendered the palette for History.
      seen.push(mounted.handle().paletteRow("open:chats:chat-1"));
    });

    expect(seen).toEqual([null]);
    expect(mounted.handle().paletteRow("open:chats:chat-1")).toBeNull();
    expect(
      mounted.handle().paletteRow("action:app.history.open")?.ctx.activeTabId,
    ).toBeNull();
  });

  it("is none while the palette has published nothing", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: false });

    expect(mounted.handle().paletteRow("open:chats:chat-1")).toBeNull();
  });

  it("is none for an item that only opens a picker or cannot be used, though the palette lists it", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: true });
    const { composedFor, ctx } = mounted.published();
    const usable = plainItem("action:usable", {});
    mounted.handle().setPaletteItems(
      {
        ...NO_PALETTE_ITEMS,
        commands: [
          usable,
          plainItem("action:picker", {
            subpage: { id: "picker", title: "Pick", useItems: () => [] },
          }),
          plainItem("action:off", { disabled: true }),
        ],
      },
      composedFor,
      ctx,
    );

    expect(mounted.handle().paletteRow("action:usable")?.item).toBe(usable);
    expect(mounted.handle().paletteRow("action:picker")).toBeNull();
    expect(mounted.handle().paletteRow("action:off")).toBeNull();
  });
});

describe("the chat session behind an action", () => {
  it("is the chat in the active tile, by its id or for whichever is shown", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: false });
    const store = chatSession().store;

    const byId = mounted.handle().agentSession("chat-1");
    const shown = mounted.handle().agentSession(null);

    expect(byId).toMatchObject({
      chatId: "chat-1",
      epicId: EPIC_ID,
      hostId: HOST_ID,
      tileInstanceId: AGENT.instanceId,
      title: "Main agent",
    });
    expect(byId?.handle.store).toBe(store);
    expect(shown?.chatId).toBe("chat-1");
  });

  it("is none for another chat's id", () => {
    taskWithWorkingAgent();
    const mounted = mount("/", { enabled: true, palette: false });

    expect(mounted.handle().agentSession("chat-elsewhere")).toBeNull();
  });

  it("is none once the active tile is not a chat", () => {
    const task = taskWithWorkingAgent();
    useTileFindStore.getState().resetForTests();
    activateTile(task, SPEC);
    const mounted = mount("/", { enabled: true, palette: false });

    expect(mounted.handle().agentSession(null)).toBeNull();
    expect(mounted.handle().agentSession("chat-1")).toBeNull();
  });
});
