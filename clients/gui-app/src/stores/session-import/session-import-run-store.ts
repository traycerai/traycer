import { create } from "zustand";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  SessionImportOutcome,
  SessionImportRunCounts,
} from "@traycer/protocol/host/session-import/run";
import { sessionImportSelectionKey } from "@/components/session-import/session-import-model";

/**
 * Live state of the import runs this client is watching - ONE PER HOST.
 *
 * "One run at a time" is the host's own rule, so it is a fact about a machine
 * and not about this window: two hosts can be importing at once, and a store
 * with a single slice would let the second start overwrite the first's tally.
 * Every action therefore names the host it is about, and every surface reads
 * the slice for the host it sits under (`sessionImportRunFor`).
 *
 * A module-level store rather than wizard state because a run deliberately
 * outlives its wizard: the user is told to close it and carry on, and the
 * Settings entry shows the same progress from a different surface. It also
 * outlives its SOCKET, so every frame is folded idempotently - a re-subscribe
 * replays `started` and every `progress` frame already produced, and a replay
 * that double-counted would show "14 of 8 imported".
 */

export type SessionImportRunStatus =
  | "idle"
  | "starting"
  | "running"
  | "complete"
  | "error";

export interface SessionImportProgressEntry {
  /**
   * The run that reported this outcome. Carried on the entry, not just on the
   * frame, so every fold can ask whose progress it is holding - a socket that
   * has been re-pointed at a newer run can still drain the previous one's
   * frames, and those sessions belong to a tally this store is no longer
   * showing.
   */
  readonly runId: string;
  readonly selectionKey: string;
  readonly harness: GuiHarnessId;
  readonly nativeSessionId: string;
  readonly outcome: SessionImportOutcome;
}

export interface SessionImportRunState {
  readonly status: SessionImportRunStatus;
  readonly runId: string | null;
  readonly total: number;
  /** Keyed so a replayed frame overwrites rather than appends. */
  readonly outcomes: ReadonlyMap<string, SessionImportProgressEntry>;
  /** Display titles captured at submit; empty when we attached mid-run. */
  readonly titles: ReadonlyMap<string, string>;
  /**
   * True when the host answered our subscribe by attaching us to a run that
   * was already in flight. The selections we submitted were NOT started, so
   * every surface reading this run has to say whose progress it is showing.
   */
  readonly attached: boolean;
  /** The session the last frame was about - the progress line's caption. */
  readonly lastTitle: string | null;
  /** Authoritative counts, present only once the run reports `complete`. */
  readonly finalCounts: SessionImportRunCounts | null;
}

export interface SessionImportRunsState {
  /**
   * One slice per host with a run this window is watching, in START ORDER: a
   * host whose run begins is (re)inserted at the end, so the last entry is the
   * newest run. The single ambient toast speaks for one run and picks it that
   * way.
   */
  readonly runs: ReadonlyMap<string, SessionImportRunState>;
}

interface SessionImportRunActions {
  readonly markStarting: (
    hostId: string,
    titles: ReadonlyMap<string, string>,
  ) => void;
  readonly applyStarted: (
    hostId: string,
    input: {
      readonly runId: string;
      readonly total: number;
      readonly attached: boolean;
    },
  ) => void;
  readonly applyProgress: (
    hostId: string,
    entry: SessionImportProgressEntry,
  ) => void;
  readonly applyComplete: (
    hostId: string,
    input: {
      readonly runId: string;
      readonly counts: SessionImportRunCounts;
    },
  ) => void;
  readonly applyError: (hostId: string) => void;
  /** Retires one host's run; every other host keeps its own. */
  readonly reset: (hostId: string) => void;
}

/** No import on this host - the shape every selector falls back to. */
export const SESSION_IMPORT_RUN_IDLE: SessionImportRunState = {
  status: "idle",
  runId: null,
  total: 0,
  outcomes: new Map(),
  titles: new Map(),
  attached: false,
  lastTitle: null,
  finalCounts: null,
};

/**
 * The run for one host, or the idle state for a host with none. A single
 * shared `SESSION_IMPORT_RUN_IDLE` instance, so a selector over a host that is
 * not importing returns the same object every time and cannot churn its
 * readers.
 */
export function sessionImportRunFor(
  state: SessionImportRunsState,
  hostId: string | null,
): SessionImportRunState {
  if (hostId === null) return SESSION_IMPORT_RUN_IDLE;
  return state.runs.get(hostId) ?? SESSION_IMPORT_RUN_IDLE;
}

/** Sessions the run has reported on, however they turned out. */
export function sessionImportDoneCount(state: SessionImportRunState): number {
  return state.outcomes.size;
}

export function sessionImportCountsFromOutcomes(
  outcomes: ReadonlyMap<string, SessionImportProgressEntry>,
): SessionImportRunCounts {
  let imported = 0;
  let skippedAlreadyImported = 0;
  let failed = 0;
  for (const entry of outcomes.values()) {
    if (entry.outcome.kind === "imported") imported += 1;
    else if (entry.outcome.kind === "skipped_already_imported") {
      skippedAlreadyImported += 1;
    } else failed += 1;
  }
  return { imported, skippedAlreadyImported, failed };
}

/**
 * The summary view's numbers: the run's own once it has reported them, and
 * until then what the frames seen so far add up to. Takes the two fields it
 * reads rather than the whole state so a component can call it from a `useMemo`
 * over stable slices instead of minting a fresh object inside a selector.
 */
