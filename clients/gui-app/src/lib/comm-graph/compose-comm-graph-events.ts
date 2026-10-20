import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import { normalizeCloudEvent } from "@/lib/comm-graph/comm-graph-cloud-subscription";
import {
  compareCommGraphEvents,
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

/**
 * The snapshot with each arm event it does not already hold, by `eventId`,
 * in the graph's own order. Only the rows move: the arm's history accounting
 * is its own, so `initialHistoryCaughtUp` and `lastArrival` stay the viewer
 * feed's.
 */
export function withEnvironmentArmGraphEvents(
  snapshot: CommGraphSnapshot,
  arm: readonly HostCommunicationGraphCloudFeedEvent[],
): CommGraphSnapshot {
  if (arm.length === 0) return snapshot;
  const seen = new Set(snapshot.events.map((event) => event.eventId));
  const added = arm
    .filter((event) => !seen.has(event.eventId))
    .map(normalizeCloudEvent);
  if (added.length === 0) return snapshot;
  return {
    ...snapshot,
    events: [...snapshot.events, ...added].sort(compareCommGraphEvents),
  };
}
