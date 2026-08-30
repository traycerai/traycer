// The durable host-update attempt record and the pure algebra over it.
//
// THE DEFINITION MOVED. It now lives in
// `@traycer/protocol/config/host-update-attempt`, and this module is a
// re-export so every existing client import keeps resolving unchanged.
//
// Why: `traycer-host` projects this record into `host.status` and cannot
// import `@traycer-clients/shared` at all. The alternative was a second
// decoder for one file, which is how two readers end up disagreeing about
// bytes neither of them changed - the record already grew `recovery` without
// a schema bump (deliberately, so retained v2 records stay readable), and a
// decoder that had not learned about it would read a perfectly good record as
// `corrupt`. That is a fail-closed VERDICT, not a missing detail.
//
// `@traycer/protocol/config` is where a host-home file contract shared by two
// repositories already lives - see `config/host-stop-intent`,
// `config/installation-records`, and `config/credentials-lock`, all of which
// `traycer-host` reads today.
//
// Nothing about the shape, the algebra, or the fail-closed rules changed in
// the move; the suites in `__tests__` exercise this module's re-exports
// verbatim and are the proof of that.

export type {
  HostUpdateAttemptContinuation,
  HostUpdateAttemptError,
  HostUpdateAttemptExecution,
  HostUpdateAttemptIdentity,
  HostUpdateAttemptPhase,
  HostUpdateAttemptProgress,
  HostUpdateAttemptRecovery,
  HostUpdateAttemptRecoveryArtifactLeg,
  HostUpdateAttemptRecoveryRunningLeg,
  HostUpdateAttemptRecord,
  HostUpdateTrigger,
} from "@traycer/protocol/config/host-update-attempt";

export {
  HOST_UPDATE_ATTEMPT_PHASES,
  HOST_UPDATE_ATTEMPT_SCHEMA_VERSION,
  HOST_UPDATE_ATTEMPT_SUPPORTED_VERSIONS,
  HOST_UPDATE_TRIGGERS,
  MAX_INCREMENTABLE_ATTEMPT_COUNTER,
  TERMINAL_ATTEMPT_RETENTION_MS,
  attemptIdentityOf,
  compareAttemptOrder,
  continuationLegalFor,
  executionForPhase,
  isActivePhase,
  isParkedPhase,
  isTerminalPhase,
  isTerminalRetentionExpired,
  nextAttemptCounter,
  parkContinuationFor,
  sameAttemptIdentity,
} from "@traycer/protocol/config/host-update-attempt";
