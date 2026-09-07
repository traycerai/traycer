/**
 * Moving the cursor belongs to `use-comm-graph-transport`, which owns the controls and the single playback tick; this hook never writes.
 * Live mode is the cursor being `null` - not a second mode with its own rendering path - which is why a live graph and a replayed one cannot drift apart.
 */
import { useEffect, useMemo, useState } from "react";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import {
  commGraphAgentIdsAsOfCursor,
  commGraphCreationCursorByAgentId,
  commGraphCursorMatchesEvent,
  commGraphEventKey,
  commGraphEventsAsOfCursor,
  commGraphPulseForEvent,
  type CommGraphPulse,
} from "@/lib/comm-graph/comm-graph-timeline";
import {
  useCommGraphCursor,
  useCommGraphPlaying,
} from "@/stores/epics/comm-graph-timeline-store";

/**
 * Playback pulses are anchored to each moving cursor step; an arrival has no such anchor, so it decays - otherwise the newest row would sit lit indefinitely and read as "happening now" hours after it happened.
 */
const LIVE_PULSE_MS = 1_400;

export interface CommGraphTimelineProjection {
  /** The full merged array up to the cursor - what the canvas projects. */
  readonly asOfEvents: ReadonlyArray<CommGraphEvent>;
  /**
   * When their `agent_created` event is available, they appear at that ordered cursor; historical agents without one fall back to `createdAt`.
   */
  readonly visibleAgentIds: ReadonlySet<string>;
  /** Drives playback-only canvas behavior; live and paused are both false. */
  readonly playing: boolean;
  readonly pulse: CommGraphPulse | null;
  /**
   * A renderer that spawns something per event - the office floor's envelopes - cannot tell those apart without the row's own key, so it is carried alongside rather than recovered by comparing pulses.
   */
  readonly pulseEventKey: string | null;
}

/** Tile-side derivations: the graph as of the panel's cursor, plus its pulse. */
export function useCommGraphTimelineProjection(
  epicId: string,
  events: ReadonlyArray<CommGraphEvent>,
  agents: ReadonlyArray<CommGraphAgentNode>,
  /**
   * Newest row above its own host's snapshot boundary, from the subscription
   * layer. Sticky there; decayed into a transient pulse here.
   */
  lastArrival: CommGraphEvent | null,
): CommGraphTimelineProjection {
  const cursor = useCommGraphCursor(epicId);
  const playing = useCommGraphPlaying(epicId);

  const asOfEvents = useMemo(
    () => commGraphEventsAsOfCursor(events, cursor),
    [cursor, events],
  );
  const creationCursorByAgentId = useMemo(
    () => commGraphCreationCursorByAgentId(events),
    [events],
  );
  const visibleAgentIds = useMemo(
    () => commGraphAgentIdsAsOfCursor(agents, cursor, creationCursorByAgentId),
    [agents, creationCursorByAgentId, cursor],
  );

  // `lastArrival` is sticky, so the decay is expressed as "this arrival has finished pulsing" rather than by clearing the fact itself.
  const [expiredArrivalKey, setExpiredArrivalKey] = useState<string | null>(
    null,
  );
  const arrivalKey =
    lastArrival === null ? null : commGraphEventKey(lastArrival);
  useEffect(() => {
    if (arrivalKey === null) return;
    const timer = setTimeout(
      () => setExpiredArrivalKey(arrivalKey),
      LIVE_PULSE_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [arrivalKey]);
  const arrivalPulseEvent =
    arrivalKey !== null && arrivalKey !== expiredArrivalKey
      ? lastArrival
      : null;

  // The as-of prefix ends exactly on the cursor row when that row exists, so this is a tail check rather than another scan.
  // A paused media transport freezes both progression and animation; retaining the held row only keeps the graph's as-of projection in place.
  const heldPulseEvent = (() => {
    if (cursor === null || !playing || asOfEvents.length === 0) return null;
    const last = asOfEvents[asOfEvents.length - 1];
    return commGraphCursorMatchesEvent(cursor, last) ? last : null;
  })();
  const pulseEvent = cursor === null ? arrivalPulseEvent : heldPulseEvent;
  const pulse = useMemo(
    () => commGraphPulseForEvent(pulseEvent, visibleAgentIds),
    [pulseEvent, visibleAgentIds],
  );

  // Keyed off the row the pulse was resolved FROM, not off the pulse: a row that resolves to no pulse (both endpoints still invisible) must not leave a key pointing at something the canvas is not showing.
  const pulseEventKey =
    pulse === null || pulseEvent === null
      ? null
      : commGraphEventKey(pulseEvent);

  return { asOfEvents, visibleAgentIds, playing, pulse, pulseEventKey };
}
