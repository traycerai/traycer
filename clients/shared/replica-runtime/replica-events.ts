/**
 * The vocabulary an adapter decodes INTO and a replica applies.
 *
 * This is the seam that lets a legacy `epic.subscribe@1` adapter and a
 * `epic.state.subscribe@1.0` lane adapter be indistinguishable to the
 * projection layer on identical epic content - which is the exit criterion the
 * capture/replay harness asserts.
 *
 * Every envelope is generic over the payload. The runtime cares about
 * cursoring, revisions, tombstones, barriers and trust; it does not care what a
 * row IS, and baking `@traycer/protocol` row types in here would re-couple the
 * runtime to the wire the architecture just decoupled it from. Adapters
 * instantiate these with whatever their contract serves.
 */
import type { BarrierRef, LaneCursor } from "./lane-cursor";
import type { SeedTrust } from "./freshness";

// ─── Records ──────────────────────────────────────────────────────────────

/**
 * One server-arbitrated row plus the two facts the runtime needs about it.
 *
 * `revision` is per-row monotonic and is the ONLY ordering fact a reconciler
 * may read. Never a timestamp: host clocks skew, and `updatedAt` is display
 * metadata that no ordering decision may consult.
 */
export interface RecordRow<TRow> {
  readonly rowId: string;
  readonly revision: number;
  readonly row: TRow;
}

export type RecordChange<TRow> =
  | { readonly kind: "upsert"; readonly row: RecordRow<TRow> }
  | {
      readonly kind: "remove";
      readonly rowId: string;
      /**
       * Required on a removal too, and the distinction that reads backwards at
       * first: it is CARRIED, not GATED ON.
       *
       * Removal is terminal and absorbing, so a tombstone whose revision is
       * LOWER than an upsert already applied still removes the row - "this row
       * was deleted" wins against later upserts at any revision. What the
       * number buys is placement in the entity's history: ordering removals
       * against each other, and telling a delete-then-recreate from a
       * recreate-then-delete. A removal with no revision cannot be placed at
       * all.
       *
       * So: never write `if (change.revision <= held) return` on this arm. The
       * ignore reason for a removal is `"absorbed-tombstone"`, never
       * `"stale-revision"`.
       */
      readonly revision: number;
      /**
       * Carried through to the UI. A removal the user can see a reason for is
       * the difference between "it vanished" and "it was deleted on host B".
       */
      readonly reason: string;
    };

/**
 * A typed snapshot plus the mark it was taken at.
 *
 * The snapshot rides the STREAM, never a unary. A unary snapshot with a
 * separate delta channel reintroduces the join-vs-fetch ordering race;
 * snapshot-then-deltas on one ordered channel solves it by construction, and
 * this type is the client half of that: there is no way to express a snapshot
 * without the watermark it belongs to.
 */
export interface RecordSnapshotEvent<TRow> {
  readonly kind: "record-snapshot";
  readonly watermark: LaneCursor;
  readonly rows: readonly RecordRow<TRow>[];
  /**
   * Whether the serving node had reconciled with the cloud when it took this
   * snapshot. `null` when the adapter cannot tell (every legacy adapter).
   */
  readonly trust: SeedTrust | null;
  /**
   * Why this snapshot is arriving. A reseed mid-session is materially
   * different from a first open and the replica logs it differently.
   */
  readonly cause: "initial" | "reseed";
}

/**
 * A transactional envelope: every row and tombstone a single authority-side
 * change touched, delivered atomically.
 *
 * This is where "no client-observable impossible intermediate trees" is
 * enforced. A reparent that moves a node between two parents ships both
 * affected rows in ONE envelope; splitting it across two would let the UI paint
 * a frame in which the node has no parent, or two.
 */
export interface RecordTransactionEvent<TRow> {
  readonly kind: "record-transaction";
  readonly cursor: LaneCursor;
  readonly changes: readonly RecordChange<TRow>[];
  /** Non-null only for the exceptional cross-lane case. Never inferred. */
  readonly barrier: BarrierRef | null;
}

