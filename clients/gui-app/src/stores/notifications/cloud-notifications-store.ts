import { create } from "zustand";
import type {
  IStreamSession,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV11,
  type HostNotificationsCloudFeedRowV11,
  type HostNotificationsCloudFeedSummary,
  type HostNotificationsEntityRef,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  isReopenableNotificationsStreamClose,
  type HostReconnectEngine,
} from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";

export type CloudNotificationsConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unavailable";

export interface CloudNotificationsState {
  /** Keyed by `entryId` ALONE. */
  readonly rows: Readonly<
    Partial<Record<string, HostNotificationsCloudFeedRowV11>>
  >;
  readonly summary: HostNotificationsCloudFeedSummary | null;
  /** The cloud's per-user change sequence, as of the last snapshot. This is
   * what a bulk mutation names as the feed the user was looking at. */
  readonly version: number | null;
  /**
   * A cloud feed is authoritative only after this session has received a complete snapshot. Until
   * then an in-progress retry must not masquerade as a usable feed.
   */
  readonly hasSnapshot: boolean;
  /** Increments whenever ownership changes, so a late command from an old
   * host/session cannot change the replacement session's presentation. */
  readonly sessionEpoch: number;
  /** Entries whose view-consumption mark-read the server ACCEPTED this session. */
  readonly entityReadSucceeded: ReadonlySet<string>;
  /** Per-entry retry state for view-consumption marks that have NOT yet been accepted. */
  readonly entityReadRetries: Readonly<
    Partial<Record<string, CloudEntityReadRetry>>
  >;
  readonly connectionState: CloudNotificationsConnectionState;
  applySnapshot(input: {
    readonly rows: ReadonlyArray<HostNotificationsCloudFeedRowV11>;
    readonly summary: HostNotificationsCloudFeedSummary;
    readonly version: number;
  }): ReadonlyArray<HostNotificationsCloudFeedRowV11> | null;
  /** Optimistic set-once marker application. */
  markReadLocally(entryId: string, readAt: number): void;
  /** Optimistically covers the whole raw snapshot summary, including unread
   * entries omitted from `rows` because this client cannot render them. */
  markAllReadLocally(readAt: number): void;
  /**
   * One atomic step for a view-consumption fan-out: claim every entry as in-flight and apply its
   * optimistic marker in a single write, so no subscriber can observe the new rows before the claim
   */
  beginEntityRead(entryIds: ReadonlyArray<string>, readAt: number): void;
  /** The server took the marker: stop retrying it, and never rediscover it. */
  recordEntityReadSuccess(entryId: string): void;
  /** The server did not take it: count the attempt and park the entry until
   * `nextEligibleAt`. */
  recordEntityReadFailure(entryId: string, nextEligibleAt: number): void;
  /** Drop retry state for an entry the feed no longer carries - a mark for a
   * row that is gone has nothing left to converge on. */
  clearEntityReadRetries(entryIds: ReadonlyArray<string>): void;
  setConnectionState(state: CloudNotificationsConnectionState): void;
  reset(): void;
}

export interface CloudEntityReadRetry {
  /** Failed attempts so far. `0` while the first attempt is in flight. */
  readonly attempts: number;
  /** `Infinity` while an attempt is in flight. */
  readonly nextEligibleAt: number;
}

/**
 * The entries a visit to `entity` should mark read, mirroring the host's
 * `hostNotificationsMarkEntityRead` SQL exactly:
 */
