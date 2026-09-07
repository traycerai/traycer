import { create } from "zustand";

export type MigrationRunStatus = "idle" | "running" | "complete" | "error";

export interface MigrationRunCounts {
  readonly taskChainsComplete: number;
  readonly taskChainsSkipped: number;
  readonly taskChainsFailed: number;
  readonly epicsComplete: number;
  readonly epicsFailed: number;
  readonly replaysIncomplete: number;
}

export interface MigrationRunTotals {
  readonly totalTaskChains: number;
  readonly totalLocalEpics: number;
}

export interface MigrationRunState {
  readonly status: MigrationRunStatus;
  readonly totals: MigrationRunTotals | null;
  readonly counts: MigrationRunCounts;
  readonly finalSuccess: boolean | null;
}

/**
 * Migration runs, ONE PER HOST: a migration moves one machine's local data, so
 * two machines can be migrating at once and each carries its own progress.
 *
 * `remoteRunning` is deliberately NOT per host. It comes from the desktop's
 * cross-window IPC, which carries a single running bit and the window that
 * owns it - no host - so it stays the one aggregate the blocking modal reads.
 */
export interface MigrationRunsState {
  readonly runs: ReadonlyMap<string, MigrationRunState>;
  readonly remoteRunning: boolean;
}

interface MigrationRunActions {
  readonly markRunning: (hostId: string) => void;
  readonly applyStarted: (hostId: string, totals: MigrationRunTotals) => void;
  readonly incrementTaskChain: (
    hostId: string,
    outcome: "complete" | "skipped" | "failed",
  ) => void;
  readonly incrementEpic: (
    hostId: string,
    outcome: "complete" | "failed",
  ) => void;
  readonly incrementReplayIncomplete: (hostId: string) => void;
  readonly applyComplete: (
    hostId: string,
    input: {
      readonly success: boolean;
      readonly counts: MigrationRunCounts;
    },
  ) => void;
  readonly applyError: (hostId: string) => void;
  readonly setRemoteRunning: (running: boolean) => void;
  /** Retires one host's run; every other host keeps its own. */
  readonly reset: (hostId: string) => void;
}

const INITIAL_COUNTS: MigrationRunCounts = {
  taskChainsComplete: 0,
  taskChainsSkipped: 0,
  taskChainsFailed: 0,
  epicsComplete: 0,
  epicsFailed: 0,
  replaysIncomplete: 0,
};

/** No migration on this host - the shape every selector falls back to. */
export const MIGRATION_RUN_IDLE: MigrationRunState = {
  status: "idle",
  totals: null,
  counts: INITIAL_COUNTS,
  finalSuccess: null,
};

export function taskChainsSeen(counts: MigrationRunCounts): number {
  return (
    counts.taskChainsComplete +
    counts.taskChainsSkipped +
    counts.taskChainsFailed
  );
}

export function epicsSeen(counts: MigrationRunCounts): number {
  return counts.epicsComplete + counts.epicsFailed;
}

/**
 * The run for one host, or the idle state for a host with none. A single
 * shared `MIGRATION_RUN_IDLE` instance, so a selector over a host that is not
 * migrating returns the same object every time and cannot churn its readers.
 */
export function migrationRunFor(
  state: MigrationRunsState,
  hostId: string | null,
): MigrationRunState {
  if (hostId === null) return MIGRATION_RUN_IDLE;
  return state.runs.get(hostId) ?? MIGRATION_RUN_IDLE;
}

export interface MigrationRunEntry {
  readonly hostId: string;
  readonly run: MigrationRunState;
}

/**
 * The run the ONE blocking modal speaks for: a live migration first - it is
 * what the modal blocks the app for - and otherwise a failure nobody has
 * acknowledged yet. `null` when no host has either, which is when the modal
 * is not on screen at all.
 */
export function migrationModalRun(
  runs: ReadonlyMap<string, MigrationRunState>,
): MigrationRunEntry | null {
  let errored: MigrationRunEntry | null = null;
  for (const [hostId, run] of runs) {
    if (run.status === "running") return { hostId, run };
    if (run.status === "error" && errored === null) errored = { hostId, run };
  }
  return errored;
}

