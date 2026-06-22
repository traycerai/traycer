import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
} from "@traycer/protocol/notifications/notification-entry";
import {
  NOTIFICATIONS_ARRAY_KEY,
  createNotificationRoomEntryMap,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";

const hostState = vi.hoisted(() => ({ id: "host-a" }));

const mockAuth = {
  onChange: vi.fn((_handler: (status: string) => void) => ({
    dispose: vi.fn(),
  })),
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => mockAuth,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostState.id,
}));

import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { __setNotificationsStreamFactoryForTests } from "@/providers/notifications-stream-factory-override";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  __resetNotificationsStoreForTests,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";

interface ControlledStream {
  closeCount: number;
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

describe("<NotificationsSessionProvider />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostState.id = "host-a";
    mockAuth.onChange.mockClear();
    mockAuth.onChange.mockImplementation(
      (_handler: (status: string) => void) => ({
        dispose: vi.fn(),
      }),
    );
    __resetNotificationsStoreForTests();
    __setNotificationsStreamFactoryForTests(null);
    resetAuth("signed-out", null);
  });

  afterEach(() => {
    cleanup();
    __resetNotificationsStoreForTests();
    __setNotificationsStreamFactoryForTests(null);
    resetAuth("signed-out", null);
  });

  it("reopens the stream and resets the local replica on signed-in user switches", async () => {
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
      <NotificationsSessionProvider>
        <div />
      </NotificationsSessionProvider>,
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
      <NotificationsSessionProvider>
        <div />
      </NotificationsSessionProvider>,
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
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>,
      );
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(streams[0].closeCount).toBe(1);
      expect(useNotificationsStore.getState().entries).toEqual([]);
    });
  });
});
