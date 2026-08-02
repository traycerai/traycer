import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  WsStreamClient,
  type ParamsOf,
  type StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
} from "@traycer/protocol/notifications/notification-entry";
import {
  hostNotificationsSubscribeClientFrameSchema,
  type HostNotificationEntry,
  type HostNotificationsCloudFeedRow,
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
import type { NotificationNavigate } from "@/lib/notifications";
import {
  HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS,
  HOST_STREAM_REOPEN_MAX_BACKOFF_MS,
} from "@/lib/host/stream-reopen";
import type { NotificationShow } from "@/hooks/notifications/use-notifications";

interface HostState {
  id: string | null;
  client: HostClient<HostRpcRegistry> | null;
}

interface StreamState {
  client: WsStreamClient<HostStreamRpcRegistry> | null;
  cloudFeedSupport: StreamMethodSupport | null;
  useClientSupport: boolean;
}

const hostState = vi.hoisted<HostState>(() => ({ id: "host-a", client: null }));
const streamState = vi.hoisted<StreamState>(() => ({
  client: null,
  cloudFeedSupport: null,
  useClientSupport: false,
}));

const mockAuth = {
  onChange: vi.fn((_handler: (status: string) => void) => ({
    dispose: vi.fn(),
  })),
  revalidateCurrentContext: vi.fn(() => Promise.resolve(null)),
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => hostState.client,
  useAuthService: () => mockAuth,
}));

// Feed-mode capability still reads the app-wide stream binding, so this mock
// stays pointed at `stream-runtime-context` even though the provider no longer
// takes its CLIENT from there (see the two hooks mocked below).
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: (method: keyof HostStreamRpcRegistry & string) =>
    streamState.useClientSupport
      ? (streamState.client?.getMethodSupport(method) ?? null)
      : streamState.cloudFeedSupport,
}));

// Per the G8 decision the provider binds to the LOCAL host, not the app-wide
// active one, so these two hooks replace `useReactiveActiveHostId` +
// `useWsStreamClient` as the harness's steering wheel. The `hostState.id` /
// `streamState.client` pair keeps its old meaning: `id === null` means "no
// local host", and assigning a NEW `streamState.client` object is what the
// provider reads as a respawn that must teardown and reopen.
vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: (): HostDirectoryEntry | null =>
    hostState.id === null
      ? null
      : { ...mockLocalHostEntry, hostId: hostState.id },
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: (target: HostDirectoryEntry | null) =>
    target === null ? null : streamState.client,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0) return null;
    return mockLocalHostEntry;
  },
}));

const showNotificationMock = vi.hoisted(() =>
  vi.fn<NotificationShow>(() => Promise.resolve()),
);

vi.mock("@/hooks/notifications/use-notifications", () => ({
  useNotificationShow: () => showNotificationMock,
}));

const activateMock = vi.hoisted(() =>
  vi.fn<
    (input: {
      readonly payload: { readonly kind: string };
      readonly receivedAt: number;
      readonly feedId: string | null;
      readonly onResult: ((outcome: "success" | "failure") => void) | null;
    }) => void
  >(),
);
const notificationNavigateMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve()),
);
const activationHookState = vi.hoisted<{
  navigate: NotificationNavigate | null;
}>(() => ({ navigate: null }));
const markAsReadMock = vi.hoisted(() => vi.fn<(feedId: string) => void>());
const lastHostDisplay = vi.hoisted(() => ({
  originHostId: null as string | null,
  onToastClick: null as
    | ((row: {
        readonly feedId: string;
        readonly payload: { readonly kind: string } | null;
        readonly createdAt: number;
      }) => void)
    | null,
}));

vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivationWithNavigate: (navigate: NotificationNavigate) => {
    activationHookState.navigate = navigate;
    return {
      activate: activateMock,
      pendingFeedId: null,
    };
  },
}));

vi.mock("@/stores/notifications/merged-notifications", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/stores/notifications/merged-notifications")
    >();
  return {
    ...actual,
    useMergedNotificationsActions: () => ({
      markAsRead: markAsReadMock,
      markAllAsRead: vi.fn(),
      // Cloud view-consumption fan-out. These cases never reach it (jsdom
      // reports the document blurred, so the locally-read focus signal stays
      // null), but the provider holds a reference to it - leaving it off the
      // mock would make any future focus stub here a TypeError, not a
      // behaviour change.
      markEntityAsRead: vi.fn(),
      loadMoreHost: vi.fn(),
      canLoadMoreHost: false,
      isLoadingMoreHost: false,
      hasHostLoadError: false,
      loadMoreAttention: vi.fn(),
      canLoadMoreAttention: false,
      isLoadingMoreAttention: false,
      hasAttentionLoadError: false,
      loadMoreUnreadRecent: vi.fn(),
      canLoadMoreUnreadRecent: false,
      isLoadingMoreUnreadRecent: false,
      hasUnreadRecentLoadError: false,
    }),
  };
});

