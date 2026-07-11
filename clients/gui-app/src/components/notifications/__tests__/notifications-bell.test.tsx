import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
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

function appendEntryToStore(entry: NotificationEntry): void {
  const doc = useNotificationsStore.getState().doc;
  const arr = doc.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  doc.transact(() => {
    arr.push([createNotificationRoomEntryMap(entry)]);
  }, "stream");
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

interface ThreadEntryArgs {
  readonly id: string;
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly epicId: string;
  readonly artifactId: string;
  readonly threadId: string;
}

function threadEntry(args: ThreadEntryArgs): NotificationEntry {
  return {
    id: args.id,
    createdAt: args.createdAt,
    readAt: args.readAt,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.COMMENT_ADDED,
      epicId: args.epicId,
      artifactId: args.artifactId,
      artifactType: "ticket",
      threadId: args.threadId,
      actorName: "Bob",
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

function mountBell(runnerHost: MockRunnerHost): HTMLElement {
  const { container } = render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <NotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return container;
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

describe("NotificationsBell - OS toast bridge", () => {
  beforeEach(() => {
    __resetNotificationsStoreForTests();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTitleBarDragStore.setState({ suppressors: new Set() });
  });

  afterEach(() => {
    cleanup();
    useNotificationsPopoverStore.getState().setOpen(false);
    useTitleBarDragStore.setState({ suppressors: new Set() });
  });

  it("fires OS toast when a new unread notification arrives while the popover is closed", async () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);

    mountBell(runnerHost);

    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("toast-seed", 1, 500, "e1")]),
      );
    });
    expect(runnerHost.notificationsSent.length).toBe(0);

    act(() => {
      appendEntryToStore(invitedEntry("toast-new", 999, null, "e1"));
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(runnerHost.notificationsSent.length).toBe(1);
    expect(runnerHost.notificationsSent[0].title).toBe("Traycer");
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

  it("does not focus the first header action when the popover opens", async () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    mountBell(runnerHost);

    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("focus-seed", 1, null, "e1")]),
      );
    });

    const bell = screen.getByTestId("notifications-bell");
    bell.focus();

    fireEvent.click(bell);

    expect(await screen.findByTestId("notifications-popover")).not.toBeNull();
    const markAll = screen.getByTestId("notifications-mark-all-read");
    expect(document.activeElement).not.toBe(markAll);
    expect(markAll.getAttribute("data-state")).toBe("closed");
    expect(screen.queryByText("Mark all as read")).toBeNull();
  });

  it("suppresses OS toasts while the popover is open", async () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    mountBell(runnerHost);

    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("sup-seed", 1, 500, "e1")]),
      );
    });

    fireEvent.click(screen.getByTestId("notifications-bell"));

    act(() => {
      appendEntryToStore(invitedEntry("sup-new", 1000, null, "e1"));
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(runnerHost.notificationsSent.length).toBe(0);
  });

  it("carries a typed epic payload on toast for permission events", async () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    mountBell(runnerHost);

    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("pre-1", 1, 500, "e-seed")]),
      );
    });

    act(() => {
      appendEntryToStore(invitedEntry("epic-new", 999, null, "epic-alpha"));
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(runnerHost.notificationsSent.length).toBe(1);
    const sent = runnerHost.notificationsSent[0];
    expect(sent.payload).toEqual({ kind: "epic", epicId: "epic-alpha" });
  });

  it("carries a typed artifact payload with threadId on toast for comment events", async () => {
    const runnerHost = createRunnerHost();
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    mountBell(runnerHost);

    act(() => {
      handle().callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshot([invitedEntry("pre-2", 1, 500, "e-seed")]),
      );
    });

    act(() => {
      appendEntryToStore(
        threadEntry({
          id: "thread-new",
          createdAt: 1000,
          readAt: null,
          epicId: "epic-beta",
          artifactId: "artifact-42",
          threadId: "thread-7",
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(runnerHost.notificationsSent.length).toBe(1);
    const sent = runnerHost.notificationsSent[0];
    expect(sent.payload).toEqual({
      kind: "artifact",
      epicId: "epic-beta",
      artifactId: "artifact-42",
      threadId: "thread-7",
    });
  });
});