/**
 * A full-set answer from a POLL rather than a push - `epic.listChatRecords`,
 * `epic.listTuiAgents`.
 *
 * It is not a snapshot: it carries no watermark it can claim, and it may be
 * older than pushes the client has already applied. `issuedAtFence` is what
 * makes it safe - a row this answer omits is dropped only if it was already
 * held when the answer was ISSUED. Anything ingested since is newer than the
 * poll by construction and survives it.
 *
 * Modelled here rather than left to each plane because it is currently
 * implemented three times: twice in `open-epic/store.ts` (chats, terminal
 * agents) and a third time in different vocabulary in the chat plane.
 */
export interface RecordPollAnswerEvent<TRow> {
  readonly kind: "record-poll-answer";
  readonly rows: readonly RecordRow<TRow>[];
  /**
   * The replica's ingest counter as read when the request was SENT. `null`
   * falls back to the previous answer's watermark, which is strictly weaker -
   * a caller that can capture the request-time value must.
   */
  readonly issuedAtFence: number | null;
}

/**
 * The serving node's trust in the rows it already sent CHANGED - it has
 * reconciled with the cloud since the snapshot it served from its own replica.
 *
 * ## Why the snapshot's `trust` field is not enough on its own
 *
 * Seed-first serving means a node answers from its own replica immediately and
 * reconciles upstream in the background, so the FIRST snapshot of a warm epic is
 * routinely `"seed-only"`. That is a normal state, not an error - but it is one
 * the node leaves, and a client with no event for the leaving would keep
 * labelling healthy data as stale for the rest of the session and keep gating
 * privileged actions on an authority check that is never relieved.
 *
 * A snapshot cannot carry the correction, and not merely as a matter of taste:
 * re-issuing one would mean claiming a `basis` - a fresh open, a replaced
 * replica, a refused resume - and none of those happened. Nor can a transaction
 * carry it, because a trust change touches no row, and an envelope with no
 * changes would consume a lane position for a commit that never happened.
 *
 * ## Addressed by epoch, cursored by nothing
 *
 * It carries `authorityEpoch` so a client can drop one that arrives for a
 * replica it has already replaced, and deliberately NO cursor: this is not a
 * point in the lane's history, it is a statement about the replica the history
 * belongs to. Giving it a position would let a consumer advance a resume cursor
 * past work no commit did.
 *
 * `null` trust is unrepresentable here on purpose. An adapter that cannot tell
 * reports `trust: null` on its SNAPSHOT and simply never emits this - "I cannot
 * distinguish seed from reconciled" is a property of the adapter's contract,
 * not a transition its authority can announce.
 */
export interface RecordTrustEvent {
  readonly kind: "record-trust";
  readonly authorityEpoch: string;
  readonly trust: SeedTrust;
}

export type RecordReplicaEvent<TRow> =
  | RecordSnapshotEvent<TRow>
  | RecordTransactionEvent<TRow>
  | RecordPollAnswerEvent<TRow>
  | RecordTrustEvent;

// ─── Logs ─────────────────────────────────────────────────────────────────

/** A half-open ordinal range, `[fromOrdinal, toOrdinal)`. */
export interface OrdinalSpan {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
}

export interface LogRow<TRow> {
  readonly ordinal: number;
  /**
   * The row's own identity, independent of its ordinal.
   *
   * Load-bearing: the client compares served row ids against its own skeleton
   * before seating bodies, so a missed coordinate invalidation degrades to a
   * wasted round trip instead of bodies rendered under the wrong rows.
   */
  readonly rowId: string;
  readonly row: TRow;
}