vi.mock("@/lib/notifications/notification-display", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/notifications/notification-display")
    >();
  return {
    ...actual,
    displayHostChannelEmission: (
      _entries: unknown,
      target: {
        readonly onToastClick: (row: {
          readonly feedId: string;
          readonly payload: { readonly kind: string } | null;
          readonly createdAt: number;
        }) => void;
      },
      originHostId: string | null,
    ) => {
      lastHostDisplay.originHostId = originHostId;
      lastHostDisplay.onToastClick = target.onToastClick;
    },
  };
});

import { NotificationsSessionProvider as RoutedNotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { __setNotificationsStreamFactoryForTests } from "@/providers/notifications-stream-factory-override";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  __resetNotificationsStoreForTests,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  emitTerminalCrashedNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

function NotificationsSessionProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RoutedNotificationsSessionProvider navigate={notificationNavigateMock}>
      {props.children}
    </RoutedNotificationsSessionProvider>
  );
}

interface ControlledStream {
  closeCount: number;
}

class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  readonly clientFrames: HostNotificationsSubscribeClientFrame[] = [];
  closeCount = 0;
  requestReconnectCount = 0;

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

  requestReconnect(): void {
    this.requestReconnectCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  emitServerFrame(envelope: StreamFrameEnvelope): void {
    this.serverFrameHandler?.(envelope, null);
  }

  emitBinaryServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array,
  ): void {
    this.serverFrameHandler?.(envelope, binaryPayload);
  }

  emitOpen(): void {
    this.statusChangeHandler?.("open", null);
  }

  emitStatus(status: "connecting" | "open" | "closed" | "reconnecting"): void {
    this.statusChangeHandler?.(status, null);
  }

  emitClosed(reason: StreamCloseReason): void {
    this.statusChangeHandler?.("closed", reason);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly subscribedMethods: string[] = [];
  private readonly sessionsByMethod = new Map<string, MockStreamSession[]>();
  private readonly openedSessions: MockStreamSession[] = [];

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
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
    const session = new MockStreamSession();
    this.subscribedMethods.push(method);
    this.openedSessions.push(session);
    const sessions = this.sessionsByMethod.get(method) ?? [];
    sessions.push(session);
    this.sessionsByMethod.set(method, sessions);
    return session;
  }

  get session(): MockStreamSession {
    const session = this.openedSessions.at(-1);
    if (session === undefined) throw new Error("No stream session is open");
    return session;
  }

  sessionFor(method: keyof HostStreamRpcRegistry & string): MockStreamSession {
    const session = this.sessionsByMethod.get(method)?.at(-1);
    if (session === undefined) {
      throw new Error(`No stream session is open for ${method}`);
    }
    return session;
  }
}

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  userId: string | null,
  email: string | null,
): void {
  if (status === "signed-in" && userId !== null && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId, userName: userId, email },
      contextMetadata: { userId, username: userId },
      // Tier is deliberately irrelevant to feed selection. Most cases in
      // this suite pin the methodless-host fallback configured in beforeEach.
      subscriptionStatus: "FREE",
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

function cloudRow(
  entryId: string,
  createdAt: number,
): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId: "host-a",
    coalesceKey: "agent.stopped:chat-cloud",
    entry: {
      id: entryId,
      updatedAt: createdAt,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: entryId,
      severity: "done",
      outcome: "completed",
      epicId: "epic-cloud",
      chatId: "chat-cloud",
      payload: {
        kind: "chat",
        epicId: "epic-cloud",
        chatId: "chat-cloud",
        taskTitle: "Cloud epic",
        agentName: "Cloud chat",
        outcome: "completed",
      },
    },
    presentation: { epicTitle: "Cloud epic", chatTitle: "Cloud chat" },
  };
}

