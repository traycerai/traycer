import { useMemo } from "react";
import { create } from "zustand";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  hostNotificationsSubscribeServerFrameSchema,
  type HostNotificationCursor,
  type HostNotificationEntry,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

export const HOST_NOTIFICATIONS_INITIAL_LIMIT = 50;

interface HostNotificationsProjection {
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;
}

interface HostNotificationsState {
  readonly byId: Readonly<Record<string, HostNotificationEntry>>;
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;
  readonly connectionStatus: StreamConnectionStatus;
  readonly nextCursor: HostNotificationCursor | null;
  readonly snapshotEpoch: number;

  replaceFromSnapshot: (
    entries: ReadonlyArray<HostNotificationEntry>,
    initialLimit: number,
  ) => void;
  upsert: (entry: HostNotificationEntry) => void;
  mergePage: (
    entries: ReadonlyArray<HostNotificationEntry>,
    nextCursor: HostNotificationCursor | null,
    expectedSnapshotEpoch: number,
  ) => void;
  applyReadState: (
    ids: ReadonlyArray<string>,
    readAt: number | null,
    expectedSnapshotEpoch: number,
  ) => void;
  markAllReadLocally: (
    beforeUpdatedAt: number,
    readAt: number,
    expectedSnapshotEpoch: number,
  ) => void;
  reset: () => void;
}

function projectHostNotifications(
  byId: Readonly<Record<string, HostNotificationEntry>>,
): HostNotificationsProjection {
  const entries = Object.values(byId);
  entries.sort(compareHostNotificationEntries);
  let unreadCount = 0;
  for (const entry of entries) {
    if (entry.readAt === null) unreadCount++;
  }
  return {
    orderedIds: entries.map((entry) => entry.id),
    unreadCount,
  };
}

export function compareHostNotificationEntries(
  a: HostNotificationEntry,
  b: HostNotificationEntry,
): number {
  const updatedAtDelta = b.updatedAt - a.updatedAt;
  if (updatedAtDelta !== 0) return updatedAtDelta;
  return b.id.localeCompare(a.id);
}

function cursorFromEntries(
  entries: ReadonlyArray<HostNotificationEntry>,
  initialLimit: number,
): HostNotificationCursor | null {
  if (entries.length < initialLimit) return null;
  const sorted = [...entries].sort(compareHostNotificationEntries);
  const last = sorted.at(-1);
  if (last === undefined) return null;
  return { updatedAt: last.updatedAt, id: last.id };
}

function mergeById(
  current: Readonly<Record<string, HostNotificationEntry>>,
  entries: ReadonlyArray<HostNotificationEntry>,
): Readonly<Record<string, HostNotificationEntry>> {
  if (entries.length === 0) return current;
  const next: Record<string, HostNotificationEntry> = { ...current };
  for (const entry of entries) {
    if (
      Object.hasOwn(current, entry.id) &&
      current[entry.id].updatedAt > entry.updatedAt
    ) {
      continue;
    }
    next[entry.id] = entry;
  }
  return next;
}

function applyReadStateById(
  current: Readonly<Record<string, HostNotificationEntry>>,
  ids: ReadonlyArray<string>,
  readAt: number | null,
): Readonly<Record<string, HostNotificationEntry>> {
  let changed = false;
  const next: Record<string, HostNotificationEntry> = { ...current };
  for (const id of ids) {
    if (!Object.hasOwn(current, id)) continue;
    const entry = current[id];
    if (entry.readAt === readAt) continue;
    next[id] = { ...entry, readAt };
    changed = true;
  }
  return changed ? next : current;
}

function initialState(): Pick<
  HostNotificationsState,
  | "byId"
  | "orderedIds"
  | "unreadCount"
  | "connectionStatus"
  | "nextCursor"
  | "snapshotEpoch"
> {
  return {
    byId: {},
    orderedIds: [],
    unreadCount: 0,
    connectionStatus: "connecting",
    nextCursor: null,
    snapshotEpoch: 0,
  };
}

