import type {
  MigrationJournal,
  MigrationPhase,
  SessionImpactReport,
  Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";

/**
 * Shared vocabulary of the data-root migration engine (issue 718, ticket 6).
 *
 * The engine never throws for an OPERATIONAL refusal: a blocker, a third
 * party's change, an I/O failure or a damaged record comes back as a
 * `stopped` result naming the phase it stopped in. The journal then still
 * holds that phase (and, from `quiescing` until `activated`, the startup
 * barrier), so `recoverMigration` can resume it or, before activation, roll
 * it back. Throws are reserved for programming errors and for failures that
 * decided nothing.
 *
 * Messages carry no paths or account identifiers; `object` names the exact
 * affected object for the user's own diagnostics only, never for INFO+ logs
 * or analytics.
 */

export type EngineBlocker = {
  readonly code: string;
  /** The exact object (a store key, a path, a task, a pid), when one exists. */
  readonly object: string | null;
  readonly message: string;
};

export type EngineStopReason =
  /** Preconditions not met (participants still running, maintenance blockers). */
  | "blocked"
  /** The session impact report must be (re)accepted before mutation continues. */
  | "acceptance-required"
  /** A third party changed an object or the pointer; never overwritten. */
  | "conflict"
  /** An I/O failure, mismatch or cancellation; the source stays authoritative. */
  | "failed"
  /** A bootstrap record is damaged; only explicit record recovery can proceed. */
  | "damaged";

export type EngineResult =
  | {
      readonly kind: "done";
      readonly journal: MigrationJournal;
    }
  | {
      readonly kind: "stopped";
      readonly reason: EngineStopReason;
      /** The journal as durably recorded when the engine stopped; null before one exists. */
      readonly journal: MigrationJournal | null;
      readonly blockers: readonly EngineBlocker[];
      /** Present when the stop concerns the session impact report. */
      readonly impact: SessionImpactReport | null;
    };

export function engineBlocker(
  code: string,
  object: string | null,
  message: string,
): EngineBlocker {
  return { code, object, message };
}

export function stopped(
  reason: EngineStopReason,
  journal: MigrationJournal | null,
  blockers: readonly EngineBlocker[],
  impact: SessionImpactReport | null,
): EngineResult {
  return { kind: "stopped", reason, journal, blockers, impact };
}

/**
 * Raised inside the engine to unwind to the phase driver with an
 * operational stop; the driver converts it into a `stopped` result.
 */
export class EngineStop extends Error {
  readonly reason: EngineStopReason;
  readonly blockers: readonly EngineBlocker[];
  readonly impact: SessionImpactReport | null;

  constructor(
    reason: EngineStopReason,
    blockers: readonly EngineBlocker[],
    impact: SessionImpactReport | null,
  ) {
    super(blockers[0]?.message ?? reason);
    this.name = "EngineStop";
    this.reason = reason;
    this.blockers = blockers;
    this.impact = impact;
  }
}

export function stopWith(
  reason: EngineStopReason,
  code: string,
  object: string | null,
  message: string,
): EngineStop {
  return new EngineStop(reason, [engineBlocker(code, object, message)], null);
}

/**
 * Every durable boundary the engine crosses, for crash injection: tests make
 * `checkpoint` throw at one of these and then run recovery in a fresh engine.
 * `before-` is called after the decision and before the durable effect;
 * `after-` immediately after the effect landed and before anything else.
 */
export type EngineCheckpoint =
  | `before-journal:${MigrationPhase}`
  | `after-journal:${MigrationPhase}`
  | `before-action:${string}`
  | `after-action:${string}`
  | "before-pointer-switch"
  | "after-pointer-switch"
  | "before-pointer-restore"
  | "after-pointer-restore"
  | "before-receipt-mirror"
  | "after-receipt-mirror"
  | "after-copy-file"
  | "before-cleanup-delete"
  | "after-cleanup-delete";

/** Progress for a caller's display; never marks an unfinished phase complete. */
export type EngineProgress =
  | { readonly kind: "phase"; readonly phase: MigrationPhase }
  | {
      readonly kind: "copy";
      readonly files: number;
      readonly totalFiles: number;
      readonly bytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly kind: "maintenance";
      readonly operation: string;
      readonly completed: number;
      readonly total: number;
    }
  | {
      readonly kind: "cleanup";
      readonly removedEntries: number;
      readonly totalEntries: number;
    }
  | { readonly kind: "waiting-for-participants"; readonly running: number }
  /** Writers proven running at `planned`; the quiesced re-inventory must find none. */
  | { readonly kind: "deferred-to-quiescence"; readonly running: number };

/** The session impact a plan presents, with the digest an acceptance must name. */
export type SessionImpactPresentation = {
  readonly report: SessionImpactReport;
  readonly digest: Sha256Digest;
  readonly requiresAcceptance: boolean;
};