export function sessionImportRunCounts(input: {
  readonly outcomes: ReadonlyMap<string, SessionImportProgressEntry>;
  readonly finalCounts: SessionImportRunCounts | null;
}): SessionImportRunCounts {
  return input.finalCounts ?? sessionImportCountsFromOutcomes(input.outcomes);
}

export function sessionImportIsRunning(state: SessionImportRunState): boolean {
  return state.status === "starting" || state.status === "running";
}

/**
 * Folds one host's slice. A fold that returns the slice it was given leaves
 * the whole map alone, so a refused frame (a foreign run id, a late frame on
 * a retired run) re-renders nothing.
 */
function foldRun(
  hostId: string,
  fold: (prev: SessionImportRunState) => SessionImportRunState,
): (state: SessionImportRunsState) => SessionImportRunsState {
  return (state) => {
    const prev = state.runs.get(hostId) ?? SESSION_IMPORT_RUN_IDLE;
    const next = fold(prev);
    if (next === prev) return state;
    const runs = new Map(state.runs);
    runs.set(hostId, next);
    return { runs };
  };
}

export const useSessionImportRunStore = create<
  SessionImportRunsState & SessionImportRunActions
>((set) => ({
  runs: new Map(),
  markStarting: (hostId, titles) =>
    set(
      foldRun(hostId, () => ({
        ...SESSION_IMPORT_RUN_IDLE,
        status: "starting",
        titles,
      })),
    ),
  applyStarted: (hostId, { runId, total, attached }) =>
    set((state) => {
      const prev = state.runs.get(hostId) ?? SESSION_IMPORT_RUN_IDLE;
      // Whose run this is was settled by the FIRST frame that named the id; a
      // redeclare only refreshes the totals. The distinction matters because
      // `attached: true` does not mean "someone else's run" - a physical
      // reconnect makes the transport resubscribe to `sessionImport.run`, and
      // the host answers `attached: true` for the run this very window
      // submitted a moment ago. Re-reading ownership off that frame would tell
      // the user their selections were never started, and would throw away the
      // titles that caption the progress line.
      if (prev.runId === runId) {
        // A reconnect replay redeclaring an unchanged run is not a change;
        // returning `prev` keeps every reader of the slice from re-rendering.
        if (prev.status === "running" && prev.total === total) return state;
        return foldRun(hostId, () => ({ ...prev, status: "running", total }))(
          state,
        );
      }
      // A run id we were not tracking supersedes the one we were: its outcomes
      // are about other sessions. Only here does `attached` decide ownership -
      // the host put us on a run already in flight, so our selections were
      // never started and the titles we captured caption nothing in it.
      return foldRun(hostId, () => ({
        ...SESSION_IMPORT_RUN_IDLE,
        status: "running",
        runId,
        total,
        attached,
        titles: attached ? SESSION_IMPORT_RUN_IDLE.titles : prev.titles,
      }))(state);
    }),
  applyProgress: (hostId, entry) =>
    set(
      foldRun(hostId, (prev) => {
        // Nothing is being tracked: either no run has started, or the user has
        // retired a finished one. A late frame must not resurrect a run every
        // surface has stopped showing.
        if (prev.status === "idle") return prev;
        // A frame from a superseded or foreign run would count its sessions
        // into this run's progress - "14 of 8 imported" from the other
        // direction.
        if (prev.runId !== null && prev.runId !== entry.runId) return prev;
        const outcomes = new Map(prev.outcomes);
        outcomes.set(entry.selectionKey, entry);
        return {
          ...prev,
          status: prev.status === "complete" ? prev.status : "running",
          outcomes,
          lastTitle: prev.titles.get(entry.selectionKey) ?? prev.lastTitle,
        };
      }),
    ),
  applyComplete: (hostId, { runId, counts }) =>
    set(
      foldRun(hostId, (prev) =>
        // Another run's summary is not this run's summary: its counts would
        // replace the tally the surfaces are showing with numbers about
        // sessions the user never selected.
        prev.runId !== null && prev.runId !== runId
          ? prev
          : {
              ...prev,
              status: "complete",
              runId,
              finalCounts: counts,
            },
      ),
    ),
  // A drop after the run has completed is not an error - the summary the user
  // is reading is final.
  applyError: (hostId) =>
    set(
      foldRun(hostId, (prev) =>
        prev.status === "complete" || prev.status === "idle"
          ? prev
          : { ...prev, status: "error" },
      ),
    ),
  reset: (hostId) =>
    set((state) => {
      if (!state.runs.has(hostId)) return state;
      const runs = new Map(state.runs);
      runs.delete(hostId);
      return { runs };
    }),
}));

/** The run for the host a surface sits under. */
export function useSessionImportRun(
  hostId: string | null,
): SessionImportRunState {
  return useSessionImportRunStore((state) =>
    sessionImportRunFor(state, hostId),
  );
}

export function progressEntryFrom(input: {
  readonly runId: string;
  readonly harness: GuiHarnessId;
  readonly nativeSessionId: string;
  readonly outcome: SessionImportOutcome;
}): SessionImportProgressEntry {
  return {
    runId: input.runId,
    selectionKey: sessionImportSelectionKey(
      input.harness,
      input.nativeSessionId,
    ),
    harness: input.harness,
    nativeSessionId: input.nativeSessionId,
    outcome: input.outcome,
  };
}
