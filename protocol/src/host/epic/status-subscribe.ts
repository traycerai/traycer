/**
 * `epic.status.subscribe@1.0` - the epic's CONTROL lane: how healthy is this
 * session.
 *
 * The urgent-delivery sibling of `epic.state.subscribe`. It carries the facts
 * that change what a client is ALLOWED or ABLE to do - permission and its
 * security epoch, whether the host's cloud connection is up, whether the host
 * still holds unacknowledged work, whether the epic was deleted underneath the
 * tab, and the lifecycle of a major migration.
 *
 * ## Why two lanes and not one, and not five
 *
 * "What is in the epic" and "how healthy is the session" have different urgency
 * (a permission revocation must not queue behind a delta backlog), different
 * cursor needs (control state is a fixed-size snapshot, not a log), and
 * different consumers (the sync pill and the permission gates never read the
 * artifact tree). Splitting finer than this adds subscriptions with no gain;
 * the monolith's mistake was bundling unrelated cursor domains onto one channel
 * so that neither could be reasoned about.
 *
 * ## No resume cursor at `@1.0`, deliberately
 *
 * Every fact on this lane is CURRENT-STATE, not history: the entire control
 * state fits in one `snapshot` frame, and a client that missed transitions
 * while disconnected converges by reading the next snapshot rather than by
 * replaying them. There is no delta log behind this lane, so a cursor would be
 * a promise the wire made and the implementation could not keep - the same
 * judgement `host.chatRecords.subscribe@1.0` recorded for the same reason. A
 * cursor is exactly the kind of thing a later ADDITIVE MINOR can add once
 * something exists to seek in.
 *
 * `authorityEpoch` is still stamped on every frame, and is not a cursor: it is
 * how the client learns the host's replica was replaced (migration, compaction,
 * or a host that upgraded from the legacy monolith under an open tab) so it can
 * reconcile this lane against `epic.state.subscribe`, which re-seeds on the
 * same event.
 *
 * ## THE RULE THAT MAKES CURSOR-LESS HONEST
 *
 * Dropping the cursor is only defensible if the snapshot is COMPLETE. So:
 *
 *   **Every non-`snapshot` server frame kind MUST have a current-state
 *   projection on the `snapshot` frame, or a stated reason why absence is
 *   itself the state.**
 *
 * Without that rule, a transition-only fact silently becomes unrecoverable
 * across a reconnect: the client missed the frame, no cursor can replay it, and
 * the snapshot does not mention it - so the fact is simply gone, and the client
 * renders a session it believes is healthy. This is not hypothetical; the
 * migration frames shipped that way in the first cut of this contract, and a
 * client reconnecting mid-migration could not distinguish "no migration" from
 * "migration running, next progress frame pending" while the state lane held
 * its snapshot for the same migration.
 *
 * The sweep, kind by kind - extend it when adding a frame:
 *
 * | Frame kind            | Projection on `snapshot`      |
 * | --------------------- | ----------------------------- |
 * | `permissionChanged`   | `permissionRole`, `securityEpoch` |
 * | `cloudSyncStatus`     | `cloudSyncStatus`             |
 * | `dirtyChanged`        | `dirty`                       |
 * | `epicDeleted`         | `deletion`                    |
 * | `migrationStarted`    | `migration.state === "running"` |
 * | `migrationProgress`   | `migration.progress`          |
 * | `migrationFailed`     | `migration.state === "failed"` |
 * | `migrationNotAllowed` | `migration.state === "notAllowed"` |
 * | `pong`                | none - transport heartbeat, carries no session state |
 *
 * `pong` is the only exempt kind, and it is exempt because it is not a fact
 * about the epic at all.
 *
 * ## Aggregate dirty, and the two places UNKNOWN lives
 *
 * `dirty` is ONE aggregate per epic: the host folds root and every live room
 * into it, because that aggregation is over the host's own durability legs and
 * the per-room granularity the monolith shipped had no consumer - the sync pill
 * only ever read `unknown | clean | dirty`.
 *
 * Snapshot-then-delta, and UNKNOWN is never clean. Under-reporting dirtiness is
 * the dangerous direction: a pill that says "all changes synced" over work the
 * cloud has never seen is a claim about the user's data that nothing supports.
 * This is the rule `epic.subscribe@1.1`'s `dirtySnapshot` established, and it is
 * restated here because it was learned rather than designed.
 *
 * UNKNOWN now has TWO representations, and they are different situations:
 *
 * 1. **Pre-snapshot silence.** No snapshot has arrived; the client knows
 *    nothing about any field. Out of band, by construction.
 * 2. **`dirty: null` INSIDE a snapshot.** A snapshot has arrived and the host is
 *    explicitly stating it has not established dirtiness. In band, because the
 *    snapshot-first invariant forces a truthful snapshot before the epic is
 *    open - see the pre-open basis section below.
 *
 * The second exists because the first could not cover it without breaking the
 * lane's own ordering rule. Buffering the snapshot until dirtiness is knowable
 * would mean no snapshot during a migration - the exact window a client most
 * needs one - and synthesizing `false` would be the false-clean claim above. So
 * "not established" became a value rather than a delay. Both map onto the same
 * pill state; neither may be rendered as clean.
 *
 * ## The pre-open control basis
 *
 * Migrations run DURING the epic open, and this lane is snapshot-first, so the
 * host must emit a truthful snapshot BEFORE the epic is open. Every field has to
 * have an honest value in that state, and only two did not:
 *
 * | Snapshot field    | Pre-open value | Why it is truthful there |
 * | ----------------- | -------------- | ------------------------ |
 * | `authorityEpoch`  | the host's current replica identity | host-owned, always known |
 * | `securityEpoch`   | the persisted host-local epoch | host-owned, persisted beside the lane cursors |
 * | `permissionRole`  | `null` | already means "not known here", not "no access" |
 * | `cloudSyncStatus` | `disconnected` | an OBSERVATION - no room is open, so nothing is connected. Safe direction |
 * | `migration`       | the real state | host-domain state the host owns directly; this is *why* the pre-open snapshot exists |
 * | `dirty`           | `null` | composes from live-connection state; offline teardown folds edits back into the seed, so disk cannot distinguish unsynced from reconciled |
 * | `deletion`        | `{state:"unknown"}` | deletion leaves no local marker in either direction - a local delete unlinks the seed dir (an absence), a remote delete leaves nothing until the room reports |
 *
 * The rule this encodes: a snapshot field either has a truthful value in every
 * state the lane can be in, or it carries an explicit NOT-ESTABLISHED value.
 * Never a synthesized default, and never a buffered snapshot.
 *
 * Frame ordering for a failed open, since it is the sequence that motivated all
 * of this and the one a client is most likely to get wrong:
 *
 *     snapshot(pre-open basis, migration running) -> migrationProgress... ->
 *     migrationFailed -> termination
 *
 * The client renders the migration modal off the SNAPSHOT, not off
 * `migrationStarted` - which it may never see, because the migration was already
 * running when it attached.
 *
 * What this lane emits is one INPUT to the sync pill, not the pill. Aggregating
 * the host's durability legs into a boolean is fine; blending unrelated
 * CLASSES - transport status, cloud freshness, unacked commands, rejected
 * commands - into one displayed claim is what the north-star forbids, and this
 * lane deliberately does not do it: the other inputs stay separate fields and
 * separate lanes.
 *
 * ## The security epoch, scoped honestly
 *
 * `securityEpoch` is HOST-LOCAL at `@1.0`. The host increments it when IT
 * learns of a permission change - today that means a cloud denial on the next
 * operation, or a permission frame from the room - persists it beside the lane
 * cursors, and stamps permission frames with it. Privileged unaries validate
 * against the host's current epoch, so a client acting on a stale epoch is
 * refused rather than served.
 *
 * An authoritative cloud->host revocation PUSH does not exist today and this
 * contract does not assume one. That propagation contract is recorded as open
 * work, not as a dependency of this lane, and the field is named for what it
 * is so a later reader cannot mistake it for a cloud-issued epoch. The honest
 * promise is access CESSATION, not retroactive erasure: a partitioned client
 * retains what it already decrypted.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  epicLaneEpochFrameFields,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";
// The cloud-sync and migration-phase vocabularies are imported from the
// monolith rather than restated, so the lanes and the `@1` line that keeps
// serving released GUIs cannot drift into two spellings of one fact.
//
// The coupling runs one way and must be respected: both enums are FROZEN by
// `epic.subscribe@1.x`'s released baseline. A new member added to either const
// would grow a released line, silently, on a method whose name gives no hint it
// carries an enum - the `chatRunSettingsHarnessIdSchemaV10` trap. When this
// lane needs a value the monolith never shipped, fork a `...V11` copy HERE and
// leave the shared const alone.
import {
  epicCloudSyncStatusSchema,
  epicMigrationPhaseSchema,
} from "@traycer/protocol/host/epic/subscribe";

const permissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role",
  "latest",
);

/**
 * WHO deleted the epic, when the host observed a remote deletion.
 *
 * One shape used in TWO places - the `epicDeleted` transition frame and the
 * snapshot's current-state projection of it - rather than two flat field pairs
 * that could drift. Both members are nullable because attribution is
 * best-effort: the host may know the epic is gone without knowing who removed
 * it, and "deleted by nobody we can name" must stay renderable.
 */
