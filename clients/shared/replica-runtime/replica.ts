/**
 * A replica owns the state of one plane and is the sole read model behind the projections a UI consumes.
 * The governing decision: the client's bounded local replica/projection runtime - not any RPC subscription and not a root CRDT - is what the UI reads, with class-specific sync adapters feeding it.
 */
import type { ClassFreshness } from "./freshness";
import type { LaneCursor } from "./lane-cursor";
import type { ProjectionSink } from "./projection-sink";

export type PlaneId = string;

export type ReplicaDataClass =
  /** Server-arbitrated rows: snapshot + transactional deltas, per-row revisions. */
  | "records"
  /** Append-only, single-writer, windowed ranges. */
  | "log"
  /** CRDT bodies humans co-edit. Yjs lives here and nowhere else. */
  | "doc"
  /** Presence, cursors, typing. Loss is fine; replay is wrong. */
  | "ephemera"
  /** Content-addressed transfers; their metadata rides a record plane. */
  | "blob";

  /**
   * Why the entire replica is being thrown away and rebuilt.
   * They share one code path deliberately: the runtime has exactly one rebuild mechanism and every one of these must exercise it, including the ones that look routine.
   */
export type ReplicaReplacementReason =
  /** The authority reissued its epoch (compaction, replica swap). */
  | "authority-epoch-changed"
  /** The offered resume cursor can no longer be served. */
  | "resume-too-old"
  /** A major migration finished; both lanes resume from the new epoch. */
  | "migration-completed"
  /**
   * The connection came back advertising a different lane manifest - typically a host that upgraded under an open tab, taking it from the legacy `@1` adapter to the lane adapters.
   * Every long-lived tab hits this exactly once, which makes it the single most likely path to ship untested.
   */
  | "manifest-changed"
  /** The session moved to a different host; nothing carries over. */
  | "host-repointed"
  /** Authorization changed under us; hydration must stop and restart. */
  | "security-epoch-changed";

  /**
   * Which authority transition a replacement request is about.
   * The runtime coalesces on this and not on the reason, because a reason cannot identify an occurrence in either direction: - Two lanes observing one epoch change can name it differently.
   */
export type ReplicaTransitionToken = string;

export function authorityEpochTransition(
  authorityEpoch: string,
): ReplicaTransitionToken {
  return `authority-epoch:${authorityEpoch}`;
}

export function securityEpochTransition(
  securityEpoch: number,
): ReplicaTransitionToken {
  return `security-epoch:${securityEpoch}`;
}

export function resumeTooOldTransition(
  watermark: string,
): ReplicaTransitionToken {
  return `resume-too-old:${watermark}`;
}

export type ReplicaClientResetIntent =
  /**
   * A fresh snapshot was requested locally - the user's recovery affordance, or
   * a caller that has decided its view is not trustworthy.
   */
  "fresh-snapshot-requested";

  /**
   * Why a replica is being reset, and by whom.
   * One type with the provenance as its discriminant, rather than a second reset method beside the first.
   */
export type ReplicaResetCause =
  | { readonly origin: "authority"; readonly reason: ReplicaReplacementReason }
  | { readonly origin: "client"; readonly intent: ReplicaClientResetIntent };

  /**
   * Why a decoded event was not applied.
   * Ignoring is the normal, correct outcome for a large fraction of frames on a flaky link, so it is a first-class result rather than an exception.
   */
export type ReplicaIgnoreReason =
  /** A row whose revision does not strictly exceed the held one. */
  | "stale-revision"
  /**
   * A removal is terminal AND absorbing: no later upsert resurrects the row.
   * The one lifecycle rule the record model has.
   */
  | "absorbed-tombstone"
  /** The frame belongs to a stream generation this replica has replaced. */
  | "stale-generation"
  /**
   * Doc class: the bytes name a `docGuid` this replica does not hold, so they describe a different document.
   * Its own member rather than folded into `"stale-generation"`, which it superficially resembles.
   */
  | "guid-mismatch"
  /**
   * A snapshot answer issued before something the client has since ingested.
   * The monotonic request-time fence: an omission in a slow answer may only delete a row that was already held when that answer was issued.
   */
  | "before-fence"
  /** Same cursor already applied. */
  | "duplicate"
  /** The cursor's epoch is not this replica's; caller must replace instead. */
  | "epoch-mismatch"
  /** The replica has been disposed. */
  | "disposed";

export type ReplicaApplyOutcome =
  | {
      readonly kind: "applied";
      /** The replica's watermark after this event, or `null` for uncursored classes. */
      readonly cursor: LaneCursor | null;
    }
  | { readonly kind: "ignored"; readonly reason: ReplicaIgnoreReason }
  /** The event proves the replica must be rebuilt. */
  | {
      readonly kind: "requires-replacement";
      readonly reason: ReplicaReplacementReason;
    };

export interface Replica<TEvent, TProjection> {
  readonly planeId: PlaneId;
  readonly dataClass: ReplicaDataClass;

  /**
   * Apply one decoded event.
   * It never throws for a well-formed event, never awaits, and never touches transport - which is what makes a captured frame log replayable through the real replica with no host attached.
   */
  apply(event: TEvent): ReplicaApplyOutcome;

  /** Recompute and publish the projection. */
  project(): void;

  /** The sink this replica publishes through. */
  readonly sink: ProjectionSink<TProjection>;

  /** Highest applied cursor, or `null` before the first snapshot. */
  watermark(): LaneCursor | null;

  /** This plane's freshness. Never blended with any other plane's. */
  freshness(): ClassFreshness;

  /**
   * Discard all state and return to the pre-snapshot condition, keeping the plane's identity and its sink.
   * Not `dispose` + reconstruct: consumers hold the sink, and rebuilding it would drop every subscriber.
   */
  reset(cause: ReplicaResetCause): void;

  /**
   * Terminal.
   * Idempotent; every method above answers `"disposed"` or its empty value afterwards.
   */
  dispose(): void;
}