export interface LogSnapshotEvent<TRow> {
  readonly kind: "log-snapshot";
  /** `(transcriptEpoch, ordinal)` expressed in the one cursor model. */
  readonly watermark: LaneCursor;
  /** Authoritative total row count at the watermark. */
  readonly rowCount: number;
  readonly rows: readonly LogRow<TRow>[];
  /** Which ordinals the rows above actually cover. */
  readonly coverage: OrdinalSpan;
  readonly trust: SeedTrust | null;
}

/**
 * Rows appended at the tail.
 *
 * `rowCountAfterAppend` is authoritative and the base ordinal is DERIVED from
 * it (`rowCountAfterAppend - appended.length`) - never from the client's own
 * window length. A windowed client's window is not the log: it may be
 * bounded, evicted, or mid-rebuild, so deriving the base locally seats the
 * append at the wrong ordinals exactly when the window is under memory
 * pressure. Carrying the count on the event is what makes the derivation
 * possible at all, which is why it is required rather than inferred.
 */
export interface LogAppendEvent<TRow> {
  readonly kind: "log-append";
  readonly watermark: LaneCursor;
  readonly rowCountAfterAppend: number;
  readonly appended: readonly TRow[];
}

/**
 * Rows rewritten in place - a streaming row finalising, an image resolving.
 * Ordinals are untouched; inclusion IS the staleness signal, so the replica
 * drops the named rows' bodies and re-requests them if they are still visible.
 */
export interface LogRowsUpdatedEvent<TRow> {
  readonly kind: "log-rows-updated";
  readonly watermark: LaneCursor;
  readonly rows: readonly LogRow<TRow>[];
}

/**
 * The index moved: rows were trimmed, or one was re-seated mid-history. Every
 * ordinal past the change is different, so the honest answer is to declare the
 * coordinate space invalid rather than to describe the shift.
 *
 * This is a rebuild announcement, not a replacement: the epoch is unchanged and
 * the replica keeps its identity, its leases, and its budget charge while it
 * re-requests. Conflating it with `ReplicaReplacementReason` would tear down a
 * live transcript on a checkpoint trim.
 */
export interface LogReindexedEvent {
  readonly kind: "log-reindexed";
  readonly watermark: LaneCursor;
}

/** An answer to one on-demand range request. */
export interface LogRangeEvent<TRow> {
  readonly kind: "log-range";
  readonly requestId: string;
  readonly watermark: LaneCursor;
  readonly rows: readonly LogRow<TRow>[];
  /**
   * Set when the server stopped early to respect a byte ceiling - a single row
   * can exceed a whole frame budget. Not an error: the client requests the
   * remainder from here. `null` means the range was served in full.
   */
  readonly truncatedAtOrdinal: number | null;
}

export type LogReplicaEvent<TRow> =
  | LogSnapshotEvent<TRow>
  | LogAppendEvent<TRow>
  | LogRowsUpdatedEvent<TRow>
  | LogReindexedEvent
  | LogRangeEvent<TRow>;

// ─── Docs ─────────────────────────────────────────────────────────────────

/**
 * A doc the runtime has heard nothing about is implicitly unavailable - there
 * is no "unknown" member, because absence already means it.
 */

/**
 * Doc-class payloads are opaque encoded bytes at this seam, never live CRDT
 * objects. That is what keeps Yjs out of the runtime's own dependency surface
 * and what lets cold bytes sit in a worker while a live doc is bound by an
 * editor on the main thread - bytes transfer across that boundary, a `Y.Doc`
 * cannot.
 */
/**
 * Whether a snapshot's bytes stand on their own.
 *
 * LOAD-BEARING, and the reason this is a named state rather than a flag: both
 * forms apply through the same CRDT merge, so this does not select an apply
 * FUNCTION - it forbids the replica's swap-in-a-fresh-doc path. A delta is
 * computed against the state vector THIS replica offered, so installing it
 * wholesale drops every byte the delta legitimately omitted, silently and
 * unrecoverably.
 *
 * Two named members rather than the wire's present-or-absent flag: absence is
 * unrepresentable here, so no consumer can branch on `=== false` where it meant
 * `!== true`, and neither state can be reached by forgetting a field.
 */