export const epicDeletionAttributionSchema = z.object({
  deletedByDisplayName: z.string().nullable(),
  deletedByTraycerUserId: z.string().nullable(),
});
export type EpicDeletionAttribution = z.infer<
  typeof epicDeletionAttributionSchema
>;

/**
 * Whether this epic has been deleted - as THREE states, not two.
 *
 * ## Why a discriminated union and not `attribution | null`
 *
 * The obvious shape - attribution when deleted, `null` otherwise - encodes two
 * states, and this fact has three. The third is "not established yet", and it
 * is not a hypothetical: the snapshot-first invariant obliges the host to send a
 * truthful snapshot BEFORE the epic is open (see the pre-open basis section in
 * the module doc), and at that point NOTHING ON DISK CAN ANSWER THIS QUESTION.
 *
 * Deletion leaves no local marker to read, in either direction. A local delete
 * UNLINKS the seed directory - the evidence is an absence, and an absence is
 * equally consistent with "never opened here". A remote delete leaves nothing at
 * all until the cloud room reports it. So a pre-open host that answered "not
 * deleted" would be asserting a fact it cannot observe, for an epic that may
 * have been deleted by a collaborator while this host was offline - and the
 * client would render a healthy session for an epic that no longer exists.
 *
 * `null` was already TAKEN by the two-state shape, meaning "not deleted". A
 * third state could only have been squeezed in by overloading it, which would
 * make the SAFE reading and the UNKNOWN reading the same wire value - exactly
 * the collapse the `dirty` tri-state exists to prevent one field over. So the
 * shape is redefined rather than extended, which is free here: the line is
 * unreleased.
 *
 * ## The states
 *
 * - `unknown`  - the host cannot answer yet. Render the epic, do NOT claim it
 *   is alive, and do not act on deletion either way. Resolves to one of the
 *   other two once the epic is open.
 * - `none`     - ESTABLISHED not-deleted. The host has an open room (or an
 *   authoritative local answer) and the epic is live.
 * - `deleted`  - the epic is gone, with whatever attribution the host has.
 *
 * `unknown` is NOT a one-way latch. A snapshot re-issued after an
 * `authorityEpoch` change may legitimately return to `unknown`, because a
 * replica replacement puts the host back in the pre-open state it was in the
 * first time.
 *
 * The `deleted` arm carries {@link epicDeletionAttributionSchema} - the SAME
 * shape the `epicDeleted` transition frame carries, so the transition and its
 * current-state projection cannot disagree about what attribution is. Nesting
 * it under the arm rather than beside the discriminator also means attribution
 * exists only where it is meaningful; there is no `unknown` state carrying a
 * vestigial null attribution for a reader to misinterpret.
 */
