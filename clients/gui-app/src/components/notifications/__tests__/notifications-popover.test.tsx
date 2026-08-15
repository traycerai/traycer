import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import {
  __resetAppLocalNotificationsStoreForTests,
  emitTerminalCrashedNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import {
  type NotificationEntry,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import {
  type NotificationRoomEntryMap,
  NOTIFICATIONS_ARRAY_KEY,
  createNotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import type {
  HostNotificationEntry,
  HostNotificationsCloudFeedRow,
} from "@traycer/protocol/host/notifications/contracts";
import { ALL_NOTIFICATION_CATEGORIES } from "@/lib/notifications/notification-category";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toast } from "sonner";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";

const hostRequestMock = vi.hoisted(() => vi.fn());

const hostBindingState = vi.hoisted(() => ({
  current: null as {
    readonly hostClient: {
      readonly request: typeof hostRequestMock;
      readonly getActiveHostId: () => string | null;
    };
    readonly directory?: {
      readonly findById: (hostId: string) => typeof mockLocalHostEntry | null;
      readonly selectById: (hostId: string) => void;
      readonly getLocalEntry: () => typeof mockLocalHostEntry | null;
      readonly onChange: (listener: () => void) => { dispose: () => void };
    };
  } | null,
}));

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

const notificationFeedMode = vi.hoisted<{ value: "local" | "cloud" }>(() => ({
  value: "local",
}));

const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingState.current,
  };
});

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => activeHostIdRef.value,
}));

vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: (hostId: string) => {
      if (hostId.length === 0 || directoryRef.value === null) return null;
      return directoryRef.value.findById(hostId);
    },
  };
});

vi.mock("@/lib/notifications/notification-feed-mode", () => ({
  useNotificationFeedMode: () => notificationFeedMode.value,
}));

/**
 * Controllable ready-session evidence, the same seam
 * `use-host-reachability.composition.test.tsx` uses. `originRefusal` asks the
 * shared `isConfirmedTransportRefusal` gate, whose ready-session override must
 * keep an approval actionable when this client holds a live session to a
 * cloud-`offline` origin. Partial (spread-actual) so every other export stays
 * real.
 */
const readySessionHosts = vi.hoisted(() => ({ value: new Set<string>() }));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        readySessionHosts.value.has(hostId),
    };
  },
);

vi.mock("@/lib/host-error-toast", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host-error-toast")>();
  return {
    ...actual,
    toastFromHostError: vi.fn(actual.toastFromHostError),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const TASK_TITLE = "Checkout notification title and hover behavior";
const DAY_MS = 86_400_000;

function seedEntries(
  callbacks: NotificationsStreamCallbacks,
  entries: ReadonlyArray<NotificationEntry>,
): void {
  const donor = new Y.Doc();
  const arr = donor.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  donor.transact(() => {
    for (const entry of entries) {
      arr.push([createNotificationRoomEntryMap(entry)]);
    }
  });
  callbacks.onSnapshot({ schemaVersion: "2" }, Y.encodeStateAsUpdate(donor));
}

interface TargetCapture {
  epicId: string | null;
  tabId: string | null;
  focusArtifactId: string | null;
  focusThreadId: string | null;
}

function PopoverShell(props: { readonly onNavigate: () => void }): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <NotificationsPopover
      onNavigate={props.onNavigate}
      headingRef={headingRef}
      shellRef={shellRef}
      shellStyle={{}}
      onFilterMenuOpenChange={() => undefined}
    />
  );
}

function buildRouterWithCapture(target: TargetCapture, onNavigate: () => void) {
  // Keep the center mounted across in-app navigation the way the real app
  // shell does: routeNotification may change the route while the center is
  // still open; the shell itself must stay mounted until onNavigate closes it.
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <PopoverShell onNavigate={onNavigate} />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "epics/$epicId/$tabId",
    validateSearch: (search: Record<string, unknown>) => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
      focusArtifactId:
        typeof search.focusArtifactId === "string"
          ? search.focusArtifactId
          : undefined,
      focusThreadId:
        typeof search.focusThreadId === "string"
          ? search.focusThreadId
          : undefined,
    }),
    component: function EpicCaptureRouteComponent() {
      const location = useRouterState({ select: (state) => state.location });
      const parts = location.pathname.split("/");
      const epicId = parts[2];
      const tabId = parts[3];
      target.epicId = epicId.length > 0 ? epicId : null;
      target.tabId = tabId.length > 0 ? tabId : null;
      target.focusArtifactId =
        typeof location.search.focusArtifactId === "string"
          ? location.search.focusArtifactId
          : null;
      target.focusThreadId =
        typeof location.search.focusThreadId === "string"
          ? location.search.focusThreadId
          : null;
      return <div data-testid="epic-route">epic:{epicId}</div>;
    },
  });
  const routeTree = rootRoute.addChildren([indexRoute, epicRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderRouter(router: AnyRouter): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function hostAgentEntry(input: {
  readonly id: string;
  readonly kind: "agent.stopped" | "agent.stalled";
  readonly severity: "failure" | "done";
  readonly outcome: "completed" | "stopped" | "errored" | null;
  readonly updatedAt: number | null;
  readonly readAt: number | null;
}): HostNotificationEntry {
  const updatedAt = input.updatedAt ?? (input.id === "failed" ? 20 : 10);
  if (input.kind === "agent.stopped") {
    return {
      id: input.id,
      updatedAt,
      readAt: input.readAt,
      kind: "agent.stopped",
      sourceRef: input.id,
      severity: input.severity,
      outcome: input.outcome ?? "completed",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Agent",
        taskTitle: TASK_TITLE,
        outcome: input.outcome ?? "completed",
      },
    };
  }
  return {
    id: input.id,
    updatedAt,
    readAt: input.readAt,
    kind: "agent.stalled",
    sourceRef: input.id,
    severity: input.severity,
    outcome: "errored",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "agent_stalled",
      epicId: "epic-1",
      chatId: "chat-1",
      agentId: "chat-1",
      agentName: "Agent",
      taskTitle: TASK_TITLE,
      reason: "provider_buffering",
      title: "Provider is buffering",
      outcome: "errored",
    },
  };
}

function hostPrompt(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "approval.requested",
    sourceRef: id,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: TASK_TITLE,
      approvalId: id,
    },
  };
}

function hostFailure(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return hostAgentEntry({
    id,
    kind: "agent.stopped",
    severity: "failure",
    outcome: "errored",
    updatedAt,
    readAt,
  });
}

function hostDone(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return hostAgentEntry({
    id,
    kind: "agent.stopped",
    severity: "done",
    outcome: "completed",
    updatedAt,
    readAt,
  });
}