export type DocSeedMode =
  /** Self-sufficient. Safe to install wholesale. */
  | "full"
  /** A delta against this replica's own offer. MUST be merged, never installed. */
  | "delta-against-offer";

export interface DocSnapshotEvent {
  readonly kind: "doc-snapshot";
  /** The epic replica generation this body was served under. */
  readonly authorityEpoch: string;
  readonly docId: string;
  /**
   * The authority's identity for this doc instance. A deleted-and-recreated
   * artifact gets a new one, and a mismatch against what the client holds must
   * reseed rather than merge - splicing two histories under one id is
   * unrecoverable.
   */
  readonly docGuid: string;
  readonly update: Uint8Array;
  /** The authority's state vector at snapshot time, for the reconcile diff. */
  readonly hostStateVectorBase64: string | null;
  readonly seed: DocSeedMode;
}

export interface DocUpdateEvent {
  readonly kind: "doc-update";
  readonly authorityEpoch: string;
  readonly docId: string;
  /**
   * REQUIRED, and the replica - not the adapter - owns the drop.
   *
   * A replica holding a different guid must DROP this update rather than apply
   * it: the bytes describe a document it does not have. Leaving the guid off
   * the event would push a core replica invariant into every adapter, where it
   * would be enforced three times and eventually only twice.
   */
  readonly docGuid: string;
  readonly update: Uint8Array;
}

/**
 * The authority's coverage of updates THIS client pushed: its state vector
 * after applying them.
 *
 * Carries no bytes - it answers "how much of what I sent have you got", which
 * is what lets the replica retire its unsynced divergence watermark without
 * waiting for its own edit to echo back through the room. Without it there is
 * no event on which local divergence can ever be retired, so a body would read
 * as permanently unsynced after a successful push and the runtime-local
 * divergence input to any sync indicator would never clear.
 *
 * Divergence is replica-owned state, so this is a replica event, not an adapter
 * detail.
 */
export interface DocCoverageAckEvent {
  readonly kind: "doc-coverage-ack";
  readonly authorityEpoch: string;
  readonly docId: string;
  readonly docGuid: string;
  readonly coverageStateVectorBase64: string;
}

/**
 * Presence for one doc. Ephemeral by class - never replayed from a durable
 * store - but buffered briefly for a cold doc so a collaborator already sitting
 * in the body is visible the moment it materialises instead of after their next
 * renewal.
 *
 * Carries `authorityEpoch` but deliberately NO `docGuid`, and both halves are
 * deliberate. The epoch is replica identity, so a caret from a superseded
 * replica is still dropped - that is not cursoring, it is addressing. The guid
 * is absent because a caret is not document state: replaying one after a reseed
 * would place a cursor from a document that no longer exists.
 */
export interface DocAwarenessEvent {
  readonly kind: "doc-awareness";
  readonly authorityEpoch: string;
  readonly docId: string;
  readonly frame: Uint8Array;
}

/**
 * The body is being served.
 *
 * Emitted on first observation and on every recovery transition, INDEPENDENTLY
 * of whether any bytes have arrived - so "ready with no snapshot" is a real,
 * reachable state. It must stay distinguishable from an empty body: a consumer
 * that treats ready-but-unseeded as an empty document renders a blank editor
 * and exports an empty file over real content. This is the same distinction
 * `LeaseGrant`'s `"awaiting-seed"` arm exists to preserve.
 */
export interface DocReadyEvent {
  readonly kind: "doc-ready";
  readonly authorityEpoch: string;
  readonly docId: string;
}

/**
 * Why a body is not being served. A CLOSED set: a client handed only free text
 * would have to string-match to choose between reseeding the epic and rendering
 * an unavailable affordance, and those are different products of one frame.
 */
