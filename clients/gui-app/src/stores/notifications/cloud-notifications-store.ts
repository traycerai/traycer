import { create } from "zustand";
import type {
  IStreamSession,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV10,
  type HostNotificationsCloudFeedRow,
  type HostNotificationsCloudFeedSummary,
  type HostNotificationsEntityRef,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { createNotificationStreamReopenScheduler } from "@/lib/notifications/notification-stream-reopen";

export type CloudNotificationsConnectionState =
  "connecting" | "connected" | "reconnecting" | "unavailable";

export interface CloudNotificationsState {
  /**
   * Keyed by `entryId` ALONE. An entry is an immutable occurrence, so a key
   * identifies one occurrence for its whole life - a reopen arrives as a
   * different key, never as an edit of this one. `originHostId` is display
   * metadata riding on the row and is deliberately not part of the key: the
   * same feed is served whichever host relays it.
   *
   * Sparse on purpose: a snapshot can drop an id while a delayed native
   * activation still asks for it.
   */
  readonly rows: Readonly<
    Partial<Record<string, HostNotificationsCloudFeedRow>>
  >;
  readonly summary: HostNotificationsCloudFeedSummary | null;
  /** The cloud's per-user change sequence, as of the last snapshot. This is
   * what a `clearAll` names as the feed the user was looking at. */
  readonly version: number | null;
  /** A cloud feed is authoritative only after this session has received a
   * complete snapshot. Until then an in-progress retry must not masquerade as
   * a usable feed. */
  readonly hasSnapshot: boolean;
  /** Increments whenever ownership changes, so a late command from an old
   * host/session cannot change the replacement session's presentation. */
  readonly sessionEpoch: number;
  /**
   * Entries this session has already fanned a view-consumption mark-read out
   * for. This is the convergence guard for `beginEntityRead`, and it is
   * deliberately keyed on the ATTEMPT, not the outcome.
   *
   * The optimistic marker alone would suppress a repeat, but only while it
   * survives: when the server never takes the marker, the next authoritative
   * snapshot re-lands the row as unread, which would re-arm the fan-out and
   * turn a failing server into a per-snapshot RPC storm. Recording the attempt
   * bounds it at one request per entry per relay session; the marker is
   * recovered on the next session or by an explicit action in the center.
   */
  readonly entityReadAttempts: ReadonlySet<string>;
  readonly connectionState: CloudNotificationsConnectionState;
  applySnapshot(input: {
    readonly rows: ReadonlyArray<HostNotificationsCloudFeedRow>;
    readonly summary: HostNotificationsCloudFeedSummary;
    readonly version: number;
  }): ReadonlyArray<HostNotificationsCloudFeedRow>;
  /** Optimistic set-once marker application. A later authoritative snapshot
   * reconciles the row, but the common successful mutation never waits on a
   * wake or the relay's correctness poll to look read. */
  markReadLocally(entryId: string, readAt: number): void;
  /** One atomic step for a view-consumption fan-out: record the attempts and
   * apply every optimistic marker in a single write, so the guard is in place
   * before any subscriber can observe the new rows and re-enter. */
  beginEntityRead(entryIds: ReadonlyArray<string>, readAt: number): void;
  setConnectionState(state: CloudNotificationsConnectionState): void;
  reset(): void;
}

/**
 * The entries a visit to `entity` should mark read, mirroring the host's
 * `hostNotificationsMarkEntityRead` SQL exactly:
 *
 * - `severity IN ('done','failure')` - `needs_action` is EXCLUDED on purpose.
 *   Looking at a chat must never silently dismiss a pending approval or
 *   interview; only answering or explicitly dismissing one may do that.
 * - `read_at IS NULL` - set-once markers never re-fire.
 * - entity clause: a chat visit matches `chat_id = ?`; an epic visit matches
 *   `epic_id = ? AND chat_id IS NULL`, i.e. epic-level rows ONLY. This is
 *   deliberately NARROWER than the indicator rollup, which does aggregate an
 *   epic's chats - visiting an epic must not mark its chats' rows read.
 *
 * Visibility needs no clause here: a cloud snapshot is already the visible set.
 * `attempted` entries are skipped (see `entityReadAttempts`).
 */
export function selectCloudEntityReadTargets(
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRow>>>,
  attempted: ReadonlySet<string>,
  entity: HostNotificationsEntityRef,
): ReadonlyArray<string> {
  const targets: string[] = [];
  for (const row of Object.values(rows)) {
    if (row === undefined) continue;
    const { entry } = row;
    if (entry.severity !== "done" && entry.severity !== "failure") continue;
    if (entry.readAt !== null) continue;
    if (attempted.has(row.entryId)) continue;
    const matchesEntity =
      entity.chatId === undefined
        ? entry.epicId === entity.epicId && entry.chatId === null
        : entry.chatId === entity.chatId;
    if (!matchesEntity) continue;
    targets.push(row.entryId);
  }
  return targets;
}

export function cloudNotificationFeedId(entryId: string): string {
  return `cloud:${encodeURIComponent(entryId)}`;
}

function rowKey(row: Pick<HostNotificationsCloudFeedRow, "entryId">): string {
  return cloudNotificationFeedId(row.entryId);
}

export const useCloudNotificationsStore = create<CloudNotificationsState>()(
  (set) => ({
    rows: {},
    summary: null,
    version: null,
    connectionState: "unavailable",
    hasSnapshot: false,
    sessionEpoch: 0,
    entityReadAttempts: new Set<string>(),
    applySnapshot: (input) => {
      const arrivals: HostNotificationsCloudFeedRow[] = [];
      set((state) => {
        // The feed version is a monotonic change sequence, so a snapshot below
        // the one already rendered can only be a delayed frame from a
        // superseded session. Dropping it is the whole rewind guard - there is
        // no delta stream here whose ordering could need a richer one.
        if (state.version !== null && input.version < state.version) {
          return state;
        }
        const rows: Partial<Record<string, HostNotificationsCloudFeedRow>> = {};
        for (const row of input.rows) {
          const key = rowKey(row);
          rows[key] = row;
          if (state.hasSnapshot && state.rows[key] === undefined) {
            arrivals.push(row);
          }
        }
        return {
          rows,
          summary: input.summary,
          version: input.version,
          connectionState: "connected",
          hasSnapshot: true,
        };
      });
      return arrivals;
    },
    markReadLocally: (entryId, readAt) =>
      set((state) => {
        const key = cloudNotificationFeedId(entryId);
        const row = state.rows[key];
        if (row === undefined || row.entry.readAt !== null) return state;
        return {
          rows: {
            ...state.rows,
            [key]: { ...row, entry: { ...row.entry, readAt } },
          },
          summary:
            state.summary === null
              ? null
              : {
                  ...state.summary,
                  unreadCount: Math.max(0, state.summary.unreadCount - 1),
                },
        };
      }),
    beginEntityRead: (entryIds, readAt) =>
      set((state) => {
        const attempts = new Set(state.entityReadAttempts);
        const rows = { ...state.rows };
        let flipped = 0;
        for (const entryId of entryIds) {
          attempts.add(entryId);
          const key = cloudNotificationFeedId(entryId);
          const row = rows[key];
          if (row === undefined || row.entry.readAt !== null) continue;
          rows[key] = { ...row, entry: { ...row.entry, readAt } };
          flipped += 1;
        }
        return {
          rows,
          entityReadAttempts: attempts,
          summary:
            state.summary === null
              ? null
              : {
                  ...state.summary,
                  unreadCount: Math.max(0, state.summary.unreadCount - flipped),
                },
        };
      }),
    setConnectionState: (connectionState) =>
      set((state) => ({
        connectionState:
          connectionState === "reconnecting" && !state.hasSnapshot
            ? "unavailable"
            : connectionState,
      })),
    reset: () =>
      set((state) => ({
        rows: {},
        summary: null,
        version: null,
        connectionState: "unavailable",
        hasSnapshot: false,
        sessionEpoch: state.sessionEpoch + 1,
        // The attempt guard is relay-session scoped: a new session is a fresh
        // chance for a mark the previous one never got through.
        entityReadAttempts: new Set<string>(),
      })),
  }),
);

/** Opens the distinct cloud-feed stream. It deliberately owns a fresh-session
 * retry loop: a terminal stream close is otherwise permanent in the shared
 * transport and would leave the cloud-only surface stale until app restart. */
export function openCloudNotificationsStream(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
  onAuthError: (() => void) | null,
  onEntitlementDenied: (() => void) | null,
  onArrivals:
    ((rows: ReadonlyArray<HostNotificationsCloudFeedRow>) => void) | null,
): () => void {
  let disposed = false;
  let currentSession: IStreamSession | null = null;
  // Ownership is established when this relay controller opens. A replacement
  // client resets the store before opening its controller; delayed callbacks
  // from this one must never repopulate that new ownership epoch.
  const sessionEpoch = useCloudNotificationsStore.getState().sessionEpoch;
  const reopenScheduler = createNotificationStreamReopenScheduler(() => {
    currentSession?.close();
    currentSession = null;
    openSession();
  });

  const reconnect = (): void => {
    if (disposed) return;
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    currentSession?.requestReconnect();
  };

  function openSession(): void {
    if (disposed) return;
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    const session = wsStreamClient.subscribe(
      "host.notifications.cloudFeed.subscribe",
      {},
    );
    currentSession = session;
    session.onServerFrame((envelope, binaryPayload) => {
      if (currentSession !== session) return;
      if (useCloudNotificationsStore.getState().sessionEpoch !== sessionEpoch) {
        return;
      }
      if (binaryPayload !== null) {
        reconnect();
        return;
      }
      const parsed =
        hostNotificationsCloudFeedSubscribeServerFrameSchemaV10.safeParse(
          envelope,
        );
      if (!parsed.success) {
        reconnect();
        return;
      }
      switch (parsed.data.kind) {
        case "snapshot": {
          const arrivals = useCloudNotificationsStore
            .getState()
            .applySnapshot(parsed.data);
          if (arrivals.length > 0) onArrivals?.(arrivals);
          reopenScheduler.resetBackoff();
          return;
        }
        case "connectionState":
          useCloudNotificationsStore
            .getState()
            .setConnectionState(parsed.data.connectionState);
          return;
        case "pong":
          return;
      }
    });
    session.onStatusChange((status, reason) => {
      if (currentSession !== session) return;
      if (status === "closed") {
        useCloudNotificationsStore
          .getState()
          .setConnectionState(cloudCloseState(reason));
        reopenScheduler.scheduleAfterClose(reason);
      } else if (status !== "open") {
        useCloudNotificationsStore
          .getState()
          .setConnectionState("reconnecting");
      }
      if (
        reason?.kind === "fatalError" &&
        reason.details.code === "UNAUTHORIZED"
      ) {
        onAuthError?.();
      }
      if (
        reason?.kind === "fatalError" &&
        reason.details.code === "FREE_TIER_NO_CLOUD_SYNC"
      ) {
        // Dormant defense: today's server never emits this refusal. If a
        // server-side entitlement gate appears later, translate it into a
        // stable unavailable wall instead of an undefined terminal state.
        onEntitlementDenied?.();
      }
    });
  }

  openSession();
  return () => {
    disposed = true;
    reopenScheduler.dispose();
    currentSession?.close();
    currentSession = null;
  };
}

function cloudCloseState(
  reason: StreamCloseReason | null,
): CloudNotificationsConnectionState {
  if (
    reason?.kind === "fatalError" &&
    (reason.details.code === "INCOMPATIBLE" ||
      reason.details.code === "FREE_TIER_NO_CLOUD_SYNC")
  ) {
    return "unavailable";
  }
  return "reconnecting";
}
