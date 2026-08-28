import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renameWithWindowsRetry } from "@traycer/protocol/config/credentials-fs";
// The READ side of this record moved to `@traycer/protocol/config`, so
// `traycer-host` can project it into `host.status` without importing this
// package (see `./record` for the full reasoning). What stayed here is
// everything that WRITES - which is also what makes the host structurally
// incapable of writing: it imports a module with no writer in it.
//
// `classifyPath` and `errorCode` come back across that boundary because the
// write paths below use them too, and a symlink classifier duplicated between
// the reader and the writer of one file is how the two stop agreeing about
// what a symlink at the record path means.
import {
  classifyPath,
  errorCode,
  readUpdateAttemptRecordAtPath as readRecordAtPath,
} from "@traycer/protocol/config/host-update-attempt-fs";
// The writer's exact-byte round-trip runs its own output back through the
// canonical decoder before the bytes are allowed anywhere near disk, so it
// still needs the decoder itself - through `./decode`, which re-exports it.
import { decodeHostUpdateAttempt, type HostUpdateAttemptRead } from "./decode";
import {
  acquireAttemptMutationLease,
  verifyAttemptLockOwnership,
  type UpdateAttemptLockHandle,
} from "./lock";
import {
  HOST_UPDATE_ATTEMPT_PHASES,
  HOST_UPDATE_TRIGGERS,
  attemptIdentityOf,
  isActivePhase,
  isTerminalRetentionExpired,
  sameAttemptIdentity,
  type HostUpdateAttemptContinuation,
  type HostUpdateAttemptError,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptPhase,
  type HostUpdateAttemptProgress,
  type HostUpdateAttemptRecovery,
  type HostUpdateAttemptRecord,
  type HostUpdateTrigger,
} from "./record";
import { updateAttemptRecordPath } from "./paths";
import {
  advanceAttempt,
  decideAttemptClaim,
  decideAttemptRecovery,
  type AttemptAdvance,
  type AttemptClaimRequest,
  type AttemptRecoveryArtifactEvidence,
  type AttemptRecoveryEvidence,
  type AttemptRecoveryRequest,
  type AttemptRecoveryRunningEvidence,
} from "./transition";

// Filesystem side of `update-attempt.json` (§1.4).
//
// ============================================================================
// THERE IS NO RAW WRITE OR DELETE IN THIS MODULE'S PUBLIC SURFACE.
// ============================================================================
//
// `writeRecordAtomic` and `removeRecordFile` below are module-private and
// stay that way. The only public ways to change the canonical record are
// `commitAttemptMutation` / `pruneTerminalAttemptRecord`; the direct-module
// executor-only channel is separately restricted by the architecture gate.
// Every path takes a lock handle this module's sibling issued and, before
// touching anything:
//
//   1. verify the handle is genuine, unreleased, and STILL owns the lock
//      token on disk;
//   2. re-read canonical state from disk - never trusting the caller's copy;
//   3. check the caller's expected attempt/generation/sequence against what
//      was just read;
//   4. require the new record to be strictly ordered after it.
//
// An exported raw write is not a smaller version of this - it is the whole
// defect. A callback that closes over a record and runs after its segment
// released the lock will happily overwrite generation N+1 with its cached
// generation N, or delete a live attempt outright, and the identity checks in
// `advanceAttempt` cannot see it because they only compare two objects the
// caller supplied. The check has to happen at the point of the write, against
// disk, under a proven-live claim.
//
// Reads stay total and lock-free: a status projection must be able to read
// without contending, and must never be able to write.

/** 0600. The record names an in-flight update; no other local account reads it. */
const RECORD_MODE = 0o600;
/** 0700 on creation only - `mkdir` mode never touches an existing directory. */
const HOME_MODE = 0o700;

// ---- The read side, re-exported ---------------------------------------------
//
// These are the SAME function objects the protocol module defines, not
// wrappers around them. That matters for the three test seams: they toggle
// module-private state (the Windows missing-flag override, the swap-at-open
// hook), so a wrapper would give this package a second copy of that state and
// a test setting it here would leave the real reader untouched - passing while
// proving nothing.
export {
  __sameRecordFileIdentityForTest,
  __setBeforeRecordOpenHookForTest,
  __setRecordOpenPlatformForTest,
  readRegularFileNoFollow,
  readUpdateAttemptRecord,
} from "@traycer/protocol/config/host-update-attempt-fs";
export type { RegularFileNoFollowRead } from "@traycer/protocol/config/host-update-attempt-fs";

