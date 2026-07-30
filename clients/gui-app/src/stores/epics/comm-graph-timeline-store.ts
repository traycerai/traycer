/**
 * ONE time cursor per epic, read by the graph canvas and driven by the
 * on-canvas transport.
 *
 * It outlived the sidebar panel that used to own it, and deliberately: keeping
 * the cursor here rather than inside the tile means closing and reopening the
 * graph does not silently rewind the epic's playback position, and any future
 * second reader of "where is the cursor" gets the same answer as the canvas.
 * Keyed by epic id.
 *
 * SESSION-ONLY, deliberately not persisted. A cursor is a reading position into
 * an event log that is itself not persisted client-side: restoring "paused at
 * 14:02:41" against a log this client has not re-pulled would point at nothing.
 * A fresh load starts live, which is also the product default.
 *
 * Playback TIMING is not here. This store holds where the cursor is, not who is
 * moving it: the on-canvas transport owns the tick (it owns the controls), so
 * `playing` is an intent any reader can observe while exactly one advances it.
 */
import { create } from "zustand";
import type { CommGraphTimeCursor } from "@/lib/comm-graph/comm-graph-timeline";

/**
 * Playback speeds, in the order the control cycles them. Event-paced, not
 * wall-clock-scaled - see the transport's tick.
 */
export const COMM_GRAPH_PLAYBACK_SPEEDS: ReadonlyArray<number> = [0.5, 1, 2, 4];

const DEFAULT_SPEED = 1;

export interface CommGraphTimelineEpicState {
  /** `null` = live: the cursor tracks the newest row as rows arrive. */
  readonly cursor: CommGraphTimeCursor | null;
  readonly playing: boolean;
  readonly speed: number;
}

const DEFAULT_EPIC_STATE: CommGraphTimelineEpicState = {
  cursor: null,
  playing: false,
  speed: DEFAULT_SPEED,
};

interface CommGraphTimelineStore {
  readonly stateByEpicId: Readonly<
    Record<string, CommGraphTimelineEpicState | undefined>
  >;
  readonly setCursor: (
    epicId: string,
    cursor: CommGraphTimeCursor | null,
  ) => void;
  readonly setPlaying: (epicId: string, playing: boolean) => void;
  readonly cycleSpeed: (epicId: string) => void;
}

function readEpicState(
  store: CommGraphTimelineStore,
  epicId: string,
): CommGraphTimelineEpicState {
  // Spread over the default (rather than `?? default`) so a slice written by an
  // earlier build can never surface an `undefined` field to a consumer guard.
  return { ...DEFAULT_EPIC_STATE, ...store.stateByEpicId[epicId] };
}

export const useCommGraphTimelineStore = create<CommGraphTimelineStore>(
  (set, get) => {
    const patch = (
      epicId: string,
      next: (
        current: CommGraphTimelineEpicState,
      ) => CommGraphTimelineEpicState | null,
    ): void => {
      set((state) => {
        const current = readEpicState(get(), epicId);
        const patched = next(current);
        if (patched === null) return state;
        return {
          stateByEpicId: { ...state.stateByEpicId, [epicId]: patched },
        };
      });
    };
    return {
      stateByEpicId: {},

      setCursor: (epicId, cursor) =>
        patch(epicId, (current) =>
          current.cursor === cursor ? null : { ...current, cursor },
        ),

      setPlaying: (epicId, playing) =>
        patch(epicId, (current) =>
          current.playing === playing ? null : { ...current, playing },
        ),

      cycleSpeed: (epicId) =>
        patch(epicId, (current) => {
          const index = COMM_GRAPH_PLAYBACK_SPEEDS.indexOf(current.speed);
          const nextIndex = (index + 1) % COMM_GRAPH_PLAYBACK_SPEEDS.length;
          return { ...current, speed: COMM_GRAPH_PLAYBACK_SPEEDS[nextIndex] };
        }),
    };
  },
);

/**
 * Per-field selectors, not a whole-slice one: `readEpicState` spreads a fresh
 * object on every call, so selecting the slice would re-render both surfaces on
 * every unrelated store write.
 */
export function useCommGraphCursor(epicId: string): CommGraphTimeCursor | null {
  return useCommGraphTimelineStore((s) => readEpicState(s, epicId).cursor);
}

export function useCommGraphPlaying(epicId: string): boolean {
  return useCommGraphTimelineStore((s) => readEpicState(s, epicId).playing);
}

export function useCommGraphSpeed(epicId: string): number {
  return useCommGraphTimelineStore((s) => readEpicState(s, epicId).speed);
}

/** Imperative read for callbacks that must not subscribe (playback ticks). */
export function readCommGraphTimelineEpicState(
  epicId: string,
): CommGraphTimelineEpicState {
  return readEpicState(useCommGraphTimelineStore.getState(), epicId);
}