export function selectCloudEntityReadTargets(
  state: Pick<
    CloudNotificationsState,
    "rows" | "entityReadSucceeded" | "entityReadRetries"
  >,
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
): ReadonlyArray<string> {
  const targets: string[] = [];
  for (const row of Object.values(state.rows)) {
    if (row === undefined) continue;
    const { entry } = row;
    if (
      entry.severity !== "needs_action" &&
      entry.severity !== "done" &&
      entry.severity !== "failure"
    )
      continue;
    if (entry.readAt !== null) continue;
    // A focused tile supplies its bound host and must only acknowledge that exact lineage.
    if (originHostId !== null && row.originHostId !== originHostId) continue;
    if (state.entityReadSucceeded.has(row.entryId)) continue;
    if (Object.hasOwn(state.entityReadRetries, row.entryId)) continue;
    const matchesEntity =
      entry.epicId === entity.epicId &&
      (entry.chatId === null || entry.chatId === entity.chatId);
    if (!matchesEntity) continue;
    targets.push(row.entryId);
  }
  return targets;
}

/** Entries whose backoff has elapsed and are due another attempt. */
export function selectCloudEntityReadRetries(
  state: Pick<CloudNotificationsState, "rows" | "entityReadRetries">,
  now: number,
): {
  readonly due: ReadonlyArray<string>;
  readonly dropped: ReadonlyArray<string>;
} {
  const due: string[] = [];
  const dropped: string[] = [];
  for (const [entryId, retry] of Object.entries(state.entityReadRetries)) {
    if (!Object.hasOwn(state.rows, cloudNotificationFeedId(entryId))) {
      dropped.push(entryId);
      continue;
    }
    if (retry !== undefined && retry.nextEligibleAt <= now) due.push(entryId);
  }
  return { due, dropped };
}

export function cloudNotificationFeedId(entryId: string): string {
  return `cloud:${encodeURIComponent(entryId)}`;
}

function rowKey(
  row: Pick<HostNotificationsCloudFeedRowV11, "entryId">,
): string {
  return cloudNotificationFeedId(row.entryId);
}

function isUnreadAttention(row: HostNotificationsCloudFeedRowV11): boolean {
  return (
    (row.entry.severity === "needs_action" ||
      row.entry.severity === "failure") &&
    row.entry.readAt === null
  );
}

export const useCloudNotificationsStore = create<CloudNotificationsState>()(
  (set, get) => ({
    rows: {},
    summary: null,
    version: null,
    connectionState: "unavailable",
    hasSnapshot: false,
    sessionEpoch: 0,
    entityReadSucceeded: new Set<string>(),
    entityReadRetries: {},
    applySnapshot: (input) => {
      const currentVersion = get().version;
      // Rejected frames must not escape through the return value: the caller
      // uses accepted snapshots to drive cross-plane completion reconciliation.
      if (currentVersion !== null && input.version < currentVersion)
        return null;
      const arrivals: HostNotificationsCloudFeedRowV11[] = [];
      set((state) => {
        const rows: Partial<Record<string, HostNotificationsCloudFeedRowV11>> =
          {};
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
        const attentionDelta = isUnreadAttention(row) ? 1 : 0;
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
                  attentionCount: Math.max(
                    0,
                    state.summary.attentionCount - attentionDelta,
                  ),
                },
        };
      }),
    markAllReadLocally: (readAt) =>
      set((state) => {
        const rows = { ...state.rows };
        for (const [key, row] of Object.entries(rows)) {
          if (row === undefined || row.entry.readAt !== null) continue;
          rows[key] = { ...row, entry: { ...row.entry, readAt } };
        }
        return {
          rows,
          summary:
            state.summary === null
              ? null
              : {
                  ...state.summary,
                  unreadCount: 0,
                  attentionCount: 0,
                },
        };
      }),
    beginEntityRead: (entryIds, readAt) =>
      set((state) => {
        const retries = { ...state.entityReadRetries };
        const rows = { ...state.rows };
        let flipped = 0;
        let attentionFlipped = 0;
        for (const entryId of entryIds) {
          retries[entryId] = {
            attempts: retries[entryId]?.attempts ?? 0,
            nextEligibleAt: Number.POSITIVE_INFINITY,
          };
          const key = cloudNotificationFeedId(entryId);
          const row = rows[key];
          if (row === undefined || row.entry.readAt !== null) continue;
          if (isUnreadAttention(row)) attentionFlipped += 1;
          rows[key] = { ...row, entry: { ...row.entry, readAt } };
          flipped += 1;
        }
        return {
          rows,
          entityReadRetries: retries,
          summary:
            state.summary === null
              ? null
              : {
                  ...state.summary,
                  unreadCount: Math.max(0, state.summary.unreadCount - flipped),
                  attentionCount: Math.max(
                    0,
                    state.summary.attentionCount - attentionFlipped,
                  ),
                },
        };
      }),
    recordEntityReadSuccess: (entryId) =>
      set((state) => {
        const retries = { ...state.entityReadRetries };
        delete retries[entryId];
        const succeeded = new Set(state.entityReadSucceeded);
        succeeded.add(entryId);
        return { entityReadRetries: retries, entityReadSucceeded: succeeded };
      }),
    recordEntityReadFailure: (entryId, nextEligibleAt) =>
      set((state) => ({
        entityReadRetries: {
          ...state.entityReadRetries,
          [entryId]: {
            attempts: (state.entityReadRetries[entryId]?.attempts ?? 0) + 1,
            nextEligibleAt,
          },
        },
      })),
    clearEntityReadRetries: (entryIds) =>
      set((state) => {
        if (entryIds.length === 0) return state;
        const retries = { ...state.entityReadRetries };
        for (const entryId of entryIds) delete retries[entryId];
        return { entityReadRetries: retries };
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
        // View-consumption bookkeeping is relay-session scoped, like every
        // other field here: a new session rediscovers from its own snapshot.
        entityReadSucceeded: new Set<string>(),
        entityReadRetries: {},
      })),
  }),
);