/**
 * Raised only after a successful `rename`, when the parent-directory sync
 * that would make that rename survive a crash could not be completed for a
 * reason this platform does not positively classify as "unsupported".
 *
 * The bytes are very likely in place. What is missing is the guarantee, so
 * the caller must not begin a side effect on the strength of them.
 */
export class AttemptRecordDurabilityError extends Error {
  readonly path: string;
  readonly cause: string;

  constructor(path: string, cause: string) {
    super(
      `Host update attempt record at ${path} is not durably placed: ${cause}`,
    );
    this.name = "AttemptRecordDurabilityError";
    this.path = path;
    this.cause = cause;
  }
}

// Mutation barriers are test-only scheduling seams. They are deliberately
// immediately adjacent to the irreversible rename/unlink operations so the
// release-overlap regression proves the capability lease, not merely a
// preflight check.
let beforeRecordRenameHook: (() => Promise<void>) | null = null;
let beforeRecordRemoveHook: (() => Promise<void>) | null = null;

export function __setBeforeRecordRenameHookForTest(
  hook: (() => Promise<void>) | null,
): void {
  beforeRecordRenameHook = hook;
}

export function __setBeforeRecordRemoveHookForTest(
  hook: (() => Promise<void>) | null,
): void {
  beforeRecordRemoveHook = hook;
}

// ---- Private mutation primitives -------------------------------------------

type RawWriteOutcome =
  | { readonly kind: "written" }
  | {
      readonly kind: "refused";
      readonly reason: "symlink" | "not-a-regular-file";
    };

