// The client replica runtime's interface seam — the contracts the replica,
// its adapters, its leases, its registry, its accountant, and its command
// overlay are all written against.
//
// This directory is types plus the few pure helpers whose semantics would
// otherwise be re-invented once per plane. It moves no existing code; the
// extraction that fills these seams in is a separate change.
//
// See `README.md` in this directory for what each seam is for, which existing
// code it is destined to absorb, and the rules that are non-negotiable.

export type {
  MonotonicSequence,
  RuntimeClock,
  RuntimeEnvironment,
  RuntimeLogFields,
  RuntimeLogger,
  RuntimeScheduler,
  RuntimeTimer,
} from "./runtime-environment";
export { createMonotonicSequence } from "./runtime-environment";

export type {
  BarrierRef,
  CursorComparison,
  CursorResumeOffer,
  DocSeedResumeOffer,
  LaneCursor,
  LaneId,
  ReseedReason,
  ResumeOffer,
  ResumeOutcome,
} from "./lane-cursor";
export { advancesLaneCursor, compareLaneCursors } from "./lane-cursor";

export type { ProjectionDelivery, ProjectionSink } from "./projection-sink";
export { createTransactionalProjectionSink } from "./projection-sink";

export type {
  ClassFreshness,
  FreshnessReport,
  FreshnessStatus,
  SeedTrust,
} from "./freshness";
export { unknownFreshness } from "./freshness";

export type {
  PlaneId,
  Replica,
  ReplicaApplyOutcome,
  ReplicaClientResetIntent,
  ReplicaDataClass,
  ReplicaIgnoreReason,
  ReplicaReplacementReason,
  ReplicaResetCause,
} from "./replica";

export type {
  ControlEvent,
  DocAwarenessEvent,
  DocCoverageAckEvent,
  DocReadyEvent,
  DocReplicaEvent,
  DocSeedMode,
  DocSnapshotEvent,
  DocUnavailableCode,
  DocUnavailableEvent,
  DocUpdateEvent,
  EphemeralEvent,
  LogAppendEvent,
  LogRangeEvent,
  LogReindexedEvent,
  LogReplicaEvent,
  LogRow,
  LogRowsUpdatedEvent,
  LogSnapshotEvent,
  MigrationStage,
  MigrationStatus,
  OrdinalSpan,
  RecordChange,
  RecordPollAnswerEvent,
  RecordReplicaEvent,
  RecordRow,
  RecordSnapshotEvent,
  RecordTransactionEvent,
  RecordTrustEvent,
} from "./replica-events";

export type { GenerationGuard } from "./generation-guard";
export { createGenerationGuard, guardHandler } from "./generation-guard";

export type {
  AdapterDescriptor,
  AdapterDetachReason,
  AdapterHost,
  AdapterKind,
  AdapterSelection,
  AdapterSelector,
  AdapterStatus,
  LaneAdapter,
  LaneRequester,
  SendOutcome,
} from "./adapter";

export type {
  LeaseGrant,
  LeaseHandle,
  LeaseMaterializer,
  LeasePolicy,
  LeaseRegistry,
  LeaseRegistryOptions,
} from "./lease";

export type {
  ReleaseDisposition,
  SessionDisposeCause,
  SessionDisposeVerdict,
  SessionEntryView,
  SessionKey,
  SessionRegistry,
  SessionRegistryOptions,
  SessionRegistryPolicy,
  WarmCapScope,
} from "./session-registry";
export { createSessionRegistry, sessionKeyOf } from "./session-registry";

export type {
  AccountantSnapshot,
  BudgetEvictionHook,
  BudgetHolderId,
  BudgetPlaneId,
  BudgetPressure,
  BudgetRegistration,
  EvictionOutcome,
  KnownBudgetPlaneId,
  MemoryAccountant,
  MemoryAccountantOptions,
  PlaneBudgetSpec,
  PlaneUsage,
  ProtectedBytes,
  ProtectedRegionKind,
} from "./memory-accountant";
export { BUDGET_PLANE_IDS, createMemoryAccountant } from "./memory-accountant";

export type {
  CommandEnqueueRequest,
  CommandDeliveryState,
  CommandId,
  CommandIdFactory,
  CommandOverlay,
  CommandQueue,
  CommandQueueOptions,
  CommandRecord,
  CommandResolution,
  CommandSendFailure,
  CommandState,
} from "./command-overlay";
export { createCommandQueue } from "./command-overlay";

export type { PlaneRegistration, ReplicaRuntime } from "./replica-runtime";
