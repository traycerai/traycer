/**
 * What was on disk when a host-start grant went unacknowledged, as closed sets
 * a Sentry tag can carry. Every value is one of these words: no path, pid,
 * time, nonce or message text, so the evidence can never carry a host or
 * account identifier.
 */

/** The grant's proof file at its fixed discovery path. */
export type SpawnAckProofState =
  // Our own proof is still there: no supervisor claimed it.
  | "pending-ours"
  // No proof at the path: a supervisor claimed it (and then died or was slow
  // before it acknowledged), or another party removed it.
  | "absent"
  // A different publisher's proof holds the path.
  | "other-nonce"
  | "unreadable";

/** Whether the service's supervisor is provably alive. */
export type SpawnAckSupervisorState = "live" | "none" | "unknown";

/**
 * The phase of the newest supervisor marker written after the grant was
 * published: the `BootstrapPhase` set (`host/bootstrap-log.ts`), `other` for a
 * phase outside it, `none` for no marker since the publish.
 */
export type SpawnAckMarkerState =
  | "none"
  | "starting"
  | "exited"
  | "crashed"
  | "killed"
  | "failed-to-spawn"
  | "other"
  | "unknown";

export interface SpawnAcknowledgementEvidence {
  readonly proof: SpawnAckProofState;
  readonly supervisor: SpawnAckSupervisorState;
  readonly marker: SpawnAckMarkerState;
}

// The whole evidence read at a timeout, across every reader, is bounded by this.
const SPAWN_ACK_EVIDENCE_BUDGET_MS = 2_000;

/**
 * `read`'s answer, or `fallback` when it throws or has not settled by
 * `deadlineMs` (an absolute `Date.now()` time, shared by every reader of one
 * timeout so their budgets do not add up). Never throws and never retries, so
 * reading evidence cannot change or delay the failure it describes by more
 * than the one budget.
 */
export async function readSpawnAckEvidenceWithin<T>(
  read: () => Promise<T>,
  fallback: T,
  deadlineMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const budget = new Promise<T>((resolve) => {
    timer = setTimeout(
      () => resolve(fallback),
      Math.max(0, deadlineMs - Date.now()),
    );
  });
  try {
    return await Promise.race([read().catch(() => fallback), budget]);
  } catch {
    return fallback;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export class SpawnAcknowledgementTimeoutError extends Error {
  readonly #evidenceDeadlineMs = Date.now() + SPAWN_ACK_EVIDENCE_BUDGET_MS;
  #proof: SpawnAckProofState | null = null;
  #supervisor: SpawnAckSupervisorState = "unknown";
  #marker: SpawnAckMarkerState = "unknown";

  constructor() {
    super("host-start supervisor did not acknowledge its spawn");
    this.name = "SpawnAcknowledgementTimeoutError";
  }

  /** When reading evidence for this timeout must stop, whoever reads it. */
  get evidenceDeadlineMs(): number {
    return this.#evidenceDeadlineMs;
  }

  /** Set once by the waiter that raised this error. */
  attachProof(proof: SpawnAckProofState): void {
    this.#proof = proof;
  }

  /** Set by a caller that can read the service's own records. */
  attachSupervisorEvidence(
    supervisor: SpawnAckSupervisorState,
    marker: SpawnAckMarkerState,
  ): void {
    this.#supervisor = supervisor;
    this.#marker = marker;
  }

  /** `null` for an error raised before any evidence was read. */
  get evidence(): SpawnAcknowledgementEvidence | null {
    if (this.#proof === null) return null;
    return {
      proof: this.#proof,
      supervisor: this.#supervisor,
      marker: this.#marker,
    };
  }
}
