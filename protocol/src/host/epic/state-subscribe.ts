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
 * ## Two orders, and they are not interchangeable
 *
 * `seq` is TRANSACTION order - where a commit sits in the lane. `revision` is
 * ENTITY order - how many times one row has changed. Every row and every
 * removal on this lane carries a revision, because the runtime's reconciler
 * needs a per-entity fence that transaction order cannot provide: one envelope
 * at one `seq` carries rows at many different revisions, so synthesizing a
 * revision from `seq` would stamp every row a commit touched with the same
 * value and make unrelated rows falsely comparable.
 *
 * The guard is the one the record layer already proves elsewhere
 * (`chatRecordSummarySchema.revision`): apply an upsert only when its revision
 * strictly exceeds the one held, and treat a removal as TERMINAL AND ABSORBING
 * - it applies unconditionally, at any revision, and no later upsert resurrects
 * the row on that client. {@link epicLaneRowRevisionSchema} states both rules
 * in full, including why the second one is not simply "higher revision wins".
 *
 * The guard is not decoration even though this lane is the only PUSH source for
 * these rows. EVERY population has a cold-read path that races it -
 * `epic.listCommentThreads` for threads, `agent.roles.list` for claims,
 * `epic.getWorkspaceContext`'s `epicLight` for the epic TITLE - and an
 * optimistic local write is a further racer for all of them.
 *
 * Three of the four populations are revisioned per row. The two exceptions are
 * revisioned as ONE ENTITY, and for the same underlying reason - the thing that
 * changes is not a row:
 *
 * - **Role claims**, as a SET, because a claim is created and destroyed but
 *   never updated ({@link epicStateRoleClaimsProjectionSchema}).
 * - **Epic meta**, as a RECORD, because `title` and `updatedAt` are two fields
 *   of one thing the host commits together
 *   ({@link epicStateMetaProjectionSchema}).
 *
 * ## Seed-first, with the trust labelled
 *
 * The host serves this lane from its own local replica the moment it has one,
 * and reconciles with the cloud in the background - "hold the client while I
 * ask upstream" is forbidden. `reconciledWithCloud` says which of the two a
 * given seed is, so the client can render immediately, LABEL the staleness, and
 * gate privileged actions on an authority check rather than on a guess.
 *
 * Trust is a fact with a LIFETIME, not a property of one frame, so it appears
 * in three places and they are one contract:
 *
 * - on `snapshot`, as the value at the moment the rows were read;
 * - on `resumed`, restated because a resuming client cannot inherit it (the
 *   serving host may have restarted seed-only since the cursor was persisted);
 * - as `trustChanged`, when the background reconcile flips it mid-subscription.
 *
 * The transition frame is not a nicety. A reconcile changes no row, so the
 * delta path cannot carry it and no snapshot is re-emitted - which left an
 * attached client labelling its data seed-only forever, with privileged actions
 * gated on a marker that could be set but never cleared. See
 * {@link epicStateSubscribeServerFrameSchemaV10}'s `trustChanged` variant.
 *
 * Trust stays on THIS lane and is never derived from the control lane's
 * `cloudSyncStatus`: that is the host's connection state, this is whether these
 * rows have been reconciled, and blending the two would be one displayed claim
 * over two classes.
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
import {
  epicLaneCursorSchema,
  epicLaneEpochFrameFields,
  epicLanePositionSchema,
  epicLaneRowRevisionFields,
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
import {
  epicFileEntrySchema,
  epicFileObjectSchema,
} from "@traycer/protocol/persistence/epic/files";
import { roleClaimSchema } from "@traycer/protocol/persistence/epic/role-claims";

/**
 * One artifact record on the records lane.
 *
 * Derived from the released PERSISTENCE variants rather than restating a second
 * field/status vocabulary: an artifact's kind, status and parentage mean the
 * same thing on disk and on the wire, and two spellings of that would be a seam
 * where they could drift.
 *
 * `revision` is added at the WIRE layer, not pushed down into the persisted
 * shape: it is a property of this host replica's delivery of the row, not of
 * the artifact itself, and a persisted artifact copied to another host is the
 * same artifact at a different revision. See
 * {@link epicLaneRowRevisionSchema} for the guard it powers, and note that
 * `updatedAt` - which the persisted shape does carry - is display metadata that
 * must never be read as an ordering fact in its place.
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
  specArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  ticketArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  storyArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  reviewArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
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
 *
 * A tombstone carries the same `revision` a live row does, and for a reason
 * that reads backwards at first: it does NOT gate whether the tombstone
 * applies. Removal is ABSORBING - a tombstone whose revision is LOWER than an
 * upsert the client already applied still removes the artifact, because "this
 * row was deleted" is terminal against later upserts at any revision. The
 * number is what lets the reconciler place the removal in the entity's history
 * (ordering removals against each other, and distinguishing a
 * delete-then-recreate from a recreate-then-delete). See
 * {@link epicLaneRowRevisionSchema} rule 2.
 */
export const epicDeletedArtifactRecordSchema = z.discriminatedUnion("kind", [
  deletedSpecArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  deletedTicketArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  deletedStoryArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
  deletedReviewArtifactSchema
    .omit({ artifactRoomId: true })
    .extend(epicLaneRowRevisionFields),
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

/**
 * Epic metadata as a REVISIONED ROW, which is how it travels on both frames.
 *
 * ## Why meta needs a revision at all
 *
 * It is a row like any other on this lane, and it has the same racing cold-read
 * problem the other populations do: `epic.getWorkspaceContext` serves
 * `epicLight`, which carries the epic TITLE. So a slow workspace-context answer
 * can land after a newer title push, and without a per-entity fence the client
 * has no way to reject it - the exact "a slow answer can never regress a newer
 * push" case the guard exists for. The host already mints the number
 * (`journal.recordEntity(epicMetaEntityKey(), ...)`); it simply was not on the
 * wire.
 *
 * ## Why ONE revision for the whole record, not one per field
 *
 * Meta is revisioned as a single ENTITY, on the same reasoning that makes
 * `roleClaims` a revisioned SET: `title` and `updatedAt` are not independently
 * reconcilable rows, they are two fields of one thing the host commits
 * together. A per-field revision would invite a consumer to accept a newer
 * `title` beside an older `updatedAt` and materialize a meta record that never
 * existed on the host.
 *
 * ## Why a WRAPPER rather than `revision` inline on the record
 *
 * The other rows (artifacts, tombstones) carry `revision` inline, and meta
 * deliberately does not - because of the DELTA, where meta travels as a
 * PARTIAL. A partial's key set means "the fields this commit changed", so a
 * `revision` sitting inside it is a key that is present on every patch while
 * not being a patched field. A consumer spreading the patch over its held
 * record would write `revision` into the meta itself.
 *
 * The wrapper makes that separation structural instead of conventional, so
 * there is no rule for a later reader to know. It is also why the inline form
 * cannot simply be `.partial()`d: applying `.partial()` to a revision-extended
 * record makes `revision` OPTIONAL, silently deleting the guard on the one
 * frame that most needs it.
 */
export const epicStateMetaProjectionSchema = z.object({
  ...epicLaneRowRevisionFields,
  meta: epicMetaSchema,
});
export type EpicStateMetaProjection = z.infer<
  typeof epicStateMetaProjectionSchema
>;

/**
 * The delta counterpart: the meta fields this commit changed, at the revision
 * the whole record reached.
 *
 * `meta` is PARTIAL - `title` and `updatedAt` move independently and a
 * whole-object push would force the host to restate a title it did not re-read.
 * `revision` is REQUIRED and describes the record, not the patch: it is the
 * entity's revision AFTER this commit, so a consumer applies the patch only
 * when it strictly exceeds the revision it holds.
 */
export const epicStateMetaPatchSchema = z.object({
  ...epicLaneRowRevisionFields,
  meta: epicMetaSchema.partial(),
});
export type EpicStateMetaPatch = z.infer<typeof epicStateMetaPatchSchema>;

/**
 * The role-claims projection carried on this lane: a whole SET, revisioned as a
 * set rather than per row.
 *
 * ## Why whole-set replacement
 *
 * Claims are a handful of small rows per epic, the host already computes the
 * visible projection in one pass (`projectVisibleRoleClaims` - filtered by
 * account, then by live agents), and a per-claim delta would force the client
 * to re-derive a filter the host is the only party able to evaluate. A claim
 * that leaves the projection because its agent died is not a "removal" any
 * per-row tombstone could express.
 *
 * ## Why the revision is on the SET and not on each claim
 *
 * This is the one record population on the lane where a per-row revision would
 * be the wrong shape, and the reason is the entity's lifecycle: a claim is
 * CREATED (`agent.roles.claim`) and DESTROYED (`agent.roles.relinquish`) and
 * never updated, so a per-claim revision would be a constant - a guard against
 * a change that cannot happen. What actually races is the SET, and the set
 * revision is what fences it: apply a replacement only when its revision
 * strictly exceeds the one held.
 *
 * That race is real rather than theoretical, because claims DO have a second
 * delivery path: `agent.roles.list` is installed and a client may read it
 * directly. Note honestly what this contract can and cannot do about that -
 * `agent.roles.list` is a released line and carries no revision, so it cannot
 * be fenced against this one today. Until it grows one, the runtime must treat
 * THIS LANE as authoritative for role claims and never let a poll answer
 * overwrite lane state. The set revision is what a later `agent.roles.list`
 * minor would carry to close the gap properly.
 */
export const epicStateRoleClaimsProjectionSchema = z.object({
  ...epicLaneRowRevisionFields,
  claims: z.array(roleClaimSchema),
});
export type EpicStateRoleClaimsProjection = z.infer<
  typeof epicStateRoleClaimsProjectionSchema
>;

/**
 * One epic-files manifest entry on the records lane: the path that keys it in
 * the sibling `files` Y.Map (D02), plus the entry itself.
 *
 * The entry reuses `epicFileEntrySchema` verbatim - the same shape the doc
 * stores and the same shape `@traycerai/common/yjs/epic-files` parses - so the
 * lane head and the doc head cannot disagree about what a file IS. Per-ENTRY
 * leniency stays where the manifest already puts it: the PRODUCER parses each
 * key on its own and drops only the ones it cannot read, so an entry written by
 * a newer host never blocks the rest of the manifest from reaching a client.
 */
export const epicFileWireEntrySchema = z.object({
  path: z.string(),
  entry: epicFileEntrySchema.extend({
    /**
     * Restated WITHOUT the reader-side cap `.transform`, and only that.
     *
     * The persisted schema trims `versions` to `EPIC_FILE_VERSIONS_CAP` in a
     * `.transform`, which the protocol SURFACE builder cannot render into JSON
     * Schema ("Transforms cannot be represented in JSON Schema") - so an entry
     * carrying it could not be described on a wire contract at all. Nothing is
     * lost: the producer parses every entry through `epicFileEntrySchema`
     * before it reaches this frame, so the trim has already happened, and the
     * parsed type is identical on both sides of the substitution.
     */
    versions: z.array(epicFileObjectSchema).default([]),
  }),
});
export type EpicFileWireEntry = z.infer<typeof epicFileWireEntrySchema>;

/**
 * The manifest projection carried on this lane: the whole SET, revisioned as a
 * set, exactly like {@link epicStateRoleClaimsProjectionSchema}.
 *
 * ## Why the lane carries it at all
 *
 * The manifest is a sibling `Y.Map` on the epic root doc, and a lane connection
 * HAS NO ROOT DOC. Everything downstream of the projection - the Files panel,
 * the `epic-file` tile, the quote affordances - reads one `FilesSlice`, so on
 * the lane head that slice was structurally empty and the panel rendered as if
 * the epic had no files at all. This is that population's record-plane form.
 *
 * ## Why whole-set replacement rather than a row per path
 *
 * Same shape as the claims for the same reason: the host reads the manifest in
 * one lenient pass (unparsable keys are already dropped there), the set is
 * small and bounded, and a per-path delta would need a tombstone vocabulary the
 * manifest already expresses inside the entry (`deletedAt`). Tombstoned entries
 * TRAVEL - the deleted list is live state a restore affordance reads - so a
 * per-path removal would carry no fact the entry does not already state.
 */
export const epicStateFilesProjectionSchema = z.object({
  ...epicLaneRowRevisionFields,
  files: z.array(epicFileWireEntrySchema),
});
export type EpicStateFilesProjection = z.infer<
  typeof epicStateFilesProjectionSchema
>;

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
 * - `revision` - the per-row monotonic staleness test every row on this lane
 *   carries (see {@link epicLaneRowRevisionSchema}). It matters most acutely
 *   here, because comment threads have a SECOND delivery path
 *   (`epic.listCommentThreads`, kept for cold reads), so a slow unary answer
 *   can genuinely land after a newer push. Apply an upsert only when its
 *   revision strictly EXCEEDS the one held.
 */
export const epicCommentThreadRecordSchema = commentThreadWireSchema.extend({
  artifactId: z.string().min(1),
  ...epicLaneRowRevisionFields,
});
export type EpicCommentThreadRecord = z.infer<
  typeof epicCommentThreadRecordSchema
>;

/**
 * A comment thread's removal, addressed by its row key.
 *
 * Removal is TERMINAL AND ABSORBING: it applies unconditionally and
 * idempotently, and no later upsert - however high its revision - resurrects
 * the thread on a client that has seen this. That is what makes replayed and
 * reordered deltas harmless without any merge logic (the
 * `host.chatRecords.subscribe` `remove` precedent).
 *
 * It carries a `revision` anyway, and the two statements are not in tension.
 * The revision does not GATE the removal - a tombstone at a lower revision than
 * an upsert the client already applied still absorbs. It records WHERE in the
 * thread's history the removal sits, which is what lets a reconciler order two
 * removals against each other and keep retraction memory that survives a
 * reconnect. Without it, "removed" is a fact with no position, and the
 * client seam has nowhere to put it.
 */
export const epicCommentThreadRemovalSchema = z.object({
  artifactId: z.string().min(1),
  threadId: z.string().min(1),
  ...epicLaneRowRevisionFields,
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
  epicMeta: epicStateMetaProjectionSchema,
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
  roleClaims: epicStateRoleClaimsProjectionSchema,
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
 *
 * It also restates `reconciledWithCloud`, which is the ONE fact a resuming
 * client cannot carry over from its previous session. Every other thing this
 * frame omits is genuinely unchanged - the client still holds its rows, and
 * that is the point of resuming. Trust is not row state: it describes the
 * SERVING HOST'S replica, which may have restarted seed-only since the cursor
 * was persisted. A client that kept its old value would resume believing it was
 * reconciled against a host that is not, which is the more dangerous direction
 * of the same bug `trustChanged` exists to fix.
 */
const epicStateSubscribeResumedFrameSchemaV10 = z.object({
  kind: z.literal("resumed"),
  ...epicLaneEpochFrameFields,
  position: epicLanePositionSchema,
  /** Current trust, restated - see the frame doc above for why it cannot be
   * inherited from the client's previous session. */
  reconciledWithCloud: z.boolean(),
  ...epicLaneTextFrameFields,
});

/**
 * The seed-trust marker FLIPPED. No rows changed, and that is precisely why
 * this frame has to exist.
 *
 * ## Why the delta path cannot carry it
 *
 * A background reconcile that finds the local replica already correct changes
 * NO ROW. There is nothing for a `delta` envelope to carry, and the envelope
 * refuses to be empty by design - an empty envelope would consume a lane
 * position for a commit that never happened. Nor can the host re-emit a
 * `snapshot`: `basis` has no member a trust flip could honestly claim (`cold`,
 * `authorityEpochChanged` and `resumeTooOld` are all false), and re-sending
 * every row to move one boolean is the whole-document behaviour these lanes
 * exist to retire.
 *
 * So the fact had no way to reach a client that was already attached. Observed
 * end to end: a seed-only snapshot, then the cloud connects, then zero events -
 * and the client labels its data seed-only forever. Wire-lane invariant 7's
 * freshness marker could be set but never cleared, so any privileged action
 * gated on it stayed gated for the life of the subscription.
 *
 * ## Why it is not read off the control lane
 *
 * `epic.status.subscribe`'s `cloudSyncStatus` is a different fact with a
 * different lifetime: it is the host's CONNECTION state, while this is whether
 * THIS LANE'S rows have been reconciled against the cloud. A connected socket
 * does not mean the reconcile finished, and a dropped socket does not un-do one
 * that did. Deriving trust from the other lane would also blend two classes
 * into one displayed claim, which the north-star forbids - freshness is labelled
 * PER CLASS, and this is the records class's own label.
 *
 * ## Ordering
 *
 * Carries no `seq` and consumes no lane position, for the same reason the delta
 * path could not carry it: nothing was committed. It is ordered only by
 * arrival, within its `authorityEpoch`. A client applies it by overwriting its
 * held trust value - there is no revision guard because there is no entity, and
 * the host is the sole writer.
 *
 * The snapshot's and `resumed`'s `reconciledWithCloud` are this frame's
 * CURRENT-STATE PROJECTION - the completeness rule the control lane states in
 * full, applied here: a client that attaches after the flip reads trust off its
 * lead frame and needs no replay.
 */
const epicStateSubscribeTrustChangedFrameSchemaV10 = z.object({
  kind: z.literal("trustChanged"),
  ...epicLaneEpochFrameFields,
  reconciledWithCloud: z.boolean(),
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
   * The epic metadata this commit changed, at the revision the record reached,
   * or `null` when the commit changed no metadata. See
   * {@link epicStateMetaPatchSchema} - the revision sits OUTSIDE the partial so
   * it cannot be mistaken for a patched field, and so `.partial()` cannot make
   * it optional.
   */
  epicMeta: epicStateMetaPatchSchema.nullable(),
  /**
   * The complete visible role-claim set after this commit, or `null` when the
   * commit did not touch claims. Whole-set replacement, carrying the set's own
   * revision - see {@link epicStateRoleClaimsProjectionSchema} for why claims
   * are revisioned as a set rather than per row.
   */
  roleClaims: epicStateRoleClaimsProjectionSchema.nullable(),
  ...epicLaneTextFrameFields,
});

/**
 * The minimal SUPERTYPE the envelope invariant reads, declared by hand so the
 * refine can be shared across future minors' unions without a circular
 * const/type reference (an inferred type would name the refine that builds it).
 * This is the `EnvelopeCheckedFrame` idiom from `chat-records.ts`.
 */
type EmptinessCheckedDelta = {
  readonly kind: "delta";
  readonly artifactUpserts: readonly unknown[];
  readonly artifactTombstones: readonly unknown[];
  readonly commentThreadUpserts: readonly unknown[];
  readonly commentThreadRemovals: readonly unknown[];
  readonly epicMeta: unknown;
  readonly roleClaims: unknown;
};

type EmptinessCheckedLeadFrame =
  | { readonly kind: "snapshot" }
  | { readonly kind: "resumed" }
  | { readonly kind: "trustChanged" }
  | { readonly kind: "pong" };

type EmptinessCheckedFrame = EmptinessCheckedDelta | EmptinessCheckedLeadFrame;

/**
 * `@1.1`'s supertype: the same delta plus the manifest field. Spelled as its
 * own union rather than an optional key on the one above, because an optional
 * `files` would make "this is a `@1.0` delta" and "a `@1.1` producer forgot the
 * field" the same observation - the exact confusion the required-and-empty rule
 * on the delta frame exists to refuse.
 */
type EmptinessCheckedFrameV11 =
  | (EmptinessCheckedDelta & {
      /**
       * OPTIONAL because the `@1.1` union is the superset a client decodes a
       * `@1.0` host's frames through too, so the key genuinely may not be
       * there. The refine below therefore tests both `null` (a `@1.1` commit
       * that changed no file) and `undefined` (a host that carries no
       * manifest); neither is a change.
       */
      readonly files?: unknown;
    })
  | EmptinessCheckedLeadFrame;

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
function deltaCarriesChange(frame: EmptinessCheckedDelta): boolean {
  return (
    frame.artifactUpserts.length > 0 ||
    frame.artifactTombstones.length > 0 ||
    frame.commentThreadUpserts.length > 0 ||
    frame.commentThreadRemovals.length > 0 ||
    frame.epicMeta !== null ||
    frame.roleClaims !== null
  );
}

function addEmptyEnvelopeIssue(ctx: z.RefinementCtx): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["kind"],
    message:
      "A delta envelope must carry at least one change - an empty envelope consumes a lane position for a commit that never happened.",
  });
}

function refineDeltaCarriesChange(
  frame: EmptinessCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "delta") return;
  if (deltaCarriesChange(frame)) return;
  addEmptyEnvelopeIssue(ctx);
}

/** `@1.1`: a manifest change is a change, so a files-only envelope is legal. */
function refineDeltaCarriesChangeV11(
  frame: EmptinessCheckedFrameV11,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "delta") return;
  if (deltaCarriesChange(frame)) return;
  // `undefined` as well as `null`: `files` is optional on this union so a
  // `@1.0` host's frame still parses through it, and an absent manifest is no
  // more a change than an unchanged one.
  if (frame.files !== null && frame.files !== undefined) return;
  addEmptyEnvelopeIssue(ctx);
}

