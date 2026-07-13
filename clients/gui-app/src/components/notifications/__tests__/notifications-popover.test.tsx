import "../../../../__tests__/test-browser-apis";
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
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
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
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";

const hostBindingState = vi.hoisted<{
  current: { readonly hostClient: HostClient<HostRpcRegistry> } | null;
}>(() => ({ current: null }));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingState.current,
  };
});

const TASK_TITLE = "Checkout notification title and hover behavior";

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

function buildRouterWithCapture(target: TargetCapture, onNavigate: () => void) {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <NotificationsPopover onNavigate={onNavigate} />,
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

function createHostClient(
  clearAllRequests: Array<{ readonly beforeUpdatedAt: number }>,
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "clear-all-request",
      handlers: {
        "host.notifications.clearAll": (request) => {
          clearAllRequests.push(request);
          return {};
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test-token",
    }),
  );
  return client;
}

function hostAgentEntry(input: {
  readonly id: string;
  readonly kind: "agent.stopped" | "agent.stalled";
  readonly severity: "failure" | "done";
  readonly outcome: "completed" | "stopped" | "errored" | null;
}): HostNotificationEntry {
  if (input.kind === "agent.stopped") {
    return {
      id: input.id,
      updatedAt: input.id === "failed" ? 20 : 10,
      readAt: null,
      kind: "agent.stopped",
      sourceRef: input.id,
      severity: input.severity,
      outcome: input.outcome ?? "completed",
      payload: {
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
    updatedAt: input.id === "failed" ? 20 : 10,
    readAt: null,
    kind: "agent.stalled",
    sourceRef: input.id,
    severity: input.severity,
    outcome: "errored",
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
      taskTitle: TASK_TITLE,
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

function notificationIds(rows: ReadonlyArray<HTMLElement>) {
  return rows.map((row) => row.dataset.notificationId);
}

async function selectTab(testId: string) {
  const trigger = screen.getByTestId(testId);
  await act(async () => {
    fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
    await Promise.resolve();
  });
}

describe("NotificationsPopover click routing", () => {
  beforeEach(() => {
    hostBindingState.current = null;
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    __resetHostNotificationsStoreForTests();
  });

  it("renders a relative timestamp on every notification row", async () => {
    // Use the floor of 2.5 minutes so we land firmly inside the `2m ago`
    // bucket and cannot drift into `1m ago` between module load and render.
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

  it("defaults to Unread and shows read notifications only in All", async () => {
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
          threadEntryWithState({
            id: "unread-new",
            epicId: "epic-1",
            artifactId: "art-1",
            threadId: "thread-1",
            createdAt: 2,
            readAt: null,
          }),
          threadEntryWithState({
            id: "read-old",
            epicId: "epic-2",
            artifactId: "art-2",
            threadId: "thread-2",
            createdAt: 1,
            readAt: 10,
          }),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    renderRouter(router);

    const unreadContent = await screen.findByTestId(
      "notifications-tab-content-unread",
    );
    const unreadRows =
      within(unreadContent).getAllByTestId("notification-entry");
    expect(notificationIds(unreadRows)).toEqual(["global:unread-new"]);
    const unreadRow = unreadRows[0];
    const unreadMarker = within(unreadRow).getByTestId(
      "notification-unread-marker",
    );
    expect(unreadMarker.className).toContain("absolute");
    expect(unreadMarker.className).toContain("inset-y-2");
    expect(unreadMarker.className).toContain("left-0");
    expect(unreadMarker.className).toContain("rounded-r-full");

    await selectTab("notifications-tab-all");

    const allContent = await screen.findByTestId(
      "notifications-tab-content-all",
    );
    let allRows: ReadonlyArray<HTMLElement> = [];
    await waitFor(() => {
      allRows = within(allContent).getAllByTestId("notification-entry");
      expect(notificationIds(allRows)).toEqual([
        "global:unread-new",
        "global:read-old",
      ]);
    });
    const readRow = allRows[1];
    expect(
      within(readRow).queryByTestId("notification-unread-marker"),
    ).toBeNull();
  });

  it("renders failed host outcomes and stalled rows as failure severity", async () => {
    useHostNotificationsStore.getState().replaceFromSnapshot(
      [
        hostAgentEntry({
          id: "completed",
          kind: "agent.stopped",
          severity: "done",
          outcome: "completed",
        }),
        hostAgentEntry({
          id: "failed",
          kind: "agent.stopped",
          severity: "failure",
          outcome: "errored",
        }),
        hostAgentEntry({
          id: "stalled",
          kind: "agent.stalled",
          severity: "failure",
          outcome: "errored",
        }),
      ],
      50,
    );

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
    expect(failed?.dataset.notificationOutcome).toBe("errored");
    expect(failed?.textContent).toContain(TASK_TITLE);
    expect(failed?.textContent).toContain("Agent • Failed");
    expect(completed?.dataset.notificationSeverity).toBe("done");
    expect(completed?.textContent).toContain(TASK_TITLE);
    expect(completed?.textContent).toContain("Agent • Done");
    expect(stalled?.dataset.notificationSeverity).toBe("failure");
    expect(stalled?.textContent).toContain(TASK_TITLE);
    expect(stalled?.textContent).toContain("Agent • Stalled");

    if (completed === undefined) throw new Error("missing completed row");
    const notificationTitle =
      within(completed).getByTestId("notification-title");
    expect(notificationTitle.className).toContain("truncate");
    expect(notificationTitle.className).toContain("font-semibold");
    fireEvent.pointerMove(notificationTitle, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe(TASK_TITLE);
  });

  it("keeps the Unread tab visible when every notification is read", async () => {
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
          threadEntryWithState({
            id: "read-only",
            epicId: "epic-1",
            artifactId: "art-1",
            threadId: "thread-1",
            createdAt: 1,
            readAt: 10,
          }),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    renderRouter(router);

    expect(
      await screen.findByTestId("notifications-tab-unread"),
    ).not.toBeNull();
    const unreadContent = await screen.findByTestId(
      "notifications-tab-content-unread",
    );
    const emptyState = within(unreadContent).getByTestId("notifications-empty");
    expect(emptyState).not.toBeNull();
    expect(emptyState.className).toContain("h-full");
    expect(emptyState.className).toContain("justify-center");

    await selectTab("notifications-tab-all");

    const allContent = await screen.findByTestId(
      "notifications-tab-content-all",
    );
    await waitFor(() => {
      expect(
        notificationIds(
          within(allContent).getAllByTestId("notification-entry"),
        ),
      ).toEqual(["global:read-only"]);
    });
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

  it("clears every notification when Clear all is clicked", async () => {
    const clearAllRequests: Array<{ readonly beforeUpdatedAt: number }> = [];
    hostBindingState.current = {
      hostClient: createHostClient(clearAllRequests),
    };
    useHostNotificationsStore.getState().replaceFromSnapshot(
      [
        hostAgentEntry({
          id: "clear-host",
          kind: "agent.stopped",
          severity: "done",
          outcome: "completed",
        }),
      ],
      50,
    );
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
          threadEntry("clear-1", "epic-1", "art-1", "thread-1"),
          threadEntry("clear-2", "epic-2", "art-2", "thread-2"),
        ]);
      });
      return { applyUpdate: () => {}, close: () => {} };
    }, null);

    renderRouter(router);

    fireEvent.click(await screen.findByTestId("notifications-clear-all"));

    expect(useNotificationsStore.getState().entries.length).toBe(0);
    await waitFor(() => {
      expect(clearAllRequests).toHaveLength(1);
      expect(clearAllRequests.at(0)?.beforeUpdatedAt).toBe(10);
      expect(useHostNotificationsStore.getState().orderedIds).toEqual([]);
    });
    expect(await screen.findByTestId("notifications-empty")).not.toBeNull();
  });
});
