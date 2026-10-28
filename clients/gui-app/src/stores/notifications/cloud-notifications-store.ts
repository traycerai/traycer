import { create } from "zustand";
import type {
  IStreamSession,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  hostNotificationsCloudFeedSubscribeServerFrameSchemaV16,
  parseKnownHostNotificationPayloadForKind,
  type HostNotificationsCloudFeedRowV16,
  type HostNotificationsCloudFeedSummary,
  type HostNotificationsEntityRef,
  type HostNotificationSandboxNoticePayload,
} from "@traycer/protocol/host/notifications/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  isReopenableHostStreamClose,
  type HostReconnectEngine,
} from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";

export type CloudNotificationsConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unavailable";

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
    Partial<Record<string, HostNotificationsCloudFeedRowV16>>
  >;
  readonly summary: HostNotificationsCloudFeedSummary | null;
  /** The cloud's per-user change sequence, as of the last snapshot. This is
   * what a bulk mutation names as the feed the user was looking at. */
  readonly version: number | null;
  /** A cloud feed is authoritative only after this session has received a
   * complete snapshot. Until then an in-progress retry must not masquerade as
   * a usable feed. */
  readonly hasSnapshot: boolean;
  /** Increments whenever ownership changes, so a late command from an old
   * host/session cannot change the replacement session's presentation. */
  readonly sessionEpoch: number;
  /** The account that owns this session's rows, including a replica seed.
   * Auth may switch before the provider tears the old session down. */
  readonly accountId: string | null;
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
    readonly rows: ReadonlyArray<HostNotificationsCloudFeedRowV16>;
    readonly summary: HostNotificationsCloudFeedSummary;
    readonly version: number;
  }): ReadonlyArray<HostNotificationsCloudFeedRowV16> | null;
  /**
   * Paints the replica tier's copy of the feed before this session's first
   * snapshot. A no-op once a snapshot landed. It leaves `hasSnapshot` false
   * and `version` null, so the seeded rows are never authoritative: no bulk
   * mutation names them, they raise no arrival, and the first snapshot
   * replaces them wholesale.
   */
  seedFromReplica(input: {
    readonly accountId: string;
    readonly rows: ReadonlyArray<HostNotificationsCloudFeedRowV16>;
    readonly summary: HostNotificationsCloudFeedSummary;
  }): void;
  /** The replica no longer admits its page: drop the rows it seeded. A live
   * snapshot, once held, is the feed's own and stays. */
  revokeReplicaSeed(): void;
  /** Optimistic set-once marker application. A later authoritative snapshot
   * reconciles the row, but the common successful mutation never waits on a
   * wake or the relay's correctness poll to look read. */
  markReadLocally(entryId: string, readAt: number): void;
  resolveNoticeLocally(entryId: string, resolvedAt: number): void;
  /** Optimistically covers the whole raw snapshot summary, including unread
   * entries omitted from `rows` because this client cannot render them. */
  markAllReadLocally(readAt: number): void;
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
 * - `severity IN ('needs_action','done','failure')` - looking at a chat
 *   acknowledges its notification rows without resolving the underlying
 *   approval or interview workflow.
 * - `read_at IS NULL` - set-once markers never re-fire.
 * - entity clause: a chat visit matches that chat plus its Task-level rows;
 *   an epic visit matches `epic_id = ? AND chat_id IS NULL`, i.e. epic-level
 *   rows ONLY. A focused child is inside its Task and therefore covers the
 *   Task row, while visiting a Task must not mark sibling chats read.
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
    // A focused tile supplies its bound host and must only acknowledge that
    // exact lineage. An epic-only surface has no host binding, so it retains
    // the existing epic-level behavior across visible origins.
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

function rowKey(
  row: Pick<HostNotificationsCloudFeedRowV16, "entryId">,
): string {
  return cloudNotificationFeedId(row.entryId);
}

