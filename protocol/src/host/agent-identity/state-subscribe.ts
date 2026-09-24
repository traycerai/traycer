/**
 * `agentIdentity.state.subscribe@1.0` - an identity's INDEX lane.
 *
 * The identity counterpart of `epic.state.subscribe`, and deliberately its
 * shape: one typed snapshot followed by seq-ordered transactional deltas, on
 * ONE ordered channel, with the epoch and revision vocabulary the epic lanes
 * already define (`host/epic/lane-cursor.ts`). Those primitives are named for
 * the epic only because it is where they were minted; nothing in them is
 * epic-specific, and a second spelling of "authority epoch" would be exactly the
 * drift the lane-cursor module exists to prevent.
 *
 * ## What rides it
 *
 * Everything in the identity's root doc except fragment BODIES:
 *
 * - `identity` - the settings record: title, description, evolution.
 * - `documents` - one entry per markdown file: which shard holds its fragment,
 *   and under what name.
 * - `files` - the file plane's manifest, projected. Carried from day one rather
 *   than behind a wire minor the way the epic plane negotiates it, because this
 *   line has no released peer to negotiate with.
 * - shard availability - which of the identity's shard rooms the host can
 *   currently serve, so a file whose shard is down opens read-only instead of
 *   looking empty.
 *
 * Bodies ride `agentIdentity.file.subscribe`, per open file. That split is the
 * whole point of a lane: an identity with forty skill files must not ship forty
 * Y.Docs because a user opened the settings panel.
 *
 * ## Text-only, by contract
 *
 * Every frame declares `hasBinaryPayload: false`. The manifest names bytes and
 * never carries them - a blob's bytes reach a client through the plane's signed
 * read URL, and a fragment's through the body lane. The literal makes the
 * regression unconstructible rather than merely discouraged.
 *
 * ## Exactly one LEAD frame
 *
 * A subscription opens with exactly one of `snapshot` or `resumed`, before any
 * `delta`, and `resume-too-old` is explicit rather than silence. Identical to
 * the epic records lane, including the honest scope of the restart promise:
 * `position` survives a host restart, but serving DELTAS across one does not,
 * so a resume may legally degrade to a fresh snapshot and a client must never
 * treat that as an error.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  epicLaneCursorSchema,
  epicLaneEpochFrameFields,
  epicLanePositionSchema,
  epicLaneRowRevisionFields,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";
import {
  agentIdentityEvolutionSettingsSchema,
  agentIdentityIdSchema,
  agentIdentityPathSchema,
} from "@traycer/protocol/host/agent-identity/schemas";
import { identityFileEntrySchema } from "@traycer/protocol/host/agent-identity/files";
import { identityDocumentProvenanceKindSchema } from "@traycer/protocol/persistence/identity/schemas";
import {
  epicDurabilityStatusSchemaV15,
  epicLocalProtectionSchema,
  epicPromotionStateSchema,
} from "@traycer/protocol/host/epic/subscribe";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Where the identity's bytes are safe, and whether this session has local
 * (WAL) protection at all - the epic lane's `@1.6` durability legs, one
 * container over, and deliberately the SAME schemas rather than an identity
 * spelling of them: an identity is local-first (T14), its rooms are armed
 * into the same local room store an epic's are, and the renderer that
 * presents "local / promoting / cloud" for an epic presents exactly those
 * states for an identity.
 *
 * All three are OPTIONAL, and absence means UNKNOWN, never synced - the same
 * conservative reading `epic.subscribe` gives, for the same reason: a host
 * that cannot answer must not be read as reassurance. Every host-state
 * bearing frame carries them (both lead frames and `hostStateChanged`), so a
 * client attaching after a promotion needs no replay to learn the home moved.
 */
export const agentIdentityDurabilityFields = {
  durability: epicDurabilityStatusSchemaV15.optional(),
  promotionState: epicPromotionStateSchema.optional(),
  localProtection: epicLocalProtectionSchema.optional(),
} as const;

/**
 * The identity's own settings, as a revisioned RECORD.
 *
 * Revisioned as ONE entity rather than per field, on the reasoning
 * `epicStateMetaProjectionSchema` states: `title`, `description` and the
 * evolution block are not independently reconcilable rows, they are fields of
 * one thing the host commits together. A per-field revision would invite a
 * consumer to accept a newer title beside an older review model and materialize
 * a record that never existed on the host.
 *
 * It needs a revision at all because there IS a racing cold read:
 * `agentIdentity.list` serves the title and description, so a slow list answer
 * can land after a newer push.
 */
