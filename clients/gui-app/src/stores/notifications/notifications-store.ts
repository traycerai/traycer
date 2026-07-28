import { useMemo } from "react";
import { create, type UseBoundStore, type StoreApi } from "zustand";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
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
import { createNotificationStreamReopenScheduler } from "@/lib/notifications/notification-stream-reopen";

/** The surface `openNotificationsStream` needs from a stream client; the
 * only two members production and test doubles both provide. */
type NotificationsStreamClientHandle = Pick<
  NotificationsStreamClient,
  "applyUpdate" | "close"
>;
import {
  EMPTY_AGENT_ACTIVITY_BY_EPIC,
  EMPTY_EPIC_AGENT_ACTIVITY,
  readAgentActivityByEpic,
  type EpicAgentActivity,
} from "@/lib/notifications/agent-activity-presence";

export type NotificationsStreamClientFactory = (
  callbacks: NotificationsStreamCallbacks,
) => NotificationsStreamClientHandle;

interface NotificationsState {
  readonly doc: Y.Doc;
  readonly snapshotMeta: NotificationsSnapshotMeta | null;
  readonly connectionStatus: StreamConnectionStatus;
  readonly entries: ReadonlyArray<NotificationEntry>;
  readonly entryIds: ReadonlyArray<string>;
  readonly unreadCount: number;
  readonly revision: number;
  /**
   * Cross-epic, cross-host agent-activity presence, folded from the room's
   * awareness entries (one per host). THE source for every activity indicator
   * in the app - unlike per-epic collaboration awareness it covers epics this
   * window has never opened, which is the whole point of moving the signal
   * onto the always-subscribed per-user room.
   *
   * Per-epic values are identity-stable while that epic's membership is
   * unchanged, so a per-epic selector bails the re-render when an unrelated
   * epic's agents start or stop.
   */
  readonly agentActivityByEpic: ReadonlyMap<string, EpicAgentActivity>;

  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
  reset: () => void;
}

const LOCAL_ORIGIN = "local";
const STREAM_ORIGIN = "stream";

/** An empty Y update encodes to exactly 2 bytes; anything longer carries
 * real operations. Same check the epic store's reconcile path uses. */
const EMPTY_Y_UPDATE_BYTES = 2;

function isNonTrivialYUpdate(updateBytes: Uint8Array): boolean {
  return updateBytes.length > EMPTY_Y_UPDATE_BYTES;
}

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
  /**
   * Folds the room's awareness entries into the cross-epic activity union.
   * Returns the prior map by reference when nothing changed.
   */
  projectAgentActivity(): ReadonlyMap<string, EpicAgentActivity>;
  onAwareness(handler: () => void): () => void;
  applyAwareness(updateBytes: Uint8Array): void;
  /**
   * Discards the whole awareness replica - entries AND their per-clientId
   * clocks - and notifies awareness subscribers. Used when a room session is
   * (re)opened: awareness has no CRDT-style merge that would make carrying
   * stale entries safe, and the attaching host re-ships the current states.
   */
  clearAwareness(): void;
  replace(): void;
}

/**
 * A reader-only `Awareness` paired with the throwaway Y.Doc it is bound to.
 *
 * Reader-only means it never publishes a local state, which matters twice over:
 * `applyAwarenessUpdate` refuses a remote removal of our OWN clientID while we
 * hold a local state, and y-protocols' outdated-entry sweep (~30s) only runs
 * its eviction arm for a reader. That sweep is what clears a crashed or
 * disconnected host's spinners with no cleanup protocol.
 */
interface ReaderAwareness {
  readonly awareness: Awareness;
  readonly doc: Y.Doc;
}

/**
 * Builds a reader over its OWN disposable doc - deliberately NOT the
 * notifications doc.
 *
 * `Awareness`'s constructor registers an anonymous `doc.on("destroy", () =>
 * this.destroy())` that its own `destroy()` never unregisters. Every reset
 * swaps the reader instance while the notifications doc lives on, so binding
 * readers to that doc would leave one dead closure per reset behind, each
 * retaining a retired instance's states and meta until an identity reset
 * finally destroyed the doc. Giving the reader a doc of its own makes teardown
 * total: destroying that doc takes the listener with it.
 *
 * Nothing is lost by decoupling them - this replica never reads or writes
 * notifications-doc content, it only decodes awareness bytes off the wire. The
 * one visible consequence is that our own clientID churns per swap, which is
 * irrelevant for a reader whose local state is always null.
 */
