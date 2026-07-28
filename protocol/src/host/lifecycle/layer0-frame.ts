/**
 * The Layer 0 status frame: a host -> client wire payload.
 *
 * It lives here because that is what it is. The host emits these frames on its
 * status fd during startup and the CLI's probe reads them, which makes the
 * shape a client<->host contract and `@traycer/protocol` its owner by the
 * repo's own rule.
 *
 * It did not start here. The host declared the union in
 * `traycer-host/src/lifecycle/layer0-lock.ts` and the OSS client carried a
 * hand-written "wire-level copy" in `host-lifecycle/transition/probe.ts`,
 * with a comment explaining that duplication kept the internal package out of
 * the client tree. The copy had already drifted: it carried a fourth
 * `layer0: "unavailable"` variant the host has no way to emit, and the
 * exhaustiveness test that was supposed to catch exactly this asserted
 * exhaustiveness OVER THE COPY - so it could never observe a host-side
 * addition, and proved a property of a type that was not the source of truth.
 *
 * One declaration, imported by both sides, is the only version of this that
 * cannot drift.
 */

/** Why Layer 0 could not establish a trusted verdict. */
export type Layer0UnavailableCause =
  | "addon-load-failed"
  | "fs-unsupported"
  | "lock-path-invalid"
  // Windows only. The lock file could not be opened exclusively, but nothing
  // corroborates that another host holds it.
  //
  // POSIX `flock` returning EWOULDBLOCK means *another flock holder*, and
  // nothing else in the system takes an flock on this path. The Windows
  // acquire is a share-mode-0 `CreateFileW`, where `ERROR_SHARING_VIOLATION`
  // means *anyone has the file open at all* - Defender's real-time filter,
  // the Search indexer, a VSS/backup agent, or OneDrive when `~/.traycer`
  // sits in a synced folder. Treating that as a held lock would decline
  // startup against an incumbent that does not exist, which is the one place
  // a lock problem could block a start that should proceed.
  | "sharing-violation-unattested"
  | {
      readonly kind: "os-error";
      readonly syscall: string;
      readonly code: string;
      readonly fsType: string | null;
    };

/** What the loser of a contention learned about the winner. */
export type Layer0IncumbentEvidence =
  | {
      readonly kind: "pid-metadata";
      readonly pid: number;
      readonly hostId: string;
      readonly startedAt: string;
    }
  | {
      readonly kind: "held-retry-window";
      readonly lockPath: string;
      readonly observedForMs: number;
    };

/**
 * Exactly three outcomes, because `layer0PreventsStartup` is total over them
 * and only `declined` may stop a start. There is deliberately no
 * `unavailable` variant: an unavailable lock is a `degraded` start, not a
 * fourth state - a new safety mechanism must never make availability worse
 * than not having it.
 */
export type Layer0Frame =
  | { readonly attemptId: string; readonly layer0: "acquired" }
  | {
      readonly attemptId: string;
      readonly layer0: "declined";
      readonly incumbentEvidence: Layer0IncumbentEvidence;
    }
  | {
      readonly attemptId: string;
      readonly layer0: "degraded";
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    };
