import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import { normalizeCloudEvent } from "@/lib/comm-graph/comm-graph-cloud-subscription";
import {
  compareCommGraphEvents,
  type CommGraphEvent,
  type CommGraphSnapshot,
} from "@/lib/comm-graph/comm-graph-events";
import { defineComposedView } from "@/lib/view-composition/composed-view";

/**
 * A task's communication graph as the app composes it: the viewer's cloud
 * history, and the events each team environment the task is attached to
 * recorded, which only the pool's environment arm serves to a member.
 */
export const COMM_GRAPH_COMPOSED_VIEW = defineComposedView("comm-graph", [
  {
    id: "viewer",
    kind: "stream",
    method: "host.communicationGraph.subscribe",
  },
  {
    id: "environment-arm",
    kind: "stream",
    method: "environment.communicationGraph.subscribe",
  },
]);

/** What the task's environment arms have handed over so far. */
export interface EnvironmentArmGraph {
  readonly events: readonly HostCommunicationGraphCloudFeedEvent[];
  /**
   * Every arm the task reads has handed over its history up to the head the
   * server read when it opened (or has ended). True with no arm to read.
   */
  readonly caughtUp: boolean;
}

/**
 * The snapshot with each arm event it does not already hold, by `eventId`,
 * in the graph's own order. The initial history is caught up only once the
 * viewer feed and every arm have each handed over theirs; `lastArrival` stays
 * the viewer feed's.
 */
export function withEnvironmentArmGraphEvents(
  snapshot: CommGraphSnapshot,
  arm: EnvironmentArmGraph,
): CommGraphSnapshot {
  const initialHistoryCaughtUp =
    snapshot.initialHistoryCaughtUp && arm.caughtUp;
  const added = newArmEvents(snapshot, arm.events);
  if (
    added.length === 0 &&
    initialHistoryCaughtUp === snapshot.initialHistoryCaughtUp
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    initialHistoryCaughtUp,
    events:
      added.length === 0
        ? snapshot.events
        : [...snapshot.events, ...added].sort(compareCommGraphEvents),
  };
}

function newArmEvents(
  snapshot: CommGraphSnapshot,
  arm: readonly HostCommunicationGraphCloudFeedEvent[],
): CommGraphEvent[] {
  if (arm.length === 0) return [];
  const seen = new Set(snapshot.events.map((event) => event.eventId));
  return arm
    .filter((event) => !seen.has(event.eventId))
    .map(normalizeCloudEvent);
}
