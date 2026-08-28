/**
 * `epic.state.subscribe@1.0` - the epic's RECORDS lane: what is in the epic.
 *
 * One of the three lanes that retire the monolithic `epic.subscribe`. This one
 * carries the server-arbitrated row set - artifact index and tombstones, epic
 * metadata, agent role claims, comment threads - as a typed snapshot followed
 * by seq-ordered transactional deltas. It is the ONLY source of those rows: the
 * root Y.Doc replica that used to produce them client-side does not exist for a
 * lane client.
 *
 * ## Text-only, by contract
 *
 * Every frame declares `hasBinaryPayload: false`. The monolith's defining cost
 * was a whole-epic Y.Doc snapshot at open (chat transcript residue included);
 * this lane cannot regress into that because the literal makes a binary frame
 * unconstructible. Artifact BODIES - the only genuinely CRDT-shaped data in an
 * epic - ride `artifact.subscribe`, per open tile.
 *
 * ## Snapshot-then-deltas on ONE ordered channel
 *
 * The snapshot rides the stream and never a unary. A unary snapshot plus a
 * separate delta channel reintroduces the join-vs-fetch race - the client must
 * decide whether a delta it already received belongs before or after a snapshot
 * it fetched concurrently - and every fix for that race is a re-derivation of
 * what one ordered channel gives for free.
 *
 * The resolver's ordering obligation is inherited verbatim from
 * `epic.subscribe@2.0`, which is this lane's primary donor: install the
 * observers BEFORE reading the snapshot, buffer and coalesce their output until
 * the snapshot frame has been emitted, then flush it in `seq` order. A mutation
 * must never land between the snapshot read and observer registration. The
 * snapshot carries its own high-water mark so the client can drop the buffered
 * deltas the snapshot already contains rather than guessing from arrival order.
 *
 * ## Exactly one LEAD frame per subscription
 *
 * A subscription opens with exactly one of `snapshot` or `resumed`, before any
 * `delta`. That is the whole of the resume contract, and it is total:
 *
 * - No `resume` offered, or an offer the host cannot serve -> `snapshot`, whose
 *   `basis` states which of the three cases it is.
 * - An offer the host CAN serve -> `resumed`, naming the epoch and position it
 *   is continuing from, then the deltas above it.
 *
 * `resume-too-old` is therefore explicit, never an error and never silence
 * (wire-lane invariant 3). It is also not a rare path: a resume across a host
 * restart may legally degrade to a fresh snapshot, because serving deltas
 * across a restart would need a persisted record-change journal these contracts
 * do not promise.
 *
 * The `resumed` acknowledgement exists so that "your cursor was accepted and
 * nothing has happened since" is a STATEMENT rather than an absence. Without
 * it, a caught-up resume and a host that has not gotten around to answering are
 * the same observation, and every client would grow a timeout to tell them
 * apart.
 *
 * ## Deltas are transactional envelopes
 *
 * One `delta` frame is one commit. A reorder, a move, or a delete ships ALL
 * affected rows and tombstones in that single frame, so no client ever observes
 * an impossible intermediate tree (two artifacts claiming one folder name, a
 * child whose parent has already been removed). This is why the envelope
 * carries arrays rather than the per-row `artifactRecordUpsert` /
 * `artifactRecordRemove` frames `@2` used: those could not express atomicity at
 * all, and a consumer had no way to know a reparent was half-applied.
 *
 * ## Ordering guards, and why the row shapes differ
 *
 * `seq` is the lane's total order and the ONLY ordering fact for artifact rows,
 * epic metadata and role claims: this lane is their sole delivery plane, so
 * there is no second source a stale answer could arrive from, and a per-row
 * revision would be a guard against a race that cannot occur.
 *
 * Comment threads are the exception, and carry a `revision` for that reason:
 * `epic.listCommentThreads` remains installed for cold reads, so a slow unary
 * answer genuinely can land after a newer push. The guard is the one the record
 * layer already proves elsewhere (`chatRecordSummarySchema.revision`): apply an
 * upsert only when its revision strictly exceeds the one held, and treat a
 * removal as TERMINAL AND ABSORBING - it applies unconditionally and no later
 * upsert resurrects the row on that client.
 *
 * ## Seed-first, with the trust labelled
 *
 * The host serves this lane from its own local replica the moment it has one,
 * and reconciles with the cloud in the background - "hold the client while I
 * ask upstream" is forbidden. `reconciledWithCloud` on the snapshot says which
 * of the two a given seed is, so the client can render immediately, LABEL the
 * staleness, and gate privileged actions on an authority check rather than on a
 * guess.
 *
 * Seed-first is CONDITIONAL by nature and the contract does not pretend
 * otherwise: a first open on a host - fresh install, newly shared epic, new
 * device - has no seed and its snapshot still waits on the cloud sync. That gap
 * is an accepted, telemetered limitation, not something a wire field can close.
 *
 * ## Comment threads are records here, not invalidation pings
 *
 * `@2` shipped a `commentThreadsChanged` frame carrying only the artifact ids
 * whose threads had moved, which forced a refetch stampede on exactly the links
 * least able to absorb one. Threads travel as rows on this lane so a cached
 * thread stays renderable across a flaky connection. `epic.listCommentThreads`
 * remains for cold reads and for surfaces that never open the lane.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  epicLaneCursorSchema,
  epicLaneEpochFrameFields,
  epicLanePositionSchema,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";
import { commentThreadWireSchema } from "@traycer/protocol/host/epic/unary-schemas";
import {
  deletedReviewArtifactSchema,
  deletedSpecArtifactSchema,
  deletedStoryArtifactSchema,
  deletedTicketArtifactSchema,
  reviewArtifactSchema,
  specArtifactSchema,
  storyArtifactSchema,
  ticketArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";
import { roleClaimSchema } from "@traycer/protocol/persistence/epic/role-claims";

/**
 * One artifact record on the records lane.
 *
 * Derived from the released PERSISTENCE variants rather than restating a second
 * field/status vocabulary: an artifact's kind, status and parentage mean the
 * same thing on disk and on the wire, and two spellings of that would be a seam
 * where they could drift.
 *
 * `artifactRoomId` is omitted, and that omission is load-bearing rather than
 * tidy. Room routing is how the HOST reaches an artifact body in the cloud; a
 * lane client addresses bodies by `artifactId` through `artifact.subscribe` and
 * has no use for a room id except to construct a connection it must never
 * construct. Shipping it would make the client's dependence on host-internal
 * topology invisible until the topology changed.
 *
 * Inherited unchanged from `epic.subscribe@2.0`, which minted this shape and
 * was never released - so this is the first line to carry it, and it is frozen
 * from here.
 */
