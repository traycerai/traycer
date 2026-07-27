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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const testQueryClient = new QueryClient();
function QueryWrapper({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <QueryClientProvider client={testQueryClient}>
      {children}
    </QueryClientProvider>
  );
}

const notificationNavigateMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve()),
);

const hostState = vi.hoisted((): { local: HostDirectoryEntry | null } => ({
  local: {
    hostId: "host-a",
    label: "host-a",
    kind: "local",
    websocketUrl: "ws://host-a:9000",
    version: null,
    status: "available",
  },
}));

const streamClientCache = vi.hoisted(() => ({
  byKey: new Map<
    string,
    { readonly hostId: string; readonly websocketUrl: string | null }
  >(),
}));

const mockAuth = {
  onChange: vi.fn((_handler: (status: string) => void) => ({
    dispose: vi.fn(),
  })),
};

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  // Threaded into `invalidateNotificationIndicators` as its nullable read
  // canceller. These tests drive stream lifecycle, not indicator
  // invalidation, so `null` (the "no canceller" case) is the honest stub.
  useHostClient: () => null,
  useAuthService: () => mockAuth,
}));

vi.mock("@/hooks/notifications/use-notifications", () => ({
  useNotificationShow: () => () => Promise.resolve(),
}));

vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: () => undefined }),
  }),
);

vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridge: () => null,
}));

vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => hostState.local,
}));

// Stands in for the real `useHostStreamClientFor` (the transient,
// non-app-wide-rebinding stream-client hook). Mirrors its real contract: the
// SAME reference for an unchanged (hostId, websocketUrl) pair across
// re-renders, and a NEW reference whenever either changes - e.g. a local
// host respawn that moves to a fresh `websocketUrl` under the same
// `hostId`. That reference change is the signal
// `NotificationsSessionProvider` uses to decide whether to teardown+reopen.
vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: (target: HostDirectoryEntry | null) => {
    if (target === null) {
      return null;
    }
    const key = `${target.hostId}::${target.websocketUrl ?? ""}`;
    const cached = streamClientCache.byKey.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = {
      hostId: target.hostId,
      websocketUrl: target.websocketUrl,
    };
    streamClientCache.byKey.set(key, created);
    return created;
  },
}));

import { NotificationsSessionProvider as RoutedNotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { __setNotificationsStreamFactoryForTests } from "@/providers/notifications-stream-factory-override";

// The provider now takes a `navigate` (`NotificationNavigate`) it hands to the
// activation hook. These tests exercise stream lifecycle, not routing, so a
// local shim supplies a stub navigate and every case below keeps rendering
// `<NotificationsSessionProvider>` with children only.
function NotificationsSessionProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RoutedNotificationsSessionProvider navigate={notificationNavigateMock}>
      {props.children}
    </RoutedNotificationsSessionProvider>
  );
}
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostNotificationsStore } from "@/stores/notifications/host-notifications-store";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import {
  __resetNotificationsStoreForTests,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";

interface ControlledStream {
  closeCount: number;
}

const DEFAULT_LOCAL_ENTRY: HostDirectoryEntry = {
  hostId: "host-a",
  label: "host-a",
  kind: "local",
  websocketUrl: "ws://host-a:9000",
  version: null,
  status: "available",
};

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

function hostEntry(input: {
  readonly id: string;
  readonly epicId: string;
  readonly chatId: string;
}): HostNotificationEntry {
  return {
    id: input.id,
    updatedAt: 1,
    readAt: null,
    kind: "agent.stopped",
    sourceRef: input.id,
    severity: "done",
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

describe("<NotificationsSessionProvider />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostState.local = { ...DEFAULT_LOCAL_ENTRY };
    streamClientCache.byKey.clear();
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
      { wrapper: QueryWrapper },
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

  it("re-establishes the stream when the local host respawns at a new endpoint under the same hostId", async () => {
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
      { wrapper: QueryWrapper },
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });

    // Seed the HOST replica (host-scoped rows/summary). The Y.Doc
    // notifications room is user-scoped and deliberately survives a respawn -
    // it is the host replica that must not carry a dead process's rows into
    // the new one.
    act(() => {
      useHostNotificationsStore.getState().applySnapshot({
        attention: { entries: [], nextCursor: null },
        recent: {
          entries: [
            hostEntry({
              id: "n-1",
              epicId: "epic-alpha",
              chatId: "chat-alpha",
            }),
          ],
          nextCursor: null,
        },
        summary: { unreadCount: 1, attentionCount: 0 },
      });
    });

    expect(useHostNotificationsStore.getState().byId["n-1"]).toBeDefined();

    // Respawn: same hostId, fresh endpoint (e.g. the local host process
    // restarted on a new port). The provider must teardown the stale stream
    // and reopen against the new endpoint even though "the local host"
    // identity (hostId) never changed.
    act(() => {
      hostState.local = {
        ...DEFAULT_LOCAL_ENTRY,
        websocketUrl: "ws://host-a:9500",
      };
      view.rerender(
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>,
      );
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
      expect(streams[0].closeCount).toBe(1);
      expect(useHostNotificationsStore.getState().byId).toEqual({});
    });
  });

  it("does not reopen the stream on a re-render when the local host is unchanged (proxy for an active-host switch elsewhere in the app)", async () => {
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
      { wrapper: QueryWrapper },
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });

    // This provider has no dependency on the app-wide active host, so a
    // re-render triggered by an active-host switch elsewhere in the tree is
    // indistinguishable, from here, from any other unrelated re-render: the
    // local host entry (and therefore the resolved stream client) stays the
    // same object, and the stream must not be torn down or reopened.
    act(() => {
      view.rerender(
        <NotificationsSessionProvider>
          <div />
        </NotificationsSessionProvider>,
      );
    });

    expect(streams).toHaveLength(1);
    expect(streams[0].closeCount).toBe(0);
  });

  it("mounts cleanly with no stream opened when there is no local host (browser/mobile shells)", () => {
    hostState.local = null;
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
        <div data-testid="child" />
      </NotificationsSessionProvider>,
      { wrapper: QueryWrapper },
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    expect(view.getByTestId("child")).not.toBeNull();
    expect(streams).toHaveLength(0);
    expect(useNotificationsStore.getState().entries).toEqual([]);
  });
});