export const agentIdentityRecordProjectionSchema = lazySchema(() =>
  z.object({
    ...epicLaneRowRevisionFields,
    identity: z.object({
      title: z.string(),
      description: z.string().nullable(),
      evolution: agentIdentityEvolutionSettingsSchema,
    }),
  }),
);
export type AgentIdentityRecordProjection = z.infer<
  typeof agentIdentityRecordProjectionSchema
>;

/**
 * The delta counterpart: the fields this commit changed, at the revision the
 * record reached.
 *
 * `identity` is PARTIAL and `revision` sits OUTSIDE it, for the reason
 * `epicStateMetaPatchSchema` gives at length: a partial's key set means "the
 * fields this commit changed", so a revision inside it would be a key present on
 * every patch while not being a patched field, and a consumer spreading the
 * patch over its held record would write the revision into the record. The
 * wrapper makes the separation structural rather than a rule to remember, and it
 * is also why the inline form cannot simply be `.partial()`d - that would make
 * `revision` optional and silently delete the guard on the one frame that most
 * needs it.
 */
export const agentIdentityRecordPatchSchema = lazySchema(() =>
  z.object({
    ...epicLaneRowRevisionFields,
    identity: z
      .object({
        title: z.string(),
        description: z.string().nullable(),
        evolution: agentIdentityEvolutionSettingsSchema,
      })
      .partial(),
  }),
);
export type AgentIdentityRecordPatch = z.infer<
  typeof agentIdentityRecordPatchSchema
>;

/**
 * WHICH LIFE of a path a row describes. Host-minted, opaque, and half of every
 * row's key: a row is `(path, incarnation)`, never the path alone.
 *
 * ## Why a path is not enough
 *
 * A removal is terminal and ABSORBING (`epicLaneRowRevisionSchema`, rule 2): no
 * later upsert resurrects the row it removed, whatever its revision. That is
 * right for ONE file, and wrong for a PATH, because a path is reused. Rename A
 * to B and back to A, or delete A and create A again, inside one authority
 * epoch: keyed by path, the second A lands on A's tombstone and is suppressed
 * for the life of the replica. Nothing the file carries tells its two lives
 * apart either - a markdown fragment is named after its path, and a blob
 * recreated from the same bytes has the same hash - so the discriminator has
 * to be minted by the host, which is the only party that sees a row come into
 * existence.
 *
 * ## The minting contract - the HOST must honour all of it
 *
 * FRESH - a value this identity's replica has never used for this path in this
 * `authorityEpoch` - every time a row comes into existence at a path:
 *
 * - a create (`files.add`, a committed upload to a new path, an import, the
 *   projection ingesting a file the agent wrote);
 * - a rename, for the row at the DESTINATION path, including a rename back to
 *   a path that has held a row before;
 * - a recreate at a path whose previous row was removed.
 *
 * UNCHANGED for every later change to that same row: a body edit, a blob
 * overwrite (the displaced object moves into `versions[]`), a provenance or
 * metadata change - anything that is an upsert of a row the client already
 * holds. Minting a new one there would read as a removal the host never sent
 * plus a create, and leave the old row live forever.
 *
 * A removal names the incarnation it removes, so it can only ever absorb that
 * one life of the path.
 *
 * The value is OPAQUE: a client compares it for equality and nothing else, and
 * never orders, parses or derives one. How the host mints it is the host's
 * business - a uuid, or the position of the commit that created the row, both
 * satisfy the contract - but it must be persisted with the replica, for the
 * same reason `revision` is: a restart that re-minted it would present every
 * held row as a new life of its path.
 *
 * `revision` is per incarnation: a new life may start its count over.
 */
export const agentIdentityRowIncarnationSchema = lazySchema(() =>
  z.string().min(1),
);
export type AgentIdentityRowIncarnation = z.infer<
  typeof agentIdentityRowIncarnationSchema
>;

/**
 * One markdown file, as a ROW.
 *
 * Keyed by `(path, incarnation)` - see {@link agentIdentityRowIncarnationSchema}
 * for why the path alone is not a key. `path` is also the row's DATA: it is
 * where the file lives, and a caller looking for "the file at P" matches on it.
 * `revision` is the per-row staleness test every row on a lane carries: apply an
 * upsert only when it STRICTLY EXCEEDS the one held, and treat a removal as
 * terminal and ABSORBING - it applies at any revision and no later upsert
 * resurrects the row. `epicLaneRowRevisionSchema` states both rules in full,
 * including why the second is not simply "higher revision wins".
 */
