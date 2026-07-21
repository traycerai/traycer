import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  hostNotificationsSubscribeClientFrameSchema,
  hostNotificationsSubscribeServerFrameSchema,
  type HostNotificationEntry,
  type HostNotificationsAttentionCursor,
  type HostNotificationsChronologicalCursor,
  type HostNotificationsSubscribeServerFrame,
  type HostNotificationsSummary,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  readHostNotificationPresenceFrame,
  subscribeHostNotificationPresence,
  type HostNotificationPresenceFrame,
} from "@/lib/notifications/notification-presence";
import { compareFeedIdAscending } from "@/lib/notifications/notification-lifecycle";

export const HOST_NOTIFICATIONS_INITIAL_ATTENTION_LIMIT = 50;
export const HOST_NOTIFICATIONS_INITIAL_RECENT_LIMIT = 50;

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
  | { readonly kind: "removed" }
  | { readonly kind: "cleared" }
>;

/** Request lifecycle for one paginated projection. Whether more can be
 * loaded is carried by the track's cursor (`null` = exhausted), not here. */
export type HostNotificationsPageStatus = "idle" | "loading" | "error";

interface PageMergeExpectation<Cursor> {
  readonly snapshotEpoch: number;
  /** Captured `liveLifecycleRevision` at request start. A page response can
   * merge rows / advance its cursor only while this still matches - any live
   * frame landing after the request began (e.g. an exact removal) must
   * discard the whole response rather than risk resurrecting a pruned row. */
  readonly liveLifecycleRevision: number;
  readonly cursor: Cursor | null;
}

interface HostNotificationsState {
  readonly byId: Readonly<Record<string, HostNotificationFeedEntry>>;
  /** `null` means the exact host contribution is unknown: never derive a
   * composite count from `byId`, which is only ever a partial window. */
  readonly summary: HostNotificationsSummary | null;
  readonly attentionCursor: HostNotificationsAttentionCursor | null;
  readonly recentCursor: HostNotificationsChronologicalCursor | null;
  readonly unreadRecentCursor: HostNotificationsChronologicalCursor | null;
  /** Unlike the other two tracks, a `null` `unreadRecentCursor` is ambiguous
   * between "never loaded" and "exhausted". This disambiguates it: `true`
   * once any `unreadRecent` page has successfully merged, so `null` + `true`
   * means genuinely exhausted. Resets alongside the cursor on every snapshot
   * (host reconnect/switch/identity change). */
  readonly unreadRecentHasLoadedOnce: boolean;
  readonly attentionStatus: HostNotificationsPageStatus;
  readonly recentStatus: HostNotificationsPageStatus;
  readonly unreadRecentStatus: HostNotificationsPageStatus;
  readonly connectionStatus: StreamConnectionStatus;
  readonly snapshotEpoch: number;
  /** Monotonic counter bumped on every live server-pushed lifecycle frame
   * (upsert/read-state/removal). Page requests capture it; a response whose
   * captured value no longer matches is discarded outright. */
  readonly liveLifecycleRevision: number;

  applySnapshot: (snapshot: {
    readonly attention: {
      readonly entries: ReadonlyArray<HostNotificationFeedEntry>;
      readonly nextCursor: HostNotificationsAttentionCursor | null;
    };
    readonly recent: {
      readonly entries: ReadonlyArray<HostNotificationFeedEntry>;
      readonly nextCursor: HostNotificationsChronologicalCursor | null;
    };
    readonly summary: HostNotificationsSummary;
  }) => void;
  applyUpsertFrame: (
    entry: HostNotificationFeedEntry,
    removedIds: ReadonlyArray<string>,
    summary: HostNotificationsSummary,
  ) => void;
  applyReadStateFrame: (
    ids: ReadonlyArray<string>,
    change: {
      readonly readAt: number | null;
      readonly resolvedAt: number | null;
      readonly removedIds: ReadonlyArray<string>;
      readonly summary: HostNotificationsSummary;
    },
  ) => void;
  applyRemovalFrame: (
    removedIds: ReadonlyArray<string>,
    summary: HostNotificationsSummary,
  ) => void;
  markReadLocally: (
    ids: ReadonlyArray<string>,
    readAt: number,
    expectedSnapshotEpoch: number,
  ) => void;
  markAllReadLocally: (
    beforeUpdatedAt: number,
    readAt: number,
    expectedSnapshotEpoch: number,
  ) => void;
  markSummaryUnknown: () => void;
  setPageStatus: (
    track: "attention" | "recent" | "unreadRecent",
    status: HostNotificationsPageStatus,
  ) => void;
  mergeAttentionPage: (
    entries: ReadonlyArray<HostNotificationFeedEntry>,
    nextCursor: HostNotificationsAttentionCursor | null,
    expected: PageMergeExpectation<HostNotificationsAttentionCursor>,
  ) => void;
  mergeRecentPage: (
    entries: ReadonlyArray<HostNotificationFeedEntry>,
    nextCursor: HostNotificationsChronologicalCursor | null,
    expected: PageMergeExpectation<HostNotificationsChronologicalCursor>,
  ) => void;
  mergeUnreadRecentPage: (
    entries: ReadonlyArray<HostNotificationFeedEntry>,
    nextCursor: HostNotificationsChronologicalCursor | null,
    expected: PageMergeExpectation<HostNotificationsChronologicalCursor>,
  ) => void;
  setConnectionStatus: (status: StreamConnectionStatus) => void;
  reset: () => void;
}

