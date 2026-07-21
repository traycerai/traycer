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
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
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
  createNotificationRoomEntryMap,
  NOTIFICATIONS_ARRAY_KEY,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import { ALL_NOTIFICATION_CATEGORIES } from "@/lib/notifications/notification-category";

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

const DAY_MS = 86_400_000;
const LONG_TITLE =
  "A deliberately long notification title that should ellipsize when the row is narrow enough";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

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

function hostDone(
  id: string,
  updatedAt: number,
  readAt: number | null,
  taskTitle: string,
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
      taskTitle,
      outcome: "completed",
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
      taskTitle: "Needs action task",
      approvalId: id,
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
          entry.severity === "needs_action" || entry.severity === "failure",
      ),
      nextCursor: null,
    },
    recent: { entries, nextCursor: null },
    summary,
  });
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function PopoverShell(props: {
  readonly onFilterMenuOpenChange: (open: boolean) => void;
}): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <TooltipProvider delayDuration={0}>
      <NotificationsPopover
        onNavigate={() => undefined}
        headingRef={headingRef}
        shellRef={shellRef}
        shellStyle={{}}
        onFilterMenuOpenChange={props.onFilterMenuOpenChange}
      />
    </TooltipProvider>
  );
}

function buildPopoverRouter(
  onFilterMenuOpenChange: (open: boolean) => void,
): AnyRouter {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <PopoverShell onFilterMenuOpenChange={onFilterMenuOpenChange} />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function renderPopoverRouter(
  onFilterMenuOpenChange: (open: boolean) => void,
): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RouterProvider router={buildPopoverRouter(onFilterMenuOpenChange)} />
    </QueryClientProvider>,
  );
}

const noopFilterMenuOpenChange = (_open: boolean): void => undefined;

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/** Coordinates clearly outside a typical shell placement (see mockShellRect). */
const OUTSIDE_SHELL_COORDS = { clientX: 10, clientY: 10, button: 0 } as const;
/** Coordinates inside mockShellRect - used for the hit-test-collapse shape. */
const INSIDE_SHELL_COORDS = { clientX: 300, clientY: 200, button: 0 } as const;

/**
 * PopoverContent's onPointerDownOutside coordinate guard compares
 * clientX/Y against shellRef.getBoundingClientRect(). In jsdom both the
 * default event coords and the shell rect are often 0, which the guard
 * treats as "inside" and preventDefaults - so truly-outside tests must
 * pin a non-zero shell rect and click outside it.
 */
function mockShellRect(): () => void {
  const shell = screen.getByTestId("notifications-popover");
  const spy = vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({
    x: 200,
    y: 100,
    width: 320,
    height: 400,
    top: 100,
    left: 200,
    right: 520,
    bottom: 500,
    toJSON: () => ({}),
  });
  return () => {
    spy.mockRestore();
  };
}

function fireFullClick(
  target: HTMLElement,
  coords: {
    readonly clientX: number;
    readonly clientY: number;
    readonly button: number;
  },
): void {
  fireEvent.pointerDown(target, coords);
  fireEvent.pointerUp(target, coords);
  fireEvent.click(target, coords);
}

/**
 * Full outside click on an underlying page control for the bleed-through
 * repro. Snapshots the modal body pointer lock *before* the gesture, then
 * runs pointerdown/up/click so Radix can dismiss.
 *
 * jsdom's fireEvent ignores CSS `pointer-events` and will invoke React
 * onClick even while the lock is active (and a modal menu often lifts the
 * lock on pointerdown before the trailing click). A real browser would not
 * activate a control that was inert when the gesture started - so when the
 * lock was present at start we clear the spy afterward to report the
 * browser-faithful activation count. Under `modal={false}` there is no lock
 * at start, the spy keeps its call, and the bleed-through assertion fails
 * (discrimination - verified locally against a temporary modal={false} patch).
 */
