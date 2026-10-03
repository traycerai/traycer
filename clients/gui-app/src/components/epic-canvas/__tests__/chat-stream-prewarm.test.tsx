import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatStreamPrewarm } from "@/components/epic-canvas/chat-stream-prewarm";
import { selectChatPrewarmRefs } from "@/components/epic-canvas/chat-prewarm-selection";
import { notifyChatTileSessionAcquired } from "@/components/epic-canvas/chat-prewarm-handoff";
import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type { ChatSessionRegistry } from "@/stores/chats/session-registry";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { ChatSessionRegistry as ChatSessionRegistryImpl } from "@/stores/chats/session-registry";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";

const testState = vi.hoisted(() => ({
  canvas: null as EpicCanvasState | null,
  mobile: false,
  visible: true,
  parked: false,
  pending: new Set<string>(),
  deleted: new Set<string>(),
  calls: [] as Array<{
    chatId: string;
    hostId: string;
    enabled: boolean;
    demand: "surface" | "startup";
  }>,
  leases: new Map<string, number>(),
  registry: null as ChatSessionRegistry | null,
  createHandle: null as
    | ((
        epicId: string,
        chatId: string,
        hostId: string,
      ) => ChatSessionStoreHandle)
    | null,
  owner: "prewarm" as "prewarm" | "tile",
  events: [] as string[],
  tileHandles: new Map<string, ChatSessionStoreHandle>(),
  createdHandles: new Map<string, ChatSessionStoreHandle>(),
}));

vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => testState.visible,
}));

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => testState.mobile,
}));

vi.mock("@/lib/epics/epic-parking", () => ({
  useEpicParked: () => testState.parked,
}));

vi.mock("@/lib/registries/chat-session-registry", async () => {
  const React = await import("react");
  return {
    useChatSessionHandle: (
      chatId: string,
      hostId: string,
      enabled: boolean,
      demand: "surface" | "startup",
    ) => {
      testState.calls.push({ chatId, hostId, enabled, demand });
      const owner = testState.owner;
      const [handle, setHandle] = React.useState<ChatSessionStoreHandle | null>(
        null,
      );
      React.useEffect(() => {
        const registry = testState.registry;
        if (registry !== null) {
          if (!enabled) {
            setHandle(null);
            return;
          }
          const lease = registry.acquire(
            {
              epicId: "epic-handoff",
              chatId,
              hostId,
              scopeKey: "handoff-test",
            },
            () => {
              const createHandle = testState.createHandle;
              if (createHandle === null) {
                throw new Error("Expected a ChatSessionStoreHandle factory");
              }
              const created = createHandle("epic-handoff", chatId, hostId);
              testState.createdHandles.set(`${hostId}\u0000${chatId}`, created);
              return created;
            },
          );
          setHandle(lease);
          return () => {
            testState.events.push(`${owner}-release:${chatId}`);
            registry.releaseHandle("epic-handoff", chatId, hostId, lease);
          };
        }
        if (!enabled) return;
        const key = `${hostId}\u0000${chatId}`;
        testState.leases.set(key, (testState.leases.get(key) ?? 0) + 1);
        return () => {
          const remaining = (testState.leases.get(key) ?? 1) - 1;
          if (remaining === 0) testState.leases.delete(key);
          else testState.leases.set(key, remaining);
        };
      }, [chatId, enabled, hostId, owner]);
      return handle;
    },
  };
});

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvas: () => testState.canvas,
  useEpicCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({
      pendingCreateArtifactIds: testState.pending,
      selfDeletedArtifactIds: testState.deleted,
    }),
}));

function chat(
  id: string,
  instanceId: string,
  hostId: string,
): EpicCanvasTileRef {
  return {
    id,
    instanceId,
    type: "chat",
    name: id,
    hostId,
  };
}