async function writeRecordAtomic(
  recordPath: string,
  bytes: string,
): Promise<RawWriteOutcome> {
  const dir = dirname(recordPath);
  await mkdir(dir, { recursive: true, mode: HOME_MODE });

  // `rename` does not follow a destination symlink, so the write itself is
  // safe either way. Refusing is still right: a link at this path is an
  // anomaly worth surfacing, not something to silently overwrite.
  const existing = await classifyPath(recordPath);
  if (existing.kind === "symlink")
    return { kind: "refused", reason: "symlink" };
  if (existing.kind === "other") {
    return { kind: "refused", reason: "not-a-regular-file" };
  }

  // Same-directory unique temp created with `wx` (so a pre-planted temp path
  // can never be followed or clobbered) at 0600 -> write -> fsync the file ->
  // rename. The file sync is what makes the rename meaningful: without it the
  // rename can be durable while the bytes it points at are not, which is
  // precisely the torn record §1.4 requires to fail closed.
  const tmp = `${recordPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", RECORD_MODE);
    try {
      await handle.writeFile(bytes, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeRecordRenameHook !== null) await beforeRecordRenameHook();
    await renameWithWindowsRetry(tmp, recordPath, 0);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await syncDirectory(dir, recordPath);
  return { kind: "written" };
}

// Directory-sync error codes that positively mean "this platform or
// filesystem does not support fsync on a directory" - the only cases it is
// honest to ignore.
//
// Everything else - EIO above all - is a REAL durability failure and is
// propagated. Swallowing it reported a durable claim on a rename whose
// directory entry a crash can still lose, resurrecting the previous attempt
// underneath a caller that has already started downloading.
const UNSUPPORTED_DIR_FSYNC_CODES: ReadonlySet<string> = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

// Test seam: replaces the real directory open+fsync. A genuine EIO on a
// directory cannot be provoked from a test, and the behaviour that matters -
// which failures are ignorable and which must surface as
// `durability-unverified` - is exactly the part worth proving. The hook
// throws an errno-shaped error and the real classification below runs on it
// unchanged. Never set in production.
type DirectorySyncStage = "open" | "sync";

let directorySyncHook:
  | ((dir: string, stage: DirectorySyncStage) => Promise<void>)
  | null = null;

export function __setDirectorySyncHookForTest(
  hook: ((dir: string, stage: DirectorySyncStage) => Promise<void>) | null,
): void {
  directorySyncHook = hook;
}

async function syncDirectory(dir: string, recordPath: string): Promise<void> {
  // Windows cannot open a directory as a file at all, and its rename is
  // already atomic. Known-unsupported, so not a failure.
  if (process.platform === "win32") return;
  if (directorySyncHook !== null) {
    try {
      await directorySyncHook(dir, "open");
    } catch (err) {
      // A directory OPEN failure (including EACCES/EPERM) cannot establish
      // anything about fsync support. The rename has happened but is not
      // durably verified.
      throw new AttemptRecordDurabilityError(
        recordPath,
        errorCode(err) ?? String(err),
      );
    }
    try {
      await directorySyncHook(dir, "sync");
      return;
    } catch (err) {
      const code = errorCode(err);
      if (code !== null && UNSUPPORTED_DIR_FSYNC_CODES.has(code)) return;
      throw new AttemptRecordDurabilityError(recordPath, code ?? String(err));
    }
  }
  let handle: FileHandle;
  try {
    handle = await open(dir, constants.O_RDONLY);
  } catch (err) {
    throw new AttemptRecordDurabilityError(
      recordPath,
      errorCode(err) ?? String(err),
    );
  }
  try {
    await handle.sync();
  } catch (err) {
    const code = errorCode(err);
    if (code !== null && UNSUPPORTED_DIR_FSYNC_CODES.has(code)) return;
    throw new AttemptRecordDurabilityError(recordPath, code ?? String(err));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function removeRecordFile(recordPath: string): Promise<boolean> {
  const kind = await classifyPath(recordPath);
  if (kind.kind === "symlink" || kind.kind === "other") return false;
  try {
    if (beforeRecordRemoveHook !== null) await beforeRecordRemoveHook();
    await rm(recordPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---- Canonical, intent-bound mutation --------------------------------------

/**
 * The only legal mutations of the canonical record. The caller supplies an
 * intent, never a next record: under the handle lease this module re-reads
 * the canonical bytes and asks the pure transition algebra to derive the
 * exact output. That makes an A -> B replacement, a counter jump, and a
 * trigger/target rewrite structurally unrepresentable at the persistence
 * boundary.
 */
export type AttemptMutationIntent =
  | { readonly kind: "create"; readonly request: AttemptClaimRequest }
  | { readonly kind: "resume"; readonly request: AttemptClaimRequest }
  | {
      readonly kind: "supersede";
      readonly request: AttemptClaimRequest;
      /**
       * Present only when recovery decided a target change applies. The
       * resulting terminal write still travels through this one canonical
       * supersede intent and its shared transition primitive.
       */
      readonly recovery?: AttemptRecoveryRequest;
    }
  | {
      readonly kind: "advance";
      readonly held: HostUpdateAttemptIdentity;
      readonly advance: AttemptAdvance;
    }
  | { readonly kind: "recover"; readonly recovery: AttemptRecoveryRequest };

/**
 * Intent surface available to ordinary holders of a public attempt lock.
 * Recovery is deliberately excluded: its evidence is only meaningful after
 * the executor has observed it under its inner CLI lock.
 */
type AdvanceMutationIntent = Extract<
  AttemptMutationIntent,
  { readonly kind: "advance" }
>;
type SupersedeMutationIntent = Extract<
  AttemptMutationIntent,
  { readonly kind: "supersede" }
>;

export type PublicAttemptMutationIntent =
  | Extract<AttemptMutationIntent, { readonly kind: "create" | "resume" }>
  | {
      readonly kind: "supersede";
      readonly request: AttemptClaimRequest;
    }
  | {
      readonly kind: "advance";
      readonly held: HostUpdateAttemptIdentity;
      readonly advance: Omit<AttemptAdvance, "phase"> & {
        readonly phase: Exclude<HostUpdateAttemptPhase, "complete">;
      };
    };

export type ExecutorOnlyAttemptMutationIntent =
  | Extract<AttemptMutationIntent, { readonly kind: "recover" }>
  | (Omit<AdvanceMutationIntent, "advance"> & {
      readonly advance: Omit<AttemptAdvance, "phase"> & {
        readonly phase: "complete";
      };
    })
  | (Omit<SupersedeMutationIntent, "recovery"> & {
      readonly recovery: AttemptRecoveryRequest;
    });

export type AttemptMutationRejection =
  | "handle-not-issued"
  | "handle-released"
  | "lock-lost"
  | "lock-indeterminate"
  | "record-path-refused"
  | "record-fail-closed"
  // The TypeScript surface is not a trust boundary. A JS/plugin caller can
  // still hand us an empty id, an invented action, or an object whose JSON
  // view differs from the values the transition evaluated. Those inputs are
  // refused before they can reach the temp file.
  | "intent-invalid"
  | "intent-not-legal";

export type AttemptCommitOutcome =
  | {
      readonly kind: "committed";
      readonly record: HostUpdateAttemptRecord;
      readonly identity: HostUpdateAttemptIdentity;
    }
  | {
      readonly kind: "rejected";
      readonly reason: AttemptMutationRejection;
      readonly canonical: HostUpdateAttemptRead;
    }
  | {
      readonly kind: "durability-unverified";
      readonly cause: string;
      readonly canonical: HostUpdateAttemptRead;
    };

export interface CommitAttemptMutationOptions {
  readonly handle: UpdateAttemptLockHandle;
  readonly intent: PublicAttemptMutationIntent;
}

/**
 * Direct-module-only recovery channel. It is intentionally absent from the
 * host-update barrel; the contender boundary admits only the executor-owned
 * CLI recovery bridge to this operation.
 */
export interface CommitExecutorOnlyAttemptMutationOptions {
  readonly handle: UpdateAttemptLockHandle;
  readonly intent: ExecutorOnlyAttemptMutationIntent;
}

const CLAIM_ACTIONS: ReadonlySet<string> = new Set([
  "start",
  "resume-apply",
  "activate",
  "force",
  "defer",
]);
const TRIGGERS: ReadonlySet<string> = new Set(HOST_UPDATE_TRIGGERS);
const PHASES: ReadonlySet<string> = new Set(HOST_UPDATE_ATTEMPT_PHASES);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExecutorOnlyMutationIntent(
  intent: AttemptMutationIntent,
): intent is ExecutorOnlyAttemptMutationIntent {
  return (
    intent.kind === "recover" ||
    (intent.kind === "advance" && intent.advance.phase === "complete") ||
    (intent.kind === "supersede" && intent.recovery !== undefined)
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nullableFiniteNumber(value: unknown): number | null | "invalid" {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : "invalid";
}

// Caller objects are not written directly. Apart from avoiding a caller's
// `toJSON`, this gives the transition a one-time primitive snapshot: a Proxy
// that changes its shape during serialization cannot make the committed
// bytes differ from the decision that authorized them.
function isSerializableInputObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isObjectRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    !("toJSON" in value)
  );
}

// Read a descriptor, not `source[key]`: accessors are executable caller
// code and a Proxy can return a different value on its later serialization
// access. A descriptor snapshot gives the writer an owned primitive value or
// rejects the input before any disk mutation.
function dataProperty(
  source: Record<string, unknown>,
  key: string,
): unknown | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function normalizeIdentity(value: unknown): HostUpdateAttemptIdentity | null {
  if (!isSerializableInputObject(value)) return null;
  const attemptId = nonEmptyString(dataProperty(value, "attemptId"));
  const generation = positiveSafeInteger(dataProperty(value, "generation"));
  const sequence = positiveSafeInteger(dataProperty(value, "sequence"));
  if (attemptId === null || generation === null || sequence === null)
    return null;
  return { attemptId, generation, sequence };
}

function normalizeProgress(
  value: unknown,
): HostUpdateAttemptProgress | "invalid" {
  if (value === null) return null;
  if (!isSerializableInputObject(value)) return "invalid";
  const percent = nullableFiniteNumber(dataProperty(value, "percent"));
  const bytes = nullableFiniteNumber(dataProperty(value, "bytes"));
  const totalBytes = nullableFiniteNumber(dataProperty(value, "totalBytes"));
  if (
    percent === "invalid" ||
    bytes === "invalid" ||
    totalBytes === "invalid"
  ) {
    return "invalid";
  }
  return { percent, bytes, totalBytes };
}

function normalizeError(value: unknown): HostUpdateAttemptError | "invalid" {
  if (value === null) return null;
  if (!isSerializableInputObject(value)) return "invalid";
  const code = dataProperty(value, "code");
  const message = dataProperty(value, "message");
  const phase = dataProperty(value, "phase");
  if (
    typeof code !== "string" ||
    typeof message !== "string" ||
    typeof phase !== "string"
  ) {
    return "invalid";
  }
  return { code, message, phase };
}

function normalizeClaimRequest(value: unknown): AttemptClaimRequest | null {
  if (!isSerializableInputObject(value)) return null;
  const targetVersion = nonEmptyString(dataProperty(value, "targetVersion"));
  const trigger = dataProperty(value, "trigger");
  const action = dataProperty(value, "action");
  const newAttemptId = nonEmptyString(dataProperty(value, "newAttemptId"));
  const initialPhase = dataProperty(value, "initialPhase");
  const nowIso = nonEmptyString(dataProperty(value, "nowIso"));
  const expected = dataProperty(value, "expected");
  if (
    targetVersion === null ||
    newAttemptId === null ||
    nowIso === null ||
    typeof trigger !== "string" ||
    !TRIGGERS.has(trigger) ||
    typeof action !== "string" ||
    !CLAIM_ACTIONS.has(action) ||
    typeof initialPhase !== "string" ||
    !PHASES.has(initialPhase) ||
    !isActivePhase(initialPhase as HostUpdateAttemptPhase)
  ) {
    return null;
  }
  const normalizedExpected =
    expected === null ? null : normalizeIdentity(expected);
  if (normalizedExpected === null && expected !== null) return null;
  return {
    targetVersion,
    trigger: trigger as HostUpdateTrigger,
    action: action as AttemptClaimRequest["action"],
    expected: normalizedExpected,
    newAttemptId,
    initialPhase: initialPhase as AttemptClaimRequest["initialPhase"],
    nowIso,
  };
}

function normalizeAdvance(value: unknown): AttemptAdvance | null {
  if (!isSerializableInputObject(value)) return null;
  const phase = dataProperty(value, "phase");
  const continuation = dataProperty(value, "continuation");
  const nowIso = nonEmptyString(dataProperty(value, "nowIso"));
  const progress = normalizeProgress(dataProperty(value, "progress"));
  const error = normalizeError(dataProperty(value, "error"));
  if (
    typeof phase !== "string" ||
    !PHASES.has(phase) ||
    (continuation !== null &&
      continuation !== "resume-apply" &&
      continuation !== "activate") ||
    nowIso === null ||
    progress === "invalid" ||
    error === "invalid"
  ) {
    return null;
  }
  return {
    phase: phase as HostUpdateAttemptPhase,
    continuation: continuation as HostUpdateAttemptContinuation,
    progress,
    error,
    nowIso,
  };
}

function normalizeRecoveryArtifactEvidence(
  value: unknown,
): AttemptRecoveryArtifactEvidence | null {
  if (!isSerializableInputObject(value)) return null;
  const kind = dataProperty(value, "kind");
  if (kind === "absent" || kind === "unreadable") return { kind };
  if (kind !== "verified" && kind !== "missing") return null;
  const version = nonEmptyString(dataProperty(value, "version"));
  return version === null ? null : { kind, version };
}

function normalizeRecoveryRunningEvidence(
  value: unknown,
): AttemptRecoveryRunningEvidence | null {
  if (!isSerializableInputObject(value)) return null;
  const kind = dataProperty(value, "kind");
  if (kind === "absent" || kind === "unreadable") return { kind };
  const version = nonEmptyString(dataProperty(value, "version"));
  if (version === null) return null;
  if (kind === "unbound") return { kind, version };
  if (
    kind !== "verified" ||
    dataProperty(value, "owner") !== "host-home-bound"
  ) {
    return null;
  }
  return { kind, version, owner: "host-home-bound" };
}

function normalizeRecoveryEvidence(
  value: unknown,
): AttemptRecoveryEvidence | null {
  if (!isSerializableInputObject(value)) return null;
  const installed = normalizeRecoveryArtifactEvidence(
    dataProperty(value, "installed"),
  );
  const staged = normalizeRecoveryArtifactEvidence(
    dataProperty(value, "staged"),
  );
  const running = normalizeRecoveryRunningEvidence(
    dataProperty(value, "running"),
  );
  if (installed === null || staged === null || running === null) return null;
  return { installed, staged, running };
}

function normalizeRecoveryRequest(
  value: unknown,
): AttemptRecoveryRequest | null {
  if (!isSerializableInputObject(value)) return null;
  const expected = normalizeIdentity(dataProperty(value, "expected"));
  const requestedTargetVersion = nonEmptyString(
    dataProperty(value, "requestedTargetVersion"),
  );
  const action = dataProperty(value, "action");
  const evidence = normalizeRecoveryEvidence(dataProperty(value, "evidence"));
  const nowIso = nonEmptyString(dataProperty(value, "nowIso"));
  if (
    expected === null ||
    requestedTargetVersion === null ||
    typeof action !== "string" ||
    !CLAIM_ACTIONS.has(action) ||
    evidence === null ||
    nowIso === null
  ) {
    return null;
  }
  return {
    expected,
    requestedTargetVersion,
    action: action as AttemptRecoveryRequest["action"],
    evidence,
    nowIso,
  };
}

function normalizeMutationIntent(value: unknown): AttemptMutationIntent | null {
  // A plugin can hand this public boundary a Proxy whose `has`/`get` trap
  // throws. That is malformed input, not a reason for the writer to throw
  // halfway through an authority check. All source-object inspection stays
  // inside this catch; the returned intent contains only copied primitives.
  try {
    return normalizeMutationIntentUnchecked(value);
  } catch {
    return null;
  }
}

function normalizeMutationIntentUnchecked(
  value: unknown,
): AttemptMutationIntent | null {
  if (!isSerializableInputObject(value)) return null;
  const kind = dataProperty(value, "kind");
  if (kind === "advance") {
    const held = normalizeIdentity(dataProperty(value, "held"));
    const advance = normalizeAdvance(dataProperty(value, "advance"));
    return held === null || advance === null ? null : { kind, held, advance };
  }
  if (kind === "recover") {
    const recovery = normalizeRecoveryRequest(dataProperty(value, "recovery"));
    return recovery === null ? null : { kind, recovery };
  }
  if (kind === "create" || kind === "resume") {
    const request = normalizeClaimRequest(dataProperty(value, "request"));
    return request === null ? null : { kind, request };
  }
  if (kind === "supersede") {
    const request = normalizeClaimRequest(dataProperty(value, "request"));
    const rawRecovery = dataProperty(value, "recovery");
    const recovery =
      rawRecovery === undefined
        ? undefined
        : normalizeRecoveryRequest(rawRecovery);
    if (request === null || recovery === null) return null;
    return recovery === undefined
      ? { kind, request }
      : { kind, request, recovery };
  }
  return null;
}

function sameNullableProgress(
  a: HostUpdateAttemptProgress,
  b: HostUpdateAttemptProgress,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    Object.is(a.percent, b.percent) &&
    Object.is(a.bytes, b.bytes) &&
    Object.is(a.totalBytes, b.totalBytes)
  );
}

function sameNullableError(
  a: HostUpdateAttemptError,
  b: HostUpdateAttemptError,
): boolean {
  if (a === null || b === null) return a === b;
  return a.code === b.code && a.message === b.message && a.phase === b.phase;
}

function sameRecovery(
  a: HostUpdateAttemptRecovery | undefined,
  b: HostUpdateAttemptRecovery | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.recoveredBy === b.recoveredBy &&
    a.outcome === b.outcome &&
    a.evidence.installed.kind === b.evidence.installed.kind &&
    a.evidence.installed.version === b.evidence.installed.version &&
    a.evidence.staged.kind === b.evidence.staged.kind &&
    a.evidence.staged.version === b.evidence.staged.version &&
    a.evidence.running.kind === b.evidence.running.kind &&
    a.evidence.running.version === b.evidence.running.version &&
    a.evidence.running.ownerBound === b.evidence.running.ownerBound
  );
}

// Do not reduce this to a JSON-string comparison. We need to compare the
// transition's semantic value to the decoder's canonical value, not merely
// prove that a second serializer happens to emit the same representation.
function sameRecord(
  a: HostUpdateAttemptRecord,
  b: HostUpdateAttemptRecord,
): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    sameAttemptIdentity(attemptIdentityOf(a), attemptIdentityOf(b)) &&
    a.trigger === b.trigger &&
    a.targetVersion === b.targetVersion &&
    a.phase === b.phase &&
    a.execution === b.execution &&
    a.continuation === b.continuation &&
    sameNullableProgress(a.progress, b.progress) &&
    a.startedAt === b.startedAt &&
    a.updatedAt === b.updatedAt &&
    a.completedAt === b.completedAt &&
    sameNullableError(a.error, b.error) &&
    sameRecovery(a.recovery, b.recovery)
  );
}

type EncodedRecord = {
  readonly bytes: string;
  readonly record: HostUpdateAttemptRecord;
};

function encodeValidatedRecord(
  record: HostUpdateAttemptRecord,
): EncodedRecord | null {
  let bytes: string;
  try {
    bytes = `${JSON.stringify(record, null, 2)}\n`;
  } catch {
    return null;
  }
  const decoded = decodeHostUpdateAttempt({ kind: "bytes", text: bytes });
  if (decoded.kind !== "valid" || !sameRecord(record, decoded.value)) {
    return null;
  }
  return { bytes, record: decoded.value };
}

/**
 * Commit one transition-derived record to the handle's canonical
 * `update-attempt.json`. A parked-target change remains deliberately two
 * writes: commit `supersede`, then make a separate `create` claim over the
 * terminal evidence. A crash between them therefore cannot erase the old
 * target's durable outcome.
 */
export async function commitAttemptMutation(
  options: CommitAttemptMutationOptions,
): Promise<AttemptCommitOutcome> {
  // Types disappear at the JavaScript boundary. Reject a structural recovery
  // object here too, so public-barrel callers cannot bypass the recovery
  // evidence owner with `as` casts, plugins, or plain JavaScript.
  const normalized = normalizeMutationIntent(options.intent);
  if (normalized === null) return rejectedWithoutRead("intent-invalid");
  if (isExecutorOnlyMutationIntent(normalized)) {
    return rejectedWithoutRead("intent-not-legal");
  }
  return commitAttemptMutationInternal({
    handle: options.handle,
    intent: normalized,
  });
}

/**
 * Direct-module executor-only mutation channel. Its importer boundary is
 * enforced by the contender architecture gate, while the executor facade
 * supplies the live capability and evidence ownership for recoveries,
 * recovery-derived supersedes, and exact terminal completion.
 */
export async function commitExecutorOnlyAttemptMutation(
  options: CommitExecutorOnlyAttemptMutationOptions,
): Promise<AttemptCommitOutcome> {
  return commitAttemptMutationInternal(options);
}

async function commitAttemptMutationInternal(options: {
  readonly handle: UpdateAttemptLockHandle;
  readonly intent: AttemptMutationIntent;
}): Promise<AttemptCommitOutcome> {
  const leaseOutcome = acquireAttemptMutationLease(options.handle);
  if (leaseOutcome.kind !== "leased") {
    return rejectedWithoutRead(
      leaseOutcome.kind === "not-issued"
        ? "handle-not-issued"
        : "handle-released",
    );
  }

  const { lease } = leaseOutcome;
  try {
    const preOwnership = await ownershipRejection(options.handle);
    if (preOwnership !== null) return rejectedWithoutRead(preOwnership);

    const intent = normalizeMutationIntent(options.intent);
    if (intent === null) return rejectedWithoutRead("intent-invalid");

    const canonical = await readRecordAtPath(lease.recordPath);
    if (
      canonical.kind === "corrupt" ||
      canonical.kind === "unreadable" ||
      canonical.kind === "unsupported-version"
    ) {
      return { kind: "rejected", reason: "record-fail-closed", canonical };
    }
    const next = recomputeIntent(canonical, intent);
    if (next === null) {
      return { kind: "rejected", reason: "intent-not-legal", canonical };
    }
    // Serialize once, then make the decoder validate THOSE exact bytes before
    // the rename. The bytes subsequently fsynced and renamed are therefore
    // exactly the record the transition authorized, not a second invocation
    // of a caller-controlled serializer.
    const encoded = encodeValidatedRecord(next);
    if (encoded === null) {
      return { kind: "rejected", reason: "intent-invalid", canonical };
    }

    // The lease prevents our release from removing this lock after this check
    // but before rename. A stale-break by another process is still detected
    // here by token ownership, so both independent authority failures close.
    const postOwnership = await ownershipRejection(options.handle);
    if (postOwnership !== null) {
      return { kind: "rejected", reason: postOwnership, canonical };
    }

    let written: RawWriteOutcome;
    try {
      written = await writeRecordAtomic(lease.recordPath, encoded.bytes);
    } catch (err) {
      if (err instanceof AttemptRecordDurabilityError) {
        return {
          kind: "durability-unverified",
          cause: err.cause,
          canonical: await readRecordAtPath(lease.recordPath),
        };
      }
      // Every other throw out of `writeRecordAtomic` (mkdir, temp open/write/
      // fsync, the rename itself) happened BEFORE a durable rename could
      // land, so the canonical record is unchanged — but the callers of
      // `deps.commit` await an outcome and switch on `kind`; a raw rejection
      // here would bypass their activation-result handling entirely. Fold it
      // into the same conservative arm: do not proceed, evidence attached.
      return {
        kind: "durability-unverified",
        cause: `record-write-failed:${errorCode(err) ?? String(err)}`,
        canonical: await readRecordAtPath(lease.recordPath),
      };
    }
    if (written.kind === "refused") {
      return { kind: "rejected", reason: "record-path-refused", canonical };
    }
    const reread = await readRecordAtPath(lease.recordPath);
    if (reread.kind !== "valid" || !sameRecord(encoded.record, reread.value)) {
      // The rename completed, but returning success would authorize a caller
      // to act on a record we cannot positively prove is the exact canonical
      // value just validated. This is the same operational posture as an
      // unverifiable directory sync: preserve the evidence, do not proceed.
      return {
        kind: "durability-unverified",
        cause: "post-write-roundtrip-mismatch",
        canonical: reread,
      };
    }
    return {
      kind: "committed",
      record: reread.value,
      identity: attemptIdentityOf(reread.value),
    };
  } finally {
    lease.release();
  }
}

export type AttemptPruneRejection =
  | AttemptMutationRejection
  | "not-terminal"
  | "not-expired"
  | "expectation-mismatch"
  | "remove-failed";

export type AttemptPruneOutcome =
  | { readonly kind: "pruned" }
  | {
      readonly kind: "rejected";
      readonly reason: AttemptPruneRejection;
      readonly canonical: HostUpdateAttemptRead;
    };

export interface PruneTerminalAttemptRecordOptions {
  readonly handle: UpdateAttemptLockHandle;
  /** The exact retained terminal record the caller intends to drop. */
  readonly expected: HostUpdateAttemptIdentity;
  /** The caller controls only observation time, never retention policy. */
  readonly nowMs: number;
}

/** Retention cleanup is an explicit, handle-bound `prune` mutation intent. */
export async function pruneTerminalAttemptRecord(
  options: PruneTerminalAttemptRecordOptions,
): Promise<AttemptPruneOutcome> {
  const leaseOutcome = acquireAttemptMutationLease(options.handle);
  if (leaseOutcome.kind !== "leased") {
    return rejectedPruneWithoutRead(
      leaseOutcome.kind === "not-issued"
        ? "handle-not-issued"
        : "handle-released",
    );
  }

  const { lease } = leaseOutcome;
  try {
    const preOwnership = await ownershipRejection(options.handle);
    if (preOwnership !== null) return rejectedPruneWithoutRead(preOwnership);

    const canonical = await readRecordAtPath(lease.recordPath);
    if (canonical.kind !== "valid") {
      return { kind: "rejected", reason: "record-fail-closed", canonical };
    }
    if (
      !sameAttemptIdentity(attemptIdentityOf(canonical.value), options.expected)
    ) {
      return { kind: "rejected", reason: "expectation-mismatch", canonical };
    }
    if (canonical.value.execution !== "terminal") {
      return { kind: "rejected", reason: "not-terminal", canonical };
    }
    if (!isTerminalRetentionExpired(canonical.value, options.nowMs)) {
      return { kind: "rejected", reason: "not-expired", canonical };
    }

    const postOwnership = await ownershipRejection(options.handle);
    if (postOwnership !== null) {
      return { kind: "rejected", reason: postOwnership, canonical };
    }
    return (await removeRecordFile(lease.recordPath))
      ? { kind: "pruned" }
      : { kind: "rejected", reason: "remove-failed", canonical };
  } finally {
    lease.release();
  }
}

function recomputeIntent(
  canonical: HostUpdateAttemptRead,
  intent: AttemptMutationIntent,
): HostUpdateAttemptRecord | null {
  if (intent.kind === "advance") {
    if (canonical.kind !== "valid") return null;
    const result = advanceAttempt(canonical.value, intent.held, intent.advance);
    return result.kind === "advanced" ? result.record : null;
  }

  if (intent.kind === "recover") {
    if (canonical.kind !== "valid") return null;
    const decision = decideAttemptRecovery({
      current: canonical.value,
      request: intent.recovery,
      // The handle was freshly ownership-checked immediately before this
      // canonical read. `acquireUpdateAttemptLock` grants it only after a
      // positive no-live-holder outcome; an indeterminate prior holder never
      // reaches this mutation path.
      holder: { kind: "recovery-lock-held" },
    });
    return decision.kind === "refuse" || decision.kind === "supersede"
      ? null
      : decision.record;
  }

  if (intent.kind === "supersede" && intent.recovery !== undefined) {
    if (canonical.kind !== "valid") return null;
    if (
      intent.recovery.requestedTargetVersion !== intent.request.targetVersion ||
      intent.recovery.action !== intent.request.action
    ) {
      return null;
    }
    const recovery = decideAttemptRecovery({
      current: canonical.value,
      request: intent.recovery,
      holder: { kind: "recovery-lock-held" },
    });
    return recovery.kind === "supersede" ? recovery.record : null;
  }

  const decision = decideAttemptClaim({
    current: canonical,
    request: intent.request,
    holder: { kind: "held-by-self" },
  });
  if (decision.kind !== intent.kind) return null;
  return decision.record;
}

function rejectedWithoutRead(
  reason: AttemptMutationRejection,
): AttemptCommitOutcome {
  return {
    kind: "rejected",
    reason,
    canonical: { kind: "unreadable", cause: "not-read" },
  };
}

function rejectedPruneWithoutRead(
  reason: AttemptMutationRejection,
): AttemptPruneOutcome {
  return {
    kind: "rejected",
    reason,
    canonical: { kind: "unreadable", cause: "not-read" },
  };
}

async function ownershipRejection(
  handle: UpdateAttemptLockHandle,
): Promise<AttemptMutationRejection | null> {
  const ownership = await verifyAttemptLockOwnership(handle);
  switch (ownership.kind) {
    case "owned":
      return null;
    case "not-issued":
      return "handle-not-issued";
    case "released":
      return "handle-released";
    case "lost":
      return "lock-lost";
    case "indeterminate":
      return "lock-indeterminate";
  }
}