function fireBleedCheckedOutsideClick(
  underlying: HTMLElement,
  onUnderlyingClick: { mockClear: () => void },
): void {
  const lockedAtStart =
    document.body.style.pointerEvents === "none" ||
    getComputedStyle(underlying).pointerEvents === "none";
  onUnderlyingClick.mockClear();
  const restoreShell = mockShellRect();
  fireFullClick(underlying, OUTSIDE_SHELL_COORDS);
  restoreShell();
  if (lockedAtStart) {
    onUnderlyingClick.mockClear();
  }
}

function mountBell(options: {
  readonly onUnderlyingClick: (() => void) | undefined;
}): void {
  // Same shell as notifications-bell.test.tsx: no router. Nested-dismissal
  // only needs the real Popover + DropdownMenu layering; settings navigation
  // is not exercised here (useRouter may warn if the overflow item is opened).
  // Optional underlying page control reproduces the review's bleed-through
  // repro (click reaches a non-popover button while a nested menu is open).
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RunnerHostProvider runnerHost={createRunnerHost()}>
        <TooltipProvider delayDuration={0}>
          <div>
            {options.onUnderlyingClick !== undefined && (
              <button
                type="button"
                data-testid="underlying-page-button"
                onClick={options.onUnderlyingClick}
              >
                Underlying page control
              </button>
            )}
            <NotificationsBell />
          </div>
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/**
 * jsdom reports scrollWidth/clientWidth as 0. Stub the title span's metrics so
 * `useIsTextTruncated` can take a real overflow path without layout.
 */
function stubTitleTruncation(truncated: boolean): () => void {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "notification-title") {
        return truncated ? 320 : 40;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "notification-title") {
        return 120;
      }
      return 0;
    },
  });
  return () => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 0,
    });
  };
}

