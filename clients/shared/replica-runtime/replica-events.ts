/** The vocabulary an adapter decodes into and a replica applies. */
import type { BarrierRef, LaneCursor } from "./lane-cursor";
import type { SeedTrust } from "./freshness";

 // ─── Records ──────────────────────────────────────────────────────────────

/**
 * One server-arbitrated row plus the two facts the runtime needs about it.
 * `revision` is per-row monotonic and is the only ordering fact a reconciler may read.
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
       * Required on a removal too, and the distinction that reads backwards at first: it is carried, not gated ON.
       * Removal is terminal and absorbing, so a tombstone whose revision is lower than an upsert already applied still removes the row - "this row was deleted" wins against later upserts at any revision.
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
     * The snapshot rides the stream, never a unary.
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
 * A transactional envelope: every row and tombstone a single authority-side change touched, delivered atomically.
 */
export interface RecordTransactionEvent<TRow> {
  readonly kind: "record-transaction";
  readonly cursor: LaneCursor;
  readonly changes: readonly RecordChange<TRow>[];
  /** Non-null only for the exceptional cross-lane case. Never inferred. */
  readonly barrier: BarrierRef | null;
}

/**
 * A full-set answer from a poll rather than a push - `epic.listChatRecords`, `epic.listTuiAgents`.
 * It is not a snapshot: it carries no watermark it can claim, and it may be older than pushes the client has already applied.
 */
export interface RecordPollAnswerEvent<TRow> {
  readonly kind: "record-poll-answer";
  readonly rows: readonly RecordRow<TRow>[];
  /** The replica's ingest counter as read when the request was sent. */
  readonly issuedAtFence: number | null;
}

/**
 * The serving node's trust in the rows it already sent changed - it has reconciled with the cloud since the snapshot it served from its own replica.
 * A snapshot cannot carry the correction, and not merely as a matter of taste: re-issuing one would mean claiming a `basis` - a fresh open, a replaced replica, a refused resume - and none of those happened.
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

export interface OrdinalSpan {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
}

export interface LogRow<TRow> {
  readonly ordinal: number;
  /**
   * The row's own identity, independent of its ordinal.
   * Load-bearing: the client compares served row ids against its own skeleton before seating bodies, so a missed coordinate invalidation degrades to a wasted round trip instead of bodies rendered under the wrong rows.
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
 * `rowCountAfterAppend` is authoritative and the base ordinal is derived from it (`rowCountAfterAppend - appended.length`) - never from the client's own window length.
 */
export interface LogAppendEvent<TRow> {
  readonly kind: "log-append";
  readonly watermark: LaneCursor;
  readonly rowCountAfterAppend: number;
  readonly appended: readonly TRow[];
}

export interface LogRowsUpdatedEvent<TRow> {
  readonly kind: "log-rows-updated";
  readonly watermark: LaneCursor;
  readonly rows: readonly LogRow<TRow>[];
}

/**
 * The index moved: rows were trimmed, or one was re-seated mid-history.
 * Every ordinal past the change is different, so the honest answer is to declare the coordinate space invalid rather than to describe the shift.
 */
export interface LogReindexedEvent {
  readonly kind: "log-reindexed";
  readonly watermark: LaneCursor;
}