/** Opens the distinct cloud-feed stream. */
// eslint-disable-next-line max-params -- All five are semantically distinct: one reconnect policy, one transport, and three unrelated callbacks (auth, entitlement, snapshot) that no caller supplies together. The fifth arrived with P4.1's consolidation handing the policy IN rather than each store constructing its own; folding the callbacks into a bag would restructure this store's public surface across ten call sites for a consolidation ticket whose acceptance is "no behavior change at surfaces". Mirrors git-query-keys.ts's fileDiff.
export function openCloudNotificationsStream(
  /**
   * THE reconnect policy for this stream's host (redesign P4.1 / connection-registry §6), acquired
   * from the connection registry by the one place that opens these streams.
   */
  reconnectEngine: HostReconnectEngine,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  onAuthError: (() => void) | null,
  onEntitlementDenied: (() => void) | null,
  onSnapshot:
    | ((input: {
        readonly rows: ReadonlyArray<HostNotificationsCloudFeedRowV11>;
        readonly arrivals: ReadonlyArray<HostNotificationsCloudFeedRowV11>;
      }) => void)
    | null,
): () => void {
  let disposed = false;
  let currentSession: IStreamSession | null = null;
  // Ownership is established when this relay controller opens.
  const sessionEpoch = useCloudNotificationsStore.getState().sessionEpoch;
  const reopenScheduler = reconnectEngine.openReopenLane(() => {
    currentSession?.close();
    currentSession = null;
    openSession();
  }, isReopenableNotificationsStreamClose);

  const reconnect = (): void => {
    if (disposed) return;
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    currentSession?.requestReconnect();
  };

  function openSession(): void {
    if (disposed) return;
    const cloudState = useCloudNotificationsStore.getState();
    cloudState.setConnectionState(
      cloudState.hasSnapshot ? "reconnecting" : "connecting",
    );
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
        hostNotificationsCloudFeedSubscribeServerFrameSchemaV11.safeParse(
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
          if (arrivals === null) return;
          onSnapshot?.({ rows: parsed.data.rows, arrivals });
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
        const currentState = useCloudNotificationsStore.getState();
        currentState.setConnectionState(
          currentState.hasSnapshot ? "reconnecting" : "connecting",
        );
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
        // Dormant defense: today's server never emits this refusal.
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
