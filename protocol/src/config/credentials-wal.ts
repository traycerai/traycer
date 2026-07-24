import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  bumpMtimeAbove,
  errorCode,
  fileMtimeMsOrZero,
  writeJsonFileAtomic,
} from "./credentials-fs";
import {
  deleteCredentialsFile,
  serializeCredentials,
  writeCredentialsFile,
  type StoredCredentials,
} from "./credentials";
import { withCredentialsLock } from "./credentials-lock";

/**
 * Write-ahead log for credentials mutations (credentials-file token-store tech
 * plan, §2). The sidecar `credentials.meta.json` is token-free and mutated only
 * under the lock. Every mutation runs prepare -> apply -> finalize, so any crash
 * between the credentials file and the sidecar is recoverable: the next lock
 * acquirer finds the `pending` record and either completes it (the apply
 * provably landed) or rolls it back (it did not).
 *
 * The sidecar also carries the sign-out tombstone (`lastMutation: "signOut"`)
 * and the monotonic mtime floor that survives a delete->recreate, so the host's
 * mtime-equality owner cache can never serve a stale owner.
 */
export type MutationKind = "signIn" | "rotate" | "signOut" | "updateProfile";

export interface PendingRecord {
  readonly op: MutationKind;
  // Epoch this mutation commits to (see nextEpochFor).
  readonly nextEpoch: number;
  // Digest of the credentials bytes the apply intends to land; `null` for a
  // sign-out (a delete has no target content).
  readonly targetDigest: string | null;
  // `max(prior floor, F mtime)` captured before any F mutation, carried so a
  // delete->recreate keeps the host owner cache strictly advancing.
  readonly floorCandidate: number;
}

export interface SidecarState {
  readonly epoch: number;
  // The last committed mutation kind; `null` on a fresh sidecar (never mutated).
  readonly lastMutation: MutationKind | null;
  readonly mtimeFloorMs: number;
  readonly pending: PendingRecord | null;
}

export type SidecarReadResult =
  | { readonly kind: "present"; readonly state: SidecarState }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" };

export interface CommitPaths {
  readonly credentialsPath: string;
  readonly metaPath: string;
}

export type WalTarget =
  | { readonly kind: "write"; readonly credentials: StoredCredentials }
  | { readonly kind: "delete" };

export type CommitOutcome =
  | {
      readonly kind: "committed";
      readonly state: SidecarState;
      readonly mtimeMs: number | null;
    }
  | { readonly kind: "commit-failed"; readonly error: unknown };

export type InitGateResult = "ready" | "recovery-deferred" | "unavailable";

// Token-free, but kept owner-only for tidiness alongside the credentials file.
const SIDECAR_MODE = 0o600;
// Bounded in-place retry of the local WAL chain within a single lock hold
// (pure filesystem work). Exhaustion -> `commit-failed`.
const COMMIT_ATTEMPTS = 3;
const COMMIT_RETRY_DELAY_MS = 20;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Digest of the exact bytes the write primitive lands for `credentials`. */
export function digestCredentials(credentials: StoredCredentials): string {
  return sha256Hex(serializeCredentials(credentials));
}

/**
 * Sign-out and interactive sign-in are tombstone transitions and take a fresh
 * epoch; rotate and profile updates preserve the session identity and its
 * epoch. The epoch is what a first-write migration continuation pins to detect
 * a sign-out landing under it (§2).
 */
function nextEpochFor(op: MutationKind, currentEpoch: number): number {
  return op === "signOut" || op === "signIn" ? currentEpoch + 1 : currentEpoch;
}

/** The state to assume when the sidecar is absent (fresh machine / upgrade). */
export function defaultSidecarState(fMtimeMs: number): SidecarState {
  return {
    epoch: 0,
    lastMutation: null,
    mtimeFloorMs: fMtimeMs,
    pending: null,
  };
}

/** A committed *or pending* sign-out both count as a tombstone for every guard. */
export function hasTombstone(state: SidecarState): boolean {
  return state.lastMutation === "signOut" || state.pending?.op === "signOut";
}

export async function readSidecar(
  metaPath: string,
): Promise<SidecarReadResult> {
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "missing" };
    throw err;
  }
  const state = parseSidecar(raw);
  return state === null ? { kind: "malformed" } : { kind: "present", state };
}

export async function writeSidecarState(
  metaPath: string,
  state: SidecarState,
): Promise<void> {
  await writeJsonFileAtomic(metaPath, state, SIDECAR_MODE);
}

