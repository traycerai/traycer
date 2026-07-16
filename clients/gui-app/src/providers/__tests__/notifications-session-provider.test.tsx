import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
} from "@traycer/protocol/notifications/notification-entry";
import {
  hostNotificationsSubscribeClientFrameSchema,
  type HostNotificationEntry,
  type HostNotificationsMarkReadRequest,
  type HostNotificationsSubscribeClientFrame,
} from "@traycer/protocol/host/notifications/contracts";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  NOTIFICATIONS_ARRAY_KEY,
  createNotificationRoomEntryMap,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";

interface HostState {
  id: string;
  client: HostClient<HostRpcRegistry> | null;
}

interface StreamState {
  client: WsStreamClient<HostStreamRpcRegistry> | null;
}

const hostState = vi.hoisted<HostState>(() => ({ id: "host-a", client: null }));
const streamState = vi.hoisted<StreamState>(() => ({ client: null }));

const mockAuth = {
  onChange: vi.fn((_handler: (status: string) => void) => ({
    dispose: vi.fn(),
  })),
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => hostState.client,
  useAuthService: () => mockAuth,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => streamState.client,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostState.id,
}));

vi.mock("@/hooks/notifications/use-notifications", () => ({
  useNotificationShow: () => () => Promise.resolve(),
}));

import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { __setNotificationsStreamFactoryForTests } from "@/providers/notifications-stream-factory-override";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  __resetNotificationsStoreForTests,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  emitTerminalCrashedNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

interface ControlledStream {
  closeCount: number;
}

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  readonly clientFrames: HostNotificationsSubscribeClientFrame[] = [];
  closeCount = 0;

  sendClientFrame(envelope: StreamFrameEnvelope): void {
    this.clientFrames.push(
      hostNotificationsSubscribeClientFrameSchema.parse(envelope),
    );
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  close(): void {
    this.closeCount += 1;
  }

  emitServerFrame(envelope: StreamFrameEnvelope): void {
    this.serverFrameHandler?.(envelope, null);
  }

  emitOpen(): void {
    this.statusChangeHandler?.("open", null);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly session = new MockStreamSession();
  readonly subscribedMethods: string[] = [];

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribedMethods.push(method);
    return this.session;
  }
}

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
      subscriptionStatus: "PRO",
    });
    return;
  }
  useAuthStore.setState({
    status,
    profile: null,
    contextMetadata: null,
    subscriptionStatus: null,
  });
}

function invitedEntry(id: string, epicId: string): NotificationEntry {
  return {
    id,
    createdAt: 1,
    readAt: null,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.INVITED,
      epicId,
      actorName: "Alice",
    },
  };
}

function appendEntry(entry: NotificationEntry): void {
  const doc = useNotificationsStore.getState().doc;
  const arr = doc.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  doc.transact(() => {
    arr.push([createNotificationRoomEntryMap(entry)]);
  }, "stream");
}

function hostEntry(input: {
  readonly id: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly severity: "done" | "failure" | "needs_action";
}): HostNotificationEntry {
  if (input.severity === "needs_action") {
    return {
      id: input.id,
      updatedAt: 1,
      readAt: null,
      kind: "interview.requested",
      sourceRef: input.id,
      severity: input.severity,
      outcome: null,
      resolvedAt: null,
      epicId: input.epicId,
      chatId: input.chatId,
      payload: { epicId: input.epicId, chatId: input.chatId },
    };
  }
  return {
    id: input.id,
    updatedAt: 1,
    readAt: null,
    kind: "agent.stopped",
    sourceRef: input.id,
    severity: input.severity,
    outcome: "completed",
    epicId: input.epicId,
    chatId: input.chatId,
    payload: {
      epicId: input.epicId,
      chatId: input.chatId,
      outcome: "completed",
    },
  };
}

function createHostClient(
  markReadCalls: Array<HostNotificationsMarkReadRequest>,
): HostClient<HostRpcRegistry> {
  const queryClient = new QueryClient();
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {
        "host.notifications.markRead": (request) => {
          markReadCalls.push(request);
          return {};
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return client;
}

function setFocusedChat(epicId: string, chatId: string): void {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, "Epic");
  useEpicCanvasStore.getState().openTileInTab(
    tabId,
    makeOpenableNodeRef({
      id: chatId,
      instanceId: `${chatId}-instance`,
      type: "chat",
      name: "Chat",
      hostId: "host-a",
    }),
  );
}

function setFocusedTerminal(epicId: string, terminalId: string): void {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, "Epic");
  useEpicCanvasStore.getState().openTileInTab(tabId, {
    id: terminalId,
    instanceId: `${terminalId}-instance`,
    type: "terminal",
    name: "Terminal",
    titleSource: "default",
    hostId: "host-a",
    cwd: "/repo",
  });
}

