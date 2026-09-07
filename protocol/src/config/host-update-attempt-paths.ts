import { join } from "node:path";

// The two host-home resources the update transaction is built on (Host update progress tech plan §1.1).
// Same reason as `./host-stop-intent` and `./installation-records`: three separate processes in TWO repositories must resolve the exact same file and agree on the exact same bytes, and `traycer-host` cannot import.

export const UPDATE_ATTEMPT_RECORD_FILENAME = "update-attempt.json";
export const UPDATE_ATTEMPT_LOCK_FILENAME = "update-attempt.lock";

/** Retained attempt evidence, given the host runtime home that contains it. */
export function updateAttemptRecordPath(hostHomeDir: string): string {
  return join(hostHomeDir, UPDATE_ATTEMPT_RECORD_FILENAME);
}

/** Execution authority for the attempt, given the same host runtime home. */
export function updateAttemptLockPath(hostHomeDir: string): string {
  return join(hostHomeDir, UPDATE_ATTEMPT_LOCK_FILENAME);
}
