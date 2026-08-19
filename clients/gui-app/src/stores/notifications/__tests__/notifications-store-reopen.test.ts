import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import { NOTIFICATION_EVENT_TYPES } from "@traycer/protocol/notifications/notification-entry";
import {
  NOTIFICATIONS_ARRAY_KEY,
  createNotificationRoomEntryMap,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import {
  createHostReconnectEngine,
  HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS,
  HOST_STREAM_REOPEN_MAX_BACKOFF_MS,
  type HostReconnectEngine,
} from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";

interface ControlledClient {
  readonly callbacks: NotificationsStreamCallbacks;
  readonly applyUpdateCalls: Uint8Array[];
  closeCount: number;
}

function fatalClose(code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: `test close: ${code}`,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function emptyServerSnapshot(client: ControlledClient): void {
  client.callbacks.onSnapshot(
    { schemaVersion: "1" },
    Y.encodeStateAsUpdate(new Y.Doc()),
  );
}

function appendLocalEntry(id: string): void {
  const doc = useNotificationsStore.getState().doc;
  const arr = doc.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  doc.transact(() => {
    arr.push([
      createNotificationRoomEntryMap({
        id,
        createdAt: 1,
        readAt: null,
        event: {
          kind: NOTIFICATION_EVENT_TYPES.INVITED,
          epicId: "epic-1",
          actorName: "Alice",
        },
      }),
    ]);
  }, "local");
}

describe("openNotificationsStream terminal-close reopen", () => {
  let clients: ControlledClient[];
  let reconnectEngine: HostReconnectEngine;

  const factory = (
    callbacks: NotificationsStreamCallbacks,
  ): { applyUpdate: (update: Uint8Array) => void; close: () => void } => {
    const client: ControlledClient = {
      callbacks,
      applyUpdateCalls: [],
      closeCount: 0,
    };
    clients.push(client);
    return {
      applyUpdate: (update) => {
        client.applyUpdateCalls.push(update);
      },
      close: () => {
        client.closeCount += 1;
      },
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clients = [];
    reconnectEngine = createHostReconnectEngine();
    __resetNotificationsStoreForTests();
  });

  afterEach(() => {
    reconnectEngine.dispose();
    vi.useRealTimers();
    __resetNotificationsStoreForTests();
  });

  it("re-invokes the factory with backoff after a terminal close", () => {
    const close = openNotificationsStream(reconnectEngine, factory, null);
    expect(clients).toHaveLength(1);
    clients[0].callbacks.onConnectionStatus("open", null);

    clients[0].callbacks.onConnectionStatus("closed", fatalClose("INTERNAL"));
    expect(useNotificationsStore.getState().connectionStatus).toBe("closed");
    // The reopen waits out the backoff — no synchronous redial storm.
    expect(clients).toHaveLength(1);
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(clients).toHaveLength(2);
    expect(clients[0].closeCount).toBe(1);

    // The replacement client owns the store projection from here; the
    // superseded client's late emissions are ignored.
    clients[1].callbacks.onConnectionStatus("open", null);
    clients[0].callbacks.onConnectionStatus("closed", fatalClose("INTERNAL"));
    expect(useNotificationsStore.getState().connectionStatus).toBe("open");
    vi.advanceTimersByTime(4 * HOST_STREAM_REOPEN_MAX_BACKOFF_MS);
    expect(clients).toHaveLength(2);

    close();
  });

  it("keeps escalating while replacements die before a snapshot and resets on one", () => {
    const close = openNotificationsStream(reconnectEngine, factory, null);

    clients[0].callbacks.onConnectionStatus("closed", fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(clients).toHaveLength(2);

    // A raw transport `open` is NOT proof of a usable stream — the host
    // resolver's async init can still fail and terminate after it. The
    // backoff must keep escalating: this close waits the doubled delay.
    clients[1].callbacks.onConnectionStatus("open", null);
    clients[1].callbacks.onConnectionStatus("closed", fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(clients).toHaveLength(2);
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(clients).toHaveLength(3);

    // A snapshot is the usability proof that resets the backoff.
    clients[2].callbacks.onConnectionStatus("open", null);
    emptyServerSnapshot(clients[2]);
    clients[2].callbacks.onConnectionStatus("closed", fatalClose("INTERNAL"));
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(clients).toHaveLength(4);

    close();
  });

  it("re-sends local Y.Doc state a reopened session's snapshot lacks", () => {
    const close = openNotificationsStream(reconnectEngine, factory, null);
    clients[0].callbacks.onConnectionStatus("open", null);
    // A snapshot matching the (empty) local doc produces no reconcile send.
    emptyServerSnapshot(clients[0]);
    expect(clients[0].applyUpdateCalls).toHaveLength(0);

    // Local mutation lands while the session is terminally dead — the
    // fire-and-forget forward has nowhere to go.
    clients[0].callbacks.onConnectionStatus("closed", fatalClose("INTERNAL"));
    appendLocalEntry("offline-entry");

    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(clients).toHaveLength(2);
    clients[1].callbacks.onConnectionStatus("open", null);
    // The replacement's snapshot still lacks the offline entry, so the
    // reconcile delta must carry it back to the host.
    emptyServerSnapshot(clients[1]);

    const serverDoc = new Y.Doc();
    for (const update of clients[1].applyUpdateCalls) {
      Y.applyUpdate(serverDoc, update);
    }
    const serverEntries = serverDoc.getArray<NotificationRoomEntryMap>(
      NOTIFICATIONS_ARRAY_KEY,
    );
    expect(serverEntries.length).toBe(1);
    expect(serverEntries.get(0).get("id")).toBe("offline-entry");

    close();
  });

  it("still routes UNAUTHORIZED terminal closes to the auth revalidator while scheduling the reopen", () => {
    const onAuthError = vi.fn();
    const close = openNotificationsStream(
      reconnectEngine,
      factory,
      onAuthError,
    );

    clients[0].callbacks.onConnectionStatus(
      "closed",
      fatalClose("UNAUTHORIZED"),
    );
    expect(onAuthError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    expect(clients).toHaveLength(2);

    close();
  });

  it("never reopens after the dormant entitlement terminal refusal", () => {
    const close = openNotificationsStream(reconnectEngine, factory, null);

    clients[0].callbacks.onConnectionStatus(
      "closed",
      fatalClose("FREE_TIER_NO_CLOUD_SYNC"),
    );
    vi.advanceTimersByTime(4 * HOST_STREAM_REOPEN_MAX_BACKOFF_MS);
    expect(clients).toHaveLength(1);

    close();
  });

  it("cancels a pending reopen on dispose", () => {
    const close = openNotificationsStream(reconnectEngine, factory, null);
    clients[0].callbacks.onConnectionStatus("closed", fatalClose("INTERNAL"));
    close();
    vi.advanceTimersByTime(4 * HOST_STREAM_REOPEN_MAX_BACKOFF_MS);
    expect(clients).toHaveLength(1);
    expect(clients[0].closeCount).toBe(1);
  });
});