export const epicDeletionStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }),
  z.object({ state: z.literal("none") }),
  z.object({
    state: z.literal("deleted"),
    attribution: epicDeletionAttributionSchema,
  }),
]);
export type EpicDeletionStatus = z.infer<typeof epicDeletionStatusSchema>;

/**
 * The CURRENT state of a major migration, as the snapshot projects it.
 *
 * This exists because the control lane has no resume cursor, and that model is
 * only honest if the snapshot is COMPLETE. Without this field a client
 * reconnecting mid-migration receives a snapshot that says nothing about the
 * migration and cannot distinguish "no migration" from "a migration is running
 * and the next progress frame has not arrived yet" - while the state lane is
 * silently holding its own snapshot for the same migration. The client would
 * render an epic that appears merely slow, with no modal and no explanation,
 * for as long as the migration takes.
 *
 * Discriminated on `state` rather than flattened into nullable siblings so the
 * per-state fields cannot be read in a combination that never occurs (a
 * `reason` on a running migration, a `phase` on a failed one).
 *
 * - `running`   - started, and not yet finished or failed. `progress` is `null`
 *   between `migrationStarted` and the first `migrationProgress`, which is a
 *   real window a reconnect can land in - encoding it as `0 / 1` instead would
 *   claim a determinate fraction the host has not measured.
 * - `failed`    - terminal for this attempt; `epic.retryMigration` is the way
 *   out. `reason` carries the same host-side summary the `migrationFailed`
 *   frame does, and is likewise never rendered as product copy.
 * - `notAllowed` - the epic needs a migration this caller lacks the write
 *   access to perform. Terminal and NOT retryable, which is the whole reason it
 *   is a separate state rather than a `failed` with a particular reason.
 *
 * There is no `completed` state: a finished migration leaves the epic in its
 * ordinary condition under a new `authorityEpoch`, so `null` covers both "never
 * needed one" and "finished". Adding a terminal success state would create a
 * value every snapshot would have to carry forever with nothing to say.
 */
