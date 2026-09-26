import type { Environment } from "../runner/environment";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import {
  readSupervisorRecord,
  readSupervisorRunState,
  type SupervisorRunAdmission,
} from "./lifecycle-files";

/** The supervisor running this environment's host, provably alive. */
export interface LiveSupervisorRun {
  readonly supervisorPid: number;
  readonly admission: SupervisorRunAdmission;
}

/**
 * The supervisor running right now for this environment, or `null`.
 *
 * The one reader for "is a supervisor alive here, and how was it admitted?"
 * that a CLI command acts on - a stop that must tell a terminal-started host
 * from the service's, and a start that must not launch over a supervisor
 * already relaunching its host. Both are decisions to NOT do the ordinary
 * thing, so every answer here is positive evidence and every doubt is `null`:
 *
 * - `supervisor.json` and `supervisor-run.json` must name the same pid, the
 *   pairing `readHostLifecycleSnapshot` uses. A run state left behind by an
 *   exit that owes a successor (77 / 76 keep it; `SupervisorRecordRemoval`)
 *   has no `supervisor.json` beside it, so it is never read as a running
 *   supervisor.
 * - The recorded pid must be the recorded process instance: pid plus the
 *   start identity it wrote at admission. A dead pid, a pid the OS handed to
 *   another process, a record with no identity, and a probe that could not
 *   tell all read as `null`.
 */
export async function readLiveSupervisorRun(
  environment: Environment,
): Promise<LiveSupervisorRun | null> {
  const [supervisor, run] = await Promise.all([
    readSupervisorRecord(environment),
    readSupervisorRunState(environment),
  ]);
  if (supervisor.kind !== "valid" || run.kind !== "valid") return null;
  if (run.record.supervisorPid !== supervisor.record.pid) return null;
  const verdict = await getPublishedProcessIdentityVerdict(
    run.record.supervisorPid,
    run.record.supervisorStartIdentity,
  );
  return verdict === "current"
    ? {
        supervisorPid: run.record.supervisorPid,
        admission: run.record.admission,
      }
    : null;
}