function canvas(
  panes: ReadonlyArray<{
    id: string;
    tabs: ReadonlyArray<string>;
    active: string | null;
  }>,
  refs: Readonly<Record<string, EpicCanvasTileRef>>,
  activePaneId: string | null,
): EpicCanvasState {
  const root =
    panes.length === 1
      ? {
          kind: "pane" as const,
          id: panes[0].id,
          tabInstanceIds: panes[0].tabs,
          activeTabId: panes[0].active,
          previewTabId: null,
          activationHistory: [],
        }
      : {
          kind: "group" as const,
          id: "root",
          direction: "horizontal" as const,
          children: panes.map((pane) => ({
            kind: "pane" as const,
            id: pane.id,
            tabInstanceIds: pane.tabs,
            activeTabId: pane.active,
            previewTabId: null,
            activationHistory: [],
          })),
        };
  return {
    root,
    activePaneId,
    tilesByInstanceId: refs,
    sizesByGroupId: {},
  };
}

function resetMocks(): void {
  testState.canvas = null;
  testState.mobile = false;
  testState.visible = true;
  testState.parked = false;
  testState.pending = new Set();
  testState.deleted = new Set();
  testState.calls = [];
  testState.leases = new Map();
  testState.registry?.disposeAll();
  testState.registry = null;
  testState.createHandle = null;
  testState.owner = "prewarm";
  testState.events = [];
  testState.tileHandles = new Map();
  testState.createdHandles = new Map();
}

function createTestChatHandle(
  epicId: string,
  chatId: string,
  hostId: string,
): ChatSessionStoreHandle {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId,
    epicId,
    chatId,
    userId: "prewarm-test-user",
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      interviewSettlementActionsProtocolSupported: () => true,
      autoPermissionModeProtocolSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
}

function ChatTileLease(props: {
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly instanceId: string;
}) {
  const handle = useChatSessionHandle(
    props.chatId,
    props.hostId,
    true,
    "surface",
  );
  useEffect(() => {
    if (handle === null) return;
    testState.tileHandles.set(`${props.hostId}\u0000${props.chatId}`, handle);
    testState.events.push(`tile-acquired:${props.chatId}`);
    notifyChatTileSessionAcquired(
      props.epicId,
      props.hostId,
      props.chatId,
      props.instanceId,
    );
  }, [handle, props.chatId, props.epicId, props.hostId, props.instanceId]);
  return null;
}

afterEach(() => {
  cleanup();
  resetMocks();
});