function sendPresence(): void {
  window.dispatchEvent(new Event("focus"));
}

async function renderHostNotificationsProvider(): Promise<{
  readonly markReadCalls: Array<HostNotificationsMarkReadRequest>;
  readonly queryClient: QueryClient;
  readonly streamClient: MockWsStreamClient;
}> {
  const markReadCalls: Array<HostNotificationsMarkReadRequest> = [];
  const streamClient = new MockWsStreamClient();
  const queryClient = new QueryClient();
  hostState.id = mockLocalHostEntry.hostId;
  hostState.client = createHostClient(markReadCalls);
  streamState.client = streamClient;
  useAppLocalNotificationsStore
    .getState()
    .activateIdentity("alice@example.com");

  render(
    <QueryClientProvider client={queryClient}>
      <NotificationsSessionProvider>
        <div />
      </NotificationsSessionProvider>
    </QueryClientProvider>,
  );

  act(() => {
    resetAuth("signed-in", "alice@example.com");
  });

  await waitFor(() => {
    expect(streamClient.session.clientFrames).toHaveLength(1);
  });

  return { markReadCalls, queryClient, streamClient };
}

function indicatorKey(
  epicId: string,
  chatId: string,
): readonly [
  "host",
  string,
  "host.notifications.indicatorState",
  {
    readonly epicIds: ReadonlyArray<string>;
    readonly chatIds: ReadonlyArray<string>;
  },
  string,
] {
  return [
    "host",
    mockLocalHostEntry.hostId,
    "host.notifications.indicatorState",
    { epicIds: [epicId], chatIds: [chatId] },
    "notifications:indicator-state:alice@example.com",
  ];
}

