// Durable host-update attempt core — the shared foundation the CLI, the
// desktop, and (later) the host reconciler all contend through.
//
// See `README.md` in this directory for the lock-order rule, the ordering
// key, and what this layer deliberately does NOT do yet.

export {
  UPDATE_ATTEMPT_LOCK_FILENAME,
  UPDATE_ATTEMPT_RECORD_FILENAME,
  updateAttemptLockPath,
  updateAttemptRecordPath,
} from "./paths";

export type {
  HostUpdateAttemptContinuation,
  HostUpdateAttemptError,
  HostUpdateAttemptExecution,
  HostUpdateAttemptIdentity,
  HostUpdateAttemptPhase,
  HostUpdateAttemptProgress,
  HostUpdateAttemptRecovery,
  HostUpdateAttemptRecord,
  HostUpdateTrigger,
} from "./record";
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
} from "./record";

export type {
  DurableBytes,
  FileReadResult,
  HostUpdateAttemptRead,
} from "./decode";
export { decodeHostUpdateAttempt, fileReadToDurableBytes } from "./decode";

// NOTE: there is deliberately no raw write or delete here. The canonical
// record changes only through the two handle-bound operations below, which
// verify live lock ownership and re-read disk before touching anything.
export type {
  AttemptCommitOutcome,
  PublicAttemptMutationIntent,
  PublicAttemptMutationIntent as AttemptMutationIntent,
  AttemptMutationRejection,
  AttemptPruneOutcome,
  AttemptPruneRejection,
  CommitAttemptMutationOptions,
  PruneTerminalAttemptRecordOptions,
} from "./store";
export {
  AttemptRecordDurabilityError,
  commitAttemptMutation,
  pruneTerminalAttemptRecord,
  readRegularFileNoFollow,
  readUpdateAttemptRecord,
} from "./store";
export type { RegularFileNoFollowRead } from "./store";

export type {
  AcquireUpdateAttemptLockOptions,
  AcquireUpdateAttemptLockOutcome,
  AttemptLockLivenessPublication,
  AttemptMutationLease,
  AttemptMutationLeaseOutcome,
  AttemptHolderEvidence,
  AttemptLockOwnership,
  LockMetadata,
  ProbeAttemptHolderOptions,
  UpdateAttemptLockHandle,
  WithUpdateAttemptLockOutcome,
} from "./lock";
export {
  acquireUpdateAttemptLock,
  acquireAttemptMutationLease,
  isUpdateAttemptLockHeldInProcess,
  probeAttemptHolder,
  verifyAttemptLockOwnership,
  withUpdateAttemptLock,
} from "./lock";

export type {
  ActiveHostUpdateAttemptPhase,
  AttemptAdvance,
  AttemptAdvanceOutcome,
  AttemptAdvanceRejection,
  AttemptClaimContext,
  AttemptClaimDecision,
  AttemptClaimAction,
  AttemptClaimHolderDisposition,
  AttemptClaimRequest,
  AttemptRecoveryArtifactEvidence,
  AttemptRecoveryContext,
  AttemptRecoveryDecision,
  AttemptRecoveryEvidence,
  AttemptRecoveryHolderDisposition,
  AttemptRecoveryRefusal,
  AttemptRecoveryRequest,
  AttemptRecoveryRunningEvidence,
  AttemptRefusalReason,
} from "./transition";
export {
  advanceAttempt,
  decideAttemptClaim,
  decideAttemptRecovery,
  isLegalPhaseTransition,
} from "./transition";

export type { AttemptLiveness, AttemptLivenessInput } from "./liveness";
export {
  RECOMMENDED_ATTEMPT_STALENESS_MS,
  deriveAttemptLiveness,
} from "./liveness";

export type {
  ActiveAttemptDisposition,
  UpdateContenderExecutionContext,
  UpdateContenderAdmission,
  UpdateRecoveryAction,
  UpdateContenderOutcome,
  UpdateMaintenanceExemption,
  UpdateMutationCapability,
  UpdateMutationCapabilityAdoption,
  UpdateMutationCapabilityVerdict,
  WithUpdateContenderOptions,
} from "./contender";
export {
  verifyUpdateMutationCapability,
  createUpdateMutationCapabilityAdoption,
  validateUpdateMutationCapabilityAdoption,
  rebindUpdateMutationCapabilityLiveness,
  withUpdateContender,
  commitAttemptMutationWithCapability,
  withUpdateContenderAdoption,
} from "./contender";

// The parent-to-child adoption proof transport (Ticket 05, Ruling 1). The
// MINT is deliberately not here: it is a two-line composition of
// `createUpdateMutationCapabilityAdoption` with `writeAdoptionProof` at each
// call site, which is what keeps this module free of any reference to
// `contender.ts` and therefore out of that module's pinned importer set.
export {
  UPDATE_ADOPTION_MAX_AGE_MS,
  writeAdoptionProof,
  consumeUpdateAttemptAdoption,
  resolveAttemptAdoptionFromNonce,
} from "./adoption-transport";
export type {
  PublishedUpdateAdoption,
  ConsumedUpdateAdoption,
} from "./adoption-transport";

// Ticket 07's compatibility fence. Pure decisions only - no filesystem, no
// clock - so the whole matrix is exhaustively testable and both the CLI and
// Desktop consume ONE definition of the floors rather than each keeping a copy.
export {
  COMPATIBILITY_FLOOR_UNPINNED,
  LOCK_AWARE_CLI_FLOOR,
  LOCK_AWARE_DESKTOP_FLOOR,
  SHIPPED_COMPATIBILITY_FLOORS,
  decideCompatibilityFence,
  decideLegacyMarkerConcurrency,
  resolveCohortPolicy,
} from "./compatibility-fence";
export type {
  CompatibilityFenceInput,
  CompatibilityFloors,
  CompatibilityFenceVerdict,
  CompatibilityRefusalReason,
  CohortPolicyResolution,
  CohortPolicySource,
  LegacyMarkerAbortDisposition,
  LegacyMarkerConcurrencyInput,
  LegacyMarkerConcurrencyVerdict,
  SignedCohortPolicy,
} from "./compatibility-fence";

// Ticket 07 §4.2 shadow/telemetry gates. Pure shaping only; the collection
// side supplies counts. `insufficient-data` is a first-class arm because a
// ratio over an empty denominator is unknown, not zero.
export {
  evaluateGate,
  gateClears,
  isBackfillObservationHealthy,
  isJournalObservationHealthy,
  isLegacyMarkerObservationHealthy,
  isAdoptionObservationHealthy,
  isTerminalizationObservationHealthy,
} from "./cutover-telemetry";
export type {
  CutoverGateId,
  GateReading,
  GateSample,
  GateSampleDefect,
} from "./cutover-telemetry";