export const epicArtifactRecordSchema = z.discriminatedUnion("kind", [
  specArtifactSchema.omit({ artifactRoomId: true }),
  ticketArtifactSchema.omit({ artifactRoomId: true }),
  storyArtifactSchema.omit({ artifactRoomId: true }),
  reviewArtifactSchema.omit({ artifactRoomId: true }),
]);
export type EpicArtifactRecord = z.infer<typeof epicArtifactRecordSchema>;

/**
 * Tombstone counterpart of {@link epicArtifactRecordSchema}. Same derivation,
 * same room-routing omission.
 *
 * Tombstones are carried rather than implied by absence because absence cannot
 * distinguish "deleted" from "not in this snapshot": the artifact tree renders
 * deleted-artifact affordances, and a client that inferred deletion from a
 * missing row would resurrect an artifact the moment a snapshot arrived that
 * legitimately did not mention it.
 */
export const epicDeletedArtifactRecordSchema = z.discriminatedUnion("kind", [
  deletedSpecArtifactSchema.omit({ artifactRoomId: true }),
  deletedTicketArtifactSchema.omit({ artifactRoomId: true }),
  deletedStoryArtifactSchema.omit({ artifactRoomId: true }),
  deletedReviewArtifactSchema.omit({ artifactRoomId: true }),
]);
export type EpicDeletedArtifactRecord = z.infer<
  typeof epicDeletedArtifactRecordSchema
>;

/**
 * The epic-level metadata the records lane owns.
 *
 * Deliberately small. Everything a tab needs BEFORE the lane can answer -
 * repos, workspace folders, repo mapping, `epicLight`, permission role - is the
 * workspace context, and it is served by `epic.getWorkspaceContext` at tab open
 * precisely so this lane does not have to block on a cloud room to hand the
 * renderer a title.
 */
export const epicMetaSchema = z.object({
  title: z.string(),
  updatedAt: z.number(),
});
export type EpicMeta = z.infer<typeof epicMetaSchema>;

const permissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role",
  "latest",
);

/**
 * The role-claims projection carried on this lane.
 *
 * Whole-set replacement, not per-claim deltas: claims are a handful of small
 * rows per epic, the host already computes the visible projection in one pass
 * (`projectVisibleRoleClaims` - filtered by account, then by live agents), and
 * a per-claim delta would force the client to re-derive a filter the host is
 * the only party able to evaluate. `seq` orders the replacements; there is no
 * per-claim revision because there is no second source for a claim.
 */
const epicStateRoleClaimsSchema = z.array(roleClaimSchema);

