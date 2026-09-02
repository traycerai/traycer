/**
 * Cursor, epoch and frame primitives shared by the epic sync LANES -
 * `epic.state.subscribe`, `epic.status.subscribe` and `artifact.subscribe`.
 *
 * These three methods replace the monolithic `epic.subscribe` with one lane per
 * data CLASS (server-arbitrated records, session control, co-edited bodies).
 * Each lane versions on its own `{ major, minor }` line forever; what they must
 * NOT do is grow three spellings of the same ordering vocabulary, which is why
 * the cursor primitives live here rather than beside any one lane.
 *
 * ## The cursor is `(authorityEpoch, lane, position)`
 *
 * `lane` is NOT a wire field. It is the METHOD: each lane is its own cursor
 * domain, so a position from `epic.state.subscribe` is meaningless to
 * `epic.status.subscribe` and there is nothing on the wire that could tempt a
 * consumer to compare them. Encoding the lane as a field would invite exactly
 * that comparison and buy nothing - the client already knows which subscription
 * a frame arrived on.
 *
 * `position` is monotonic WITHIN an epoch and totally ordered within a lane.
 * Cross-lane atomicity is deliberately inexpressible here: two lanes' positions
 * are incomparable, and a consumer must never infer that coincident positions
 * mean coincident commits (north-star: "Cross-lane atomicity is exceptional and
 * expressed via an explicit barrier/transaction reference - never inferred from
 * coincident positions").
 *
 * ## What the epoch is, and what changes it
 *
 * `authorityEpoch` names the serving host's REPLICA IDENTITY for one epic. It
 * changes on replica replacement, compaction, and major migration - the three
 * events after which an old `position` names nothing. It is deliberately an
 * OPAQUE string rather than a counter: the host is free to derive it from a
 * room id, a generation stamp, or a uuid, and a client that tried to order two
 * epochs would be asserting a total order the contract does not define. The
 * only legal comparison is EQUALITY.
 *
 * A client observing an epoch it did not open with must discard everything it
 * holds for that epic - rows, tombstones and per-artifact body state alike -
 * and re-seed from the fresh snapshot that follows. This is also how a
 * mid-session LEGACY -> LANES transition is expressed: a host that upgrades
 * under an open tab reconnects advertising the lanes, and the runtime treats
 * that as an ordinary replica replacement rather than a special case (wire-lane
 * contracts, "Mid-session legacy->lanes transition is a named event"). Every
 * long-lived tab hits it exactly once, so it must ride the same machinery as
 * any other epoch bump, not a path of its own.
 *
 * ## The restart promise, scoped honestly
 *
 * `position` must survive host restart - it is never a process-local counter.
 * What that buys is MONOTONICITY plus a truthful `resume-too-old`, and nothing
 * more: a resume across a restart may legally degrade to a fresh snapshot.
 * Serving DELTAS across a restart would require a persisted record-change
 * journal, which these contracts deliberately do not promise. A client must
 * therefore never treat a post-restart snapshot as an error.
 *
 * Allowed dependencies: `zod` only - this file must stay browser-safe and free
 * of lane-specific vocabulary.
 */
import { z } from "zod";

/**
 * Opaque replica identity for one epic on one serving host.
 *
 * `min(1)` so "no epoch" is unrepresentable: an empty epoch would compare equal
 * to another empty epoch and silently license a resume across a replica
 * replacement, which is the one thing the field exists to prevent.
 */
export const epicLaneAuthorityEpochSchema = z.string().min(1);
export type EpicLaneAuthorityEpoch = z.infer<
  typeof epicLaneAuthorityEpochSchema
>;

/**
 * Position within a lane's epoch. Monotonic, host-durable, and comparable ONLY
 * against another position carrying the same `authorityEpoch`.
 *
 * Non-negative rather than positive so a lane that has committed nothing yet
 * has a representable high-water mark (`0`) instead of forcing a nullable -
 * "the lane is empty" and "the lane has no cursor" are the same fact here, and
 * one representation is better than two.
 */
export const epicLanePositionSchema = z.number().int().nonnegative();
export type EpicLanePosition = z.infer<typeof epicLanePositionSchema>;

/**
 * A resume point on one lane: the epoch it belongs to, and the position within
 * it the client has already applied.
 *
 * The two fields travel as ONE object rather than as sibling request keys
 * because neither is meaningful alone, and the failure mode of the loose form
 * is silent: a position without its epoch is a number the host would have to
 * interpret against whatever replica it happens to hold now, which is precisely
 * the "state vector without its provenance" hazard that forced
 * `epicSubscribeClientSeedOfferSchema` into a nested shape at `epic.subscribe@1.2`.
 * Nesting makes "both or neither" STRUCTURAL, so there is no cross-field
 * runtime check for a later reader to overlook.
 */
