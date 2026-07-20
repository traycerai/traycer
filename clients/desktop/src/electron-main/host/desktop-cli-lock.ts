// Desktop-held implementation of the `cli-lock` file protocol (Host
// Update Layer Redesign Tech Plan, "cli-lock" rule 3: "Electron main
// implements the identical lock protocol [as the CLI] (same file, desktop
// PID + start-time identity)"). The protocol itself - open with
// O_CREAT|O_EXCL, holder identity, only-positive-evidence breaking, the
// `.break` arbitration sub-lock - lives in
// `@traycer-clients/shared/host-lock/cross-process-lock`, the SAME module
// the CLI's own `store/cli-lock.ts` wraps, so a CLI-owned mutation and a
// desktop-held section exclude each other via ordinary O_CREAT|O_EXCL
// contention on one file with zero risk of the two implementations
// drifting apart. This file only renames the shared, outcome-based API to
// the desktop-facing names existing callers use - `HostController`'s own
// bounded-retry-then-classify contract already matches the shared module's
// discriminated-outcome convention (never throws on busy), so there is no
// adaptation to do here beyond naming.
export type {
  LockHandle as DesktopCliLockHandle,
  LockMetadata as DesktopCliLockMetadata,
  AcquireLockOptions as AcquireDesktopCliLockOptions,
  AcquireLockOutcome as AcquireDesktopCliLockOutcome,
  WithLockOutcome as WithDesktopCliLockOutcome,
} from "@traycer-clients/shared/host-lock/cross-process-lock";
export {
  acquireLock as acquireDesktopCliLock,
  withLock as withDesktopCliLock,
} from "@traycer-clients/shared/host-lock/cross-process-lock";
