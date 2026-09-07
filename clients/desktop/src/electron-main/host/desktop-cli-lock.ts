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
