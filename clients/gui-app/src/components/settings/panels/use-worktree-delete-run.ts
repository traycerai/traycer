import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  WorktreeDeleteOutputChannel,
  WorktreeDeletePhase,
} from "@traycer/protocol/host/worktree-delete-stream";
import type { WorktreeHostEntry } from "@traycer/protocol/host/index";
import type { WorktreeEntryScripts } from "@traycer/protocol/host/worktree-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { WorktreeDeleteStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";

export interface LogSegment {
  /** Monotonic per-run id (append-only), so React keys are stable. */
  readonly id: number;
  readonly channel: WorktreeDeleteOutputChannel;
  readonly text: string;
}

export interface WorktreeDeleteRunState {
  readonly status: "queued" | "running" | "complete" | "failed";
  /** Whether a teardown step runs - known once the `started` frame arrives. */
  readonly hasTeardown: boolean;
  readonly activePhase: WorktreeDeletePhase | null;
  readonly log: readonly LogSegment[];
  readonly deleted: boolean;
  readonly error: string | null;
}

const INITIAL_RUN: WorktreeDeleteRunState = {
  status: "running",
  hasTeardown: false,
  activePhase: null,
  log: [],
  deleted: false,
  error: null,
};

const QUEUED_RUN: WorktreeDeleteRunState = {
  ...INITIAL_RUN,
  status: "queued",
};

// Each stream can run teardown scripts plus git removal; cap fanout so a large
// multi-repo selection cannot saturate the host or websocket transport.
const MAX_PARALLEL_DELETE_STREAMS = 2;
const CONNECTION_LOST_MESSAGE =
  "Lost connection to the host before the delete finished.";

export interface WorktreeDeleteRunRecord {
  readonly key: string;
  readonly hostId: string;
  readonly batchKey: string | null;
  readonly target: WorktreeHostEntry;
  readonly run: WorktreeDeleteRunState;
  readonly backgrounded: boolean;
}

export interface WorktreeDeleteProgressSummary {
  readonly total: number;
  readonly deleted: number;
  readonly failed: number;
  readonly active: number;
}

interface WorktreeDeleteRunStore {
  readonly runs: readonly WorktreeDeleteRunRecord[];
  readonly foregroundKey: string | null;
  readonly begin: (input: {
    readonly key: string;
    readonly hostId: string;
    readonly batchKey: string | null;
    readonly target: WorktreeHostEntry;
    readonly run: WorktreeDeleteRunState;
    readonly backgrounded: boolean;
  }) => void;
  readonly updateRun: (
    key: string,
    updater: (run: WorktreeDeleteRunState) => WorktreeDeleteRunState,
  ) => void;
  readonly completeRun: (key: string, deleted: boolean) => void;
  readonly failRun: (key: string, error: string) => void;
  readonly setBackgrounded: (key: string, backgrounded: boolean) => void;
  readonly backgroundForegroundForHost: (hostId: string) => void;
  readonly clearTerminalBackgroundedForHost: (hostId: string) => void;
  readonly clearSettledSuccessesForHostIfQuiescent: (hostId: string) => void;
  readonly clearCompletedDeletedMissingFromList: (
    hostId: string,
    visibleWorktreePaths: ReadonlySet<string>,
  ) => void;
  readonly clear: (key: string) => void;
  readonly clearAll: () => void;
}

