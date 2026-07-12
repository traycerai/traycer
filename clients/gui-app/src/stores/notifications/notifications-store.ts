import { useMemo } from "react";
import { create, type UseBoundStore, type StoreApi } from "zustand";
import * as Y from "yjs";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  NotificationsSnapshotMeta,
  NotificationsStreamCallbacks,
  NotificationsStreamClient,
} from "@traycer-clients/shared/host-transport/notifications-stream-client";
import type { NotificationEntry } from "@traycer/protocol/notifications/notification-entry";
import {
  type NotificationRoomEntriesArray,
  type NotificationRoomEntryMap,
  NOTIFICATIONS_ARRAY_KEY,
  parseNotificationRoomEntry,
} from "@traycer/protocol/notifications/notification-room";

export type NotificationsStreamClientFactory = (
  callbacks: NotificationsStreamCallbacks,
) => Pick<NotificationsStreamClient, "applyUpdate" | "close">;

interface NotificationsState {
  readonly doc: Y.Doc;
  readonly snapshotMeta: NotificationsSnapshotMeta | null;
  readonly connectionStatus: StreamConnectionStatus;
  readonly entries: ReadonlyArray<NotificationEntry>;
  readonly entryIds: ReadonlyArray<string>;
  readonly unreadCount: number;
  readonly revision: number;

  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
  reset: () => void;
}

const LOCAL_ORIGIN = "local";
const STREAM_ORIGIN = "stream";

function getNotificationsArray(target: Y.Doc): NotificationRoomEntriesArray {
  return target.getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY);
}