export const agentIdentityDocumentRowSchema = lazySchema(() =>
  z.object({
    path: agentIdentityPathSchema,
    incarnation: agentIdentityRowIncarnationSchema,
    shardRoomId: z.string().min(1),
    fragmentName: z.string().min(1),
    /** Display metadata. No ordering decision may read it; that is `revision`. */
    updatedAt: z.number(),
    provenance: identityDocumentProvenanceKindSchema,
    ...epicLaneRowRevisionFields,
  }),
);
export type AgentIdentityDocumentRow = z.infer<
  typeof agentIdentityDocumentRowSchema
>;

/**
 * One blob, as a ROW: the plane's manifest entry, keyed by `(path,
 * incarnation)` exactly as a document row is.
 */
export const agentIdentityFileRowSchema = lazySchema(() =>
  z.object({
    path: agentIdentityPathSchema,
    incarnation: agentIdentityRowIncarnationSchema,
    entry: identityFileEntrySchema,
    ...epicLaneRowRevisionFields,
  }),
);
export type AgentIdentityFileRow = z.infer<typeof agentIdentityFileRowSchema>;

/**
 * A row's removal, addressed by its key - the path AND the incarnation, so a
 * removal absorbs exactly the life of the path it names and never a later one.
 *
 * One shape for both populations, because a removal carries nothing but the key
 * and the revision and two identical schemas would be two names for one fact.
 * `population` is what says which map to remove from - deliberately explicit
 * rather than inferred from the path, since `identityBodyKindForPath` is a HOST
 * rule and a client re-deriving it would eventually disagree with the host that
 * wrote the row.
 */
export const agentIdentityRowRemovalSchema = lazySchema(() =>
  z.object({
    population: z.enum(["document", "file"]),
    path: agentIdentityPathSchema,
    incarnation: agentIdentityRowIncarnationSchema,
    ...epicLaneRowRevisionFields,
  }),
);
export type AgentIdentityRowRemoval = z.infer<
  typeof agentIdentityRowRemovalSchema
>;

/**
 * Whether the host can currently serve one shard room.
 *
 * Carried as a SET on both lead frames and replaced whole on change, rather than
 * as a per-room delta, because availability is a property of the host's current
 * connection state and not of a row: a host that reconnects re-learns every
 * room at once, and a per-room stream of transitions would be a delta feed over
 * a value that is always fully known.
 *
 * A file whose shard is not `ready` opens READ-ONLY in the GUI and the
 * projection keeps the last bytes it wrote - the same availability contract
 * artifact rooms have.
 */
export const agentIdentityShardAvailabilitySchema = lazySchema(() =>
  z.object({
    shardRoomId: z.string().min(1),
    /**
     * `retrying` is its own value rather than a boolean, for the reason
     * `artifact.subscribe`'s `terminal` flag exists: a room the host has given
     * up on and a room it is still dialling need different affordances, and
     * folding them forces the host to pick a lie for one of the two.
     */
    state: z.enum(["ready", "retrying", "unavailable"]),
  }),
);
export type AgentIdentityShardAvailability = z.infer<
  typeof agentIdentityShardAvailabilitySchema
>;

/**
 * WHY a subscription received a full snapshot instead of a resume. CLOSED, on
 * `epicStateSnapshotBasisSchema`'s reasoning, and the same three members mean
 * the same three things one container over.
 */
export const agentIdentityStateSnapshotBasisSchema = lazySchema(() =>
  z.enum(["cold", "authorityEpochChanged", "resumeTooOld"]),
);
export type AgentIdentityStateSnapshotBasis = z.infer<
  typeof agentIdentityStateSnapshotBasisSchema
>;

/**
 * The open request.
 *
 * `resume` is REQUIRED AND NULLABLE rather than optional: "start from the
 * beginning" and "I forgot to send a cursor" must never be the same request on
 * the wire, and here the difference silently costs a full snapshot, which looks
 * like a slow host rather than a client bug.
 */
export const agentIdentityStateSubscribeOpenRequestSchemaV10 = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    resume: epicLaneCursorSchema.nullable(),
  }),
);
export type AgentIdentityStateSubscribeOpenRequestV10 = z.infer<
  typeof agentIdentityStateSubscribeOpenRequestSchemaV10