/**
 * Runs prepare -> apply -> finalize for one mutation, all under a lock the
 * caller already holds. Returns `committed` with the new sidecar state, or
 * `commit-failed` after a bounded in-place retry of the local chain (the minted
 * pair, if any, stays with the caller for the continuation retry). A finalize
 * that never lands is not lost data: the apply already put the target on disk,
 * so recovery replays the finalize on the next acquisition.
 */
export async function commitMutation(args: {
  readonly paths: CommitPaths;
  readonly op: MutationKind;
  readonly target: WalTarget;
  readonly currentState: SidecarState;
}): Promise<CommitOutcome> {
  const { paths, op, target, currentState } = args;
  let floorCandidate: number;
  let targetDigest: string | null;
  try {
    // Floor captured before any F mutation; digest of the intended bytes.
    floorCandidate = Math.max(
      currentState.mtimeFloorMs,
      await fileMtimeMsOrZero(paths.credentialsPath),
    );
    targetDigest =
      target.kind === "write" ? digestCredentials(target.credentials) : null;
  } catch (err) {
    return { kind: "commit-failed", error: err };
  }
  const nextEpoch = nextEpochFor(op, currentState.epoch);
  const pending: PendingRecord = {
    op,
    nextEpoch,
    targetDigest,
    floorCandidate,
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    try {
      // 1. Prepare: record the intent (committed fields unchanged).
      await writeSidecarState(paths.metaPath, {
        ...currentState,
        pending,
      });
      // 2. Apply: mutate F.
      let mtimeMs: number | null;
      if (target.kind === "write") {
        mtimeMs = (
          await writeCredentialsFile(
            paths.credentialsPath,
            target.credentials,
            floorCandidate,
          )
        ).mtimeMs;
      } else {
        await deleteCredentialsFile(paths.credentialsPath);
        mtimeMs = null;
      }
      // 3. Finalize: the committed state.
      const finalState: SidecarState = {
        epoch: nextEpoch,
        lastMutation: op,
        mtimeFloorMs:
          mtimeMs !== null ? Math.max(floorCandidate, mtimeMs) : floorCandidate,
        pending: null,
      };
      await writeSidecarState(paths.metaPath, finalState);
      return { kind: "committed", state: finalState, mtimeMs };
    } catch (err) {
      lastError = err;
      await sleep(COMMIT_RETRY_DELAY_MS);
    }
  }
  return { kind: "commit-failed", error: lastError };
}

/**
 * Completes or rolls back a `pending` record deterministically (§2). Must be
 * called under the lock, with a state whose `pending` is non-null. Returns the
 * recovered committed state.
 *
 *   - pending signOut       -> complete the delete (ENOENT-tolerant), finalize
 *                              the tombstone including the floor candidate.
 *   - pending write + F     -> if F matches the target digest, the apply landed:
 *     matches digest           replay the mtime bump and finalize.
 *   - pending write + F      -> the apply never landed: roll back (clear pending,
 *     absent/mismatch          keep the committed state); the caller retries.
 */
export async function recoverPending(args: {
  readonly paths: CommitPaths;
  readonly state: SidecarState;
}): Promise<SidecarState> {
  const { paths, state } = args;
  const pending = state.pending;
  if (pending === null) return state;

  if (pending.op === "signOut") {
    await deleteCredentialsFile(paths.credentialsPath);
    return finalize(paths.metaPath, {
      epoch: pending.nextEpoch,
      lastMutation: "signOut",
      mtimeFloorMs: pending.floorCandidate,
      pending: null,
    });
  }

  const raw = await readFileRaw(paths.credentialsPath);
  const applyLanded =
    raw !== null &&
    pending.targetDigest !== null &&
    sha256Hex(raw) === pending.targetDigest;
  if (applyLanded) {
    const mtimeMs = await bumpMtimeAbove(
      paths.credentialsPath,
      pending.floorCandidate,
    );
    return finalize(paths.metaPath, {
      epoch: pending.nextEpoch,
      lastMutation: pending.op,
      mtimeFloorMs: Math.max(pending.floorCandidate, mtimeMs),
      pending: null,
    });
  }

  // Apply never landed -> roll back to the committed base, dropping the intent.
  // If that base is a sign-out tombstone, F must be absent: a stale/foreign
  // writer may have left a *different* valid file that the sidecar-blind host
  // would otherwise adopt, resurrecting the logged-out session. Restore absence,
  // carrying the floor above any stray file's mtime so a later sign-in outranks.
  if (state.lastMutation === "signOut") {
    const strayFloor = await fileMtimeMsOrZero(paths.credentialsPath);
    await deleteCredentialsFile(paths.credentialsPath);
    return finalize(paths.metaPath, {
      ...state,
      mtimeFloorMs: Math.max(state.mtimeFloorMs, strayFloor),
      pending: null,
    });
  }
  return finalize(paths.metaPath, { ...state, pending: null });
}

