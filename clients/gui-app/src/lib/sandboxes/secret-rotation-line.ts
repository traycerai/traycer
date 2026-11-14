import type {
  EnvironmentSecretsRotationResponse,
  RotationProducer,
} from "@traycer/protocol/host/environment-schemas";
import type { SandboxGrantRotation } from "@traycer/protocol/host/sandbox-secrets";

/**
 * What a replaced value has done, in words: on the sandbox card per grant, and
 * on Settings ▸ Personal ▸ Secrets per secret.
 *
 * "Enforced" is said only on evidence: every worker class must carry a
 * `rotation_ack` entry of a kind the rotation wire defines (`session_closed`,
 * `cache_cleared`, `probe_refused`). A producer contained by expiry owes
 * none. Until then the line reads "accepted, closing old sessions", whatever
 * the state says, so a missing or unknown proof never reads as enforced. The
 * value is enforced where it is used, by the workers; a host owes nothing,
 * so a host producer an older answer still carries is not read.
 */

export interface SecretRotationLine {
  readonly tone: "success" | "warning" | "muted";
  readonly text: string;
}

interface RotationEvidenceEntry {
  readonly kind: string;
  readonly count: number | null;
}

/** One producer's acknowledgement as both wires carry it. */
export interface RotationProof {
  readonly status: string;
  readonly evidence: readonly RotationEvidenceEntry[] | null;
}

/** Producers that owe no acknowledgement for this rotation. */
const OWES_NONE: ReadonlySet<string> = new Set([
  "contained_by_expiry",
  "applies_on_resume",
]);

/**
 * "3 sessions closed, cached keys dropped": the entries of the kinds the wire
 * defines, in its order; `null` when none of them proves anything. A kind
 * newer than this build adds nothing, and a bare `session_closed` with a
 * count of zero or none closed nothing, so it is no proof on its own (the
 * notification row counts the same way).
 */
export function rotationProofPhrase(
  evidence: readonly RotationEvidenceEntry[] | null,
): string | null {
  const parts: string[] = [];
  let sessions = 0;
  let cacheCleared = false;
  let probeRefused = false;
  for (const entry of evidence ?? []) {
    if (entry.kind === "session_closed") {
      sessions += entry.count ?? 0;
    } else if (entry.kind === "cache_cleared") {
      cacheCleared = true;
    } else if (entry.kind === "probe_refused") {
      probeRefused = true;
    }
  }
  if (sessions > 0) {
    parts.push(
      sessions === 1 ? "1 session closed" : `${sessions} sessions closed`,
    );
  }
  if (cacheCleared) parts.push("cached keys dropped");
  if (probeRefused) parts.push("old value refused");
  return parts.length === 0 ? null : parts.join(", ");
}

/** Whether a producer has proved the old value is out of use, or owes nothing. */
export function rotationProven(proof: RotationProof): boolean {
  if (OWES_NONE.has(proof.status)) return true;
  return (
    proof.status === "acknowledged" &&
    rotationProofPhrase(proof.evidence) !== null
  );
}

const ACCEPTED: SecretRotationLine = {
  tone: "muted",
  text: "New value accepted, closing old sessions.",
};

const FAILED: SecretRotationLine = {
  tone: "warning",
  text: "Replacing the value failed. The old value may still be in use.",
};

function classPhrase(entry: SandboxGrantRotation["classes"][number]): string {
  if (entry.status === "contained_by_expiry") {
    return `${entry.workerClass}, contained by expiry`;
  }
  return `${entry.workerClass}, ${rotationProofPhrase(entry.evidence) ?? "confirmed"}`;
}

/**
 * The sandbox card's line for one grant's rotation, or `null` when the grant
 * has none: "New value accepted, closing old sessions.", then "New value
 * enforced: postgres, 3 sessions closed."
 */
export function grantRotationLine(
  rotation: SandboxGrantRotation | null,
): SecretRotationLine | null {
  if (rotation === null) return null;
  if (rotation.state === "failed") return FAILED;
  if (rotation.state !== "enforced") return ACCEPTED;
  if (rotation.classes.length === 0) {
    return { tone: "success", text: "New value in use." };
  }
  if (!rotation.classes.every(rotationProven)) return ACCEPTED;
  return {
    tone: "success",
    text: `New value enforced: ${rotation.classes.map(classPhrase).join("; ")}.`,
  };
}

export interface SecretRotationProducerLine {
  /** A worker class; unique within one rotation. */
  readonly key: string;
  /** "postgres: 3 sessions closed". */
  readonly text: string;
}

export interface SecretRotationStatus {
  readonly headline: SecretRotationLine;
  readonly producers: readonly SecretRotationProducerLine[];
}

type WorkerProducer = Extract<RotationProducer, { producer: "worker" }>;

function workerProducers(
  producers: readonly RotationProducer[],
): WorkerProducer[] {
  return producers.filter(
    (producer): producer is WorkerProducer => producer.producer === "worker",
  );
}

/**
 * One line per worker class, however many incarnations (pods) it runs: any
 * incarnation not yet proven leaves the class not confirmed, and a proven
 * class reads its incarnations' evidence combined.
 */
function workerClassLine(
  workerClass: string,
  incarnations: readonly WorkerProducer[],
): string {
  if (!incarnations.every(rotationProven)) {
    return `${workerClass}: not confirmed yet`;
  }
  const evidence = incarnations.flatMap((producer) =>
    producer.status === "acknowledged" ? (producer.evidence ?? []) : [],
  );
  const proof = rotationProofPhrase(evidence);
  return proof === null
    ? `${workerClass}: contained by expiry`
    : `${workerClass}: ${proof}`;
}

/** The worker classes' lines in first-seen order, each class once. */
function producerLines(
  producers: readonly WorkerProducer[],
): SecretRotationProducerLine[] {
  const classes = new Map<string, WorkerProducer[]>();
  for (const producer of producers) {
    const incarnations = classes.get(producer.workerClass) ?? [];
    incarnations.push(producer);
    classes.set(producer.workerClass, incarnations);
  }
  return [...classes].map(([workerClass, incarnations]) => ({
    key: `worker:${workerClass}`,
    text: workerClassLine(workerClass, incarnations),
  }));
}

/**
 * The Secrets page's status of a secret's current rotation, or `null` when it
 * has none.
 */
export function secretRotationStatus(
  rotation: EnvironmentSecretsRotationResponse["rotation"],
): SecretRotationStatus | null {
  if (rotation === null) return null;
  const workers = workerProducers(rotation.producers);
  const producers = producerLines(workers);
  switch (rotation.state) {
    case "failed":
      return { headline: FAILED, producers };
    case "stalled":
      return {
        headline: {
          tone: "warning",
          text: "Not confirmed after a minute. Finish or stop running agent turns and shells before stopping the sandbox to end old sessions.",
        },
        producers,
      };
    case "enforced":
      return {
        headline: workers.every(rotationProven)
          ? { tone: "success", text: "New value enforced." }
          : ACCEPTED,
        producers,
      };
    case "accepted":
    case "enforcing":
      return { headline: ACCEPTED, producers };
  }
}

/** Whether the rotation is still moving, so its status is worth reading again. */
export function secretRotationSettled(
  rotation: EnvironmentSecretsRotationResponse["rotation"],
): boolean {
  if (rotation === null) return true;
  if (rotation.state === "failed") return true;
  return (
    rotation.state === "enforced" &&
    workerProducers(rotation.producers).every(rotationProven)
  );
}