>;

/**
 * The typed snapshot: a complete REPLACEMENT of the client's state for this
 * identity, never a merge. A client applying it drops every row it held - the
 * three populations below are the whole of the lane's state, and merging would
 * silently retain rows the host has since forgotten.
 *
 * It MINTS the authority epoch, which is the reason this lane is the one a
 * client must open first: `agentIdentity.file.subscribe` requires an epoch on
 * its open request, and there is nowhere else to learn one.
 */
const agentIdentityStateSubscribeSnapshotFrameSchemaV10 = lazySchema(() =>
  z.object({
    kind: z.literal("snapshot"),
    ...epicLaneEpochFrameFields,
    /**
     * This snapshot's HIGH-WATER MARK. Deltas at or below it are already
     * contained here and must be dropped. Carried on the snapshot rather than
     * inferred from the first delta because a quiet identity may never send one,
     * and a client that had to wait for a delta to learn its own cursor could
     * not persist a resume point at all.
     */
    position: epicLanePositionSchema,
    basis: agentIdentityStateSnapshotBasisSchema,
    /**
     * Whether the rows below came from a replica the host has RECONCILED with
     * the cloud, or from a local seed it is serving ahead of that reconcile.
     * `false` is normal on a warm open and is a FRESHNESS label, not an error.
     */
    reconciledWithCloud: z.boolean(),
    identity: agentIdentityRecordProjectionSchema,
    documents: z.array(agentIdentityDocumentRowSchema),
    files: z.array(agentIdentityFileRowSchema),
    shards: z.array(agentIdentityShardAvailabilitySchema),
    ...agentIdentityDurabilityFields,
    ...epicLaneTextFrameFields,
  }),
);

/**
 * The other lead frame: the host accepted the cursor and is continuing from it.
 * No rows travel - the client keeps what it holds, which is the point of
 * resuming.
 *
 * It restates `reconciledWithCloud` and `shards`, which are the two facts a
 * resuming client cannot carry over: both describe the SERVING HOST's current
 * state, and the host may have restarted seed-only, or lost a shard, since the
 * cursor was persisted. A client that kept its old values would resume believing
 * it was reconciled against a host that is not, and rendering a writable editor
 * over a room that is down.
 */
const agentIdentityStateSubscribeResumedFrameSchemaV10 = lazySchema(() =>
  z.object({
    kind: z.literal("resumed"),
    ...epicLaneEpochFrameFields,
    position: epicLanePositionSchema,
    reconciledWithCloud: z.boolean(),
    shards: z.array(agentIdentityShardAvailabilitySchema),
    ...agentIdentityDurabilityFields,
    ...epicLaneTextFrameFields,
  }),
);

/**
 * The seed-trust marker FLIPPED, or a shard's availability changed. No row
 * changed, and that is precisely why these cannot ride the delta path: a delta
 * envelope refuses to be empty, because an empty one would consume a lane
 * position for a commit that never happened.
 *
 * Both facts travel on one frame with both fields required, rather than on two
 * frames or with optional keys. They are the only two host-state facts this lane
 * carries, a client applies either by overwriting, and an optional key would make
 * "unchanged" and "the producer forgot" the same observation.
 *
 * Carries no `seq` and consumes no position. Ordered only by arrival within its
 * epoch, with no revision guard because there is no entity and the host is the
 * sole writer. The lead frames' copies of these fields are this frame's
 * CURRENT-STATE PROJECTION, so a client attaching after a flip needs no replay.
 */
const agentIdentityStateSubscribeHostStateFrameSchemaV10 = lazySchema(() =>
  z.object({
    kind: z.literal("hostStateChanged"),
    ...epicLaneEpochFrameFields,
    reconciledWithCloud: z.boolean(),
    shards: z.array(agentIdentityShardAvailabilitySchema),
    ...agentIdentityDurabilityFields,
    ...epicLaneTextFrameFields,
  }),
);

/**
 * ONE COMMIT. Every row the commit touched, atomically.
 *
 * All four change fields are REQUIRED, with empty arrays and `null` carrying
 * "nothing in this category". An optional key makes "unchanged" and "the
 * producer forgot" the same wire observation, and required-and-empty is
 * checkable - which is what makes the emptiness invariant below enforceable at
 * the schema boundary instead of in prose.
 *
 * The atomicity obligation is on the PRODUCER and cannot be typed: a RENAME
 * ships the new document row (under a FRESH incarnation) AND the old row's
 * removal in one envelope, so no client ever observes both paths live or
 * neither. A blob overwrite ships one
 * file row whose entry already carries the displaced object in `versions[]`.
 */
