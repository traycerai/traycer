/**
 * The transport: the controls that MOVE the epic's time cursor, and the single
 * playback tick.
 *
 * ONE OWNER, always. The tick lives with the controls, so the cursor cannot
 * double-step no matter how many things are watching it. That ownership used to
 * belong to the sidebar timeline panel; the panel is gone and the on-canvas
 * transport bar inherited it wholesale.
 *
 * LIVE IS `cursor === null`, not a flag beside the cursor. Everything here that
 * looks like a mode change is really just the cursor landing on, or leaving, the
 * newest row - which is why "scrub to the end", "play to the end" and "press
 * Live" all converge on the same state instead of three that must be kept in
 * agreement.
 *
 * The store outlives this hook (it is per epic, not per tile), so unmounting the
 * graph freezes playback where it stands rather than restarting it: `playing`
 * stays true and the next mount picks the tick back up.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import {
  commGraphCursorForEvent,
  nextCommGraphTimelineEvent,
  type CommGraphTimeCursor,
} from "@/lib/comm-graph/comm-graph-timeline";
import {
  commGraphCursorAtEnd,
  commGraphCursorIndex,
} from "@/lib/comm-graph/comm-graph-transport";
import {
  readCommGraphTimelineEpicState,
  useCommGraphCursor,
  useCommGraphPlaying,
  useCommGraphSpeed,
  useCommGraphTimelineStore,
} from "@/stores/epics/comm-graph-timeline-store";

/**
 * Playback is EVENT-PACED, not wall-clock-paced: replaying real inter-event
 * gaps would sit still for the minutes an agent spent thinking. One step per
 * tick, scaled by speed, keeps a long session watchable.
 */
const BASE_STEP_MS = 700;

export interface CommGraphTransport {
  /** `null` = live: the cursor tracks the newest row as rows arrive. */
  readonly cursor: CommGraphTimeCursor | null;
  readonly following: boolean;
  readonly playing: boolean;
  readonly speed: number;
  /** Cursor position as a track index; live is the LAST index, not a sentinel. */
  readonly cursorIndex: number;
  readonly togglePlay: () => void;
  readonly cycleSpeed: () => void;
  readonly followLive: () => void;
  /**
   * Seek the cursor onto a row. Detaching is a CONSEQUENCE of landing on a row
   * that is not the newest, not a separate action - which is what keeps "scrub
   * back and you are detached" and "scrub to the end and you are live" from
   * needing to agree with each other.
   */
  readonly seekToEvent: (event: CommGraphEvent) => void;
  readonly stepForward: () => void;
  readonly stepBackward: () => void;
}

export function useCommGraphTransport(
  epicId: string,
  events: ReadonlyArray<CommGraphEvent>,
): CommGraphTransport {
  const cursor = useCommGraphCursor(epicId);
  const playing = useCommGraphPlaying(epicId);
  const speed = useCommGraphSpeed(epicId);

  // The playback timer must not restart every time a live frame lands, so the
  // array it reads is reached through a ref and kept out of the effect's
  // dependencies. Only the cursor moving, the speed changing, or play/pause
  // reschedules a tick.
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const cursorIndex = useMemo(
    () => commGraphCursorIndex(events, cursor),
    [cursor, events],
  );

  const cursorKey = cursor === null ? "live" : commGraphCursorKey(cursor);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      const store = useCommGraphTimelineStore.getState();
      const current = readCommGraphTimelineEpicState(epicId).cursor;
      const next = nextCommGraphTimelineEvent(eventsRef.current, current);
      if (next === null) {
        // Caught up: playback re-attaches to live rather than parking on the
        // last row, so the graph keeps evolving instead of freezing one event
        // behind whatever the agents do next.
        store.setPlaying(epicId, false);
        store.setCursor(epicId, null);
        return;
      }
      store.setCursor(epicId, commGraphCursorForEvent(next));
    }, BASE_STEP_MS / speed);
    return () => {
      clearTimeout(timer);
    };
    // `cursorKey` is the schedule trigger: each landed step queues the next one.
  }, [cursorKey, epicId, playing, speed]);

  const followLive = useCallback(() => {
    const store = useCommGraphTimelineStore.getState();
    store.setPlaying(epicId, false);
    store.setCursor(epicId, null);
  }, [epicId]);

  const cycleSpeed = useCallback(() => {
    useCommGraphTimelineStore.getState().cycleSpeed(epicId);
  }, [epicId]);

  const seekToEvent = useCallback(
    (event: CommGraphEvent) => {
      const store = useCommGraphTimelineStore.getState();
      const next = commGraphCursorForEvent(event);
      // Landing on the newest row IS live. Setting a cursor there instead would
      // pin the playhead to the right edge and then quietly refuse to advance
      // when the next row arrived.
      if (commGraphCursorAtEnd(eventsRef.current, next)) {
        store.setCursor(epicId, null);
        return;
      }
      store.setCursor(epicId, next);
    },
    [epicId],
  );

  const stepBy = useCallback(
    (delta: number) => {
      const all = eventsRef.current;
      if (all.length === 0) return;
      const current = commGraphCursorIndex(
        all,
        readCommGraphTimelineEpicState(epicId).cursor,
      );
      const nextIndex = current + delta;
      if (nextIndex <= 0) {
        seekToEvent(all[0]);
        return;
      }
      if (nextIndex >= all.length - 1) {
        // Off the end is live, by the same rule the tick uses.
        useCommGraphTimelineStore.getState().setCursor(epicId, null);
        return;
      }
      seekToEvent(all[nextIndex]);
    },
    [epicId, seekToEvent],
  );

  const stepForward = useCallback(() => stepBy(1), [stepBy]);
  const stepBackward = useCallback(() => stepBy(-1), [stepBy]);

  const togglePlay = useCallback(() => {
    const store = useCommGraphTimelineStore.getState();
    const current = readCommGraphTimelineEpicState(epicId);
    if (current.playing) {
      store.setPlaying(epicId, false);
      return;
    }
    const all = eventsRef.current;
    // Play from live replays the session from the beginning; play while
    // detached resumes from where the cursor sits.
    if (current.cursor === null && all.length > 0) {
      store.setCursor(epicId, commGraphCursorForEvent(all[0]));
    }
    store.setPlaying(epicId, true);
  }, [epicId]);

  return {
    cursor,
    following: cursor === null,
    playing,
    speed,
    cursorIndex,
    togglePlay,
    cycleSpeed,
    followLive,
    seekToEvent,
    stepForward,
    stepBackward,
  };
}

function commGraphCursorKey(cursor: CommGraphTimeCursor): string {
  return `${cursor.timestamp}:${cursor.hostId}:${cursor.id}`;
}