/**
 * One comment thread, as a ROW on the records lane.
 *
 * The thread body reuses `commentThreadWireSchema` verbatim - the same shape
 * `epic.listCommentThreads` returns - so the cold read and the push cannot
 * disagree about what a thread is. That shape is FROZEN by the released
 * `epic.listCommentThreads@1.0` line: a field added to it grows a released
 * response, so the next field forks a versioned copy for THIS lane (the
 * `chatRecordSummarySchema` / `hostNotificationEntrySchemaV21` pattern) rather
 * than being edited in place.
 *
 * Two fields are added around it:
 *
 * - `artifactId` - threads are per-artifact, and `(artifactId, threadId)` is
 *   the row key. The artifact KIND is deliberately absent: it is already on the
 *   artifact record this thread hangs off, and carrying a second copy would let
 *   a frame assert a kind that contradicts the record it references.
 * - `revision` - the per-row monotonic staleness test. It exists for comment
 *   threads and for no other row on this lane because comment threads are the
 *   only rows with a SECOND delivery path (`epic.listCommentThreads`, kept for
 *   cold reads), so a slow unary answer can genuinely land after a newer push.
 *   Apply an upsert only when its revision strictly EXCEEDS the one held.
 */
export const epicCommentThreadRecordSchema = commentThreadWireSchema.extend({
  artifactId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type EpicCommentThreadRecord = z.infer<
  typeof epicCommentThreadRecordSchema
>;

/**
 * A comment thread's removal, addressed by its row key.
 *
 * No revision, and none is needed: removal is TERMINAL AND ABSORBING, the one
 * lifecycle rule this design has. It applies unconditionally and idempotently,
 * and no later upsert - however high its revision - resurrects the thread on a
 * client that has seen this. That is what makes replayed and reordered deltas
 * harmless without any merge logic (the `host.chatRecords.subscribe` `remove`
 * precedent).
 */
export const epicCommentThreadRemovalSchema = z.object({
  artifactId: z.string().min(1),
  threadId: z.string().min(1),
});
export type EpicCommentThreadRemoval = z.infer<
  typeof epicCommentThreadRemovalSchema
>;

/**
 * WHY a subscription received a full snapshot instead of a resume.
 *
 * CLOSED enum. A basis this contract version cannot represent would leave the
 * client unable to distinguish a routine cold open from a replica replacement,
 * which are the same frame but not the same event - so widening it is a NEW
 * MINOR, never a silent addition.
 *
 * - `cold` - the open carried no `resume`. First open of this epic on this
 *   client, or a client that deliberately discarded its cursor.
 * - `authorityEpochChanged` - a cursor was offered, and its `authorityEpoch` is
 *   not the one this host is serving. The replica was replaced, compacted or
 *   migrated underneath the client. Everything the client held for this epic is
 *   void, INCLUDING per-artifact body state: an artifact deleted and recreated
 *   across an epoch is a different document, and splicing the two histories is
 *   the failure this basis exists to prevent.
 * - `resumeTooOld` - the epoch MATCHED and the position did not: the host can
 *   no longer serve deltas from there (compaction below the cursor, or a
 *   restart, which is explicitly permitted to degrade this way). The replica is
 *   the same one, so per-artifact body state remains valid; only the row set
 *   re-seeds.
 *
 * The two failure bases are distinguished rather than folded into one
 * `resumeTooOld` because they demand different amounts of discarding, and a
 * client handed only "your cursor did not work" would have to take the
 * pessimistic branch every time - throwing away hot artifact docs on every
 * compaction.
 */
export const epicStateSnapshotBasisSchema = z.enum([
  "cold",
  "authorityEpochChanged",
  "resumeTooOld",
]);
export type EpicStateSnapshotBasis = z.infer<
  typeof epicStateSnapshotBasisSchema
>;

/**
 * The open request.
 *
 * `resume` is REQUIRED AND NULLABLE rather than optional, on the
 * `epic.communicationGraph.subscribe` `sinceCursor` precedent: "start from the
 * beginning" and "I forgot to send a cursor" must never be the same request on
 * the wire. The distinction matters more here than there - a missing cursor
 * silently costs a full snapshot, which looks like a slow host rather than a
 * client bug, so the honest encoding is the one where the intent is always
 * stated.
 */
export const epicStateSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string().min(1),
  /**
   * The furthest point on THIS lane the client has already applied, or `null`
   * for a cold open. Only rows above it are delivered, and only when the host
   * can still serve from there - otherwise the answer is a fresh `snapshot`
   * naming the basis, never an error and never silence.
   */
  resume: epicLaneCursorSchema.nullable(),
});
export type EpicStateSubscribeOpenRequestV10 = z.infer<
  typeof epicStateSubscribeOpenRequestSchemaV10
