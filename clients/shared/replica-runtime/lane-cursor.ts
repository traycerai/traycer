/**
 * The one cursor model. Every durable lane in the runtime is addressed by
 * `(authorityEpoch, lane, position)` and nothing addresses itself any other
 * way.
 *
 * The alternative the architecture rejected was a single per-epic total-order
 * cursor: it is only honest with one sequencer, which conflicts with per-host
 * commit authority plus edge writes, and it couples unrelated churn into one
 * hotspot. Per-lane cursors buy no less referential integrity, because a
 * transactional envelope - not a shared position - is what makes a multi-row
 * change atomic.
 *
 * The log classes are NOT a second coordinate system. `chat.subscribe`'s
 * `(transcriptEpoch, ordinal)` is this cursor with `transcriptEpoch` in
 * `authorityEpoch` and `ordinal` in `position`; naming it twice is how the
 * two planes' resume logic drifted apart in the first place.
 */

/**
 * Which lane a cursor addresses.
 *
 * A plain string rather than a union of wire method names on purpose: the
 * runtime must be able to carry a lane it does not have a protocol definition
 * for (a legacy adapter's synthesised lane, a lane a newer host advertises),
 * and the adapter that mints the id is the only component that needs to know
 * what it means. The wire-facing names are owned by `@traycer/protocol`; this
 * type is the client-side key those names are carried under.
 */
export type LaneId = string;

export interface LaneCursor {
  /**
   * The serving host's replica identity for this epic. Changes on replica
   * replacement, compaction, and major migration - the three events after
   * which an old `position` names nothing. A change is never a gap to be
   * filled; it means the position space itself was replaced, so the only
   * correct response is a fresh snapshot. See `ReplicaReplacementReason`.
   *
   * An OPAQUE string, never a counter, matching the wire contract: a host may
   * derive it from a room id, a generation stamp, or a uuid, and a client that
   * ordered two epochs would be asserting a total order no contract defines.
   * **The only legal comparison is equality** - which is why
   * {@link compareLaneCursors} answers `"incomparable"` rather than ordering
   * two epochs, and why nothing here ever increments one.
   *
   * The empty string is not a valid epoch. "No epoch" is expressed by a `null`
   * cursor; an empty one would compare equal to another empty one and silently
   * license a resume across a replica replacement.
   */
  readonly authorityEpoch: string;
  readonly lane: LaneId;
  /**
   * Monotonic WITHIN one `(lane, authorityEpoch)` pair and meaningless across
   * epochs. It must survive a host restart - a process-local counter would let
   * a resume offer name a position the host has since reused.
   *
   * The restart promise is monotonicity plus an explicit `resume-too-old`,
   * nothing more: a resume across a restart may legally degrade to a fresh
   * snapshot, because serving deltas across a restart would require a
   * persisted record-change journal that the lane contracts deliberately do
   * not promise.
   */
  readonly position: number;
}

/**
 * The result of ordering two cursors.
 *
 * `"incomparable"` is the member that matters and the reason this is not a
 * `number`. Two cursors from different epochs (or different lanes) have no
 * order at all, and a comparator that folded that into `-1`/`0`/`1` would let
 * a caller "resume" across an epoch bump by arithmetic - the exact splice the
 * epoch exists to prevent. Callers must switch on all four members.
 */
export type CursorComparison = "before" | "same" | "after" | "incomparable";

export function compareLaneCursors(
  left: LaneCursor,
  right: LaneCursor,
): CursorComparison {
  if (left.lane !== right.lane) return "incomparable";
  if (left.authorityEpoch !== right.authorityEpoch) return "incomparable";
  if (left.position < right.position) return "before";
  if (left.position > right.position) return "after";
  return "same";
}

/**
 * Whether `next` is the legitimate successor state of `held`.
 *
 * `held === null` (nothing applied yet) accepts anything - that is the first
 * frame of a fresh subscription. A same-epoch cursor at or behind the held
 * position is a replay, a reorder, or a duplicate, and dropping it is what
 * makes those harmless with no merge logic anywhere. A DIFFERENT epoch answers
 * `false` here as well, and deliberately so: an epoch change is not an advance,
 * it is a replacement, and the caller must route it through
 * `Replica.replace` rather than applying it as the next delta.
 */
export function advancesLaneCursor(
  held: LaneCursor | null,
  next: LaneCursor,
): boolean {
  if (held === null) return true;
  return compareLaneCursors(held, next) === "before";
}

/**
 * The cursor a client offers when (re)opening a lane, or `null` for "I have
 * nothing, send me a snapshot".
 *
 * `null` is a first-class answer, not a missing value: a first open on a host
 * has no seed, and a client that has just been told `resume-too-old` has
 * nothing valid to offer either.
 */
export type ResumeOffer = LaneCursor | null;

/**
 * What the host did with a {@link ResumeOffer}.
 *
 * `resume-too-old` is explicit by contract - a client offering a cursor the
 * host can no longer serve gets a fresh snapshot frame, never an error and
 * never silence. Modelling it as an outcome rather than as an error keeps the
 * degrade on the success path, where the runtime already knows how to rebuild.
 */
export type ResumeOutcome =
  | { readonly kind: "resumed"; readonly from: LaneCursor }
  | {
      readonly kind: "reseeded";
      readonly reason: ReseedReason;
      readonly watermark: LaneCursor;
    };

export type ReseedReason =
  /** The client offered nothing (first open, or post-reseed). */
  | "no-offer"
  /** The host cannot serve from the offered position any more. */
  | "resume-too-old"
  /** The offer named an epoch the host has replaced. */
  | "epoch-changed";

/**
 * An explicit reference tying changes on two or more lanes into one atomic
 * unit.
 *
 * Cross-lane atomicity is exceptional and must be NAMED. Inferring it from
 * coincident positions is the failure this type exists to prevent: two lanes'
 * positions have no relationship whatsoever, so "these arrived together" is a
 * statement about scheduling, not about the data.
 *
 * Within a single lane no barrier is needed - a transactional envelope already
 * carries every affected row and tombstone together.
 */
export interface BarrierRef {
  readonly barrierId: string;
  /** Every lane participating. A one-lane barrier is a modelling error. */
  readonly lanes: readonly LaneId[];
}