describe("chat stream prewarm", () => {
  it("does not acquire a chat session when first mounted after the snapshot loaded", () => {
    testState.canvas = canvas(
      [{ id: "pane", tabs: ["chat"], active: "chat" }],
      { chat: chat("chat-1", "chat", "host-a") },
      "pane",
    );

    const prewarm = render(
      <ChatStreamPrewarm epicId="epic-1" tabId="tab-1" snapshotLoaded />,
    );

    expect(prewarm.container.childElementCount).toBe(0);
    expect(testState.calls).toEqual([]);
  });

  it("selects only each desktop pane's active chat and preserves its bound host", () => {
    const state = canvas(
      [
        {
          id: "left",
          tabs: ["left-chat", "left-inactive"],
          active: "left-chat",
        },
        { id: "right", tabs: ["right-chat"], active: "right-chat" },
      ],
      {
        "left-chat": chat("chat-left", "left-chat", "host-left"),
        "left-inactive": chat("chat-hidden", "left-inactive", "host-left"),
        "right-chat": chat("chat-right", "right-chat", "host-right"),
      },
      "left",
    );

    expect(selectChatPrewarmRefs(state, false, new Set(), new Set())).toEqual([
      {
        id: "chat-left",
        hostId: "host-left",
        instanceId: "left-chat",
      },
      {
        id: "chat-right",
        hostId: "host-right",
        instanceId: "right-chat",
      },
    ]);
  });

  it("keeps distinct opaque host/chat pairs when their NUL-joined spellings collide", () => {
    const state = canvas(
      [
        { id: "left", tabs: ["left-chat"], active: "left-chat" },
        { id: "right", tabs: ["right-chat"], active: "right-chat" },
      ],
      {
        "left-chat": chat("c", "left-chat", "a\u0000b"),
        "right-chat": chat("b\u0000c", "right-chat", "a"),
      },
      "left",
    );

    expect(selectChatPrewarmRefs(state, false, new Set(), new Set())).toEqual([
      { id: "c", hostId: "a\u0000b", instanceId: "left-chat" },
      { id: "b\u0000c", hostId: "a", instanceId: "right-chat" },
    ]);
  });

  it("selects only the phone's currently selected chat", () => {
    const state = canvas(
      [
        { id: "left", tabs: ["left-chat"], active: "left-chat" },
        { id: "right", tabs: ["right-chat"], active: "right-chat" },
      ],
      {
        "left-chat": chat("chat-left", "left-chat", "host-left"),
        "right-chat": chat("chat-right", "right-chat", "host-right"),
      },
      "right",
    );

    expect(selectChatPrewarmRefs(state, true, new Set(), new Set())).toEqual([
      {
        id: "chat-right",
        hostId: "host-right",
        instanceId: "right-chat",
      },
    ]);
  });

  it("suppresses pending-create and self-deleted selected chats", () => {
    const state = canvas(
      [
        { id: "pending-pane", tabs: ["pending"], active: "pending" },
        { id: "deleted-pane", tabs: ["deleted"], active: "deleted" },
        { id: "valid-pane", tabs: ["valid"], active: "valid" },
      ],
      {
        pending: chat("chat-pending", "pending", "host-a"),
        deleted: chat("chat-deleted", "deleted", "host-a"),
        valid: chat("chat-valid", "valid", "host-b"),
      },
      "valid-pane",
    );

    expect(
      selectChatPrewarmRefs(
        state,
        false,
        new Set(["chat-pending"]),
        new Set(["chat-deleted"]),
      ),
    ).toEqual([{ id: "chat-valid", hostId: "host-b", instanceId: "valid" }]);
  });

  it("keeps its pre-snapshot lease until the tile reports its acquired lease", async () => {
    testState.canvas = canvas(
      [{ id: "pane", tabs: ["chat"], active: "chat" }],
      { chat: chat("chat-1", "chat", "remote-host") },
      "pane",
    );
    const prewarm = render(
      <ChatStreamPrewarm
        epicId="epic-1"
        tabId="tab-1"
        snapshotLoaded={false}
      />,
    );
    const registryKey = "remote-host\u0000chat-1";

    expect(testState.calls).toEqual([
      {
        chatId: "chat-1",
        hostId: "remote-host",
        enabled: true,
        demand: "startup",
      },
    ]);
    expect(testState.leases.get(registryKey)).toBe(1);

    // A temporary tab hide before snapshot arrival must retain the already
    // selected lease; its mounted shell still needs this overlap for handoff.
    testState.visible = false;
    prewarm.rerender(
      <ChatStreamPrewarm
        epicId="epic-1"
        tabId="tab-1"
        snapshotLoaded={false}
      />,
    );
    expect(testState.leases.get(registryKey)).toBe(1);

    // Snapshot arrival while hidden still retains the lease for tile handoff.
    prewarm.rerender(
      <ChatStreamPrewarm epicId="epic-1" tabId="tab-1" snapshotLoaded />,
    );
    expect(testState.leases.get(registryKey)).toBe(1);

    // The ordinary tile reports acquisition across the handoff signal.
    function NormalChatTileLease() {
      useChatSessionHandle("chat-1", "remote-host", true, "surface");
      return null;
    }
    const tile = render(<NormalChatTileLease />);
    expect(testState.calls.at(-1)).toEqual({
      chatId: "chat-1",
      hostId: "remote-host",
      enabled: true,
      demand: "surface",
    });
    expect(testState.leases.get(registryKey)).toBe(2);
    notifyChatTileSessionAcquired("epic-1", "remote-host", "chat-1", "chat");
    await waitFor(() => expect(testState.leases.get(registryKey)).toBe(1));
    tile.unmount();
    expect(testState.leases.has(registryKey)).toBe(false);
  });

  it("hands seven prewarm leases to tiles before the six-session warm cap can evict a handle", async () => {
    const paneRefs = Array.from({ length: 7 }, (_, index) => ({
      id: `pane-${index}`,
      tabs: [`instance-${index}`],
      active: `instance-${index}`,
    }));
    const refs = Object.fromEntries(
      paneRefs.map((pane, index) => [
        pane.tabs[0],
        chat(`chat-${index}`, pane.tabs[0], "remote-host"),
      ]),
    );
    testState.registry = new ChatSessionRegistryImpl({
      idleTtlMs: 60_000,
      maxWarmSessions: 6,
    });
    testState.createHandle = createTestChatHandle;
    testState.canvas = canvas(paneRefs, refs, "pane-0");
    testState.owner = "prewarm";

    const prewarm = render(
      <ChatStreamPrewarm
        epicId="epic-handoff"
        tabId="tab-handoff"
        snapshotLoaded={false}
      />,
    );
    await waitFor(() => expect(testState.registry?.size()).toBe(7));
    expect(testState.createdHandles.size).toBe(7);

    prewarm.rerender(
      <ChatStreamPrewarm
        epicId="epic-handoff"
        tabId="tab-handoff"
        snapshotLoaded
      />,
    );
    expect(testState.registry.size()).toBe(7);
    expect(testState.events).toEqual([]);

    const tileTrees = paneRefs.map((_, index) => {
      testState.owner = "tile";
      const tile = render(
        <ChatTileLease
          chatId={`chat-${index}`}
          epicId="epic-handoff"
          hostId="remote-host"
          instanceId={`instance-${index}`}
        />,
      );
      testState.owner = "prewarm";
      return tile;
    });

    await waitFor(() => expect(testState.tileHandles.size).toBe(7));
    for (let index = 0; index < 7; index += 1) {
      const key = `remote-host\u0000chat-${index}`;
      const acquiredIndex = testState.events.indexOf(
        `tile-acquired:chat-${index}`,
      );
      const releasedIndex = testState.events.indexOf(
        `prewarm-release:chat-${index}`,
      );
      expect(acquiredIndex).toBeGreaterThanOrEqual(0);
      expect(releasedIndex).toBeGreaterThan(acquiredIndex);
      expect(testState.tileHandles.get(key)).toBe(
        testState.createdHandles.get(key),
      );
      expect(
        testState.registry.peek("epic-handoff", `chat-${index}`, "remote-host"),
      ).toBe(testState.createdHandles.get(key));
    }
    expect(testState.createdHandles.size).toBe(7);
    for (const tile of tileTrees) tile.unmount();
  });

  it("releases a stale prewarm lease after the 30 second post-snapshot fallback", async () => {
    vi.useFakeTimers();
    try {
      testState.canvas = canvas(
        [{ id: "pane", tabs: ["chat"], active: "chat" }],
        { chat: chat("chat-1", "chat", "host-a") },
        "pane",
      );
      const prewarm = render(
        <ChatStreamPrewarm
          epicId="epic-1"
          tabId="tab-1"
          snapshotLoaded={false}
        />,
      );
      const key = "host-a\u0000chat-1";
      prewarm.rerender(
        <ChatStreamPrewarm epicId="epic-1" tabId="tab-1" snapshotLoaded />,
      );
      expect(testState.leases.get(key)).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(testState.leases.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not acquire leases while the pane is hidden or the epic is parked", () => {
    testState.canvas = canvas(
      [{ id: "pane", tabs: ["chat"], active: "chat" }],
      { chat: chat("chat-1", "chat", "host-a") },
      "pane",
    );
    testState.visible = false;
    const hidden = render(
      <ChatStreamPrewarm
        epicId="epic-1"
        tabId="tab-1"
        snapshotLoaded={false}
      />,
    );
    expect(testState.calls).toEqual([]);

    testState.visible = true;
    testState.parked = true;
    hidden.rerender(
      <ChatStreamPrewarm
        epicId="epic-1"
        tabId="tab-1"
        snapshotLoaded={false}
      />,
    );
    expect(testState.calls).toEqual([]);
  });

  it("releases an existing selected prewarm lease when the epic becomes parked", () => {
    testState.canvas = canvas(
      [{ id: "pane", tabs: ["chat"], active: "chat" }],
      { chat: chat("chat-1", "chat", "host-a") },
      "pane",
    );
    const prewarm = render(
      <ChatStreamPrewarm
        epicId="epic-1"
        tabId="tab-1"
        snapshotLoaded={false}
      />,
    );
    const registryKey = "host-a\u0000chat-1";
    expect(testState.leases.get(registryKey)).toBe(1);

    testState.parked = true;
    prewarm.rerender(
      <ChatStreamPrewarm
        epicId="epic-1"
        tabId="tab-1"
        snapshotLoaded={false}
      />,
    );

    expect(testState.leases.has(registryKey)).toBe(false);
  });
});