>;

/**
 * The typed state snapshot: one of the two possible LEAD frames, and a complete
 * replacement of the client's row set for this epic.
 *
 * Complete replacement, not a merge. A client applying this must drop every row
 * it held for the epic and install exactly what this frame carries - the four
 * row populations below are the whole of the lane's state, and a merge would
 * silently retain rows the host has since forgotten.
 */
const epicStateSubscribeSnapshotFrameSchemaV10 = z.object({
  kind: z.literal("snapshot"),
  ...epicLaneEpochFrameFields,
  /**
   * This snapshot's HIGH-WATER MARK: the lane position the row set below
   * reflects. Deltas at or below it are already contained in this frame and
   * must be dropped; the buffered deltas the resolver flushes after this frame
   * begin above it.
   *
   * Carried on the snapshot rather than inferred from the first delta because
   * a quiet epic may never send one, and a client that had to wait for a delta
   * to learn its own cursor could not persist a resume point at all.
   */
  position: epicLanePositionSchema,
  basis: epicStateSnapshotBasisSchema,
  /**
   * Whether this snapshot reflects a replica the host has RECONCILED with the
   * cloud, or a local seed it is serving ahead of that reconcile.
   *
   * `false` is the normal, expected state on a warm open and is not an error:
   * the host serves from its own replica immediately by design. It is a
   * FRESHNESS label - the client renders either way, marks the staleness where
   * a user could act on it, and gates privileged mutations and secret
   * hydration on an authority check rather than on this boolean.
   *
   * A cloud denial arriving after a seed-served open terminates the lane with
   * the adjudicated verdict; it does not flip this field, because by then the
   * question is authorization, not freshness.
   */
  reconciledWithCloud: z.boolean(),
  epicMeta: epicMetaSchema,
  artifactRecords: z.array(epicArtifactRecordSchema),
  /**
   * Tombstones ride the SNAPSHOT, unlike removed comment threads below, and
   * the asymmetry is not an oversight.
   *
   * A deleted artifact is still RENDERED - the tree shows deleted-artifact
   * affordances, and a link to one must resolve to "deleted" rather than to
   * nothing - so its tombstone is live state a snapshot has to carry. A removed
   * comment thread renders as nothing at all, so a snapshot that simply omits
   * it has already said everything there is to say. Carrying thread tombstones
   * here would grow the snapshot without end for a fact no consumer reads.
   */
  deletedArtifacts: z.array(epicDeletedArtifactRecordSchema),
  roleClaims: epicStateRoleClaimsSchema,
  /** Every LIVE thread on this epic. Removed threads are simply absent. */
  commentThreads: z.array(epicCommentThreadRecordSchema),
  ...epicLaneTextFrameFields,
});

/**
 * The other possible LEAD frame: the host accepted the offered cursor and is
 * continuing from it. No rows travel here - the client keeps everything it
 * holds, and the deltas above `position` follow.
 *
 * It echoes the accepted `(authorityEpoch, position)` rather than staying
 * empty so the acknowledgement is self-describing: a client that persisted a
 * cursor, restarted, and reconnected can verify the host resumed from the point
 * it meant rather than from a stale copy it still had in memory.
 */
const epicStateSubscribeResumedFrameSchemaV10 = z.object({
  kind: z.literal("resumed"),
  ...epicLaneEpochFrameFields,
  position: epicLanePositionSchema,
  ...epicLaneTextFrameFields,
});

/**
 * ONE COMMIT. Every row and tombstone the commit touched, atomically.
 *
 * All six change fields are REQUIRED, with empty arrays and `null` carrying
 * "nothing in this category" - not optional keys. An optional key makes
 * "unchanged" and "the producer forgot" the same wire observation, and the
 * consumer's only recourse is to guess. Required-and-empty is checkable, which
 * is what makes the invariant below enforceable at the schema boundary instead
 * of in prose.
 *
 * The atomicity obligation is on the PRODUCER and cannot be expressed in a type:
 * a reparent that moves a child ships both the child's new row and every
 * sibling whose order changed; a delete ships the tombstone AND any row whose
 * parentage the delete rewrote. The rule a resolver must follow is that a
 * client applying one envelope in full must never be able to observe a tree
 * that could not exist.
 */
