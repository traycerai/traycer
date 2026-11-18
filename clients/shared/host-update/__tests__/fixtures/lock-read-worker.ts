import { acquireUpdateAttemptLock, probeAttemptHolder } from "../../lock";
import { readLockHolder } from "../../../host-lock/cross-process-lock";

const mode = process.env.LOCK_READ_WORKER_MODE;
const hostHomeDir = process.env.LOCK_READ_WORKER_HOME;
const lockPath = process.env.LOCK_READ_WORKER_PATH;

if (hostHomeDir === undefined || lockPath === undefined) {
  throw new Error("lock read worker requires home and lock path");
}

const result =
  mode === "acquire"
    ? await acquireUpdateAttemptLock({
        hostHomeDir,
        reason: "special-entry-regression",
        waitMs: 0,
        pollIntervalMs: 10,
      })
    : mode === "probe"
      ? await probeAttemptHolder({
          hostHomeDir,
          nowMs: Date.now(),
          cacheTtlMs: 0,
        })
      : await readLockHolder(lockPath);

process.stdout.write(`${JSON.stringify(result)}\n`);