function isUnreadAttention(row: HostNotificationsCloudFeedRowV16): boolean {
  return (
    (row.entry.severity === "needs_action" ||
      row.entry.severity === "failure") &&
    row.entry.readAt === null
  );
}

let cancelSandboxExpiry: (() => void) | null = null;

function sandboxNoticeOf(
  row: HostNotificationsCloudFeedRowV16,
): HostNotificationSandboxNoticePayload | null {
  if (row.entry.kind !== "sandbox.notice") return null;
  const payload = parseKnownHostNotificationPayloadForKind(
    row.entry.kind,
    row.entry.payload,
  );
  return payload?.kind === "sandbox_notice" ? payload : null;
}

interface SandboxWarningSupersessionTimes {
  readonly resting: number;
  readonly frozen: number;
}

function sandboxNoticeSupersession(
  notice: HostNotificationSandboxNoticePayload["notice"],
): "resting" | "both" | null {
  switch (notice.kind) {
    case "manual_rest":
      return notice.outcome === "confirmed" ? "resting" : null;
    case "resting_warning":
    case "frozen":
    case "frozen_warning":
    case "resting_destroyed":
    case "frozen_deleting":
    case "frozen_destroyed":
    case "destroyed_by_member":
    case "lost":
    case "create_failed":
      return "both";
  }
}

function latestSandboxNoticeTimes(
  rows: CloudNotificationsState["rows"],
): ReadonlyMap<string, SandboxWarningSupersessionTimes> {
  const latest = new Map<string, SandboxWarningSupersessionTimes>();
  for (const row of Object.values(rows)) {
    if (row === undefined) continue;
    const payload = sandboxNoticeOf(row);
    if (payload === null) continue;
    const supersession = sandboxNoticeSupersession(payload.notice);
    if (supersession === null) continue;
    const previous = latest.get(payload.sandboxId) ?? { resting: 0, frozen: 0 };
    latest.set(payload.sandboxId, {
      resting: Math.max(previous.resting, row.entry.updatedAt),
      frozen:
        supersession === "both"
          ? Math.max(previous.frozen, row.entry.updatedAt)
          : previous.frozen,
    });
  }
  return latest;
}

function noticeResolvedAt(
  row: HostNotificationsCloudFeedRowV16 | undefined,
): number | null {
  if (
    row?.entry.kind !== "sandbox.notice" &&
    row?.entry.kind !== "environment.apply.failed"
  )
    return null;
  return row.entry.resolvedAt ?? null;
}

/** A resolution is a set-once marker: preserve the earliest observed value. */
function mergeNoticeResolution(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null) return previous;
  if (previous === null) return current;
  return Math.min(current, previous);
}

/** Only a distinct later entry supersedes a warning:
 * resting_warning <- resting_warning, frozen/frozen_warning, confirmed manual_rest, terminal;
 * frozen/frozen_warning <- resting_warning (thawed), frozen/frozen_warning, terminal.
 * Terminal: resting_destroyed, frozen_deleting, frozen_destroyed, destroyed_by_member, lost, create_failed.
 * Failed manual_rest and settings failures never supply supersession evidence. */
function observedRetirementAt(
  row: HostNotificationsCloudFeedRowV16,
  latest: ReadonlyMap<string, SandboxWarningSupersessionTimes>,
  now: number,
): number | null {
  // A later sandbox event does not prove this settings operation applied.
  if (row.entry.kind === "environment.apply.failed") return null;
  const payload = sandboxNoticeOf(row);
  if (payload === null) return null;
  const times = latest.get(payload.sandboxId);
  let newer = 0;
  switch (payload.notice.kind) {
    case "resting_warning":
      newer = times?.resting ?? 0;
      break;
    case "frozen":
    case "frozen_warning":
      newer = times?.frozen ?? 0;
      break;
  }
  // This row's own time cannot pass, including a re-emission of the same id.
  if (newer > row.entry.updatedAt) return newer;
  return payload.notice.kind === "resting_warning" &&
    payload.notice.destroyAt <= now
    ? payload.notice.destroyAt
    : null;
}

