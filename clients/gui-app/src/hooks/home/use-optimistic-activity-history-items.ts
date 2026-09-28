import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  buildHistoryItemsFromTasks,
  formatUpdatedLabel,
  sortHistoryItems,
  toHistoryRecencyBucket,
} from "@/components/home/data/home-page.data";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useOwnTurnEpicIds } from "@/stores/use-own-turn-epic-ids";

const MAX_ACTIVE_ROWS = 64;
const MAX_KNOWN_DURABLE_KEYS = MAX_ACTIVE_ROWS * 4;
const MAX_SETTLED_REFRESH_SCOPES = 64;
const STAMP_TTL_MS = 10 * 60_000;
const REFRESH_DEBOUNCE_MS = 750;
const REFRESH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const EMPTY_ITEMS: readonly HistoryItem[] = [];
const listeners = new Set<() => void>();
const activeSeen = new Set<string>();
interface ActivityStamp {
  readonly at: number;
  readonly expiresAt: number;
  /** Durable key observed before this edge, in the server's clock domain. */
  readonly baselineAt: number | null;
  /** The first durable key arrived while this stamp was already pending. */
  readonly baselineFromPendingRead: boolean;
  /** Own-record timestamp from the host stream, when one is available. */
  readonly acceptedAt: number | null;
  /** A later turn still needs activity beyond this earlier accepted record. */
  readonly turnAfterAcceptedAt: number | null;
  /** Context acknowledged this key; retain its row until the list sees it. */
  readonly awaitingListAt: number | null;
}
const stamps = new Map<string, ActivityStamp>();
const knownDurableAt = new Map<string, number>();
interface ActivitySnapshot {
  readonly revision: number;
  readonly stamps: ReadonlyMap<string, ActivityStamp>;
}
const EMPTY_SNAPSHOT: ActivitySnapshot = { revision: 0, stamps: new Map() };
let currentSnapshot: ActivitySnapshot = EMPTY_SNAPSHOT;
const generations = new Map<string, number>();
const ownerlessRefreshDeadlines = new Map<string, number>();
const scheduledGenerations = new Map<string, number>();
const settledGenerations = new Map<string, number>();
const scopeSubscribers = new Map<string, number>();
interface RefreshState {
  readonly scope: string;
  readonly userId: string;
  timer: number | null;
  inFlight: boolean;
  refetch: () => Promise<unknown>;
  attempts: number;
  deadline: number;
  ownerlessUntil: number;
  newEdgeInFlight: boolean;
}
const refreshes = new Map<string, RefreshState>();

function keyFor(userId: string, epicId: string): string {
  return JSON.stringify([userId, epicId]);
}

function rememberDurableKey(key: string, at: number): void {
  const previous = knownDurableAt.get(key);
  if (previous !== undefined && previous >= at) return;
  knownDurableAt.delete(key);
  knownDurableAt.set(key, at);
  if (knownDurableAt.size > MAX_KNOWN_DURABLE_KEYS) {
    const oldest = knownDurableAt.keys().next().value;
    if (oldest !== undefined) knownDurableAt.delete(oldest);
  }
}

function latestDurableBaseline(
  key: string,
  previous: ActivityStamp | undefined,
): number | null {
  const latest = Math.max(
    previous?.baselineAt ?? -Infinity,
    previous?.awaitingListAt ?? -Infinity,
    knownDurableAt.get(key) ?? -Infinity,
  );
  return latest === -Infinity ? null : latest;
}

function contextAlreadyAcknowledged(
  previous: ActivityStamp | undefined,
  at: number,
): boolean {
  const acknowledgedAt = previous?.awaitingListAt;
  return (
    acknowledgedAt !== null &&
    acknowledgedAt !== undefined &&
    at <= acknowledgedAt
  );
}

function pendingBaselineForNewRecord(
  previous: ActivityStamp | undefined,
): boolean {
  if (
    previous?.awaitingListAt !== null &&
    previous?.awaitingListAt !== undefined
  )
    return false;
  return previous?.baselineFromPendingRead ?? false;
}