export type DocUnavailableCode =
  /**
   * The attach named an epoch the authority is not serving. Always terminal,
   * and NOT an availability state: the client's whole epic view is void. The
   * replica must be replaced (`"authority-epoch-changed"`) and the body
   * reattached under the epoch the records lane then reports - rendering this
   * as an unavailable body would leave the epic silently stale.
   */
  | "stale-authority-epoch"
  /** No such artifact at this epoch, or it is tombstoned. Terminal. */
  | "artifact-not-found"
  /** It exists and the body cannot currently be materialised. See `terminal`. */
  | "body-unavailable";

export interface DocUnavailableEvent {
  readonly kind: "doc-unavailable";
  readonly authorityEpoch: string;
  readonly docId: string;
  readonly code: DocUnavailableCode;
  /**
   * Whether this lane is finished. `true` means no later event arrives and the
   * consumer must reattach if it still wants the body; `false` means the
   * authority is retrying and the tile shows a transient state without tearing
   * down.
   *
   * Its own field rather than derived from {@link code}, because
   * `"body-unavailable"` is genuinely both - retrying, and given up - and
   * folding them forces one of the two to be a lie.
   */
  readonly terminal: boolean;
  /**
   * A short authority-side summary, for logs only. Never parse it, never branch
   * on it, never render it as product copy - that is what {@link code} is for.
   */
  readonly reason: string;
}

export type DocReplicaEvent =
  | DocSnapshotEvent
  | DocUpdateEvent
  | DocCoverageAckEvent
  | DocAwarenessEvent
  | DocReadyEvent
  | DocUnavailableEvent;

// ─── Ephemera ─────────────────────────────────────────────────────────────

/**
 * Fire-and-forget. No cursor, no resume, no replay - a replayed presence frame
 * is worse than a lost one, because it asserts a peer is somewhere they left.
 * The type carries no watermark on purpose: there is nothing to offer on
 * reconnect, and a field for one would eventually be filled in.
 */
export interface EphemeralEvent<TPayload> {
  readonly kind: "ephemeral";
  readonly payload: TPayload;
}

// ─── Control plane ────────────────────────────────────────────────────────

/**
 * The migration's internal stage, meaningful only while it is running.
 *
 * Distinct from {@link MigrationStatus}, which is the lifecycle. Keeping them
 * two words matters: the wire calls THIS one `phase`, so a seam that also
 * called its lifecycle discriminant `phase` would give one word two meanings
 * across the boundary an adapter has to translate.
 */
export type MigrationStage =
  /** Connect to the new room and seed the metadata-only root. */
  | "prepare"
  /** Publish the bodies. The long, genuinely fraction-bearing stage. */
  | "upload"
  /** Write the final root and tear down the migration provider. */
  | "finalize";

/**
 * The migration lifecycle as the runtime observes it.
 *
 * There is deliberately **no `completed` member.** Completion is not an event
 * on this lane - it is the authority epoch changing, after which both lanes
 * resume from the post-migration replica. The runtime learns of it through
 * `ReplicaReplacementReason: "migration-completed"`, the same machinery as any
 * other epoch bump.
 *
 * A `completed` member here would be a second, parallel route to "the migration
 * finished", and the two could disagree. The cross-lane coordination - the
 * state lane holding its snapshot while this lane reports progress - is a
 * designed contract precisely because it used to be an emergent one, and a
 * synthesised completion event is how it would become emergent again.
 */