function resetStores(): void {
  hostRequestMock.mockReset();
  hostRequestMock.mockImplementation((method: string) => {
    if (method === "epic.listCollaborators") {
      return Promise.resolve({
        collaborators: [],
        collaboratorsAvailable: true,
      });
    }
    if (
      method === "host.notifications.markRead" ||
      method === "host.notifications.markAllRead"
    ) {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
  hostBindingState.current = {
    hostClient: {
      request: hostRequestMock,
      getActiveHostId: () => mockLocalHostEntry.hostId,
    },
  };
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  useNotificationsPopoverStore.setState({
    open: false,
    unreadOnly: false,
    categories: ALL_NOTIFICATION_CATEGORIES,
    originUnavailable: false,
    originUnavailableHostLabel: null,
  });
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
}

describe("notification desktop-pass design corrections", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    __resetHostNotificationsStoreForTests();
    useNotificationsPopoverStore.getState().setOpen(false);
  });

  describe("unread rail", () => {
    it("renders the rail only for unread rows and never reflows content padding", async () => {
      applyHostSnapshot(
        [
          hostDone("unread-row", 100, null, "Unread task"),
          hostDone("read-row", 90, 10, "Read task"),
        ],
        { unreadCount: 1, attentionCount: 0 },
      );
      renderPopoverRouter(noopFilterMenuOpenChange);

      const rows = await screen.findAllByTestId("notification-entry");
      const unread = rows.find(
        (row) => row.dataset.notificationId === "host:unread-row",
      );
      const read = rows.find(
        (row) => row.dataset.notificationId === "host:read-row",
      );
      if (unread === undefined || read === undefined) {
        throw new Error("expected unread and read rows");
      }

      expect(unread.dataset.notificationRead).toBe("false");
      expect(read.dataset.notificationRead).toBe("true");
      expect(
        within(unread).getByTestId("notification-unread-rail"),
      ).not.toBeNull();
      expect(within(read).queryByTestId("notification-unread-rail")).toBeNull();
      expect(screen.queryByTestId("notification-unread-dot")).toBeNull();

      // Permanent edge inset + relative positioning so the absolute rail never
      // shifts the icon/title stack between read and unread. pl-6/pr-4 are the
      // edge-to-edge divider content paddings (old section inset + rail gutter).
      expect(unread.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["relative", "pl-6", "pr-4"]),
      );
      expect(read.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["relative", "pl-6", "pr-4"]),
      );
      expect(unread.className).toBe(read.className);
    });

    it("keeps the rail on Attention rows after read-acknowledge while Recent still keys on unread", async () => {
      // needs_action stays in Attention via resolvedAt, not readAt - so a
      // post-activation-acknowledged prompt remains Attention-visible with
      // readAt set, and alwaysShowRail must keep the rail painted.
      applyHostSnapshot(
        [
          hostPrompt("attn-read", 200, 50),
          hostDone("recent-read", 100, 40, "Recent read task"),
          hostDone("recent-unread", 90, null, "Recent unread task"),
        ],
        { unreadCount: 2, attentionCount: 1 },
      );
      renderPopoverRouter(noopFilterMenuOpenChange);

      expect(await screen.findByText("Needs attention")).not.toBeNull();
      const rows = screen.getAllByTestId("notification-entry");
      const attention = rows.find(
        (row) => row.dataset.notificationId === "host:attn-read",
      );
      const recentRead = rows.find(
        (row) => row.dataset.notificationId === "host:recent-read",
      );
      const recentUnread = rows.find(
        (row) => row.dataset.notificationId === "host:recent-unread",
      );
      if (
        attention === undefined ||
        recentRead === undefined ||
        recentUnread === undefined
      ) {
        throw new Error("expected attention + recent rows");
      }

      expect(attention.dataset.notificationRead).toBe("true");
      expect(
        within(attention).getByTestId("notification-unread-rail"),
      ).not.toBeNull();
      expect(recentRead.dataset.notificationRead).toBe("true");
      expect(
        within(recentRead).queryByTestId("notification-unread-rail"),
      ).toBeNull();
      expect(recentUnread.dataset.notificationRead).toBe("false");
      expect(
        within(recentUnread).getByTestId("notification-unread-rail"),
      ).not.toBeNull();
    });

    it("removes the rail after mark-as-read without changing the row class contract", async () => {
      const stream = openGlobalStream();
      renderPopoverRouter(noopFilterMenuOpenChange);
      act(() => {
        stream.seed([
          {
            id: "collab-unread",
            createdAt: Date.now() - 60_000,
            readAt: null,
            event: {
              kind: NOTIFICATION_EVENT_TYPES.COMMENT_ADDED,
              epicId: "epic-1",
              artifactId: "art-1",
              artifactType: "ticket",
              threadId: "thread-1",
              actorName: "Alice",
            },
          },
        ]);
      });

      const row = await screen.findByTestId("notification-entry");
      const classBefore = row.className;
      expect(
        within(row).getByTestId("notification-unread-rail"),
      ).not.toBeNull();

      fireEvent.click(within(row).getByTestId("notification-mark-read"));
      await waitFor(() => {
        expect(
          within(row).queryByTestId("notification-unread-rail"),
        ).toBeNull();
      });
      expect(row.className).toBe(classBefore);
      expect(row.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["relative", "pl-6", "pr-4"]),
      );
      expect(within(row).queryByTestId("notification-mark-read")).toBeNull();
    });
  });

  describe("row hover and trailing action affordances", () => {
    it("tints the whole row on hover/focus-visible via class contract", async () => {
      applyHostSnapshot(
        [hostDone("hover-row", Date.now(), null, "Hover task")],
        { unreadCount: 1, attentionCount: 0 },
      );
      renderPopoverRouter(noopFilterMenuOpenChange);

      const row = await screen.findByTestId("notification-entry");
      expect(row.className.split(/\s+/)).toEqual(
        expect.arrayContaining([
          "hover:bg-muted/70",
          "has-[:focus-visible]:bg-muted/70",
        ]),
      );
      // Separators/labels are not rows - no hover tint class there.
      const separator = screen.queryByTestId("notification-temporal-separator");
      if (separator !== null) {
        expect(separator.className).not.toContain("hover:bg-muted/70");
      }
    });

    it("hides mark-read and acknowledge once read for both row shapes", async () => {
      useAppLocalNotificationsStore.getState().activateIdentity("user-a");
      // Non-navigable already-read (the regression: used to show disabled CheckCheck).
      useAppLocalNotificationsStore.getState().upsert({
        id: "local-read",
        updatedAt: 80,
        readAt: 70,
        kind: "stream.transport.error",
        sourceRef: "local-read",
        payload: null,
        message: "Already acknowledged",
        detail: null,
      });
      // Non-navigable unread (working path must stay).
      useAppLocalNotificationsStore.getState().upsert({
        id: "local-unread",
        updatedAt: 90,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "local-unread",
        payload: null,
        message: "Needs acknowledge",
        detail: null,
      });
      // Navigable already-read in Recent.
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [hostDone("nav-read", 60, 50, "Navigable read task")],
          nextCursor: null,
        },
        summary: { unreadCount: 1, attentionCount: 1 },
      });
      renderPopoverRouter(noopFilterMenuOpenChange);

      function findRow(feedId: string): HTMLElement | undefined {
        return screen
          .queryAllByTestId("notification-entry")
          .find((row) => row.dataset.notificationId === feedId);
      }

      await screen.findAllByTestId("notification-entry");
      const localRead = findRow("app-local:local-read");
      const localUnread = findRow("app-local:local-unread");
      const navRead = findRow("host:nav-read");
      if (
        localRead === undefined ||
        localUnread === undefined ||
        navRead === undefined
      ) {
        throw new Error(
          `missing rows: ${screen
            .queryAllByTestId("notification-entry")
            .map((r) => r.dataset.notificationId)
            .join(",")}`,
        );
      }

      expect(
        within(localRead).queryByTestId("notification-acknowledge"),
      ).toBeNull();
      expect(
        within(localRead).queryByTestId("notification-mark-read"),
      ).toBeNull();
      expect(
        within(navRead).queryByTestId("notification-mark-read"),
      ).toBeNull();
      expect(
        within(navRead).queryByTestId("notification-acknowledge"),
      ).toBeNull();

      const ack = within(localUnread).getByTestId("notification-acknowledge");
      expect(ack.hasAttribute("disabled")).toBe(false);
      fireEvent.click(ack);
      await waitFor(() => {
        expect(
          useAppLocalNotificationsStore.getState().byId["local-unread"].readAt,
        ).toBeTypeOf("number");
      });
      await waitFor(() => {
        const live = findRow("app-local:local-unread");
        if (live === undefined) {
          // Left Attention after acknowledge - control is gone with the row.
          expect(screen.queryByTestId("notification-acknowledge")).toBeNull();
          return;
        }
        expect(
          within(live).queryByTestId("notification-acknowledge"),
        ).toBeNull();
      });
    });
  });

  describe("edge-to-edge row dividers", () => {
    it("breaks row lists out of the section inset and restores content padding on rows", async () => {
      const now = Date.now();
      applyHostSnapshot(
        [
          hostPrompt("attn", now, null),
          hostDone("today", now - 60_000, null, "Today task"),
          hostDone(
            "yesterday",
            startOfLocalDay(now) - DAY_MS / 2,
            null,
            "Yesterday task",
          ),
        ],
        { unreadCount: 3, attentionCount: 1 },
      );
      renderPopoverRouter(noopFilterMenuOpenChange);

      await screen.findByText("Needs attention");
      const lists = screen
        .getByTestId("notifications-popover")
        .querySelectorAll("ul");
      expect(lists.length).toBeGreaterThanOrEqual(2);
      for (const list of lists) {
        expect(list.className.split(/\s+/)).toContain("-mx-4");
      }

      for (const row of screen.getAllByTestId("notification-entry")) {
        const classes = row.className.split(/\s+/);
        expect(classes).toContain("pl-6");
        expect(classes).toContain("pr-4");
        expect(classes).not.toContain("pl-2");
      }

      const separators = screen.getAllByTestId(
        "notification-temporal-separator",
      );
      expect(separators.length).toBeGreaterThan(0);
      for (const separator of separators) {
        expect(separator.className.split(/\s+/)).toContain("px-4");
        expect(separator.className.split(/\s+/)).not.toContain("px-0");
      }
    });
  });

  describe("header settings gear", () => {
    it("exposes a direct settings control with no overflow menu", async () => {
      applyHostSnapshot([hostDone("seed", Date.now(), null, "Seed")], {
        unreadCount: 1,
        attentionCount: 0,
      });
      renderPopoverRouter(noopFilterMenuOpenChange);

      const settings = await screen.findByTestId("notifications-open-settings");
      expect(settings.tagName.toLowerCase()).toBe("button");
      expect(settings.getAttribute("aria-label")).toBe("Notification settings");
      expect(screen.queryByTestId("notifications-overflow-menu")).toBeNull();
    });
  });

  describe("truncation-gated title tooltip", () => {
    it("shows a title tooltip only when the title is actually truncated", async () => {
      const restore = stubTitleTruncation(true);
      applyHostSnapshot(
        [hostDone("trunc-host", Date.now(), null, LONG_TITLE)],
        { unreadCount: 1, attentionCount: 0 },
      );
      renderPopoverRouter(noopFilterMenuOpenChange);

      const title = await screen.findByTestId("notification-title");
      expect(title.textContent).toBe(LONG_TITLE);

      fireEvent.pointerMove(title);
      fireEvent.focus(title);

      expect(
        await screen.findByRole("tooltip", { name: LONG_TITLE }),
      ).not.toBeNull();
      restore();
    });

    it("mounts no title tooltip when the title fits, including Collaboration rows", async () => {
      const restore = stubTitleTruncation(false);
      const stream = openGlobalStream();
      renderPopoverRouter(noopFilterMenuOpenChange);
      act(() => {
        stream.seed([
          {
            id: "collab-fit",
            createdAt: Date.now() - 30_000,
            readAt: null,
            event: {
              kind: NOTIFICATION_EVENT_TYPES.COMMENT_ADDED,
              epicId: "epic-1",
              artifactId: "art-1",
              artifactType: "ticket",
              threadId: "thread-1",
              actorName: "Alice",
            },
          },
        ]);
      });

      const title = await screen.findByTestId("notification-title");
      fireEvent.pointerMove(title);
      fireEvent.focus(title);
      fireEvent.mouseEnter(title);

      // Give the zero-delay tooltip provider a turn; nothing should mount for
      // the title (label is null → TooltipWrapper is a transparent Slot).
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.queryByRole("tooltip", { name: title.textContent }),
      ).toBeNull();
      expect(
        document.querySelector('[data-slot="tooltip-content"]'),
      ).toBeNull();
      restore();
    });
  });

  describe("temporal separator subordination", () => {
    it("keeps separators sentence-case and micro while section headers stay overline/uppercase", async () => {
      const now = Date.now();
      applyHostSnapshot(
        [
          hostDone("today", now - 60_000, null, "Today task"),
          hostDone(
            "yesterday",
            startOfLocalDay(now) - DAY_MS / 2,
            null,
            "Yesterday task",
          ),
          hostDone(
            "earlier",
            startOfLocalDay(now) - 3 * DAY_MS,
            null,
            "Earlier task",
          ),
        ],
        { unreadCount: 3, attentionCount: 0 },
      );
      renderPopoverRouter(noopFilterMenuOpenChange);

      const separators = await screen.findAllByTestId(
        "notification-temporal-separator",
      );
      expect(separators.map((node) => node.textContent)).toEqual([
        "Today",
        "Yesterday",
        "Earlier",
      ]);
      for (const separator of separators) {
        const classes = separator.className.split(/\s+/);
        expect(classes).toContain("text-micro");
        expect(classes).toContain("text-muted-foreground/60");
        expect(classes).not.toContain("uppercase");
        expect(classes).not.toContain("font-semibold");
        expect(classes).not.toContain("text-overline");
      }

      const sectionHeader = screen.getByText("Recent activity");
      const headerClasses = sectionHeader.className.split(/\s+/);
      expect(headerClasses).toEqual(
        expect.arrayContaining(["text-overline", "font-semibold", "uppercase"]),
      );
    });
  });

  describe("nested dismissal (real Radix filter menu inside the bell popover)", () => {
    // The only nested DropdownMenu left in the center is the filter menu
    // (overflow was replaced by a direct settings gear). Modal menus keep
    // the body pointer lock; PopoverContent's onFocusOutside preventDefault
    // plus onPointerDownOutside coordinate guard keep inside-shell clicks
    // from dismissing the whole flyout.

    async function openCenter(input: {
      readonly onUnderlyingClick: (() => void) | undefined;
    }): Promise<HTMLElement> {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [hostDone("seed", Date.now(), null, "Seed task")],
          nextCursor: null,
        },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
      mountBell({ onUnderlyingClick: input.onUnderlyingClick });
      fireEvent.click(screen.getByTestId("notifications-bell"));
      return screen.findByTestId("notifications-popover");
    }

    async function openFilterMenu(): Promise<HTMLElement> {
      fireEvent.pointerDown(
        screen.getByTestId("notifications-filter-trigger"),
        { button: 0 },
      );
      return screen.findByTestId("notifications-filter-menu");
    }

    it("closes the filter menu on an inside-popover outside-menu click without closing the center", async () => {
      // jsdom note: this fires pointerdown directly on the subtitle element,
      // so it does NOT exercise the real-browser hit-test collapse to <html>
      // under the modal pointer lock (body pointer-events:none). That defect
      // class is covered by the live CDP harness against Chromium; this test
      // only covers the ordinary "still-open menu, inside click closes menu
      // only" path and the ref-driven decision wiring, not hit-testing.
      const onUnderlyingClick = vi.fn();
      await openCenter({ onUnderlyingClick });
      await openFilterMenu();
      // Modal menus install a body pointer lock while open.
      expect(document.body.style.pointerEvents).toBe("none");

      // Click empty space inside the flyout (subtitle is always present and
      // not part of the filter menu portal).
      fireEvent.pointerDown(screen.getByTestId("notifications-subtitle"));

      await waitFor(() => {
        expect(screen.queryByTestId("notifications-filter-menu")).toBeNull();
      });
      expect(screen.getByTestId("notifications-popover")).not.toBeNull();
      expect(useNotificationsPopoverStore.getState().open).toBe(true);
      expect(onUnderlyingClick).toHaveBeenCalledTimes(0);
    });

    it("notifies onFilterMenuOpenChange true on open and false on close", async () => {
      const onFilterMenuOpenChange = vi.fn();
      applyHostSnapshot([hostDone("seed", Date.now(), null, "Seed task")], {
        unreadCount: 1,
        attentionCount: 0,
      });
      renderPopoverRouter(onFilterMenuOpenChange);

      const trigger = await screen.findByTestId("notifications-filter-trigger");
      fireEvent.pointerDown(trigger, { button: 0 });
      await screen.findByTestId("notifications-filter-menu");
      expect(onFilterMenuOpenChange).toHaveBeenCalledWith(true);

      const menu = screen.getByTestId("notifications-filter-menu");
      const unreadItem = within(menu).getByTestId(
        "notifications-filter-unread-only",
      );
      unreadItem.focus();
      fireEvent.keyDown(unreadItem, {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
      });
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-filter-menu")).toBeNull();
      });
      expect(onFilterMenuOpenChange).toHaveBeenCalledWith(false);
    });

    it("does not synthetic-Escape the popover when the filter menu already closed itself first", async () => {
      // Regression for the deferred onPointerDownOutside ordering P0: when
      // the menu's own outside handler closes it before the popover guard
      // runs, nestedMenuOpenRef is already false and the guard must NOT
      // dispatch Escape (which would hit the popover as the new topmost
      // layer and close it too).
      await openCenter({ onUnderlyingClick: undefined });
      await openFilterMenu();

      // Close the menu through its own Escape path first - ref is false after.
      const menu = screen.getByTestId("notifications-filter-menu");
      const unreadItem = within(menu).getByTestId(
        "notifications-filter-unread-only",
      );
      unreadItem.focus();
      fireEvent.keyDown(unreadItem, {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
      });
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-filter-menu")).toBeNull();
      });
      expect(useNotificationsPopoverStore.getState().open).toBe(true);

      const restoreShell = mockShellRect();
      const dispatchSpy = vi.spyOn(document, "dispatchEvent");
      // Inside-shell coordinates + target outside PopoverContent DOM so
      // onPointerDownOutside fires; isInsideShell true, but menu ref is
      // false → preventDefault only, no synthetic Escape.
      fireEvent.pointerDown(document.body, INSIDE_SHELL_COORDS);
      fireEvent.pointerUp(document.body, INSIDE_SHELL_COORDS);
      fireEvent.click(document.body, INSIDE_SHELL_COORDS);

      const syntheticEscapes = dispatchSpy.mock.calls.filter((call) => {
        const event = call[0];
        return event instanceof KeyboardEvent && event.key === "Escape";
      });
      expect(syntheticEscapes).toHaveLength(0);
      expect(screen.getByTestId("notifications-popover")).not.toBeNull();
      expect(useNotificationsPopoverStore.getState().open).toBe(true);
      dispatchSpy.mockRestore();
      restoreShell();
    });

    it("does not activate an underlying page control when dismissing via a truly-outside click on that control (filter menu)", async () => {
      const onUnderlyingClick = vi.fn();
      await openCenter({ onUnderlyingClick });
      await openFilterMenu();

      const underlying = screen.getByTestId("underlying-page-button");
      expect(document.body.style.pointerEvents).toBe("none");
      expect(getComputedStyle(underlying).pointerEvents).toBe("none");

      fireBleedCheckedOutsideClick(underlying, onUnderlyingClick);

      await waitFor(() => {
        expect(screen.queryByTestId("notifications-filter-menu")).toBeNull();
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
      });
      expect(useNotificationsPopoverStore.getState().open).toBe(false);
      expect(onUnderlyingClick).toHaveBeenCalledTimes(0);
    });

    it("closes everything in one physical outside click (both layers dismiss on pointerdown)", async () => {
      // Under Radix dismissable-layer 1.1.16 the nested modal menu is the only
      // layer that receives the outside pointerdown while its lock is active.
      // Production adaptation: the menu reports coordinates before releasing
      // the lock; the popover closes itself immediately when those coords are
      // truly outside the shell. One physical outside gesture still closes
      // everything - both layers on pointerdown, not menu-then-trailing-click.
      await openCenter({ onUnderlyingClick: undefined });
      await openFilterMenu();
      const restoreShell = mockShellRect();

      fireEvent.pointerDown(document.body, OUTSIDE_SHELL_COORDS);
      await waitFor(() => {
        expect(screen.queryByTestId("notifications-filter-menu")).toBeNull();
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
      });
      expect(useNotificationsPopoverStore.getState().open).toBe(false);

      // Trailing events of the same physical click must not reopen anything.
      fireEvent.pointerUp(document.body, OUTSIDE_SHELL_COORDS);
      fireEvent.click(document.body, OUTSIDE_SHELL_COORDS);
      restoreShell();
      expect(screen.queryByTestId("notifications-popover")).toBeNull();
      expect(useNotificationsPopoverStore.getState().open).toBe(false);
    });

    it("Escape closes only the nested filter menu first, then the popover", async () => {
      await openCenter({ onUnderlyingClick: undefined });
      const filterMenu = await openFilterMenu();
      const menuItem = within(filterMenu).getByTestId(
        "notifications-filter-unread-only",
      );
      menuItem.focus();

      fireEvent.keyDown(menuItem, {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
      });

      await waitFor(() => {
        expect(screen.queryByTestId("notifications-filter-menu")).toBeNull();
      });
      expect(screen.getByTestId("notifications-popover")).not.toBeNull();
      expect(useNotificationsPopoverStore.getState().open).toBe(true);
      // Settings gear is a direct button (not a menu) - still present.
      expect(screen.getByTestId("notifications-open-settings")).not.toBeNull();
      expect(screen.queryByTestId("notifications-overflow-menu")).toBeNull();

      const popover = screen.getByTestId("notifications-popover");
      fireEvent.keyDown(popover, {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
      });

      await waitFor(() => {
        expect(screen.queryByTestId("notifications-popover")).toBeNull();
      });
      expect(useNotificationsPopoverStore.getState().open).toBe(false);
    });
  });
});