const agentIdentityStateSubscribeDeltaFrameSchemaV10 = lazySchema(() =>
  z.object({
    kind: z.literal("delta"),
    ...epicLaneEpochFrameFields,
    /**
     * This commit's position. Strictly increasing within an epoch, and the value
     * a client persists as its resume cursor once the envelope is FULLY applied
     * - never before, or a crash mid-apply resumes past work it did not finish.
     */
    seq: epicLanePositionSchema,
    documentUpserts: z.array(agentIdentityDocumentRowSchema),
    fileUpserts: z.array(agentIdentityFileRowSchema),
    removals: z.array(agentIdentityRowRemovalSchema),
    /**
     * The identity fields this commit changed, at the revision the record
     * reached, or `null` when the commit changed none.
     */
    identity: agentIdentityRecordPatchSchema.nullable(),
    ...epicLaneTextFrameFields,
  }),
);

/**
 * The minimal SUPERTYPE the envelope invariant reads, declared by hand so the
 * refine can be shared across future minors' unions without a circular
 * const/type reference. The `EnvelopeCheckedFrame` idiom from `chat-records.ts`.
 */
type EmptinessCheckedFrame =
  | {
      readonly kind: "delta";
      readonly documentUpserts: readonly unknown[];
      readonly fileUpserts: readonly unknown[];
      readonly removals: readonly unknown[];
      readonly identity: unknown;
    }
  | { readonly kind: "snapshot" }
  | { readonly kind: "resumed" }
  | { readonly kind: "hostStateChanged" }
  | { readonly kind: "pong" };

/**
 * An envelope must carry at least one change.
 *
 * Validated rather than left as prose because an empty envelope is not merely
 * useless - it CONSUMES A POSITION, and the resulting "resume from N" would be
 * indistinguishable from a real commit at N.
 */
function refineDeltaCarriesChange(
  frame: EmptinessCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "delta") return;
  const carriesChange =
    frame.documentUpserts.length > 0 ||
    frame.fileUpserts.length > 0 ||
    frame.removals.length > 0 ||
    frame.identity !== null;
  if (carriesChange) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["kind"],
    message:
      "A delta envelope must carry at least one change - an empty envelope consumes a lane position for a commit that never happened.",
  });
}

export const agentIdentityStateSubscribeServerFrameSchemaV10 = lazySchema(() =>
  z
    .discriminatedUnion("kind", [
      agentIdentityStateSubscribeSnapshotFrameSchemaV10,
      agentIdentityStateSubscribeResumedFrameSchemaV10,
      agentIdentityStateSubscribeDeltaFrameSchemaV10,
      agentIdentityStateSubscribeHostStateFrameSchemaV10,
      z.object({
        kind: z.literal("pong"),
        // No epoch stamp: heartbeats are intercepted by the shared connection
        // handler before a resolver is selected, so there is no resolver to
        // mint one. Same transport-level shape as every other lane's `pong`.
        ...epicLaneTextFrameFields,
      }),
    ])
    .superRefine(refineDeltaCarriesChange),
);
export type AgentIdentityStateSubscribeServerFrameV10 = z.infer<
  typeof agentIdentityStateSubscribeServerFrameSchemaV10
>;

/**
 * `ping` and nothing else.
 *
 * The index lane is READ-ONLY on the wire. Every mutation rides the
 * `agentIdentity.files.*` unaries with a client-generated id, which is what lets
 * a write be retried after a reconnect without the stream having to remember it.
 * A write frame here would be a second write path with no command identity and
 * no lifecycle.
 */
export const agentIdentityStateSubscribeClientFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...epicLaneTextFrameFields,
    }),
  ]),
);
export type AgentIdentityStateSubscribeClientFrameV10 = z.infer<
  typeof agentIdentityStateSubscribeClientFrameSchemaV10
>;

export const agentIdentityStateSubscribeV10 = defineStreamRpcContract({
  method: "agentIdentity.state.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: agentIdentityStateSubscribeOpenRequestSchemaV10,
  serverFrameSchema: agentIdentityStateSubscribeServerFrameSchemaV10,
  clientFrameSchema: agentIdentityStateSubscribeClientFrameSchemaV10,
});
