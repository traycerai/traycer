import "../../../../../__tests__/test-browser-apis";
import {
  afterEach,
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import {
  openCreatedChatWhenProjected,
  openCreatedChatWhenProjectedWithNavigation,
  openNewChatInActiveTile,
  type CreateChatCommand,
  type CreateChatCommandCallbacks,
  type CreatedChatOpenIntent,
} from "@/lib/commands/actions";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/** Every open tab's payload across all panes, resolved through the canvas. */
function allTabRefs(
  canvas: EpicCanvasState | undefined,
): ReadonlyArray<EpicCanvasTileRef> {
  if (canvas === undefined) return [];
  return collectPanes(canvas.root).flatMap((pane) => paneTabRefs(canvas, pane));
}

const registryMock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    chats: {
      byId: {} as Record<string, { id: string; title: string }>,
    },
  };
  const handle = {
    store: {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  return {
    getOpenEpicRegistry: () => ({
      get: () => handle,
    }),
    projectChat: (chat: { readonly id: string; readonly title: string }) => {
      state.chats.byId = {
        ...state.chats.byId,
        [chat.id]: { id: chat.id, title: chat.title },
      };
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
    reset: () => {
      state.chats.byId = {};
      listeners.clear();
    },
  };
});

vi.mock("@/lib/registries/epic-session-registry", () => ({
  getOpenEpicRegistry: registryMock.getOpenEpicRegistry,
}));

const EPIC_ID = "epic-command-new-chat";
const TAB_ID = "tab-command-new-chat";
const SEEDED_WORKTREE_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: "/repo-seeded",
      repoIdentifier: { owner: "traycerai", repo: "seeded" },
      isPrimary: true,
    },
  ],
};

interface CreateChatCall {
  readonly request: CreateChatMutationInput;
  readonly callbacks: CreateChatCommandCallbacks;
}

function createChatRecorder(): {
  readonly calls: CreateChatCall[];
  readonly createChat: CreateChatCommand;
} {
  const calls: CreateChatCall[] = [];
  return {
    calls,
    createChat: (request, callbacks) => {
      calls.push({ request, callbacks });
    },
  };
}

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
    selfDeletedArtifactIds: new Set<string>(),
    preAckRootCreatesByEpic: {},
    pendingRootCreatesByEpic: {},
  });
}

function seedActiveGroup(): string {
  useEpicCanvasStore
    .getState()
    .seedEpic(EPIC_ID, { tabId: TAB_ID, name: "Command Epic" }, []);
  useEpicCanvasStore.getState().openTileInTab(TAB_ID, {
    id: "existing-spec",
    instanceId: "inst-existing-spec",
    type: "spec",
    name: "Existing spec",
    hostId: "test-host",
  });
  const activeGroupId =
    useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.activePaneId ?? null;
  if (activeGroupId === null) {
    throw new Error("Expected active group after seeding canvas.");
  }
  return activeGroupId;
}

function openIntentsRecorder(): {
  readonly intents: CreatedChatOpenIntent[];
  readonly openWhenProjected: (intent: CreatedChatOpenIntent) => () => void;
} {
  const intents: CreatedChatOpenIntent[] = [];
  return {
    intents,
    openWhenProjected: (intent) => {
      intents.push(intent);
      return () => undefined;
    },
  };
}

interface NestedFocusCall {
  readonly epicId: string;
  readonly tabId: string;
  readonly target: NestedFocusTarget | null;
}

function nestedFocusRecorder(): {
  readonly calls: NestedFocusCall[];
  readonly navigateNestedFocus: NavigateNestedFocus;
} {
  const calls: NestedFocusCall[] = [];
  return {
    calls,
    navigateNestedFocus: (epicId, tabId, prepare) => {
      const target = prepare();
      calls.push({
        epicId,
        tabId,
        target,
      });
      return target;
    },
  };
}