function changed(userId: string | null): void {
  if (userId !== null) {
    generations.set(userId, (generations.get(userId) ?? 0) + 1);
  }
  currentSnapshot = {
    revision: currentSnapshot.revision + 1,
    stamps: new Map(stamps),
  };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ActivitySnapshot {
  return currentSnapshot;
}

function removeExpiredStamps(at: number): boolean {
  let removed = false;
  for (const [key, stamp] of stamps) {
    if (stamp.expiresAt > at) continue;
    stamps.delete(key);
    removed = true;
  }
  return removed;
}

function capStamps(): void {
  if (stamps.size <= MAX_ACTIVE_ROWS) return;
  // Preserve an accepted record (including a context-acknowledged row) ahead
  // of an active-only edge when the shared overlay reaches its fixed cap.
  const activeOnly = [...stamps].find(
    ([, stamp]) => stamp.acceptedAt === null && stamp.awaitingListAt === null,
  )?.[0];
  const oldest = activeOnly ?? stamps.keys().next().value;
  if (oldest !== undefined) stamps.delete(oldest);
}

function stampActiveHistoryEdge(key: string, at: number): void {
  // A record delta can precede the turn projection. Its exact accepted time
  // settles that record, but the later turn still needs a further durable key.
  const previous = stamps.get(key);
  const acceptedAt = previous?.acceptedAt ?? null;
  const priorTurnBarrier = previous?.turnAfterAcceptedAt ?? null;
  stamps.set(key, {
    at: Math.max(previous?.at ?? 0, at),
    expiresAt: Math.max(previous?.expiresAt ?? 0, at + STAMP_TTL_MS),
    baselineAt: latestDurableBaseline(key, previous),
    // A fresh turn makes any already-observed key its pre-edge baseline.
    baselineFromPendingRead: false,
    acceptedAt,
    turnAfterAcceptedAt:
      acceptedAt === null
        ? priorTurnBarrier
        : Math.max(priorTurnBarrier ?? acceptedAt, acceptedAt),
    awaitingListAt: null,
  });
  capStamps();
}

/** Records only a new active edge; a durable catch-up does not re-arm it. */
export function observeActiveHistoryEdges(
  userId: string,
  workingEpicIds: ReadonlySet<string>,
  at: number,
): boolean {
  let added = false;
  for (const key of [...activeSeen]) {
    const pair = JSON.parse(key) as [string, string];
    if (pair[0] === userId && !workingEpicIds.has(pair[1]))
      activeSeen.delete(key);
  }
  const expired = removeExpiredStamps(at);
  for (const epicId of workingEpicIds) {
    const key = keyFor(userId, epicId);
    if (activeSeen.has(key)) continue;
    activeSeen.add(key);
    stampActiveHistoryEdge(key, at);
    added = true;
    if (activeSeen.size > MAX_ACTIVE_ROWS * 4) {
      const oldest = activeSeen.values().next().value;
      if (oldest !== undefined) activeSeen.delete(oldest);
    }
  }
  if (added) changed(userId);
  else if (expired) changed(null);
  return added;
}

/** An own record delta can arrive while the task is idle or already active. */
export function observeOwnHistoryRecordChange(
  userId: string,
  epicId: string,
  at: number,
): void {
  const key = keyFor(userId, epicId);
  const previous = stamps.get(key);
  if (contextAlreadyAcknowledged(previous, at)) return;
  const priorTurnBarrier = previous?.turnAfterAcceptedAt ?? null;
  stamps.delete(key);
  stamps.set(key, {
    at: Math.max(previous?.at ?? 0, at),
    expiresAt: Date.now() + STAMP_TTL_MS,
    baselineAt: latestDurableBaseline(key, previous),
    baselineFromPendingRead: pendingBaselineForNewRecord(previous),
    acceptedAt: Math.max(previous?.acceptedAt ?? 0, at),
    turnAfterAcceptedAt:
      priorTurnBarrier !== null && at <= priorTurnBarrier
        ? priorTurnBarrier
        : null,
    awaitingListAt: null,
  });
  capStamps();
  changed(userId);
}

/** Removes have no owner on the old stream wire, so only reconcile the page. */
export function requestHistoryActivityRefresh(userId: string): void {
  const now = Date.now();
  for (const [key, deadline] of ownerlessRefreshDeadlines) {
    if (deadline <= now) ownerlessRefreshDeadlines.delete(key);
  }
  ownerlessRefreshDeadlines.delete(userId);
  ownerlessRefreshDeadlines.set(userId, now + STAMP_TTL_MS);
  if (ownerlessRefreshDeadlines.size > MAX_ACTIVE_ROWS) {
    const oldest = ownerlessRefreshDeadlines.keys().next().value;
    if (oldest !== undefined) ownerlessRefreshDeadlines.delete(oldest);
  }
  changed(userId);
}

/** Settles in the durable clock domain; the browser clock only places the row. */
function durableKeyCatchesUp(stamp: ActivityStamp, durableAt: number): boolean {
  // A matching accepted record can confirm a key learned during this edge.
  // An unchanged key already known before the edge cannot confirm it.
  const exactAcceptedRecord =
    stamp.acceptedAt !== null &&
    stamp.turnAfterAcceptedAt === null &&
    durableAt === stamp.acceptedAt &&
    (stamp.baselineAt === null || stamp.baselineFromPendingRead);
  if (stamp.baselineAt === null) return exactAcceptedRecord;
  if (stamp.acceptedAt === null) return durableAt > stamp.baselineAt;
  return (
    exactAcceptedRecord ||
    (durableAt >= stamp.acceptedAt &&
      durableAt > stamp.baselineAt &&
      (stamp.turnAfterAcceptedAt === null ||
        durableAt > stamp.turnAfterAcceptedAt))
  );
}

export function settleHistoryActivity(
  userId: string,
  items: readonly HistoryItem[],
): void {
  let removed = false;
  for (const item of items) {
    // Older negotiated peers omit the activity key. An edit timestamp cannot
    // prove that the viewer's own chat or turn activity was persisted.
    if (item.recentAtMs === undefined) continue;
    const key = keyFor(userId, item.epicId);
    const durableAt = item.recentAtMs;
    const stamp = stamps.get(key);
    if (stamp !== undefined) {
      if (
        stamp.awaitingListAt !== null
          ? durableAt >= stamp.awaitingListAt
          : durableKeyCatchesUp(stamp, durableAt)
      ) {
        stamps.delete(key);
        removed = true;
      } else if (stamp.awaitingListAt === null && stamp.baselineAt === null) {
        // The first off-page key may predate the edge even when its server
        // clock is ahead of the browser. Only a later change can settle it.
        stamps.set(key, {
          ...stamp,
          baselineAt: durableAt,
          baselineFromPendingRead: true,
        });
      }
    }
    rememberDurableKey(key, durableAt);
  }
  if (removed) changed(null);
}

/** A context key settles the timestamp but cannot prove page membership. */
function settleBackfilledHistoryActivity(
  userId: string,
  items: readonly HistoryItem[],
): void {
  let acknowledged = false;
  for (const item of items) {
    if (item.recentAtMs === undefined) continue;
    const key = keyFor(userId, item.epicId);
    const durableAt = item.recentAtMs;
    const stamp = stamps.get(key);
    if (stamp !== undefined) {
      if (stamp.awaitingListAt !== null && durableAt > stamp.awaitingListAt) {
        stamps.set(key, { ...stamp, awaitingListAt: durableAt });
        acknowledged = true;
      } else if (
        stamp.awaitingListAt === null &&
        durableKeyCatchesUp(stamp, durableAt)
      ) {
        stamps.set(key, { ...stamp, awaitingListAt: durableAt });
        acknowledged = true;
      } else if (stamp.awaitingListAt === null && stamp.baselineAt === null) {
        stamps.set(key, {
          ...stamp,
          baselineAt: durableAt,
          baselineFromPendingRead: true,
        });
      }
    }
    rememberDurableKey(key, durableAt);
  }
  if (acknowledged) changed(userId);
}

interface ProjectedHistoryRow {
  readonly item: HistoryItem;
  readonly stampAt: number | null;
}

function compareLegacyProjectedRows(
  left: ProjectedHistoryRow,
  right: ProjectedHistoryRow,
): number {
  const pinned = Number(right.item.isPinned) - Number(left.item.isPinned);
  if (pinned !== 0) return pinned;
  const stamped =
    Number(right.stampAt !== null) - Number(left.stampAt !== null);
  if (stamped !== 0) return stamped;
  // Older peers do not expose the server's activity key. Lift only rows with
  // a local edge, then retain the server's order for every unstamped row.
  return (right.stampAt ?? 0) - (left.stampAt ?? 0);
}

/** Loaded-row projection shared by the panel, drawer, and tray. */
export function projectOptimisticHistoryItems(
  userId: string,
  pageItems: readonly HistoryItem[],
  backfilled: readonly HistoryItem[],
  nowMs: number,
): readonly HistoryItem[] {
  const byEpic = new Map(pageItems.map((item) => [item.epicId, item]));
  for (const item of backfilled) {
    const pageItem = byEpic.get(item.epicId);
    if (pageItem === undefined) {
      byEpic.set(item.epicId, item);
    } else if (
      item.recentAtMs !== undefined &&
      item.recentAtMs > (pageItem.recentAtMs ?? -Infinity)
    ) {
      // A stale page can contain the row before its activity key catches up.
      byEpic.set(item.epicId, {
        ...pageItem,
        recentAtMs: item.recentAtMs,
        recentLabel: item.recentLabel,
        recentBucket: item.recentBucket,
      });
    }
  }
  const sourceItems = [...byEpic.values()];
  const missingDurableKey = sourceItems.some(
    (item) => item.recentAtMs === undefined,
  );
  const projected: ProjectedHistoryRow[] = sourceItems.map((item) => {
    const stamp = stamps.get(keyFor(userId, item.epicId));
    if (
      stamp === undefined ||
      stamp.expiresAt <= nowMs ||
      stamp.awaitingListAt !== null
    ) {
      return { item, stampAt: null };
    }
    const recentAtMs = Math.max(item.recentAtMs ?? item.updatedAtMs, stamp.at);
    return {
      item: {
        ...item,
        recentAtMs,
        recentLabel: formatUpdatedLabel(recentAtMs),
        recentBucket: toHistoryRecencyBucket(recentAtMs, nowMs),
      },
      stampAt: stamp.at,
    };
  });
  if (missingDurableKey) {
    return projected
      .toSorted(compareLegacyProjectedRows)
      .map((row) => row.item);
  }
  return sortHistoryItems(
    projected.map((row) => row.item),
    "recent",
  );
}

function hasUnsettledStamps(userId: string, now: number): boolean {
  for (const [key, stamp] of stamps) {
    if (
      stamp.expiresAt > now &&
      (JSON.parse(key) as [string, string])[0] === userId
    ) {
      return true;
    }
  }
  return false;
}

function scheduleActivityRefresh(state: RefreshState, delay: number): void {
  if (state.timer !== null || state.inFlight) return;
  state.timer = window.setTimeout(() => {
    state.timer = null;
    if (Date.now() >= state.deadline) {
      refreshes.delete(state.scope);
      return;
    }
    state.inFlight = true;
    state.attempts += 1;
    void state
      .refetch()
      .catch(() => undefined)
      .finally(() => {
        state.inFlight = false;
        if (refreshes.get(state.scope) !== state) return;
        const now = Date.now();
        const pending = hasUnsettledStamps(state.userId, now);
        // An ownerless removal has no durable watermark on the frozen stream
        // wire. Reconcile through its bounded window, including cloud retry.
        if (state.newEdgeInFlight) {
          state.newEdgeInFlight = false;
          state.attempts = 1;
        }
        if (
          now >= state.deadline ||
          (!pending && now >= state.ownerlessUntil && state.attempts >= 3)
        ) {
          refreshes.delete(state.scope);
          return;
        }
        const retryIndex = Math.min(
          state.attempts - 1,
          REFRESH_RETRY_DELAYS_MS.length - 1,
        );
        scheduleActivityRefresh(state, REFRESH_RETRY_DELAYS_MS[retryIndex]);
      });
  }, delay);
}

function queueActivityRefresh(
  scope: string,
  userId: string,
  generation: number,
  refetch: () => Promise<unknown>,
): void {
  const existing = refreshes.get(scope);
  if (existing !== undefined) {
    existing.refetch = refetch;
    if (generation > (scheduledGenerations.get(scope) ?? 0)) {
      existing.deadline = Date.now() + STAMP_TTL_MS;
      existing.ownerlessUntil = Math.max(
        existing.ownerlessUntil,
        ownerlessRefreshDeadlines.get(userId) ?? 0,
      );
      if (existing.inFlight) {
        existing.newEdgeInFlight = true;
      } else {
        if (existing.timer !== null) window.clearTimeout(existing.timer);
        existing.timer = null;
        existing.attempts = 0;
      }
    }
    scheduledGenerations.set(scope, generation);
    scheduleActivityRefresh(existing, REFRESH_DEBOUNCE_MS);
    return;
  }
  const state: RefreshState = {
    scope,
    userId,
    timer: null,
    inFlight: false,
    refetch,
    attempts: 0,
    deadline: Date.now() + STAMP_TTL_MS,
    ownerlessUntil: ownerlessRefreshDeadlines.get(userId) ?? 0,
    newEdgeInFlight: false,
  };
  refreshes.set(scope, state);
  scheduledGenerations.set(scope, generation);
  scheduleActivityRefresh(state, REFRESH_DEBOUNCE_MS);
}

export interface OptimisticActivityHistoryInput {
  readonly items: readonly HistoryItem[];
  readonly userId: string | null;
  readonly hostId: string | null;
  readonly enabled: boolean;
  /** Refresh the durable page even when filters disable row injection. */
  readonly refreshEnabled?: boolean;
  /** The actual list request key; distinct filters own distinct retries. */
  readonly refreshScope?: string;
  readonly refetch: () => Promise<unknown>;
}

/**
 * Active edges can outrun the cloud outbox. Keep at most 64 stamped rows in a
 * shared, ten-minute overlay; one batched context request supplies missing
 * active rows and one scoped refresh resets retained cursor pages.
 */
export function useOptimisticActivityHistoryItems(
  input: OptimisticActivityHistoryInput,
): readonly HistoryItem[] {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const refreshEnabled = input.refreshEnabled ?? input.enabled;
  const refreshScope = input.refreshScope ?? "";
  const workingEpicIds = useOwnTurnEpicIds(input.userId);
  const activitySnapshot = useSyncExternalStore(
    subscribe,
    snapshot,
    () => EMPTY_SNAPSHOT,
  );
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const missing = useMemo(() => {
    if (!input.enabled || input.userId === null) return [];
    const userId = input.userId;
    const onPage = new Map(input.items.map((item) => [item.epicId, item]));
    const stamped = [...activitySnapshot.stamps]
      .filter(
        ([key]) => (JSON.parse(key) as [string, string])[0] === input.userId,
      )
      .map(([key]) => (JSON.parse(key) as [string, string])[1]);
    // Every retained stamp fits the 64-row cap. Prioritize those obligations
    // before filling any remaining context slots with unstamped active ids.
    const stampedSet = new Set(stamped);
    const candidates = [
      ...stamped.sort(),
      ...[...workingEpicIds].filter((epicId) => !stampedSet.has(epicId)).sort(),
    ];
    return candidates
      .filter((epicId) => {
        const pageItem = onPage.get(epicId);
        const awaitingListAt = activitySnapshot.stamps.get(
          keyFor(userId, epicId),
        )?.awaitingListAt;
        return (
          pageItem === undefined ||
          (awaitingListAt !== null &&
            awaitingListAt !== undefined &&
            (pageItem.recentAtMs ?? -Infinity) < awaitingListAt)
        );
      })
      .slice(0, MAX_ACTIVE_ROWS)
      .sort();
  }, [
    activitySnapshot.stamps,
    input.enabled,
    input.items,
    input.userId,
    workingEpicIds,
  ]);
  const backfill = useEpicGetTaskContexts(missing, input.userId, {
    enabled: cloudAuthorized,
  });
  const backfilled = useMemo(() => {
    const missingSet = new Set(missing);
    return buildHistoryItemsFromTasks(
      [...backfill.tasksById.values()],
      nowMs,
      input.userId,
      backfill.localHomedTaskIds,
    ).filter((item) => missingSet.has(item.epicId));
  }, [
    backfill.localHomedTaskIds,
    backfill.tasksById,
    input.userId,
    missing,
    nowMs,
  ]);
  // The context batch has a five-minute title cache. Re-read its mounted
  // batches with the list so an off-page activity key can actually catch up.
  const refetchList = input.refetch;
  const refetchContexts = backfill.refetch;
  const refetchActivity = useCallback(async () => {
    await Promise.all([refetchList(), refetchContexts()]);
  }, [refetchContexts, refetchList]);
  useEffect(() => {
    if (!refreshEnabled || input.userId === null) return;
    const scope = JSON.stringify([input.hostId, input.userId, refreshScope]);
    scopeSubscribers.set(scope, (scopeSubscribers.get(scope) ?? 0) + 1);
    return () => {
      const remaining = (scopeSubscribers.get(scope) ?? 1) - 1;
      if (remaining > 0) {
        scopeSubscribers.set(scope, remaining);
        return;
      }
      scopeSubscribers.delete(scope);
      const state = refreshes.get(scope);
      const generation = scheduledGenerations.get(scope);
      // A completed cycle has already consumed this generation. Keep its
      // watermark across navigation, but let a canceled cycle restart when
      // the scope remounts. Bound the inactive watermarks independently of
      // the number of scopes that are currently mounted.
      if (state === undefined && generation !== undefined) {
        settledGenerations.delete(scope);
        settledGenerations.set(scope, generation);
        if (settledGenerations.size > MAX_SETTLED_REFRESH_SCOPES) {
          const oldest = settledGenerations.keys().next().value;
          if (oldest !== undefined) settledGenerations.delete(oldest);
        }
      }
      scheduledGenerations.delete(scope);
      if (state?.timer !== null && state?.timer !== undefined) {
        window.clearTimeout(state.timer);
      }
      refreshes.delete(scope);
    };
  }, [input.hostId, refreshEnabled, refreshScope, input.userId]);
  useEffect(() => {
    if (input.userId === null) return;
    observeActiveHistoryEdges(input.userId, workingEpicIds, Date.now());
    if (!refreshEnabled) return;
    const scope = JSON.stringify([input.hostId, input.userId, refreshScope]);
    const generation = generations.get(input.userId) ?? 0;
    const consumedGeneration = Math.max(
      scheduledGenerations.get(scope) ?? 0,
      settledGenerations.get(scope) ?? 0,
    );
    if (generation > consumedGeneration) {
      settledGenerations.delete(scope);
      queueActivityRefresh(scope, input.userId, generation, refetchActivity);
    } else {
      const state = refreshes.get(scope);
      if (state !== undefined) state.refetch = refetchActivity;
    }
  }, [
    activitySnapshot,
    input.enabled,
    input.hostId,
    refetchActivity,
    refreshEnabled,
    refreshScope,
    input.userId,
    workingEpicIds,
  ]);
  useEffect(() => {
    // A filtered page may contain the task while the unfiltered Recent page
    // still omits it; only the latter can retire an off-page context row.
    if (input.userId === null || !input.enabled) return;
    settleHistoryActivity(input.userId, input.items);
    settleBackfilledHistoryActivity(input.userId, backfilled);
  }, [backfilled, input.enabled, input.items, input.userId]);
  useEffect(() => {
    if (!refreshEnabled || input.userId === null || stamps.size === 0) return;
    const earliestExpiry = Math.min(
      ...[...stamps.values()].map((stamp) => stamp.expiresAt),
    );
    const timer = window.setTimeout(
      () => {
        if (removeExpiredStamps(Date.now())) changed(null);
        setNowMs(Date.now());
      },
      Math.max(0, earliestExpiry - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [activitySnapshot, refreshEnabled, input.userId]);
  if (!input.enabled || input.userId === null) return input.items;
  if (input.items.length === 0 && backfilled.length === 0) return EMPTY_ITEMS;
  return projectOptimisticHistoryItems(
    input.userId,
    input.items,
    backfilled,
    nowMs,
  );
}
