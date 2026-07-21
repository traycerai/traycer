import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
} from "@tanstack/react-router";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
} from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
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
  HostNotificationsAttentionCursor,
  HostNotificationsChronologicalCursor,
} from "@traycer/protocol/host/notifications/contracts";
import { ALL_NOTIFICATION_CATEGORIES } from "@/lib/notifications/notification-category";
import { useNotificationCenterGeometry } from "@/hooks/notifications/use-notification-center-geometry";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

const hostRequestMock = vi.hoisted(() => vi.fn());

const hostBindingState = vi.hoisted(() => ({
  current: null as {
    readonly hostClient: {
      readonly request: typeof hostRequestMock;
      readonly getActiveHostId: () => string | null;
    };
  } | null,
}));

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
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

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0 || directoryRef.value === null) return null;
    return directoryRef.value.findById(hostId);
  },
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

const TASK_TITLE = "Checkout notification title";

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

function openGlobalStream(): {
  readonly seed: (entries: ReadonlyArray<NotificationEntry>) => void;
} {
  let current: NotificationsStreamCallbacks | null = null;
  openNotificationsStream((callbacks) => {
    current = callbacks;
    return {
      applyUpdate: () => {},
      close: () => {},
    };
  }, null);
  return {
    seed: (entries) => {
      if (current === null) throw new Error("stream factory not invoked");
      seedEntries(current, entries);
    },
  };
}

function hostPrompt(id: string, updatedAt: number): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt: null,
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

function hostDone(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
      taskTitle: TASK_TITLE,
      outcome: "completed",
    },
  };
}

function hostFailure(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "failure",
    outcome: "errored",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
      taskTitle: TASK_TITLE,
      outcome: "errored",
      code: "RATE_LIMIT",
    },
  };
}

function chronologicalCursor(
  updatedAt: number,
  id: string,
): HostNotificationsChronologicalCursor {
  return { kind: "chronological", updatedAt, id };
}

function attentionCursor(
  updatedAt: number,
  id: string,
): HostNotificationsAttentionCursor {
  return {
    kind: "attention",
    tier: "blocking",
    updatedAt,
    id,
  };
}

function applyHostSnapshot(input: {
  readonly entries: ReadonlyArray<HostNotificationEntry>;
  readonly summary: {
    readonly unreadCount: number;
    readonly attentionCount: number;
  };
  readonly recentCursor: HostNotificationsChronologicalCursor | null;
  readonly attentionCursor: HostNotificationsAttentionCursor | null;
}): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: {
      entries: input.entries.filter(
        (entry) =>
          entry.severity === "needs_action" || entry.severity === "failure",
      ),
      nextCursor: input.attentionCursor,
    },
    recent: {
      entries: input.entries,
      nextCursor: input.recentCursor,
    },
    summary: input.summary,
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
  });
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function PopoverShell(): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <NotificationsPopover
      onNavigate={() => undefined}
      headingRef={headingRef}
      shellRef={shellRef}
      shellStyle={{}}
      onFilterMenuOpenChange={() => undefined}
    />
  );
}

function GeometryPopoverShell(props: {
  readonly open: boolean;
  readonly isColdOpen: boolean;
}): ReactNode {
  const geometry = useNotificationCenterGeometry({
    open: props.open,
    isColdOpen: props.isColdOpen,
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  if (!props.open) return null;
  return (
    <div
      data-radix-popper-content-wrapper=""
      data-testid="popper-wrapper"
      style={{ transform: "translate(0, -200%)" }}
    >
      <NotificationsPopover
        onNavigate={() => undefined}
        headingRef={headingRef}
        shellRef={geometry.shellRef}
        shellStyle={geometry.style}
        onFilterMenuOpenChange={() => undefined}
      />
    </div>
  );
}

function buildRouter(component: () => ReactNode): AnyRouter {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function renderPopover(): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RouterProvider
        router={buildRouter(() => (
          <PopoverShell />
        ))}
      />
    </QueryClientProvider>,
  );
}

function renderGeometryPopover(): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RouterProvider
        router={buildRouter(() => (
          <GeometryPopoverShell open isColdOpen={false} />
        ))}
      />
    </QueryClientProvider>,
  );
}

function forcePopperPlacement(shell: HTMLElement): void {
  const wrapper = shell.closest<HTMLElement>(
    "[data-radix-popper-content-wrapper]",
  );
  if (wrapper === null) {
    throw new Error("missing radix popper content wrapper");
  }
  act(() => {
    wrapper.style.transform = "translate(0, -200%)";
  });
  act(() => {
    wrapper.style.transform = "translate(0px, 0px)";
  });
}

async function waitForGeometryLock(
  shell: HTMLElement,
): Promise<{ readonly width: string; readonly height: string }> {
  await waitFor(() => {
    expect(shell.style.width.length).toBeGreaterThan(0);
    expect(shell.style.height.length).toBeGreaterThan(0);
  });
  return { width: shell.style.width, height: shell.style.height };
}

function makeDomRect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  };
}

function bindHostClient(): void {
  hostBindingState.current = {
    hostClient: {
      request: hostRequestMock,
      getActiveHostId: () => mockLocalHostEntry.hostId,
    },
  };
}

function setScrollTop(scrollEl: HTMLElement, scrollTop: number): void {
  Object.defineProperty(scrollEl, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  fireEvent.scroll(scrollEl);
}

function listError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "list failed",
    requestId: "req-fail",
    method: "host.notifications.list",
    fatalDetails: null,
  });
}

function globalEntry(
  id: string,
  createdAt: number,
  readAt: number | null,
): NotificationEntry {
  return {
    id,
    createdAt,
    readAt,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.COMMENT_ADDED,
      epicId: "epic-1",
      artifactId: "art-1",
      artifactType: "ticket",
      threadId: "thread-1",
      actorName: "Alice",
    },
  };
}