const epicStateSubscribePongFrameSchemaV10 = z.object({
  kind: z.literal("pong"),
  // No epoch stamp: heartbeats are intercepted by the shared connection
  // handler before a resolver is selected, so there is no resolver to mint
  // one. Same transport-level shape as every other lane's `pong`.
  ...epicLaneTextFrameFields,
});

export const epicStateSubscribeServerFrameSchemaV10 = z
  .discriminatedUnion("kind", [
    epicStateSubscribeSnapshotFrameSchemaV10,
    epicStateSubscribeResumedFrameSchemaV10,
    epicStateSubscribeDeltaFrameSchemaV10,
    epicStateSubscribeTrustChangedFrameSchemaV10,
    epicStateSubscribePongFrameSchemaV10,
  ])
  .superRefine(refineDeltaCarriesChange);
export type EpicStateSubscribeServerFrameV10 = z.infer<
  typeof epicStateSubscribeServerFrameSchemaV10
>;

/**
 * The first `epic.state.subscribe` minor carrying the epic-files manifest, and
 * therefore the floor the host must clear before putting it on the wire.
 *
 * `@1.0` shipped in cli-v1.3.0 and is frozen there. The manifest was NOT added
 * to it, for the reason the durability legs on `epic.status.subscribe` proved
 * the hard way: a `.default([])` protects a NEW client reading an OLD host and
 * does nothing for the case the release baseline actually gates - an old client
 * decoding a new host's extra keys on a host->client slot. Exported because the
 * schema and the emission gate are ONE fact.
 */