function createReaderAwareness(): ReaderAwareness {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  return { awareness, doc };
}

function createNotificationsReplica(): NotificationsReplica {
  let doc = new Y.Doc();
  let reader = createReaderAwareness();
  let lastProjectionKey: string | null = null;
  let lastEntries: ReadonlyArray<NotificationEntry> = [];
  let lastEntryIds: ReadonlyArray<string> = [];
  let lastUnread = 0;
  let lastAgentActivity: ReadonlyMap<string, EpicAgentActivity> =
    EMPTY_AGENT_ACTIVITY_BY_EPIC;

  // The replica - not the store - owns the awareness listener fan-out, because
  // resetting awareness means REPLACING the instance (see `installAwareness`).
  // Subscribers register once here and survive every swap; a single internal
  // bridge is what actually moves between instances.
  const awarenessListeners = new Set<() => void>();
  const notifyAwareness = (): void => {
    for (const listener of [...awarenessListeners]) listener();
  };
  let detachAwareness = attachAwarenessBridge(reader.awareness);

  function attachAwarenessBridge(target: Awareness): () => void {
    // "change" (not "update"): clock-only renewals carry no membership change,
    // and re-folding the union on each one would churn every indicator.
    target.on("change", notifyAwareness);
    return () => {
      target.off("change", notifyAwareness);
    };
  }

  /**
   * Tears the current reader down completely - listener bridge, instance, and
   * the doc it was bound to. Destroying that doc is what drops the anonymous
   * destroy listener `Awareness` registered on it; the instance's own
   * `destroy()` cannot. (The cascade calls `destroy()` a second time, which is
   * a no-op on an already-torn-down instance.)
   */
  function retireAwareness(): void {
    detachAwareness();
    reader.awareness.destroy();
    reader.doc.destroy();
  }

  /**
   * Installs a fresh reader and republishes the (now empty) union.
   *
   * Every awareness reset goes through here, and every one of them REPLACES the
   * instance rather than calling `removeAwarenessStates`: that helper deletes
   * the states but leaves `meta.clock` behind for each remote clientId, and
   * `applyAwarenessUpdate` drops an inbound entry whose clock is not strictly
   * greater. The replacement session's attach-time replay re-ships each host's
   * CURRENT state at its CURRENT clock, so a clock-retaining reset would make
   * that whole replay a no-op and blank every indicator until each publisher's
   * next renewal (~15s later). Only a fresh `meta` accepts the replay.
   */
  function installAwareness(): void {
    reader = createReaderAwareness();
    detachAwareness = attachAwarenessBridge(reader.awareness);
    lastAgentActivity = EMPTY_AGENT_ACTIVITY_BY_EPIC;
    // No "change" fires for a swap, so drive the projection by hand - otherwise
    // the store would keep rendering the retired instance's union.
    notifyAwareness();
  }

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

  function projectAgentActivity(): ReadonlyMap<string, EpicAgentActivity> {
    lastAgentActivity = readAgentActivityByEpic(
      reader.awareness.getStates().values(),
      lastAgentActivity,
    );
    return lastAgentActivity;
  }

  function onAwareness(handler: () => void): () => void {
    awarenessListeners.add(handler);
    return () => {
      awarenessListeners.delete(handler);
    };
  }

  function applyAwareness(updateBytes: Uint8Array): void {
    applyAwarenessUpdate(reader.awareness, updateBytes, STREAM_ORIGIN);
  }

  function clearAwareness(): void {
    retireAwareness();
    installAwareness();
  }

  function replace(): void {
    // Both reset paths route through the same retire/install pair so they
    // cannot drift. The reader owns its own doc, so retiring it is independent
    // of the notifications doc being swapped here.
    retireAwareness();
    doc.destroy();
    doc = new Y.Doc();
    lastProjectionKey = null;
    lastEntries = [];
    lastEntryIds = [];
    lastUnread = 0;
    installAwareness();
  }

  return {
    getDoc: () => doc,
    project,
    onProjection,
    projectAgentActivity,
    onAwareness,
    applyAwareness,
    clearAwareness,
    replace,
  };
}

