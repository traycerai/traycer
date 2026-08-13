/**
 * The canvas's view of the epic's time cursor: the as-of prefix, the agents that
 * existed by then, and what should be pulsing.
 *
 * READ-ONLY. Moving the cursor belongs to `use-comm-graph-transport`, which owns
 * the controls and the single playback tick; this hook never writes. Live mode is
 * the cursor being `null` - not a second mode with its own rendering path - which
 * is why a live graph and a replayed one cannot drift apart.
 *
 * NEWNESS IS DERIVED FROM ROW CONTENT AND THIS CURSOR, NEVER FROM FRAME KIND.
 * The stream delivers reconnect gap-fill and snapshot overflow as `event` frames
 * too, so "an event frame arrived" says nothing about whether anything just
 * happened.
 *
 * PULSES HAVE TWO SOURCES, ONE PER MODE. While detached, the pulse is the row
 * the cursor is HELD on. While live there is no held row, so the pulse is
 * ARRIVAL - and which row that is belongs to the subscription layer, which owns
 * the per-host initialization boundaries that define it
 * (`CommGraphSnapshot.lastArrival`). The projection hook only decides how long
 * it stays lit.
 *
 * ONE LIST, NO FILTERS. The density controls went with the sidebar panel and the
 * log is A2A-only, so playback steps through exactly the array this projects.
 * There is no longer a filtered view that could disagree with the graph about
 * what happened.
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
import { useCommGraphCursor } from "@/stores/epics/comm-graph-timeline-store";

/**
 * How long an arrival pulse stays lit in live mode. A held cursor pulses for as
 * long as it is held; an arrival has no such anchor, so it decays - otherwise
 * the newest row would sit lit indefinitely and read as "happening now" hours
 * after it happened.
 */
const LIVE_PULSE_MS = 1_400;

export interface CommGraphTimelineProjection {
  /** The full merged array up to the cursor - what the canvas projects. */
  readonly asOfEvents: ReadonlyArray<CommGraphEvent>;
  /**
   * Agents that exist as of the cursor. When their `agent_created` event is
   * available, they appear at that ordered cursor; historical agents without
   * one fall back to `createdAt`.
   */
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly pulse: CommGraphPulse | null;
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

  // WHAT arrived is decided by the subscription layer (it owns the per-host
  // boundaries); all that is left here is HOW LONG it stays lit. `lastArrival`
  // is sticky, so the decay is expressed as "this arrival has finished pulsing"
  // rather than by clearing the fact itself.
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

  // The as-of prefix ends exactly on the cursor row when that row exists, so
  // this is a tail check rather than another scan.
  const heldPulseEvent = useMemo(() => {
    if (cursor === null) return null;
    if (asOfEvents.length === 0) return null;
    const last = asOfEvents[asOfEvents.length - 1];
    return commGraphCursorMatchesEvent(cursor, last) ? last : null;
  }, [asOfEvents, cursor]);
  const pulseEvent = cursor === null ? arrivalPulseEvent : heldPulseEvent;
  const pulse = useMemo(
    () => commGraphPulseForEvent(pulseEvent, visibleAgentIds),
    [pulseEvent, visibleAgentIds],
  );

  return { asOfEvents, visibleAgentIds, pulse };
}
