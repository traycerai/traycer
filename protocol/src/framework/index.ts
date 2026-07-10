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
  AnyOfJsonSchema,
  ArrayJsonSchema,
  ContractJsonSchemas,
  EnumJsonSchema,
  JsonSchemaFingerprint,
  ObjectJsonSchema,
  RegistryJsonSchemas,
} from "./versioned-rpc";

export {
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
  HostFrame,
  HostOpenAckFrame,
  HostResponseFrame,
  HostFatalErrorFrame,
  IncompatibilityUpgradeGuidance,
  IncompatibleMethodBlocking,
  IncompatibleMethodDetails,
  FatalErrorDetails,
} from "./ws-protocol";

export {
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
  schemaVersionSchema,
  fatalErrorDetailsSchema,
} from "./ws-protocol";

export type {
  ManifestRegistry,
  SplitConnectionManifest,
} from "./capability-manifest";

export {
  buildConnectionManifest,
  mergeConnectionManifests,
  splitConnectionManifest,
} from "./capability-manifest";

export type {
  CompatibilityCheckResult,
  CompatibilityRole,
} from "./compatibility-checker";
export { check as checkCompatibility } from "./compatibility-checker";