export const epicMigrationStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("running"),
    progress: z
      .object({
        phase: epicMigrationPhaseSchema,
        chunksDone: z.number().int().nonnegative(),
        chunksTotal: z.number().int().positive(),
      })
      .nullable(),
  }),
  z.object({
    state: z.literal("failed"),
    reason: z.string(),
  }),
  z.object({
    state: z.literal("notAllowed"),
  }),
]);
export type EpicMigrationStatus = z.infer<typeof epicMigrationStatusSchema>;

/**
 * The host-local authorization epoch for this epic/member.
 *
 * Monotonic per host and NOT comparable across hosts - it names how many times
 * THIS host has learned that the caller's access changed, which is a different
 * number on a peer host serving the same shared epic. A client keys it
 * alongside the `hostId` its tab is bound to, and never compares two hosts'
 * epochs.
 *
 * A number rather than an opaque string, unlike `authorityEpoch`: the only
 * useful operation is "is this newer than the one I acted under", which is an
 * ORDER, and the host is the sole writer so the order is well defined.
 */
export const epicSecurityEpochSchema = z.number().int().nonnegative();
export type EpicSecurityEpoch = z.infer<typeof epicSecurityEpochSchema>;

/**
 * The open request. `epicId` and nothing else - see the module doc for why
 * there is no resume cursor at `@1.0`.
 */
export const epicStatusSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string().min(1),
});
export type EpicStatusSubscribeOpenRequestV10 = z.infer<
  typeof epicStatusSubscribeOpenRequestSchemaV10
>;

/**
 * The atomic control-lane snapshot. Exactly one per subscribe / resubscribe
 * cycle, and the FIRST frame of that cycle.
 *
 * Receipt of this single frame IS snapshot completion - there is no sentinel
 * and no ordering contract over N separate frames, which is the shape
 * `epic.subscribe@1.1`'s `dirtySnapshot` settled on after the per-signal
 * alternative proved unorderable. Every field below is restated in full even
 * when unchanged since the previous cycle, because a client reconnecting has no
 * way to know what it missed.
 *
 * Before this frame arrives, every field it carries is UNKNOWN to the client -
 * emphatically including `dirty`, which must not render as clean.
 */
