/**
 * Client-side shape of the per-epic communication event log.
 *
 * The wire event (`EpicCommunicationGraphEvent`) is deliberately flat, with
 * nullable per-kind fields mirroring the host's SQLite row 1:1; the client
 * narrows on `kind` itself. The only thing added here is `hostId`, because a
 * multi-host epic merges several disjoint per-host logs into ONE array and the
 * row `id` is monotonic PER HOST - two hosts routinely hand out the same id for
 * unrelated events, so `id` alone is not an identity and must never be compared
 * across hosts.
 */
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

/**
 * The direction a reader should see and the canvas pulse should travel.
 *
 * Message rows are deliveries from sender to receiver, and created rows point
 * the same way (creator → the agent it spawned). Notice rows are broker
 * feedback about an unanswered request, delivered back to the sender that is
 * awaiting the reply, so their visible direction is the reverse of the raw log
 * ownership fields.
 */
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
 * Per-host subscription state, surfaced on the canvas so a degraded host is
 * visible rather than silently contributing nothing:
 *
 * - `connecting` / `live` / `reconnecting` - the normal socket lifecycle.
 * - `unsupported` - the host predates `epic.communicationGraph.subscribe`
 *   (an optional stream method). Its agents render a "no edge data"
 *   affordance; every other host in the epic keeps streaming.
 * - `unreachable` - the host has no dialable endpoint, or the subscription
 *   died. Its agents badge muted.
 * - `failed` - BUILDING the transport threw, so there is no socket to have a
 *   lifecycle at all. Distinct from `unreachable` (a socket that cannot reach
 *   its host) and from `reconnecting` (a socket retrying on its own backoff):
 *   nothing is retrying here except this client's own bounded redial, and once
 *   that is exhausted the host stays failed until something reconciles it. Kept
 *   separate precisely so "we could not even construct the transport" is not
 *   reported as "the host is away".
 */
export type CommGraphHostStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unsupported"
  | "unreachable"
  | "failed";

/**
 * A host's INITIALIZATION LINE: where its own log stood when its snapshot was
 * handed off.
 *
 * This is what makes "did something just happen?" answerable without reading a
 * clock or trusting a frame kind. Everything at or below a host's boundary is
 * history this client is merely learning; everything above it is a row that
 * appeared after we were caught up on that host.
 *
 * It MUST be per host. Hosts initialize independently and at wildly different
 * times - a second host added to the epic hands over its whole history long
 * after the first went live - so a single global boundary would read that
 * history as activity (if the second host's rows sort newer) or would never
 * initialize at all (if the first host's snapshot was empty).
 */
export interface CommGraphHostSnapshotBoundary {
  /**
   * The host log's head id at handoff (the snapshot frame's `headId`), or
   * `null` when the log was EMPTY. Deliberately NOT the snapshot's own last
   * row: the snapshot is bounded, so backlog past its bound arrives as
   * `event` frames, and only the head keeps that overflow classed as
   * history.
   *
   * An empty-log boundary is a real boundary, not a missing one: a fresh
   * epic legitimately has no history, and the very next row it produces is
   * genuinely new. That is exactly why this is a distinct nullable INSIDE
   * the boundary - "initialized with nothing" and "not initialized yet"
   * would otherwise collapse onto the same `null`.
   */
  readonly highestId: number | null;
}

export interface CommGraphHostState {
  readonly hostId: string;
  readonly status: CommGraphHostStatus;
  /** Highest event id applied for this host; the resume `sinceCursor`. */
  readonly cursor: number | null;
  /**
   * `null` until this host's snapshot has been applied - before that handoff
   * nothing from it can be classed as an arrival, because we do not yet know
   * what its history was. Set exactly ONCE per subscription entry: a reconnect
   * gap snapshot carries rows that appeared while we were away, and those are
   * arrivals, not history.
   */
  readonly snapshotBoundary: CommGraphHostSnapshotBoundary | null;
}

export interface CommGraphSnapshot {
  /**
   * Every captured event across every subscribed host, ordered by timestamp.
   *
   * RAW AND UNCOLLAPSED. Two rows that look alike are two rows: the log is an
   * append-only record of what the host observed, and nothing here may collapse
   * one - see `mergeCommGraphEvents`.
   */
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly hosts: ReadonlyArray<CommGraphHostState>;
  /**
   * The newest row seen above its OWN host's snapshot boundary, or `null` while
   * every host is still only handing over history.
   *
   * A FACT ABOUT THE LOG, not a UI state: it is sticky (never expires here) and
   * says nothing about how long anything should be animated. The timeline turns
   * it into a decaying pulse; anything else that wants "what just happened"
   * reads the same value.
   *
   * Derived here rather than in the consumer because the boundary that defines
   * it is per host and lives here - a consumer holding only the merged array
   * would have to re-derive per-host state it does not own, and comparing rows
   * across hosts (whose ids are independent) is exactly the mistake this avoids.
   */
  readonly lastArrival: CommGraphEvent | null;
}

export const EMPTY_COMM_GRAPH_SNAPSHOT: CommGraphSnapshot = {
  events: [],
  hosts: [],
  lastArrival: null,
};

/**
 * Merge per-host event arrays (each already ordered by its own host's
 * monotonic `id`) into one timestamp-ordered array.
 *
 * NO DEDUP OF ANY KIND. This is a requirement, not an oversight:
 *
 * - Across hosts there is nothing to dedup: A2A is host-local (cross-host sends
 *   are rejected at the broker), so the per-host sets are disjoint.
 * - Within a host, two rows that resemble each other are two observations the
 *   host actually recorded. Collapsing by timestamp or content would discard
 *   evidence and break the timeline's no-coalescing invariant. If you are here
 *   to "fix" duplicate rows: don't.
 *
 * Ordering is stable and total: timestamp, then hostId, then the host's row id.
 * The hostId tiebreak only ever separates events from DIFFERENT hosts, which
 * are causally unrelated by construction (both ends of a conversation live on
 * one host), so it cannot misorder a conversation - it just keeps the sort
 * deterministic under cross-host clock skew.
 */
export function mergeCommGraphEvents(
  byHost: ReadonlyArray<ReadonlyArray<CommGraphEvent>>,
): ReadonlyArray<CommGraphEvent> {
  // Always a fresh array, never one of the inputs: the caller keeps mutating
  // its per-host arrays, and aliasing one of them here would let a later push
  // land in the merged result twice.
  const merged = byHost.flat();
  merged.sort(compareCommGraphEvents);
  return merged;
}

/**
 * The array's total order, as a standalone key so a TIME CURSOR can be compared
 * against rows without being one. The timeline's cursor is exactly this triple
 * (see `comm-graph-timeline.ts`) - keeping one comparator is what guarantees
 * "everything at or before the cursor" and "the display order" can never
 * disagree.
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