export type MigrationStatus =
  /** Emitted before any progress, so a silent skeleton can become a modal. */
  | { readonly status: "started" }
  | {
      readonly status: "progress";
      readonly stage: MigrationStage;
      /**
       * An OPAQUE tick fraction for the active stage, not a global percentage.
       * Only `"upload"` is determinate; `"prepare"` and `"finalize"` report
       * `0 / 1`, which a consumer must render as an indeterminate spinner
       * rather than as a bar stuck at zero.
       */
      readonly chunksDone: number;
      readonly chunksTotal: number;
    }
  /**
   * Terminal failure of an in-flight migration, delivered INSTEAD of a fatal
   * close so the session survives and a retry stays reachable. `reason` is a
   * host-side summary for logs; product copy must never render it.
   */
  | { readonly status: "failed"; readonly reason: string }
  /**
   * The epic needs a migration this caller lacks the write access to perform.
   * One-shot and terminal, and distinct from `"failed"` in the way that
   * matters: nothing was attempted, so a retry from THIS caller can never
   * succeed and must not be offered.
   *
   * Carries NO `reason`, unlike `"failed"`, and the asymmetry is the point.
   * `"failed"` reports what went wrong during an attempt, which only the
   * authority knows; here nothing was attempted and the STATE is the whole
   * explanation. Neither `epic.status.subscribe@1.0`'s `migrationNotAllowed`
   * frame nor its `migration: {state: "notAllowed"}` snapshot projection
   * carries one, so an adapter asked for a reason here could only synthesise
   * a string - and a synthesised authority-side fact is indistinguishable
   * downstream from one the authority actually said.
   */
  | { readonly status: "not-allowed" };

/**
 * Control-plane facts. Records with barrier semantics on an urgent lane, kept
 * as their own event union because their consumers (the session shell, the sync
 * indicator, the mutation gate) are not the consumers of the record planes.
 */
export type ControlEvent =
  | {
      readonly kind: "permission-changed";
      /**
       * The wire role verbatim, for display and telemetry only. The runtime
       * never interprets it - see {@link canWrite}.
       */
      readonly role: string | null;
      /**
       * Decoded by the adapter, because it is the only component that knows
       * the wire vocabulary. FAIL CLOSED: an adapter that cannot tell must
       * answer `false`, since the consequence of a wrong `true` is a write
       * queued against an epic the user has lost access to.
       */
      readonly canWrite: boolean;
      /**
       * Host-local. The host increments it when IT learns of a permission
       * change - today via a cloud denial on the next operation, or a room
       * permission frame. There is no authoritative cloud-to-host revocation
       * push, and nothing here may assume one. The honest promise is access
       * cessation, not retroactive erasure.
       */
      readonly securityEpoch: number;
    }
  | {
      readonly kind: "cloud-sync-status";
      readonly status: string;
      readonly observedAtMs: number;
    }
  /**
   * One aggregate durability boolean owned by the authority (root OR any room).
   * Snapshot-then-delta: pre-snapshot silence means UNKNOWN, never clean.
   *
   * Aggregating the host's own durability legs is legitimate - it is one
   * class's answer. It is one INPUT to a sync indicator, never the indicator.
   */
  | { readonly kind: "aggregate-dirty"; readonly dirty: boolean }
  /**
   * The epic is gone, with whatever attribution the authority has.
   *
   * The attribution is CARRIED rather than dropped because it is what the
   * renderer says when it force-closes the tab - "deleted by Alice" against
   * "it vanished" - and both delivery paths on the wire have it: the
   * `epicDeleted` transition frame and the status snapshot's
   * `deletion: {state: "deleted", attribution}` projection share one shape
   * precisely so a transition and its current-state projection cannot
   * disagree about it. An event that could not carry it would make the
   * SNAPSHOT path (the one a reconnecting client takes) lossier than the
   * transition path, which is the failure the projection exists to prevent.
   *
   * Both fields are nullable because attribution is best-effort: the
   * authority may know the epic is gone without knowing who removed it, and
   * "deleted by nobody we can name" must stay renderable.
   */
  | {
      readonly kind: "epic-deleted";
      readonly deletedByDisplayName: string | null;
      readonly deletedByTraycerUserId: string | null;
    }
  | { readonly kind: "migration"; readonly migration: MigrationStatus };
