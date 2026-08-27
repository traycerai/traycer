/**
 * Public surface of the versioned message framework.
 *
 * This module is the single source of truth for two parallel contract
 * families:
 *
 * - **RPC contracts** - paired request/response schemas for wire calls
 *   (`defineRpcContract`, `defineVersionedRpcRegistry`, ...).
 * - **Record contracts** - single schemas for stored records
 *   (`defineRecordContract`, `defineVersionedRecordRegistry`, ...).
 *
 * Both families share the same versioning rules (major/minor lines,
 * additive minors, breaking-only majors, direct downgrade bridges). Keep
 * them structurally identical - drift between the two families is a bug.
 */

// ---- Versioned RPC (request/response) ---------------------------------- //

export type {
  AnyDowngradePath,
  AnyRpcContract,
  AnyUpgradePath,
  AnyVersionEntry,
  ContextlessUpgradePath,
  ContextualUpgradePath,
  ContractForInstalledVersion,
  DowngradePath,
  DowngradeResult,
  FallbackMethodDegrade,
  InstalledSchemaVersion,
  LatestContract,
  MajorVersionLine,
  MethodDegradeDeclaration,
  MethodVersionRegistry,
  RequestOf,
  ResponseOf,
  RpcContract,
  RpcErrorCode,
  RpcErrorDetails,
  RpcErrorFor,
  RpcRequestFor,
  RpcResultFor,
  RpcResponseUpgradeContext,
  RpcSuccessFor,
  SchemaVersion,
  UncheckedMethodVersionRegistry,
  UncheckedVersionedRpcRegistry,
  UpgradePath,
  UnsupportedMethodDegrade,
  VersionEntry,
  VersionedRpcRegistry,
} from "./versioned-rpc-types";

export { RPC_ERROR_CODES, isRpcErrorCode } from "./versioned-rpc-types";

export type {
  WorktreeBusyErrorDetails,
  WorktreeBusyHoldKind,
  WorktreeBusyHolder,
  WorktreeBusyHolderActivity,
  WorktreeBusyHolders,
  WorktreeBusyOwnerKind,
  WorktreeBusyOwnerRef,
} from "./worktree-busy-holders";
export {
  worktreeBusyErrorDetailsSchema,
  worktreeBusyHoldKindSchema,
  worktreeBusyHolderActivitySchema,
  worktreeBusyHolderSchema,
  worktreeBusyHoldersSchema,
  worktreeBusyHoldersWireFieldSchema,
  worktreeBusyOwnerKindSchema,
  worktreeBusyOwnerRefSchema,
} from "./worktree-busy-holders";

export type {
  AnyOfJsonSchema,
  ArrayJsonSchema,
  ContractJsonSchemas,
  EnumJsonSchema,
  JsonSchemaFingerprint,
  ObjectJsonSchema,
  RegistryJsonSchemas,
} from "./versioned-rpc";

export {
  defineContextualUpgradePath,
  defineDowngradePath,
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  getLatestContract,
  toJsonSchemas,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
  upgradeResponseToVersionWithContext,
  validateVersionedRpcRegistryDegrades,
  validateVersionedRpcRegistry,
} from "./versioned-rpc";

// ---- Versioned records (single-schema persistence) --------------------- //

export type {
  AnyRecordContract,
  AnyRecordDowngradePath,
  AnyRecordUpgradePath,
  AnyRecordVersionEntry,
  ContractForInstalledVersion as RecordContractForInstalledVersion,
  InstalledSchemaVersion as RecordInstalledSchemaVersion,
  LatestRecordContract,
  MajorRecordVersionLine,
  RecordContract,
  RecordDowngradePath,
  RecordErrorCode,
  RecordErrorDetails,
  RecordUpgradePath,
  RecordVersionEntry,
  RecordVersionRegistry,
  UncheckedRecordVersionRegistry,
  UncheckedVersionedRecordRegistry,
  ValueOf,
  VersionedRecordRegistry,
} from "./versioned-record-types";

export type {
  AnyOfJsonSchema as RecordAnyOfJsonSchema,
  EnumJsonSchema as RecordEnumJsonSchema,
  ObjectJsonSchema as RecordObjectJsonSchema,
  RecordJsonSchema,
  RecordValue,
  RegistryJsonSchemas as RecordRegistryJsonSchemas,
} from "./versioned-record";

export {
  defineRecordContract,
  defineRecordDowngradePath,
  defineRecordUpgradePath,
  defineVersionedRecordRegistry,
  downgradeRecordAcrossMajors,
  getLatestRecordContract,
  getRecordSchema,
  loadRecord,
  parseRecord,
  toRecordJsonSchemas,
  upgradeRecordToVersion,
  validateVersionedRecordRegistry,
} from "./versioned-record";

// ---- WebSocket frame protocol + version negotiation ---------------------- //
//
// Transport-generic - used by the host RPC + stream surfaces today, and
// reusable by any future RPC consumer (cloud, relay) that adopts the same
// versioned-RPC framework.

export type {
  ClientFrame,
  ClientOpenFrame,
  ClientRequestFrame,
  ClientFatalErrorFrame,
  ConnectionManifest,
  ManifestMethodEntry,
  HostFrame,
  HostOpenAckFrame,
  HostResponseFrame,
  HostFatalErrorFrame,
  IncompatibilityUpgradeGuidance,
  IncompatibleMethodBlocking,
  IncompatibleMethodDetails,
  FatalErrorDetails,
  HostRestartIntent,
} from "./ws-protocol";

export {
  HOST_RESTARTING_FATAL_CODE,
  RPC_REQUEST_TIMEOUT_FATAL_CODE,
  clientFrameSchema,
  clientOpenFrameSchema,
  clientRequestFrameSchema,
  clientFatalErrorFrameSchema,
  connectionManifestSchema,
  hostFrameSchema,
  hostOpenAckFrameSchema,
  hostResponseErrorSchema,
  hostResponseFrameSchema,
  hostFatalErrorFrameSchema,
  incompatibilityUpgradeGuidanceSchema,
  incompatibleMethodDetailsSchema,
  manifestMethodEntrySchema,
  schemaVersionSchema,
  fatalErrorDetailsSchema,
  hostRestartIntentSchema,
} from "./ws-protocol";

// ---- Client handshake identity + compatibility epoch --------------------- //

export type {
  ClientCompatibilityFailure,
  ClientCompatibilityRequirement,
  ClientHandshakeIdentity,
  FirstPartyClientIdentity,
  FirstPartyClientKind,
  KnownHostReleaseChannel,
} from "./client-identity";

export {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  KNOWN_HOST_RELEASE_CHANNELS,
  LEGACY_CLIENT_COMPATIBILITY_EPOCH,
  MAX_DIAGNOSTIC_APP_VERSION_LENGTH,
  STRICT_SEMVER_PATTERN,
  clientCompatibilityRequirementSchema,
  clientHandshakeIdentitySchema,
  hostReleaseChannelAllowsRcRecovery,
  isStrictSemVer,
  isValidCompatibilityEpoch,
  toClientHandshakeIdentity,
} from "./client-identity";

export type {
  ManifestRegistry,
  SplitConnectionManifest,
} from "./capability-manifest";

export {
  buildConnectionManifest,
  mergeConnectionManifests,
  selectConnectionManifestForPeer,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "./capability-manifest";

export type { ServedMajorsByMethod } from "./capability-manifest";

export type {
  CompatibilityCheckResult,
  CompatibilityRole,
} from "./compatibility-checker";
export { check as checkCompatibility } from "./compatibility-checker";
