import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
} from "@/stores/notifications/notifications-store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
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

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
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

function invitedEntry(
  id: string,
  createdAt: number,
  readAt: number | null,
  epicId: string,
): NotificationEntry {
  return {
    id,
    createdAt,
    readAt,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.INVITED,
      epicId,
      actorName: "Alice",
    },
  };
}

interface FakeHandle {
  readonly callbacks: NotificationsStreamCallbacks;
}

function fakeFactory(): {
  factory: Parameters<typeof openNotificationsStream>[0];
  handle: () => FakeHandle;
} {
  let current: FakeHandle | null = null;
  return {
    factory: (callbacks) => {
      current = { callbacks };
      return {
        applyUpdate: () => {},
        close: () => {},
      };
    },
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function mountBell(runnerHost: MockRunnerHost): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <NotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

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

describe("NotificationsBell", () => {
  beforeEach(() => {
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    window.localStorage.clear();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTitleBarDragStore.setState({ suppressors: new Set() });
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
  });

  afterEach(() => {
    cleanup();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTitleBarDragStore.setState({ suppressors: new Set() });
  });

  it("keeps bell click open and close behavior unchanged", async () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost);

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(useNotificationsPopoverStore.getState().open).toBe(false);

    fireEvent.click(screen.getByTestId("notifications-bell"));

    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    expect(useNotificationsPopoverStore.getState().open).toBe(true);

    fireEvent.click(screen.getByTestId("notifications-bell"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("notifications-popover")).toBeNull();
    expect(useNotificationsPopoverStore.getState().open).toBe(false);
  });

  it("suppresses title-bar dragging only while the popover is open", async () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost);

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("notifications");

    expect(isSuppressed()).toBe(false);

    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    expect(isSuppressed()).toBe(true);

    fireEvent.click(screen.getByTestId("notifications-bell"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(isSuppressed()).toBe(false);
  });

  it("does not focus the first header action on pointer open", async () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    mountBell(runnerHost);

    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("focus-seed", 1, null, "e1")]),
      );
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    const bell = screen.getByTestId("notifications-bell");
    bell.focus();
    fireEvent.pointerDown(bell);
    fireEvent.click(bell);

    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    const markAll = screen.getByTestId("notifications-mark-all-read");
    expect(document.activeElement).not.toBe(markAll);
    const heading = screen.getByRole("heading", { name: "Notifications" });
    expect(document.activeElement).not.toBe(heading);
  });

  it("renders the exact uncapped attention badge and label", () => {
    const runnerHost = createRunnerHost();
    mountBell(runnerHost);

    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 0, attentionCount: 147 },
      });
      useAppLocalNotificationsStore.getState().activateIdentity("user-a");
      useAppLocalNotificationsStore.getState().upsert({
        id: "a1",
        updatedAt: 1,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "a1",
        payload: null,
        message: "failed",
        detail: null,
      });
      useAppLocalNotificationsStore.getState().upsert({
        id: "a2",
        updatedAt: 2,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "a2",
        payload: null,
        message: "failed",
        detail: null,
      });
      useAppLocalNotificationsStore.getState().upsert({
        id: "a3",
        updatedAt: 3,
        readAt: null,
        kind: "stream.transport.error",
        sourceRef: "a3",
        payload: null,
        message: "failed",
        detail: null,
      });
    });

    const badge = screen.getByTestId("notifications-attention-badge");
    expect(badge.textContent).toBe("150");
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, 150 notifications need attention");
  });

  it("renders the quiet-dot and unknown indicators for their bell states", () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    mountBell(runnerHost);

    // Host summary null → unknown, even with global unreads.
    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("quiet-seed", 1, null, "e1")]),
      );
    });

    expect(
      screen.getByTestId("notifications-unknown-indicator"),
    ).not.toBeNull();
    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, task notification status unavailable");

    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    expect(screen.getByTestId("notifications-quiet-dot")).not.toBeNull();
    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications, unread activity");

    act(() => {
      __resetNotificationsStoreForTests();
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });

    expect(screen.queryByTestId("notifications-attention-badge")).toBeNull();
    expect(screen.queryByTestId("notifications-quiet-dot")).toBeNull();
    expect(screen.queryByTestId("notifications-unknown-indicator")).toBeNull();
    expect(
      screen.getByTestId("notifications-bell").getAttribute("aria-label"),
    ).toBe("Notifications");
  });

  it("shows the partial host subtitle when the host summary has not landed", async () => {
    activeHostIdRef.value = null;
    directoryRef.value = { findById: () => null };
    const runnerHost = createRunnerHost();
    mountBell(runnerHost);

    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(
      (await screen.findByTestId("notifications-subtitle")).textContent,
    ).toBe("Task activity is unavailable right now");
  });

  it("shows the active host label when the summary is available", async () => {
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
    const runnerHost = createRunnerHost();
    mountBell(runnerHost);

    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(
      (await screen.findByTestId("notifications-subtitle")).textContent,
    ).toBe(`Task activity from ${mockLocalHostEntry.label}`);
  });

  describe("notification center opened analytics", () => {
    it("fires once per open cycle with direct_ui entry and exact host buckets", async () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: { entries: [], nextCursor: null },
        summary: { unreadCount: 7, attentionCount: 3 },
      });
      const runnerHost = createRunnerHost();
      const { rerender } = render(
        <QueryClientProvider client={createTestQueryClient()}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <TooltipProvider>
              <NotificationsBell />
            </TooltipProvider>
          </RunnerHostProvider>
        </QueryClientProvider>,
      );

      const bell = screen.getByTestId("notifications-bell");
      fireEvent.pointerDown(bell);
      fireEvent.click(bell);
      expect(await screen.findByTestId("notifications-popover")).not.toBeNull();

      const openCalls = trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
      );
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]?.[1]).toEqual({
        entry_point: "direct_ui",
        host_state: "exact",
        attention_bucket: "2-5",
        unread_bucket: "6-20",
      });

      // Rerender / unrelated store update while open must not re-fire.
      act(() => {
        useHostNotificationsStore.getState().applySnapshot({
          attention: { entries: [], nextCursor: null },
          recent: { entries: [], nextCursor: null },
          summary: { unreadCount: 8, attentionCount: 4 },
        });
      });
      rerender(
        <QueryClientProvider client={createTestQueryClient()}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <TooltipProvider>
              <NotificationsBell />
            </TooltipProvider>
          </RunnerHostProvider>
        </QueryClientProvider>,
      );
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
        ),
      ).toHaveLength(1);

      fireEvent.click(screen.getByTestId("notifications-bell"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(useNotificationsPopoverStore.getState().open).toBe(false);

      fireEvent.pointerDown(screen.getByTestId("notifications-bell"));
      fireEvent.click(screen.getByTestId("notifications-bell"));
      await screen.findByTestId("notifications-popover");
      expect(
        trackSpy.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
        ),
      ).toHaveLength(2);

      trackSpy.mockRestore();
    });

    it("uses notification entry_point for store-driven opens and unknown buckets when host summary is missing", async () => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      const runnerHost = createRunnerHost();
      // No host summary applied → isPartial / unknown bell state.
      activeHostIdRef.value = mockLocalHostEntry.hostId;
      mountBell(runnerHost);

      act(() => {
        useNotificationsPopoverStore.getState().setOpen(true);
      });
      expect(await screen.findByTestId("notifications-popover")).not.toBeNull();

      const openCalls = trackSpy.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.NotificationCenterOpened,
      );
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]?.[1]).toEqual({
        entry_point: "notification",
        host_state: "unknown",
        attention_bucket: "unknown",
        unread_bucket: "unknown",
      });

      trackSpy.mockRestore();
    });
  });
});
