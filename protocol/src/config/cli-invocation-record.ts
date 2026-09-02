import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "../host/lifecycle/process-start-identity";

/**
 * The host-owned, environment-scoped CLI invocation record.
 *
 * Written by the OSS CLI after a confirmed service registration (and removed
 * only after a confirmed matching uninstall). Also written by the host on the
 * first successful legacy-OS recovery. Both processes live in different
 * packages, and the host cannot import the CLI, so the filename, schema, and
 * parser live HERE — the same reason `./host-stop-intent` and
 * `./host-update-attempt-paths` do.
 *
 * ### Why these take a directory instead of an `Environment`
 *
 * The CLI resolves the host runtime home through `hostHomeDir(environment)`
 * (dev-run slot nesting included). The host resolves its OWN home through the
 * path-only `--host-data-dir` override the supervisor spawned it with. Those
 * two always name the same directory for the same host, so taking the
 * directory as input makes the agreement structural instead of a slot rule
 * duplicated in a third place that can drift.
 *
 * Authority files live in a private child {@link cliInvocationStateDir}
 * (`<hostHome>/cli-invocation/`), not in the host-home root. Helpers still
 * take the host home and join through that child. Root-level
 * `cli-invocation.*` names are never authority. The child entry is gated
 * with a no-follow directory open (a symlink is rejected). Writers
 * re-check {@link CliInvocationStateDirIdentity} before each write
 * group. Residual, stated exactly because Node has no `openat` family and
 * every operation below the gate is therefore by pathname: a post-gate
 * swap of the child under a group-writable parent can redirect a CREATE
 * (a new fixed-basename 0600 file appears in the directory the attacker
 * chose), a RENAME (a record or lifecycle lands there; the record names a
 * `serviceLabel` the redirected directory's reader rejects as foreign,
 * the lifecycle only re-keys that reader's cache), and an UNLINK. Unlinks
 * are compare-then-remove: the live record is removed only after its
 * label matched, the stale marker only after
 * {@link cliInvocationStaleMarkerRemovableBy} agreed, and every other
 * name carries a per-transaction token no other directory can hold. No
 * existing file is truncated, written through, or chmod'd via a pathname
 * (`fchmod` on the exclusive-open inode; replace only by `rename` of that
 * inode). The precondition - another account with write access to this
 * account's host home - already exposes the host install tree and the
 * credentials beside it, so nothing here widens that boundary.
 *
 * ### Cache bypass
 *
 * Presence of **any** discovered transaction marker OR the stale marker
 * forces the host to ignore `cli-invocation.json`. Staging files are
 * never a cache.
 *
 * Transaction markers are unique contenders, not a reused pathname:
 * `cli-invocation.txn.<owner-token>`, created with `O_EXCL`/`wx` at that
 * exact unique path (no `.tmp` under this stem). Identity still lives
 * inside the file (owner pid + processStartIdentity + token), and
 * `owner.token` must equal the basename suffix. The legacy exact name
 * `cli-invocation.txn` is residue from older writers. Current writers
 * never create it, never unlink it, and never rename onto it. A
 * **positively live** exact marker blocks election. An abandoned or
 * unparseable-old-enough exact marker is nonblocking residue and stays
 * on disk; unique contenders may still elect. The host may **ignore**
 * (never unlink) a parseable abandoned exact marker for cache bypass
 * and publication when {@link cliInvocationLifecycleNewerThanLegacyExactMarker}
 * holds. Unique contenders are never discharged that way. Discover
 * names with {@link isCliInvocationTransactionMarkerBasename}.
 *
 * Staging is unique per owner: `cli-invocation.json.staging.<token>`.
 * Only that owner may commit or unlink its staging file. The host never
 * creates or removes any transaction marker (legacy or unique).
 *
 * A **live** contender (processStartIdentity still the same process)
 * means a CLI mutation or election is in flight: the host must not
 * memoize or execute an OS recovery obtained in that window. **Any**
 * live contender makes the whole marker state live — the host does not
 * elect an owner. An **abandoned** owner (pid positively dead or
 * identity recycled) means that contender crashed: the host may recover
 * from the OS and persist if no live contender remains, and still must
 * not unlink txn files. Unparseable markers fall back to
 * {@link CLI_INVOCATION_TXN_ABANDON_AFTER_MS} measured as ELAPSED age
 * only; a marker stamped in the future stays live
 * ({@link cliInvocationTransactionAbandonedByAge}).
 *
 * CLI election (host does not implement this): observe existing
 * markers and elect AROUND dead **unique** files - they are not
 * unlinked during the election, because each may belong to an owner
 * that mutated the OS before it could commit, and its marker is what
 * keeps a host off the pre-mutation record until a fresh lifecycle
 * generation exists. Create a unique contender only when no other
 * live marker remains. Become owner only as the sole remaining live
 * marker after a confirm re-list. If two processes create in the
 * same empty window, the winner is earliest filesystem `mtimeMs`,
 * then basename; losers unlink **only their own** unique file. A
 * later arrival that sees a live owner — including a live legacy
 * exact marker — does not create a file and cannot unlink that
 * owner's path. The winner sweeps the dead unique files it elected
 * around only AFTER its lifecycle write succeeds, and confirms each
 * removal; a file that survives is reported, never silently left as
 * a bypass beside a record the command called clean. The exact
 * legacy path is never unlinked by anyone.
 *
 * After a successful host migration write of the live record, the host may
 * unlink `cli-invocation.stale`. The host's own live-record commit uses a
 * pid-scoped temp name, never a CLI staging filename.
 *
 * ### Lifecycle generation
 *
 * `cli-invocation.lifecycle` is rewritten with a fresh UUID on every
 * confirmed registration and confirmed matching uninstall, **before** the
 * transaction marker is released. The host folds `generation` into its
 * migration-cache key so a confirmed uninstall cannot resurrect a
 * no-marker in-memory recovery. An absent file is generation `""` (old
 * CLI). A foreign-label uninstall does not rewrite it.
 *
 * ### Remaining check/use race
 *
 * Path-based validation cannot eliminate replacement between `stat` and
 * `spawn`. Schema version 1 does not store `dev`/`ino` (or a Windows file
 * id). A process that can replace the registered CLI already controls that
 * account's service execution; this record is same-account compatibility
 * state, not cryptographic provenance.
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
 *
 * A zero `dev` or `ino` is not an identity, it is the platform saying it has
 * none: Windows reports `ino === 0` on a volume without file indexes, and two
 * different directories there would compare equal. Treating that as evidence
 * that the directory is unchanged would let a replacement through the exact
 * check that exists to catch one, so both sides refuse to hold authority
 * behind an identity they cannot verify.
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
 * Durable `{ command, args }` the host should spawn, plus the provenance of
 * that vector. `recoveredAt` is the write timestamp for both the host
 * migration writer and the CLI registration writer — the field name is
 * frozen by the schema, not a claim that every write was a recovery.
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
 * Legacy exact transaction path. Current writers never create, unlink,
 * or rename onto this file. It remains a discovered name so an older
 * CLI's in-flight marker is still a cache bypass, and an abandoned
 * exact file is left as residue.
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
 * Directory-entry predicate for transaction markers: the legacy exact
 * `cli-invocation.txn`, or `cli-invocation.txn.<uuid>`. Rejects temps and
 * other suffixes so a `cli-invocation.txn*.tmp` is not a marker.
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

/**
 * Deterministic order among live contenders: earliest filesystem mtime,
 * then basename. Not owner-supplied `startedAtMs` — a late writer could
 * forge an earlier stamp and preempt.
 */
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
 * Written when a live record must not be preferred (commit failed after OS
 * success, or an explicit un-prefer). Presence is cache bypass, same as the
 * transaction marker.
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
 *
 * `serviceLabel` is what makes removing the marker safe against a swapped
 * state directory. Every removal of `cli-invocation.stale` is by pathname -
 * Node has no `unlinkat` - so under a group-writable host home the entry
 * named `cli-invocation` can be re-pointed at another environment's state
 * directory between the identity check and the unlink. A remover that first
 * reads the marker and compares this label with its own refuses a foreign
 * marker, which turns that redirection from "the other slot's cache bypass
 * silently disappears" into a no-op. A marker written by a CLI too old to
 * carry the label parses with `serviceLabel: null` and is removable by anyone,
 * exactly as it was before the field existed.
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
 *
 * Shared so the CLI and the host cannot drift on the rule: a legacy marker
 * without a label is anyone's to remove, a labelled one belongs to its label.
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
  /**
   * Causal evidence for discharging a legacy exact `cli-invocation.txn`.
   * See {@link CliInvocationLegacyMarkerEvidence} for the four states and
   * {@link cliInvocationLifecycleSupersedesLegacyExactMarker} for how each
   * one decides.
   */
  readonly legacyMarkerEvidence: CliInvocationLegacyMarkerEvidence;
}