describe("NotificationsPopover feed controls (T05)", () => {
  let getBoundingClientRectSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    hostRequestMock.mockReset();
    hostBindingState.current = null;
    window.localStorage.clear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    resetPopoverFilters();
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    __resetHostNotificationsStoreForTests();
    if (getBoundingClientRectSpy !== null) {
      getBoundingClientRectSpy.mockRestore();
      getBoundingClientRectSpy = null;
    }
  });

  describe("scrollport + overflow-anchor", () => {
    it("marks the feed scrollport with overflow-anchor:none", async () => {
      applyHostSnapshot({
        entries: [hostDone("done", 10, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionCursor: null,
      });
      renderPopover();

      const scrollport = await screen.findByTestId(
        "notifications-feed-scrollport",
      );
      expect(scrollport.className).toContain("[overflow-anchor:none]");
    });
  });

  describe("filter source combinations", () => {
    it("filters Recent by every category and Unread-only while Attention stays fixed", async () => {
      applyHostSnapshot({
        entries: [
          hostPrompt("prompt", 100),
          hostDone("task-unread", 90, null),
          hostDone("task-read", 80, 10),
          hostFailure("fail-unread", 85, null),
        ],
        summary: { unreadCount: 3, attentionCount: 2 },
        recentCursor: null,
        attentionCursor: null,
      });
      useAppLocalNotificationsStore.getState().activateIdentity("user-a");
      useAppLocalNotificationsStore.getState().upsert({
        id: "sys-1",
        updatedAt: 70,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "sys-1",
        payload: null,
        message: "Worktree failed",
        detail: null,
      });
      const stream = openGlobalStream();
      stream.seed([globalEntry("collab", 60, null)]);

      renderPopover();

      await screen.findByText("Needs attention");
      // Unread app-local failures are Attention (not Recent), so filters
      // never hide them - same invariance as host prompts/failures.
      const attentionAlways = [
        "host:prompt",
        "host:fail-unread",
        "app-local:sys-1",
      ];

      // Default: Attention first, then Recent (newest-first across sources).
      const defaultIds = notificationIds(
        screen.getAllByTestId("notification-entry"),
      );
      expect(defaultIds.slice(0, attentionAlways.length)).toEqual(
        attentionAlways,
      );
      expect(new Set(defaultIds.slice(attentionAlways.length))).toEqual(
        new Set(["host:task-unread", "host:task-read", "global:collab"]),
      );

      // Drive the full filter matrix through the store (same state the menu
      // mutates). Filters apply to Recent only.
      act(() => {
        useNotificationsPopoverStore.setState({
          unreadOnly: true,
          categories: ALL_NOTIFICATION_CATEGORIES,
        });
      });
      await waitFor(() => {
        const ids = notificationIds(
          screen.getAllByTestId("notification-entry"),
        );
        expect(ids.slice(0, attentionAlways.length)).toEqual(attentionAlways);
        expect(ids).not.toContain("host:task-read");
        expect(ids).toContain("host:task-unread");
        expect(ids).toContain("global:collab");
      });

      act(() => {
        useNotificationsPopoverStore.setState({
          unreadOnly: true,
          categories: new Set(["collaboration"]),
        });
      });
      await waitFor(() => {
        const ids = notificationIds(
          screen.getAllByTestId("notification-entry"),
        );
        expect(ids.slice(0, attentionAlways.length)).toEqual(attentionAlways);
        // Task Recent rows drop; collab remains; Attention unchanged.
        expect(ids).not.toContain("host:task-unread");
        expect(ids).toContain("global:collab");
      });

      act(() => {
        useNotificationsPopoverStore.setState({
          unreadOnly: true,
          categories: new Set(),
        });
      });
      await waitFor(() => {
        // Recent fully filtered out; Attention (including app-local) still present.
        expect(
          notificationIds(screen.getAllByTestId("notification-entry")),
        ).toEqual(attentionAlways);
        expect(screen.getByText("Needs attention")).not.toBeNull();
        expect(screen.getByTestId("notifications-filter-empty")).not.toBeNull();
      });

      // Filter-empty Reset filters recovers Recent without closing the center.
      fireEvent.click(screen.getByTestId("notifications-filter-reset"));
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-filter-empty")).toBeNull();
        expect(
          notificationIds(screen.getAllByTestId("notification-entry")).length,
        ).toBeGreaterThan(attentionAlways.length);
      });
      expect(useNotificationsPopoverStore.getState().unreadOnly).toBe(false);
      expect(
        [...useNotificationsPopoverStore.getState().categories].sort(),
      ).toEqual([...ALL_NOTIFICATION_CATEGORIES].sort());
    });
  });

  describe("independent Attention / Recent continuation", () => {
    it("loads each track in isolation and merges correctly under interleaved resolution order", async () => {
      bindHostClient();
      const attentionCursorValue = attentionCursor(100, "prompt-a");
      const recentCursorValue = chronologicalCursor(90, "done-a");
      applyHostSnapshot({
        entries: [hostPrompt("prompt-a", 100), hostDone("done-a", 90, null)],
        summary: { unreadCount: 2, attentionCount: 1 },
        recentCursor: recentCursorValue,
        attentionCursor: attentionCursorValue,
      });

      const pendingByFilter = new Map<
        string,
        {
          resolve: (value: {
            readonly entries: ReadonlyArray<HostNotificationEntry>;
            readonly nextCursor:
              | HostNotificationsAttentionCursor
              | HostNotificationsChronologicalCursor
              | null;
          }) => void;
        }
      >();
      hostRequestMock.mockImplementation(
        (method: string, params: { readonly filter?: string }) => {
          if (method === "host.notifications.list") {
            const filter = params.filter ?? "";
            return new Promise((resolve) => {
              pendingByFilter.set(filter, { resolve });
            });
          }
          return Promise.resolve({});
        },
      );

      renderPopover();

      // --- Attention-only load leaves Recent byte-for-byte unchanged ---
      const recentBeforeAttention = {
        cursor: useHostNotificationsStore.getState().recentCursor,
        status: useHostNotificationsStore.getState().recentStatus,
        byId: useHostNotificationsStore.getState().byId,
      };
      fireEvent.click(
        await screen.findByTestId("notifications-load-more-attention"),
      );
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().attentionStatus).toBe(
          "loading",
        );
      });
      expect(hostRequestMock).toHaveBeenCalledWith("host.notifications.list", {
        filter: "attention",
        limit: 50,
        cursor: attentionCursorValue,
      });
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        recentBeforeAttention.cursor,
      );
      expect(useHostNotificationsStore.getState().recentStatus).toBe(
        recentBeforeAttention.status,
      );
      expect(useHostNotificationsStore.getState().byId).toBe(
        recentBeforeAttention.byId,
      );

      const nextAttentionCursor = attentionCursor(50, "prompt-b");
      await act(async () => {
        pendingByFilter.get("attention")?.resolve({
          entries: [hostPrompt("prompt-b", 50)],
          nextCursor: nextAttentionCursor,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().attentionStatus).toBe(
          "idle",
        );
      });
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        nextAttentionCursor,
      );
      expect(
        useHostNotificationsStore.getState().byId["prompt-b"],
      ).toBeDefined();
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        recentCursorValue,
      );
      expect(useHostNotificationsStore.getState().byId["done-a"]).toBe(
        recentBeforeAttention.byId["done-a"],
      );

      // --- Recent-only load leaves Attention unchanged ---
      const attentionBeforeRecent = {
        cursor: useHostNotificationsStore.getState().attentionCursor,
        status: useHostNotificationsStore.getState().attentionStatus,
        promptB: useHostNotificationsStore.getState().byId["prompt-b"],
        promptA: useHostNotificationsStore.getState().byId["prompt-a"],
      };
      fireEvent.click(screen.getByTestId("notifications-load-older"));
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe(
          "loading",
        );
      });
      expect(hostRequestMock).toHaveBeenLastCalledWith(
        "host.notifications.list",
        {
          filter: "recent",
          limit: 50,
          cursor: recentCursorValue,
        },
      );
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        attentionBeforeRecent.cursor,
      );
      expect(useHostNotificationsStore.getState().attentionStatus).toBe(
        attentionBeforeRecent.status,
      );

      const nextRecentCursor = chronologicalCursor(40, "done-b");
      await act(async () => {
        pendingByFilter.get("recent")?.resolve({
          entries: [hostDone("done-b", 40, null)],
          nextCursor: nextRecentCursor,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe("idle");
      });
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        nextRecentCursor,
      );
      expect(useHostNotificationsStore.getState().byId["done-b"]).toBeDefined();
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        nextAttentionCursor,
      );
      expect(useHostNotificationsStore.getState().byId["prompt-b"]).toBe(
        attentionBeforeRecent.promptB,
      );

      // --- Interleaved in-flight: start both, resolve recent first then attention ---
      const attentionCursor2 = nextAttentionCursor;
      const attentionReqCountBefore = hostRequestMock.mock.calls.filter(
        (call) =>
          call[0] === "host.notifications.list" &&
          (call[1] as { filter?: string }).filter === "attention",
      ).length;
      const recentReqCountBefore = hostRequestMock.mock.calls.filter(
        (call) =>
          call[0] === "host.notifications.list" &&
          (call[1] as { filter?: string }).filter === "recent",
      ).length;

      fireEvent.click(screen.getByTestId("notifications-load-more-attention"));
      fireEvent.click(screen.getByTestId("notifications-load-older"));
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().attentionStatus).toBe(
          "loading",
        );
        expect(useHostNotificationsStore.getState().recentStatus).toBe(
          "loading",
        );
      });

      const attentionCursorAfter = attentionCursor(20, "prompt-c");
      const recentCursorAfter = chronologicalCursor(10, "done-c");
      await act(async () => {
        pendingByFilter.get("recent")?.resolve({
          entries: [hostDone("done-c", 10, null)],
          nextCursor: recentCursorAfter,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe("idle");
      });
      // Attention still loading; its cursor/rows untouched by recent merge.
      expect(useHostNotificationsStore.getState().attentionStatus).toBe(
        "loading",
      );
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        attentionCursor2,
      );
      expect(useHostNotificationsStore.getState().byId["done-c"]).toBeDefined();
      expect(
        useHostNotificationsStore.getState().byId["prompt-c"],
      ).toBeUndefined();

      await act(async () => {
        pendingByFilter.get("attention")?.resolve({
          entries: [hostPrompt("prompt-c", 20)],
          nextCursor: attentionCursorAfter,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().attentionStatus).toBe(
          "idle",
        );
      });
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        attentionCursorAfter,
      );
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        recentCursorAfter,
      );
      expect(
        useHostNotificationsStore.getState().byId["prompt-c"],
      ).toBeDefined();
      expect(useHostNotificationsStore.getState().byId["done-c"]).toBeDefined();

      // --- Reverse interleave: attention first, then recent ---
      fireEvent.click(screen.getByTestId("notifications-load-more-attention"));
      fireEvent.click(screen.getByTestId("notifications-load-older"));
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().attentionStatus).toBe(
          "loading",
        );
        expect(useHostNotificationsStore.getState().recentStatus).toBe(
          "loading",
        );
      });

      const attentionCursorFinal = attentionCursor(5, "prompt-d");
      const recentCursorFinal = chronologicalCursor(1, "done-d");
      await act(async () => {
        pendingByFilter.get("attention")?.resolve({
          entries: [hostPrompt("prompt-d", 5)],
          nextCursor: attentionCursorFinal,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().attentionStatus).toBe(
          "idle",
        );
      });
      expect(useHostNotificationsStore.getState().recentStatus).toBe("loading");
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        recentCursorAfter,
      );
      expect(
        useHostNotificationsStore.getState().byId["done-d"],
      ).toBeUndefined();

      await act(async () => {
        pendingByFilter.get("recent")?.resolve({
          entries: [hostDone("done-d", 1, null)],
          nextCursor: recentCursorFinal,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe("idle");
      });
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        attentionCursorFinal,
      );
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        recentCursorFinal,
      );
      expect(
        useHostNotificationsStore.getState().byId["prompt-d"],
      ).toBeDefined();
      expect(useHostNotificationsStore.getState().byId["done-d"]).toBeDefined();

      // Each track issued two more requests during the interleaved pairs.
      const attentionReqCountAfter = hostRequestMock.mock.calls.filter(
        (call) =>
          call[0] === "host.notifications.list" &&
          (call[1] as { filter?: string }).filter === "attention",
      ).length;
      const recentReqCountAfter = hostRequestMock.mock.calls.filter(
        (call) =>
          call[0] === "host.notifications.list" &&
          (call[1] as { filter?: string }).filter === "recent",
      ).length;
      expect(attentionReqCountAfter - attentionReqCountBefore).toBe(2);
      expect(recentReqCountAfter - recentReqCountBefore).toBe(2);

      // DOM reflects both tracks' merged rows without cross-contamination.
      const feedIds = new Set(
        notificationIds(screen.getAllByTestId("notification-entry")),
      );
      expect(feedIds.has("host:prompt-a")).toBe(true);
      expect(feedIds.has("host:prompt-b")).toBe(true);
      expect(feedIds.has("host:prompt-c")).toBe(true);
      expect(feedIds.has("host:prompt-d")).toBe(true);
      expect(feedIds.has("host:done-a")).toBe(true);
      expect(feedIds.has("host:done-b")).toBe(true);
      expect(feedIds.has("host:done-c")).toBe(true);
      expect(feedIds.has("host:done-d")).toBe(true);
    });

    // Zero loaded attention rows must not hide Load more when the cursor still has more.
    it("keeps Load more attention when all loaded attention rows leave and the cursor remains", async () => {
      bindHostClient();
      const cursor = attentionCursor(50, "older-prompt");
      applyHostSnapshot({
        entries: [hostPrompt("prompt", 100), hostDone("done", 90, null)],
        summary: { unreadCount: 2, attentionCount: 1 },
        recentCursor: null,
        attentionCursor: cursor,
      });

      renderPopover();
      expect(
        await screen.findByTestId("notifications-load-more-attention"),
      ).not.toBeNull();
      expect(
        notificationIds(screen.getAllByTestId("notification-entry")),
      ).toContain("host:prompt");

      // Resolve the only loaded attention row in place; host attentionCursor is
      // unchanged so canLoadMoreAttention stays true while attentionIds is empty.
      act(() => {
        useHostNotificationsStore.getState().applyReadStateFrame(["prompt"], {
          readAt: 150,
          resolvedAt: 150,
          removedIds: [],
          summary: { unreadCount: 1, attentionCount: 0 },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Needs attention")).not.toBeNull();
        expect(
          screen.getByTestId("notifications-load-more-attention"),
        ).not.toBeNull();
      });
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        cursor,
      );

      const loadMore = screen.getByTestId("notifications-load-more-attention");
      const attentionSection = loadMore.closest("section");
      expect(attentionSection).not.toBeNull();
      expect(
        attentionSection?.querySelectorAll(
          '[data-testid="notification-entry"]',
        ),
      ).toHaveLength(0);
      // Resolved prompt + done remain under Recent so the center is non-empty.
      expect(
        new Set(notificationIds(screen.getAllByTestId("notification-entry"))),
      ).toEqual(new Set(["host:prompt", "host:done"]));
    });
  });

  describe("pagination error / retry", () => {
    it("shows load-older error/retry without losing the recent cursor, then recovers", async () => {
      bindHostClient();
      const cursor = chronologicalCursor(90, "task-unread");
      applyHostSnapshot({
        entries: [hostDone("task-unread", 90, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: cursor,
        attentionCursor: null,
      });

      hostRequestMock.mockRejectedValueOnce(listError());

      renderPopover();

      fireEvent.click(await screen.findByTestId("notifications-load-older"));

      expect(
        await screen.findByTestId("notifications-load-older-error"),
      ).not.toBeNull();
      expect(
        screen.getByTestId("notifications-load-older-retry"),
      ).not.toBeNull();
      expect(screen.queryByTestId("notifications-load-older")).toBeNull();

      // Cursor must survive the error path - retry reuses it.
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(cursor);
      expect(useHostNotificationsStore.getState().recentStatus).toBe("error");

      expect(hostRequestMock).toHaveBeenCalledWith("host.notifications.list", {
        filter: "recent",
        limit: 50,
        cursor,
      });

      hostRequestMock.mockResolvedValueOnce({
        entries: [hostDone("older", 40, null)],
        nextCursor: chronologicalCursor(40, "older"),
      });

      fireEvent.click(screen.getByTestId("notifications-load-older-retry"));

      await waitFor(() => {
        expect(
          screen.queryByTestId("notifications-load-older-error"),
        ).toBeNull();
      });
      expect(useHostNotificationsStore.getState().recentStatus).toBe("idle");
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        chronologicalCursor(40, "older"),
      );
      expect(useHostNotificationsStore.getState().byId.older).toBeDefined();
      expect(hostRequestMock).toHaveBeenLastCalledWith(
        "host.notifications.list",
        {
          filter: "recent",
          limit: 50,
          cursor,
        },
      );
    });

    it("shows attention load-more error/retry against the still-current attention cursor", async () => {
      bindHostClient();
      const cursor = attentionCursor(100, "prompt");
      applyHostSnapshot({
        entries: [hostPrompt("prompt", 100), hostDone("done", 90, null)],
        summary: { unreadCount: 2, attentionCount: 1 },
        recentCursor: null,
        attentionCursor: cursor,
      });

      hostRequestMock.mockRejectedValueOnce(listError());
      renderPopover();

      fireEvent.click(
        await screen.findByTestId("notifications-load-more-attention"),
      );

      expect(
        await screen.findByTestId("notifications-load-more-attention-error"),
      ).not.toBeNull();
      expect(useHostNotificationsStore.getState().attentionCursor).toEqual(
        cursor,
      );
      expect(useHostNotificationsStore.getState().attentionStatus).toBe(
        "error",
      );
      expect(hostRequestMock).toHaveBeenCalledWith("host.notifications.list", {
        filter: "attention",
        limit: 50,
        cursor,
      });

      hostRequestMock.mockResolvedValueOnce({
        entries: [hostPrompt("older-prompt", 50)],
        nextCursor: null,
      });
      fireEvent.click(
        screen.getByTestId("notifications-load-more-attention-retry"),
      );

      await waitFor(() => {
        expect(
          screen.queryByTestId("notifications-load-more-attention-error"),
        ).toBeNull();
      });
      expect(useHostNotificationsStore.getState().attentionStatus).toBe("idle");
      expect(useHostNotificationsStore.getState().attentionCursor).toBeNull();
      expect(
        useHostNotificationsStore.getState().byId["older-prompt"],
      ).toBeDefined();
    });

    it("hydrates Unread-only with a null unreadRecent cursor on first load", async () => {
      bindHostClient();
      applyHostSnapshot({
        entries: [hostDone("task-unread", 90, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: chronologicalCursor(90, "task-unread"),
        attentionCursor: null,
      });
      // unreadRecentCursor starts null after applySnapshot; hasLoadedOnce is
      // false so canLoadMoreUnreadRecent still exposes the footer pre-hydration.
      expect(
        useHostNotificationsStore.getState().unreadRecentCursor,
      ).toBeNull();
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(false);

      hostRequestMock.mockResolvedValueOnce({
        entries: [hostDone("unread-page", 40, null)],
        nextCursor: chronologicalCursor(40, "unread-page"),
      });

      renderPopover();
      await screen.findByTestId("notifications-popover");

      // Drive Unread-only via the store (same path the filter menu uses) so
      // the first-page hydration call is independent of menu portal timing.
      act(() => {
        useNotificationsPopoverStore.getState().setUnreadOnly(true);
      });

      // Footer still available before any unreadRecent page has loaded.
      fireEvent.click(await screen.findByTestId("notifications-load-older"));

      await waitFor(() => {
        expect(hostRequestMock).toHaveBeenCalledWith(
          "host.notifications.list",
          {
            filter: "unreadRecent",
            limit: 50,
            cursor: undefined,
          },
        );
      });
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().unreadRecentCursor).toEqual(
          chronologicalCursor(40, "unread-page"),
        );
        expect(
          useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
        ).toBe(true);
      });
      // Non-null cursor keeps the footer available for the next page.
      expect(screen.getByTestId("notifications-load-older")).not.toBeNull();
    });

    it("hides Unread-only Load older after a successful exhausted page (null nextCursor)", async () => {
      bindHostClient();
      applyHostSnapshot({
        entries: [hostDone("task-unread", 90, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: chronologicalCursor(90, "task-unread"),
        attentionCursor: null,
      });
      expect(
        useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
      ).toBe(false);

      hostRequestMock.mockResolvedValueOnce({
        entries: [hostDone("last-unread", 40, null)],
        nextCursor: null,
      });

      renderPopover();
      await screen.findByTestId("notifications-popover");

      act(() => {
        useNotificationsPopoverStore.getState().setUnreadOnly(true);
      });

      // Pre-hydration: footer still present so the first page can load.
      fireEvent.click(await screen.findByTestId("notifications-load-older"));

      await waitFor(() => {
        expect(
          useHostNotificationsStore.getState().unreadRecentHasLoadedOnce,
        ).toBe(true);
        expect(
          useHostNotificationsStore.getState().unreadRecentCursor,
        ).toBeNull();
      });
      // Exhausted: canLoadMoreUnreadRecent is false — footer gone entirely
      // (not merely swapped into the error/retry chrome).
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-load-older")).toBeNull();
        expect(
          screen.queryByTestId("notifications-load-older-error"),
        ).toBeNull();
        expect(
          screen.queryByTestId("notifications-load-older-retry"),
        ).toBeNull();
      });
    });

    it("routes Unread-only footer errors to the unreadRecent status track", async () => {
      bindHostClient();
      applyHostSnapshot({
        entries: [hostDone("task-unread", 90, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: chronologicalCursor(90, "task-unread"),
        attentionCursor: null,
      });
      hostRequestMock.mockRejectedValueOnce(listError());
      renderPopover();
      await screen.findByTestId("notifications-popover");

      act(() => {
        useNotificationsPopoverStore.getState().setUnreadOnly(true);
      });
      fireEvent.click(await screen.findByTestId("notifications-load-older"));

      expect(
        await screen.findByTestId("notifications-load-older-error"),
      ).not.toBeNull();
      expect(useHostNotificationsStore.getState().unreadRecentStatus).toBe(
        "error",
      );
      // Recent track must remain independent.
      expect(useHostNotificationsStore.getState().recentStatus).toBe("idle");
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        chronologicalCursor(90, "task-unread"),
      );
    });
  });

  describe("N-new arrivals integration", () => {
    it("shows the sticky pill while scrolled, clears on click (scroll + reveal), and on natural return to top", async () => {
      applyHostSnapshot({
        entries: [hostDone("baseline", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionCursor: null,
      });
      renderPopover();

      await screen.findByTestId("notification-entry");
      const scrollport = screen.getByTestId("notifications-feed-scrollport");
      expect(screen.queryByTestId("notifications-new-arrivals")).toBeNull();

      setScrollTop(scrollport, 80);

      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("live-new", 200, null), [], {
            unreadCount: 2,
            attentionCount: 0,
          });
      });

      const pill = await screen.findByTestId("notifications-new-arrivals");
      expect(pill.textContent).toMatch(/1 new notification$/);

      const scrollToSpy = vi.fn();
      scrollport.scrollTo = scrollToSpy as typeof scrollport.scrollTo;

      fireEvent.click(pill);

      expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-new-arrivals")).toBeNull();
      });

      // Natural return to top also clears without requiring another click.
      setScrollTop(scrollport, 80);
      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("live-new-2", 300, null), [], {
            unreadCount: 3,
            attentionCount: 0,
          });
      });
      expect(
        await screen.findByTestId("notifications-new-arrivals"),
      ).not.toBeNull();

      setScrollTop(scrollport, 0);
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-new-arrivals")).toBeNull();
      });
    });

    it("never promotes pre-baseline rows to new when a filter reveals them", async () => {
      applyHostSnapshot({
        entries: [hostDone("task", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionCursor: null,
      });
      const stream = openGlobalStream();
      stream.seed([globalEntry("collab-pre", 50, null)]);

      renderPopover();
      await screen.findByText("Recent activity");

      // Hide collaboration while at top so it is part of the full baseline.
      fireEvent.pointerDown(
        screen.getByTestId("notifications-filter-trigger"),
        {
          button: 0,
        },
      );
      fireEvent.click(
        await screen.findByTestId(
          "notifications-filter-category-collaboration",
        ),
      );
      await waitFor(() => {
        expect(
          notificationIds(screen.getAllByTestId("notification-entry")),
        ).toEqual(["host:task"]);
      });

      const scrollport = screen.getByTestId("notifications-feed-scrollport");
      setScrollTop(scrollport, 80);

      // Live task arrival should count.
      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("task-new", 200, null), [], {
            unreadCount: 2,
            attentionCount: 0,
          });
      });
      expect(
        (await screen.findByTestId("notifications-new-arrivals")).textContent,
      ).toMatch(/1 new notification$/);

      // Re-enable collaboration: the pre-baseline collab row must not bump N.
      fireEvent.click(
        await screen.findByTestId(
          "notifications-filter-category-collaboration",
        ),
      );
      await waitFor(() => {
        expect(
          notificationIds(screen.getAllByTestId("notification-entry")),
        ).toContain("global:collab-pre");
      });
      expect(
        screen.getByTestId("notifications-new-arrivals").textContent,
      ).toMatch(/1 new notification$/);
    });

    it("uses singular/plural copy for the N-new pill", async () => {
      applyHostSnapshot({
        entries: [hostDone("baseline", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionCursor: null,
      });
      renderPopover();
      await screen.findByTestId("notification-entry");
      setScrollTop(screen.getByTestId("notifications-feed-scrollport"), 80);

      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("n1", 200, null), [], {
            unreadCount: 2,
            attentionCount: 0,
          });
      });
      expect(
        (await screen.findByTestId("notifications-new-arrivals")).textContent,
      ).toBe("1 new notification");

      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("n2", 300, null), [], {
            unreadCount: 3,
            attentionCount: 0,
          });
      });
      await waitFor(() => {
        expect(
          screen.getByTestId("notifications-new-arrivals").textContent,
        ).toBe("2 new notifications");
      });
    });

    it("counts a same-feedId host recurrence via applyUpsertFrame as 1 new", async () => {
      // Closure-review P0: store replaces byId[id] in place, so the prior
      // occurrence key never survives. A scrolled user must still see N-new
      // for a genuine recurrence (stable id, newer updatedAt).
      applyHostSnapshot({
        entries: [hostDone("approval-1", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionCursor: null,
      });
      renderPopover();
      await screen.findByTestId("notification-entry");
      expect(
        screen.getByTestId("notification-entry").dataset.notificationId,
      ).toBe("host:approval-1");

      setScrollTop(screen.getByTestId("notifications-feed-scrollport"), 80);

      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("approval-1", 250, null), [], {
            unreadCount: 1,
            attentionCount: 0,
          });
      });

      const pill = await screen.findByTestId("notifications-new-arrivals");
      expect(pill.textContent).toBe("1 new notification");
      // Still a single DOM row for the stable feedId (store replaced in place).
      expect(screen.getAllByTestId("notification-entry")).toHaveLength(1);
      expect(
        useHostNotificationsStore.getState().byId["approval-1"].updatedAt,
      ).toBe(250);
    });

    it("does not count a same-timestamp retitle via applyUpsertFrame as new", async () => {
      applyHostSnapshot({
        entries: [hostDone("approval-1", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionCursor: null,
      });
      renderPopover();
      await screen.findByTestId("notification-entry");
      setScrollTop(screen.getByTestId("notifications-feed-scrollport"), 80);

      // Same id + same updatedAt, only task title content changes - occurrence
      // key is feedId@updatedAt and is unchanged.
      const retitled: HostNotificationEntry = {
        ...hostDone("approval-1", 100, null),
        payload: {
          kind: "chat",
          epicId: "epic-1",
          chatId: "chat-1",
          agentName: "Agent",
          taskTitle: "Retitled checkout notification",
          outcome: "completed",
        },
      };

      act(() => {
        useHostNotificationsStore.getState().applyUpsertFrame(retitled, [], {
          unreadCount: 1,
          attentionCount: 0,
        });
      });

      // Give the hook a turn to re-render if it were going to mint a count.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId("notifications-new-arrivals")).toBeNull();
      expect(
        useHostNotificationsStore.getState().byId["approval-1"].updatedAt,
      ).toBe(100);
    });
  });

  describe("geometry regression across feed control transitions", () => {
    it("keeps the locked shell size across pagination error, retry, N-new pill, and filter switch", async () => {
      bindHostClient();
      getBoundingClientRectSpy = vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: Element) {
          if (
            this instanceof HTMLElement &&
            this.getAttribute("data-testid") === "notifications-popover"
          ) {
            return makeDomRect(420, 260);
          }
          return makeDomRect(0, 0);
        });
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 1280,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: 900,
      });
      document.documentElement.style.fontSize = "16px";

      applyHostSnapshot({
        entries: [
          hostPrompt("prompt", 100),
          hostDone("task-unread", 90, null),
          hostDone("task-read", 80, 10),
        ],
        summary: { unreadCount: 2, attentionCount: 1 },
        recentCursor: chronologicalCursor(80, "task-read"),
        attentionCursor: attentionCursor(100, "prompt"),
      });

      renderGeometryPopover();
      const shell = await screen.findByTestId("notifications-popover");
      forcePopperPlacement(shell);
      const locked = await waitForGeometryLock(shell);

      // Pagination error + retry.
      hostRequestMock.mockRejectedValueOnce(listError());
      fireEvent.click(await screen.findByTestId("notifications-load-older"));
      expect(
        await screen.findByTestId("notifications-load-older-error"),
      ).not.toBeNull();
      expect(shell.style.width).toBe(locked.width);
      expect(shell.style.height).toBe(locked.height);

      hostRequestMock.mockResolvedValueOnce({
        entries: [hostDone("older", 40, null)],
        nextCursor: null,
      });
      fireEvent.click(screen.getByTestId("notifications-load-older-retry"));
      await waitFor(() => {
        expect(
          screen.queryByTestId("notifications-load-older-error"),
        ).toBeNull();
      });
      expect(shell.style.width).toBe(locked.width);
      expect(shell.style.height).toBe(locked.height);

      // N-new pill appear/disappear.
      const scrollport = screen.getByTestId("notifications-feed-scrollport");
      setScrollTop(scrollport, 80);
      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("live", 300, null), [], {
            unreadCount: 3,
            attentionCount: 1,
          });
      });
      expect(
        await screen.findByTestId("notifications-new-arrivals"),
      ).not.toBeNull();
      expect(shell.style.width).toBe(locked.width);
      expect(shell.style.height).toBe(locked.height);

      setScrollTop(scrollport, 0);
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-new-arrivals")).toBeNull();
      });
      expect(shell.style.width).toBe(locked.width);
      expect(shell.style.height).toBe(locked.height);

      // Filter switch.
      fireEvent.pointerDown(
        screen.getByTestId("notifications-filter-trigger"),
        {
          button: 0,
        },
      );
      fireEvent.click(
        await screen.findByTestId("notifications-filter-unread-only"),
      );
      await waitFor(() => {
        expect(useNotificationsPopoverStore.getState().unreadOnly).toBe(true);
      });
      expect(shell.style.width).toBe(locked.width);
      expect(shell.style.height).toBe(locked.height);

      document.documentElement.style.fontSize = "";
    });
  });

  describe("pagination and arrival analytics", () => {
    it("tracks notification_page_loaded success and failure for recent and attention", async () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      bindHostClient();
      const recentCursor = chronologicalCursor(90, "task-unread");
      const attentionCursorValue = attentionCursor(100, "prompt");
      applyHostSnapshot({
        entries: [hostPrompt("prompt", 100), hostDone("task-unread", 90, null)],
        summary: { unreadCount: 2, attentionCount: 1 },
        recentCursor,
        attentionCursor: attentionCursorValue,
      });

      hostRequestMock.mockResolvedValueOnce({
        entries: [
          hostDone("older-1", 40, null),
          hostDone("older-2", 39, null),
          hostDone("older-3", 38, null),
        ],
        nextCursor: chronologicalCursor(38, "older-3"),
      });
      renderPopover();

      fireEvent.click(await screen.findByTestId("notifications-load-older"));
      await waitFor(() => {
        expect(
          useHostNotificationsStore.getState().byId["older-1"],
        ).toBeDefined();
      });

      const recentSuccess = trackSpy.mock.calls.filter(
        (call) =>
          call[0] === AnalyticsEvent.NotificationPageLoaded &&
          call[1] !== null &&
          typeof call[1] === "object" &&
          "section" in call[1] &&
          call[1].section === "recent" &&
          call[1].outcome === "success",
      );
      expect(recentSuccess).toHaveLength(1);
      expect(recentSuccess[0]?.[1]).toEqual({
        section: "recent",
        outcome: "success",
        result_count_bucket: "2-5",
        has_more: true,
      });

      hostRequestMock.mockRejectedValueOnce(listError());
      fireEvent.click(screen.getByTestId("notifications-load-older"));
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe("error");
      });
      const recentFailure = trackSpy.mock.calls.filter(
        (call) =>
          call[0] === AnalyticsEvent.NotificationPageLoaded &&
          call[1] !== null &&
          typeof call[1] === "object" &&
          "section" in call[1] &&
          call[1].section === "recent" &&
          call[1].outcome === "failure",
      );
      expect(recentFailure).toHaveLength(1);
      expect(recentFailure[0]?.[1]).toEqual({
        section: "recent",
        outcome: "failure",
        result_count_bucket: null,
        has_more: null,
      });

      hostRequestMock.mockResolvedValueOnce({
        entries: [hostPrompt("older-prompt", 50)],
        nextCursor: null,
      });
      fireEvent.click(screen.getByTestId("notifications-load-more-attention"));
      await waitFor(() => {
        expect(
          useHostNotificationsStore.getState().byId["older-prompt"],
        ).toBeDefined();
      });
      const attentionSuccess = trackSpy.mock.calls.filter(
        (call) =>
          call[0] === AnalyticsEvent.NotificationPageLoaded &&
          call[1] !== null &&
          typeof call[1] === "object" &&
          "section" in call[1] &&
          call[1].section === "attention" &&
          call[1].outcome === "success",
      );
      expect(attentionSuccess).toHaveLength(1);
      expect(attentionSuccess[0]?.[1]).toEqual({
        section: "attention",
        outcome: "success",
        result_count_bucket: "1",
        has_more: false,
      });

      // Re-seed attention cursor for a failure pass.
      act(() => {
        useHostNotificationsStore.getState().applySnapshot({
          attention: {
            entries: [hostPrompt("prompt", 100)],
            nextCursor: attentionCursor(100, "prompt"),
          },
          recent: {
            entries: [hostDone("task-unread", 90, null)],
            nextCursor: null,
          },
          summary: { unreadCount: 2, attentionCount: 1 },
        });
      });
      hostRequestMock.mockRejectedValueOnce(listError());
      fireEvent.click(
        await screen.findByTestId("notifications-load-more-attention"),
      );
      await waitFor(() => {
        expect(useHostNotificationsStore.getState().attentionStatus).toBe(
          "error",
        );
      });
      const attentionFailure = trackSpy.mock.calls.filter(
        (call) =>
          call[0] === AnalyticsEvent.NotificationPageLoaded &&
          call[1] !== null &&
          typeof call[1] === "object" &&
          "section" in call[1] &&
          call[1].section === "attention" &&
          call[1].outcome === "failure",
      );
      expect(attentionFailure).toHaveLength(1);
      expect(attentionFailure[0]?.[1]).toEqual({
        section: "attention",
        outcome: "failure",
        result_count_bucket: null,
        has_more: null,
      });

      trackSpy.mockRestore();
    });

    it("emits no page_loaded event when a pagination response is discarded as stale", async () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      bindHostClient();
      const cursor = chronologicalCursor(90, "task-unread");
      applyHostSnapshot({
        entries: [hostDone("task-unread", 90, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: cursor,
        attentionCursor: null,
      });

      let resolveList: (value: {
        readonly entries: ReadonlyArray<HostNotificationEntry>;
        readonly nextCursor: HostNotificationsChronologicalCursor | null;
      }) => void = () => undefined;
      hostRequestMock.mockImplementation((method: string) => {
        if (method === "host.notifications.list") {
          return new Promise((resolve) => {
            resolveList = resolve;
          });
        }
        return Promise.resolve({});
      });

      renderPopover();
      fireEvent.click(await screen.findByTestId("notifications-load-older"));

      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe(
          "loading",
        );
      });

      // Bump snapshotEpoch mid-flight so the deferred response is stale.
      act(() => {
        useHostNotificationsStore.getState().applySnapshot({
          attention: { entries: [], nextCursor: null },
          recent: {
            entries: [hostDone("task-unread", 90, null)],
            nextCursor: cursor,
          },
          summary: { unreadCount: 1, attentionCount: 0 },
        });
      });

      await act(async () => {
        resolveList({
          entries: [hostDone("stale-older", 40, null)],
          nextCursor: null,
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        useHostNotificationsStore.getState().byId["stale-older"],
      ).toBeUndefined();
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationPageLoaded,
        ),
      ).toHaveLength(0);
      trackSpy.mockRestore();
    });

    it("emits no page_loaded success when an ordinary live frame crosses the request (same epoch)", async () => {
      // An ordinary live upsert bumps liveLifecycleRevision without touching
      // snapshotEpoch, so host/epoch equality alone would wrongly treat the
      // crossed response as current. The store's merge already rejects it;
      // this proves the analytics tracker uses the identical revision guard
      // rather than a looser one.
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      bindHostClient();
      const cursor = chronologicalCursor(90, "task-unread");
      applyHostSnapshot({
        entries: [hostDone("task-unread", 90, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: cursor,
        attentionCursor: null,
      });

      let resolveList: (value: {
        readonly entries: ReadonlyArray<HostNotificationEntry>;
        readonly nextCursor: HostNotificationsChronologicalCursor | null;
      }) => void = () => undefined;
      hostRequestMock.mockImplementation((method: string) => {
        if (method === "host.notifications.list") {
          return new Promise((resolve) => {
            resolveList = resolve;
          });
        }
        return Promise.resolve({});
      });

      renderPopover();
      fireEvent.click(await screen.findByTestId("notifications-load-older"));

      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe(
          "loading",
        );
      });

      // A live arrival crosses the in-flight request: same host, same
      // snapshotEpoch, but liveLifecycleRevision advances.
      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("live-new", 200, null), [], {
            unreadCount: 2,
            attentionCount: 0,
          });
      });

      await act(async () => {
        resolveList({
          entries: [hostDone("crossed-older", 40, null)],
          nextCursor: null,
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        useHostNotificationsStore.getState().byId["crossed-older"],
      ).toBeUndefined();
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationPageLoaded,
        ),
      ).toHaveLength(0);
      trackSpy.mockRestore();
    });

    it("keeps stale Load-older rows out of the feed DOM after a live upsert crosses the request", async () => {
      // Complement to the analytics-only same-epoch race above: assert the
      // rendered feed never shows the discarded page's rows, the Load older
      // control recovers to a usable idle state, and a subsequent real load
      // still uses the unchanged cursor.
      bindHostClient();
      const cursor = chronologicalCursor(90, "task-unread");
      applyHostSnapshot({
        entries: [hostDone("task-unread", 90, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: cursor,
        attentionCursor: null,
      });

      const listResolvers: Array<
        (value: {
          readonly entries: ReadonlyArray<HostNotificationEntry>;
          readonly nextCursor: HostNotificationsChronologicalCursor | null;
        }) => void
      > = [];
      hostRequestMock.mockImplementation((method: string) => {
        if (method === "host.notifications.list") {
          return new Promise((resolve) => {
            listResolvers.push(resolve);
          });
        }
        return Promise.resolve({});
      });

      renderPopover();
      fireEvent.click(await screen.findByTestId("notifications-load-older"));

      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe(
          "loading",
        );
      });
      expect(listResolvers).toHaveLength(1);

      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("live-new", 200, null), [], {
            unreadCount: 2,
            attentionCount: 0,
          });
      });

      await act(async () => {
        listResolvers[0]?.({
          entries: [hostDone("stale-page-row", 40, null)],
          nextCursor: chronologicalCursor(40, "stale-page-row"),
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(useHostNotificationsStore.getState().recentStatus).toBe("idle");
      });
      expect(
        useHostNotificationsStore.getState().byId["stale-page-row"],
      ).toBeUndefined();
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(cursor);

      const feedIds = notificationIds(
        screen.getAllByTestId("notification-entry"),
      );
      expect(feedIds).not.toContain("host:stale-page-row");
      expect(feedIds).toContain("host:task-unread");
      expect(feedIds).toContain("host:live-new");

      // Control is usable again with the original cursor.
      expect(screen.getByTestId("notifications-load-older")).not.toBeNull();
      expect(screen.queryByTestId("notifications-load-older-error")).toBeNull();

      fireEvent.click(screen.getByTestId("notifications-load-older"));
      await waitFor(() => {
        expect(listResolvers).toHaveLength(2);
      });
      expect(hostRequestMock).toHaveBeenLastCalledWith(
        "host.notifications.list",
        {
          filter: "recent",
          limit: 50,
          cursor,
        },
      );

      await act(async () => {
        listResolvers[1]?.({
          entries: [hostDone("real-older", 40, null)],
          nextCursor: chronologicalCursor(40, "real-older"),
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(
          useHostNotificationsStore.getState().byId["real-older"],
        ).toBeDefined();
      });
      expect(useHostNotificationsStore.getState().recentCursor).toEqual(
        chronologicalCursor(40, "real-older"),
      );
      expect(
        notificationIds(screen.getAllByTestId("notification-entry")),
      ).toContain("host:real-older");
      expect(
        notificationIds(screen.getAllByTestId("notification-entry")),
      ).not.toContain("host:stale-page-row");
    });

    it("tracks notification_new_revealed with the arrival count bucket before clear", async () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      applyHostSnapshot({
        entries: [hostDone("baseline", 100, null)],
        summary: { unreadCount: 1, attentionCount: 0 },
        recentCursor: null,
        attentionCursor: null,
      });
      renderPopover();

      await screen.findByTestId("notification-entry");
      const scrollport = screen.getByTestId("notifications-feed-scrollport");
      setScrollTop(scrollport, 80);

      act(() => {
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("live-new-a", 200, null), [], {
            unreadCount: 2,
            attentionCount: 0,
          });
        useHostNotificationsStore
          .getState()
          .applyUpsertFrame(hostDone("live-new-b", 210, null), [], {
            unreadCount: 3,
            attentionCount: 0,
          });
      });

      const pill = await screen.findByTestId("notifications-new-arrivals");
      scrollport.scrollTo = vi.fn() as typeof scrollport.scrollTo;
      fireEvent.click(pill);

      const revealed = trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationNewRevealed,
      );
      expect(revealed).toHaveLength(1);
      expect(revealed[0]?.[1]).toEqual({ count_bucket: "2-5" });
      trackSpy.mockRestore();
    });
  });
});
