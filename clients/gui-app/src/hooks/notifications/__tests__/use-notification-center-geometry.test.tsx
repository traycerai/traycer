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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
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
import {
  computeInitialNotificationCenterGeometryLock,
  computeNotificationCenterGeometryCaps,
  computeShrunkNotificationCenterGeometryLock,
  NOTIFICATION_CENTER_COLD_OPEN_FLOOR_REM,
  NOTIFICATION_CENTER_HEIGHT_CAP_REM,
  NOTIFICATION_CENTER_WIDTH_CAP_REM,
  useNotificationCenterGeometry,
} from "@/hooks/notifications/use-notification-center-geometry";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import {
  type NotificationEntry,
  NOTIFICATION_EVENT_TYPES,
} from "@traycer/protocol/notifications/notification-entry";
import {
  createNotificationRoomEntryMap,
  NOTIFICATIONS_ARRAY_KEY,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import * as Y from "yjs";

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));

const hostBindingState = vi.hoisted<{ current: null }>(() => ({
  current: null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => activeHostIdRef.value,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0 || directoryRef.value === null) return null;
    return directoryRef.value.findById(hostId);
  },
}));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingState.current,
  };
});

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function buildSnapshot(entries: ReadonlyArray<NotificationEntry>): Uint8Array {
  const donor = new Y.Doc();
  const arr = donor.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  donor.transact(() => {
    for (const entry of entries) {
      arr.push([createNotificationRoomEntryMap(entry)]);
    }
  });
  return Y.encodeStateAsUpdate(donor);
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
      current.onSnapshot({ schemaVersion: "2" }, buildSnapshot(entries));
    },
  };
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

async function waitForGeometryLock(
  shell: HTMLElement,
): Promise<{ readonly width: string; readonly height: string }> {
  await waitFor(() => {
    expect(shell.style.width.length).toBeGreaterThan(0);
    expect(shell.style.height.length).toBeGreaterThan(0);
  });
  return { width: shell.style.width, height: shell.style.height };
}

function forcePopperPlacement(shell: HTMLElement): void {
  const wrapper = shell.closest<HTMLElement>(
    "[data-radix-popper-content-wrapper]",
  );
  if (wrapper === null) {
    throw new Error("missing radix popper content wrapper");
  }
  // Drive the exact placement gate the production hook watches.
  act(() => {
    wrapper.style.transform = "translate(0, -200%)";
  });
  act(() => {
    wrapper.style.transform = "translate(0px, 0px)";
  });
}

interface GeometryHarnessProps {
  readonly open: boolean;
  readonly isColdOpen: boolean;
}

/**
 * Minimal deterministic harness: a Popper wrapper ancestor + real
 * NotificationsPopover content. Avoids Radix portal timing flakes while
 * still exercising the placement-gated lock + shrink paths.
 */