describe("new chat command actions", () => {
  let track: MockInstance<Analytics["track"]>;

  beforeEach(() => {
    resetCanvasStore();
    registryMock.reset();
    track = vi.spyOn(Analytics.getInstance(), "track");
  });

  afterEach(() => {
    resetCanvasStore();
    registryMock.reset();
    vi.restoreAllMocks();
  });

  it("creates active-tile chats through epic.createChat and queues the host chat id", () => {
    const createChat = createChatRecorder();
    const opened = openIntentsRecorder();

    openNewChatInActiveTile({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      hostId: "test-host",
      source: "direct_ui",
      worktreeIntent: null,
      settings: null,
      createChat: createChat.createChat,
      openWhenProjected: opened.openWhenProjected,
    });

    expect(createChat.calls).toHaveLength(1);
    expect(createChat.calls[0].request).toMatchObject({
      epicId: EPIC_ID,
      parentId: null,
      // Chats are created with an empty stored title; the "Untitled chat"
      // fallback is applied at render, not baked into the create request.
      title: "",
    });
    expect(createChat.calls[0].request.chatId).toEqual(expect.any(String));

    createChat.calls[0].callbacks.onSuccess({ chatId: "host-chat" });

    expect(opened.intents).toEqual([
      {
        kind: "active-tile",
        epicId: EPIC_ID,
        tabId: TAB_ID,
        chatId: "host-chat",
        hostId: "test-host",
        source: "direct_ui",
      },
    ]);
  });

  it("passes a supplied workspace seed into epic.createChat", () => {
    const createChat = createChatRecorder();
    const opened = openIntentsRecorder();

    openNewChatInActiveTile({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      hostId: "test-host",
      source: "direct_ui",
      worktreeIntent: SEEDED_WORKTREE_INTENT,
      settings: null,
      createChat: createChat.createChat,
      openWhenProjected: opened.openWhenProjected,
    });

    expect(createChat.calls[0].request.worktreeIntent).toBe(
      SEEDED_WORKTREE_INTENT,
    );
  });

  it("opens an active-tile tab only after the host-created chat appears in projection", () => {
    seedActiveGroup();

    openCreatedChatWhenProjected({
      kind: "active-tile",
      epicId: EPIC_ID,
      tabId: TAB_ID,
      chatId: "host-chat",
      hostId: "test-host",
      source: "direct_ui",
    });

    expect(
      allTabRefs(useEpicCanvasStore.getState().canvasByTabId[TAB_ID]).some(
        (tab) => tab.id === "host-chat",
      ),
    ).toBe(false);

    registryMock.projectChat({ id: "host-chat", title: "Host chat" });

    const tabs = allTabRefs(
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID],
    );
    expect(tabs).toContainEqual(
      expect.objectContaining({
        id: "host-chat",
        type: "chat",
        name: "Host chat",
        hostId: "test-host",
      }),
    );
    expect(useEpicCanvasStore.getState().artifactTreeByEpicId[EPIC_ID]).toEqual(
      [],
    );
  });

  it("routes projected chat opens through supplied nested focus navigation", () => {
    const activeGroupId = seedActiveGroup();
    const navigation = nestedFocusRecorder();

    openCreatedChatWhenProjectedWithNavigation({
      intent: {
        kind: "active-tile",
        epicId: EPIC_ID,
        tabId: TAB_ID,
        chatId: "host-chat",
        hostId: "test-host",
        source: "direct_ui",
      },
      navigateNestedFocus: navigation.navigateNestedFocus,
    });

    expect(navigation.calls).toHaveLength(0);

    registryMock.projectChat({ id: "host-chat", title: "Host chat" });

    expect(navigation.calls).toHaveLength(1);
    const call = navigation.calls[0];
    expect(call.epicId).toBe(EPIC_ID);
    expect(call.tabId).toBe(TAB_ID);
    expect(call.target?.paneId).toBe(activeGroupId);
    expect(typeof call.target?.tileInstanceId).toBe("string");
    const target = call.target;
    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    if (
      target === null ||
      target.tileInstanceId === undefined ||
      canvas === undefined
    ) {
      throw new Error("expected route-aware projection to open a chat tile");
    }
    expect(canvas.tilesByInstanceId[target.tileInstanceId]).toMatchObject({
      id: "host-chat",
      type: "chat",
      name: "Host chat",
      hostId: "test-host",
    });
  });

  describe("caller-owned cancellation", () => {
    beforeAll(() => {
      vi.useFakeTimers();
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    it("removes the projection subscription when the caller cancels before the chat lands", () => {
      seedActiveGroup();

      const cancel = openCreatedChatWhenProjected({
        kind: "active-tile",
        epicId: EPIC_ID,
        tabId: TAB_ID,
        chatId: "host-chat",
        hostId: "test-host",
        source: "direct_ui",
      });

      expect(registryMock.listenerCount()).toBe(1);

      cancel();

      expect(registryMock.listenerCount()).toBe(0);
      // A late projection arriving after cancel is a no-op (no tab opens).
      registryMock.projectChat({ id: "host-chat", title: "Late" });
      const tabs =
        useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.root ?? null;
      expect(JSON.stringify(tabs)).not.toContain("host-chat");

      // Advancing past the safety timeout doesn't re-trigger anything.
      vi.advanceTimersByTime(60_000);
      expect(registryMock.listenerCount()).toBe(0);
    });

    it("auto-cleans the subscription after the 30s safety timeout", () => {
      seedActiveGroup();

      openCreatedChatWhenProjected({
        kind: "active-tile",
        epicId: EPIC_ID,
        tabId: TAB_ID,
        chatId: "host-chat",
        hostId: "test-host",
        source: "direct_ui",
      });

      expect(registryMock.listenerCount()).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(registryMock.listenerCount()).toBe(0);
    });

    it("propagates cancel from openNewChatInActiveTile through the projection wait", () => {
      seedActiveGroup();
      const createChat = createChatRecorder();

      const cancel = openNewChatInActiveTile({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        hostId: "test-host",
        source: "direct_ui",
        worktreeIntent: null,
        settings: null,
        createChat: createChat.createChat,
        openWhenProjected: openCreatedChatWhenProjected,
      });

      // Mutation succeeds → projection subscription installs.
      createChat.calls[0].callbacks.onSuccess({ chatId: "host-chat" });
      expect(registryMock.listenerCount()).toBe(1);

      cancel();
      expect(registryMock.listenerCount()).toBe(0);
    });

    it("ignores onSuccess that fires after the action was cancelled", () => {
      const createChat = createChatRecorder();

      const cancel = openNewChatInActiveTile({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        hostId: "test-host",
        source: "direct_ui",
        worktreeIntent: null,
        settings: null,
        createChat: createChat.createChat,
        openWhenProjected: openCreatedChatWhenProjected,
      });

      cancel();
      createChat.calls[0].callbacks.onSuccess({ chatId: "late-chat" });

      expect(registryMock.listenerCount()).toBe(0);
    });
  });

  it("opens the host-created chat into the explicit target group (opener path)", () => {
    const sourceGroupId = seedActiveGroup();
    const targetGroupId = useEpicCanvasStore
      .getState()
      .splitPaneEmptyRightInTab(TAB_ID, sourceGroupId);
    if (targetGroupId === null) throw new Error("expected a new empty group");

    openCreatedChatWhenProjected({
      kind: "target-group",
      epicId: EPIC_ID,
      tabId: TAB_ID,
      chatId: "host-chat",
      groupId: targetGroupId,
      hostId: "test-host",
      source: "command_palette",
    });
    registryMock.projectChat({ id: "host-chat", title: "Host chat" });

    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const target = findPaneById(canvas?.root ?? null, targetGroupId);
    if (target === null || canvas === undefined) {
      throw new Error("expected a resolvable target pane");
    }
    expect(paneTabRefs(canvas, target).map((tab) => tab.id)).toEqual([
      "host-chat",
    ]);
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.ChatOpened, {
      source: "command_palette",
    });
  });

  it("abandons the open (and emits nothing) when the projected target disappears", () => {
    const sourceGroupId = seedActiveGroup();
    const targetGroupId = useEpicCanvasStore
      .getState()
      .splitPaneEmptyRightInTab(TAB_ID, sourceGroupId);
    if (targetGroupId === null) throw new Error("expected a target group");
    openCreatedChatWhenProjected({
      kind: "target-group",
      epicId: EPIC_ID,
      tabId: TAB_ID,
      chatId: "host-chat",
      groupId: targetGroupId,
      hostId: "test-host",
      source: "command_palette",
    });

    useEpicCanvasStore.getState().closeCanvasPane(TAB_ID, targetGroupId);
    registryMock.projectChat({ id: "host-chat", title: "Host chat" });

    // Pre-analytics product behavior: the open is attempted exactly once and
    // abandoned when its pane is gone - no fallback pane, no chat_opened.
    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const source = findPaneById(canvas?.root ?? null, sourceGroupId);
    if (canvas === undefined || source === null) {
      throw new Error("expected the original pane to survive");
    }
    expect(paneTabRefs(canvas, source).map((tab) => tab.id)).not.toContain(
      "host-chat",
    );
    expect(track).not.toHaveBeenCalledWith(AnalyticsEvent.ChatOpened, {
      source: "command_palette",
    });
  });

  it("splits with the host-created chat id after projection", () => {
    const activeGroupId = seedActiveGroup();

    openCreatedChatWhenProjected({
      kind: "split",
      epicId: EPIC_ID,
      tabId: TAB_ID,
      chatId: "host-chat",
      targetGroupId: activeGroupId,
      position: "bottom",
      hostId: "test-host",
      source: "direct_ui",
    });
    registryMock.projectChat({ id: "host-chat", title: "" });

    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    if (canvas === undefined) throw new Error("expected seeded tab canvas");
    const groups = collectPanes(canvas.root);
    expect(groups).toHaveLength(2);
    expect(allTabRefs(canvas)).toContainEqual(
      expect.objectContaining({
        id: "host-chat",
        type: "chat",
        // Empty stored title renders the "Untitled chat" fallback as the
        // node's snapshot name - never the "New chat" placeholder.
        name: "Untitled chat",
        hostId: "test-host",
      }),
    );
    expect(canvas.activePaneId).not.toBe(activeGroupId);
    expect(useEpicCanvasStore.getState().artifactTreeByEpicId[EPIC_ID]).toEqual(
      [],
    );
  });
});
