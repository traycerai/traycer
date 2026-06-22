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
  readonly remoteRunning: boolean;
}

interface MigrationRunActions {
  readonly markRunning: () => void;
  readonly applyStarted: (totals: MigrationRunTotals) => void;
  readonly incrementTaskChain: (
    outcome: "complete" | "skipped" | "failed",
  ) => void;
  readonly incrementEpic: (outcome: "complete" | "failed") => void;
  readonly incrementReplayIncomplete: () => void;
  readonly applyComplete: (input: {
    readonly success: boolean;
    readonly counts: MigrationRunCounts;
  }) => void;
  readonly applyError: () => void;
  readonly setRemoteRunning: (running: boolean) => void;
  readonly reset: () => void;
}

const INITIAL_COUNTS: MigrationRunCounts = {
  taskChainsComplete: 0,
  taskChainsSkipped: 0,
  taskChainsFailed: 0,
  epicsComplete: 0,
  epicsFailed: 0,
  replaysIncomplete: 0,
};

const INITIAL_STATE: MigrationRunState = {
  status: "idle",
  totals: null,
  counts: INITIAL_COUNTS,
  finalSuccess: null,
  remoteRunning: false,
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

export const useMigrationRunStore = create<
  MigrationRunState & MigrationRunActions
>((set) => ({
  ...INITIAL_STATE,
  markRunning: () =>
    set({
      status: "running",
      totals: null,
      counts: INITIAL_COUNTS,
      finalSuccess: null,
    }),
  applyStarted: (totals) =>
    set((prev) => ({
      ...prev,
      totals,
    })),
  incrementTaskChain: (outcome) =>
    set((prev) => ({
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
  incrementEpic: (outcome) =>
    set((prev) => ({
      counts: {
        ...prev.counts,
        epicsComplete:
          prev.counts.epicsComplete + (outcome === "complete" ? 1 : 0),
        epicsFailed: prev.counts.epicsFailed + (outcome === "failed" ? 1 : 0),
      },
    })),
  incrementReplayIncomplete: () =>
    set((prev) => ({
      counts: {
        ...prev.counts,
        replaysIncomplete: prev.counts.replaysIncomplete + 1,
      },
    })),
  applyComplete: ({ success, counts }) =>
    set({
      status: "complete",
      finalSuccess: success,
      counts,
    }),
  // A connection drop after status === "complete" is not an error.
  applyError: () =>
    set((prev) =>
      prev.status === "complete" ? prev : { ...prev, status: "error" },
    ),
  // Equality dedupe so cross-window IPC frames carrying an unchanged
  // running bit do not re-render the modal-open selector.
  setRemoteRunning: (running) =>
    set((prev) =>
      prev.remoteRunning === running
        ? prev
        : { ...prev, remoteRunning: running },
    ),
  reset: () => set(INITIAL_STATE),
}));