const useWorktreeDeleteRunStore = create<WorktreeDeleteRunStore>((set) => ({
  runs: [],
  foregroundKey: null,
  begin: (input) =>
    set((state) => ({
      runs: upsertRun(state.runs, {
        key: input.key,
        hostId: input.hostId,
        batchKey: input.batchKey,
        target: input.target,
        run: input.run,
        backgrounded: input.backgrounded,
      }),
      foregroundKey: input.backgrounded ? state.foregroundKey : input.key,
    })),
  updateRun: (key, updater) =>
    set((state) => ({
      runs: state.runs.map((record) =>
        record.key === key ? { ...record, run: updater(record.run) } : record,
      ),
    })),
  completeRun: (key, deleted) => {
    // Emission rides the natural non-terminal -> terminal transition (state
    // read before the synchronous update); a replayed/duplicate settle can't
    // double-count and no reporting ledger is needed.
    const existing = useWorktreeDeleteRunStore
      .getState()
      .runs.find((candidate) => candidate.key === key);
    const wasTerminal =
      existing === undefined || worktreeRunIsTerminal(existing.run);
    set((state) => {
      const record = state.runs.find((candidate) => candidate.key === key);
      if (record === undefined) return state;
      const updated: WorktreeDeleteRunRecord = {
        ...record,
        run: {
          ...record.run,
          status: "complete",
          deleted,
          activePhase: null,
        },
      };
      return {
        runs: state.runs.map((candidate) =>
          candidate.key === key ? updated : candidate,
        ),
        // Re-surface a SINGLE backgrounded delete's modal on a soft failure so
        // the user sees why. A batch item (`batchKey !== null`) stays in the
        // background - popping a modal over the still-running siblings is the
        // bug we are avoiding; its failure shows in the progress strip/toast.
        foregroundKey:
          record.backgrounded && !deleted && record.batchKey === null
            ? key
            : state.foregroundKey,
      };
    });
    if (!wasTerminal) {
      reportTerminalDeleteOutcome(
        key,
        useWorktreeDeleteRunStore.getState().runs,
      );
    }
  },
  failRun: (key, error) => {
    const existing = useWorktreeDeleteRunStore
      .getState()
      .runs.find((candidate) => candidate.key === key);
    const wasTerminal =
      existing === undefined || worktreeRunIsTerminal(existing.run);
    set((state) => {
      const record = state.runs.find((candidate) => candidate.key === key);
      if (record === undefined) return state;
      if (record.run.status === "complete" || record.run.status === "failed") {
        return state;
      }
      return {
        runs: state.runs.map((candidate) =>
          candidate.key === key
            ? {
                ...candidate,
                run: {
                  ...candidate.run,
                  status: "failed",
                  error,
                },
              }
            : candidate,
        ),
        // Same rule as `completeRun`: re-surface a single backgrounded delete's
        // modal on failure, but never pop one for a batch item - batch failures
        // surface non-modally in the progress strip/toast.
        foregroundKey:
          record.backgrounded && record.batchKey === null
            ? key
            : state.foregroundKey,
      };
    });
    if (!wasTerminal) {
      reportTerminalDeleteOutcome(
        key,
        useWorktreeDeleteRunStore.getState().runs,
      );
    }
  },
  setBackgrounded: (key, backgrounded) =>
    set((state) => ({
      runs: state.runs.map((record) =>
        record.key === key ? { ...record, backgrounded } : record,
      ),
      foregroundKey:
        backgrounded && state.foregroundKey === key
          ? null
          : state.foregroundKey,
    })),
  backgroundForegroundForHost: (hostId) =>
    set((state) => {
      const key = state.foregroundKey;
      if (key === null) return state;
      const record = state.runs.find(
        (candidate) => candidate.key === key && candidate.hostId === hostId,
      );
      if (record === undefined || worktreeRunIsTerminal(record.run)) {
        return state;
      }
      return {
        runs: state.runs.map((candidate) =>
          candidate.key === key
            ? { ...candidate, backgrounded: true }
            : candidate,
        ),
        foregroundKey: null,
      };
    }),
  // Acknowledge path for the per-host progress strip: drop every settled
  // (deleted / failed / soft-failed) backgrounded run for the host so a batch
  // that finished with failures stops occupying the strip and the app-wide
  // toast.
  clearTerminalBackgroundedForHost: (hostId) =>
    set((state) => {
      const runs = state.runs.filter(
        (record) =>
          !(
            record.hostId === hostId &&
            record.backgrounded &&
            worktreeRunIsTerminal(record.run)
          ),
      );
      if (runs.length === state.runs.length) return state;
      return {
        runs,
        foregroundKey:
          state.foregroundKey !== null &&
          !runs.some((record) => record.key === state.foregroundKey)
            ? null
            : state.foregroundKey,
      };
    }),
  // Drop a host's successfully-deleted backgrounded runs when nothing for that
  // host is still in flight. The mounted list prunes these via
  // `clearCompletedDeletedMissingFromList`, but a host the user has navigated
  // away from has no mounted list, so without this its successes linger in the
  // app-wide toast forever. Gated on quiescence so it never drops the deleted
  // tally of a batch that is still running.
  clearSettledSuccessesForHostIfQuiescent: (hostId) =>
    set((state) => {
      const hostBackgrounded = state.runs.filter(
        (record) => record.hostId === hostId && record.backgrounded,
      );
      const anyActive = hostBackgrounded.some(
        (record) => !worktreeRunIsTerminal(record.run),
      );
      if (anyActive) return state;
      const runs = state.runs.filter(
        (record) =>
          !(
            record.hostId === hostId &&
            record.backgrounded &&
            record.run.status === "complete" &&
            record.run.deleted
          ),
      );
      if (runs.length === state.runs.length) return state;
      return {
        runs,
        foregroundKey:
          state.foregroundKey !== null &&
          !runs.some((record) => record.key === state.foregroundKey)
            ? null
            : state.foregroundKey,
      };
    }),
  clearCompletedDeletedMissingFromList: (hostId, visibleWorktreePaths) =>
    set((state) => {
      const runs = state.runs.filter((record) => {
        const shouldKeep =
          record.hostId !== hostId ||
          !record.backgrounded ||
          record.run.status !== "complete" ||
          !record.run.deleted ||
          visibleWorktreePaths.has(record.target.worktreePath);
        return shouldKeep;
      });
      if (runs.length === state.runs.length) return state;
      return {
        runs,
        foregroundKey:
          state.foregroundKey !== null &&
          !runs.some((record) => record.key === state.foregroundKey)
            ? null
            : state.foregroundKey,
      };
    }),
  clear: (key) =>
    set((state) => ({
      runs: state.runs.filter((record) => record.key !== key),
      foregroundKey: state.foregroundKey === key ? null : state.foregroundKey,
    })),
  clearAll: () => set({ runs: [], foregroundKey: null }),
}));

