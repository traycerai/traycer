import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
  /** Own-record timestamp from the host stream, when one is available. */
  readonly acceptedAt: number | null;
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

function stampActiveHistoryEdge(key: string, at: number): void {
  // A record delta may arrive before the turn projection. Preserve its exact
  // accepted timestamp so a different task edit cannot settle it early.
  const previous = stamps.get(key);
  stamps.set(key, {
    at: Math.max(previous?.at ?? 0, at),
    expiresAt: Math.max(previous?.expiresAt ?? 0, at + STAMP_TTL_MS),
    baselineAt: previous?.baselineAt ?? knownDurableAt.get(key) ?? null,
    acceptedAt: previous?.acceptedAt ?? null,
  });
  if (stamps.size > MAX_ACTIVE_ROWS) {
    const oldest = stamps.keys().next().value;
    if (oldest !== undefined) stamps.delete(oldest);
  }
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
  stamps.delete(key);
  stamps.set(key, {
    at: Math.max(previous?.at ?? 0, at),
    expiresAt: Date.now() + STAMP_TTL_MS,
    baselineAt: previous?.baselineAt ?? knownDurableAt.get(key) ?? null,
    acceptedAt: Math.max(previous?.acceptedAt ?? 0, at),
  });
  if (stamps.size > MAX_ACTIVE_ROWS) {
    const oldest = stamps.keys().next().value;
    if (oldest !== undefined) stamps.delete(oldest);
  }
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
export function settleHistoryActivity(
  userId: string,
  items: readonly HistoryItem[],
): void {
  let removed = false;
  for (const item of items) {
    const key = keyFor(userId, item.epicId);
    const durableAt = item.recentAtMs ?? item.updatedAtMs;
    const stamp = stamps.get(key);
    if (stamp !== undefined) {
      const caughtUp =
        stamp.acceptedAt !== null
          ? durableAt >= stamp.acceptedAt
          : durableAt >= stamp.at ||
            (stamp.baselineAt !== null && durableAt > stamp.baselineAt);
      if (caughtUp) {
        stamps.delete(key);
        removed = true;
      } else if (stamp.baselineAt === null) {
        // A task that was off-page at the edge has no prior key. Establish the
        // first returned value as its baseline; only a later change settles it.
        stamps.set(key, { ...stamp, baselineAt: durableAt });
      }
    }
    rememberDurableKey(key, durableAt);
  }
  if (removed) changed(null);
}

/** Pure loaded-row projection shared by the panel and the phone drawer. */
export function projectOptimisticHistoryItems(
  userId: string,
  pageItems: readonly HistoryItem[],
  backfilled: readonly HistoryItem[],
  nowMs: number,
): readonly HistoryItem[] {
  const byEpic = new Map(pageItems.map((item) => [item.epicId, item]));
  for (const item of backfilled) {
    if (!byEpic.has(item.epicId)) byEpic.set(item.epicId, item);
  }
  const items = [...byEpic.values()].map((item) => {
    const stamp = stamps.get(keyFor(userId, item.epicId));
    if (stamp === undefined || stamp.expiresAt <= nowMs) return item;
    const recentAtMs = Math.max(item.recentAtMs ?? item.updatedAtMs, stamp.at);
    return {
      ...item,
      recentAtMs,
      recentLabel: formatUpdatedLabel(recentAtMs),
      recentBucket: toHistoryRecencyBucket(recentAtMs, nowMs),
    };
  });
  return sortHistoryItems(items, "recent");
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
    if (!input.enabled) return [];
    const onPage = new Set(input.items.map((item) => item.epicId));
    const stamped = [...activitySnapshot.stamps]
      .filter(
        ([key]) => (JSON.parse(key) as [string, string])[0] === input.userId,
      )
      .map(([key]) => (JSON.parse(key) as [string, string])[1]);
    return [...new Set([...workingEpicIds, ...stamped])]
      .filter((epicId) => !onPage.has(epicId))
      .sort()
      .slice(0, MAX_ACTIVE_ROWS);
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
  const backfilled = useMemo(
    () =>
      buildHistoryItemsFromTasks(
        [...backfill.tasksById.values()],
        nowMs,
        input.userId,
        backfill.localHomedTaskIds,
      ).filter((item) => missing.includes(item.epicId)),
    [
      backfill.localHomedTaskIds,
      backfill.tasksById,
      input.userId,
      missing,
      nowMs,
    ],
  );
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
      queueActivityRefresh(scope, input.userId, generation, input.refetch);
    } else {
      const state = refreshes.get(scope);
      if (state !== undefined) state.refetch = input.refetch;
    }
  }, [
    activitySnapshot,
    input.enabled,
    input.hostId,
    input.refetch,
    refreshEnabled,
    refreshScope,
    input.userId,
    workingEpicIds,
  ]);
  useEffect(() => {
    if (input.userId !== null) settleHistoryActivity(input.userId, input.items);
  }, [input.items, input.userId]);
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
