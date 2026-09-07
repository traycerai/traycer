/**
 * The one cursor model.
 * Per-lane cursors buy no less referential integrity, because a transactional envelope - not a shared position - is what makes a multi-row change atomic.
 */

export type LaneId = string;

export interface LaneCursor {
  /**
   * The serving host's replica identity for this epic.
   * Changes on replica replacement, compaction, and major migration - the three events after which an old `position` names nothing.
   */
  readonly authorityEpoch: string;
  readonly lane: LaneId;
  /**
   * Monotonic within one `(lane, authorityEpoch)` pair and meaningless across epochs.
   * It must survive a host restart - a process-local counter would let a resume offer name a position the host has since reused.
   */
  readonly position: number;
}

/**
 * The result of ordering two cursors.
 * Callers must switch on all four members.
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

export function advancesLaneCursor(
  held: LaneCursor | null,
  next: LaneCursor,
): boolean {
  if (held === null) return true;
  return compareLaneCursors(held, next) === "before";
}

/**
 * What a client offers when (re)opening a lane, or `null` for "I have nothing, send me a snapshot".
 * `null` is a first-class answer, not a missing value: a first open on a host has no seed, and a client that has just been told `resume-too-old` has nothing valid to offer either.
 */
export type ResumeOffer = CursorResumeOffer | DocSeedResumeOffer | null;

export interface CursorResumeOffer {
  readonly kind: "cursor";
  readonly cursor: LaneCursor;
}

export interface DocSeedResumeOffer {
  readonly kind: "doc-seed";
  /** The epic replica generation this attach is made under. */
  readonly authorityEpoch: string;
  readonly knownDocGuid: string;
  readonly stateVectorBase64: string;
}

/**
 * What the host did with a {@link ResumeOffer}.
 * `resume-too-old` is explicit by contract - a client offering a cursor the host can no longer serve gets a fresh snapshot frame, never an error and never silence.
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
   * An explicit reference tying changes on two or more lanes into one atomic unit.
   * Cross-lane atomicity is exceptional and must be named.
   */
export interface BarrierRef {
  readonly barrierId: string;
  /** Every lane participating. A one-lane barrier is a modelling error. */
  readonly lanes: readonly LaneId[];
}