/** True while any host is migrating - what the cross-window announce says. */
export function migrationAnyRunning(
  runs: ReadonlyMap<string, MigrationRunState>,
): boolean {
  for (const run of runs.values()) {
    if (run.status === "running") return true;
  }
  return false;
}

function foldRun(
  hostId: string,
  fold: (prev: MigrationRunState) => MigrationRunState,
): (state: MigrationRunsState) => Partial<MigrationRunsState> {
  return (state) => {
    const prev = state.runs.get(hostId) ?? MIGRATION_RUN_IDLE;
    const next = fold(prev);
    if (next === prev) return state;
    const runs = new Map(state.runs);
    runs.set(hostId, next);
    return { runs };
  };
}

export const useMigrationRunStore = create<
  MigrationRunsState & MigrationRunActions
>((set) => ({
  runs: new Map(),
  remoteRunning: false,
  markRunning: (hostId) =>
    set(foldRun(hostId, () => ({ ...MIGRATION_RUN_IDLE, status: "running" }))),
  applyStarted: (hostId, totals) =>
    set(foldRun(hostId, (prev) => ({ ...prev, totals }))),
  incrementTaskChain: (hostId, outcome) =>
    set(
      foldRun(hostId, (prev) => ({
        ...prev,
        counts: {
          ...prev.counts,
          taskChainsComplete:
            prev.counts.taskChainsComplete + (outcome === "complete" ? 1 : 0),
          taskChainsSkipped:
            prev.counts.taskChainsSkipped + (outcome === "skipped" ? 1 : 0),
          taskChainsFailed:
            prev.counts.taskChainsFailed + (outcome === "failed" ? 1 : 0),
        },
      })),
    ),
  incrementEpic: (hostId, outcome) =>
    set(
      foldRun(hostId, (prev) => ({
        ...prev,
        counts: {
          ...prev.counts,
          epicsComplete:
            prev.counts.epicsComplete + (outcome === "complete" ? 1 : 0),
          epicsFailed: prev.counts.epicsFailed + (outcome === "failed" ? 1 : 0),
        },
      })),
    ),
  incrementReplayIncomplete: (hostId) =>
    set(
      foldRun(hostId, (prev) => ({
        ...prev,
        counts: {
          ...prev.counts,
          replaysIncomplete: prev.counts.replaysIncomplete + 1,
        },
      })),
    ),
  // Nothing is being tracked for this host: no run started, or a finished one
  // was retired. A late frame must not materialise a slice for a run nobody
  // is showing - an `error` slice conjured this way would put the blocking
  // modal on screen for a migration that never happened. Same rule as the
  // session-import store, for the same reason.
  applyComplete: (hostId, { success, counts }) =>
    set(
      foldRun(hostId, (prev) =>
        prev.status === "idle"
          ? prev
          : { ...prev, status: "complete", finalSuccess: success, counts },
      ),
    ),
  // A connection drop after status === "complete" is not an error.
  applyError: (hostId) =>
    set(
      foldRun(hostId, (prev) =>
        prev.status === "complete" || prev.status === "idle"
          ? prev
          : { ...prev, status: "error" },
      ),
    ),
  // Equality dedupe so cross-window IPC frames carrying an unchanged
  // running bit do not re-render the modal-open selector.
  setRemoteRunning: (running) =>
    set((prev) =>
      prev.remoteRunning === running
        ? prev
        : { ...prev, remoteRunning: running },
    ),
  reset: (hostId) =>
    set((state) => {
      if (!state.runs.has(hostId)) return state;
      const runs = new Map(state.runs);
      runs.delete(hostId);
      return { runs };
    }),
}));

/** The migration for the host a surface sits under. */
export function useMigrationRun(hostId: string | null): MigrationRunState {
  return useMigrationRunStore((state) => migrationRunFor(state, hostId));
}