function cloudDone(
  entryId: string,
  readAt: number | null,
): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId: mockLocalHostEntry.hostId,
    coalesceKey: "agent.stopped:chat-cloud",
    entry: {
      id: entryId,
      updatedAt: 200,
      readAt,
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
        agentName: "Cloud agent",
        taskTitle: "Cloud task",
        outcome: "completed",
      },
    },
    presentation: { epicTitle: "Cloud task", chatTitle: "Cloud agent" },
  };
}

/**
 * A REAL projected remote origin entry (the directory service's own mapper),
 * cloud-`offline` with the given `lastSeenAt` deciding the relay-fuse
 * recovery-dial window at projection time.
 */
function offlineRemoteOrigin(
  hostId: string,
  lastSeenAt: string,
): RemoteHostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    {
      hostId,
      displayName: `label-${hostId}`,
      platform: "Ubuntu",
      kind: "personal",
      publicKey: `pk-${hostId}`,
      createdAt: "2026-07-01T12:00:00.000Z",
      status: {
        connectivity: "offline",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.4.2",
        lastSeenAt,
      },
      updatePolicy: "manual",
    },
    "wss://relay.example.test/attach",
  );
}

/** A `lastSeenAt` far past the relay-fuse cap - no recovery-dial window. */
const STALE_ORIGIN_LAST_SEEN = "2026-07-03T11:59:50.000Z";

function cloudApproval(
  entryId: string,
  originHostId: string,
): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId,
    coalesceKey: `approval.requested:${entryId}`,
    entry: hostPrompt(entryId, 300, null),
    presentation: {
      epicTitle: "Cloud epic",
      chatTitle: "Deploy checkout fix",
    },
  };
}

/** Routes origin lookups at the given remote entry, local lookups as usual. */
function bindOriginDirectory(origin: RemoteHostDirectoryEntry): void {
  directoryRef.value = {
    findById: (hostId) => {
      if (hostId === origin.hostId) return origin;
      return hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null;
    },
  };
}

function threadEntry(
  id: string,
  epicId: string,
  artifactId: string,
  threadId: string,
): NotificationEntry {
  return threadEntryWithState({
    id,
    epicId,
    artifactId,
    threadId,
    createdAt: 1,
    readAt: null,
  });
}

interface ThreadEntryState {
  readonly id: string;
  readonly epicId: string;
  readonly artifactId: string;
  readonly threadId: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}

function threadEntryWithState(state: ThreadEntryState): NotificationEntry {
  return {
    id: state.id,
    createdAt: state.createdAt,
    readAt: state.readAt,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.COMMENT_ADDED,
      epicId: state.epicId,
      artifactId: state.artifactId,
      artifactType: "ticket",
      threadId: state.threadId,
      actorName: "Alice",
    },
  };
}

function applyHostSnapshot(
  entries: ReadonlyArray<HostNotificationEntry>,
  summary: { readonly unreadCount: number; readonly attentionCount: number },
): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: {
      entries: entries.filter(
        (entry) =>
          entry.readAt === null &&
          (entry.severity === "needs_action" || entry.severity === "failure"),
      ),
      nextCursor: null,
    },
    recent: { entries, nextCursor: null },
    summary,
  });
}

function notificationIds(rows: ReadonlyArray<HTMLElement>) {
  return rows.map((row) => row.dataset.notificationId);
}

function resetPopoverFilters(): void {
  useNotificationsPopoverStore.setState({
    open: false,
    unreadOnly: false,
    categories: ALL_NOTIFICATION_CATEGORIES,
    originUnavailable: false,
    originUnavailableHostLabel: null,
  });
}

function bindHostClient(): void {
  hostBindingState.current = {
    hostClient: {
      request: hostRequestMock,
      getActiveHostId: () => mockLocalHostEntry.hostId,
    },
    directory: {
      findById: (hostId: string) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      selectById: () => {},
      // Locality (D7) reads the local entry through useReactiveLocalHostEntry;
      // keep this mock honest for the desktop shell under test.
      getLocalEntry: () => mockLocalHostEntry,
      onChange: () => ({ dispose: () => {} }),
    },
  };
}

/** Faithful DISCONNECT: runtime binding retained (`client !== null`) while
 * the active host id is null on both the reactive signal and
 * `client.getActiveHostId()`, and the exact summary goes unknown. Call after
 * `applyHostSnapshot` so `byId` rows stay rendered. */
function simulateHostDisconnect(): void {
  activeHostIdRef.value = null;
  hostBindingState.current = {
    hostClient: {
      request: hostRequestMock,
      getActiveHostId: () => null,
    },
  };
  useHostNotificationsStore.getState().markSummaryUnknown();
}

function markAllReadButton(): HTMLButtonElement {
  const button = screen.getByTestId("notifications-mark-all-read");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected mark-all button");
  }
  return button;
}

function seedUnreadAppLocal(id: string): void {
  useAppLocalNotificationsStore.getState().activateIdentity("user-popover");
  useAppLocalNotificationsStore.getState().upsert({
    id,
    updatedAt: 50,
    readAt: null,
    kind: "stream.transport.error",
    sourceRef: id,
    payload: null,
    message: "Worktree failed",
    detail: null,
  });
}