/**
 * What the confirming transaction saw of the legacy exact marker when it
 * acquired, as written into the lifecycle it committed.
 *
 * Four states, because "no digest" means three different things:
 *
 *   - `digest`: the {@link cliInvocationTransactionMarkerDigest} of the
 *     abandoned legacy marker that was present. A host matching it against
 *     the marker it is looking at knows the marker predates the lifecycle
 *     without consulting any clock.
 *   - `none`: a current CLI acquired and saw NO legacy marker. Any legacy
 *     marker present afterwards was therefore created after this lifecycle's
 *     transaction acquired - by an older CLI - and must never be discharged
 *     by it, whatever the clocks say. On the wire this is the field written
 *     as `null`.
 *   - `unreadable`: a legacy marker was present and abandoned by age, but its
 *     bytes could not be read, so there is no digest to name. Hashing the
 *     empty read would have manufactured evidence that can never match the
 *     real bytes. This state NEVER discharges either: it proves a marker
 *     existed but carries no identity for it, so once the path is readable
 *     the host cannot tell "that same marker" from "a later incarnation an
 *     older CLI wrote at the same path", and a timestamp comparison under a
 *     backward clock step would discharge the later one - the exact hazard
 *     `none` closes. The transaction that observed it reports the surviving
 *     bypass on completion instead. On the wire this is the literal string
 *     `"unreadable"`, which no hex digest can collide with.
 *   - `unknown`: a lifecycle written by a CLI predating the field, which
 *     recorded nothing. On the wire this is the field being absent.
 *
 * The timestamp comparison applies to `unknown` only: a pre-field CLI could
 * not record what it saw, and ordering the two CLI-authored stamps is the
 * best that remains for lifecycles it wrote.
 */