function createNotificationsStore(
  replica: NotificationsReplica,
): UseBoundStore<StoreApi<NotificationsState>> {
  let unwireProjection: (() => void) | null = null;

  const store = create<NotificationsState>()((set, get) => {
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

    const projectFromAwareness = (): void => {
      const next = replica.projectAgentActivity();
      // The reader returns the prior map by reference when the union is
      // unchanged, so this bails every awareness event that only moved an
      // unrelated field or re-stamped an identical entry.
      if (next === get().agentActivityByEpic) return;
      set({ agentActivityByEpic: next });
    };

    unwireProjection = replica.onProjection(projectFromDoc);
    // Registered once for the life of this singleton store - the replica keeps
    // the handler across every awareness instance swap, so there is nothing to
    // re-wire on reset.
    replica.onAwareness(projectFromAwareness);

    return {
      doc: replica.getDoc(),
      snapshotMeta: null,
      connectionStatus: "connecting",
      entries: [],
      entryIds: [],
      unreadCount: 0,
      revision: 0,
      agentActivityByEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,

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
        // Only the doc projection needs re-wiring: `onProjection` binds to the
        // Y.Doc that `replace()` swaps out, whereas the awareness registration
        // lives on the replica and follows it across instance swaps.
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
          // The activity union is user-scoped presence, so it dies with the
          // rest of the replica on sign-out / user-switch - the incoming user
          // must never inherit the outgoing one's spinners.
          agentActivityByEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
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
 *
 * The Y.Doc is deliberately NOT reset here (a reconnect's snapshot merges into
 * it), but the awareness replica IS: awareness has no merge that makes a
 * carried-over entry safe, and the attaching session re-ships every current
 * state anyway. The reset discards the per-clientId CLOCKS along with the
 * entries - see `clearAwareness`, where keeping them would make that attach-time
 * replay a no-op.
 */
export function openNotificationsStream(
  factory: NotificationsStreamClientFactory,
  onAuthError: (() => void) | null,
): () => void {
  replica.clearAwareness();
  const targetDoc = replica.getDoc();
  let disposed = false;
  let currentClient: NotificationsStreamClientHandle | null = null;
  let generation = 0;

  const reopenScheduler = createNotificationStreamReopenScheduler(() => {
    currentClient?.close();
    currentClient = null;
    // The scheduler reopens the stream without recreating this store. Reset the
    // reader so the host's attach-time awareness replay is accepted at its
    // current clocks rather than being discarded against retained metadata.
    replica.clearAwareness();
    openClient();
  });

  function openClient(): void {
    if (disposed) return;
    generation += 1;
    const clientGeneration = generation;
    // A superseded client (replaced by a reopen) must not touch the replica
    // or the status projection its successor now owns.
    const isCurrent = (): boolean =>
      !disposed && clientGeneration === generation;
    // Bound per generation so the reconcile send below targets THIS client
    // rather than re-reading the module-scoped `currentClient`, whose value
    // depends on assignment ordering around `factory`.
    let client: NotificationsStreamClientHandle | null = null;
    client = factory({
      onSnapshot: (meta, snapshotBytes) => {
        if (!isCurrent()) return;
        // `Y.applyUpdate` fires the doc's "update" listener synchronously, so
        // the entries/unreadCount projection runs without us having to call it
        // here. Only `snapshotMeta` needs an explicit setState.
        Y.applyUpdate(targetDoc, snapshotBytes, STREAM_ORIGIN);
        useNotificationsStore.setState({ snapshotMeta: meta });
        // Reconcile: local transactions made while no usable session existed
        // (terminal gap, mid-reconnect, pre-snapshot) were dropped by the
        // fire-and-forget send and would otherwise stay local-only forever.
        // The snapshot bytes encode exactly what the host had at snapshot
        // time, so the delta against their state vector is everything the
        // host is missing. The notifications room is the user's own — no
        // viewer-role gate applies (unlike the epic reconcile path).
        const reconcileUpdate = Y.encodeStateAsUpdate(
          targetDoc,
          Y.encodeStateVectorFromUpdate(snapshotBytes),
        );
        if (isNonTrivialYUpdate(reconcileUpdate)) {
          client?.applyUpdate(reconcileUpdate);
        }
        // A snapshot — not the raw transport `open` — is the proof the
        // stream is actually usable: the host resolver's async init can
        // still fail after `open`, and resetting there would pin the reopen
        // backoff at its floor through an init-failure loop.
        reopenScheduler.resetBackoff();
      },
      onUpdate: (updateBytes) => {
        if (!isCurrent()) return;
        Y.applyUpdate(targetDoc, updateBytes, STREAM_ORIGIN);
      },
      onAwareness: (awarenessBytes) => {
        if (!isCurrent()) return;
        replica.applyAwareness(awarenessBytes);
      },
      onConnectionStatus: (status, reason) => {
        if (!isCurrent()) return;
        useNotificationsStore.setState({ connectionStatus: status });
        if (status !== "closed") return;
        reopenScheduler.scheduleAfterClose(reason);
        if (
          reason !== null &&
          reason.kind === "fatalError" &&
          reason.details.code === "UNAUTHORIZED" &&
          onAuthError !== null
        ) {
          onAuthError();
        }
      },
    });
    currentClient = client;
  }

  openClient();

  const forwardLocal = (update: Uint8Array, origin: unknown): void => {
    if (origin === LOCAL_ORIGIN) {
      currentClient?.applyUpdate(update);
    }
  };
  targetDoc.on("update", forwardLocal);

  return () => {
    disposed = true;
    reopenScheduler.dispose();
    targetDoc.off("update", forwardLocal);
    currentClient?.close();
    currentClient = null;
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
}

// ---------------------------------------------------------------------------
// Agent-activity presence (cross-epic, cross-host)
// ---------------------------------------------------------------------------

/**
 * This epic's slice of the room-wide activity union, or the shared empty slice
 * when no host reports work for it. Identity-stable while the epic's membership
 * is unchanged, so an unrelated epic's agents starting or stopping does not
 * re-render this consumer.
 *
 * `null` epicId is accepted (and reads idle) because several cross-epic
 * surfaces render before their epic id resolves.
 */
export function useEpicAgentActivity(epicId: string | null): EpicAgentActivity {
  const selector = useMemo(() => makeSelectEpicAgentActivity(epicId), [epicId]);
  return useNotificationsStore(selector);
}

function makeSelectEpicAgentActivity(epicId: string | null) {
  return (state: NotificationsState): EpicAgentActivity => {
    if (epicId === null) return EMPTY_EPIC_AGENT_ACTIVITY;
    return state.agentActivityByEpic.get(epicId) ?? EMPTY_EPIC_AGENT_ACTIVITY;
  };
}

/**
 * Imperative read of one epic's activity, for callers that are not React (the
 * MRU prune guard). Pair with {@link subscribeAgentActivity} when the caller
 * has to re-evaluate on change.
 */
export function getEpicAgentActivity(epicId: string): EpicAgentActivity {
  return (
    useNotificationsStore.getState().agentActivityByEpic.get(epicId) ??
    EMPTY_EPIC_AGENT_ACTIVITY
  );
}

/** Fires whenever the cross-epic activity union changes membership. */
export function subscribeAgentActivity(listener: () => void): () => void {
  let previous = useNotificationsStore.getState().agentActivityByEpic;
  return useNotificationsStore.subscribe((state) => {
    if (state.agentActivityByEpic === previous) return;
    previous = state.agentActivityByEpic;
    listener();
  });
}

/**
 * Test seam: applies a raw y-protocols awareness update to the room replica,
 * exactly as an inbound `awareness` frame would. Lets a suite drive the real
 * decode + fold path instead of stubbing the store field.
 */
export function __applyNotificationsAwarenessForTests(
  updateBytes: Uint8Array,
): void {
  replica.applyAwareness(updateBytes);
}

/**
 * Test seam: drops every awareness entry, the same way opening (or reopening)
 * a room session does.
 */
export function __clearNotificationsAwarenessForTests(): void {
  replica.clearAwareness();
}

/**
 * Test helper - delegates to the public `reset()` action so tests get the
 * same teardown semantics as a sign-out transition in production.
 */
export function __resetNotificationsStoreForTests(): void {
  useNotificationsStore.getState().reset();
}