function GeometryHarness(props: GeometryHarnessProps): ReactNode {
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

function mountGeometryHarness(input: {
  readonly open: boolean;
  readonly isColdOpen: boolean;
}): void {
  const queryClient = createTestQueryClient();
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <GeometryHarness open={input.open} isColdOpen={input.isColdOpen} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("computeNotificationCenterGeometryCaps", () => {
  it("picks the smaller of viewport fraction and rem caps", () => {
    const rootFontSizePx = 16;
    const caps = computeNotificationCenterGeometryCaps({
      viewportWidthPx: 2000,
      viewportHeightPx: 2000,
      radixAvailableWidthPx: 10_000,
      radixAvailableHeightPx: 10_000,
      rootFontSizePx,
    });
    expect(caps.widthCapPx).toBe(
      rootFontSizePx * NOTIFICATION_CENTER_WIDTH_CAP_REM,
    );
    expect(caps.heightCapPx).toBe(
      rootFontSizePx * NOTIFICATION_CENTER_HEIGHT_CAP_REM,
    );

    const narrow = computeNotificationCenterGeometryCaps({
      viewportWidthPx: 400,
      viewportHeightPx: 500,
      radixAvailableWidthPx: 10_000,
      radixAvailableHeightPx: 10_000,
      rootFontSizePx,
    });
    expect(narrow.widthCapPx).toBe(400 * 0.9);
    expect(narrow.heightCapPx).toBe(500 * 0.7);
  });

  it("includes radix available height in the height cap min", () => {
    const caps = computeNotificationCenterGeometryCaps({
      viewportWidthPx: 2000,
      viewportHeightPx: 2000,
      radixAvailableWidthPx: 10_000,
      radixAvailableHeightPx: 120,
      rootFontSizePx: 16,
    });
    expect(caps.heightCapPx).toBe(120);
  });

  it("includes radix available width in the width cap min", () => {
    const caps = computeNotificationCenterGeometryCaps({
      viewportWidthPx: 2000,
      viewportHeightPx: 2000,
      radixAvailableWidthPx: 90,
      radixAvailableHeightPx: 10_000,
      rootFontSizePx: 16,
    });
    expect(caps.widthCapPx).toBe(90);
  });
});

describe("computeInitialNotificationCenterGeometryLock", () => {
  it("clamps measured size to caps without cold-open floor", () => {
    const lock = computeInitialNotificationCenterGeometryLock({
      measuredWidthPx: 900,
      measuredHeightPx: 900,
      caps: { widthCapPx: 500, heightCapPx: 400 },
      isColdOpen: false,
      rootFontSizePx: 16,
    });
    expect(lock).toEqual({ width: 500, height: 400 });
  });

  it("raises height to the cold-open floor when still below the cap", () => {
    const lock = computeInitialNotificationCenterGeometryLock({
      measuredWidthPx: 300,
      measuredHeightPx: 100,
      caps: { widthCapPx: 500, heightCapPx: 800 },
      isColdOpen: true,
      rootFontSizePx: 16,
    });
    expect(lock.width).toBe(300);
    expect(lock.height).toBe(16 * NOTIFICATION_CENTER_COLD_OPEN_FLOOR_REM);
  });

  it("never lets the cold-open floor exceed the height cap", () => {
    const lock = computeInitialNotificationCenterGeometryLock({
      measuredWidthPx: 100,
      measuredHeightPx: 50,
      caps: { widthCapPx: 500, heightCapPx: 200 },
      isColdOpen: true,
      rootFontSizePx: 16,
    });
    expect(lock.height).toBe(200);
  });
});

describe("computeShrunkNotificationCenterGeometryLock", () => {
  it("returns the same object reference when caps are larger than prev", () => {
    const prev = { width: 400, height: 300 };
    const next = computeShrunkNotificationCenterGeometryLock(prev, {
      widthCapPx: 800,
      heightCapPx: 700,
    });
    expect(next).toBe(prev);
  });

  it("shrinks only when caps are smaller than prev", () => {
    const prev = { width: 400, height: 300 };
    const next = computeShrunkNotificationCenterGeometryLock(prev, {
      widthCapPx: 250.4,
      heightCapPx: 180.6,
    });
    expect(next).toEqual({ width: 250, height: 181 });
    expect(next).not.toBe(prev);
  });
});

describe("useNotificationCenterGeometry integration", () => {
  let rectWidth = 420;
  let rectHeight = 260;
  let getBoundingClientRectSpy: {
    mockRestore: () => void;
  } | null = null;

  beforeEach(() => {
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    useNotificationsPopoverStore.getState().setOpen(false);
    hostBindingState.current = null;
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
    rectWidth = 420;
    rectHeight = 260;
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

    getBoundingClientRectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (
          this instanceof HTMLElement &&
          this.getAttribute("data-testid") === "notifications-popover"
        ) {
          return makeDomRect(rectWidth, rectHeight);
        }
        return makeDomRect(0, 0);
      });
  });

  afterEach(() => {
    cleanup();
    if (getBoundingClientRectSpy !== null) {
      getBoundingClientRectSpy.mockRestore();
    }
    useNotificationsPopoverStore.getState().setOpen(false);
    document.documentElement.style.fontSize = "";
    vi.useRealTimers();
  });

  async function openAndLock(input: {
    readonly isColdOpen: boolean;
  }): Promise<HTMLElement> {
    mountGeometryHarness({
      open: true,
      isColdOpen: input.isColdOpen,
    });
    const shell = await screen.findByTestId("notifications-popover");
    forcePopperPlacement(shell);
    await waitForGeometryLock(shell);
    return shell;
  }

  it("freezes the shell rect across content and filter transitions", async () => {
    const stream = openGlobalStream();
    const shell = await openAndLock({ isColdOpen: false });
    const locked = {
      width: shell.style.width,
      height: shell.style.height,
    };

    act(() => {
      stream.seed([
        {
          id: "g1",
          createdAt: Date.now() - 150_000,
          readAt: null,
          event: {
            kind: NOTIFICATION_EVENT_TYPES.INVITED,
            epicId: "epic-1",
            actorName: "Alice",
          },
        },
      ]);
      useHostNotificationsStore.getState().applySnapshot({
        attention: {
          entries: [
            {
              id: "prompt",
              updatedAt: Date.now(),
              readAt: null,
              kind: "approval.requested",
              sourceRef: "prompt",
              severity: "needs_action",
              outcome: null,
              resolvedAt: null,
              epicId: "epic-1",
              chatId: "chat-1",
              payload: {
                kind: "approval",
                epicId: "epic-1",
                chatId: "chat-1",
                chatTitle: "Chat",
                taskTitle: "Task",
                approvalId: "prompt",
              },
            },
          ],
          nextCursor: null,
        },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 1, attentionCount: 1 },
      });
    });

    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    fireEvent.pointerDown(screen.getByTestId("notifications-filter-trigger"), {
      button: 0,
    });
    fireEvent.click(
      await screen.findByTestId("notifications-filter-unread-only"),
    );

    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: {
          entries: [],
          nextCursor: {
            kind: "attention",
            tier: "failure",
            updatedAt: Date.now(),
            id: "cursor-1",
          },
        },
        recent: {
          entries: [],
          nextCursor: {
            kind: "chronological",
            updatedAt: Date.now(),
            id: "cursor-2",
          },
        },
        summary: { unreadCount: 0, attentionCount: 0 },
      });
      useAppLocalNotificationsStore.getState().activateIdentity("user-a");
      useAppLocalNotificationsStore.getState().upsert({
        id: "a1",
        updatedAt: Date.now(),
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "a1",
        payload: null,
        message: "failed",
        detail: null,
      });
    });

    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);
  });

  it("applies the cold-open floor when isColdOpen is true at open", async () => {
    rectHeight = 80;
    const shell = await openAndLock({ isColdOpen: true });
    const expectedFloor = 16 * NOTIFICATION_CENTER_COLD_OPEN_FLOOR_REM;
    expect(Number.parseFloat(shell.style.height)).toBe(expectedFloor);

    // Content transitions after lock must not retract the floor.
    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });
    expect(Number.parseFloat(shell.style.height)).toBe(expectedFloor);
  });

  it("does not apply the cold-open floor when isColdOpen is false at open", async () => {
    rectHeight = 80;
    const shell = await openAndLock({ isColdOpen: false });
    expect(Number.parseFloat(shell.style.height)).toBe(80);
  });

  it("captures isColdOpen at the open transition, not at placement time", async () => {
    rectHeight = 80;
    const expectedFloor = 16 * NOTIFICATION_CENTER_COLD_OPEN_FLOOR_REM;

    function ColdOpenTransitionHarness(props: {
      readonly isColdOpen: boolean;
    }): ReactNode {
      const { shellRef, style } = useNotificationCenterGeometry({
        open: true,
        isColdOpen: props.isColdOpen,
      });
      return (
        <div
          data-radix-popper-content-wrapper=""
          style={{ transform: "translate(0, -200%)" }}
        >
          <div
            ref={shellRef}
            data-testid="notifications-popover"
            style={style}
          />
        </div>
      );
    }

    const { rerender } = render(<ColdOpenTransitionHarness isColdOpen />);
    const shell = await screen.findByTestId("notifications-popover");

    // The host summary lands (isColdOpen flips to false) before Radix
    // resolves placement. The floor must still apply: it was captured at
    // the open transition, not resampled here.
    rerender(<ColdOpenTransitionHarness isColdOpen={false} />);

    forcePopperPlacement(shell);
    await waitForGeometryLock(shell);
    expect(Number.parseFloat(shell.style.height)).toBe(expectedFloor);
  });

  it("shrinks on viewport shrink and never grows back on a later enlarge", async () => {
    const shell = await openAndLock({ isColdOpen: false });
    const initialWidth = Number.parseFloat(shell.style.width);
    const initialHeight = Number.parseFloat(shell.style.height);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 300,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 200,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(Number.parseFloat(shell.style.width)).toBeLessThan(initialWidth);
      expect(Number.parseFloat(shell.style.height)).toBeLessThan(initialHeight);
    });
    const shrunkWidth = Number.parseFloat(shell.style.width);
    const shrunkHeight = Number.parseFloat(shell.style.height);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1600,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(Number.parseFloat(shell.style.width)).toBe(shrunkWidth);
    expect(Number.parseFloat(shell.style.height)).toBe(shrunkHeight);
  });

  it("holds the outer rect across pending and failure row content states", async () => {
    // Pending/failure only change opacity/disabled/data attrs - not the
    // outer shell geometry. Seed enough content for a stable locked rect,
    // then flip a row into pending via data-notification-pending is owned
    // by activation (tested elsewhere); here we assert content churn that
    // mirrors pending/failure (opacity-disabled sibling, failure severity
    // swap) never mutates the frozen outer width/height.
    const shell = await openAndLock({ isColdOpen: false });
    const locked = {
      width: shell.style.width,
      height: shell.style.height,
    };

    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: {
          entries: [
            {
              id: "prompt-pending",
              updatedAt: Date.now(),
              readAt: null,
              kind: "approval.requested",
              sourceRef: "prompt-pending",
              severity: "needs_action",
              outcome: null,
              resolvedAt: null,
              epicId: "epic-1",
              chatId: "chat-1",
              payload: {
                kind: "approval",
                epicId: "epic-1",
                chatId: "chat-1",
                chatTitle: "Chat",
                taskTitle: "Task",
                approvalId: "prompt-pending",
              },
            },
          ],
          nextCursor: null,
        },
        recent: {
          entries: [
            {
              id: "failed",
              updatedAt: Date.now() - 1_000,
              readAt: null,
              kind: "agent.stopped",
              sourceRef: "failed",
              severity: "failure",
              outcome: "errored",
              epicId: "epic-1",
              chatId: "chat-2",
              payload: {
                kind: "chat",
                epicId: "epic-1",
                chatId: "chat-2",
                agentName: "Agent",
                taskTitle: "Task",
                outcome: "errored",
              },
            },
          ],
          nextCursor: null,
        },
        summary: { unreadCount: 2, attentionCount: 1 },
      });
    });

    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    // A second content transition (failure -> done, attention clear) is the
    // closest geometry-level stand-in for "activation failure restore" and
    // "pending clear" without driving the host preflight mutation here.
    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [
            {
              id: "failed",
              updatedAt: Date.now() - 1_000,
              readAt: null,
              kind: "agent.stopped",
              sourceRef: "failed",
              severity: "done",
              outcome: "completed",
              epicId: "epic-1",
              chatId: "chat-2",
              payload: {
                kind: "chat",
                epicId: "epic-1",
                chatId: "chat-2",
                agentName: "Agent",
                taskTitle: "Task",
                outcome: "completed",
              },
            },
          ],
          nextCursor: null,
        },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);
  });

  it("holds the outer rect across unread-rail, title length, and nested menu toggles", async () => {
    const shell = await openAndLock({ isColdOpen: false });
    const locked = {
      width: shell.style.width,
      height: shell.style.height,
    };

    const unreadHostEntry = {
      id: "rail-unread",
      updatedAt: Date.now() - 60_000,
      readAt: null as number | null,
      kind: "agent.stopped" as const,
      sourceRef: "rail-unread",
      severity: "done" as const,
      outcome: "completed" as const,
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "chat" as const,
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Agent",
        taskTitle: "Unread task title",
        outcome: "completed" as const,
      },
    };

    // Unread rail mount via host snapshot (full replace, not Yjs merge).
    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [unreadHostEntry], nextCursor: null },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });
    expect(
      await screen.findByTestId("notification-unread-rail"),
    ).not.toBeNull();
    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    // Rail unmount when the same row flips to read.
    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [{ ...unreadHostEntry, readAt: Date.now() }],
          nextCursor: null,
        },
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("notification-unread-rail")).toBeNull();
    });
    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    // Long title content churn (truncation is visual-only; outer rect frozen).
    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [
            {
              ...unreadHostEntry,
              id: "title-long",
              sourceRef: "title-long",
              readAt: null,
              payload: {
                ...unreadHostEntry.payload,
                taskTitle:
                  "A deliberately long notification title that should ellipsize in the row",
              },
            },
          ],
          nextCursor: null,
        },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });
    expect(await screen.findByTestId("notification-title")).not.toBeNull();
    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    // Nested filter menu open/close (only remaining nested DropdownMenu;
    // overflow was replaced by a direct settings gear).
    fireEvent.pointerDown(screen.getByTestId("notifications-filter-trigger"), {
      button: 0,
    });
    expect(
      await screen.findByTestId("notifications-filter-menu"),
    ).not.toBeNull();
    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    fireEvent.pointerDown(screen.getByTestId("notifications-subtitle"));
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-filter-menu")).toBeNull();
    });
    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);

    // Header gear is always mounted (not a nested menu) - presence alone
    // must not resize the frozen shell.
    expect(screen.getByTestId("notifications-open-settings")).not.toBeNull();
    expect(screen.queryByTestId("notifications-overflow-menu")).toBeNull();
    expect(shell.style.width).toBe(locked.width);
    expect(shell.style.height).toBe(locked.height);
  });
});
