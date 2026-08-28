// The two host-home resources the update transaction is built on.
//
// THE PATH HELPERS MOVED to
// `@traycer/protocol/config/host-update-attempt-paths`, for the reason given
// in `./record`: `traycer-host` resolves the same two files and cannot import
// this package. Two definitions of a filename is how a reader ends up
// watching a path nobody writes.
//
// The protocol module carries the full rationale - why these take a directory
// instead of an `Environment`, and why the lock and the record are separate
// files with separate lifetimes.

export {
  UPDATE_ATTEMPT_LOCK_FILENAME,
  UPDATE_ATTEMPT_RECORD_FILENAME,
  updateAttemptLockPath,
  updateAttemptRecordPath,
} from "@traycer/protocol/config/host-update-attempt-paths";
