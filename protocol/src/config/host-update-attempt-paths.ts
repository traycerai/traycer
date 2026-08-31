import { join } from "node:path";

// The two host-home resources the update transaction is built on (Host
// update progress tech plan §1.1). They are deliberately SEPARATE files
// with separate lifetimes:
//
//   update-attempt.lock  - the execution authority. A path-based
//                          `cross-process-lock` file; exists only while a
//                          segment is executing, and is broken only on
//                          positive evidence its holder is gone.
//   update-attempt.json  - the retained evidence. Written atomically by
//                          the current lock holder, and outlives every
//                          segment (a parked or terminal attempt has a
//                          record and deliberately no lock).
//
// Neither replaces the legacy `update-progress.json` marker, which remains
// untouched and authoritative until the cutover ticket retires it.
//
// ### Why these take a directory instead of an `Environment`
//
// The same reason `./host-stop-intent` does: the readers resolve the host
// runtime home through deliberately different machinery (the CLI's
// `hostHomeDir(environment)` applies dev-run slot nesting; the desktop's
// `getHostFsLayout(environment).rootDir` applies its own copy of that rule;
// the host resolves its own `--host-data-dir`). Those always name the same
// directory for the same host, so taking the directory as input makes the
// agreement structural instead of a slot rule duplicated in a third place
// that can drift.
//
// ### Why this lives in `@traycer/protocol/config`
//
// Same reason as `./host-stop-intent` and `./installation-records`: three
// separate processes in TWO repositories must resolve the exact same file and
// agree on the exact same bytes, and `traycer-host` cannot import
// `@traycer-clients/shared`. `@traycer-clients/shared/host-update/paths` is
// now a re-export of this module, so there is exactly one definition of these
// filenames. A second one is how a reader ends up watching a path nobody
// writes.
//
// Split from `./host-update-attempt` (the pure record contract) because that
// module is renderer-reachable through `host/status/contracts.ts`'s `import
// type`, and this one imports `node:path`. Same split, same reason, as
// `./installation-records` vs `./installation`.

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
