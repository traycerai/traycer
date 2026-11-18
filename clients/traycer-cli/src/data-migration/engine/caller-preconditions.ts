import {
  surveyAdmittedProcesses,
  type ProcessIncarnationProbe,
} from "@traycer/protocol/config/data-migration-admission";
import { stopWith } from "./engine-types";

/**
 * What the process that runs the engine (the coordinator) must be, which the
 * command layer (ticket 718-7) has to arrange and the engine enforces:
 *
 * 1. It holds NO ordinary data-migration admission. An admitted process is a
 *    participant the barrier waits for; a coordinator that admitted itself
 *    would wait on itself, and would count as a writer of the root it is
 *    moving. Enforced here, at every engine entry, from the admission
 *    registry: an entry naming this pid that is not proven exited or recycled
 *    refuses (`coordinator-admitted`).
 * 2. It never writes the source data folder: no log file, working directory
 *    or other open handle inside it. Its executable image may live there (the
 *    CLI is installed in the data folder). Enforced at quiescence by the
 *    process census, which excludes the coordinator only when its verified
 *    incarnation's sole use of the root is its image (`excludeCoordinator`);
 *    any other use blocks as `process-using-data-folder`.
 * 3. It holds the migration coordinator lock for the whole operation, which
 *    every entry point acquires before doing anything else.
 *
 * Regression seam: tests create an admission entry for their own pid in an
 * isolated bootstrap folder and expect the refusal.
 */
export async function assertCallerPreconditions(input: {
  readonly bootstrapDir: string;
  readonly probe: ProcessIncarnationProbe;
  readonly selfPid: number;
}): Promise<void> {
  const survey = await surveyAdmittedProcesses({
    bootstrapDir: input.bootstrapDir,
    probe: input.probe,
    reap: false,
  });
  const self = survey.processes.find(
    (report) =>
      report.entry !== null &&
      report.entry.pid === input.selfPid &&
      report.state !== "exited" &&
      report.state !== "recycled",
  );
  if (self !== undefined) {
    throw stopWith(
      "blocked",
      "coordinator-admitted",
      self.entryId,
      "the process running the migration is registered as an ordinary Traycer participant; it must run without that registration",
    );
  }
}
