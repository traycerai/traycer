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
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { WorktreeDeleteStreamClient } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";

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
const UNREACHABLE_MESSAGE = "This host is no longer reachable.";
const CONNECTION_LOST_MESSAGE =
  "Lost connection to the host before the delete finished.";

export interface WorktreeDeleteRunRecord {
  readonly key: string;
  readonly hostId: string;
  readonly target: WorktreeHostEntry;
  readonly run: WorktreeDeleteRunState;
  readonly backgrounded: boolean;
}

interface WorktreeDeleteRunStore {
  readonly runs: readonly WorktreeDeleteRunRecord[];
  readonly foregroundKey: string | null;
  readonly begin: (input: {
    readonly key: string;
    readonly hostId: string;
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
  completeRun: (key, deleted) =>
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
        foregroundKey:
          record.backgrounded && !deleted ? key : state.foregroundKey,
      };
    }),
  failRun: (key, error) =>
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
        foregroundKey: record.backgrounded ? key : state.foregroundKey,
      };
    }),
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
const clientRefs = new Map<string, WorktreeDeleteStreamClient>();

interface QueuedWorktreeDelete {
  readonly key: string;
  readonly target: WorktreeHostEntry;
  readonly scripts: WorktreeEntryScripts | null;
  readonly streamClient: WsStreamClient<HostStreamRpcRegistry>;
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
  streamClient: WsStreamClient<HostStreamRpcRegistry> | null,
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
  readonly startBackgrounded: (
    target: WorktreeHostEntry,
    scripts: WorktreeEntryScripts | null,
  ) => void;
  readonly clearCompletedDeletedMissingFromList: (
    visibleWorktreePaths: ReadonlySet<string>,
  ) => void;
  readonly background: () => void;
  readonly close: () => void;
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
      if (streamClient === null) {
        begin({
          key,
          hostId,
          target,
          backgrounded: false,
          run: {
            ...INITIAL_RUN,
            status: "failed",
            error: UNREACHABLE_MESSAGE,
          },
        });
        return;
      }
      begin({ key, hostId, target, run: QUEUED_RUN, backgrounded });
      queuedDeletes.push({
        key,
        target,
        scripts,
        streamClient,
        onSettled,
      });
      drainDeleteQueue();
    },
    [begin, hostId, streamClient],
  );
  const start = useCallback(
    (target: WorktreeHostEntry, scripts: WorktreeEntryScripts | null) => {
      startDelete(target, scripts, false);
    },
    [startDelete],
  );
  const startBackgrounded = useCallback(
    (target: WorktreeHostEntry, scripts: WorktreeEntryScripts | null) => {
      startDelete(target, scripts, true);
    },
    [startDelete],
  );
  const clearCompletedDeletedMissingFromList = useCallback(
    (visibleWorktreePaths: ReadonlySet<string>): void => {
      clearCompletedDeletedMissingFromStore(hostId, visibleWorktreePaths);
    },
    [clearCompletedDeletedMissingFromStore, hostId],
  );

  return {
    target: visibleRecord?.target ?? null,
    run: visibleRecord?.run ?? null,
    backgrounded: visibleRecord?.backgrounded ?? false,
    runs: visibleRuns,
    start,
    startBackgrounded,
    clearCompletedDeletedMissingFromList,
    background,
    close,
  };
}

export function __resetWorktreeDeleteRunForTests(): void {
  clientRefs.forEach((client) => client.close());
  clientRefs.clear();
  queuedDeletes.length = 0;
  activeDeleteStreamCount = 0;
  pendingSettledCallbacks.clear();
  useWorktreeDeleteRunStore.getState().clearAll();
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
    const client = new WorktreeDeleteStreamClient({
      wsStreamClient: item.streamClient,
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
          useWorktreeDeleteRunStore.getState().updateRun(item.key, (run) => ({
            ...run,
            log: [...run.log, { id: run.log.length, channel, text: chunk }],
          })),
        onComplete: (deleted) => {
          useWorktreeDeleteRunStore.getState().completeRun(item.key, deleted);
          closeDeleteClient(item.key);
          settle();
        },
        onFailed: (reason) => {
          useWorktreeDeleteRunStore.getState().failRun(item.key, reason);
          closeDeleteClient(item.key);
          settle();
        },
        onConnectionStatus: (status, reason) => {
          // Only a drop BEFORE a terminal app frame is an error; a caller close
          // after terminal frames is a no-op because `settle` is idempotent.
          if (status !== "closed" || reason === null) return;
          useWorktreeDeleteRunStore
            .getState()
            .failRun(item.key, CONNECTION_LOST_MESSAGE);
          closeDeleteClient(item.key);
          settle();
        },
      },
    });
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
