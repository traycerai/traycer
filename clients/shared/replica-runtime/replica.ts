/**
 * A replica owns the state of ONE plane and is the sole read model behind the
 * projections a UI consumes.
 *
 * The governing decision: the client's bounded local replica/projection runtime
 * - not any RPC subscription and not a root CRDT - is what the UI reads, with
 * class-specific sync adapters feeding it. Wire lanes are adapters BEHIND the
 * replica, never the application state model. That is what lets the wire
 * surface evolve without touching UI ownership, keeps Yjs confined to the doc
 * class, and makes freshness, eviction, and reconciliation first-class rather
 * than per-endpoint add-ons.
 *
 * A replica is React-free, DOM-free, and holds no transport. It receives
 * decoded events, decides whether each one may be applied, recomputes a
 * projection, and publishes it through a sink. Everything about "how did these
 * bytes get here" belongs to the adapter; everything about "what does the user
 * see" belongs above the sink.
 */
import type { ClassFreshness } from "./freshness";
import type { LaneCursor } from "./lane-cursor";
import type { ProjectionSink } from "./projection-sink";

/**
 * Stable identifier for one replica instance within a runtime - "this epic's
 * records", "this chat's transcript", "this epic's doc set". Scoped to the
 * runtime, not to the wire.
 */
export type PlaneId = string;

/**
 * One epic is several kinds of data, and each gets the sync semantics it
 * deserves. Using one mechanism for all of them is the mistake the whole
 * architecture is a reaction to.
 *
 * Cross-cutting rather than members of their own: control-plane facts
 * (permissions, tombstones, migration/schema epochs) are `"records"` with
 * barrier semantics on an urgent lane, and derived views (unread counts,
 * search indexes) are rebuildable projections versioned by source watermark,
 * never primary sync data.
 */
export type ReplicaDataClass =
  /** Server-arbitrated rows: snapshot + transactional deltas, per-row revisions. */
  | "records"
  /** Append-only, single-writer, windowed ranges. */
  | "log"
  /** CRDT bodies humans co-edit. Yjs lives here and nowhere else. */
  | "doc"
  /** Presence, cursors, typing. Loss is fine; replay is WRONG. */
  | "ephemera"
  /** Content-addressed transfers; their metadata rides a record plane. */
  | "blob";

/**
 * Why the entire replica is being thrown away and rebuilt.
 *
 * Every member is a case where the position space itself changed, so applying
 * the next frame as a delta would splice two unrelated histories. They share
 * one code path deliberately: the runtime has exactly one rebuild mechanism and
 * every one of these must exercise it, including the ones that look
 * routine.
 */
export type ReplicaReplacementReason =
  /** The authority reissued its epoch (compaction, replica swap). */
  | "authority-epoch-changed"
  /** The offered resume cursor can no longer be served. */
  | "resume-too-old"
  /** A major migration finished; both lanes resume from the new epoch. */
  | "migration-completed"
  /**
   * The connection came back advertising a different lane manifest - typically
   * a host that upgraded under an open tab, taking it from the legacy `@1`
   * adapter to the lane adapters.
   *
   * Every long-lived tab hits this exactly once, which makes it the single most
   * likely path to ship untested. It is a replacement, not a migration and not
   * a reconnect: epoch bump, fresh snapshot through the new adapter, same
   * machinery as any other member here.
   */
  | "manifest-changed"
  /** The session moved to a different host; nothing carries over. */
  | "host-repointed"
  /** Authorization changed under us; hydration must stop and restart. */
  | "security-epoch-changed";

/**
 * WHICH authority transition a replacement request is about.
 *
 * The reason says what KIND of thing happened; this says which occurrence. The
 * runtime coalesces on this and not on the reason, because a reason cannot
 * identify an occurrence in either direction:
 *
 * - Two lanes observing ONE epoch change can name it differently. The status
 *   lane says `"migration-completed"` when a migration was in flight and the
 *   state lane only ever says `"authority-epoch-changed"`, so a reason-keyed
 *   guard rebuilds the replica twice for the single transition that both are
 *   correctly describing.
 * - One reason covers EVERY later occurrence of its kind. The second genuine
 *   epoch change of a session carries the same string as the first, so a
 *   reason-keyed guard has to be cleared between them - and what cleared it was
 *   the first lane's own accompanying snapshot, which arrives synchronously
 *   right after the request and therefore before the other lane has reported at
 *   all. The guard was spent before it could do the one job it had.
 *
 * A token names the occurrence, so both problems go away and nothing has to be
 * cleared: two reports of one transition share a token, and a later transition
 * simply has a different one.
 *
 * The three builders below are the only way to make one. Their prefixes are
 * fixed and pairwise distinct at the first character, so no payload - an epoch
 * id containing a colon included - can make a token of one kind equal a token
 * of another.
 */
export type ReplicaTransitionToken = string;

/** The transition INTO `authorityEpoch`. */
export function authorityEpochTransition(
  authorityEpoch: string,
): ReplicaTransitionToken {
  return `authority-epoch:${authorityEpoch}`;
}

/** The transition INTO `securityEpoch`, within one authority epoch. */
export function securityEpochTransition(
  securityEpoch: number,
): ReplicaTransitionToken {
  return `security-epoch:${securityEpoch}`;
}

/**
 * A reseed forced because the offered cursor could no longer be served.
 * `watermark` distinguishes two of these within one authority epoch, which is
 * a thing that legitimately happens.
 */
export function resumeTooOldTransition(
  watermark: string,
): ReplicaTransitionToken {
  return `resume-too-old:${watermark}`;
}