function sameIds(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

/**
 * Owns the replaceable Y.Doc plus the cached projection tuple for the
 * notifications singleton. Kept inside an IIFE closure so no module-level
 * `let` bindings leak; production callers interact only with the exported
 * zustand store and `openNotificationsStream`. `reset()` swaps the doc and
 * the projection cache atomically, matching the "fresh replica on identity
 * change" invariant the session provider relies on.
 */
interface NotificationsProjection {
  readonly entries: ReadonlyArray<NotificationEntry>;
  readonly entryIds: ReadonlyArray<string>;
  readonly unreadCount: number;
  readonly changed: boolean;
}

interface NotificationsReplica {
  getDoc(): Y.Doc;
  project(): NotificationsProjection;
  onProjection(handler: () => void): () => void;
  replace(): void;
}

function createNotificationsReplica(): NotificationsReplica {
  let doc = new Y.Doc();
  let lastProjectionKey: string | null = null;
  let lastEntries: ReadonlyArray<NotificationEntry> = [];
  let lastEntryIds: ReadonlyArray<string> = [];
  let lastUnread = 0;

  function project(): NotificationsProjection {
    const arr = getNotificationsArray(doc);
    const out: NotificationEntry[] = [];
    let unread = 0;
    for (let i = 0; i < arr.length; i++) {
      const parsed = parseNotificationRoomEntry(arr.get(i));
      if (parsed !== undefined) {
        out.push(parsed);
        if (parsed.readAt === null) unread++;
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    const entryIds = out.map((entry) => entry.id);
    const projectionKey = `${out.length}${out
      .map((entry) => `|${entry.id}:${entry.createdAt}:${entry.readAt ?? ""}`)
      .join("")}`;
    if (projectionKey === lastProjectionKey) {
      return {
        entries: lastEntries,
        entryIds: lastEntryIds,
        unreadCount: lastUnread,
        changed: false,
      };
    }
    lastProjectionKey = projectionKey;
    lastEntries = out;
    lastEntryIds = sameIds(entryIds, lastEntryIds) ? lastEntryIds : entryIds;
    lastUnread = unread;
    return {
      entries: out,
      entryIds: lastEntryIds,
      unreadCount: unread,
      changed: true,
    };
  }

  function onProjection(handler: () => void): () => void {
    doc.on("update", handler);
    return () => {
      doc.off("update", handler);
    };
  }

  function replace(): void {
    doc.destroy();
    doc = new Y.Doc();
    lastProjectionKey = null;
    lastEntries = [];
    lastEntryIds = [];
    lastUnread = 0;
  }

  return {
    getDoc: () => doc,
    project,
    onProjection,
    replace,
  };
}

function createNotificationsStore(
  replica: NotificationsReplica,
): UseBoundStore<StoreApi<NotificationsState>> {
  let unwireProjection: (() => void) | null = null;

  const store = create<NotificationsState>()((set) => {
    const projectFromDoc = (): void => {
      const projected = replica.project();
      if (!projected.changed) return;
      set({
        entries: projected.entries,
        entryIds: projected.entryIds,
        unreadCount: projected.unreadCount,
        revision: Date.now(),
      });
    };

    unwireProjection = replica.onProjection(projectFromDoc);

    return {
      doc: replica.getDoc(),
      snapshotMeta: null,
      connectionStatus: "connecting",
      entries: [],
      entryIds: [],
      unreadCount: 0,
      revision: 0,

      markAsRead: (notificationId) => {
        const doc = replica.getDoc();
        const arr = getNotificationsArray(doc);
        doc.transact(() => {
          for (let i = 0; i < arr.length; i++) {
            const entry = arr.get(i);
            if (entry.get("id") !== notificationId) {
              continue;
            }
            if (entry.get("readAt") !== null) {
              return;
            }
            entry.set("readAt", Date.now());
            return;
          }
        }, LOCAL_ORIGIN);
      },

      markAllAsRead: () => {
        const doc = replica.getDoc();
        const arr = getNotificationsArray(doc);
        doc.transact(() => {
          for (let i = 0; i < arr.length; i++) {
            const entry = arr.get(i);
            if (entry.get("readAt") === null) {
              entry.set("readAt", Date.now());
            }
          }
        }, LOCAL_ORIGIN);
      },

      clearAll: () => {
        const doc = replica.getDoc();
        const arr = getNotificationsArray(doc);
        if (arr.length === 0) return;
        doc.transact(() => {
          arr.delete(0, arr.length);
        }, LOCAL_ORIGIN);
      },

      reset: () => {
        if (unwireProjection !== null) {
          unwireProjection();
          unwireProjection = null;
        }
        replica.replace();
        unwireProjection = replica.onProjection(projectFromDoc);
        set({
          doc: replica.getDoc(),
          snapshotMeta: null,
          entries: [],
          entryIds: [],
          unreadCount: 0,
          revision: 0,
          connectionStatus: "connecting" as StreamConnectionStatus,
        });
      },
    };
  });

  return store;
}

// Module-local singleton. The replica + store are co-owned - no mutable
// module-level bindings are exposed; all lifecycle mutation happens through
// the store's `reset()` action or the exported `openNotificationsStream`.
const replica: NotificationsReplica = createNotificationsReplica();
export const useNotificationsStore = createNotificationsStore(replica);

/**
 * Opens the notifications stream via the injected factory. The returned
 * disposer tears the stream down and detaches the local-update forwarder.
 *
 * Local mutations tag their transactions with origin `"local"`; the forwarder
 * filters on that so only user-driven writes travel upstream, never snapshot
 * or remote-update applications which are tagged `"stream"`.
 */
export function openNotificationsStream(
  factory: NotificationsStreamClientFactory,
  onAuthError: (() => void) | null,
): () => void {
  const targetDoc = replica.getDoc();
  const client = factory({
    onSnapshot: (meta, snapshotBytes) => {
      // `Y.applyUpdate` fires the doc's "update" listener synchronously, so
      // the entries/unreadCount projection runs without us having to call it
      // here. Only `snapshotMeta` needs an explicit setState.
      Y.applyUpdate(targetDoc, snapshotBytes, STREAM_ORIGIN);
      useNotificationsStore.setState({ snapshotMeta: meta });
    },
    onUpdate: (updateBytes) => {
      Y.applyUpdate(targetDoc, updateBytes, STREAM_ORIGIN);
    },
    onConnectionStatus: (status, reason) => {
      useNotificationsStore.setState({ connectionStatus: status });
      if (
        status === "closed" &&
        reason !== null &&
        reason.kind === "fatalError" &&
        reason.details.code === "UNAUTHORIZED" &&
        onAuthError !== null
      ) {
        onAuthError();
      }
    },
  });

  const forwardLocal = (update: Uint8Array, origin: unknown): void => {
    if (origin === LOCAL_ORIGIN) {
      client.applyUpdate(update);
    }
  };
  targetDoc.on("update", forwardLocal);

  return () => {
    targetDoc.off("update", forwardLocal);
    client.close();
  };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function useNotificationEntries(): ReadonlyArray<NotificationEntry> {
  return useNotificationsStore((state) => state.entries);
}

export function selectNotificationEntryIds(
  state: NotificationsState,
): ReadonlyArray<string> {
  return state.entryIds;
}

export function makeSelectNotificationEntryById(id: string) {
  return (state: NotificationsState): NotificationEntry | null =>
    state.entries.find((entry) => entry.id === id) ?? null;
}

export function useNotificationEntryIds(): ReadonlyArray<string> {
  return useNotificationsStore(selectNotificationEntryIds);
}

export function useNotificationEntryById(id: string): NotificationEntry | null {
  const selector = useMemo(() => makeSelectNotificationEntryById(id), [id]);
  return useNotificationsStore(selector);
}

export function useNotificationUnreadCount(): number {
  return useNotificationsStore((state) => state.unreadCount);
} /**
 * Test helper - delegates to the public `reset()` action so tests get the
 * same teardown semantics as a sign-out transition in production.
 */
export function __resetNotificationsStoreForTests(): void {
  useNotificationsStore.getState().reset();
}
