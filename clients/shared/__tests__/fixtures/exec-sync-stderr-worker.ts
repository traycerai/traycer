// Worker fixture for `exec-sync-stderr.test.ts`, run as a real Bun subprocess
// (never in-process) - see that file's header for why. Calls a REAL
// production function that shells out to `ps` via `execFileSync` on this
// platform, then prints its result as a single `RESULT:<json>` line on
// stdout so the parent test can read it without touching this process's own
// stderr (which the test captures separately, from the OUTSIDE, to check
// whether the child `ps`'s stderr leaked into it).
import { readProcessStartTimeMs } from "../../host-lock/process-identity";
import { ownPidStartFingerprint } from "../../../../protocol/src/config/credentials-lock";

const target = process.env.WORKER_TARGET;

function resultFor(workerTarget: string | undefined): number | string | null {
  if (workerTarget === "shared") {
    // clients/shared/host-lock/process-identity.ts: shells out to `ps` on
    // every non-Windows platform unconditionally (readPosixProcessStartTimeMs).
    return readProcessStartTimeMs(process.pid);
  }
  if (workerTarget === "protocol") {
    // protocol/src/config/credentials-lock.ts: shells out to `ps` via
    // `psLstart` only on POSIX platforms OTHER than Linux (Linux reads
    // `/proc/<pid>/stat` directly and never spawns anything) - see
    // `queryPidStartFingerprint`.
    return ownPidStartFingerprint();
  }
  throw new Error(
    `exec-sync-stderr-worker: unknown WORKER_TARGET ${JSON.stringify(workerTarget)}`,
  );
}

const result = resultFor(target);
console.log(`RESULT:${JSON.stringify(result)}`);
