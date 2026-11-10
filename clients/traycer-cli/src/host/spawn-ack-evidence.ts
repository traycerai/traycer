import {
  readSpawnAckEvidenceWithin,
  SpawnAcknowledgementTimeoutError,
  type SpawnAckMarkerState,
  type SpawnAckSupervisorState,
} from "@traycer-clients/shared/host-start-adoption/spawn-acknowledgement-error";
import type { Environment } from "../runner/environment";
import { readBootstrapMarkersStrict } from "./bootstrap-log";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import {
  readSupervisorRecord,
  readSupervisorRunState,
} from "./lifecycle-files";

// Newest-first scan window over the supervisor's marker log; a grant's own
// markers are the last few lines of it.
const MARKER_SCAN_ENTRIES = 20;

// A parsed phase is any word the log line carried; only the phases
// `BootstrapPhase` defines may leave this process as themselves.
function markerState(phase: string): SpawnAckMarkerState {
  switch (phase) {
    case "starting":
    case "exited":
    case "crashed":
    case "killed":
    case "failed-to-spawn":
      return phase;
    default:
      return "other";
  }
}

/**
 * Whether the service's supervisor is alive, keeping "could not tell" apart
 * from "confirmed absent". `findLiveServiceSupervisor` answers `null` for both
 * (right for a command deciding not to start over a supervisor, wrong for
 * evidence), so this reads the same records and process identity and answers
 * `unknown` wherever those cannot settle it.
 */
async function supervisorState(
  environment: Environment,
): Promise<SpawnAckSupervisorState> {
  const [supervisor, run] = await Promise.all([
    readSupervisorRecord(environment),
    readSupervisorRunState(environment),
  ]);
  if (supervisor.kind === "unreadable" || supervisor.kind === "invalid") {
    return "unknown";
  }
  if (run.kind === "unreadable" || run.kind === "invalid") return "unknown";
  if (supervisor.kind === "absent" || run.kind === "absent") return "none";
  if (run.record.supervisorPid !== supervisor.record.pid) return "none";
  // A hand-run `host start` is not the service's supervisor.
  if (run.record.admission === "foreground") return "none";
  const verdict = await getPublishedProcessIdentityVerdict(
    run.record.supervisorPid,
    run.record.supervisorStartIdentity,
  );
  switch (verdict) {
    case "current":
      return "live";
    case "mismatch":
    case "dead":
      return "none";
    case "indeterminate":
      return "unknown";
  }
}

function readSupervisor(
  environment: Environment,
  deadlineMs: number,
): Promise<SpawnAckSupervisorState> {
  return readSpawnAckEvidenceWithin(
    () => supervisorState(environment),
    "unknown",
    deadlineMs,
  );
}

function readMarker(
  environment: Environment,
  publishedAtMs: number,
  deadlineMs: number,
): Promise<SpawnAckMarkerState> {
  return readSpawnAckEvidenceWithin(
    async (): Promise<SpawnAckMarkerState> => {
      const entries = await readBootstrapMarkersStrict(
        environment,
        MARKER_SCAN_ENTRIES,
      );
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        const writtenAtMs = Date.parse(entry.timestamp);
        if (Number.isNaN(writtenAtMs) || writtenAtMs < publishedAtMs) continue;
        return markerState(entry.phase);
      }
      return "none";
    },
    "unknown",
    deadlineMs,
  );
}

/**
 * Add what the service's own records say to a timeout the shared waiter
 * raised. Read-only, bounded and never throws; the error, its message and its
 * identity are unchanged.
 */
export async function attachCliSpawnAckEvidence(
  error: SpawnAcknowledgementTimeoutError,
  environment: Environment,
  publishedAtMs: number,
): Promise<void> {
  const [supervisor, marker] = await Promise.all([
    readSupervisor(environment, error.evidenceDeadlineMs),
    readMarker(environment, publishedAtMs, error.evidenceDeadlineMs),
  ]);
  error.attachSupervisorEvidence(supervisor, marker);
}