const epicStatusSubscribeSnapshotFrameSchemaV10 = z.object({
  kind: z.literal("snapshot"),
  ...epicLaneEpochFrameFields,
  securityEpoch: epicSecurityEpochSchema,
  /**
   * The caller's role on this epic, or `null` when the host cannot currently
   * attribute one. `null` is not "no access" - it is "not known here" - and a
   * client must gate on an authority check rather than reading it as a
   * permission verdict.
   */
  permissionRole: permissionRoleSchema.nullable(),
  /**
   * Host-observed cloud room state. Truthful even on a pre-open snapshot: a
   * host that has not opened the room has no cloud connection for this epic, so
   * `disconnected` is an OBSERVATION, not a placeholder, and it is the safe
   * direction (nothing renders as synced). Do not "fix" this into a tri-state -
   * unlike `dirty` and `deletion` below, this field has a truthful value in
   * every state the lane can be in.
   */
  cloudSyncStatus: epicCloudSyncStatusSchema,
  /**
   * The aggregate dirty flag, or `null` when the host cannot answer yet.
   *
   * Three states, mapping 1:1 onto the pill's `unknown | clean | dirty`.
   * `null` is not a default and never synthesized - it is the host stating that
   * it has not established dirtiness, which is the honest answer on a snapshot
   * emitted before the epic is open.
   *
   * Why it cannot be answered pre-open: dirtiness composes from LIVE CONNECTION
   * state, and the offline-teardown path folds a session's edits back into the
   * seed. Nothing on disk distinguishes a seed carrying unsynced offline edits
   * from a fully reconciled one. So `false` pre-open would be precisely the
   * false-clean claim this lane forbids - "all changes synced" over work the
   * cloud has never seen.
   *
   * `null` is NOT a one-way latch: a snapshot re-issued after an
   * `authorityEpoch` change may return to `null`, because a replica replacement
   * puts the host back in the pre-open state.
   */
  dirty: z.boolean().nullable(),
  /**
   * The current migration state, or `null` when no migration is running,
   * failed, or blocked. See {@link epicMigrationStatusSchema} - this field is
   * what makes the cursor-less model honest for a client that reconnects
   * mid-migration.
   *
   * Truthful pre-open, unlike its two neighbours: a migration is host-domain
   * state the host owns directly, so it knows whether one is running before any
   * room is open. This is in fact the reason a pre-open snapshot has to exist at
   * all - see the module doc.
   */
  migration: epicMigrationStatusSchema.nullable(),
  /**
   * Whether the epic has been deleted - `unknown` / `none` / `deleted`, never a
   * bare nullable. See {@link epicDeletionStatusSchema} for why this fact needs
   * three states and why `null` could not be reused for the third.
   *
   * The current-state projection of the `epicDeleted` frame. Without it, a
   * client reconnecting after a deletion - a persisted tab list, or a reconnect
   * that raced the delete - would receive a snapshot describing a healthy
   * session for an epic that no longer exists, and could only learn otherwise
   * if a transition frame it already missed were somehow re-sent.
   */
  deletion: epicDeletionStatusSchema,
  ...epicLaneTextFrameFields,
});

/**
 * A permission transition, STAMPED with the epoch that produced it.
 *
 * The stamp is the point of the frame. A bare role change tells a client what
 * to render; the epoch tells it which of its in-flight privileged operations
 * were authorized under a verdict that no longer holds, which is what makes
 * "stop further hydration and mutation the moment any serving node learns"
 * enforceable rather than aspirational.
 */
const epicStatusSubscribePermissionChangedFrameSchemaV10 = z.object({
  kind: z.literal("permissionChanged"),
  ...epicLaneEpochFrameFields,
  securityEpoch: epicSecurityEpochSchema,
  permissionRole: permissionRoleSchema.nullable(),
  ...epicLaneTextFrameFields,
});

