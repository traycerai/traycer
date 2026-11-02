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
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatApprovalStateSchema,
  type ChatApprovalState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import {
  useVoiceView,
  VoiceViewPaletteItems,
  type VoiceViewHandle,
} from "@/hooks/voice/use-voice-view";
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
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import type { VoiceView } from "@/lib/voice/view";
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

interface Mounted {
  readonly handle: () => VoiceViewHandle;
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
  function Probe(probe: ProbeProps): ReactNode {
    const handle = useVoiceView(probe.enabled);
    useEffect(() => {
      captured = handle;
    }, [handle]);
    return probe.palette ? (
      <VoiceViewPaletteItems onItems={handle.setPaletteItems} />
    ) : null;
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
  session.store.setState({ runStatus: "running" });
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

  it("moves once per change of the active tile's owner", () => {
    const task = taskWithWorkingAgent();
    mount("/", { enabled: true, palette: false });
    const before = generation();

    act(() => {
      activateTile(task, SPEC);
    });

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

  it("does not move for a change in the tile-find store that leaves the owner as it is", () => {
    taskWithWorkingAgent();
    mount("/", { enabled: true, palette: false });
    const before = generation();

    act(() => {
      useTileFindStore.getState().setQuery(AGENT.instanceId, "needle");
    });
    const owner = useTileFindStore.getState().activeOwner;
    act(() => {
      useTileFindStore.setState({
        activeOwner: owner === null ? null : { ...owner },
      });
    });

    expect(owner?.tileInstanceId).toBe(AGENT.instanceId);
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