function defaultHostRequest(method: string): Promise<unknown> {
  if (method === "host.notifications.markRead") {
    return Promise.resolve({ ok: true });
  }
  if (method === "host.notifications.markAllRead") {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve({});
}

function activateButtonFor(row: HTMLElement): HTMLButtonElement {
  // Role query scoped to the row (testing guideline): the navigable body is
  // the row's first button in document order; the trailing mark-read tick is
  // its later sibling, never nested inside it.
  const button = within(row).getAllByRole("button")[0];
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("activate button not found");
  }
  return button;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function markAllReadCallParams(): { readonly beforeUpdatedAt: number } {
  const call = hostRequestMock.mock.calls.find(
    (entry) => entry[0] === "host.notifications.markAllRead",
  );
  const params: unknown = call === undefined ? undefined : call[1];
  if (!isRecord(params)) {
    throw new Error("expected host.notifications.markAllRead params");
  }
  const beforeUpdatedAt = params["beforeUpdatedAt"];
  if (typeof beforeUpdatedAt !== "number") {
    throw new Error("expected host.notifications.markAllRead params");
  }
  return { beforeUpdatedAt };
}

describe("NotificationsPopover", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    hostRequestMock.mockReset();
    hostRequestMock.mockImplementation(defaultHostRequest);
    hostBindingState.current = null;
    vi.mocked(toastFromHostError).mockClear();
    vi.mocked(toast.error).mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    notificationFeedMode.value = "local";
    resetPopoverFilters();
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    __resetTabNavigationControllerForTesting();
    hostBindingState.current = null;
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    notificationFeedMode.value = "local";
    readySessionHosts.value.clear();
  });

  it("shows loading instead of caught up before the first cloud snapshot", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().setConnectionState("connecting");
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);

    renderRouter(router);

    const status = await screen.findByTestId("notifications-feed-status");
    expect(status.textContent).toContain("Loading notifications");
    expect(status.textContent).toContain("Fetching your notification history.");
    expect(
      screen.getByTestId("notifications-feed-status-spinner"),
    ).toBeDefined();
    expect(screen.queryByText("You're all caught up")).toBeNull();
  });

  it("shows unavailable instead of caught up when cloud bootstrap fails", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().setConnectionState("unavailable");
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);

    renderRouter(router);

    const status = await screen.findByTestId("notifications-feed-status");
    expect(status.textContent).toContain("Notifications unavailable");
    expect(status.textContent).toContain("We’ll keep trying to reconnect.");
    expect(
      screen.queryByTestId("notifications-feed-status-spinner"),
    ).toBeNull();
    expect(screen.queryByText("You're all caught up")).toBeNull();
  });

  it("shows reconnecting instead of caught up when an empty cloud snapshot becomes stale", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 1,
    });
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);

    renderRouter(router);

    const status = await screen.findByTestId("notifications-feed-status");
    expect(status.textContent).toContain("Reconnecting to notifications");
    expect(status.textContent).toContain(
      "Refreshing your notification history.",
    );
    expect(
      screen.getByTestId("notifications-feed-status-spinner"),
    ).toBeDefined();
    expect(screen.queryByText("You're all caught up")).toBeNull();
  });

  it("keeps the last cloud snapshot visible while showing reconnecting", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-cloud", null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 1,
    });
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);

    renderRouter(router);

    expect(await screen.findByTestId("notification-entry")).toBeDefined();
    const status = screen.getByTestId("notifications-feed-status");
    expect(status.textContent).toContain("Reconnecting to notifications");
  });

  it("shows caught up only after an authoritative empty cloud snapshot", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 1,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);

    renderRouter(router);

    const empty = await screen.findByTestId("notifications-empty");
    expect(empty.textContent).toContain("You're all caught up");
    expect(screen.queryByTestId("notifications-feed-status")).toBeNull();
  });

  it("routes a cloud row through its activation button to the owning chat", async () => {
    notificationFeedMode.value = "cloud";
    bindHostClient();
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-cloud", null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 1,
    });
    const onNavigate = vi.fn();
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationId).toBe("cloud:entry-cloud");
    const activationButton = activateButtonFor(row);
    expect(activationButton.disabled).toBe(false);
    fireEvent.click(activationButton);

    await waitFor(() => {
      expect(captured.epicId).toBe("epic-cloud");
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });
    expect(hostRequestMock).toHaveBeenCalledWith(
      "host.notifications.cloudFeed.markRead",
      { entryId: "entry-cloud" },
    );
  });

  it("keeps an approval actionable when its cloud-offline origin has a READY live session in this client", async () => {
    // The registry says `offline` (stale lastSeenAt - not even a fuse
    // window), but THIS client holds a ready E2E session to the origin:
    // firsthand proof the route works, which `isConfirmedTransportRefusal`
    // lets outrank the cloud verdict everywhere else (`useHostReachability`,
    // `dialableHostEndpoint` - the exact gate activation dials through).
    // Reading the raw verdict here instead removed the activation button
    // from a route that works.
    notificationFeedMode.value = "cloud";
    bindHostClient();
    const origin = offlineRemoteOrigin(
      "remote-origin-live",
      STALE_ORIGIN_LAST_SEEN,
    );
    bindOriginDirectory(origin);
    readySessionHosts.value.add(origin.hostId);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudApproval("entry-approval-live", origin.hostId)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
      version: 1,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationOriginState).toBe("available");
    expect(
      within(row).queryByText("The originating host is unavailable."),
    ).toBeNull();
    // The primary control is the navigable body button, not a dead div.
    expect(
      within(row).getByRole("button", { name: /Deploy checkout fix/ }),
    ).toBe(activateButtonFor(row));
    expect(activateButtonFor(row).disabled).toBe(false);
  });

  it("still refuses the same cloud-offline origin when NO ready session exists", async () => {
    // The counterpart leg: absent firsthand session evidence (and past the
    // relay-fuse window), the confirmed `offline` refusal still disables the
    // action - guards against the override making every origin look alive.
    notificationFeedMode.value = "cloud";
    bindHostClient();
    const origin = offlineRemoteOrigin(
      "remote-origin-dead",
      STALE_ORIGIN_LAST_SEEN,
    );
    bindOriginDirectory(origin);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudApproval("entry-approval-dead", origin.hostId)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
      version: 1,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationOriginState).toBe("unavailable");
    // A refused origin renders no navigable body button - the body is inert.
    expect(
      within(row).queryByRole("button", { name: /Deploy checkout fix/ }),
    ).toBeNull();
    expect(
      within(row).getByText("The originating host is unavailable."),
    ).not.toBeNull();
  });

  it("keeps a fuse-window offline origin actionable (the recovery dial the activation path would attempt)", async () => {
    // Inside the relay-fuse window `isConfirmedTransportRefusal` permits the
    // recovery dial, so `dialableHostEndpoint` routes the activation; a row
    // that greyed itself out from the raw verdict refused an action the
    // transport would have attempted (and which fails recoverably if the
    // host really is dead).
    notificationFeedMode.value = "cloud";
    bindHostClient();
    const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
    const origin = offlineRemoteOrigin("remote-origin-fuse", recentLastSeen);
    bindOriginDirectory(origin);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudApproval("entry-approval-fuse", origin.hostId)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
      version: 1,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationOriginState).toBe("available");
    expect(
      within(row).queryByText("The originating host is unavailable."),
    ).toBeNull();
    expect(
      within(row).getByRole("button", { name: /Deploy checkout fix/ }),
    ).toBe(activateButtonFor(row));
    expect(activateButtonFor(row).disabled).toBe(false);
  });

  it("shows and opens the exact renderer-local terminal failure in cloud mode", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 1,
    });
    useAppLocalNotificationsStore.getState().activateIdentity("user-popover");
    const canvasStore = useEpicCanvasStore.getState();
    const tabId = canvasStore.openEpicTab("epic-terminal", "Terminal epic");
    canvasStore.openTileInTab(tabId, {
      id: "terminal-build",
      instanceId: "terminal-build-instance",
      type: "terminal",
      name: "Build terminal",
      titleSource: "manual",
      hostId: mockLocalHostEntry.hostId,
      cwd: "/repo",
    });
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined || canvas.activePaneId === null) {
      throw new Error("expected terminal canvas");
    }
    emitTerminalCrashedNotification({
      instanceId: "terminal-build-instance",
      hostId: mockLocalHostEntry.hostId,
      terminalName: "Build terminal",
      target: {
        kind: "terminal",
        epicId: "epic-terminal",
        terminalId: "terminal-build",
        tabId,
        paneId: canvas.activePaneId,
        tileInstanceId: "terminal-build-instance",
      },
      cause: "exit",
    });
    const onNavigate = vi.fn();
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    expect(
      await screen.findByText("Build terminal exited unexpectedly."),
    ).toBeDefined();
    const row = screen.getByTestId("notification-entry");
    expect(row.dataset.notificationId).toMatch(/^app-local:terminal\.crashed:/);
    fireEvent.click(activateButtonFor(row));

    await waitFor(() => {
      expect(captured).toMatchObject({ epicId: "epic-terminal", tabId });
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(useAppLocalNotificationsStore.getState().unreadCount).toBe(0);
    });
  });

  it("clears renderer-local failures while the cloud feed is reconnecting", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [],
      summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
      version: 1,
    });
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    seedUnreadAppLocal("terminal-reconnecting");
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const markAll = await screen.findByTestId<HTMLButtonElement>(
      "notifications-mark-all-read",
    );
    expect(markAll.disabled).toBe(false);
    expect(
      screen.getByTestId<HTMLButtonElement>("notifications-clear-all").disabled,
    ).toBe(true);
    fireEvent.click(markAll);

    await waitFor(() => {
      expect(useAppLocalNotificationsStore.getState().unreadCount).toBe(0);
    });
    expect(hostRequestMock).not.toHaveBeenCalledWith(
      "host.notifications.cloudFeed.markAllRead",
      expect.anything(),
    );
  });

  it("does not render a trailing tick for an already-read cloud row", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-cloud-read", 100)],
      summary: { totalCount: 1, unreadCount: 0, attentionCount: 0 },
      version: 1,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationRead).toBe("true");
    expect(
      within(row).queryByRole("button", { name: "Mark as read" }),
    ).toBeNull();
    expect(within(row).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Clear" })).toBeNull();
    expect(within(row).queryByTestId("notification-unread-rail")).toBeNull();
  });

  it("does not render a row-level Clear action for an unread cloud row", async () => {
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-cloud-unread", null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 1,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationRead).toBe("false");
    expect(within(row).queryByRole("button", { name: "Clear" })).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Mark as read" }),
    ).not.toBeNull();
  });

  it("requires confirmation before clearing the cloud feed", async () => {
    notificationFeedMode.value = "cloud";
    bindHostClient();
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-cloud", null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 1,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    fireEvent.click(await screen.findByTestId("notifications-clear-all"));
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeDefined();
    expect(hostRequestMock).not.toHaveBeenCalledWith(
      "host.notifications.cloudFeed.clearAll",
      expect.anything(),
    );

    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(hostRequestMock).not.toHaveBeenCalledWith(
      "host.notifications.cloudFeed.clearAll",
      expect.anything(),
    );

    fireEvent.click(screen.getByTestId("notifications-clear-all"));
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.clearAll",
        { observedVersion: 1 },
      );
    });
  });

  it("renders a relative timestamp on every notification row", async () => {
    const twoMinutesAgo = Date.now() - 150_000;
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);

    openNotificationsStream((callbacks) => {
      act(() => {
        seedEntries(callbacks, [
          {
            id: "ts-row",
            createdAt: twoMinutesAgo,
            readAt: null,
            event: {
              kind: NOTIFICATION_EVENT_TYPES.INVITED,
              epicId: "epic-alpha",
              actorName: "Alice",
            },
          },
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    renderRouter(router);

    const timestamp = await screen.findByTestId("notification-timestamp");
    expect(timestamp.textContent).toBe("2m ago");
  });

  it("renders Attention before Recent and omits Attention when empty", async () => {
    applyHostSnapshot(
      [hostPrompt("prompt", 100, null), hostDone("done", 90, null)],
      {
        unreadCount: 2,
        attentionCount: 1,
      },
    );
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const shell = await screen.findByTestId("notifications-popover");
    const text = shell.textContent || "";
    expect(text.indexOf("Needs attention")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Recent activity")).toBeGreaterThan(
      text.indexOf("Needs attention"),
    );
    expect(
      notificationIds(screen.getAllByTestId("notification-entry")),
    ).toEqual(["host:prompt", "host:done"]);

    act(() => {
      applyHostSnapshot([hostDone("done", 90, null)], {
        unreadCount: 1,
        attentionCount: 0,
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Needs attention")).toBeNull();
    });
    expect(screen.getByText("Recent activity")).not.toBeNull();
    expect(
      notificationIds(screen.getAllByTestId("notification-entry")),
    ).toEqual(["host:done"]);
  });

  it("uses flat non-card row classes with hover/focus-visible row tint", async () => {
    applyHostSnapshot([hostDone("done", 10, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.className).not.toContain("rounded-2xl");
    expect(row.className).not.toMatch(/bg-accent\/55|bg-muted\/35/);
    expect(row.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        // Foreground-alpha, not `bg-muted/70`: these rows render on the
        // notifications popover, whose surface IS `--muted`'s value in every
        // preset dark theme, so a muted tint left the hover/focus states
        // invisible there.
        "hover:bg-foreground/6",
        "has-[:focus-visible]:bg-foreground/6",
        "py-2.5",
        "pl-6",
        "pr-4",
      ]),
    );
    // Unread rows prepend an absolute rail span; the glyph holder is the
    // permanent size-6 box, not necessarily the first child.
    const glyph = Array.from(row.querySelectorAll("span")).find((span) =>
      span.className.split(/\s+/).includes("size-6"),
    );
    expect(glyph?.className).toContain("size-6");
    expect(glyph?.className).not.toMatch(/bg-|rounded-2xl/);
  });

  it("renders non-navigable unread rows with one acknowledge control that disappears once read", async () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    useAppLocalNotificationsStore.getState().upsert({
      id: "local-1",
      updatedAt: 50,
      readAt: null,
      kind: "stream.transport.error",
      sourceRef: "local-1",
      payload: null,
      message: "Worktree failed",
      detail: null,
    });

    const onNavigate = vi.fn();
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    const acknowledge = within(row).getByTestId("notification-acknowledge");
    expect(acknowledge.getAttribute("aria-label")).toBe("Acknowledge");
    expect(acknowledge.hasAttribute("disabled")).toBe(false);
    // The content column is a plain div, not a nested button. Unread rows
    // also render an absolute rail as the first child, so locate by flex-1.
    const contentColumn = Array.from(row.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.className.split(/\s+/).includes("flex-1"),
    );
    if (contentColumn === undefined) {
      throw new Error("missing content column");
    }
    expect(contentColumn.tagName.toLowerCase()).toBe("div");
    expect(within(row).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(acknowledge);
    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        useAppLocalNotificationsStore.getState().byId["local-1"].readAt,
      ).toBeTypeOf("number");
    });
    // Once read, the trailing acknowledge control is unmounted entirely
    // (no disabled dead CheckCheck button). Re-query the live row — a
    // lifecycle move out of Attention can remount the entry.
    await waitFor(() => {
      const live = screen
        .queryAllByTestId("notification-entry")
        .find((entry) => entry.dataset.notificationId === "app-local:local-1");
      if (live === undefined) {
        expect(screen.queryByTestId("notification-acknowledge")).toBeNull();
        return;
      }
      expect(within(live).queryByTestId("notification-acknowledge")).toBeNull();
      expect(within(live).queryAllByRole("button")).toHaveLength(0);
    });
  });

  it("does not render a trailing acknowledge control on already-read non-navigable rows", async () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    useAppLocalNotificationsStore.getState().upsert({
      id: "local-read",
      updatedAt: 50,
      readAt: 40,
      kind: "stream.transport.error",
      sourceRef: "local-read",
      payload: null,
      message: "Worktree failed",
      detail: null,
    });

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationRead).toBe("true");
    expect(within(row).queryByTestId("notification-acknowledge")).toBeNull();
    expect(within(row).queryByTestId("notification-mark-read")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("renders navigable unread rows with one primary button and sibling mark-read, never nested buttons", async () => {
    openNotificationsStream((callbacks) => {
      act(() => {
        seedEntries(callbacks, [
          threadEntry("route-1", "epic-xyz", "art-7", "thread-9"),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    const buttons = within(row).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(within(row).getByTestId("notification-mark-read")).not.toBeNull();
    for (const button of buttons) {
      expect(button.querySelector("button")).toBeNull();
    }

    fireEvent.click(within(row).getByTestId("notification-mark-read"));
    await waitFor(() => {
      expect(
        useNotificationsStore
          .getState()
          .entries.find((entry) => entry.id === "route-1")?.readAt,
      ).toBeTypeOf("number");
    });
    expect(within(row).queryByTestId("notification-mark-read")).toBeNull();
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("filters Recent through the menu while leaving Attention unchanged", async () => {
    applyHostSnapshot(
      [
        hostPrompt("prompt", 100, null),
        hostDone("done-unread", 90, null),
        hostDone("done-read", 80, 10),
      ],
      { unreadCount: 2, attentionCount: 1 },
    );
    openNotificationsStream((callbacks) => {
      act(() => {
        seedEntries(callbacks, [
          threadEntryWithState({
            id: "collab",
            epicId: "epic-1",
            artifactId: "art-1",
            threadId: "thread-1",
            createdAt: 60,
            readAt: null,
          }),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    await screen.findByText("Needs attention");
    const before = notificationIds(screen.getAllByTestId("notification-entry"));
    expect(before[0]).toBe("host:prompt");

    // Radix DropdownMenuTrigger opens on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId("notifications-filter-trigger"), {
      button: 0,
    });
    fireEvent.click(
      await screen.findByTestId("notifications-filter-unread-only"),
    );

    await waitFor(() => {
      const ids = notificationIds(screen.getAllByTestId("notification-entry"));
      expect(ids).toEqual(["host:prompt", "host:done-unread", "global:collab"]);
    });

    fireEvent.click(
      await screen.findByTestId("notifications-filter-category-task"),
    );

    await waitFor(() => {
      const ids = notificationIds(screen.getAllByTestId("notification-entry"));
      expect(ids).toEqual(["host:prompt", "global:collab"]);
    });
    expect(screen.getByText("Needs attention")).not.toBeNull();
  });

  it("restores Recent rows from the filtered-empty Reset filters control", async () => {
    applyHostSnapshot([hostDone("done-read", 80, 10)], {
      unreadCount: 0,
      attentionCount: 0,
    });
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    expect(await screen.findByTestId("notification-entry")).not.toBeNull();

    fireEvent.pointerDown(screen.getByTestId("notifications-filter-trigger"), {
      button: 0,
    });
    fireEvent.click(
      await screen.findByTestId("notifications-filter-unread-only"),
    );

    expect(
      await screen.findByTestId("notifications-filter-empty"),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId("notifications-filter-reset"));

    await waitFor(() => {
      expect(screen.queryByTestId("notifications-filter-empty")).toBeNull();
      expect(screen.getByTestId("notification-entry")).not.toBeNull();
    });
    expect(useNotificationsPopoverStore.getState().unreadOnly).toBe(false);
  });

  it("inserts temporal separators only when the calendar group changes", async () => {
    const now = Date.now();
    const today = now - 60_000;
    const yesterday = startOfLocalDay(now) - DAY_MS / 2;
    const earlier = startOfLocalDay(now) - 3 * DAY_MS;

    applyHostSnapshot(
      [
        hostDone("today", today, null),
        hostDone("yesterday", yesterday, null),
        hostDone("earlier", earlier, null),
      ],
      { unreadCount: 3, attentionCount: 0 },
    );

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const separators = await screen.findAllByTestId(
      "notification-temporal-separator",
    );
    expect(separators.map((node) => node.textContent)).toEqual([
      "Today",
      "Yesterday",
      "Earlier",
    ]);

    // Only one separator per group boundary - three groups → three labels.
    expect(separators).toHaveLength(3);

    // Desktop-pass subordination: micro/muted sentence case, not overline caps.
    for (const separator of separators) {
      expect(separator.className).toContain("text-micro");
      expect(separator.className).toContain("sticky");
      expect(separator.className).toContain("top-5");
      expect(separator.className).toContain("bg-popover");
      expect(separator.className).not.toContain("uppercase");
      expect(separator.className).not.toContain("font-semibold");
      expect(separator.className).not.toContain("text-overline");
    }
    const recentHeader = screen.getByText("Recent activity");
    expect(recentHeader.className).toContain("text-overline");
    expect(recentHeader.className).toContain("uppercase");
    expect(recentHeader.className).toContain("font-semibold");
    expect(recentHeader.className).toContain("sticky");
    expect(recentHeader.className).toContain("top-0");
    expect(recentHeader.className).toContain("bg-popover");
  });

  it("renders failed host outcomes and stalled rows as failure severity", async () => {
    const entries = [
      hostAgentEntry({
        id: "completed",
        kind: "agent.stopped",
        severity: "done",
        outcome: "completed",
        updatedAt: 10,
        readAt: null,
      }),
      hostAgentEntry({
        id: "failed",
        kind: "agent.stopped",
        severity: "failure",
        outcome: "errored",
        updatedAt: 20,
        readAt: null,
      }),
      hostAgentEntry({
        id: "stalled",
        kind: "agent.stalled",
        severity: "failure",
        outcome: "errored",
        updatedAt: 15,
        readAt: null,
      }),
    ];
    applyHostSnapshot(entries, { unreadCount: 3, attentionCount: 2 });

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const rows = await screen.findAllByTestId("notification-entry");
    const failed = rows.find(
      (row) => row.dataset.notificationId === "host:failed",
    );
    const completed = rows.find(
      (row) => row.dataset.notificationId === "host:completed",
    );
    const stalled = rows.find(
      (row) => row.dataset.notificationId === "host:stalled",
    );

    expect(failed?.dataset.notificationSeverity).toBe("failure");
    expect(failed?.textContent).toContain(TASK_TITLE);
    expect(completed?.dataset.notificationSeverity).toBe("done");
    expect(completed?.textContent).toContain(TASK_TITLE);
    expect(stalled?.dataset.notificationSeverity).toBe("failure");
    expect(stalled?.textContent).toContain(TASK_TITLE);

    if (completed === undefined) throw new Error("missing completed row");
    const notificationTitle =
      within(completed).getByTestId("notification-title");
    expect(notificationTitle.className).toContain("truncate");
    expect(notificationTitle.className).toContain("font-semibold");
  });

  it("shows the full empty state when every source is empty", async () => {
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const empty = await screen.findByTestId("notifications-empty");
    expect(empty.textContent).toContain("You're all caught up");
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("Recent activity")).toBeNull();
  });

  it("navigates to /epics/$epicId/$tabId with focusArtifactId and focusThreadId on click", async () => {
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const onNavigate = vi.fn();
    const { router } = buildRouterWithCapture(captured, onNavigate);

    openNotificationsStream((callbacks) => {
      act(() => {
        seedEntries(callbacks, [
          threadEntry("route-1", "epic-xyz", "art-7", "thread-9"),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    renderRouter(router);

    const entry = await screen.findByTestId("notification-entry");
    const trigger = entry.querySelector("button");
    if (trigger === null) throw new Error("button not found");

    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(captured.epicId).toBe("epic-xyz");
    expect(captured.tabId).toEqual(expect.any(String));
    expect(captured.focusArtifactId).toBe("art-7");
    expect(captured.focusThreadId).toBe("thread-9");
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(
      useNotificationsStore
        .getState()
        .entries.find((item) => item.id === "route-1")?.readAt,
    ).toBeTypeOf("number");
  });

  it("navigates a TUI completion row to its terminal agent", async () => {
    applyHostSnapshot(
      [
        {
          id: "agent.stopped:tui-1",
          updatedAt: 10,
          readAt: null,
          kind: "agent.stopped",
          sourceRef: "tui-1",
          severity: "done",
          outcome: "completed",
          epicId: "epic-tui",
          chatId: "tui-1",
          payload: {
            kind: "epic",
            epicId: "epic-tui",
            tuiAgentId: "tui-1",
            agentName: "Terminal agent",
            taskTitle: "TUI task",
            outcome: "completed",
          },
        },
      ],
      { unreadCount: 1, attentionCount: 0 },
    );
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const onNavigate = vi.fn();
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    const entry = await screen.findByTestId("notification-entry");
    const trigger = within(entry).getByRole<HTMLButtonElement>("button", {
      name: /TUI task/,
    });

    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(captured.epicId).toBe("epic-tui");
    expect(captured.focusArtifactId).toBe("tui-1");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("marks every notification as read when Mark all read is clicked", async () => {
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);

    openNotificationsStream((callbacks) => {
      act(() => {
        seedEntries(callbacks, [
          threadEntry("all-1", "epic-1", "art-1", "thread-1"),
          threadEntry("all-2", "epic-2", "art-2", "thread-2"),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    renderRouter(router);

    fireEvent.click(await screen.findByTestId("notifications-mark-all-read"));

    expect(
      useNotificationsStore
        .getState()
        .entries.every((entry) => entry.readAt !== null),
    ).toBe(true);
  });

  it("opens Notification settings from the header gear without an overflow menu", async () => {
    useSettingsSectionStore.getState().setSection(null);
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    let navigated = false;
    const { router } = buildRouterWithCapture(captured, () => {
      navigated = true;
    });

    renderRouter(router);

    expect(screen.queryByTestId("notifications-overflow-menu")).toBeNull();
    const settings = await screen.findByTestId("notifications-open-settings");
    expect(settings.tagName.toLowerCase()).toBe("button");
    fireEvent.click(settings);

    expect(navigated).toBe(true);
    expect(useSettingsSectionStore.getState().section).toBe("notifications");
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({
        settingsOverlay: true,
      });
    });
  });

  it("closes the center on dispatch even when markRead never resolves", async () => {
    bindHostClient();
    // markRead is a background write after onResult("success"); the center
    // must close on route dispatch and never wait for this mutation.
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.markRead") {
        return new Promise(() => undefined);
      }
      return defaultHostRequest(method);
    });

    applyHostSnapshot(
      [hostDone("row-a", 20, null), hostDone("row-b", 10, null)],
      { unreadCount: 2, attentionCount: 0 },
    );

    const onNavigate = vi.fn();
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    const rows = await screen.findAllByTestId("notification-entry");
    const rowA = rows.find(
      (row) => row.dataset.notificationId === "host:row-a",
    );
    const rowB = rows.find(
      (row) => row.dataset.notificationId === "host:row-b",
    );
    if (rowA === undefined || rowB === undefined) {
      throw new Error("expected both host rows");
    }

    act(() => {
      fireEvent.click(activateButtonFor(rowA));
    });

    // Synchronous close on dispatch - no waitFor for a preflight gate.
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // No pending/disabled row state (activation is synchronous).
    expect(rowA.dataset.notificationPending).toBeUndefined();
    expect(activateButtonFor(rowA).disabled).toBe(false);
    expect(activateButtonFor(rowB).disabled).toBe(false);
    // markRead is a background mutation - it fires after onResult, but the
    // never-resolving handler must not block close (already asserted above).
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.markRead",
        expect.objectContaining({ ids: ["row-a"] }),
      );
    });
  });

  it("on activation success closes the center, marks read, and analytics stay category-only", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    openNotificationsStream((callbacks) => {
      act(() => {
        seedEntries(callbacks, [
          threadEntry("route-success", "epic-xyz", "art-7", "thread-9"),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    const onNavigate = vi.fn();
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    const entry = await screen.findByTestId("notification-entry");
    await act(async () => {
      fireEvent.click(activateButtonFor(entry));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(
      useNotificationsStore
        .getState()
        .entries.find((item) => item.id === "route-success")?.readAt,
    ).toBeTypeOf("number");

    const activatedCalls = trackSpy.mock.calls.filter(
      (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
    );
    const markedCalls = trackSpy.mock.calls.filter(
      (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
    );
    expect(activatedCalls).toHaveLength(1);
    expect(activatedCalls[0]?.[1]).toEqual({
      category: "collaboration",
      section: "recent",
      surface: "center",
      outcome: "success",
    });
    expect(markedCalls).toHaveLength(1);
    expect(markedCalls[0]?.[1]).toEqual({
      category: "collaboration",
      acknowledgment_source: "activation",
    });
    trackSpy.mockRestore();
  });

  it("on markRead failure leaves the row unread after the center already closed", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    bindHostClient();
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.markRead") {
        return Promise.reject(new Error("markRead failed"));
      }
      return defaultHostRequest(method);
    });

    applyHostSnapshot([hostDone("fail-row", 20, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });

    const onNavigate = vi.fn();
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    act(() => {
      fireEvent.click(activateButtonFor(row));
    });

    // Dispatch succeeds and closes immediately; markRead is decoupled.
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(
      trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
      ),
    ).toHaveLength(1);
    expect(
      trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
      ),
    ).toHaveLength(1);

    // markHostRead has no optimistic local flip - only onSuccess writes
    // markReadLocally. A rejected mutation leaves readAt untouched.
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.markRead",
        expect.objectContaining({ ids: ["fail-row"] }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const failEntry = useHostNotificationsStore.getState().byId["fail-row"];
    expect(failEntry).toBeDefined();
    expect(failEntry.readAt).toBeNull();
    const live = screen
      .queryAllByTestId("notification-entry")
      .find((entry) => entry.dataset.notificationId === "host:fail-row");
    if (live !== undefined) {
      expect(live.dataset.notificationRead).toBe("false");
    }
    trackSpy.mockRestore();
  });

  it("emits explicit_action marked-read analytics from the acknowledge control", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    useAppLocalNotificationsStore.getState().upsert({
      id: "ack-local",
      updatedAt: 50,
      readAt: null,
      kind: "stream.transport.error",
      sourceRef: "ack-local",
      payload: null,
      message: "Worktree failed",
      detail: null,
    });

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    const row = await screen.findByTestId("notification-entry");
    fireEvent.click(within(row).getByTestId("notification-acknowledge"));

    const activatedCalls = trackSpy.mock.calls.filter(
      (call) => call[0] === AnalyticsEvent.NotificationActivationCompleted,
    );
    const markedCalls = trackSpy.mock.calls.filter(
      (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
    );
    expect(activatedCalls).toHaveLength(1);
    expect(activatedCalls[0]?.[1]).toEqual({
      category: "system",
      section: "attention",
      surface: "center",
      outcome: "success",
    });
    expect(markedCalls).toHaveLength(1);
    expect(markedCalls[0]?.[1]).toEqual({
      category: "system",
      acknowledgment_source: "explicit_action",
    });
    trackSpy.mockRestore();
  });

  it("tracks filter toggles with the new enabled state and mark-all-read bucket", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    bindHostClient();
    applyHostSnapshot([hostDone("filter-row", 40, null)], {
      unreadCount: 4,
      attentionCount: 0,
    });

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    await screen.findByTestId("notification-entry");

    fireEvent.pointerDown(screen.getByTestId("notifications-filter-trigger"), {
      button: 0,
    });
    fireEvent.click(
      await screen.findByTestId("notifications-filter-unread-only"),
    );
    fireEvent.click(
      await screen.findByTestId("notifications-filter-category-task"),
    );

    const filterCalls = trackSpy.mock.calls.filter(
      (call) => call[0] === AnalyticsEvent.NotificationFilterChanged,
    );
    expect(filterCalls).toEqual(
      expect.arrayContaining([
        [
          AnalyticsEvent.NotificationFilterChanged,
          { filter: "unread_only", enabled: true },
        ],
        [
          AnalyticsEvent.NotificationFilterChanged,
          { filter: "task", enabled: false },
        ],
      ]),
    );

    fireEvent.click(screen.getByTestId("notifications-mark-all-read"));
    const markAllCalls = trackSpy.mock.calls.filter(
      (call) => call[0] === AnalyticsEvent.NotificationsMarkedAllRead,
    );
    expect(markAllCalls).toHaveLength(1);
    expect(markAllCalls[0]?.[1]).toEqual({
      affected_count_bucket: "2-5",
    });
    trackSpy.mockRestore();
  });

  it("moves an activated approval to Recent without resolving it", async () => {
    bindHostClient();
    applyHostSnapshot([hostPrompt("prompt-keep", 100, null)], {
      unreadCount: 1,
      attentionCount: 1,
    });

    const onNavigate = vi.fn();
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    expect(await screen.findByText("Needs attention")).not.toBeNull();
    const row = await screen.findByTestId("notification-entry");
    expect(row.dataset.notificationId).toBe("host:prompt-keep");

    await act(async () => {
      fireEvent.click(activateButtonFor(row));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    // Success acknowledges the notification without resolving the prompt.
    await waitFor(() => {
      expect(screen.queryByText("Needs attention")).toBeNull();
    });
    const stillThere = screen
      .getAllByTestId("notification-entry")
      .find((entry) => entry.dataset.notificationId === "host:prompt-keep");
    expect(stillThere).not.toBeUndefined();
  });

  it("renders trailing tick actions only on unread rows", async () => {
    applyHostSnapshot(
      [
        hostPrompt("prompt-unread", 120, null),
        hostPrompt("prompt-read", 110, 50),
        hostFailure("fail-unread", 100, null),
        hostDone("recent-read", 90, 40),
      ],
      { unreadCount: 2, attentionCount: 2 },
    );
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    expect(await screen.findByText("Needs attention")).not.toBeNull();
    function findRow(feedId: string): HTMLElement {
      const row = screen
        .getAllByTestId("notification-entry")
        .find((entry) => entry.dataset.notificationId === feedId);
      if (row === undefined) throw new Error(`missing row ${feedId}`);
      return row;
    }

    const unreadPrompt = findRow("host:prompt-unread");
    const readPrompt = findRow("host:prompt-read");
    const failure = findRow("host:fail-unread");
    const recentRead = findRow("host:recent-read");

    // Read rows do not reuse the unread-state tick for another disposition.
    expect(readPrompt.dataset.notificationRead).toBe("true");
    expect(
      within(readPrompt).queryByRole("button", { name: "Mark as read" }),
    ).toBeNull();

    expect(
      within(unreadPrompt).getByTestId("notification-mark-read"),
    ).not.toBeNull();

    expect(
      within(failure).getByTestId("notification-mark-read"),
    ).not.toBeNull();

    // Read Recent rows show no trailing control (regression guard).
    expect(recentRead.dataset.notificationRead).toBe("true");
    expect(
      within(recentRead).queryByTestId("notification-mark-read"),
    ).toBeNull();
    expect(
      within(recentRead).queryByTestId("notification-acknowledge"),
    ).toBeNull();
  });

  it("mark-read acknowledges a prompt without activating or resolving it", async () => {
    bindHostClient();
    applyHostSnapshot(
      [hostPrompt("prompt-dismiss", 100, null), hostDone("done", 90, null)],
      { unreadCount: 2, attentionCount: 1 },
    );

    const onNavigate = vi.fn();
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, onNavigate);
    renderRouter(router);

    expect(await screen.findByText("Needs attention")).not.toBeNull();
    const attentionRow = screen
      .getAllByTestId("notification-entry")
      .find((entry) => entry.dataset.notificationId === "host:prompt-dismiss");
    if (attentionRow === undefined) {
      throw new Error("expected blocking attention row");
    }

    fireEvent.click(within(attentionRow).getByTestId("notification-mark-read"));

    // Sibling control - never activates / navigates the row.
    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.markRead",
        { kind: "ids", ids: ["prompt-dismiss"] },
      );
    });
    expect(
      trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationMarkedRead,
      ),
    ).toEqual([
      [
        AnalyticsEvent.NotificationMarkedRead,
        {
          category: "task",
          acknowledgment_source: "explicit_action",
        },
      ],
    ]);

    await waitFor(() => {
      expect(screen.queryByText("Needs attention")).toBeNull();
    });
    const live = screen
      .getAllByTestId("notification-entry")
      .find((entry) => entry.dataset.notificationId === "host:prompt-dismiss");
    if (live === undefined) {
      throw new Error("expected acknowledged row in Recent");
    }
    expect(live.dataset.notificationRead).toBe("true");
    expect(
      within(live).getByTestId("notification-relocation-highlight"),
    ).not.toBeNull();
    const acknowledged =
      useHostNotificationsStore.getState().byId["prompt-dismiss"];
    expect(acknowledged.readAt).toBeTypeOf("number");
    expect(
      "resolvedAt" in acknowledged ? acknowledged.resolvedAt : null,
    ).toBeNull();
    trackSpy.mockRestore();
  });

  it("Mark all read acknowledges prompts without resolving them", async () => {
    bindHostClient();
    applyHostSnapshot(
      [
        hostPrompt("prompt-a", 200, null),
        hostPrompt("prompt-b", 150, 40),
        hostDone("done-unread", 100, null),
      ],
      { unreadCount: 2, attentionCount: 1 },
    );

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    expect(await screen.findByText("Needs attention")).not.toBeNull();
    fireEvent.click(screen.getByTestId("notifications-mark-all-read"));

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
    });

    await waitFor(() => {
      expect(screen.queryByText("Needs attention")).toBeNull();
    });
    expect(
      screen
        .queryAllByTestId("notification-entry")
        .filter((entry) =>
          ["host:prompt-a", "host:prompt-b"].includes(
            entry.dataset.notificationId ?? "",
          ),
        )
        .every((entry) => entry.dataset.notificationRead === "true"),
    ).toBe(true);
    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.resolve",
      ),
    ).toBe(false);
    for (const id of ["prompt-a", "prompt-b"]) {
      const prompt = useHostNotificationsStore.getState().byId[id];
      expect("resolvedAt" in prompt ? prompt.resolvedAt : null).toBeNull();
    }
  });

  it("Mark all read does not call resolve when no loaded blocking Attention rows exist", async () => {
    bindHostClient();
    applyHostSnapshot([hostDone("done-only", 100, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    fireEvent.click(await screen.findByTestId("notifications-mark-all-read"));

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
    });
    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.resolve",
      ),
    ).toBe(false);
  });

  it("disables Mark all read when only a read unresolved prompt remains", async () => {
    applyHostSnapshot([hostPrompt("prompt-read", 110, 50)], {
      unreadCount: 0,
      attentionCount: 0,
    });

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    expect(await screen.findByText("Recent activity")).not.toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(markAllReadButton().disabled).toBe(true);
  });

  it("enables Mark all read on disconnect when a local unread row remains actionable", async () => {
    applyHostSnapshot([hostPrompt("prompt-read", 110, 50)], {
      unreadCount: 0,
      attentionCount: 0,
    });
    seedUnreadAppLocal("local-during-disconnect");
    simulateHostDisconnect();

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    await screen.findByText("Needs attention");
    expect(
      screen
        .getAllByTestId("notification-entry")
        .some(
          (entry) =>
            entry.dataset.notificationId ===
            "app-local:local-during-disconnect",
        ),
    ).toBe(true);
    expect(markAllReadButton().disabled).toBe(false);
  });

  it("Mark all read during disconnect skips host mutations, marks local rows, and raises no error toasts", async () => {
    applyHostSnapshot([hostPrompt("prompt-read", 110, 50)], {
      unreadCount: 0,
      attentionCount: 0,
    });
    seedUnreadAppLocal("local-mark-all-disconnect");
    simulateHostDisconnect();

    const captured: TargetCapture = {
      epicId: null,
      tabId: null,
      focusArtifactId: null,
      focusThreadId: null,
    };
    const { router } = buildRouterWithCapture(captured, () => undefined);
    renderRouter(router);

    await screen.findByText("Needs attention");
    const markAll = markAllReadButton();
    expect(markAll.disabled).toBe(false);
    fireEvent.click(markAll);

    await waitFor(() => {
      expect(
        useAppLocalNotificationsStore.getState().byId[
          "local-mark-all-disconnect"
        ].readAt,
      ).toBeTypeOf("number");
    });

    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.markAllRead",
      ),
    ).toBe(false);
    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.resolve",
      ),
    ).toBe(false);
    expect(toastFromHostError).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    // The read prompt remains unresolved; notification consumption never
    // mutates chat workflow state.
    const retained = useHostNotificationsStore.getState().byId["prompt-read"];
    expect("resolvedAt" in retained ? retained.resolvedAt : null).toBeNull();
  });
});