export const epicLaneCursorSchema = z.object({
  authorityEpoch: epicLaneAuthorityEpochSchema,
  position: epicLanePositionSchema,
});
export type EpicLaneCursor = z.infer<typeof epicLaneCursorSchema>;

/**
 * A ROW's revision - the per-entity staleness test, and a different number from
 * {@link epicLanePositionSchema} in every respect that matters.
 *
 * `position` / `seq` is TRANSACTION ORDER: where a commit sits in the lane.
 * `revision` is ENTITY ORDER: how many times this particular row has changed.
 * A single envelope at one `seq` carries rows at many different revisions, so a
 * consumer must never synthesize one from the other. Deriving a revision from
 * `seq` would give every row touched by one commit the same value and make two
 * unrelated rows falsely comparable - which is exactly the reconciliation bug
 * the guard exists to prevent.
 *
 * ## Where the number comes from
 *
 * Minted by the SERVING HOST'S REPLICA, per entity, and bumped on every change
 * the host commits to that entity. It is persisted WITH the replica, so it
 * survives a host restart within an `authorityEpoch` - a revision that reset on
 * restart would let a post-restart push lose to a pre-restart row the client
 * still holds. It is never derived from frame arrival order, from a wall clock
 * (`updatedAt` is display metadata that no ordering decision may read), or from
 * the lane position.
 *
 * Comparable only against another revision for the SAME entity under the SAME
 * `authorityEpoch`. Across an epoch change every revision is void along with
 * the rest of the replica's identity.
 *
 * ## The two rules a consumer applies
 *
 * 1. **Revision guard on upserts.** Apply an upsert only when its revision
 *    STRICTLY EXCEEDS the one held for that row. This is what makes a slow
 *    answer - a cold unary read that lost a race to a push - unable to regress
 *    newer state, and what makes replayed or reordered deliveries harmless
 *    without any merge logic.
 * 2. **Tombstones are ABSORBING, not merely ordered.** A removal is terminal
 *    against later upserts *regardless of their revision*: once a client has
 *    seen a row removed, no upsert resurrects it, even one carrying a higher
 *    number. The revision on a removal therefore does NOT gate whether it
 *    applies - a tombstone whose revision is LOWER than an upsert the client
 *    already applied still absorbs. What the revision is for is the
 *    reconciler's retraction memory: it records WHEN in the entity's history
 *    the removal happened, so removals can be ordered against each other and a
 *    resurrect-then-delete sequence is not mistaken for a delete-then-resurrect
 *    one.
 *
 * Rule 2 is stated this explicitly because the natural reading of rule 1 -
 * "higher revision wins" - gets it backwards, and getting it backwards
 * resurrects deleted artifacts on exactly the flaky links this design is for.
 */
export const epicLaneRowRevisionSchema = z.number().int().nonnegative();
export type EpicLaneRowRevision = z.infer<typeof epicLaneRowRevisionSchema>;

/**
 * The revision field, spread into every row and every removal on the records
 * lane so a single definition covers all of them.
 *
 * On a REMOVAL as well as an upsert, deliberately. The client seam's
 * `RecordChange` requires one on both arms, and a removal without a revision
 * cannot be placed in its entity's history at all - see rule 2 above for why
 * carrying it is not the same as gating on it.
 */
export const epicLaneRowRevisionFields = {
  revision: epicLaneRowRevisionSchema,
} as const;

/**
 * The epoch stamp every non-`pong` lane frame carries.
 *
 * Spread rather than referenced as a nested object so the epoch reads as a
 * top-level frame field - the same shape `epic.subscribe@2.0` used for
 * `streamEpoch`, and for the same reason: a consumer's first test on any frame
 * is "is this from the replica I am attached to", and burying that behind a
 * wrapper makes the cheapest check the most awkward one to write.
 *
 * Note the semantic difference from `@2`'s `streamEpoch`, which named the
 * RESOLVER and therefore changed whenever the resolver was rebuilt. This names
 * the REPLICA. A resolver rebuild that does not replace the replica keeps the
 * same epoch and its frames stay valid - clients discard on authority identity,
 * never on resolver identity.
 *
 * `pong` is the sole exception on every lane: heartbeats are intercepted by the
 * shared connection handler before a resolver is selected, so no resolver
 * exists to stamp them.
 */
export const epicLaneEpochFrameFields = {
  authorityEpoch: epicLaneAuthorityEpochSchema,
} as const;

/**
 * The text-only marker every frame on the two RECORD lanes carries.
 *
 * `epic.state.subscribe` and `epic.status.subscribe` are text-only by contract,
 * not by accident: their whole reason for existing is that the monolith shipped
 * a whole-epic Y.Doc snapshot at open. A binary frame on either lane would
 * reintroduce exactly that, so the literal `false` makes it unconstructible
 * rather than merely discouraged. Only `artifact.subscribe` - the doc-class
 * lane - carries binary payloads, and it declares them per frame.
 */
export const epicLaneTextFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;