export const EPIC_STATE_FILES_MINOR = 1;

const epicStateSubscribeSnapshotFrameSchemaV11 =
  epicStateSubscribeSnapshotFrameSchemaV10.extend({
    /**
     * Every manifest entry, tombstones included - see the projection's doc.
     *
     * OPTIONAL, like `epic.status.subscribe@1.1`'s legs and for the same
     * reason: this superset is what a `@1.1` client parses EVERY frame
     * through, including one from a host that negotiated `@1.0` and sends no
     * manifest at all. Absent therefore means "this host said nothing about
     * files", which is not the same claim as `files: []` ("this epic has
     * none") - and a consumer that conflated them would render an empty Files
     * panel as authoritative on a host that has no file plane.
     */
    files: epicStateFilesProjectionSchema.optional(),
  });

const epicStateSubscribeDeltaFrameSchemaV11 =
  epicStateSubscribeDeltaFrameSchemaV10.extend({
    /**
     * The complete manifest after this commit, or `null` when the commit did
     * not touch it. Whole-set replacement, carrying the set's own revision -
     * the same contract `roleClaims` has one field up.
     */
    files: epicStateFilesProjectionSchema.nullable().optional(),
  });

/**
 * `@1.1` server frames: `@1.0` plus the manifest on the two frames that state
 * row content. Composed from `@1.0`'s own members rather than restated, so
 * `@1.1` differs from `@1.0` in exactly the two variants named here.
 */