export const epicStatusSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    epicStatusSubscribeSnapshotFrameSchemaV10,
    epicStatusSubscribePermissionChangedFrameSchemaV10,
    /**
     * Host-observed cloud room connection state. The client's own transport to
     * the host can be healthy while this is `disconnected`, which is exactly
     * why the pill cannot derive cloud freshness from its own socket.
     */
    z.object({
      kind: z.literal("cloudSyncStatus"),
      ...epicLaneEpochFrameFields,
      status: epicCloudSyncStatusSchema,
      ...epicLaneTextFrameFields,
    }),
    /**
     * Transition delta for the aggregate dirty flag, after this cycle's
     * `snapshot`. Absence means clean ONLY after that snapshot has been
     * received; before it, dirtiness is unknown.
     *
     * `dirty` here is a PLAIN BOOLEAN while the snapshot's is nullable, and the
     * asymmetry is deliberate rather than an oversight. A transition can only
     * be emitted once the host has established the fact - there is no event
     * "dirtiness became unknown", because the host does not un-learn it within a
     * subscription. So this frame carries `true` or `false` and never null, and
     * THE FIRST `dirtyChanged` AFTER A NULL SNAPSHOT IS WHAT ESTABLISHES THE
     * FACT: a client sitting on `unknown` leaves that state here, not by
     * timeout and not by assumption.
     *
     * Returning to unknown is possible, but it is a REPLICA event rather than a
     * dirtiness event: it arrives as an `authorityEpoch` change followed by a
     * fresh snapshot whose `dirty` is null again.
     */
    z.object({
      kind: z.literal("dirtyChanged"),
      ...epicLaneEpochFrameFields,
      dirty: z.boolean(),
      ...epicLaneTextFrameFields,
    }),
    /**
     * The host observed a REMOTE deletion of this epic - someone else deleted
     * it while this client had it open - carrying the attribution so the
     * renderer can force-close the tab and say who did it. One-shot and
     * terminal for the epic, not merely for this subscription.
     */
    z.object({
      kind: z.literal("epicDeleted"),
      ...epicLaneEpochFrameFields,
      /**
       * The same shape the snapshot's `deleted` field carries, deliberately:
       * the transition and its current-state projection must not be able to
       * disagree about what attribution IS.
       */
      attribution: epicDeletionAttributionSchema,
      ...epicLaneTextFrameFields,
    }),
    /**
     * A major migration is starting. Emitted before any `migrationProgress` so
     * the GUI can replace a silent skeleton with the migration modal
     * immediately.
     *
     * This is the CROSS-LANE half of the migration contract: while these frames
     * run, `epic.state.subscribe` holds its snapshot, and both lanes resume
     * from the post-migration `authorityEpoch`. That coordination replaces the
     * monolith's "migrate inside initialize" serialization, and it is a
     * designed contract precisely because it used to be an emergent one.
     */
    z.object({
      kind: z.literal("migrationStarted"),
      ...epicLaneEpochFrameFields,
      ...epicLaneTextFrameFields,
    }),
    /**
     * Progress for an in-flight migration. `chunksDone` / `chunksTotal` are an
     * opaque tick fraction for the active `phase`; only `upload` is
     * determinate, and for `prepare` / `finalize` the host sends `0 / 1` and
     * the renderer shows a spinner.
     */
    z.object({
      kind: z.literal("migrationProgress"),
      ...epicLaneEpochFrameFields,
      phase: epicMigrationPhaseSchema,
      chunksDone: z.number().int().nonnegative(),
      chunksTotal: z.number().int().positive(),
      ...epicLaneTextFrameFields,
    }),
    /**
     * Terminal failure of an in-flight migration. Emitted INSTEAD of a fatal
     * stream close so the session stays alive and the modal can drive
     * `epic.retryMigration`. `reason` is a short, user-safe summary for
     * host-side logging; the modal copy is fixed and never renders this string.
     */
    z.object({
      kind: z.literal("migrationFailed"),
      ...epicLaneEpochFrameFields,
      reason: z.string(),
      ...epicLaneTextFrameFields,
    }),
    /**
     * This epic needs a major migration and the caller lacks the write access
     * to perform it. One-shot and terminal: the host does not attempt the
     * migration, so there is nothing to retry, which is the whole distinction
     * from `migrationFailed` - a retry from THIS caller can never succeed.
     */
    z.object({
      kind: z.literal("migrationNotAllowed"),
      ...epicLaneEpochFrameFields,
      ...epicLaneTextFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type EpicStatusSubscribeServerFrameV10 = z.infer<
  typeof epicStatusSubscribeServerFrameSchemaV10
>;

/**
 * `ping` and nothing else.
 *
 * The monolith carried a `retryMigration` CLIENT frame, and that is the one
 * thing deliberately not ported: a retry is a command, it needs a reply, and a
 * frame on a fire-and-forget stream can give it neither. It moves to
 * `epic.retryMigration` as a unary.
 */
export const epicStatusSubscribeClientFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type EpicStatusSubscribeClientFrameV10 = z.infer<
  typeof epicStatusSubscribeClientFrameSchemaV10
>;

export const epicStatusSubscribeV10 = defineStreamRpcContract({
  method: "epic.status.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicStatusSubscribeOpenRequestSchemaV10,
  serverFrameSchema: epicStatusSubscribeServerFrameSchemaV10,
  clientFrameSchema: epicStatusSubscribeClientFrameSchemaV10,
});