export interface LogRangeEvent<TRow> {
  readonly kind: "log-range";
  readonly requestId: string;
  readonly watermark: LaneCursor;
  readonly rows: readonly LogRow<TRow>[];
  /**
   * Set when the server stopped early to respect a byte ceiling - a single row can exceed a whole frame budget.
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

/** Doc-class payloads are opaque encoded bytes at this seam, never live CRDT objects. */
/**
 * Whether a snapshot's bytes stand on their own.
 * Load-bearing, and the reason this is a named state rather than a flag: both forms apply through the same CRDT merge, so this does not select an apply function - it forbids the replica's swap-in-a-fresh-doc path.
 */
export type DocSeedMode =
  /** Self-sufficient. Safe to install wholesale. */
  | "full"
  /** A delta against this replica's own offer. Must be merged, never installed. */
  | "delta-against-offer";

export interface DocSnapshotEvent {
  readonly kind: "doc-snapshot";
  /** The epic replica generation this body was served under. */
  readonly authorityEpoch: string;
  readonly docId: string;
  /**
   * The authority's identity for this doc instance.
   * A deleted-and-recreated artifact gets a new one, and a mismatch against what the client holds must reseed rather than merge - splicing two histories under one id is unrecoverable.
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
   * Required, and the replica - not the adapter - owns the drop.
   * A replica holding a different guid must drop this update rather than apply it: the bytes describe a document it does not have.
   */
  readonly docGuid: string;
  readonly update: Uint8Array;
}

/**
 * The authority's coverage of updates this client pushed: its state vector after applying them.
 * Carries no bytes - it answers "how much of what I sent have you got", which is what lets the replica retire its unsynced divergence watermark without waiting for its own edit to echo back through the room.
 */
export interface DocCoverageAckEvent {
  readonly kind: "doc-coverage-ack";
  readonly authorityEpoch: string;
  readonly docId: string;
  readonly docGuid: string;
  readonly coverageStateVectorBase64: string;
}

/**
 * Presence for one doc.
 * Ephemeral by class - never replayed from a durable store - but buffered briefly for a cold doc so a collaborator already sitting in the body is visible the moment it materialises instead of after their next renewal.
 */
export interface DocAwarenessEvent {
  readonly kind: "doc-awareness";
  readonly authorityEpoch: string;
  readonly docId: string;
  readonly frame: Uint8Array;
}

/**
 * The body is being served.
 * It must stay distinguishable from an empty body: a consumer that treats ready-but-unseeded as an empty document renders a blank editor and exports an empty file over real content.
 */
export interface DocReadyEvent {
  readonly kind: "doc-ready";
  readonly authorityEpoch: string;
  readonly docId: string;
}

/**
 * Why a body is not being served.
 * A closed set: a client handed only free text would have to string-match to choose between reseeding the epic and rendering an unavailable affordance, and those are different products of one frame.
 */
export type DocUnavailableCode =
  /**
   * The attach named an epoch the authority is not serving.
   * The replica must be replaced (`"authority-epoch-changed"`) and the body reattached under the epoch the records lane then reports - rendering this as an unavailable body would leave the epic silently stale.
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
   * Whether this lane is finished.
   * `true` means no later event arrives and the consumer must reattach if it still wants the body; `false` means the authority is retrying and the tile shows a transient state without tearing down.
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

export interface EphemeralEvent<TPayload> {
  readonly kind: "ephemeral";
  readonly payload: TPayload;
}

// ─── Control plane ────────────────────────────────────────────────────────

/** The migration's internal stage, meaningful only while it is running. */
export type MigrationStage =
  /** Connect to the new room and seed the metadata-only root. */
  | "prepare"
  /** Publish the bodies. The long, genuinely fraction-bearing stage. */
  | "upload"
  /** Write the final root and tear down the migration provider. */
  | "finalize";

  /**
   * The migration lifecycle as the runtime observes it.
   * There is deliberately **no `completed` member.** Completion is not an event on this lane - it is the authority epoch changing, after which both lanes resume from the post-migration replica.
   */
export type MigrationStatus =
  /** Emitted before any progress, so a silent skeleton can become a modal. */
  | { readonly status: "started" }
  | {
      readonly status: "progress";
      readonly stage: MigrationStage;
      /**
       * An opaque tick fraction for the active stage, not a global percentage.
       * Only `"upload"` is determinate; `"prepare"` and `"finalize"` report `0 / 1`, which a consumer must render as an indeterminate spinner rather than as a bar stuck at zero.
       */
      readonly chunksDone: number;
      readonly chunksTotal: number;
    }
  /**
   * Terminal failure of an in-flight migration, delivered instead of a fatal close so the session survives and a retry stays reachable.
   * `reason` is a host-side summary for logs; product copy must never render it.
   */
  | { readonly status: "failed"; readonly reason: string }
  /**
   * The epic needs a migration this caller lacks the write access to perform.
   * One-shot and terminal, and distinct from `"failed"` in the way that matters: nothing was attempted, so a retry from this caller can never succeed and must not be offered.
   */
  | { readonly status: "not-allowed" };

  /**
   * Control-plane facts.
   * Records with barrier semantics on an urgent lane, kept as their own event union because their consumers (the session shell, the sync indicator, the mutation gate) are not the consumers of the record planes.
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
       * Decoded by the adapter, because it is the only component that knows the wire vocabulary.
       * Fail closed: an adapter that cannot tell must answer `false`, since the consequence of a wrong `true` is a write queued against an epic the user has lost access to.
       */
      readonly canWrite: boolean;
      /** Host-local. */
      readonly securityEpoch: number;
    }
  /**
   * The control lane's authoritative snapshot completed, with the role it carried.
   * The boundary, not the facts.
   */
  | {
      readonly kind: "control-snapshot-complete";
      readonly role: string | null;
    }
  | {
      readonly kind: "cloud-sync-status";
      readonly status: string;
      readonly observedAtMs: number;
    }
  /**
   * One aggregate durability boolean owned by the authority (root OR any room).
   * Snapshot-then-delta: pre-snapshot silence means unknown, never clean.
   */
  | { readonly kind: "aggregate-dirty"; readonly dirty: boolean }
  /**
   * The epic is gone, with whatever attribution the authority has.
   * Both fields are nullable because attribution is best-effort: the authority may know the epic is gone without knowing who removed it, and "deleted by nobody we can name" must stay renderable.
   */
  | {
      readonly kind: "epic-deleted";
      readonly deletedByDisplayName: string | null;
      readonly deletedByTraycerUserId: string | null;
    }
  | { readonly kind: "migration"; readonly migration: MigrationStatus };