/** A later fact or an elapsed deadline retires a warning, even on an old relay
 * that omits resolvedAt. Keep observed retirement through replaying snapshots. */
function reconcileSandboxNotices(
  rows: CloudNotificationsState["rows"],
  held: CloudNotificationsState["rows"],
  now: number,
): CloudNotificationsState["rows"] {
  const latest = latestSandboxNoticeTimes(rows);
  const next = { ...rows };
  for (const [key, row] of Object.entries(rows)) {
    if (
      row === undefined ||
      (row.entry.kind !== "sandbox.notice" &&
        row.entry.kind !== "environment.apply.failed") ||
      row.entry.severity !== "needs_action"
    )
      continue;
    const resolvedAt =
      mergeNoticeResolution(
        noticeResolvedAt(row),
        noticeResolvedAt(held[key]),
      ) ?? observedRetirementAt(row, latest, now);
    if (resolvedAt !== null) {
      next[key] = { ...row, entry: { ...row.entry, resolvedAt } };
    }
  }
  return next;
}

function scheduleSandboxNoticeExpiry(): void {
  cancelSandboxExpiry?.();
  cancelSandboxExpiry = null;
  let nextDeadline = Infinity;
  for (const row of Object.values(useCloudNotificationsStore.getState().rows)) {
    if (
      row === undefined ||
      row.entry.kind !== "sandbox.notice" ||
      row.entry.severity !== "needs_action" ||
      (row.entry.resolvedAt ?? null) !== null
    )
      continue;
    const notice = sandboxNoticeOf(row);
    if (notice?.notice.kind === "resting_warning") {
      nextDeadline = Math.min(nextDeadline, notice.notice.destroyAt);
    }
  }
  if (!Number.isFinite(nextDeadline)) return;
  const timer = setTimeout(
    () => {
      useCloudNotificationsStore.setState((state) => ({
        rows: reconcileSandboxNotices(state.rows, state.rows, Date.now()),
      }));
      scheduleSandboxNoticeExpiry();
    },
    Math.min(2_147_483_647, Math.max(0, nextDeadline - Date.now())),
  );
  cancelSandboxExpiry = () => clearTimeout(timer);
}

