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

export type RecordReplicaEvent<TRow> =
  | RecordSnapshotEvent<TRow>
  | RecordTransactionEvent<TRow>
  | RecordPollAnswerEvent<TRow>;

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
 * Availability of one doc, mirrored from the authority.
 *
 * A doc absent from the report is implicitly `"unavailable"`. `"ready"` is
 * reported on first observation and on every recovery transition, INDEPENDENTLY
 * of whether any bytes have arrived - so `"ready"` with no snapshot is a real,
 * reachable state and must stay distinguishable from an empty doc.
 */
export type DocAvailability = "ready" | "unavailable" | "retrying";

/**
 * Doc-class payloads are opaque encoded bytes at this seam, never live CRDT
 * objects. That is what keeps Yjs out of the runtime's own dependency surface
 * and what lets cold bytes sit in a worker while a live doc is bound by an
 * editor on the main thread - bytes transfer across that boundary, a `Y.Doc`
 * cannot.
 */
export interface DocSnapshotEvent {
  readonly kind: "doc-snapshot";
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
}

export interface DocUpdateEvent {
  readonly kind: "doc-update";
  readonly docId: string;
  readonly update: Uint8Array;
}

/**
 * Presence for one doc. Ephemeral by class - never cursored, never replayed
 * from a durable store - but buffered briefly for a cold doc so a collaborator
 * already sitting in the body is visible the moment it materialises instead of
 * after their next renewal.
 */
export interface DocAwarenessEvent {
  readonly kind: "doc-awareness";
  readonly docId: string;
  readonly frame: Uint8Array;
}

export interface DocAvailabilityEvent {
  readonly kind: "doc-availability";
  readonly docId: string;
  readonly availability: DocAvailability;
}

export type DocReplicaEvent =
  | DocSnapshotEvent
  | DocUpdateEvent
  | DocAwarenessEvent
  | DocAvailabilityEvent;

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

export type MigrationPhase =
  | { readonly phase: "started" }
  | {
      readonly phase: "progress";
      readonly chunksDone: number;
      readonly chunksTotal: number;
    }
  /**
   * Carries the epoch both lanes resume from. Without it the state lane has
   * no way to know which epoch its held snapshot belongs to, and the
   * cross-lane resume becomes a guess.
   */
  | { readonly phase: "completed"; readonly authorityEpoch: string }
  | { readonly phase: "failed"; readonly reason: string }
  | { readonly phase: "not-allowed"; readonly reason: string };

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
  | { readonly kind: "epic-deleted" }
  | { readonly kind: "migration"; readonly migration: MigrationPhase };
