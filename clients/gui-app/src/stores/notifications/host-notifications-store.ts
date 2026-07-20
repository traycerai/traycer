import { useMemo } from "react";
import { create } from "zustand";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  hostNotificationsSubscribeClientFrameSchema,
  hostNotificationsSubscribeServerFrameSchema,
  type HostNotificationCursor,
  type HostNotificationEntry,
  type HostNotificationsSubscribeServerFrame,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  readHostNotificationPresenceFrame,
  subscribeHostNotificationPresence,
  type HostNotificationPresenceFrame,
} from "@/lib/notifications/notification-presence";

export const HOST_NOTIFICATIONS_INITIAL_LIMIT = 50;

/**
 * The host expires presence records after a short TTL (15s at the time of
 * writing) so a dead window can't suppress deliveries forever. A change-driven
 * presence send alone therefore goes stale whenever the user simply stays on
 * one tab — exactly the case suppression exists for — so the stream re-sends
 * the current presence on this cadence, comfortably inside that TTL.
 */
export const HOST_NOTIFICATIONS_PRESENCE_HEARTBEAT_MS = 5_000;

export type HostNotificationFeedEntry = HostNotificationEntry;

export type HostNotificationsFeedFrame = Extract<
  HostNotificationsSubscribeServerFrame,
  | { readonly kind: "snapshot" }
  | { readonly kind: "upserted" }
  | { readonly kind: "readStateChanged" }
  | { readonly kind: "cleared" }
>;

interface HostNotificationsProjection {
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;
}

interface HostNotificationsState {
  readonly byId: Readonly<Record<string, HostNotificationFeedEntry>>;
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;
  readonly connectionStatus: StreamConnectionStatus;
  readonly nextCursor: HostNotificationCursor | null;
  readonly snapshotEpoch: number;

  replaceFromSnapshot: (
    entries: ReadonlyArray<HostNotificationFeedEntry>,
    initialLimit: number,
  ) => void;
  upsert: (entry: HostNotificationFeedEntry) => void;
  mergePage: (
    entries: ReadonlyArray<HostNotificationFeedEntry>,
    nextCursor: HostNotificationCursor | null,
    expectedSnapshotEpoch: number,
  ) => void;
  applyReadState: (
    ids: ReadonlyArray<string>,
    readAt: number | null,
    resolvedAt: number | null | undefined,
    expectedSnapshotEpoch: number,
  ) => void;
  markAllReadLocally: (
    beforeUpdatedAt: number,
    readAt: number,
    expectedSnapshotEpoch: number,
  ) => void;
  clearBeforeLocally: (
    beforeUpdatedAt: number,
    expectedSnapshotEpoch: number,
  ) => void;
  reset: () => void;
}

function projectHostNotifications(
  byId: Readonly<Record<string, HostNotificationFeedEntry>>,
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
  a: HostNotificationFeedEntry,
  b: HostNotificationFeedEntry,
): number {
  const updatedAtDelta = b.updatedAt - a.updatedAt;
  if (updatedAtDelta !== 0) return updatedAtDelta;
  return b.id.localeCompare(a.id);
}

function cursorFromEntries(
  entries: ReadonlyArray<HostNotificationFeedEntry>,
  initialLimit: number,
): HostNotificationCursor | null {
  if (entries.length < initialLimit) return null;
  const sorted = [...entries].sort(compareHostNotificationEntries);
  const last = sorted.at(-1);
  if (last === undefined) return null;
  return { updatedAt: last.updatedAt, id: last.id };
}

function mergeById(
  current: Readonly<Record<string, HostNotificationFeedEntry>>,
  entries: ReadonlyArray<HostNotificationFeedEntry>,
): Readonly<Record<string, HostNotificationFeedEntry>> {
  if (entries.length === 0) return current;
  const next: Record<string, HostNotificationFeedEntry> = { ...current };
  for (const entry of entries) {
    const hasCurrent = Object.hasOwn(current, entry.id);
    if (hasCurrent && current[entry.id].updatedAt > entry.updatedAt) {
      continue;
    }
    next[entry.id] =
      hasCurrent && current[entry.id].updatedAt === entry.updatedAt
        ? preserveReadState(current[entry.id], entry)
        : entry;
  }
  return next;
}

function preserveReadState(
  current: HostNotificationFeedEntry,
  incoming: HostNotificationFeedEntry,
): HostNotificationFeedEntry {
  const readAt = current.readAt;
  if ("resolvedAt" in current && "resolvedAt" in incoming) {
    return { ...incoming, readAt, resolvedAt: current.resolvedAt };
  }
  return { ...incoming, readAt };
}

