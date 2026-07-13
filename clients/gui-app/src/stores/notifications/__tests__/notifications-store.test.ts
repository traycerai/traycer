import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
} from "@traycer/protocol/notifications/notification-entry";
import {
  NOTIFICATIONS_ARRAY_KEY,
  createNotificationRoomEntryMap,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";

interface FakeHandle {
  readonly callbacks: NotificationsStreamCallbacks;
  readonly applied: Uint8Array[];
  closeCount: number;
}

function fakeFactory(): {
  factory: (
    callbacks: NotificationsStreamCallbacks,
  ) => Pick<
    { applyUpdate: (b: Uint8Array) => void; close: () => void },
    "applyUpdate" | "close"
  >;
  handle: () => FakeHandle;
} {
  let current: FakeHandle | null = null;
  return {
    factory: (callbacks) => {
      const h: FakeHandle = { callbacks, applied: [], closeCount: 0 };
      current = h;
      return {
        applyUpdate: (bytes) => h.applied.push(bytes),
        close: () => {
          h.closeCount += 1;
        },
      };
    },
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
  };
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

function buildSnapshotBytes(
  entries: ReadonlyArray<NotificationEntry>,
): Uint8Array {
  const donor = new Y.Doc();
  const arr = donor.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
  donor.transact(() => {
    for (const entry of entries) {
      arr.push([createNotificationRoomEntryMap(entry)]);
    }
  });
  return Y.encodeStateAsUpdate(donor);
}

describe("notifications store", () => {
  beforeEach(() => {
    __resetNotificationsStoreForTests();
  });

  it("projects a snapshot into entries via the shared schema", () => {
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    handle().callbacks.onSnapshot(
      { schemaVersion: "2" },
      buildSnapshotBytes([
        invitedEntry("n1", 1, null, "epic-1"),
        invitedEntry("n2", 2, Date.now(), "epic-2"),
      ]),
    );
    const state = useNotificationsStore.getState();
    expect(state.entries.length).toBe(2);
    // Sorted descending by createdAt.
    expect(state.entries[0].id).toBe("n2");
    expect(state.entries[1].id).toBe("n1");
    expect(state.entries[1].event.kind).toBe(NOTIFICATION_EVENT_TYPES.INVITED);
  });

  it("derives unread count from entries whose readAt is null", () => {
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    handle().callbacks.onSnapshot(
      { schemaVersion: "2" },
      buildSnapshotBytes([
        invitedEntry("un-a", 1, null, "epic-a"),
        invitedEntry("un-b", 2, null, "epic-b"),
        invitedEntry("un-c", 3, 999, "epic-c"),
      ]),
    );
    const entries = useNotificationsStore.getState().entries;
    expect(entries.length).toBe(3);
    const unread = entries.filter((e) => e.readAt === null).length;
    expect(unread).toBe(2);
  });

  it("keeps the projected entry id array stable across read-state-only changes", () => {
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    handle().callbacks.onSnapshot(
      { schemaVersion: "2" },
      buildSnapshotBytes([
        invitedEntry("ids-1", 1, null, "epic-a"),
        invitedEntry("ids-2", 2, null, "epic-b"),
      ]),
    );
    const before = useNotificationsStore.getState().entryIds;

    useNotificationsStore.getState().markAsRead("ids-1");

    expect(useNotificationsStore.getState().entryIds).toBe(before);
    expect(useNotificationsStore.getState().entryIds).toEqual([
      "ids-2",
      "ids-1",
    ]);
  });

  it("markAsRead mutates readAt on the typed entry map and emits upstream", () => {
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    handle().callbacks.onSnapshot(
      { schemaVersion: "2" },
      buildSnapshotBytes([invitedEntry("mar-1", 1, null, "epic-mar")]),
    );
    useNotificationsStore.getState().markAsRead("mar-1");
    expect(handle().applied.length).toBe(1);
    const entry = useNotificationsStore
      .getState()
      .entries.find((e) => e.id === "mar-1");
    expect(entry?.readAt).toBeTypeOf("number");
  });

  it("markAllAsRead sets readAt on every unread entry", () => {
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    handle().callbacks.onSnapshot(
      { schemaVersion: "2" },
      buildSnapshotBytes([
        invitedEntry("all-1", 1, null, "e1"),
        invitedEntry("all-2", 2, null, "e2"),
        invitedEntry("all-3", 3, 500, "e3"),
      ]),
    );
    useNotificationsStore.getState().markAllAsRead();
    const entries = useNotificationsStore.getState().entries;
    for (const entry of entries) {
      expect(entry.readAt).not.toBeNull();
    }
  });

  it("clearAll empties the Y.Array via a local transaction", () => {
    const { factory, handle } = fakeFactory();
    openNotificationsStream(factory, null);
    handle().callbacks.onSnapshot(
      { schemaVersion: "2" },
      buildSnapshotBytes([
        invitedEntry("c1", 1, null, "e1"),
        invitedEntry("c2", 2, null, "e2"),
      ]),
    );
    useNotificationsStore.getState().clearAll();
    expect(useNotificationsStore.getState().entries.length).toBe(0);
    expect(handle().applied.length).toBeGreaterThanOrEqual(1);
  });

  it("reset clears entries, snapshot meta, and replaces the doc", () => {
    const { factory, handle } = fakeFactory();
    const disposer = openNotificationsStream(factory, null);
    handle().callbacks.onSnapshot(
      { schemaVersion: "2" },
      buildSnapshotBytes([invitedEntry("r1", 1, null, "e1")]),
    );
    const priorDoc = useNotificationsStore.getState().doc;
    disposer();
    useNotificationsStore.getState().reset();
    const state = useNotificationsStore.getState();
    expect(state.entries.length).toBe(0);
    expect(state.snapshotMeta).toBeNull();
    expect(state.connectionStatus).toBe("connecting");
    expect(state.doc).not.toBe(priorDoc);
  });

  it("invokes onAuthError when the host closes the stream with UNAUTHORIZED", () => {
    const { factory, handle } = fakeFactory();
    let count = 0;
    const disposer = openNotificationsStream(factory, () => {
      count += 1;
    });

    handle().callbacks.onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "expired bearer",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(count).toBe(1);
    disposer();
  });

  it("does not invoke onAuthError on caller-initiated close or other fatal errors", () => {
    const { factory, handle } = fakeFactory();
    let count = 0;
    const disposer = openNotificationsStream(factory, () => {
      count += 1;
    });

    handle().callbacks.onConnectionStatus("closed", { kind: "caller" });
    handle().callbacks.onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "schema mismatch",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(count).toBe(0);
    disposer();
  });

  it("sign-out + sign-in as a different user does not replay prior entries", () => {
    // User A signs in and receives notifications.
    const userA = fakeFactory();
    const disposerA = openNotificationsStream(userA.factory, null);
    userA
      .handle()
      .callbacks.onSnapshot(
        { schemaVersion: "2" },
        buildSnapshotBytes([
          invitedEntry("a-1", 100, null, "epic-a-1"),
          invitedEntry("a-2", 200, null, "epic-a-2"),
        ]),
      );
    expect(useNotificationsStore.getState().entries.length).toBe(2);

    // Sign-out path: tear the stream down and reset the local replica.
    disposerA();
    useNotificationsStore.getState().reset();
    expect(useNotificationsStore.getState().entries.length).toBe(0);

    // User B signs in. Their host delivers an empty snapshot first.
    const userB = fakeFactory();
    openNotificationsStream(userB.factory, null);
    userB
      .handle()
      .callbacks.onSnapshot({ schemaVersion: "2" }, buildSnapshotBytes([]));
    const entries = useNotificationsStore.getState().entries;
    expect(entries.length).toBe(0);
    expect(entries.some((e) => e.id === "a-1" || e.id === "a-2")).toBe(false);
  });
});