export const epicStateSubscribeServerFrameSchemaV11 = z
  .discriminatedUnion("kind", [
    epicStateSubscribeSnapshotFrameSchemaV11,
    epicStateSubscribeResumedFrameSchemaV10,
    epicStateSubscribeDeltaFrameSchemaV11,
    epicStateSubscribeTrustChangedFrameSchemaV10,
    epicStateSubscribePongFrameSchemaV10,
  ])
  .superRefine(refineDeltaCarriesChangeV11);
export type EpicStateSubscribeServerFrameV11 = z.infer<
  typeof epicStateSubscribeServerFrameSchemaV11
>;

/**
 * The downgrade bridge for a peer below {@link EPIC_STATE_FILES_MINOR}.
 *
 * The host composes `@1.1` frames unconditionally and projects here, per
 * SUBSCRIBER, on the way out - the same shape `epicStatusFrameForNegotiatedMinor`
 * takes, and per subscriber for the same reason: one session fans one delta out
 * to subscribers that negotiated different minors.
 *
 * `null` means DO NOT SEND, and only a delta can produce it: a commit that
 * changed nothing but the manifest projects to an EMPTY `@1.0` envelope, which
 * that line refuses by construction because an empty envelope consumes a lane
 * position for a commit that never happened. Dropping it is safe and is not a
 * gap: the adapter records its cursor from whatever frame arrives, so an `@1.0`
 * peer that never sees the frame stays exactly as current as it can be about
 * everything it is able to render.
 */
export function epicStateFrameForNegotiatedMinor(
  frame: EpicStateSubscribeServerFrameV11,
  negotiatedMinor: number,
): EpicStateSubscribeServerFrameV10 | null {
  if (negotiatedMinor >= EPIC_STATE_FILES_MINOR) {
    // `@1.1` is a superset of `@1.0` in TYPE as well as on the wire, so the
    // frame passes through unchanged and the return type stays honest.
    return frame;
  }
  if (frame.kind === "snapshot") {
    const { files: _files, ...projected } = frame;
    return projected;
  }
  if (frame.kind !== "delta") return frame;
  const { files: _files, ...projected } = frame;
  return deltaCarriesChange(projected) ? projected : null;
}

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

/** Additive minor: same open request and client frames; the epic-files manifest
 * joins the `snapshot` and `delta` server frames. `@1.0` shipped in cli-v1.3.0
 * and is frozen there. */
export const epicStateSubscribeV11 = defineStreamRpcContract({
  method: "epic.state.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: epicStateSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicStateSubscribeServerFrameSchemaV11,
  clientFrameSchema: epicStateSubscribeClientFrameSchemaV10,
});