export type CliInvocationLegacyMarkerEvidence =
  | { readonly kind: "digest"; readonly digest: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unknown" };

const LEGACY_MARKER_UNREADABLE_WIRE = "unreadable";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Identity of a transaction marker's BYTES, shared so the CLI (which writes
 * the digest into a lifecycle) and the host (which computes it from the file
 * it read) cannot disagree on the hashing.
 */
export function cliInvocationTransactionMarkerDigest(
  bytes: Uint8Array,
): string {
  return createHash("sha256").update(bytes).digest("hex");
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
      // `digest`, `none` and `unreadable` are all WRITTEN (a hex string,
      // `null`, the literal `"unreadable"`), so a reader can tell each from
      // "recorded nothing". `unknown` is only ever re-serialised from a
      // parsed pre-field lifecycle and keeps the field absent, exactly as
      // that CLI wrote it.
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

/**
 * The wire value of a RECORDED evidence state. Exhaustive by construction: a
 * new evidence kind fails to compile here rather than falling through to the
 * `null` that means "saw no marker", which is the one value that would let a
 * later host discharge on a claim nobody made.
 */
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
  // Absent and `null` are DIFFERENT answers - see
  // {@link CliInvocationLegacyMarkerEvidence}. Absent is a CLI that recorded
  // nothing; `null` is a CLI that looked and saw nothing. Anything else that
  // is not a hex digest is a document this parser cannot vouch for.
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
 * Whether a parseable lifecycle generation is demonstrably newer than a
 * parseable legacy exact transaction marker.
 *
 * The host uses this only to *ignore* an abandoned exact
 * `cli-invocation.txn` for cache bypass and publication. It never
 * unlinks the file. Unique contenders are not discharged by this
 * helper — callers must still require the exact basename, a parseable
 * payload, and a positively abandoned owner.
 *
 * Marker start is `max(Date.parse(startedAt), owner.startedAtMs)`:
 * CLI-authored evidence only, not filesystem mtime. Fail-closed when
 * neither stamp is a finite number.
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
 * Whether a lifecycle discharges a legacy exact marker, by CAUSAL evidence
 * first and by timestamp only as the fallback.
 *
 * The digest match is what makes the rule clock-independent: the CLI writes
 * the digest of the abandoned legacy marker it observed at acquire time into
 * the lifecycle it commits, so a lifecycle naming this marker's bytes was
 * written by a transaction that completed after the marker existed - true
 * regardless of what the wall clock did in between. The timestamp comparison
 * remains only for a lifecycle written by a CLI predating the field
 * (`unknown`).
 *
 * Recorded evidence is decisive in every other case, and each of the other
 * states refuses when it cannot match - `unreadable` always, since it names
 * no bytes to match and a later incarnation at the same path would be
 * indistinguishable from the one it saw:
 *
 *   - a digest naming a DIFFERENT marker is evidence against, not absence of
 *     evidence: the confirming transaction saw another incarnation of this
 *     file, so the marker read now was written after it acquired - by an
 *     older CLI rewriting the exact path - and a lifecycle cannot discharge a
 *     transaction that started after it;
 *   - `none` is the same argument with nothing seen: the transaction acquired
 *     with no legacy marker present (a LIVE one would have blocked its
 *     election), so any legacy marker present now postdates it.
 *
 * Falling back to timestamps in either case would let a backward clock step
 * discharge that later transaction and drop its record bypass.
 *
 * `digest` is the {@link cliInvocationTransactionMarkerDigest} of the marker
 * file's bytes as the caller read them.
 */
export function cliInvocationLifecycleSupersedesLegacyExactMarker(
  marker: {
    readonly parsed: CliInvocationTransactionMarker;
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
      return cliInvocationLifecycleNewerThanLegacyExactMarker(
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
 *
 * ONE-SIDED on purpose. A marker stamped in the future - the wall clock was
 * stepped back after it was written - is not old, it is unreadable in time,
 * and the callers that reach this function are exactly the ones that could
 * not verify the owner's liveness any other way (an unreadable file, an
 * unparseable payload, an identity-less owner). Ageing such a marker out on
 * the absolute distance from `now` would let a second CLI elect around an
 * owner that is still running and mutate the OS registration beside it,
 * which is the one thing the transaction exists to prevent. A future stamp
 * therefore stays LIVE until the clock catches up with it plus the window;
 * the cost is a wait that reports the marker by path, the alternative is two
 * writers.
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
 * Hand-rolled rather than zod: a torn or hostile file must read as absent
 * so the host fails closed to OS recovery / `cli-unavailable`, not as a
 * thrown parse that could take down a maintenance path.
 *
 * Unknown keys are ignored on purpose. A future additive field must not
 * make an otherwise valid schemaVersion 1 record unreadable; required
 * fields and enums stay fail-closed.
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