export const useHostNotificationsStore = create<HostNotificationsState>()(
  (set) => ({
    ...initialState(),

    replaceFromSnapshot: (entries, initialLimit) => {
      const byId = mergeById({}, entries);
      const projection = projectHostNotifications(byId);
      set((state) => ({
        byId,
        orderedIds: projection.orderedIds,
        unreadCount: projection.unreadCount,
        nextCursor: cursorFromEntries(entries, initialLimit),
        snapshotEpoch: state.snapshotEpoch + 1,
      }));
    },

    upsert: (entry) => {
      set((state) => {
        const byId = { ...state.byId, [entry.id]: entry };
        const projection = projectHostNotifications(byId);
        return {
          byId,
          orderedIds: projection.orderedIds,
          unreadCount: projection.unreadCount,
        };
      });
    },

    mergePage: (entries, nextCursor, expectedSnapshotEpoch) => {
      set((state) => {
        if (state.snapshotEpoch !== expectedSnapshotEpoch) return state;
        const byId = mergeById(state.byId, entries);
        const projection = projectHostNotifications(byId);
        return {
          byId,
          orderedIds: projection.orderedIds,
          unreadCount: projection.unreadCount,
          nextCursor,
        };
      });
    },

    applyReadState: (ids, readAt, expectedSnapshotEpoch) => {
      set((state) => {
        if (state.snapshotEpoch !== expectedSnapshotEpoch) return state;
        const byId = applyReadStateById(state.byId, ids, readAt);
        if (byId === state.byId) return state;
        const projection = projectHostNotifications(byId);
        return {
          byId,
          orderedIds: projection.orderedIds,
          unreadCount: projection.unreadCount,
        };
      });
    },

    markAllReadLocally: (beforeUpdatedAt, readAt, expectedSnapshotEpoch) => {
      set((state) => {
        if (state.snapshotEpoch !== expectedSnapshotEpoch) return state;
        const ids = state.orderedIds.filter((id) => {
          const entry = state.byId[id];
          return entry.readAt === null && entry.updatedAt <= beforeUpdatedAt;
        });
        const byId = applyReadStateById(state.byId, ids, readAt);
        if (byId === state.byId) return state;
        const projection = projectHostNotifications(byId);
        return {
          byId,
          orderedIds: projection.orderedIds,
          unreadCount: projection.unreadCount,
        };
      });
    },

    reset: () => set(initialState()),
  }),
);

export function openHostNotificationsStream(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
  onAuthError: (() => void) | null,
): () => void {
  const session = wsStreamClient.subscribe("host.notifications.subscribe", {
    filter: "all",
    initialLimit: HOST_NOTIFICATIONS_INITIAL_LIMIT,
  });
  session.onServerFrame((envelope, binaryPayload) => {
    if (binaryPayload !== null) return;
    const parsed =
      hostNotificationsSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.kind) {
      case "snapshot":
        useHostNotificationsStore
          .getState()
          .replaceFromSnapshot(frame.entries, HOST_NOTIFICATIONS_INITIAL_LIMIT);
        return;
      case "upserted":
        useHostNotificationsStore.getState().upsert(frame.entry);
        return;
      case "readStateChanged":
        useHostNotificationsStore
          .getState()
          .applyReadState(
            frame.ids,
            frame.readAt,
            useHostNotificationsStore.getState().snapshotEpoch,
          );
        return;
      case "pong":
        return;
    }
  });
  session.onStatusChange((status, reason) => {
    useHostNotificationsStore.setState({ connectionStatus: status });
    handleHostNotificationsCloseReason(reason, onAuthError);
  });
  return () => {
    session.close();
  };
}

function handleHostNotificationsCloseReason(
  reason: StreamCloseReason | null,
  onAuthError: (() => void) | null,
): void {
  if (
    reason !== null &&
    reason.kind === "fatalError" &&
    reason.details.code === "UNAUTHORIZED" &&
    onAuthError !== null
  ) {
    onAuthError();
  }
}

export function selectHostNotificationIds(
  state: HostNotificationsState,
): ReadonlyArray<string> {
  return state.orderedIds;
}

export function selectHostNotificationUnreadCount(
  state: HostNotificationsState,
): number {
  return state.unreadCount;
}

export function selectHostNotificationNextCursor(
  state: HostNotificationsState,
): HostNotificationCursor | null {
  return state.nextCursor;
}

export function makeSelectHostNotificationById(id: string) {
  return (state: HostNotificationsState): HostNotificationEntry | null =>
    state.byId[id] ?? null;
}

export function useHostNotificationIds(): ReadonlyArray<string> {
  return useHostNotificationsStore(selectHostNotificationIds);
}

export function useHostNotificationUnreadCount(): number {
  return useHostNotificationsStore(selectHostNotificationUnreadCount);
}

export function useHostNotificationById(
  id: string,
): HostNotificationEntry | null {
  const selector = useMemo(() => makeSelectHostNotificationById(id), [id]);
  return useHostNotificationsStore(selector);
}

export function __resetHostNotificationsStoreForTests(): void {
  useHostNotificationsStore.getState().reset();
}