/**
 * A reseed this client asked for, with nothing wrong upstream.
 *
 * Separate from {@link ReplicaReplacementReason} because every member of that
 * type is a statement about the AUTHORITY - its epoch moved, its history no
 * longer reaches back this far, it migrated. None of them is true when a user
 * hits a recovery affordance, and passing one anyway (`"resume-too-old"` is the
 * tempting one) puts a fabricated authority-side event into logs, telemetry and
 * the replay harness, where nothing downstream can tell it from a real one.
 */
export type ReplicaClientResetIntent =
  /**
   * A fresh snapshot was requested locally - the user's recovery affordance, or
   * a caller that has decided its view is not trustworthy.
   */
  "fresh-snapshot-requested";

/**
 * Why a replica is being reset, and by whom.
 *
 * ONE type with the provenance as its discriminant, rather than a second reset
 * method beside the first. Two entry points is the shape that drifts: a guard
 * added to one, telemetry added to the other, and after a while the two answers
 * to "why is this replica empty" disagree. Here there is one way in, and
 * `origin` is a field every consumer can read.
 *
 * The two arms deliberately name their payload differently (`reason` vs
 * `intent`) so neither can be passed for the other by rearranging a literal -
 * the provenance is structural, not a convention someone has to remember.
 */
export type ReplicaResetCause =
  | { readonly origin: "authority"; readonly reason: ReplicaReplacementReason }
  | { readonly origin: "client"; readonly intent: ReplicaClientResetIntent };

/**
 * Why a decoded event was NOT applied.
 *
 * Ignoring is the normal, correct outcome for a large fraction of frames on a
 * flaky link, so it is a first-class result rather than an exception. Naming
 * the reason is what makes "the client silently dropped it" a diagnosable
 * event instead of a mystery, and it is what the replay harness asserts on:
 * a replay that produces `"stale-generation"` against a live stream means the
 * generation guard is wrong, not that the frame was noise.
 */
export type ReplicaIgnoreReason =
  /** A row whose revision does not strictly exceed the held one. */
  | "stale-revision"
  /**
   * A removal is TERMINAL AND ABSORBING: no later upsert resurrects the row.
   * The one lifecycle rule the record model has.
   */
  | "absorbed-tombstone"
  /** The frame belongs to a stream generation this replica has replaced. */
  | "stale-generation"
  /**
   * Doc class: the bytes name a `docGuid` this replica does not hold, so they
   * describe a different document.
   *
   * Its own member rather than folded into `"stale-generation"`, which it
   * superficially resembles. They are different facts with different causes: a
   * stale generation means the frame came from a subscription attempt this
   * replica has replaced, while this means the frame is current but the
   * DOCUMENT was deleted and recreated underneath it. Reading one as the other
   * sends a diagnosis after the wrong thing - a reconnect loop instead of a
   * reseed - and the guid guard is what stops two histories being spliced
   * under one artifact id.
   */
  | "guid-mismatch"
  /**
   * A snapshot answer issued BEFORE something the client has since ingested.
   * The monotonic request-time fence: an omission in a slow answer may only
   * delete a row that was already held when that answer was issued.
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
  /**
   * The event proves the replica must be rebuilt. The runtime - not the
   * replica, and not the adapter - drives the replacement, so the two lanes of
   * a shared open can be sequenced against each other (a migration holds the
   * state lane's snapshot while the control lane reports progress).
   */
  | {
      readonly kind: "requires-replacement";
      readonly reason: ReplicaReplacementReason;
    };

export interface Replica<TEvent, TProjection> {
  readonly planeId: PlaneId;
  readonly dataClass: ReplicaDataClass;

  /**
   * Apply one decoded event.
   *
   * Synchronous and total: it either applies, ignores with a reason, or asks to
   * be replaced. It never throws for a well-formed event, never awaits, and
   * never touches transport - which is what makes a captured frame log
   * replayable through the real replica with no host attached.
   */
  apply(event: TEvent): ReplicaApplyOutcome;

  /**
   * Recompute and publish the projection.
   *
   * Separate from {@link apply} so a burst of events costs one projection.
   * Callers wrap a batch in `sink.transact(...)` and publish once at the end;
   * the alternative - projecting per event - is what a `setState` per
   * `observeDeep` event already costs today.
   */
  project(): void;

  /** The sink this replica publishes through. */
  readonly sink: ProjectionSink<TProjection>;

  /** Highest applied cursor, or `null` before the first snapshot. */
  watermark(): LaneCursor | null;

  /** This plane's freshness. Never blended with any other plane's. */
  freshness(): ClassFreshness;

  /**
   * Discard all state and return to the pre-snapshot condition, keeping the
   * plane's identity and its sink.
   *
   * NOT `dispose` + reconstruct: consumers hold the sink, and rebuilding it
   * would drop every subscriber. The projection published immediately after a
   * reset is the empty one, and freshness returns to `"unknown"` - a reset
   * replica must not keep asserting the watermark it no longer holds.
   *
   * The ONE reset entry point, for both authority-driven replacement and a
   * locally requested reseed. They behave identically - the replica is empty
   * either way - and differ only in what may be claimed about why, which is
   * what {@link ReplicaResetCause}'s `origin` carries.
   */
  reset(cause: ReplicaResetCause): void;

  /**
   * Terminal. Releases every budget charge and every lease this replica holds.
   * Idempotent; every method above answers `"disposed"` or its empty value
   * afterwards.
   */
  dispose(): void;
}