/**
 * Module-level registry for live delete stream clients. Each host/worktree
 * pair owns its own stream, so backgrounding one delete does not release or
 * overwrite another in-flight delete.
 */
const clientRefs = new Map<string, { close(): void }>();

interface QueuedWorktreeDelete {
  readonly key: string;
  readonly hostId: string;
  readonly target: WorktreeHostEntry;
  readonly scripts: WorktreeEntryScripts | null;
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly onSettled: () => void;
}

const queuedDeletes: QueuedWorktreeDelete[] = [];
let activeDeleteStreamCount = 0;
const pendingSettledCallbacks = new Set<() => void>();

/**
 * Owns `worktree.deleteByPath` stream lifecycles for Settings deletes. Each
 * stream is started imperatively from the confirm action (a user event, fired
 * exactly once) rather than a mount effect, so a StrictMode double-invoke can
 * never open the stream twice and trigger two server-side deletes.
 *
 * The run state is global to the Settings surface instead of section-local:
 * switching Settings sections or closing/reopening Settings must not abort a
 * backgrounded delete or lose its row/modal state.
 */
export function useWorktreeDeleteRun(
  hostId: string,
  openStreamTransport: (hostId: string) => DurableStreamTransport,
  onSettled: () => void,
): {
  readonly target: WorktreeHostEntry | null;
  readonly run: WorktreeDeleteRunState | null;
  readonly backgrounded: boolean;
  readonly runs: readonly WorktreeDeleteRunRecord[];
  readonly start: (
    target: WorktreeHostEntry,
    scripts: WorktreeEntryScripts | null,
  ) => void;
  readonly startBatchBackgrounded: (
    targets: ReadonlyArray<WorktreeHostEntry>,
    scriptsByPath: ReadonlyMap<string, WorktreeEntryScripts>,
  ) => void;
  readonly clearCompletedDeletedMissingFromList: (
    visibleWorktreePaths: ReadonlySet<string>,
  ) => void;
  readonly background: () => void;
  readonly close: () => void;
  readonly dismissTerminalBackgrounded: () => void;
} {
  const { runs, foregroundKey, begin, setBackgrounded, clear } =
    useWorktreeDeleteRunStore(
      useShallow((state) => ({
        runs: state.runs,
        foregroundKey: state.foregroundKey,
        begin: state.begin,
        setBackgrounded: state.setBackgrounded,
        clear: state.clear,
      })),
    );
  const clearCompletedDeletedMissingFromStore = useWorktreeDeleteRunStore(
    (state) => state.clearCompletedDeletedMissingFromList,
  );
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const visibleRuns = runs.filter((record) => record.hostId === hostId);
  const visibleRecord =
    foregroundKey === null
      ? null
      : (visibleRuns.find(
          (record) =>
            record.key === foregroundKey && shouldShowProgress(record),
        ) ?? null);

  const background = useCallback(() => {
    if (visibleRecord === null) return;
    setBackgrounded(visibleRecord.key, true);
  }, [setBackgrounded, visibleRecord]);

  const close = useCallback(() => {
    if (visibleRecord === null) return;
    clientRefs.get(visibleRecord.key)?.close();
    clientRefs.delete(visibleRecord.key);
    clear(visibleRecord.key);
  }, [clear, visibleRecord]);

  const startDelete = useCallback(
    (
      target: WorktreeHostEntry,
      scripts: WorktreeEntryScripts | null,
      backgrounded: boolean,
      batchKey: string | null,
    ) => {
      const key = worktreeDeleteRunKey(hostId, target.worktreePath);
      if (
        clientRefs.has(key) ||
        queuedDeletes.some((queued) => queued.key === key)
      ) {
        return;
      }
      // Freeze the settle callback at start so a host swap mid-delete can't
      // redirect the cache invalidation to the wrong host scope (the live
      // `onSettledRef` would otherwise rebind to the newly-selected host).
      const onSettled = onSettledRef.current;
      begin({ key, hostId, batchKey, target, run: QUEUED_RUN, backgrounded });
      queuedDeletes.push({
        key,
        hostId,
        target,
        scripts,
        openStreamTransport,
        onSettled,
      });
      drainDeleteQueue();
    },
    [begin, hostId, openStreamTransport],
  );
  const start = useCallback(
    (target: WorktreeHostEntry, scripts: WorktreeEntryScripts | null) => {
      startDelete(target, scripts, false, null);
    },
    [startDelete],
  );
  const startBatchBackgrounded = useCallback(
    (
      targets: ReadonlyArray<WorktreeHostEntry>,
      scriptsByPath: ReadonlyMap<string, WorktreeEntryScripts>,
    ) => {
      const batchKey = nextWorktreeDeleteBatchKey(hostId);
      targets.forEach((target) => {
        startDelete(
          target,
          scriptsByPath.get(target.worktreePath) ?? null,
          true,
          batchKey,
        );
      });
    },
    [hostId, startDelete],
  );
  const clearCompletedDeletedMissingFromList = useCallback(
    (visibleWorktreePaths: ReadonlySet<string>): void => {
      clearCompletedDeletedMissingFromStore(hostId, visibleWorktreePaths);
    },
    [clearCompletedDeletedMissingFromStore, hostId],
  );
  const dismissTerminalBackgrounded = useCallback(() => {
    clearTerminalBackgroundedWorktreeDeletesForHost(hostId);
  }, [hostId]);

  return {
    target: visibleRecord?.target ?? null,
    run: visibleRecord?.run ?? null,
    backgrounded: visibleRecord?.backgrounded ?? false,
    runs: visibleRuns,
    start,
    startBatchBackgrounded,
    clearCompletedDeletedMissingFromList,
    background,
    close,
    dismissTerminalBackgrounded,
  };
}