export const useCloudNotificationsStore = create<CloudNotificationsState>()(
  (set, get) => ({
    rows: {},
    summary: null,
    version: null,
    connectionState: "unavailable",
    hasSnapshot: false,
    sessionEpoch: 0,
    accountId: null,
    entityReadSucceeded: new Set<string>(),
    entityReadRetries: {},
    applySnapshot: (input) => {
      const currentVersion = get().version;
      // Rejected frames must not escape through the return value: the caller
      // uses accepted snapshots to drive cross-plane completion reconciliation.
      if (currentVersion !== null && input.version < currentVersion)
        return null;
      const arrivals: HostNotificationsCloudFeedRowV16[] = [];
      set((state) => {
        const rows: Partial<Record<string, HostNotificationsCloudFeedRowV16>> =
          {};
        for (const row of input.rows) {
          const key = rowKey(row);
          rows[key] = row;
          if (state.hasSnapshot && state.rows[key] === undefined) {
            arrivals.push(row);
          }
        }
        return {
          rows: reconcileSandboxNotices(rows, state.rows, Date.now()),
          summary: input.summary,
          version: input.version,
          connectionState: "connected",
          hasSnapshot: true,
        };
      });
      scheduleSandboxNoticeExpiry();
      return arrivals;
    },
    seedFromReplica: (input) => {
      set((state) => {
        if (
          state.hasSnapshot ||
          (state.accountId !== null && state.accountId !== input.accountId)
        )
          return state;
        const rows: Partial<Record<string, HostNotificationsCloudFeedRowV16>> =
          {};
        for (const row of input.rows) rows[rowKey(row)] = row;
        return {
          accountId: input.accountId,
          rows: reconcileSandboxNotices(rows, state.rows, Date.now()),
          summary: input.summary,
        };
      });
      scheduleSandboxNoticeExpiry();
    },
    revokeReplicaSeed: () => {
      set((state) =>
        state.hasSnapshot ||
        (state.summary === null && Object.keys(state.rows).length === 0)
          ? state
          : { rows: {}, summary: null },
      );
      scheduleSandboxNoticeExpiry();
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
    resolveNoticeLocally: (entryId, resolvedAt) => {
      const state = get();
      const key = cloudNotificationFeedId(entryId);
      const row = state.rows[key];
      if (
        row?.entry.kind !== "sandbox.notice" &&
        row?.entry.kind !== "environment.apply.failed"
      )
        return;
      state.markReadLocally(entryId, resolvedAt);
      set((current) => {
        const currentRow = current.rows[key];
        if (
          currentRow?.entry.kind !== "sandbox.notice" &&
          currentRow?.entry.kind !== "environment.apply.failed"
        )
          return current;
        return {
          rows: {
            ...current.rows,
            [key]: {
              ...currentRow,
              entry: {
                ...currentRow.entry,
                resolvedAt: currentRow.entry.resolvedAt ?? resolvedAt,
              },
            },
          },
        };
      });
      scheduleSandboxNoticeExpiry();
    },
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
    reset: () => {
      cancelSandboxExpiry?.();
      cancelSandboxExpiry = null;
      set((state) => ({
        rows: {},
        summary: null,
        version: null,
        connectionState: "unavailable",
        hasSnapshot: false,
        sessionEpoch: state.sessionEpoch + 1,
        accountId: null,
        // View-consumption bookkeeping is relay-session scoped, like every
        // other field here: a new session rediscovers from its own snapshot.
        entityReadSucceeded: new Set<string>(),
        entityReadRetries: {},
      }));
    },
  }),
);

/** Opens the distinct cloud-feed stream. It deliberately owns a fresh-session
 * retry loop: a terminal stream close is otherwise permanent in the shared
 * transport and would leave the cloud-only surface stale until app restart. */
// eslint-disable-next-line max-params -- The reconnect policy, transport, owning account and two unrelated callbacks (auth, snapshot) describe distinct stream boundaries.
export function openCloudNotificationsStream(
  /**
   * THE reconnect policy for this stream's host (redesign P4.1 /
   * connection-registry §6), acquired from the connection registry by the one
   * place that opens these streams. This store no longer constructs its own
   * scheduler: the constants, the terminal-close classification and the
   * backoff shape live once, in the engine, and each stream still gets its
   * own independent lane so a sibling stream's refusal cannot pace it.
   */
  reconnectEngine: HostReconnectEngine,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  accountId: string,
  onAuthError: (() => void) | null,
  onSnapshot:
    | ((input: {
        readonly rows: ReadonlyArray<HostNotificationsCloudFeedRowV16>;
        readonly arrivals: ReadonlyArray<HostNotificationsCloudFeedRowV16>;
      }) => void)
    | null,
): () => void {
  const state = useCloudNotificationsStore.getState();
  if (state.accountId !== accountId) {
    state.reset();
    useCloudNotificationsStore.setState({ accountId });
  }
  let disposed = false;
  let currentSession: IStreamSession | null = null;
  // Ownership is established when this relay controller opens. A replacement
  // client resets the store before opening its controller; delayed callbacks
  // from this one must never repopulate that new ownership epoch.
  const sessionEpoch = useCloudNotificationsStore.getState().sessionEpoch;
  const reopenScheduler = reconnectEngine.openReopenLane(() => {
    currentSession?.close();
    currentSession = null;
    openSession();
  }, isReopenableHostStreamClose);

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
        hostNotificationsCloudFeedSubscribeServerFrameSchemaV16.safeParse(
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
  if (reason?.kind === "fatalError" && reason.details.code === "INCOMPATIBLE") {
    return "unavailable";
  }
  return "reconnecting";
}