/**
 * Store-initialization gate (§2). Acquires the lock and completes any pending
 * recovery, resolving:
 *   - `ready`             -> lock acquired, recovery done (or nothing pending).
 *   - `recovery-deferred` -> a live holder kept the lock within the bounded
 *                            wait; reads proceed lock-free, mutations recover at
 *                            their own acquisition, a background retry re-runs.
 *   - `unavailable`       -> an I/O failure; the store surfaces unavailable.
 */
export async function runInitGate(args: {
  readonly paths: CommitPaths;
  readonly lockPath: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}): Promise<InitGateResult> {
  try {
    const result = await withCredentialsLock(
      {
        lockPath: args.lockPath,
        reason: "init-recover",
        waitMs: args.waitMs,
        pollIntervalMs: args.pollIntervalMs,
        signal: null,
      },
      async () => {
        const read = await readSidecar(args.paths.metaPath);
        // A missing sidecar is fresh/pre-refactor; a malformed one is left for
        // fail-closed handling at mutation time. Only a readable pending record
        // is recovered here.
        if (read.kind === "present" && read.state.pending !== null) {
          await recoverPending({ paths: args.paths, state: read.state });
        }
      },
    );
    return result.acquired ? "ready" : "recovery-deferred";
  } catch {
    return "unavailable";
  }
}

async function finalize(
  metaPath: string,
  state: SidecarState,
): Promise<SidecarState> {
  await writeSidecarState(metaPath, state);
  return state;
}

async function readFileRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
}

function parseSidecar(raw: string): SidecarState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  // Range-validate the numeric fields, not just `typeof number`: a corrupt
  // sidecar with a huge/NaN epoch or floor must be classified malformed here
  // (fail-closed before any spend, rebuildable by an interactive sign-in), never
  // returned `present` only to break later at `utimes` as a post-spend fault.
  if (
    !isEpoch(obj.epoch) ||
    !isMtimeMs(obj.mtimeFloorMs) ||
    !isMutationKindOrNull(obj.lastMutation)
  ) {
    return null;
  }
  const pending = parsePending(obj.pending);
  if (pending === "invalid") return null;
  return {
    epoch: obj.epoch,
    lastMutation: obj.lastMutation,
    mtimeFloorMs: obj.mtimeFloorMs,
    pending,
  };
}

function parsePending(value: unknown): PendingRecord | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return "invalid";
  const obj = value as Record<string, unknown>;
  if (
    !isMutationKind(obj.op) ||
    !isEpoch(obj.nextEpoch) ||
    !isMtimeMs(obj.floorCandidate)
  ) {
    return "invalid";
  }
  // Op/target coupling: a sign-out deletes (no digest); every write op must
  // carry a non-empty digest. Anything else is corruption, not a live intent.
  let targetDigest: string | null;
  if (obj.op === "signOut") {
    if (obj.targetDigest !== null) return "invalid";
    targetDigest = null;
  } else {
    if (typeof obj.targetDigest !== "string" || obj.targetDigest.length === 0) {
      return "invalid";
    }
    targetDigest = obj.targetDigest;
  }
  return {
    op: obj.op,
    nextEpoch: obj.nextEpoch,
    targetDigest,
    floorCandidate: obj.floorCandidate,
  };
}

function isMutationKind(value: unknown): value is MutationKind {
  return (
    value === "signIn" ||
    value === "rotate" ||
    value === "signOut" ||
    value === "updateProfile"
  );
}

function isMutationKindOrNull(value: unknown): value is MutationKind | null {
  return value === null || isMutationKind(value);
}

// The largest mtime floor we accept from the sidecar. Bounded by the maximum
// valid JS Date MINUS headroom for the largest post-parse bump (`bumpMtimeAbove`
// escalates up to 16s for coarse clocks; the write path adds +1ms), so a
// validated floor can never make `floor + bump` overflow Date and fault at
// `utimes` AFTER a spend. A floor above this parses malformed (fail-closed
// before any spend) rather than surfacing later as a post-spend commit fault.
const MAX_MTIME_FLOOR_MS = 8_640_000_000_000_000 - 16_000;

function isEpoch(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isMtimeMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_MTIME_FLOOR_MS
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
