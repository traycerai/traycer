import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createIndexedDbViewReplicaBackend } from "@traycer-clients/shared/view-replica/indexeddb-backend";
import { ViewReplicaStore } from "@traycer-clients/shared/view-replica/store";
import {
  noteNotificationFeedConfirmedWrite,
  notificationFeedReplicaAddress,
  notificationFeedReplicaService,
  rememberNotificationFeed,
} from "@/lib/view-replica/notification-feed-replica";
import {
  VIEW_REPLICA_DB_NAME,
  useViewReplicaPaint,
  viewReplicaStore,
} from "@/lib/view-replica/view-replica-store";
import {
  cloudNotificationFeedId,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import {
  ACCOUNT,
  FEED_SUMMARY,
  HOST,
  feedRow,
} from "@/lib/view-replica/__tests__/replica-fixtures";

function address() {
  const resolved = notificationFeedReplicaAddress(ACCOUNT, HOST);
  if (resolved === null) throw new Error("Expected a feed address");
  return resolved;
}

/** A previous session's replica: on disk, not in this memory. */
async function seedPreviousSession(entryIds: readonly string[]): Promise<void> {
  const previous = new ViewReplicaStore(
    createIndexedDbViewReplicaBackend(
      () => globalThis.indexedDB,
      VIEW_REPLICA_DB_NAME,
    ),
  );
  await previous.warm(ACCOUNT);
  previous.write(
    notificationFeedReplicaService,
    address(),
    {
      rows: entryIds.map(feedRow),
      summary: FEED_SUMMARY,
      cloudFeedVersion: { major: 1, minor: 2 },
    },
    { observedAt: 100, sourceGeneration: 7 },
  );
  await previous.drain();
}

function seededKeys(): readonly string[] {
  return Object.keys(useCloudNotificationsStore.getState().rows).sort();
}

describe("notification feed replica", () => {
  beforeEach(() => {
    useCloudNotificationsStore.setState(
      useCloudNotificationsStore.getInitialState(),
      true,
    );
  });

  afterEach(async () => {
    cleanup();
    await viewReplicaStore.evict({ kind: "identity-retired" });
  });

  it("paints the cached feed rows by entry id once warm, and seeds them without making them authoritative", async () => {
    await seedPreviousSession(["entry-1", "entry-2"]);
    const { result } = renderHook(() =>
      useViewReplicaPaint(notificationFeedReplicaService, address()),
    );
    expect(result.current).toBeNull();

    await act(async () => {
      await viewReplicaStore.warm(ACCOUNT);
    });

    const page = result.current;
    expect(page?.rows.map((row) => row.entryId)).toEqual([
      "entry-1",
      "entry-2",
    ]);
    expect(page?.cloudFeedVersion).toEqual({ major: 1, minor: 2 });
    if (page === null) throw new Error("Expected a cached feed");

    useCloudNotificationsStore.getState().seedFromReplica(page);

    expect(seededKeys()).toEqual(
      [
        cloudNotificationFeedId("entry-1"),
        cloudNotificationFeedId("entry-2"),
      ].sort(),
    );
    const state = useCloudNotificationsStore.getState();
    expect(state.hasSnapshot).toBe(false);
    expect(state.version).toBeNull();
  });

  it("does not seed over a live snapshot", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [feedRow("live-1")],
      summary: FEED_SUMMARY,
      version: 5,
    });

    useCloudNotificationsStore.getState().seedFromReplica({
      rows: [feedRow("cached-1")],
      summary: FEED_SUMMARY,
    });

    expect(seededKeys()).toEqual([cloudNotificationFeedId("live-1")]);
  });

  it("replaces the seeded rows wholesale with the first live snapshot", () => {
    useCloudNotificationsStore.getState().seedFromReplica({
      rows: [feedRow("cached-1"), feedRow("cached-2")],
      summary: FEED_SUMMARY,
    });

    useCloudNotificationsStore.getState().applySnapshot({
      rows: [feedRow("cached-2"), feedRow("live-3")],
      summary: FEED_SUMMARY,
      version: 1,
    });

    expect(seededKeys()).toEqual(
      [
        cloudNotificationFeedId("cached-2"),
        cloudNotificationFeedId("live-3"),
      ].sort(),
    );
  });

  it("revokes the rows a replica page seeded, and the summary, when the replica stops admitting it", () => {
    useCloudNotificationsStore.getState().seedFromReplica({
      rows: [feedRow("cached-1")],
      summary: FEED_SUMMARY,
    });

    useCloudNotificationsStore.getState().revokeReplicaSeed();

    const state = useCloudNotificationsStore.getState();
    expect(seededKeys()).toEqual([]);
    expect(state.summary).toBeNull();
    expect(state.hasSnapshot).toBe(false);
  });

  it("keeps a live snapshot when the replica seed is revoked", () => {
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [feedRow("live-1")],
      summary: FEED_SUMMARY,
      version: 5,
    });

    useCloudNotificationsStore.getState().revokeReplicaSeed();

    expect(seededKeys()).toEqual([cloudNotificationFeedId("live-1")]);
    expect(useCloudNotificationsStore.getState().summary).toEqual(
      FEED_SUMMARY,
    );
  });

  it("stops admitting the cached feed once the account is refused", async () => {
    await seedPreviousSession(["entry-1"]);
    await viewReplicaStore.warm(ACCOUNT);
    const { result } = renderHook(() =>
      useViewReplicaPaint(notificationFeedReplicaService, address()),
    );
    expect(result.current?.rows).toHaveLength(1);

    await act(async () => {
      await viewReplicaStore.evict({
        kind: "account-refused",
        accountId: ACCOUNT,
      });
    });

    expect(result.current).toBeNull();
  });

  describe("confirmed-write floor", () => {
    function remember(version: number): void {
      rememberNotificationFeed({
        accountId: ACCOUNT,
        servingHostId: HOST,
        page: {
          rows: [feedRow("unread")],
          summary: FEED_SUMMARY,
          cloudFeedVersion: { major: 1, minor: 2 },
        },
        version,
      });
    }

    function cachedFeedIds(): readonly string[] | null {
      const hit = viewReplicaStore.read(
        notificationFeedReplicaService,
        address(),
      );
      return hit === null ? null : hit.page.rows.map((row) => row.entryId);
    }

    it("misses a snapshot at the version held when the write was sent, even when it arrives later", async () => {
      await viewReplicaStore.warm(ACCOUNT);
      remember(7);
      noteNotificationFeedConfirmedWrite(ACCOUNT, 7);
      expect(cachedFeedIds()).toBeNull();

      remember(7);

      expect(cachedFeedIds()).toBeNull();
    });

    it("hits a snapshot a later version produced", async () => {
      await viewReplicaStore.warm(ACCOUNT);
      remember(7);
      noteNotificationFeedConfirmedWrite(ACCOUNT, 7);

      remember(8);

      expect(cachedFeedIds()).toEqual(["unread"]);
    });
  });
});
