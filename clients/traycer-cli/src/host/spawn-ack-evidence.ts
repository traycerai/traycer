import {
  readSpawnAckEvidenceWithin,
  SpawnAcknowledgementTimeoutError,
  type SpawnAckMarkerState,
  type SpawnAckSupervisorState,
} from "@traycer-clients/shared/host-start-adoption/spawn-acknowledgement-error";
import type { Environment } from "../runner/environment";
import { readBootstrapMarkersStrict } from "./bootstrap-log";
import { findLiveServiceSupervisor } from "./service-supervisor-relaunch";

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

function readSupervisor(
  environment: Environment,
  deadlineMs: number,
): Promise<SpawnAckSupervisorState> {
  return readSpawnAckEvidenceWithin(
    async (): Promise<SpawnAckSupervisorState> =>
      (await findLiveServiceSupervisor(environment)) === null ? "none" : "live",
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
