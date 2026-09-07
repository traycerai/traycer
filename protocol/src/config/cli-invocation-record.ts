import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "../host/lifecycle/process-start-identity";

/**
 * Host-owned CLI invocation record. Filename, schema, and parser live here (host cannot import the CLI).
 * Authority is only `<hostHome>/cli-invocation/`; any txn or stale marker bypasses `cli-invocation.json`; never unlink the legacy exact `cli-invocation.txn`.
 */

export const CLI_INVOCATION_RECORD_SCHEMA_VERSION = 1;

/** Private child of the host runtime home that holds every authority file. */
export const CLI_INVOCATION_STATE_DIRNAME = "cli-invocation";

/**
 * Identity of the state directory from one `fstat` / `lstat`. Used to detect a
 * post-gate swap of the `cli-invocation` entry under a writable parent.
 */
export interface CliInvocationStateDirIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * `null` when the stats carry no usable identity.
 * Treating that as evidence that the directory is unchanged would let a replacement through the exact check that exists to catch one, so both sides refuse to hold authority behind an identity they cannot verify.
 */
export function cliInvocationStateDirIdentityFromStats(stats: {
  readonly dev: number;
  readonly ino: number;
}): CliInvocationStateDirIdentity | null {
  if (
    !Number.isInteger(stats.dev) ||
    !Number.isInteger(stats.ino) ||
    stats.dev === 0 ||
    stats.ino === 0
  ) {
    return null;
  }
  return { dev: stats.dev, ino: stats.ino };
}