export function __resetWorktreeDeleteRunForTests(): void {
  clientRefs.forEach((client) => client.close());
  clientRefs.clear();
  queuedDeletes.length = 0;
  activeDeleteStreamCount = 0;
  pendingSettledCallbacks.clear();
  batchSequence = 0;
  useWorktreeDeleteRunStore.getState().clearAll();
}

/**
 * Called exactly once per run's non-terminal -> terminal transition (the
 * store actions observe the transition inside their state update). A batch
 * emits when the member that just settled was its last non-terminal one.
 */
function reportTerminalDeleteOutcome(
  key: string,
  runs: readonly WorktreeDeleteRunRecord[],
): void {
  const record = runs.find((candidate) => candidate.key === key);
  if (record === undefined || !worktreeRunIsTerminal(record.run)) return;
  if (record.batchKey === null) {
    Analytics.getInstance().track(
      AnalyticsEvent.WorktreeDeleted,
      record.run.deleted
        ? { outcome: "succeeded", blocker: null }
        : {
            outcome: "failed",
            blocker: analyticsBlockerFromError(record.run.error),
          },
    );
    return;
  }
  const batch = runs.filter(
    (candidate) => candidate.batchKey === record.batchKey,
  );
  if (batch.some((candidate) => !worktreeRunIsTerminal(candidate.run))) {
    return;
  }
  const succeededCount = batch.filter(
    (candidate) => candidate.run.deleted,
  ).length;
  Analytics.getInstance().track(AnalyticsEvent.WorktreesBulkDeleted, {
    requested_count: batch.length,
    succeeded_count: succeededCount,
    failed_count: batch.length - succeededCount,
  });
}

