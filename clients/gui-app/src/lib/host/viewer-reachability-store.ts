/**
 * `viewerReachability` provenance store (Architecture §7): "Per-viewer
 * reachability stays an open-time/on-demand probe... always timestamped."
 * The list must never invent ambient reachability it didn't measure, so this
 * only ever gets a fresh entry from an ACTUAL wire-level check: a tab-open
 * probe that really attempts the remote path, or an explicit manual "Check
 * now" action - never a directory/presence-derived render gate.
 *
 * A plain module-level map, not a Zustand store: My Hosts already re-renders
 * on its own ~15s poll and on directory changes, so a check recorded here
 * shows up on the next natural render without needing its own subscription
 * machinery.
 */

export interface ViewerReachabilityCheck {
  readonly result: "ok" | "failing";
  readonly checkedAtMs: number;
}

const checksByHostId = new Map<string, ViewerReachabilityCheck>();

export function getViewerReachabilityCheck(
  hostId: string,
): ViewerReachabilityCheck | null {
  return checksByHostId.get(hostId) ?? null;
}