export function cliInvocationStateDirIdentitiesMatch(
  left: CliInvocationStateDirIdentity,
  right: CliInvocationStateDirIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export const CLI_INVOCATION_RECORD_FILENAME = "cli-invocation.json";
/** Legacy unused basename. Current writers never create this file. */
export const CLI_INVOCATION_RECORD_STAGING_FILENAME =
  "cli-invocation.json.staging";
export const CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX =
  "cli-invocation.json.staging.";
/** Legacy exact basename. Current writers never create this file. */
export const CLI_INVOCATION_RECORD_TXN_FILENAME = "cli-invocation.txn";
/** Unique contender prefix: `cli-invocation.txn.<owner-token>`. */
export const CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX = "cli-invocation.txn.";
export const CLI_INVOCATION_RECORD_STALE_FILENAME = "cli-invocation.stale";
export const CLI_INVOCATION_LIFECYCLE_FILENAME = "cli-invocation.lifecycle";

/**
 * Age fallback for unparseable / identity-less transaction markers.
 * A still-alive owner is never abandoned by age.
 */
export const CLI_INVOCATION_TXN_ABANDON_AFTER_MS = 5 * 60_000;

export const CLI_INVOCATION_RECORD_MAX_ARGS = 32;
export const CLI_INVOCATION_RECORD_MAX_ARG_LENGTH = 4096;
export const CLI_INVOCATION_RECORD_MAX_SERIALIZED_BYTES = 65_536;

export type CliInvocationRecordPlatform = "linux" | "macos" | "windows";
export type CliInvocationRecordSourceKind =
  | "legacy-os-service"
  | "service-registration";

export interface CliInvocationRecordSource {
  readonly kind: CliInvocationRecordSourceKind;
  readonly platform: CliInvocationRecordPlatform;
  readonly serviceLabel: string;
}

/**
 * Durable `{ command, args }` the host should spawn, plus the provenance of that vector.
 * `recoveredAt` is the write timestamp for both the host migration writer and the CLI registration writer - the field name is frozen by the schema, not a claim that every write was a recovery.
 */
export interface CliInvocationRecord {
  readonly schemaVersion: typeof CLI_INVOCATION_RECORD_SCHEMA_VERSION;
  readonly command: string;
  readonly args: readonly string[];
  readonly source: CliInvocationRecordSource;
  readonly recoveredAt: string;
}

/** Private authority directory under the given host runtime home. */
export function cliInvocationStateDir(hostHomeDir: string): string {
  return nodePath.join(hostHomeDir, CLI_INVOCATION_STATE_DIRNAME);
}

function cliInvocationStateFile(hostHomeDir: string, filename: string): string {
  return nodePath.join(cliInvocationStateDir(hostHomeDir), filename);
}

/** Live record, given the host runtime home that contains it. */
export function cliInvocationRecordPath(hostHomeDir: string): string {
  return cliInvocationStateFile(hostHomeDir, CLI_INVOCATION_RECORD_FILENAME);
}

/** Legacy unused path. Current writers never create this file. */
export function cliInvocationRecordStagingPath(hostHomeDir: string): string {
  return cliInvocationStateFile(
    hostHomeDir,
    CLI_INVOCATION_RECORD_STAGING_FILENAME,
  );
}

const OWNER_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCliInvocationOwnerToken(value: unknown): value is string {
  return typeof value === "string" && OWNER_TOKEN_PATTERN.test(value);
}

/** Basename of the owner-unique staging file. */
export function cliInvocationRecordOwnedStagingBasename(token: string): string {
  return `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}${token}`;
}

/** Owner-unique staging path. Never a cache. */
export function cliInvocationRecordOwnedStagingPath(
  hostHomeDir: string,
  token: string,
): string {
  return cliInvocationStateFile(
    hostHomeDir,
    cliInvocationRecordOwnedStagingBasename(token),
  );
}

/**
 * Legacy exact transaction path.
 * Current writers never create, unlink, or rename onto this file.
 */
export function cliInvocationRecordTransactionMarkerPath(
  hostHomeDir: string,
): string {
  return cliInvocationStateFile(
    hostHomeDir,
    CLI_INVOCATION_RECORD_TXN_FILENAME,
  );
}

/** Basename of the owner-unique transaction contender. */
export function cliInvocationRecordOwnedTransactionBasename(
  token: string,
): string {
  return `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${token}`;
}

/** Owner-unique transaction contender path. */
export function cliInvocationRecordOwnedTransactionPath(
  hostHomeDir: string,
  token: string,
): string {
  return cliInvocationStateFile(
    hostHomeDir,
    cliInvocationRecordOwnedTransactionBasename(token),
  );
}

/**
 * Directory-entry predicate for transaction markers: the legacy exact `cli-invocation.txn`, or `cli-invocation.txn.<uuid>`.
 */
export function isCliInvocationTransactionMarkerBasename(
  name: string,
): boolean {
  if (name === CLI_INVOCATION_RECORD_TXN_FILENAME) return true;
  if (!name.startsWith(CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX)) {
    return false;
  }
  return isCliInvocationOwnerToken(
    name.slice(CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX.length),
  );
}

/** Sorted transaction-marker basenames from one `readdir` result. */
export function cliInvocationTransactionMarkerBasenamesFrom(
  names: readonly string[],
): string[] {
  return names.filter(isCliInvocationTransactionMarkerBasename).sort();
}

export interface CliInvocationTransactionContenderOrder {
  readonly basename: string;
  readonly mtimeMs: number;
}

/** Deterministic order among live contenders: earliest filesystem mtime, then basename. */
export function compareCliInvocationTransactionContenders(
  left: CliInvocationTransactionContenderOrder,
  right: CliInvocationTransactionContenderOrder,
): number {
  if (left.mtimeMs < right.mtimeMs) return -1;
  if (left.mtimeMs > right.mtimeMs) return 1;
  if (left.basename < right.basename) return -1;
  if (left.basename > right.basename) return 1;
  return 0;
}

/** Basename of the elected live owner, or `null` when the set is empty. */
export function electCliInvocationTransactionOwnerBasename(
  live: readonly CliInvocationTransactionContenderOrder[],
): string | null {
  if (live.length === 0) return null;
  const [first, ...rest] = live;
  if (first === undefined) return null;
  let winner = first;
  for (const candidate of rest) {
    if (compareCliInvocationTransactionContenders(candidate, winner) < 0) {
      winner = candidate;
    }
  }
  return winner.basename;
}

/**
 * Written when a live record must not be preferred (commit failed after OS success, or an explicit un-prefer).
 * Presence is cache bypass, same as the transaction marker.
 */
export function cliInvocationRecordStaleMarkerPath(
  hostHomeDir: string,
): string {
  return cliInvocationStateFile(
    hostHomeDir,
    CLI_INVOCATION_RECORD_STALE_FILENAME,
  );
}

/**
 * The stale marker's payload.
 * A remover that first reads the marker and compares this label with its own refuses a foreign marker, which turns that redirection from "the other slot's cache bypass silently disappears" into a no-op.
 */
export interface CliInvocationStaleMarker {
  readonly schemaVersion: typeof CLI_INVOCATION_RECORD_SCHEMA_VERSION;
  readonly kind: "stale";
  readonly serviceLabel: string | null;
}

export function serializeCliInvocationStaleMarker(input: {
  readonly serviceLabel: string;
}): string {
  return `${JSON.stringify({
    schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
    kind: "stale",
    serviceLabel: input.serviceLabel,
  })}\n`;
}

/** `null` for anything that is not a stale marker of this schema version. */
export function parseCliInvocationStaleMarker(
  value: unknown,
): CliInvocationStaleMarker | null {
  if (!isPlainRecord(value)) return null;
  if (value.schemaVersion !== CLI_INVOCATION_RECORD_SCHEMA_VERSION) return null;
  if (value.kind !== "stale") return null;
  // Absent (a marker from a CLI predating the field) and an explicit `null`
  // (that same marker re-serialised through this shape) are one legacy form.
  if (
    !("serviceLabel" in value) ||
    value.serviceLabel === undefined ||
    value.serviceLabel === null
  ) {
    return {
      schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
      kind: "stale",
      serviceLabel: null,
    };
  }
  if (
    typeof value.serviceLabel !== "string" ||
    value.serviceLabel.length === 0 ||
    value.serviceLabel.includes("\0")
  ) {
    return null;
  }
  return {
    schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
    kind: "stale",
    serviceLabel: value.serviceLabel,
  };
}

/**
 * May a remover that acts on behalf of `ownLabel` unlink this marker?
 * Shared so the CLI and the host cannot drift on the rule: a legacy marker without a label is anyone's to remove, a labelled one belongs to its label.
 */
export function cliInvocationStaleMarkerRemovableBy(
  marker: CliInvocationStaleMarker,
  ownLabel: string,
): boolean {
  return marker.serviceLabel === null || marker.serviceLabel === ownLabel;
}

/** Lifecycle generation, given the host runtime home that contains it. */
export function cliInvocationLifecyclePath(hostHomeDir: string): string {
  return cliInvocationStateFile(hostHomeDir, CLI_INVOCATION_LIFECYCLE_FILENAME);
}

export type CliInvocationLifecycleEvent = "registered" | "uninstalled";

export interface CliInvocationLifecycle {
  readonly schemaVersion: typeof CLI_INVOCATION_RECORD_SCHEMA_VERSION;
  readonly kind: "lifecycle";
  readonly generation: string;
  readonly event: CliInvocationLifecycleEvent;
  readonly serviceLabel: string;
  readonly at: string;
  /** Causal evidence for discharging a legacy exact `cli-invocation.txn`. */
  readonly legacyMarkerEvidence: CliInvocationLegacyMarkerEvidence;
}

/**
 * Legacy exact marker as seen at acquire. `none` and `unreadable` never discharge by clock; timestamp fallback is for `unknown` only.
 */
export type CliInvocationLegacyMarkerEvidence =
  | { readonly kind: "digest"; readonly digest: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unknown" };

const LEGACY_MARKER_UNREADABLE_WIRE = "unreadable";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * How many leading bytes of a transaction marker its digest covers.
 * The host's bounded read must cover at least this many bytes; the CLI passes whatever it read and the helper takes the prefix.
 */
export const CLI_INVOCATION_TRANSACTION_MARKER_DIGEST_BYTES = 4096;

/**
 * Identity of a transaction marker's BYTES, shared so the CLI (which writes the digest into a lifecycle) and the host (which computes it from the file it read) cannot disagree on the hashing.
 * Over the RAW bytes as read from the file, never text decoded from them: a corrupt marker may not be valid UTF-8, and a decode-then-re-encode would hash replacement characters the file does not contain.
 */
export function cliInvocationTransactionMarkerDigest(
  bytes: Uint8Array,
): string {
  return createHash("sha256")
    .update(bytes.subarray(0, CLI_INVOCATION_TRANSACTION_MARKER_DIGEST_BYTES))
    .digest("hex");
}

export function serializeCliInvocationLifecycle(
  record: CliInvocationLifecycle,
): string {
  const evidence = record.legacyMarkerEvidence;
  return `${JSON.stringify(
    {
      schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
      kind: "lifecycle",
      generation: record.generation,
      event: record.event,
      serviceLabel: record.serviceLabel,
      at: record.at,
      // `digest`, `none` and `unreadable` are all WRITTEN (a hex string, `null`, the literal `"unreadable"`), so a reader can tell each from "recorded nothing".
      ...(evidence.kind === "unknown"
        ? {}
        : {
            supersededLegacyMarkerDigest: recordedEvidenceWireValue(evidence),
          }),
    },
    null,
    2,
  )}\n`;
}

function recordedEvidenceWireValue(
  evidence: Exclude<CliInvocationLegacyMarkerEvidence, { kind: "unknown" }>,
): string | null {
  switch (evidence.kind) {
    case "digest":
      return evidence.digest;
    case "unreadable":
      return LEGACY_MARKER_UNREADABLE_WIRE;
    case "none":
      return null;
    default: {
      const unhandled: never = evidence;
      return unhandled;
    }
  }
}

export function parseCliInvocationLifecycle(
  value: unknown,
): CliInvocationLifecycle | null {
  if (!isPlainRecord(value)) return null;
  if (value.schemaVersion !== CLI_INVOCATION_RECORD_SCHEMA_VERSION) return null;
  if (value.kind !== "lifecycle") return null;
  if (!isCliInvocationOwnerToken(value.generation)) return null;
  if (value.event !== "registered" && value.event !== "uninstalled") {
    return null;
  }
  if (
    typeof value.serviceLabel !== "string" ||
    value.serviceLabel.length === 0 ||
    value.serviceLabel.includes("\0")
  ) {
    return null;
  }
  if (typeof value.at !== "string") return null;
  if (Number.isNaN(Date.parse(value.at))) return null;
  // Absent and `null` are DIFFERENT answers - see {@link CliInvocationLegacyMarkerEvidence}.
  // Anything else that is not a hex digest is a document this parser cannot vouch for.
  let legacyMarkerEvidence: CliInvocationLegacyMarkerEvidence;
  if (
    !("supersededLegacyMarkerDigest" in value) ||
    value.supersededLegacyMarkerDigest === undefined
  ) {
    legacyMarkerEvidence = { kind: "unknown" };
  } else if (value.supersededLegacyMarkerDigest === null) {
    legacyMarkerEvidence = { kind: "none" };
  } else if (
    value.supersededLegacyMarkerDigest === LEGACY_MARKER_UNREADABLE_WIRE
  ) {
    legacyMarkerEvidence = { kind: "unreadable" };
  } else if (
    typeof value.supersededLegacyMarkerDigest === "string" &&
    SHA256_HEX.test(value.supersededLegacyMarkerDigest)
  ) {
    legacyMarkerEvidence = {
      kind: "digest",
      digest: value.supersededLegacyMarkerDigest,
    };
  } else {
    return null;
  }
  return {
    schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
    kind: "lifecycle",
    generation: value.generation,
    event: value.event,
    serviceLabel: value.serviceLabel,
    at: value.at,
    legacyMarkerEvidence,
  };
}

export type CliInvocationTransactionOperation = "install" | "uninstall";

export interface CliInvocationTransactionOwner {
  readonly pid: number;
  readonly token: string;
  readonly processStartIdentity: ProcessStartIdentity | null;
  readonly startedAtMs: number | null;
}

export interface CliInvocationTransactionMarker {
  readonly schemaVersion: typeof CLI_INVOCATION_RECORD_SCHEMA_VERSION;
  readonly kind: "transaction";
  readonly owner: CliInvocationTransactionOwner;
  readonly stagingFile: string;
  readonly operation: CliInvocationTransactionOperation;
  readonly serviceLabel: string;
  readonly startedAt: string;
}

/**
 * Unique files must carry `owner.token` as their basename suffix. The
 * legacy exact basename may hold any valid token.
 */
export function cliInvocationTransactionMarkerMatchesBasename(
  marker: CliInvocationTransactionMarker,
  basename: string,
): boolean {
  if (basename === CLI_INVOCATION_RECORD_TXN_FILENAME) return true;
  return (
    basename === cliInvocationRecordOwnedTransactionBasename(marker.owner.token)
  );
}

/**
 * Whether a parseable lifecycle generation is demonstrably newer than a parseable legacy exact transaction marker.
 * Fail-closed when neither stamp is a finite number.
 */
export function cliInvocationLifecycleNewerThanLegacyExactMarker(
  marker: CliInvocationTransactionMarker,
  lifecycle: CliInvocationLifecycle,
): boolean {
  const startedAtMs = Date.parse(marker.startedAt);
  const ownerStartedAtMs =
    marker.owner.startedAtMs === null
      ? Number.NEGATIVE_INFINITY
      : marker.owner.startedAtMs;
  const markerStart = Number.isNaN(startedAtMs)
    ? ownerStartedAtMs
    : Math.max(startedAtMs, ownerStartedAtMs);
  const lifecycleAt = Date.parse(lifecycle.at);
  if (!Number.isFinite(markerStart) || Number.isNaN(lifecycleAt)) {
    return false;
  }
  return lifecycleAt > markerStart;
}

/**
 * Whether a lifecycle discharges a legacy exact marker, by CAUSAL evidence first and by timestamp only as the fallback.
 * Falling back to timestamps in either case would let a backward clock step discharge that later transaction and drop its record bypass.
 */
export function cliInvocationLifecycleSupersedesLegacyExactMarker(
  marker: {
    readonly parsed: CliInvocationTransactionMarker | null;
    readonly digest: string;
  },
  lifecycle: CliInvocationLifecycle,
): boolean {
  const evidence = lifecycle.legacyMarkerEvidence;
  // Exhaustive on purpose: the timestamp fallback is the fail-OPEN arm, so a
  // new evidence kind must be placed deliberately rather than inherit it.
  switch (evidence.kind) {
    case "digest":
      return evidence.digest === marker.digest;
    case "none":
    case "unreadable":
      return false;
    case "unknown":
      return marker.parsed === null
        ? false
        : cliInvocationLifecycleNewerThanLegacyExactMarker(
            marker.parsed,
            lifecycle,
          );
    default: {
      const unhandled: never = evidence;
      return unhandled;
    }
  }
}

/**
 * Elapsed-age window for unparseable / identity-less markers.
 * A parsed still-alive owner is never abandoned by this function.
 */
export function cliInvocationTransactionAbandonedByAge(
  startedAtMs: number,
  nowMs: number,
): boolean {
  return nowMs - startedAtMs >= CLI_INVOCATION_TXN_ABANDON_AFTER_MS;
}

export function serializeCliInvocationTransactionMarker(
  marker: CliInvocationTransactionMarker,
): string {
  return `${JSON.stringify(
    {
      schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
      kind: "transaction",
      owner: {
        pid: marker.owner.pid,
        token: marker.owner.token,
        processStartIdentity: marker.owner.processStartIdentity,
        startedAtMs: marker.owner.startedAtMs,
      },
      stagingFile: marker.stagingFile,
      operation: marker.operation,
      serviceLabel: marker.serviceLabel,
      startedAt: marker.startedAt,
    },
    null,
    2,
  )}\n`;
}

export function parseCliInvocationTransactionMarker(
  value: unknown,
): CliInvocationTransactionMarker | null {
  if (!isPlainRecord(value)) return null;
  if (value.schemaVersion !== CLI_INVOCATION_RECORD_SCHEMA_VERSION) return null;
  if (value.kind !== "transaction") return null;
  if (!isPlainRecord(value.owner)) return null;
  if (
    typeof value.owner.pid !== "number" ||
    !Number.isInteger(value.owner.pid) ||
    value.owner.pid <= 0
  ) {
    return null;
  }
  if (!isCliInvocationOwnerToken(value.owner.token)) return null;
  let processStartIdentity: ProcessStartIdentity | null = null;
  if (
    value.owner.processStartIdentity !== null &&
    value.owner.processStartIdentity !== undefined
  ) {
    if (!isProcessStartIdentity(value.owner.processStartIdentity)) return null;
    processStartIdentity = value.owner.processStartIdentity;
  }
  let startedAtMs: number | null = null;
  if (
    value.owner.startedAtMs !== null &&
    value.owner.startedAtMs !== undefined
  ) {
    if (
      typeof value.owner.startedAtMs !== "number" ||
      !Number.isFinite(value.owner.startedAtMs)
    ) {
      return null;
    }
    startedAtMs = value.owner.startedAtMs;
  }
  if (typeof value.stagingFile !== "string") return null;
  if (
    value.stagingFile !==
    cliInvocationRecordOwnedStagingBasename(value.owner.token)
  ) {
    return null;
  }
  if (value.operation !== "install" && value.operation !== "uninstall") {
    return null;
  }
  if (
    typeof value.serviceLabel !== "string" ||
    value.serviceLabel.length === 0 ||
    value.serviceLabel.includes("\0")
  ) {
    return null;
  }
  if (typeof value.startedAt !== "string") return null;
  if (Number.isNaN(Date.parse(value.startedAt))) return null;
  return {
    schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
    kind: "transaction",
    owner: {
      pid: value.owner.pid,
      token: value.owner.token,
      processStartIdentity,
      startedAtMs,
    },
    stagingFile: value.stagingFile,
    operation: value.operation,
    serviceLabel: value.serviceLabel,
    startedAt: value.startedAt,
  };
}

function parseRecordPlatform(
  value: unknown,
): CliInvocationRecordPlatform | null {
  if (value === "linux" || value === "macos" || value === "windows") {
    return value;
  }
  return null;
}

function parseRecordSourceKind(
  value: unknown,
): CliInvocationRecordSourceKind | null {
  if (value === "legacy-os-service" || value === "service-registration") {
    return value;
  }
  return null;
}

/**
 * Map Node's `process.platform` onto the frozen record enum. `null` for
 * anything the CLI/host service layer does not register.
 */
export function cliInvocationRecordPlatformFor(
  nodePlatform: string,
): CliInvocationRecordPlatform | null {
  if (nodePlatform === "linux") return "linux";
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  return null;
}

export function serializeCliInvocationRecord(
  record: CliInvocationRecord,
): string {
  return `${JSON.stringify(
    {
      schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
      command: record.command,
      args: [...record.args],
      source: {
        kind: record.source.kind,
        platform: record.source.platform,
        serviceLabel: record.source.serviceLabel,
      },
      recoveredAt: record.recoveredAt,
    },
    null,
    2,
  )}\n`;
}

/**
 * `null` for anything that is not a well-formed schemaVersion 1 record.
 * A future additive field must not make an otherwise valid schemaVersion 1 record unreadable; required fields and enums stay fail-closed.
 */
export function parseCliInvocationRecord(
  value: unknown,
): CliInvocationRecord | null {
  if (!isPlainRecord(value)) return null;
  if (value.schemaVersion !== CLI_INVOCATION_RECORD_SCHEMA_VERSION) return null;
  if (!isBoundedAbsolutePath(value.command)) return null;
  if (!Array.isArray(value.args)) return null;
  if (value.args.length > CLI_INVOCATION_RECORD_MAX_ARGS) return null;
  const args: string[] = [];
  for (const entry of value.args) {
    if (typeof entry !== "string") return null;
    if (!isBoundedArg(entry)) return null;
    args.push(entry);
  }
  if (!isPlainRecord(value.source)) return null;
  const kind = parseRecordSourceKind(value.source.kind);
  const platform = parseRecordPlatform(value.source.platform);
  if (kind === null || platform === null) return null;
  if (
    typeof value.source.serviceLabel !== "string" ||
    value.source.serviceLabel.length === 0 ||
    value.source.serviceLabel.includes("\0")
  ) {
    return null;
  }
  if (typeof value.recoveredAt !== "string") return null;
  if (Number.isNaN(Date.parse(value.recoveredAt))) return null;
  const record: CliInvocationRecord = {
    schemaVersion: CLI_INVOCATION_RECORD_SCHEMA_VERSION,
    command: value.command,
    args,
    source: {
      kind,
      platform,
      serviceLabel: value.source.serviceLabel,
    },
    recoveredAt: value.recoveredAt,
  };
  if (
    new TextEncoder().encode(serializeCliInvocationRecord(record)).length >
    CLI_INVOCATION_RECORD_MAX_SERIALIZED_BYTES
  ) {
    return null;
  }
  return record;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedArg(value: string): boolean {
  return (
    value.length <= CLI_INVOCATION_RECORD_MAX_ARG_LENGTH &&
    !value.includes("\0")
  );
}

function isBoundedAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (!isBoundedArg(value)) return false;
  return nodePath.posix.isAbsolute(value) || nodePath.win32.isAbsolute(value);
}