/** Matches the host's `updatedAt DESC, id ASC` tie-break exactly, so the
 * renderer's projection order never disagrees with SQLite's. */
export function compareHostNotificationEntries(
  a: HostNotificationFeedEntry,
  b: HostNotificationFeedEntry,
): number {
  const updatedAtDelta = b.updatedAt - a.updatedAt;
  if (updatedAtDelta !== 0) return updatedAtDelta;
  return compareFeedIdAscending(a.id, b.id);
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

function withoutIds(
  byId: Readonly<Record<string, HostNotificationFeedEntry>>,
  ids: ReadonlyArray<string>,
): Readonly<Record<string, HostNotificationFeedEntry>> {
  if (ids.length === 0) return byId;
  const next = { ...byId };
  for (const id of ids) {
    delete next[id];
  }
  return next;
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

function chronologicalCursorsEqual(
  a: HostNotificationsChronologicalCursor | null,
  b: HostNotificationsChronologicalCursor | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.updatedAt === b.updatedAt && a.id === b.id;
}

function attentionCursorsEqual(
  a: HostNotificationsAttentionCursor | null,
  b: HostNotificationsAttentionCursor | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.tier === b.tier && a.updatedAt === b.updatedAt && a.id === b.id;
}

function initialState(): Pick<
  HostNotificationsState,
  | "byId"
  | "summary"
  | "attentionCursor"
  | "recentCursor"
  | "unreadRecentCursor"
  | "unreadRecentHasLoadedOnce"
  | "attentionStatus"
  | "recentStatus"
  | "unreadRecentStatus"
  | "connectionStatus"
  | "snapshotEpoch"
  | "liveLifecycleRevision"
> {
  return {
    byId: {},
    summary: null,
    attentionCursor: null,
    recentCursor: null,
    unreadRecentCursor: null,
    unreadRecentHasLoadedOnce: false,
    attentionStatus: "idle",
    recentStatus: "idle",
    unreadRecentStatus: "idle",
    connectionStatus: "connecting",
    snapshotEpoch: 0,
    liveLifecycleRevision: 0,
  };
}

export const useHostNotificationsStore = create<HostNotificationsState>()(
  (set) => ({
    ...initialState(),

    applySnapshot: (snapshot) => {
      set((state) => ({
        byId: mergeById({}, [
          ...snapshot.attention.entries,
          ...snapshot.recent.entries,
        ]),
        summary: snapshot.summary,
        attentionCursor: snapshot.attention.nextCursor,
        recentCursor: snapshot.recent.nextCursor,
        unreadRecentCursor: null,
        unreadRecentHasLoadedOnce: false,
        attentionStatus: "idle",
        recentStatus: "idle",
        unreadRecentStatus: "idle",
        snapshotEpoch: state.snapshotEpoch + 1,
      }));
    },

    applyUpsertFrame: (entry, removedIds, summary) => {
      set((state) => {
        const withoutRemoved = withoutIds(state.byId, removedIds);
        const byId = removedIds.includes(entry.id)
          ? withoutRemoved
          : { ...withoutRemoved, [entry.id]: entry };
        return {
          byId,
          summary,
          liveLifecycleRevision: state.liveLifecycleRevision + 1,
        };
      });
    },

    applyReadStateFrame: (ids, change) => {
      set((state) => {
        const patched = applyReadStateById(
          state.byId,
          ids,
          change.readAt,
          change.resolvedAt,
        );
        const byId = withoutIds(patched, change.removedIds);
        return {
          byId,
          summary: change.summary,
          liveLifecycleRevision: state.liveLifecycleRevision + 1,
        };
      });
    },

    applyRemovalFrame: (removedIds, summary) => {
      set((state) => ({
        byId: withoutIds(state.byId, removedIds),
        summary,
        liveLifecycleRevision: state.liveLifecycleRevision + 1,
      }));
    },

    markReadLocally: (ids, readAt, expectedSnapshotEpoch) => {
      set((state) => {
        if (state.snapshotEpoch !== expectedSnapshotEpoch) return state;
        const byId = applyReadStateById(state.byId, ids, readAt, undefined);
        return byId === state.byId ? state : { byId };
      });
    },

    markAllReadLocally: (beforeUpdatedAt, readAt, expectedSnapshotEpoch) => {
      set((state) => {
        if (state.snapshotEpoch !== expectedSnapshotEpoch) return state;
        const ids = Object.values(state.byId)
          .filter(
            (entry) =>
              entry.readAt === null && entry.updatedAt <= beforeUpdatedAt,
          )
          .map((entry) => entry.id);
        const byId = applyReadStateById(state.byId, ids, readAt, undefined);
        return byId === state.byId ? state : { byId };
      });
    },

    markSummaryUnknown: () => {
      set({ summary: null });
    },

    setPageStatus: (track, status) => {
      if (track === "attention") {
        set({ attentionStatus: status });
        return;
      }
      if (track === "recent") {
        set({ recentStatus: status });
        return;
      }
      set({ unreadRecentStatus: status });
    },

    mergeAttentionPage: (entries, nextCursor, expected) => {
      set((state) => {
        // Every expected token must match before ANY row merges or the
        // cursor advances - a stale epoch/cursor is rejected outright rather
        // than partially enriching `byId`, or a crossed reset/snapshot could
        // still smuggle a prior identity's rows into the live replica.
        const stale =
          state.liveLifecycleRevision !== expected.liveLifecycleRevision ||
          state.snapshotEpoch !== expected.snapshotEpoch ||
          !attentionCursorsEqual(state.attentionCursor, expected.cursor);
        if (stale) return { attentionStatus: "idle" };
        return {
          byId: mergeById(state.byId, entries),
          attentionCursor: nextCursor,
          attentionStatus: "idle",
        };
      });
    },

    mergeRecentPage: (entries, nextCursor, expected) => {
      set((state) => {
        const stale =
          state.liveLifecycleRevision !== expected.liveLifecycleRevision ||
          state.snapshotEpoch !== expected.snapshotEpoch ||
          !chronologicalCursorsEqual(state.recentCursor, expected.cursor);
        if (stale) return { recentStatus: "idle" };
        return {
          byId: mergeById(state.byId, entries),
          recentCursor: nextCursor,
          recentStatus: "idle",
        };
      });
    },

    mergeUnreadRecentPage: (entries, nextCursor, expected) => {
      set((state) => {
        const stale =
          state.liveLifecycleRevision !== expected.liveLifecycleRevision ||
          state.snapshotEpoch !== expected.snapshotEpoch ||
          !chronologicalCursorsEqual(state.unreadRecentCursor, expected.cursor);
        if (stale) return { unreadRecentStatus: "idle" };
        return {
          byId: mergeById(state.byId, entries),
          unreadRecentCursor: nextCursor,
          unreadRecentHasLoadedOnce: true,
          unreadRecentStatus: "idle",
        };
      });
    },

    setConnectionStatus: (status) => {
      set(() =>
        status === "open"
          ? { connectionStatus: status }
          : { connectionStatus: status, summary: null },
      );
    },

    // `snapshotEpoch`/`liveLifecycleRevision` are ADVANCED here, never
    // restored to zero AND never merely preserved: an in-flight request
    // captures one of these tokens before this fires, and preserving them
    // unchanged would leave the exact captured pair still matching for the
    // whole cleared pre-snapshot interval - until a replacement snapshot
    // finally bumps the epoch - letting that stale, prior-identity response
    // merge into the now-empty replica. Bumping both immediately, right here,
    // closes that window entirely: no captured token can match again from the
    // instant reset runs. Both counters only ever increase for the store's
    // entire lifetime, across every reset, so a captured token can never
    // match again once superseded.
    reset: () =>
      set((state) => ({
        ...initialState(),
        snapshotEpoch: state.snapshotEpoch + 1,
        liveLifecycleRevision: state.liveLifecycleRevision + 1,
      })),
  }),
);

export function openHostNotificationsStream(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
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
  let disposed = false;
  let currentSession: IStreamSession | null = null;
  let lastPresenceKey: string | null = null;

  // `force` refreshes the host's TTL'd presence record even when nothing
  // changed locally; change-driven sends stay deduplicated by content.
  const sendPresence = (force: boolean): void => {
    const session = currentSession;
    if (session === null) return;
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

  // A stream frame that fails the contract-specific schema is a
  // connection-integrity failure: the exact summary can no longer be
  // trusted, so the store degrades to unknown and the session redials for a
  // fresh atomic snapshot. Already-rendered rows are left untouched.
  const reconnect = (): void => {
    if (disposed) return;
    useHostNotificationsStore.getState().markSummaryUnknown();
    currentSession?.requestReconnect();
  };

  function openSession(): void {
    if (disposed) return;
    const session = wsStreamClient.subscribe(
      "host.notifications.feed.subscribe",
      {
        initialAttentionLimit: HOST_NOTIFICATIONS_INITIAL_ATTENTION_LIMIT,
        initialRecentLimit: HOST_NOTIFICATIONS_INITIAL_RECENT_LIMIT,
      },
    );
    currentSession = session;
    session.onServerFrame((envelope, binaryPayload) => {
      // Notification frames are contractually text-only; an unexpected
      // binary payload is the same connection-integrity failure as a
      // malformed text envelope, not a silently ignorable frame.
      if (binaryPayload !== null) {
        reconnect();
        return;
      }
      const parsed =
        hostNotificationsSubscribeServerFrameSchema.safeParse(envelope);
      if (!parsed.success) {
        reconnect();
        return;
      }
      const frame = parsed.data;
      switch (frame.kind) {
        case "snapshot":
          useHostNotificationsStore.getState().applySnapshot(frame);
          options.onFeedFrame(frame);
          return;
        case "upserted":
          useHostNotificationsStore
            .getState()
            .applyUpsertFrame(frame.entry, frame.removedIds, frame.summary);
          options.onFeedFrame(frame);
          return;
        case "readStateChanged":
          useHostNotificationsStore.getState().applyReadStateFrame(frame.ids, {
            readAt: frame.readAt,
            resolvedAt: frame.resolvedAt,
            removedIds: frame.removedIds,
            summary: frame.summary,
          });
          options.onFeedFrame(frame);
          return;
        case "removed":
        case "cleared":
          useHostNotificationsStore
            .getState()
            .applyRemovalFrame(frame.removedIds, frame.summary);
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
      useHostNotificationsStore.getState().setConnectionStatus(status);
      if (status === "open") {
        lastPresenceKey = null;
        options.onStreamOpened();
        sendPresence(true);
      }
      handleHostNotificationsCloseReason(reason, onAuthError);
    });
  }

  openSession();

  return () => {
    disposed = true;
    globalThis.clearInterval(presenceHeartbeat);
    unsubscribePresence();
    currentSession?.close();
    currentSession = null;
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
  const entries = Object.values(state.byId);
  entries.sort(compareHostNotificationEntries);
  return entries.map((entry) => entry.id);
}

export function selectHostNotificationUnreadCount(
  state: HostNotificationsState,
): number {
  return state.summary?.unreadCount ?? 0;
}

export function selectHostNotificationRecentCursor(
  state: HostNotificationsState,
): HostNotificationsChronologicalCursor | null {
  return state.recentCursor;
}

export function selectHostNotificationAttentionCursor(
  state: HostNotificationsState,
): HostNotificationsAttentionCursor | null {
  return state.attentionCursor;
}

export function selectHostNotificationUnreadRecentCursor(
  state: HostNotificationsState,
): HostNotificationsChronologicalCursor | null {
  return state.unreadRecentCursor;
}

export function selectHostNotificationUnreadRecentHasLoadedOnce(
  state: HostNotificationsState,
): boolean {
  return state.unreadRecentHasLoadedOnce;
}

/** `null` means the exact host contribution is unknown - see the store's
 * `summary` field doc. Never derive this from `byId`. */
export function selectHostNotificationSummary(
  state: HostNotificationsState,
): HostNotificationsSummary | null {
  return state.summary;
}

export function makeSelectHostNotificationById(id: string) {
  return (state: HostNotificationsState): HostNotificationFeedEntry | null =>
    state.byId[id] ?? null;
}

export function useHostNotificationIds(): ReadonlyArray<string> {
  // `selectHostNotificationIds` always allocates a fresh array; shallow-
  // compare the contents so subscribers don't re-render in a loop when
  // `byId` is stable.
  return useHostNotificationsStore(useShallow(selectHostNotificationIds));
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

// Bypasses the production `reset()` action deliberately: production reset
// preserves `snapshotEpoch`/`liveLifecycleRevision` so they stay monotonic
// (see `reset()`'s own comment), but test isolation between cases wants a
// true zero-state so fixtures can assert on small absolute token values.
export function __resetHostNotificationsStoreForTests(): void {
  useHostNotificationsStore.setState(initialState());
}