function applyReadStateById(
  current: Readonly<Record<string, HostNotificationFeedEntry>>,
  ids: ReadonlyArray<string>,
  readAt: number | null,
  resolvedAt: number | null | undefined,
): Readonly<Record<string, HostNotificationFeedEntry>> {
  let changed = false;
  const next: Record<string, HostNotificationFeedEntry> = { ...current };
  for (const id of ids) {
    if (!Object.hasOwn(current, id)) continue;
    const entry = current[id];
    const resolvedAtChanged =
      "resolvedAt" in entry &&
      resolvedAt !== undefined &&
      entry.resolvedAt !== resolvedAt;
    if (entry.readAt === readAt && !resolvedAtChanged) continue;
    next[id] =
      "resolvedAt" in entry && resolvedAt !== undefined
        ? { ...entry, readAt, resolvedAt }
        : { ...entry, readAt };
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

    applyReadState: (ids, readAt, resolvedAt, expectedSnapshotEpoch) => {
      set((state) => {
        if (state.snapshotEpoch !== expectedSnapshotEpoch) return state;
        const byId = applyReadStateById(state.byId, ids, readAt, resolvedAt);
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
        const byId = applyReadStateById(state.byId, ids, readAt, undefined);
        if (byId === state.byId) return state;
        const projection = projectHostNotifications(byId);
        return {
          byId,
          orderedIds: projection.orderedIds,
          unreadCount: projection.unreadCount,
        };
      });
    },

    clearBeforeLocally: (beforeUpdatedAt, expectedSnapshotEpoch) => {
      set((state) => {
        if (state.snapshotEpoch !== expectedSnapshotEpoch) return state;
        const retainedEntries = Object.values(state.byId).filter(
          (entry) => entry.updatedAt > beforeUpdatedAt,
        );
        if (retainedEntries.length === state.orderedIds.length) return state;
        const byId = Object.fromEntries(
          retainedEntries.map((entry) => [entry.id, entry]),
        );
        const projection = projectHostNotifications(byId);
        return {
          byId,
          orderedIds: projection.orderedIds,
          unreadCount: projection.unreadCount,
          nextCursor: null,
        };
      });
    },

    reset: () => set(initialState()),
  }),
);

export function openHostNotificationsStream(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  onAuthError: (() => void) | null,
  options: {
    readonly windowId: string;
    readonly now: () => number;
    readonly displayChannelEmission: (
      entries: ReadonlyArray<HostNotificationFeedEntry>,
    ) => void;
    readonly onFeedFrame: (frame: HostNotificationsFeedFrame) => void;
    readonly onPresenceChanged: (frame: HostNotificationPresenceFrame) => void;
    readonly onStreamOpened: () => void;
  },
): () => void {
  const session = wsStreamClient.subscribe("host.notifications.subscribe", {
    filter: "all",
    initialLimit: HOST_NOTIFICATIONS_INITIAL_LIMIT,
  });
  let lastPresenceKey: string | null = null;
  // `force` refreshes the host's TTL'd presence record even when nothing
  // changed locally; change-driven sends stay deduplicated by content.
  const sendPresence = (force: boolean): void => {
    const frame = readHostNotificationPresenceFrame({
      windowId: options.windowId,
      now: options.now,
    });
    const parsed = hostNotificationsSubscribeClientFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    if (parsed.data.kind !== "presence") return;
    const presence = parsed.data;
    const presenceKey = JSON.stringify({
      focused: presence.focused,
      entity: presence.entity,
    });
    if (!force && presenceKey === lastPresenceKey) return;
    lastPresenceKey = presenceKey;
    session.sendClientFrame(presence, null);
    options.onPresenceChanged(presence);
  };
  const unsubscribePresence = subscribeHostNotificationPresence(() => {
    sendPresence(false);
  });
  const presenceHeartbeat = globalThis.setInterval(() => {
    sendPresence(true);
  }, HOST_NOTIFICATIONS_PRESENCE_HEARTBEAT_MS);
  sendPresence(true);
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
        options.onFeedFrame(frame);
        return;
      case "upserted":
        useHostNotificationsStore.getState().upsert(frame.entry);
        options.onFeedFrame(frame);
        return;
      case "readStateChanged":
        useHostNotificationsStore
          .getState()
          .applyReadState(
            frame.ids,
            frame.readAt,
            frame.resolvedAt,
            useHostNotificationsStore.getState().snapshotEpoch,
          );
        options.onFeedFrame(frame);
        return;
      case "cleared":
        useHostNotificationsStore
          .getState()
          .clearBeforeLocally(
            frame.beforeUpdatedAt,
            useHostNotificationsStore.getState().snapshotEpoch,
          );
        options.onFeedFrame(frame);
        return;
      case "channelEmission":
        if (frame.channelId === "renderer") {
          const currentById = useHostNotificationsStore.getState().byId;
          options.displayChannelEmission(
            frame.rows.map((entry) => {
              const current = currentById[entry.id];
              return Object.hasOwn(currentById, entry.id) &&
                current.updatedAt >= entry.updatedAt
                ? current
                : entry;
            }),
          );
        }
        return;
      case "pong":
        return;
    }
  });
  session.onStatusChange((status, reason) => {
    useHostNotificationsStore.setState({ connectionStatus: status });
    if (status === "open") {
      lastPresenceKey = null;
      options.onStreamOpened();
      sendPresence(true);
    }
    handleHostNotificationsCloseReason(reason, onAuthError);
  });
  return () => {
    globalThis.clearInterval(presenceHeartbeat);
    unsubscribePresence();
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
  return (state: HostNotificationsState): HostNotificationFeedEntry | null =>
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
): HostNotificationFeedEntry | null {
  const selector = useMemo(() => makeSelectHostNotificationById(id), [id]);
  return useHostNotificationsStore(selector);
}

export function __resetHostNotificationsStoreForTests(): void {
  useHostNotificationsStore.getState().reset();
}
