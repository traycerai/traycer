import { beforeEach, describe, expect, it } from "vitest";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";

function entry(
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
    payload: {
      epicId: "epic-1",
      chatId: "chat-1",
    },
  };
}

describe("host notifications store", () => {
  beforeEach(() => {
    __resetHostNotificationsStoreForTests();
  });

  it("overwrites upserted rows by id, reorders by updatedAt, and flips read rows unread", () => {
    const store = useHostNotificationsStore.getState();

    store.replaceFromSnapshot(
      [entry("older", 10, null), entry("target", 20, 30)],
      50,
    );

    expect(useHostNotificationsStore.getState().orderedIds).toEqual([
      "target",
      "older",
    ]);
    expect(useHostNotificationsStore.getState().unreadCount).toBe(1);

    useHostNotificationsStore.getState().upsert(entry("target", 40, null));

    expect(useHostNotificationsStore.getState().orderedIds).toEqual([
      "target",
      "older",
    ]);
    expect(useHostNotificationsStore.getState().byId.target.updatedAt).toBe(40);
    expect(useHostNotificationsStore.getState().unreadCount).toBe(2);
  });

  it("wipes and replaces stale rows on a new snapshot", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("stale", 10, null)], 50);

    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("fresh", 20, null)], 50);

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["fresh"]);
    expect(useHostNotificationsStore.getState().byId.stale).toBeUndefined();
    expect(useHostNotificationsStore.getState().snapshotEpoch).toBe(2);
  });

  it("merges back-pages by id and keeps newer upsert state", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot(
        [entry("same", 100, null), entry("top", 120, null)],
        2,
      );

    useHostNotificationsStore.getState().upsert(entry("same", 130, null));
    const snapshotEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore.getState().mergePage(
      [entry("same", 90, 95), entry("older", 80, null)],
      {
        updatedAt: 80,
        id: "older",
      },
      snapshotEpoch,
    );

    expect(useHostNotificationsStore.getState().orderedIds).toEqual([
      "same",
      "top",
      "older",
    ]);
    expect(useHostNotificationsStore.getState().byId.same.updatedAt).toBe(130);
    expect(useHostNotificationsStore.getState().nextCursor).toEqual({
      updatedAt: 80,
      id: "older",
    });
  });

  it("discards stale list and mark-read results after a snapshot bump", () => {
    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot(
        [entry("old", 100, null), entry("older", 90, null)],
        2,
      );
    const staleEpoch = useHostNotificationsStore.getState().snapshotEpoch;

    useHostNotificationsStore
      .getState()
      .replaceFromSnapshot([entry("fresh", 200, null)], 50);

    useHostNotificationsStore.getState().mergePage(
      [entry("resurrected", 80, null)],
      {
        updatedAt: 80,
        id: "resurrected",
      },
      staleEpoch,
    );
    useHostNotificationsStore
      .getState()
      .applyReadState(["fresh"], 250, staleEpoch);

    expect(useHostNotificationsStore.getState().orderedIds).toEqual(["fresh"]);
    expect(
      useHostNotificationsStore.getState().byId.resurrected,
    ).toBeUndefined();
    expect(useHostNotificationsStore.getState().byId.fresh.readAt).toBeNull();
    expect(useHostNotificationsStore.getState().nextCursor).toBeNull();
  });
});