function fatalClose(code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: `test close: ${code}`,
      incompatibleMethods: null,
      upgradeGuidance: null,
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
    resetAuth("signed-in", "alice@example.com", "alice@example.com");
  });

  await waitFor(() => {
    expect(streamClient.subscribedMethods).toContain(
      "host.notifications.feed.subscribe",
    );
  });
  // Presence is only sent after the stream reports open; the mock does not
  // auto-ack, so drive that transition explicitly.
  act(() => {
    streamClient.session.emitOpen();
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
    streamState.cloudFeedSupport = "unsupported";
    streamState.useClientSupport = false;
    mockAuth.onChange.mockClear();
    mockAuth.revalidateCurrentContext.mockClear();
    showNotificationMock.mockClear();
    mockAuth.onChange.mockImplementation(
      (_handler: (status: string) => void) => ({
        dispose: vi.fn(),
      }),
    );
    activationHookState.navigate = null;
    __resetNotificationsStoreForTests();
    __resetAgentActivityStoreForTests();
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    useAppLocalNotificationsStore.getState().resetForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __setNotificationsStreamFactoryForTests(null);
    resetAuth("signed-out", null, null);
  });

  afterEach(() => {
    cleanup();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    useAppLocalNotificationsStore.getState().resetForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __setNotificationsStreamFactoryForTests(null);
    resetAuth("signed-out", null, null);
    vi.restoreAllMocks();
  });

  it("uses the dedicated host-selected activity stream while cloud relay owns notification rows", async () => {
    const queryClient = new QueryClient();
    const streamClient = new MockWsStreamClient();
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = streamClient;
    streamState.cloudFeedSupport = "supported";
    useAppLocalNotificationsStore
      .getState()
      .activateIdentity("alice@example.com");
    emitTerminalCrashedNotification({
      instanceId: "terminal-before-cloud",
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-1",
        tabId: "tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-before-cloud",
      },
      cause: "exit",
    });
    appendEntry(invitedEntry("global-before-cloud", "epic-1"));

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });

    await waitFor(() => {
      expect(streamClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
      expect(useAppLocalNotificationsStore.getState().orderedIds).toEqual([]);
      expect(useNotificationsStore.getState().entryIds).toEqual([]);
    });

    act(() => {
      streamClient.sessionFor("agent.activity.subscribe").emitServerFrame({
        kind: "state",
        servedBy: "cloud",
        byEpic: {
          "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
        },
        hasBinaryPayload: false,
      });
    });

    expect([
      ...(useAgentActivityStore.getState().byEpic.get("epic-1")?.working ?? []),
    ]).toEqual(["agent-1"]);
    expect(useNotificationsStore.getState().entryIds).toEqual([]);

    act(() => {
      streamClient.sessionFor("agent.activity.subscribe").emitStatus("closed");
    });

    expect(useAgentActivityStore.getState()).toMatchObject({
      connectionStatus: "closed",
      servedBy: null,
    });
    expect(useAgentActivityStore.getState().byEpic).toEqual(new Map());
  });

  it("reopens activity after a recoverable terminal close", async () => {
    const queryClient = new QueryClient();
    const streamClient = new MockWsStreamClient();
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = streamClient;
    streamState.cloudFeedSupport = "supported";

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );
    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });
    await waitFor(() => {
      expect(streamClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        streamClient
          .sessionFor("agent.activity.subscribe")
          .emitClosed(fatalClose("UNAUTHORIZED"));
      });
      expect(mockAuth.revalidateCurrentContext).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(streamClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
        "agent.activity.subscribe",
      ]);
      act(() => {
        streamClient
          .sessionFor("agent.activity.subscribe")
          .emitClosed(fatalClose("INCOMPATIBLE"));
        vi.advanceTimersByTime(2 * HOST_STREAM_REOPEN_MAX_BACKOFF_MS);
      });
      expect(streamClient.subscribedMethods).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns only post-baseline cloud snapshot arrivals into notification displays", async () => {
    const queryClient = new QueryClient();
    const streamClient = new MockWsStreamClient();
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = streamClient;
    streamState.cloudFeedSupport = "supported";

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );
    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });
    await waitFor(() => {
      expect(streamClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
    });

    const baseline = cloudRow("entry-baseline", 7);
    act(() => {
      streamClient.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        connectionState: "connected",
        version: 7,
        rows: [baseline],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      });
    });
    expect(showNotificationMock).not.toHaveBeenCalled();

    const arrived = cloudRow("entry-arrived", 8);
    act(() => {
      streamClient.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        connectionState: "connected",
        version: 8,
        rows: [baseline, arrived],
        summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
      });
    });
    await waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledTimes(1);
    });
    expect(showNotificationMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        feed: { source: "cloud", id: "entry-arrived" },
        originHostId: "host-a",
      },
    });

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        connectionState: "connected",
        version: 8,
        rows: [baseline, arrived],
        summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
      });
    });
    expect(showNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("drops a cloud snapshot across an A to null to A binding cycle", async () => {
    const queryClient = new QueryClient();
    const streamClient = new MockWsStreamClient();
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = streamClient;
    streamState.cloudFeedSupport = "supported";

    const view = render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });
    await waitFor(() => {
      expect(streamClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
    });
    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudRow("entry-a", 7)],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
        version: 7,
      });
      hostState.id = null;
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      const cloud = useCloudNotificationsStore.getState();
      expect(cloud.hasSnapshot).toBe(false);
      expect(cloud.rows).toEqual({});
      expect(cloud.version).toBeNull();
      expect(cloud.connectionState).toBe("unavailable");
    });

    act(() => {
      hostState.id = mockLocalHostEntry.hostId;
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      expect(streamClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
      expect(useCloudNotificationsStore.getState().hasSnapshot).toBe(false);
      expect(useCloudNotificationsStore.getState().connectionState).toBe(
        "unavailable",
      );
    });
  });

  it("drops cloud ownership when the websocket client is replaced", async () => {
    const queryClient = new QueryClient();
    const firstClient = new MockWsStreamClient();
    const replacementClient = new MockWsStreamClient();
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = firstClient;
    streamState.cloudFeedSupport = "supported";

    const view = render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );
    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });
    await waitFor(() => {
      expect(firstClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
    });
    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudRow("entry-a", 7)],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
        version: 7,
      });
      streamState.client = replacementClient;
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      expect(replacementClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
      const cloud = useCloudNotificationsStore.getState();
      expect(cloud.hasSnapshot).toBe(false);
      expect(cloud.rows).toEqual({});
      expect(cloud.version).toBeNull();
      expect(cloud.connectionState).toBe("unavailable");
    });
  });

  it("keeps the dormant entitlement refusal on a stable unavailable wall", async () => {
    const queryClient = new QueryClient();
    const streamClient = new MockWsStreamClient();
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = streamClient;
    streamState.cloudFeedSupport = "supported";
    __setNotificationsStreamFactoryForTests(() => ({
      applyUpdate: () => undefined,
      close: () => undefined,
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );
    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });
    await waitFor(() => {
      expect(streamClient.subscribedMethods).toEqual([
        "agent.activity.subscribe",
        "host.notifications.cloudFeed.subscribe",
      ]);
    });

    act(() => {
      streamClient.session.emitClosed(fatalClose("FREE_TIER_NO_CLOUD_SYNC"));
    });
    await waitFor(() => {
      expect(useAuthStore.getState().subscriptionStatus).toBe("FREE");
      expect(useCloudNotificationsStore.getState().connectionState).toBe(
        "unavailable",
      );
      expect(mockAuth.revalidateCurrentContext).toHaveBeenCalledTimes(1);
      expect(
        streamClient.subscribedMethods.filter(
          (method) => method === "host.notifications.cloudFeed.subscribe",
        ),
      ).toHaveLength(1);
      expect(streamClient.subscribedMethods).not.toContain(
        "host.notifications.feed.subscribe",
      );
    });
  });

  it("keeps retained v1 rows while a rebuilt client's capability is pending offline", async () => {
    const queryClient = new QueryClient();
    const streamClient = new WsStreamClient({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      webSocketFactory: {
        create: () => {
          throw new Error("offline client must not dial");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const subscribeSpy = vi.spyOn(streamClient, "subscribe");
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = streamClient;
    streamState.useClientSupport = true;
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: {
        entries: [
          hostEntry({
            id: "retained-local-row",
            epicId: "epic-local",
            chatId: "chat-local",
            severity: "done",
          }),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 1, attentionCount: 0 },
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );
    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });
    await waitFor(() => {
      expect(subscribeSpy.mock.calls.map(([method]) => method)).toEqual([
        "agent.activity.subscribe",
        "notifications.subscribe",
        "host.notifications.feed.subscribe",
      ]);
    });
    expect(
      useHostNotificationsStore.getState().byId["retained-local-row"],
    ).toBeDefined();
    expect(
      streamClient.getMethodSupport("host.notifications.cloudFeed.subscribe"),
    ).toBe("unknown");
    view.unmount();
    streamClient.close("test-complete");
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
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
      useAppLocalNotificationsStore
        .getState()
        .activateIdentity("alice@example.com");
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
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: {
        entries: [
          hostEntry({
            id: "host-before-user-switch",
            epicId: "epic-alpha",
            chatId: "chat-alpha",
            severity: "done",
          }),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 1, attentionCount: 0 },
    });
    __setAgentActivityStateForTests(
      {
        "epic-alpha": {
          working: ["agent-before-host-switch"],
          turn: ["agent-before-host-switch"],
        },
      },
      "local",
    );
    emitTerminalCrashedNotification({
      instanceId: "terminal-before-user-switch",
      target: {
        kind: "terminal",
        epicId: "epic-alpha",
        terminalId: "chat-alpha",
        tabId: "view-tab",
        paneId: "pane",
        tileInstanceId: "terminal-before-user-switch",
      },
      cause: "exit",
    });

    act(() => {
      resetAuth("signed-in", "bob@example.com", "bob@example.com");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(streams[0].closeCount).toBe(1);
      expect(useNotificationsStore.getState().entries).toEqual([]);
      expect(useHostNotificationsStore.getState().byId).toEqual({});
      expect(
        Object.keys(useAppLocalNotificationsStore.getState().byId),
      ).not.toHaveLength(0);
    });
  });

  it("resets collaboration and host replicas on a same-email different-userId switch", async () => {
    // Two distinct canonical userIds sharing one email: an email-keyed
    // identity comparison would misclassify this as an idle re-render and
    // leave user-a's collaboration/host rows visible to user-b. The provider
    // must key off `contextMetadata.userId`, not `profile.email`.
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
      resetAuth("signed-in", "user-a", "shared@example.com");
      useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });

    act(() => {
      appendEntry(invitedEntry("n-user-a", "epic-alpha"));
    });

    await waitFor(() => {
      expect(useNotificationsStore.getState().entries).toHaveLength(1);
    });
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: {
        entries: [
          hostEntry({
            id: "host-user-a",
            epicId: "epic-alpha",
            chatId: "chat-alpha",
            severity: "done",
          }),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 1, attentionCount: 0 },
    });
    emitTerminalCrashedNotification({
      instanceId: "terminal-user-a",
      target: {
        kind: "terminal",
        epicId: "epic-alpha",
        terminalId: "chat-alpha",
        tabId: "view-tab",
        paneId: "pane",
        tileInstanceId: "terminal-user-a",
      },
      cause: "exit",
    });

    act(() => {
      // Same email as user-a, distinct canonical userId.
      resetAuth("signed-in", "user-b", "shared@example.com");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(streams[0].closeCount).toBe(1);
      expect(useNotificationsStore.getState().entries).toEqual([]);
      expect(useHostNotificationsStore.getState().byId).toEqual({});
      // The provider does not own the app-local bucket: retargeting it by
      // userId is `AppLocalNotificationsPersistLifecycleBridge`'s
      // responsibility (see its own dedicated test file), so this replica
      // must be left untouched by the session provider itself.
      expect(
        Object.keys(useAppLocalNotificationsStore.getState().byId),
      ).not.toHaveLength(0);
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
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
      useAppLocalNotificationsStore
        .getState()
        .activateIdentity("alice@example.com");
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
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: {
        entries: [
          hostEntry({
            id: "host-before-host-switch",
            epicId: "epic-alpha",
            chatId: "chat-alpha",
            severity: "done",
          }),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 1, attentionCount: 0 },
    });
    emitTerminalCrashedNotification({
      instanceId: "terminal-before-host-switch",
      target: {
        kind: "terminal",
        epicId: "epic-alpha",
        terminalId: "chat-alpha",
        tabId: "view-tab",
        paneId: "pane",
        tileInstanceId: "terminal-before-host-switch",
      },
      cause: "exit",
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
      expect(useNotificationsStore.getState().entries).toHaveLength(1);
      expect(useHostNotificationsStore.getState().byId).toEqual({});
      expect(useHostNotificationsStore.getState().summary).toBeNull();
      expect(useAgentActivityStore.getState().servedBy).toBeNull();
      expect(useAgentActivityStore.getState().byEpic).toEqual(new Map());
      expect(
        Object.keys(useAppLocalNotificationsStore.getState().byId),
      ).not.toHaveLength(0);
    });
  });

  it("resets host replica on host switch while preserving collaboration store identity", async () => {
    // Integrated boundary: host A rows+summary+cursors reset to the
    // connecting-to-B empty state, while the global/collaboration store's
    // projected entries keep the same values and object references.
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
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
      useAppLocalNotificationsStore
        .getState()
        .activateIdentity("alice@example.com");
    });
    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });

    act(() => {
      appendEntry(invitedEntry("collab-host-switch", "epic-alpha"));
    });
    await waitFor(() => {
      expect(useNotificationsStore.getState().entries).toHaveLength(1);
    });

    const collabEntriesBefore = useNotificationsStore.getState().entries;
    const collabEntryBefore = collabEntriesBefore[0];
    expect(collabEntryBefore).toBeDefined();
    expect(collabEntryBefore.id).toBe("collab-host-switch");

    useHostNotificationsStore.getState().applySnapshot({
      attention: {
        entries: [
          hostEntry({
            id: "host-a-attention",
            epicId: "epic-alpha",
            chatId: "chat-alpha",
            severity: "needs_action",
          }),
        ],
        nextCursor: {
          kind: "attention",
          tier: "blocking",
          updatedAt: 1,
          id: "host-a-attention",
        },
      },
      recent: {
        entries: [
          hostEntry({
            id: "host-a-recent",
            epicId: "epic-alpha",
            chatId: "chat-alpha",
            severity: "done",
          }),
        ],
        nextCursor: {
          kind: "chronological",
          updatedAt: 1,
          id: "host-a-recent",
        },
      },
      summary: { unreadCount: 2, attentionCount: 1 },
    });
    expect(
      useHostNotificationsStore.getState().byId["host-a-recent"],
    ).toBeDefined();
    expect(useHostNotificationsStore.getState().summary).toEqual({
      unreadCount: 2,
      attentionCount: 1,
    });
    expect(useHostNotificationsStore.getState().attentionCursor).not.toBeNull();
    expect(useHostNotificationsStore.getState().recentCursor).not.toBeNull();

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
      expect(useHostNotificationsStore.getState().byId).toEqual({});
      expect(useHostNotificationsStore.getState().summary).toBeNull();
    });

    // Host-owned tracks reset to the connecting-to-B empty state.
    const hostAfter = useHostNotificationsStore.getState();
    expect(hostAfter.attentionCursor).toBeNull();
    expect(hostAfter.recentCursor).toBeNull();
    expect(hostAfter.attentionStatus).toBe("idle");
    expect(hostAfter.recentStatus).toBe("idle");
    expect(hostAfter.connectionStatus).toBe("connecting");

    // Collaboration/global store completely untouched - same array and
    // entry object references, not a copy or rebuild.
    const collabEntriesAfter = useNotificationsStore.getState().entries;
    expect(collabEntriesAfter).toBe(collabEntriesBefore);
    expect(collabEntriesAfter[0]).toBe(collabEntryBefore);
    expect(collabEntriesAfter).toHaveLength(1);
    expect(collabEntryBefore.id).toBe("collab-host-switch");
  });

  it("drives reconnect/unknown through the full stream → store → bell path", async () => {
    // Real session-provider stream wiring + real NotificationsBell: connect
    // with an exact summary, disconnect to unknown (rows preserved), reconnect
    // with a fresh snapshot and the matching badge.
    useNotificationsPopoverStore.getState().setOpen(false);
    const { streamClient } = await renderHostNotificationsProvider();

    // Mount the real bell alongside the already-open session provider state.
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <NotificationsBell />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const snapshotEntry = hostEntry({
      id: "connected-host-row",
      epicId: "epic-alpha",
      chatId: "chat-alpha",
      severity: "done",
    });
    act(() => {
      streamClient.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [snapshotEntry],
          nextCursor: null,
        },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    await waitFor(() => {
      expect(useHostNotificationsStore.getState().summary).toEqual({
        unreadCount: 1,
        attentionCount: 0,
      });
    });
    expect(
      useHostNotificationsStore.getState().byId["connected-host-row"],
    ).toBeDefined();
    expect(screen.getByTestId("notifications-quiet-dot")).not.toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();

    // (2) Disconnect → summary unknown, rows preserved; unknown renders like clear
    // (no indicator) so the bell stays quiet while status is unresolved.
    act(() => {
      streamClient.session.emitStatus("reconnecting");
    });
    expect(useHostNotificationsStore.getState().summary).toBeNull();
    expect(
      useHostNotificationsStore.getState().byId["connected-host-row"],
    ).toBeDefined();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).not.toBeNull();

    // (3) Reconnect open + fresh atomic snapshot → exact summary + badge.
    act(() => {
      streamClient.session.emitStatus("open");
      streamClient.session.emitServerFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        attention: {
          entries: [
            hostEntry({
              id: "reconnected-prompt",
              epicId: "epic-beta",
              chatId: "chat-beta",
              severity: "needs_action",
            }),
          ],
          nextCursor: null,
        },
        recent: {
          entries: [
            hostEntry({
              id: "reconnected-done",
              epicId: "epic-beta",
              chatId: "chat-beta",
              severity: "done",
            }),
          ],
          nextCursor: null,
        },
        summary: { unreadCount: 2, attentionCount: 1 },
      });
    });

    await waitFor(() => {
      expect(useHostNotificationsStore.getState().summary).toEqual({
        unreadCount: 2,
        attentionCount: 1,
      });
    });
    // Fresh snapshot replaces prior rows.
    expect(
      useHostNotificationsStore.getState().byId["connected-host-row"],
    ).toBeUndefined();
    expect(
      useHostNotificationsStore.getState().byId["reconnected-prompt"],
    ).toBeDefined();
    expect(
      screen.getByTestId("notifications-attention-badge").textContent,
    ).toBe("1");
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, 1 notification needs attention");
  });

  it("preserves all non-host sources and host rows across disconnect and reconnect", async () => {
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
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
      useAppLocalNotificationsStore
        .getState()
        .activateIdentity("alice@example.com");
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => appendEntry(invitedEntry("disconnect-collab", "epic-alpha")));
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: {
        entries: [
          hostEntry({
            id: "disconnect-host",
            epicId: "epic-alpha",
            chatId: "chat-alpha",
            severity: "done",
          }),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 1, attentionCount: 0 },
    });
    emitTerminalCrashedNotification({
      instanceId: "disconnect-system",
      target: {
        kind: "terminal",
        epicId: "epic-alpha",
        terminalId: "chat-alpha",
        tabId: "view-tab",
        paneId: "pane",
        tileInstanceId: "disconnect-system",
      },
      cause: "exit",
    });

    act(() => {
      hostState.id = null;
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      expect(useHostNotificationsStore.getState().summary).toBeNull();
      expect(
        useHostNotificationsStore.getState().byId["disconnect-host"],
      ).toBeDefined();
    });
    expect(useNotificationsStore.getState().entries).toHaveLength(1);
    expect(useAppLocalNotificationsStore.getState().byId).not.toEqual({});

    act(() => {
      hostState.id = "host-a";
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(
      useHostNotificationsStore.getState().byId["disconnect-host"],
    ).toBeDefined();
  });

  it("resets the host replica when a different host appears after an intervening disconnect", async () => {
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
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
      useAppLocalNotificationsStore
        .getState()
        .activateIdentity("alice@example.com");
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: {
        entries: [
          hostEntry({
            id: "host-a-row",
            epicId: "epic-alpha",
            chatId: "chat-alpha",
            severity: "done",
          }),
        ],
        nextCursor: null,
      },
      summary: { unreadCount: 1, attentionCount: 0 },
    });

    act(() => {
      hostState.id = null;
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      expect(useHostNotificationsStore.getState().summary).toBeNull();
    });
    expect(
      useHostNotificationsStore.getState().byId["host-a-row"],
    ).toBeDefined();

    // A different host appears after the disconnect gap: the replica must
    // reset against "host-a" (the ref's last known non-null value), not
    // against the disconnect's transient `null` - otherwise host-a's stale
    // rows would render for one frame as if they belonged to host-b.
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
    });
    expect(useHostNotificationsStore.getState().byId).toEqual({});
    expect(useHostNotificationsStore.getState().summary).toBeNull();
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
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });

    await waitFor(() => {
      expect(firstClient.subscribedMethods).toContain(
        "host.notifications.feed.subscribe",
      );
    });
    act(() => {
      firstClient.session.emitOpen();
    });
    await waitFor(() => {
      expect(firstClient.session.clientFrames).toHaveLength(1);
    });
    expect([...firstClient.subscribedMethods].sort()).toEqual([
      "agent.activity.subscribe",
      "host.notifications.feed.subscribe",
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
      expect(secondClient.subscribedMethods).toContain(
        "host.notifications.feed.subscribe",
      );
    });
    act(() => {
      secondClient.session.emitOpen();
    });
    await waitFor(() => {
      expect(secondClient.session.clientFrames).toHaveLength(1);
    });
    expect([...secondClient.subscribedMethods].sort()).toEqual([
      "agent.activity.subscribe",
      "host.notifications.feed.subscribe",
      "notifications.subscribe",
    ]);
    expect(firstClient.sessionFor("notifications.subscribe").closeCount).toBe(
      1,
    );
    expect(firstClient.sessionFor("agent.activity.subscribe").closeCount).toBe(
      1,
    );
    expect(
      firstClient.sessionFor("host.notifications.feed.subscribe").closeCount,
    ).toBe(1);
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
        removedIds: [],
        summary: { unreadCount: 1, attentionCount: 0 },
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
        removedIds: [],
        summary: { unreadCount: 1, attentionCount: 0 },
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
        removedIds: [],
        summary: { unreadCount: 0, attentionCount: 0 },
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
        removedIds: [],
        summary: { unreadCount: 1, attentionCount: 1 },
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
        removedIds: [],
        summary: { unreadCount: 1, attentionCount: 0 },
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
        removedIds: [],
        summary: { unreadCount: 1, attentionCount: 0 },
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
        removedIds: [],
        summary: { unreadCount: 1, attentionCount: 0 },
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
        target: {
          kind: "terminal",
          epicId: "epic-a",
          terminalId: "terminal-a",
          tabId: "view-tab",
          paneId: "pane",
          tileInstanceId: "terminal-a-instance",
        },
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
        target: {
          kind: "terminal",
          epicId: "epic-a",
          terminalId: "terminal-b",
          tabId: "view-tab",
          paneId: "pane",
          tileInstanceId: "terminal-b-instance",
        },
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
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [
            hostEntry({
              id: "done-after-reconnect",
              epicId: "epic-a",
              chatId: "chat-a",
              severity: "done",
            }),
          ],
          nextCursor: null,
        },
        summary: { unreadCount: 1, attentionCount: 0 },
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
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 0, attentionCount: 0 },
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
        removedIds: [],
        summary: { unreadCount: 0, attentionCount: 0 },
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
        removedIds: [],
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });
    expect(queryClient.getQueryState(target)?.isInvalidated).toBe(false);
  });

  it("fully invalidates indicators for an upsert frame carrying removals", async () => {
    const { queryClient, streamClient } =
      await renderHostNotificationsProvider();
    const target = indicatorKey("epic-a", "chat-a");
    const other = indicatorKey("epic-b", "chat-b");
    queryClient.setQueryData(target, { epics: {}, chats: {} });
    queryClient.setQueryData(other, { epics: {}, chats: {} });

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "upserted",
        hasBinaryPayload: false,
        entry: hostEntry({
          id: "surviving-upsert",
          epicId: "epic-a",
          chatId: "chat-a",
          severity: "done",
        }),
        removedIds: ["unrelated-removed"],
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    expect(queryClient.getQueryState(target)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(true);
  });

  it("fully invalidates indicators for a read-state frame carrying removals", async () => {
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
        removedIds: ["unrelated-removed"],
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });

    expect(queryClient.getQueryState(target)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(true);
  });

  it("invalidates all indicator queries on a removed frame", async () => {
    const { queryClient, streamClient } =
      await renderHostNotificationsProvider();
    const key = indicatorKey("epic-a", "chat-a");
    queryClient.setQueryData(key, { epics: {}, chats: {} });

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "removed",
        hasBinaryPayload: false,
        removedIds: ["gone-1"],
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("wires host-channel toast clicks through success-only mark-read with stream origin host", async () => {
    activateMock.mockReset();
    markAsReadMock.mockReset();
    lastHostDisplay.originHostId = null;
    lastHostDisplay.onToastClick = null;
    const trackSpy = vi.spyOn(
      (await import("@/lib/analytics")).Analytics.getInstance(),
      "track",
    );
    const { AnalyticsEvent } = await import("@/lib/analytics");

    const { streamClient } = await renderHostNotificationsProvider();
    expect(activationHookState.navigate).toBe(notificationNavigateMock);

    act(() => {
      streamClient.session.emitServerFrame({
        kind: "channelEmission",
        hasBinaryPayload: false,
        emissionId: "emission-toast-1",
        channelId: "renderer",
        severity: "done",
        rows: [
          hostEntry({
            id: "toast-row",
            epicId: "epic-a",
            chatId: "chat-a",
            severity: "done",
          }),
        ],
        reason: "new",
      });
    });

    await waitFor(() => {
      expect(lastHostDisplay.originHostId).toBe(mockLocalHostEntry.hostId);
    });
    expect(lastHostDisplay.onToastClick).toEqual(expect.any(Function));

    const row = {
      feedId: "host:toast-row",
      source: "host" as const,
      sourceId: "toast-row",
      createdAt: 1,
      readAt: null,
      title: "Agent finished",
      body: "done",
      payload: {
        kind: "chat" as const,
        epicId: "epic-a",
        chatId: "chat-a",
      },
      hostKind: "agent.stopped" as const,
      severity: "done" as const,
      resolvedAt: null,
      category: "task" as const,
    };

    act(() => {
      lastHostDisplay.onToastClick?.(row);
    });

    expect(activateMock).toHaveBeenCalledTimes(1);
    const activateCall = activateMock.mock.calls[0][0];
    expect(activateCall).toMatchObject({
      payload: row.payload,
      receivedAt: 1,
      feedId: "host:toast-row",
    });
    expect(typeof activateCall.onResult).toBe("function");
    expect(markAsReadMock).not.toHaveBeenCalled();

    const onResult = activateCall.onResult;
    if (onResult === null) {
      throw new Error("expected onResult callback");
    }
    act(() => {
      onResult("failure");
    });
    expect(markAsReadMock).not.toHaveBeenCalled();
    expect(
      trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
      ),
    ).toEqual([
      [
        AnalyticsEvent.NotificationActivationCompleted,
        {
          category: "task",
          section: "recent",
          surface: "toast",
          outcome: "failure",
        },
      ],
    ]);
    expect(
      trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
      ),
    ).toHaveLength(0);

    act(() => {
      onResult("success");
    });
    expect(markAsReadMock).toHaveBeenCalledTimes(1);
    expect(markAsReadMock).toHaveBeenCalledWith("host:toast-row");
    expect(
      trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
      ),
    ).toHaveLength(2);
    expect(
      trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
      ),
    ).toEqual([
      [
        AnalyticsEvent.NotificationMarkedRead,
        {
          category: "task",
          acknowledgment_source: "activation",
        },
      ],
    ]);
    trackSpy.mockRestore();
  });

  // ---------------------------------------------------------------------
  // G8: notifications bind to the LOCAL host, not the app-wide active one.
  // ---------------------------------------------------------------------

  it("does not reopen the stream on a re-render when the local host is unchanged (proxy for an active-host switch elsewhere in the app)", async () => {
    const queryClient = new QueryClient();
    const streamClient = new MockWsStreamClient();
    hostState.id = mockLocalHostEntry.hostId;
    streamState.client = streamClient;

    const view = render(
      <QueryClientProvider client={queryClient}>
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });

    await waitFor(() => {
      expect(streamClient.subscribedMethods).toContain(
        "notifications.subscribe",
      );
    });
    const openedSessions = streamClient.subscribedMethods.length;

    // This provider has no dependency on the app-wide active host, so a
    // re-render triggered by an active-host switch elsewhere in the tree is
    // indistinguishable, from here, from any other unrelated re-render: the
    // local host entry (and therefore the resolved stream client) stays the
    // same object, and the stream must not be torn down or reopened.
    act(() => {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <NotificationsSessionProvider>
            <div />
          </NotificationsSessionProvider>
        </QueryClientProvider>,
      );
    });

    expect(streamClient.subscribedMethods.length).toBe(openedSessions);
    expect(streamClient.sessionFor("notifications.subscribe").closeCount).toBe(
      0,
    );
  });

  // Synchronous by design: the assertion is that NOTHING opens, and awaiting
  // a `waitFor` for an absence would pass just as well if the stream simply
  // had not opened yet.
  it("mounts cleanly with no stream opened when there is no local host (browser/mobile shells)", () => {
    const queryClient = new QueryClient();
    // No local host at all - `useReactiveLocalHostEntry` yields null, so
    // `useHostStreamClientFor` has nothing to build a transport against.
    hostState.id = null;
    streamState.client = null;
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
          <div data-testid="child" />
        </NotificationsSessionProvider>
      </QueryClientProvider>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com", "alice@example.com");
    });

    expect(view.getByTestId("child")).not.toBeNull();
    expect(streams).toHaveLength(0);
    expect(useNotificationsStore.getState().entries).toEqual([]);
  });
});