describe("<NotificationsSessionProvider />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostState.id = "host-a";
    hostState.client = null;
    streamState.client = null;
    mockAuth.onChange.mockClear();
    mockAuth.onChange.mockImplementation(
      (_handler: (status: string) => void) => ({
        dispose: vi.fn(),
      }),
    );
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().resetForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __setNotificationsStreamFactoryForTests(null);
    resetAuth("signed-out", null);
  });

  afterEach(() => {
    cleanup();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().resetForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __setNotificationsStreamFactoryForTests(null);
    resetAuth("signed-out", null);
    vi.restoreAllMocks();
  });

  it("reopens the stream and resets the local replica on signed-in user switches", async () => {
    const queryClient = new QueryClient();
    const streams: ControlledStream[] = [];
    __setNotificationsStreamFactoryForTests((_callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });

    act(() => {
      appendEntry(invitedEntry("n-1", "epic-alpha"));
    });

    await waitFor(() => {
      expect(useNotificationsStore.getState().entries).toHaveLength(1);
    });

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(streams[0].closeCount).toBe(1);
      expect(useNotificationsStore.getState().entries).toEqual([]);
    });
  });

  it("reopens the stream and resets the local replica on host switches", async () => {
    const queryClient = new QueryClient();
    const streams: ControlledStream[] = [];
    __setNotificationsStreamFactoryForTests((_callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });

    act(() => {
      appendEntry(invitedEntry("n-1", "epic-alpha"));
    });

    await waitFor(() => {
      expect(useNotificationsStore.getState().entries).toHaveLength(1);
    });

    act(() => {
      hostState.id = "host-b";
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(streams[0].closeCount).toBe(1);
      expect(useNotificationsStore.getState().entries).toEqual([]);
    });
  });

  it("rebinds both notification streams to a replaced stream client without resetting the replica", async () => {
    const markReadCalls: Array<HostNotificationsMarkReadRequest> = [];
    const firstClient = new MockWsStreamClient();
    const queryClient = new QueryClient();
    hostState.id = mockLocalHostEntry.hostId;
    hostState.client = createHostClient(markReadCalls);
    streamState.client = firstClient;
    useAppLocalNotificationsStore
      .getState()
      .activateIdentity("alice@example.com");

    const view = render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(firstClient.session.clientFrames).toHaveLength(1);
    });
    expect([...firstClient.subscribedMethods].sort()).toEqual([
      "host.notifications.subscribe",
      "notifications.subscribe",
    ]);

    act(() => {
      appendEntry(invitedEntry("n-1", "epic-alpha"));
    });
    await waitFor(() => {
      expect(useNotificationsStore.getState().entries).toHaveLength(1);
    });

    // Same host + same user: ONLY the stream client is replaced - the
    // app-wide liveness rebuild after the old client was closed underneath
    // the provider. Both notification streams must rebind to the new client
    // (the old client's sessions are dead), and the replica must survive.
    const secondClient = new MockWsStreamClient();
    act(() => {
      streamState.client = secondClient;
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(secondClient.session.clientFrames).toHaveLength(1);
    });
    expect([...secondClient.subscribedMethods].sort()).toEqual([
      "host.notifications.subscribe",
      "notifications.subscribe",
    ]);
    // Both streams shared `firstClient.session` in this mock, so both old
    // sessions closing is observed as two closes on that shared session.
    expect(firstClient.session.closeCount).toBe(2);
    expect(useNotificationsStore.getState().entries).toHaveLength(1);
  });

  it("consumes an active entity once when a done row is present", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls, streamClient } =
      await renderHostNotificationsProvider();
    useAppLocalNotificationsStore.getState().upsert({
      id: "local-error",
      updatedAt: 1,
      readAt: null,
      kind: "host.error",
      sourceRef: null,
      payload: { kind: "chat", epicId: "epic-a", chatId: "chat-a" },
      message: "Local error",
      detail: null,
    });

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: hostEntry({
          id: "done-1",
          epicId: "epic-a",
          chatId: "chat-a",
          severity: "done",
        }),
      });
      setFocusedChat("epic-a", "chat-a");
      hasFocus.mockReturnValue(true);
      sendPresence();
      sendPresence();
    });

    await waitFor(() => {
      expect(markReadCalls).toEqual([
        { kind: "entity", entity: { epicId: "epic-a", chatId: "chat-a" } },
      ]);
    });
    expect(
      useAppLocalNotificationsStore.getState().byId["local-error"].readAt,
    ).not.toBeNull();
  });

  it("consumes the chat after a tab activates before its canvas tile settles", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { markReadCalls, streamClient } =
      await renderHostNotificationsProvider();

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: hostEntry({
          id: "done-click",
          epicId: "epic-a",
          chatId: "chat-a",
          severity: "done",
        }),
      });
      const tabId = useEpicCanvasStore.getState().openEpicTab("epic-a", "Epic");
      useEpicCanvasStore.getState().openTileInTab(
        tabId,
        makeOpenableNodeRef({
          id: "chat-a",
          instanceId: "chat-a-instance",
          type: "chat",
          name: "Chat",
          hostId: "host-a",
        }),
      );
    });

    await waitFor(() => {
      expect(markReadCalls).toContainEqual({
        kind: "entity",
        entity: { epicId: "epic-a", chatId: "chat-a" },
      });
    });
    hasFocus.mockReturnValue(true);

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["done-click"],
        entityRefs: [{ epicId: "epic-a", chatId: "chat-a" }],
        readAt: 2,
        resolvedAt: null,
      });
    });

    expect(useHostNotificationsStore.getState().byId["done-click"].readAt).toBe(
      2,
    );
    expect(
      selectNotificationIndicatorState(
        { byId: {} },
        { epicId: "epic-a", chatId: "chat-a" },
        {
          epics: {},
          chats: {
            "chat-a": {
              unreadFailure: false,
              pendingApproval: false,
              pendingInterview: false,
              unreadDone: false,
            },
          },
        },
      ),
    ).toEqual({
      unreadFailure: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
    });
  });

  it("does not consume a needs-action-only upsert for the active entity", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls, streamClient } =
      await renderHostNotificationsProvider();

    act(() => {
      setFocusedChat("epic-a", "chat-a");
      hasFocus.mockReturnValue(true);
      sendPresence();
    });
    await waitFor(() => expect(markReadCalls).toHaveLength(1));
    markReadCalls.splice(0);

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: hostEntry({
          id: "prompt-1",
          epicId: "epic-a",
          chatId: "chat-a",
          severity: "needs_action",
        }),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markReadCalls).toEqual([]);
  });

  it("does not consume done rows belonging to a different tile in the same epic", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls, streamClient } =
      await renderHostNotificationsProvider();

    act(() => {
      setFocusedChat("epic-a", "chat-a");
      hasFocus.mockReturnValue(true);
      sendPresence();
    });
    await waitFor(() => expect(markReadCalls).toHaveLength(1));
    markReadCalls.splice(0);

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: hostEntry({
          id: "done-other",
          epicId: "epic-a",
          chatId: "chat-b",
          severity: "done",
        }),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markReadCalls).toEqual([]);
  });

  it("does not consume chat rows for an epic-only presence", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls, streamClient } =
      await renderHostNotificationsProvider();

    act(() => {
      useEpicCanvasStore.getState().openEpicTab("epic-a", "Epic");
      hasFocus.mockReturnValue(true);
      sendPresence();
    });
    await waitFor(() => expect(markReadCalls).toHaveLength(1));
    markReadCalls.splice(0);

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: hostEntry({
          id: "done-chat-row",
          epicId: "epic-a",
          chatId: "chat-a",
          severity: "done",
        }),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markReadCalls).toEqual([]);
  });

  it("does not consume done rows while the window is unfocused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls, streamClient } =
      await renderHostNotificationsProvider();

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: hostEntry({
          id: "done-unfocused",
          epicId: "epic-a",
          chatId: "chat-a",
          severity: "done",
        }),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markReadCalls).toEqual([]);
  });

  it("consumes a terminal crash that arrives while that terminal is visible", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls } = await renderHostNotificationsProvider();

    act(() => {
      setFocusedTerminal("epic-a", "terminal-a");
      hasFocus.mockReturnValue(true);
      sendPresence();
    });
    await waitFor(() => expect(markReadCalls).toHaveLength(1));
    markReadCalls.splice(0);

    act(() => {
      emitTerminalCrashedNotification({
        instanceId: "terminal-a-instance",
        epicId: "epic-a",
        chatId: "terminal-a",
        cause: "exit",
      });
    });

    await waitFor(() => {
      const crash = Object.values(
        useAppLocalNotificationsStore.getState().byId,
      )[0];
      expect(crash.readAt).not.toBeNull();
    });
    expect(markReadCalls).toEqual([
      { kind: "entity", entity: { epicId: "epic-a", chatId: "terminal-a" } },
    ]);
  });

  it("leaves crashes for a background terminal unread", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls } = await renderHostNotificationsProvider();

    act(() => {
      setFocusedTerminal("epic-a", "terminal-a");
      hasFocus.mockReturnValue(true);
      sendPresence();
    });
    await waitFor(() => expect(markReadCalls).toHaveLength(1));
    markReadCalls.splice(0);

    act(() => {
      emitTerminalCrashedNotification({
        instanceId: "terminal-b-instance",
        epicId: "epic-a",
        chatId: "terminal-b",
        cause: "exit",
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const crash = Object.values(
      useAppLocalNotificationsStore.getState().byId,
    )[0];
    expect(crash.readAt).toBeNull();
    expect(markReadCalls).toEqual([]);
  });

  it("reconsumes the active entity after the host stream reconnects", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { markReadCalls, streamClient } =
      await renderHostNotificationsProvider();

    act(() => {
      setFocusedChat("epic-a", "chat-a");
      hasFocus.mockReturnValue(true);
      sendPresence();
    });
    await waitFor(() => expect(markReadCalls).toHaveLength(1));
    markReadCalls.splice(0);

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        entries: [
          hostEntry({
            id: "done-after-reconnect",
            epicId: "epic-a",
            chatId: "chat-a",
            severity: "done",
          }),
        ],
      });
      streamClient.session.emitOpen();
    });

    await waitFor(() => {
      expect(markReadCalls).toEqual([
        { kind: "entity", entity: { epicId: "epic-a", chatId: "chat-a" } },
      ]);
    });
  });

  it("invalidates all indicator queries on a snapshot frame", async () => {
    const { queryClient, streamClient } =
      await renderHostNotificationsProvider();
    const key = indicatorKey("epic-a", "chat-a");
    queryClient.setQueryData(key, { epics: {}, chats: {} });

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        entries: [],
      });
    });

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("invalidates only referenced entities on read-state frames", async () => {
    const { queryClient, streamClient } =
      await renderHostNotificationsProvider();
    const target = indicatorKey("epic-a", "chat-a");
    const other = indicatorKey("epic-b", "chat-b");
    queryClient.setQueryData(target, { epics: {}, chats: {} });
    queryClient.setQueryData(other, { epics: {}, chats: {} });

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["read-1"],
        entityRefs: [{ epicId: "epic-a", chatId: "chat-a" }],
        readAt: 1,
        resolvedAt: null,
      });
    });

    expect(queryClient.getQueryState(target)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);

    queryClient.getQueryCache().find({ queryKey: target })?.setState({
      isInvalidated: false,
    });
    act(() => {
      streamClient.session.emitServerFrame({
        kind: "readStateChanged",
        hasBinaryPayload: false,
        ids: ["read-2"],
        entityRefs: [],
        readAt: 2,
        resolvedAt: null,
      });
    });
    expect(queryClient.getQueryState(target)?.isInvalidated).toBe(false);
  });
});