export function useWorktreeDeleteProgressSummary(): WorktreeDeleteProgressSummary {
  // `summarizeProgress` builds a fresh object each call, so compare the result
  // shallowly: without this the selector returns a new reference every render,
  // which makes `useSyncExternalStore` re-render in an infinite loop.
  return useWorktreeDeleteRunStore(
    useShallow((state) =>
      summarizeProgress(state.runs.filter((record) => record.backgrounded)),
    ),
  );
}

export function summarizeWorktreeDeleteRuns(
  runs: readonly WorktreeDeleteRunRecord[],
): WorktreeDeleteProgressSummary {
  return summarizeProgress(runs.filter((record) => record.backgrounded));
}

export function backgroundForegroundWorktreeDeleteForHost(
  hostId: string,
): void {
  useWorktreeDeleteRunStore.getState().backgroundForegroundForHost(hostId);
}

export function clearTerminalBackgroundedWorktreeDeletesForHost(
  hostId: string,
): void {
  useWorktreeDeleteRunStore.getState().clearTerminalBackgroundedForHost(hostId);
}

export function clearSettledWorktreeDeleteSuccessesForHostIfQuiescent(
  hostId: string,
): void {
  useWorktreeDeleteRunStore
    .getState()
    .clearSettledSuccessesForHostIfQuiescent(hostId);
}

/**
 * Detail line shared by the in-panel progress strip and the app-wide progress
 * toast so the two surfaces cannot drift (e.g. one pluralizing "failed"). Reads
 * "2/5 deleted" or "2/5 deleted, 1 failed".
 */
export function worktreeDeleteProgressDetail(
  summary: WorktreeDeleteProgressSummary,
): string {
  const base = `${summary.deleted}/${summary.total} deleted`;
  if (summary.failed === 0) return base;
  return `${base}, ${summary.failed} failed`;
}

function drainDeleteQueue(): void {
  while (
    activeDeleteStreamCount < MAX_PARALLEL_DELETE_STREAMS &&
    queuedDeletes.length > 0
  ) {
    const next = queuedDeletes.shift();
    if (next === undefined) return;
    const record = useWorktreeDeleteRunStore
      .getState()
      .runs.find((candidate) => candidate.key === next.key);
    if (record === undefined || record.run.status !== "queued") continue;
    startQueuedDelete(next);
  }
}

