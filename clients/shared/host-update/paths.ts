// The two host-home resources the update transaction is built on.
// The path helpers moved to `@traycer/protocol/config/host-update-attempt-paths`, for the reason given in `./record`: `traycer-host` resolves the same two files and cannot import this package.

export {
  UPDATE_ATTEMPT_LOCK_FILENAME,
  UPDATE_ATTEMPT_RECORD_FILENAME,
  updateAttemptLockPath,
  updateAttemptRecordPath,
} from "@traycer/protocol/config/host-update-attempt-paths";
