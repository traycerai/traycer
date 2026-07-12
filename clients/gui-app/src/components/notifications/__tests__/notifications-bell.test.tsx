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

describe("NotificationsBell", () => {
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
});
