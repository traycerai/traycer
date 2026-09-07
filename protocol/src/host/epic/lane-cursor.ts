/**
 * Cursor, epoch and frame primitives shared by the epic sync LANES - `epic.state.subscribe`, `epic.status.subscribe` and `artifact.subscribe`.
 * A client must therefore never treat a post-restart snapshot as an error.
 */
import { z } from "zod";

/**
 * Opaque replica identity for one epic on one serving host. `min(1)` so an empty epoch cannot silently license a resume across a replica replacement.
 */
export const epicLaneAuthorityEpochSchema = z.string().min(1);
export type EpicLaneAuthorityEpoch = z.infer<
  typeof epicLaneAuthorityEpochSchema
>;

/** Position within a lane's epoch. */
export const epicLanePositionSchema = z.number().int().nonnegative();
export type EpicLanePosition = z.infer<typeof epicLanePositionSchema>;

/**
 * `epic.subscribe@1.2` - A resume point on one lane: the epoch it belongs to, and the position within it the client has already applied.
 */
export const epicLaneCursorSchema = z.object({
  authorityEpoch: epicLaneAuthorityEpochSchema,
  position: epicLanePositionSchema,
});
export type EpicLaneCursor = z.infer<typeof epicLaneCursorSchema>;

/**
 * A ROW's revision - the per-entity staleness test, and a different number from {@link epicLanePositionSchema} in every respect that matters.
 * A single envelope at one `seq` carries rows at many different revisions, so a consumer must never synthesize one from the other.
 */
export const epicLaneRowRevisionSchema = z.number().int().nonnegative();
export type EpicLaneRowRevision = z.infer<typeof epicLaneRowRevisionSchema>;

/**
 * The revision field, spread into every row and every removal on the records lane so a single definition covers all of them.
 * The client seam's `RecordChange` requires one on both arms, and a removal without a revision cannot be placed in its entity's history at all - see rule 2 above for why carrying it is not the same as gating on it.
 */
export const epicLaneRowRevisionFields = {
  revision: epicLaneRowRevisionSchema,
} as const;

/**
 * `epic.subscribe@2.0` - The epoch stamp every non-`pong` lane frame carries.
 * A resolver rebuild that does not replace the replica keeps the same epoch and its frames stay valid - clients discard on authority identity, never on resolver identity.
 */
export const epicLaneEpochFrameFields = {
  authorityEpoch: epicLaneAuthorityEpochSchema,
} as const;

/** The text-only marker every frame on the two RECORD lanes carries. */
export const epicLaneTextFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;
