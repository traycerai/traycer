/** Client-side shape of the per-epic communication event log. */
import type { EpicCommunicationGraphEvent } from "@traycer/protocol/host/epic/communication-graph";

export type CommGraphEvent = EpicCommunicationGraphEvent & {
  /** Host whose log this row came from. Scopes `id` (and `sinceCursor`). */
  readonly hostId: string;
  /** Canonical cloud identity. Absent only on the host-local plane. */
  readonly eventId?: string;
  /** Cloud ingestion order. Timeline order remains capture time/origin/id. */
  readonly ingestVersion?: number;
  /** Backlog rows render normally but never drive a live arrival pulse. */
  readonly historicalUpload?: boolean;
};

export interface CommGraphEventDirection {
  readonly fromAgentId: string | null;
  readonly toAgentId: string | null;
}

/** The direction a reader should see and the canvas pulse should travel. */
export function commGraphEventDirection(
  event: CommGraphEvent,
): CommGraphEventDirection {
  if (event.kind === "a2a_notice") {
    return {
      fromAgentId: event.receiverAgentId,
      toAgentId: event.senderAgentId,
    };
  }
  return {
    fromAgentId: event.senderAgentId,
    toAgentId: event.receiverAgentId,
  };
}

/**
 * Per-host subscription state, surfaced on the canvas so a degraded host is visible rather than silently contributing nothing:
 */
export type CommGraphHostStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unsupported"
  | "unreachable"
  | "failed";

/** A host's INITIALIZATION LINE: where its own log stood when its snapshot was handed off. */
export interface CommGraphHostSnapshotBoundary {
  /**
   * The host log's head id at handoff (the snapshot frame's `headId`), or `null` when the log was EMPTY.
   * Deliberately NOT the snapshot's own last row: the snapshot is bounded, so backlog past its bound arrives as `event` frames, and only the head keeps that overflow classed as history.
   */
  readonly highestId: number | null;
}

export interface CommGraphHostState {
  readonly hostId: string;
  readonly status: CommGraphHostStatus;
  /** Highest event id applied for this host; the resume `sinceCursor`. */
  readonly cursor: number | null;
  /**
   * `null` until this host's snapshot has been applied - before that handoff nothing from it can be classed as an arrival, because we do not yet know what its history was.
   * Set exactly ONCE per subscription entry: a reconnect gap snapshot carries rows that appeared while we were away, and those are arrivals, not history.
   */
  readonly snapshotBoundary: CommGraphHostSnapshotBoundary | null;
}

export interface CommGraphSnapshot {
  /** Every captured event across every subscribed host, ordered by timestamp. */
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly hosts: ReadonlyArray<CommGraphHostState>;
  /** Every initial history source has accounted for its bounded backlog. */
  readonly initialHistoryCaughtUp: boolean;
  /**
   * The newest row seen above its OWN host's snapshot boundary, or `null` while every host is still only handing over history.
   */
  readonly lastArrival: CommGraphEvent | null;
}

export const EMPTY_COMM_GRAPH_SNAPSHOT: CommGraphSnapshot = {
  events: [],
  hosts: [],
  initialHistoryCaughtUp: false,
  lastArrival: null,
};

/**
 * Merge per-host event arrays (each already ordered by its own host's monotonic `id`) into one timestamp-ordered array.
 */
export function mergeCommGraphEvents(
  byHost: ReadonlyArray<ReadonlyArray<CommGraphEvent>>,
): ReadonlyArray<CommGraphEvent> {
  // Always a fresh array, never one of the inputs: the caller keeps mutating its per-host arrays, and aliasing one of them here would let a later push land in the merged result twice.
  const merged = byHost.flat();
  merged.sort(compareCommGraphEvents);
  return merged;
}

/**
 * The array's total order, as a standalone key so a TIME CURSOR can be compared against rows without being one.
 * The timeline's cursor is exactly this triple (see `comm-graph-timeline.ts`) - keeping one comparator is what guarantees "everything at or before the cursor" and "the display order" can never disagree.
 */
export interface CommGraphSortKey {
  readonly timestamp: number;
  readonly hostId: string;
  readonly id: number;
  /** Present for cloud rows, whose origin sequence can legally be reused. */
  readonly eventId?: string;
}

export function compareCommGraphSortKeys(
  a: CommGraphSortKey,
  b: CommGraphSortKey,
): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.hostId !== b.hostId) return a.hostId < b.hostId ? -1 : 1;
  if (a.id !== b.id) return a.id - b.id;
  const aEventId = a.eventId ?? "";
  const bEventId = b.eventId ?? "";
  if (aEventId === bEventId) return 0;
  return aEventId < bEventId ? -1 : 1;
}

export function compareCommGraphEvents(
  a: CommGraphEvent,
  b: CommGraphEvent,
): number {
  return compareCommGraphSortKeys(a, b);
}
