import { create } from "zustand";
import type {
  IStreamSession,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV11,
  type HostNotificationsCloudFeedRow,
  type HostNotificationsCloudFeedSummary,
  type HostNotificationsEntityRef,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createHostStreamReopenScheduler,
  isReopenableNotificationsStreamClose,
} from "@/lib/host/stream-reopen";

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
   * Entries whose view-consumption mark-read the server ACCEPTED this session.
   *
   * Keyed on the outcome, not the attempt: a marker the server took is durable
   * (set-once, min-merged), so re-sending it could only ever be a no-op - while
   * a snapshot that keeps replaying the row as unread would otherwise re-arm
   * the fan-out on every frame. Suppressing on success is what makes a lagging
   * or replaying feed cost nothing; failures deliberately stay retryable.
   */
  readonly entityReadSucceeded: ReadonlySet<string>;
  /**
   * Per-entry retry state for view-consumption marks that have NOT yet been
   * accepted. An entry present here is either in flight
   * (`nextEligibleAt === Infinity`) or waiting out its backoff, and in both
   * cases is invisible to fresh discovery - which is what keeps at most one
   * attempt per entry alive at a time.
   */
  readonly entityReadRetries: Readonly<
    Partial<Record<string, CloudEntityReadRetry>>
  >;
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
  /** One atomic step for a view-consumption fan-out: claim every entry as
   * in-flight and apply its optimistic marker in a single write, so no
   * subscriber can observe the new rows before the claim is visible. */
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
 * Entries already accepted, in flight, or waiting out a backoff are excluded -
 * those are driven by `selectCloudEntityReadRetries` instead.
 */
export function selectCloudEntityReadTargets(
  state: Pick<
    CloudNotificationsState,
    "rows" | "entityReadSucceeded" | "entityReadRetries"
  >,
  entity: HostNotificationsEntityRef,
): ReadonlyArray<string> {
  const targets: string[] = [];
  for (const row of Object.values(state.rows)) {
    if (row === undefined) continue;
    const { entry } = row;
    if (entry.severity !== "done" && entry.severity !== "failure") continue;
    if (entry.readAt !== null) continue;
    if (state.entityReadSucceeded.has(row.entryId)) continue;
    if (Object.hasOwn(state.entityReadRetries, row.entryId)) continue;
    const matchesEntity =
      entity.chatId === undefined
        ? entry.epicId === entity.epicId && entry.chatId === null
        : entry.chatId === entity.chatId;
    if (!matchesEntity) continue;
    targets.push(row.entryId);
  }
  return targets;
}

/**
 * Entries whose backoff has elapsed and are due another attempt.
 *
 * Deliberately NOT filtered on the row's local `readAt`: the optimistic marker
 * was already applied when the attempt began, so re-deriving retries from the
 * rows would make every failure permanently invisible. Retry state is the
 * record of what the server has not yet accepted; the local marker only says
 * what the user has been shown.
 */
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
    entityReadSucceeded: new Set<string>(),
    entityReadRetries: {},
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
        const retries = { ...state.entityReadRetries };
        const rows = { ...state.rows };
        let flipped = 0;
        for (const entryId of entryIds) {
          retries[entryId] = {
            attempts: retries[entryId]?.attempts ?? 0,
            nextEligibleAt: Number.POSITIVE_INFINITY,
          };
          const key = cloudNotificationFeedId(entryId);
          const row = rows[key];
          if (row === undefined || row.entry.readAt !== null) continue;
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

/** Opens the distinct cloud-feed stream. It deliberately owns a fresh-session
 * retry loop: a terminal stream close is otherwise permanent in the shared
 * transport and would leave the cloud-only surface stale until app restart. */
export function openCloudNotificationsStream(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
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
  const reopenScheduler = createHostStreamReopenScheduler(() => {
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
        case "snapshot":
        case "partitionSnapshot": {
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
