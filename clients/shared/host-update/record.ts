// The durable host-update attempt record and the pure algebra over it.
// Why: `traycer-host` projects this record into `host.status` and cannot import `@traycer-clients/shared` at all.

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