const epicStateSubscribeDeltaFrameSchemaV10 = z.object({
  kind: z.literal("delta"),
  ...epicLaneEpochFrameFields,
  /**
   * This commit's position in the lane's order. Strictly increasing within an
   * epoch, and the value a client persists as its resume cursor once the
   * envelope is fully applied - never before, or a crash mid-apply resumes past
   * work it did not finish.
   */
  seq: epicLanePositionSchema,
  artifactUpserts: z.array(epicArtifactRecordSchema),
  /**
   * Artifacts deleted by this commit. ABSORBING: a client that applies one of
   * these must not resurrect the artifact from a later upsert in the same
   * envelope or from a stale row it holds elsewhere.
   */
  artifactTombstones: z.array(epicDeletedArtifactRecordSchema),
  commentThreadUpserts: z.array(epicCommentThreadRecordSchema),
  commentThreadRemovals: z.array(epicCommentThreadRemovalSchema),
  /**
   * The epic metadata fields this commit changed, or `null` when it changed
   * none. PARTIAL rather than whole: `title` and `updatedAt` move
   * independently and a whole-object push would force the host to restate a
   * title it did not re-read.
   */
  epicMeta: epicMetaSchema.partial().nullable(),
  /**
   * The complete visible role-claim set after this commit, or `null` when the
   * commit did not touch claims. Whole-set replacement - see
   * {@link epicStateRoleClaimsSchema} for why claims are not delta'd.
   */
  roleClaims: epicStateRoleClaimsSchema.nullable(),
  ...epicLaneTextFrameFields,
});

/**
 * The minimal SUPERTYPE the envelope invariant reads, declared by hand so the
 * refine can be shared across future minors' unions without a circular
 * const/type reference (an inferred type would name the refine that builds it).
 * This is the `EnvelopeCheckedFrame` idiom from `chat-records.ts`.
 */
type EmptinessCheckedFrame =
  | {
      readonly kind: "delta";
      readonly artifactUpserts: readonly unknown[];
      readonly artifactTombstones: readonly unknown[];
      readonly commentThreadUpserts: readonly unknown[];
      readonly commentThreadRemovals: readonly unknown[];
      readonly epicMeta: unknown;
      readonly roleClaims: unknown;
    }
  | { readonly kind: "snapshot" }
  | { readonly kind: "resumed" }
  | { readonly kind: "pong" };

/**
 * An envelope must carry at least one change.
 *
 * Validated rather than left as prose because an empty envelope is not merely
 * useless - it CONSUMES A POSITION. A resolver that emitted one per observed
 * no-op would advance every client's cursor for changes that never happened,
 * and the resulting "resume from N" would be indistinguishable from a real
 * commit at N. Refusing the shape outright is the only place that can be caught
 * once rather than in every consumer.
 */
function refineDeltaCarriesChange(
  frame: EmptinessCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "delta") return;
  const carriesChange =
    frame.artifactUpserts.length > 0 ||
    frame.artifactTombstones.length > 0 ||
    frame.commentThreadUpserts.length > 0 ||
    frame.commentThreadRemovals.length > 0 ||
    frame.epicMeta !== null ||
    frame.roleClaims !== null;
  if (carriesChange) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["kind"],
    message:
      "A delta envelope must carry at least one change - an empty envelope consumes a lane position for a commit that never happened.",
  });
}

export const epicStateSubscribeServerFrameSchemaV10 = z
  .discriminatedUnion("kind", [
    epicStateSubscribeSnapshotFrameSchemaV10,
    epicStateSubscribeResumedFrameSchemaV10,
    epicStateSubscribeDeltaFrameSchemaV10,
    z.object({
      kind: z.literal("pong"),
      // No epoch stamp: heartbeats are intercepted by the shared connection
      // handler before a resolver is selected, so there is no resolver to mint
      // one. Same transport-level shape as every other lane's `pong`.
      ...epicLaneTextFrameFields,
    }),
  ])
  .superRefine(refineDeltaCarriesChange);
export type EpicStateSubscribeServerFrameV10 = z.infer<
  typeof epicStateSubscribeServerFrameSchemaV10
>;

/**
 * `ping` and nothing else.
 *
 * The records lane is READ-ONLY on the wire. Mutations ride the existing
 * unaries with client-generated command ids, which is what lets a write be
 * retried after a reconnect without the stream having to remember it. A write
 * frame here would be a second write path with no command identity and no
 * lifecycle - exactly the "silent rollback" the north-star forbids.
 */
export const epicStateSubscribeClientFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type EpicStateSubscribeClientFrameV10 = z.infer<
  typeof epicStateSubscribeClientFrameSchemaV10
>;

export const epicStateSubscribeV10 = defineStreamRpcContract({
  method: "epic.state.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicStateSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicStateSubscribeServerFrameSchemaV10,
  clientFrameSchema: epicStateSubscribeClientFrameSchemaV10,
});