function startQueuedDelete(item: QueuedWorktreeDelete): void {
  activeDeleteStreamCount += 1;
  useWorktreeDeleteRunStore
    .getState()
    .updateRun(item.key, (run) => ({ ...run, status: "running" }));

  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    activeDeleteStreamCount = Math.max(0, activeDeleteStreamCount - 1);
    pendingSettledCallbacks.add(item.onSettled);
    drainDeleteQueue();
    flushSettledCallbacksIfIdle();
  };

  try {
    const client = openOwnedDurableStreamClient(
      item.openStreamTransport,
      item.hostId,
      (wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>) =>
        new WorktreeDeleteStreamClient({
          wsStreamClient,
          worktreePath: item.target.worktreePath,
          scripts: item.scripts,
          callbacks: {
            onStarted: (hasTeardown) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(item.key, (run) => ({ ...run, hasTeardown })),
            onPhase: (phase) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(item.key, (run) => ({ ...run, activePhase: phase })),
            onOutput: (channel, chunk) =>
              useWorktreeDeleteRunStore
                .getState()
                .updateRun(item.key, (run) => ({
                  ...run,
                  log: [
                    ...run.log,
                    { id: run.log.length, channel, text: chunk },
                  ],
                })),
            onComplete: (deleted) => {
              useWorktreeDeleteRunStore
                .getState()
                .completeRun(item.key, deleted);
              closeDeleteClient(item.key);
              settle();
            },
            onFailed: (reason) => {
              useWorktreeDeleteRunStore.getState().failRun(item.key, reason);
              closeDeleteClient(item.key);
              settle();
            },
            onConnectionStatus: (status, reason) => {
              // Only a terminal stream close BEFORE an app-level terminal frame
              // is an error. Recoverable reconnects surface as "reconnecting".
              if (status !== "closed" || reason === null) return;
              useWorktreeDeleteRunStore
                .getState()
                .failRun(item.key, CONNECTION_LOST_MESSAGE);
              closeDeleteClient(item.key);
              settle();
            },
          },
        }),
    );
    clientRefs.set(item.key, client);
  } catch (error) {
    useWorktreeDeleteRunStore
      .getState()
      .failRun(item.key, startStreamErrorMessage(error));
    settle();
  }
}

function startStreamErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown error.";
  return `Failed to start delete stream. ${detail}`;
}

function closeDeleteClient(key: string): void {
  const client = clientRefs.get(key);
  clientRefs.delete(key);
  client?.close();
}

function summarizeProgress(
  runs: readonly WorktreeDeleteRunRecord[],
): WorktreeDeleteProgressSummary {
  const scopedRuns = activeProgressScope(runs);
  const total = scopedRuns.length;
  const deleted = scopedRuns.filter(
    (record) => record.run.status === "complete" && record.run.deleted,
  ).length;
  const failed = scopedRuns.filter(
    (record) =>
      record.run.status === "failed" ||
      (record.run.status === "complete" && !record.run.deleted),
  ).length;
  return {
    total,
    deleted,
    failed,
    active: Math.max(0, total - deleted - failed),
  };
}

function worktreeRunIsTerminal(run: WorktreeDeleteRunState): boolean {
  return run.status === "complete" || run.status === "failed";
}

function activeProgressScope(
  runs: readonly WorktreeDeleteRunRecord[],
): readonly WorktreeDeleteRunRecord[] {
  const groups = progressGroups(runs);
  const activeGroups = groups.filter((group) =>
    group.some((record) => !worktreeRunIsTerminal(record.run)),
  );
  if (activeGroups.length > 0) {
    return activeGroups.flatMap((group) => group);
  }
  if (groups.length === 0) return [];
  return groups[groups.length - 1];
}

function progressGroups(
  runs: readonly WorktreeDeleteRunRecord[],
): ReadonlyArray<ReadonlyArray<WorktreeDeleteRunRecord>> {
  const groups = new Map<string, WorktreeDeleteRunRecord[]>();
  runs.forEach((record) => {
    const key = record.batchKey ?? record.key;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [record]);
      return;
    }
    existing.push(record);
  });
  return [...groups.values()];
}

function flushSettledCallbacksIfIdle(): void {
  if (activeDeleteStreamCount > 0 || queuedDeletes.length > 0) return;
  const callbacks = [...pendingSettledCallbacks];
  pendingSettledCallbacks.clear();
  callbacks.forEach((callback) => callback());
}

function upsertRun(
  runs: readonly WorktreeDeleteRunRecord[],
  next: WorktreeDeleteRunRecord,
): readonly WorktreeDeleteRunRecord[] {
  const exists = runs.some((record) => record.key === next.key);
  if (!exists) return [...runs, next];
  return runs.map((record) => (record.key === next.key ? next : record));
}

function shouldShowProgress(record: WorktreeDeleteRunRecord): boolean {
  if (!record.backgrounded) return true;
  return (
    record.run.status === "failed" ||
    (record.run.status === "complete" && !record.run.deleted)
  );
}

function worktreeDeleteRunKey(hostId: string, worktreePath: string): string {
  return `${hostId}\u0000${worktreePath}`;
}

let batchSequence = 0;

function nextWorktreeDeleteBatchKey(hostId: string): string {
  batchSequence += 1;
  return `${hostId}\u0000batch\u0000${batchSequence}`;
}
