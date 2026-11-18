// Host lifecycle substrate — read-only evidence algebra, per-platform parsers,
// durable-record codecs, and the journaled transition/activation primitives the
// CLI and desktop actually consume.
//
// The autonomous decision layer (planner, actuators, the three world probes,
// the transition/activation reconcilers) was built to full generality before
// any consumer existed and reached zero production callers. It is archived in
// the epic's `parked-decision-layer` artifact rather than carried here — see
// that artifact before re-introducing any of it.

export type { Evidence, DurableRecord } from "./evidence";
export { observed, absent, indeterminate, assertNever } from "./evidence";

export type {
  TraycerIdentityAttestation,
  TraycerLabelIds,
  IdentitySignal,
} from "./identity";
export {
  attestTraycerRegistration,
  isEvictableTraycerIdentity,
  isTraycerLabelShape,
  traycerLabelIdsForBase,
  COMPATIBLE_HOST_START_SCRIPT_PREFIX,
  HOST_START_LAUNCHER_BASENAME,
  TRAYCER_HOST_CONTENT_TAG,
} from "./identity";

export type {
  SubstrateRecord,
  TransitionJournal,
  TransitionGovernor,
  InstallRecord,
  PendingActivation,
} from "./durable/records";
export {
  SUBSTRATE_SUPPORTED_VERSIONS,
  SUBSTRATE_RECORD_WRITE_VERSION,
  TRANSITION_SUPPORTED_VERSIONS,
  ACTIVATION_JOURNAL_SUPPORTED_VERSIONS,
  INSTALL_SUPPORTED_VERSIONS,
  PENDING_ACTIVATION_SUPPORTED_VERSIONS,
} from "./durable/records";

export type { DurableBytes, FileReadResult } from "./durable/decoder";
export {
  decodeDurableRecord,
  decodeSubstrateRecord,
  decodeTransitionJournal,
  decodeInstallRecord,
  decodePendingActivation,
  fileReadToDurableBytes,
} from "./durable/decoder";

export type {
  BooleanSentinelKey,
  BooleanSentinelRecord,
  SentinelIndeterminateCause,
} from "./durable/sentinel";
export {
  BOOLEAN_SENTINEL_SUPPORTED_VERSIONS,
  booleanSentinelToEvidence,
  decodeBooleanSentinel,
} from "./durable/sentinel";

export type {
  DurableRepairPriorDecode,
  DurableRepairTarget,
  RepairCanonicalEffect,
} from "./durable/repair";
export {
  CANONICAL_BOOLEAN_SENTINEL_VERSION,
  canonicalBooleanSentinelBytes,
  repairCanonical,
  repairCanonicalVerdict,
  repairTargetSentinelKey,
  sentinelDecodeIsFaulted,
  sentinelPriorDecode,
} from "./durable/repair";

export type {
  Reachability,
  ReachabilityProbeOutcome,
} from "./shared/reachability";
export { classifyReachability } from "./shared/reachability";

export type {
  HostPidMetadata,
  HostProcessEvidence,
  AttemptReadiness,
  ReadinessRung,
  PidMetadataDecodeCause,
} from "./shared/host-process";
export {
  decodeHostPidMetadata,
  mapPidMetadataEvidence,
} from "./shared/host-process";

export type { CliSlotValidity, CliSlotProbeInput } from "./shared/cli-slot";
export { classifyCliSlot } from "./shared/cli-slot";

export type {
  ProbeCommandResult,
  ProbeCommandOptions,
  ProbeCommandRunner,
} from "./shared/command";
export { combinedOutput } from "./shared/command";

// ---- macOS ----------------------------------------------------------------
export type {
  IndeterminateCause,
  MacosEvidence,
  SmAppServiceSignals,
  LabelOwnership,
  LwcrEvidence,
  LaunchdRunState,
  LaunchctlPrintProbe,
  ManifestProbe,
  MacosLabelRole,
  MacosLabelView,
  HostLoginItemStatus,
  LoginItemStatus,
  WedgeReason,
  WedgeVerdict,
  MacosCapabilities,
  MacosWorld,
} from "./macos/types";
export {
  SMAPPSERVICE_PATH_UNKNOWN,
  SERVICE_MANAGEMENT_MANAGED_BY,
  SERVICE_MANAGEMENT_JOB_TYPE,
} from "./macos/types";
export {
  parseLaunchctlPrintFields,
  isSmAppServiceLaunchAgentPath,
  classifyLabelOwnership,
  extractProgramArgumentsFromPrint,
  parseLaunchdRunState,
  parseLwcrEvidence,
  classifyLaunchctlPrintResult,
  isLaunchctlNotFoundOutput,
  isLaunchctlPermissionOutput,
} from "./macos/launchctl-print";
export { deriveWedgeVerdict } from "./macos/wedge";

// ---- Linux ----------------------------------------------------------------
export type {
  LinuxIndeterminateCause,
  LinuxEvidence,
  UnitFileState,
  UserBusAvailability,
  UserManagerState,
  UnitLoadState,
  UnitEnablement,
  UnitEnablementState,
  UnitActivity,
  DaemonReloadFreshness,
  LingerState,
  LogindSession,
  LogindSessionState,
  LinuxWorld,
} from "./linux/types";
export {
  classifyUnitFile,
  extractExecStartTokens,
  tokenizeExecStart,
  classifyLingerState,
} from "./linux/unit-file";

// The mutation-result shape `activation/types` builds on. The rest of
// `actuators/` is parked - see the header note.
export type { MutationResult } from "./actuators/conditional-mutation";

// ---- Journaled substrate transitions --------------------------------------
export type {
  Layer0Frame,
  Layer0Degradation,
  Layer0IncumbentEvidence,
  Layer0UnavailableCause,
  ProbeMarker,
  ProbeMarkerOutcome,
  ProbeSupervisorAttestation,
  ProbeVerdict,
} from "./transition/probe";
export {
  interpretProbeMarker,
  mapLayer0FrameToProbeOutcome,
} from "./transition/probe";
export type {
  FallbackSlotAttestation,
  LifecycleTransitionJournal,
  ProbeLaunchResult,
  ReclaimShutdownResult,
  RegistrationDurability,
  SubstrateSnapshot,
  SubstrateTransitionKind,
  TransitionActuators,
  TransitionFailureClass,
  TransitionJournalRead,
  TransitionJournalStore,
  TransitionPhase,
  TransitionResult,
  TransitionWorld,
} from "./transition/types";
export {
  EMPTY_TRANSITION_GOVERNOR,
  evaluateGovernorEligibility,
  recordSustainedTransitionHealth,
  recordTransitionFailure,
} from "./transition/governor";
export {
  advanceTransitionJournal,
  createTransitionJournal,
  failTransitionJournal,
  finishTransitionJournal,
  isTerminalPhase,
} from "./transition/journal";

// ---- Journaled install activation -----------------------------------------
export type {
  ActivationActuators,
  ActivationAttempt,
  ActivationDiskState,
  ActivationFailureClass,
  ActivationJournalRead,
  ActivationJournalStore,
  ActivationPhase,
  ActivationResult,
  LifecycleActivationJournal,
  StopClaimResult,
  StopCommitResult,
} from "./activation/types";
export { ACTIVATION_PHASES, isActivationPhase } from "./activation/types";
export {
  advanceActivationJournal,
  createActivationJournal,
  failActivationJournal,
  finishActivationJournal,
  isActivationTerminalPhase,
} from "./activation/journal";
