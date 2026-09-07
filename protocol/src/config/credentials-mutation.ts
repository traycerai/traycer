import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { readCredentialsFile, type StoredCredentials } from "./credentials";
import {
  errorCode,
  fileMtimeMsOrZero,
  writeJsonFileAtomic,
} from "./credentials-fs";
import {
  isHolderProvablyDead,
  isProcessAlive,
  ownPidStartFingerprint,
  queryPidStartFingerprint,
  withCredentialsLock,
} from "./credentials-lock";
import {
  commitMutation,
  defaultSidecarState,
  digestCredentials,
  hasTombstone,
  readSidecar,
  recoverPending,
  type CommitPaths,
  type SidecarState,
} from "./credentials-wal";

export interface CredentialsMutationPaths {
  readonly credentialsPath: string;
  readonly metaPath: string;
  readonly lockPath: string;
}

/**
 * Injected single-attempt refresh.
 * Mirrors the shared `AuthTokenRefreshResult` shape; never throws (every failure maps to a kind).
 */
export type RefreshResult =
  | {
      readonly kind: "refreshed";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };

export type RefreshFn = (args: {
  readonly token: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal | null;
}) => Promise<RefreshResult>;

export type MutationOutcome =
  | "applied"
  | "superseded"
  | "deleted"
  | "user-mismatch"
  | "tombstoned"
  | "lock-busy"
  | "spend-pending"
  | "refresh-rejected"
  | "refresh-network"
  | "commit-failed";

export interface MutationResult {
  readonly outcome: MutationOutcome;
  readonly credentials: StoredCredentials | null;
}

/** Ceiling for the quarantine drain's backoff. */
const QUARANTINE_RETRY_MAX_MS = 30_000;

export interface CredentialsMutationStoreOptions {
  readonly paths: CredentialsMutationPaths;
  readonly refresh: RefreshFn;
  readonly lockWaitMs: number;
  readonly lockPollIntervalMs: number;
  // Backoff before a background retry of an outstanding commit-failed
  // continuation. Injected for deterministic tests.
  readonly continuationRetryMs: number;
}

export interface CredentialsMutationStore {
  /**
   * Current credentials with a process-local overlay: while a commit-failed continuation is outstanding, this process never sees its own spent base on disk - it sees the minted pair it is still trying to land.
   */
  read(): Promise<StoredCredentials | null>;
  /** Locked adopt-or-refresh+commit. `refreshTokenOverride` lets migration spend a candidate refresh token. */
  rotate(args: {
    readonly expectedUserId: string;
    readonly expectedToken: string;
    readonly refreshTokenOverride: string | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  /** Interactive create/replace; clears the tombstone. */
  signIn(
    credentials: StoredCredentials,
    preserveRefreshTokenIfBlank: boolean,
    signal: AbortSignal | null,
  ): Promise<MutationResult>;
  /** Delete under the lock (ENOENT-tolerant); always advances the tombstone. */
  signOut(signal: AbortSignal | null): Promise<MutationResult>;
  signOutIfToken(
    expectedToken: string,
    signal: AbortSignal | null,
  ): Promise<MutationResult>;
  drainQuarantine(signal: AbortSignal | null): Promise<boolean>;
  /** CAS'd merge of the `user` block only; tokens untouched. */
  updateProfile(args: {
    readonly expectedToken: string;
    readonly user: StoredCredentials["user"];
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  /**
   * Migration first-write of a known pair (§6 step 4 continuation shape): guarded by the file snapshot + tombstone/epoch, so a sign-out or newer state wins.
   */
  guardedSignIn(args: {
    readonly credentials: StoredCredentials;
    readonly expectedFile: StoredCredentials | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  /**
   * Migration first-write that must SPEND a candidate refresh token first (§6 step 4, F absent/invalid).
   */
  migrateFirstWrite(args: {
    readonly candidate: {
      readonly token: string;
      readonly refreshToken: string;
    };
    readonly identity: StoredCredentials["user"];
    readonly expectedFile: StoredCredentials | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  /** Whether a commit-failed continuation is outstanding (self-pending check). */
  hasPendingContinuation(): boolean;
  /** Stop the background continuation retry timer. */
  dispose(): void;
}

/** Thrown when the store cannot be trusted (malformed sidecar on an automatic mutation, or an I/O fault). Callers map it to store-unavailable. */
export class CredentialsStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsStoreUnavailableError";
  }
}

// Process-local commit-failed continuation - the only in-memory persisted authority, never written to disk (that on-disk overlay was the condemned round-4 design).
type PendingContinuation =
  | {
      readonly kind: "pair";
      readonly expectedToken: string;
      readonly pair: StoredCredentials;
    }
  | {
      readonly kind: "firstWrite";
      readonly credentials: StoredCredentials;
      readonly expectedDigest: string | null;
      readonly tombstoneEpoch: number;
      readonly spentBaseToken: string | null;
    };

/**
 * The spent-base marker - the cross-PROCESS complement of the in-memory commit-failed continuation.
 * Reclaiming risks at most one server-side replay/reject of an already-spent base - strictly better than both the unconditional sibling re-spend it replaces and an unbounded wait on an owner that may never come back.
 */
interface SpentBaseMarker {
  readonly spentTokenDigest: string;
  readonly at: string;
  readonly ownerPid: number;
  readonly ownerFingerprint: string | null;
}

const SPENT_BASE_MARKER_TTL_MS = 60_000;

/** Exported so tests assert against the path production actually writes. */
export function spentBaseMarkerPath(credentialsPath: string): string {
  return `${credentialsPath}.pending-spend.json`;
}

/**
 * Sidecar recording token digests whose conditional delete has been REQUESTED but has not provably landed (the quarantine).
 */
export function quarantinePath(credentialsPath: string): string {
  return `${credentialsPath}.quarantine.json`;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Absent reads as empty.
 * Malformed also reads as empty: the record is written atomically BEFORE the delete attempt, so a torn/garbled file cannot hide a still-pending delete - a genuinely pending one has a well-formed record.
 */
async function readQuarantinedDigests(qPath: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(qPath, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return new Set();
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const digests = (parsed as { tokenDigests?: unknown }).tokenDigests;
    if (Array.isArray(digests)) {
      return new Set(
        digests.filter((entry): entry is string => typeof entry === "string"),
      );
    }
  } catch {
    // Malformed - treated as empty per the contract above.
  }
  return new Set();
}

async function writeQuarantinedDigests(
  qPath: string,
  digests: ReadonlySet<string>,
): Promise<void> {
  if (digests.size === 0) {
    try {
      await unlink(qPath);
    } catch (err) {
      if (errorCode(err) !== "ENOENT") throw err;
    }
    return;
  }
  await writeJsonFileAtomic(qPath, { tokenDigests: [...digests] }, 0o600);
}

/**
 * Absent and malformed both read as "no marker": the marker is written BEFORE the refresh spend, so a torn record (crash mid-write) proves the spend never happened - there is nothing left to guard.
 */
async function readSpentBaseMarker(
  credentialsPath: string,
): Promise<SpentBaseMarker | null> {
  let raw: string;
  try {
    raw = await readFile(spentBaseMarkerPath(credentialsPath), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw new CredentialsStoreUnavailableError(
      "spent-base marker is unreadable",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.spentTokenDigest !== "string" ||
    obj.spentTokenDigest.length === 0 ||
    typeof obj.at !== "string" ||
    typeof obj.ownerPid !== "number"
  ) {
    return null;
  }
  return {
    spentTokenDigest: obj.spentTokenDigest,
    at: obj.at,
    ownerPid: obj.ownerPid,
    ownerFingerprint:
      typeof obj.ownerFingerprint === "string" ? obj.ownerFingerprint : null,
  };
}

function markerIsFresh(marker: SpentBaseMarker, nowMs: number): boolean {
  const atMs = Date.parse(marker.at);
  if (Number.isNaN(atMs)) return false;
  return Math.max(0, nowMs - atMs) < SPENT_BASE_MARKER_TTL_MS;
}

/** This process armed the marker. */
function isOwnSpentBaseMarker(marker: SpentBaseMarker): boolean {
  if (marker.ownerPid !== process.pid) return false;
  const own = ownPidStartFingerprint();
  return (
    marker.ownerFingerprint === null ||
    own === null ||
    marker.ownerFingerprint === own
  );
}

/** Same decision as the lock's dead-holder takeover, applied to the marker. */
function markerOwnerProvablyDead(marker: SpentBaseMarker): boolean {
  if (!isProcessAlive(marker.ownerPid)) return true;
  return isHolderProvablyDead({
    alive: true,
    recordedFingerprint: marker.ownerFingerprint,
    currentFingerprint: queryPidStartFingerprint(marker.ownerPid),
  });
}

/**
 * Fail-closed arm, run BEFORE the spend.
 * The rename makes replacement a single step - readers see either the old marker or the new one, never neither.
 */
async function writeSpentBaseMarker(
  credentialsPath: string,
  spentToken: string,
): Promise<void> {
  const marker: SpentBaseMarker = {
    spentTokenDigest: digestToken(spentToken),
    at: new Date().toISOString(),
    ownerPid: process.pid,
    ownerFingerprint: ownPidStartFingerprint(),
  };
  try {
    await writeJsonFileAtomic(
      spentBaseMarkerPath(credentialsPath),
      marker,
      0o600,
    );
  } catch {
    throw new CredentialsStoreUnavailableError(
      "spent-base marker could not be armed",
    );
  }
}

/** Best-effort, ENOENT-tolerant. */
async function clearSpentBaseMarker(credentialsPath: string): Promise<void> {
  try {
    await unlink(spentBaseMarkerPath(credentialsPath));
  } catch {
    // absent or unremovable - either way liveness + TTL bound the damage
  }
}

export function createCredentialsMutationStore(
  options: CredentialsMutationStoreOptions,
): CredentialsMutationStore {
  const { paths, refresh } = options;
  const commitPaths: CommitPaths = {
    credentialsPath: paths.credentialsPath,
    metaPath: paths.metaPath,
  };

  let pending: PendingContinuation | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let quarantineRetryTimer: NodeJS.Timeout | null = null;
  /** Consecutive failed drains, which is what the delay grows from. */
  let quarantineRetryAttempts = 0;
  let disposed = false;
  const qPath = quarantinePath(paths.credentialsPath);

  function quarantineRetryDelayMs(): number {
    // Doubling from the base, capped: the cap is what keeps a long-running process still checking - the quarantined delete must eventually land, so backing off without a ceiling would trade one problem for a worse one.
    return Math.min(
      QUARANTINE_RETRY_MAX_MS,
      options.continuationRetryMs * 2 ** quarantineRetryAttempts,
    );
  }

  function scheduleQuarantineRetry(): void {
    if (quarantineRetryTimer !== null || disposed) return;
    const delayMs = quarantineRetryDelayMs();
    quarantineRetryAttempts += 1;
    quarantineRetryTimer = setTimeout(() => {
      quarantineRetryTimer = null;
      void drainQuarantine(null).then(
        (clean) => {
          if (clean) {
            quarantineRetryAttempts = 0;
            return;
          }
          scheduleQuarantineRetry();
        },
        () => {
          scheduleQuarantineRetry();
        },
      );
    }, delayMs);
  }

  /**
   * Clear the spent-base marker ONLY if it still names `spentToken`'s digest.
   * Guarded so a process resolving a long-abandoned continuation can never clobber a NEWER marker a sibling wrote for a later base (that marker still protects a live pending spend).
   */
  async function clearOwnSpentBaseMarker(spentToken: string): Promise<void> {
    const marker = await readSpentBaseMarker(paths.credentialsPath);
    if (
      marker !== null &&
      marker.spentTokenDigest === digestToken(spentToken)
    ) {
      await clearSpentBaseMarker(paths.credentialsPath);
    }
  }

  async function loadState(interactive: boolean): Promise<SidecarState> {
    const read = await readSidecar(paths.metaPath);
    if (read.kind === "missing") {
      return defaultSidecarState(
        await fileMtimeMsOrZero(paths.credentialsPath),
      );
    }
    if (read.kind === "malformed") {
      // Interactive intent may rebuild a corrupt sidecar; an automatic mutation
      // fails closed (§2) rather than mutate against an untrusted floor/tombstone.
      if (interactive) {
        return defaultSidecarState(
          await fileMtimeMsOrZero(paths.credentialsPath),
        );
      }
      throw new CredentialsStoreUnavailableError(
        "credentials sidecar is malformed",
      );
    }
    if (read.state.pending !== null) {
      return recoverPending({ paths: commitPaths, state: read.state });
    }
    return read.state;
  }

  // Drive the outstanding commit-failed continuation to resolution.
  async function resolveContinuationLocked(
    state: SidecarState,
  ): Promise<SidecarState> {
    const p = pending;
    if (p === null) return state;
    const file = await readCredentialsFile(paths.credentialsPath);

    if (p.kind === "pair") {
      // Sign-out won, a sibling rotated, or the account switched -> drop the pending pair and defer to disk (adopt on the next read).
      if (
        file === null ||
        file.user.id !== p.pair.user.id ||
        file.token !== p.expectedToken
      ) {
        pending = null;
        await clearOwnSpentBaseMarker(p.expectedToken);
        return state;
      }
      const commit = await commitMutation({
        paths: commitPaths,
        op: "rotate",
        target: { kind: "write", credentials: p.pair },
        currentState: state,
      });
      if (commit.kind === "committed") {
        pending = null;
        await clearOwnSpentBaseMarker(p.expectedToken);
        return commit.state;
      }
      return state; // still failing -> keep pending, retry later
    }

    // firstWrite: a sign-out (committed or pending) or any newer state wins.
    const snapshotMatches =
      p.expectedDigest === null
        ? file === null
        : file !== null && digestCredentials(file) === p.expectedDigest;
    if (
      hasTombstone(state) ||
      state.epoch !== p.tombstoneEpoch ||
      !snapshotMatches
    ) {
      pending = null;
      if (p.spentBaseToken !== null) {
        await clearOwnSpentBaseMarker(p.spentBaseToken);
      }
      return state;
    }
    const commit = await commitMutation({
      paths: commitPaths,
      op: "signIn",
      target: { kind: "write", credentials: p.credentials },
      currentState: state,
    });
    if (commit.kind === "committed") {
      pending = null;
      if (p.spentBaseToken !== null) {
        await clearOwnSpentBaseMarker(p.spentBaseToken);
      }
      return commit.state;
    }
    return state;
  }

  function scheduleContinuationRetry(): void {
    if (retryTimer !== null || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void driveContinuation();
    }, options.continuationRetryMs);
  }

  async function driveContinuation(): Promise<void> {
    if (pending === null || disposed) return;
    try {
      // The preamble (loadState + resolveContinuationLocked) is all this needs;
      // there is no intent body to run.
      await withCredentialsLock(
        {
          lockPath: paths.lockPath,
          reason: "credentials-continuation",
          waitMs: options.lockWaitMs,
          pollIntervalMs: options.lockPollIntervalMs,
          signal: null,
        },
        async () => {
          const state = await loadState(false);
          await resolveContinuationLocked(state);
        },
      );
    } catch {
      // Best-effort background retry: a transient fault (or a disposed store / vanished file during shutdown) must never surface as an unhandled rejection.
    }
    if (pending !== null && !disposed) scheduleContinuationRetry();
  }

  // Every mutating intent runs under the lock with the same preamble: WAL recovery, then resolution of this process's own outstanding commit-failed continuation.
  // A caller binding a `commit-failed` pair to a live session MUST first check `pair.user.id` against its own expected identity (enforced renderer-side in AuthService.applyLiveRotateOutcome).
  async function runMutation(
    signal: AbortSignal | null,
    interactive: boolean,
    // Whether the body may observe a QUARANTINED current pair.
    servesQuarantined: boolean,
    body: (ctx: {
      state: SidecarState;
      file: StoredCredentials | null;
    }) => Promise<MutationResult>,
  ): Promise<MutationResult> {
    const result = await withCredentialsLock(
      {
        lockPath: paths.lockPath,
        reason: "credentials-mutate",
        waitMs: options.lockWaitMs,
        pollIntervalMs: options.lockPollIntervalMs,
        signal,
      },
      async (): Promise<MutationResult> => {
        let state = await loadState(interactive);
        state = await resolveContinuationLocked(state);
        if (pending !== null) {
          return {
            outcome: "commit-failed",
            credentials: pendingCredentials(pending),
          };
        }
        let file = await readCredentialsFile(paths.credentialsPath);
        if (!servesQuarantined && file !== null) {
          const quarantined = await readQuarantinedDigests(qPath);
          if (quarantined.has(digestToken(file.token))) {
            file = null;
          }
        }
        return body({ state, file });
      },
    );
    return result.acquired
      ? result.value
      : { outcome: "lock-busy", credentials: null };
  }

  async function read(): Promise<StoredCredentials | null> {
    const result = await readWithOverlay();
    if (result === null) return null;
    // Quarantine suppression: a pair whose conditional delete was requested but has not provably landed is NEVER served - to this process or, because every renderer read routes here, to any window.
    const quarantined = await readQuarantinedDigests(qPath);
    if (quarantined.has(digestToken(result.token))) return null;
    return result;
  }

  async function readWithOverlay(): Promise<StoredCredentials | null> {
    const file = await readCredentialsFile(paths.credentialsPath);
    const p = pending;
    if (p === null) return file;
    if (p.kind === "pair") {
      // Overlay only while disk still holds the exact base we spent past; a
      // sibling sign-out (file null) or rotation (token changed) self-corrects.
      return file !== null && file.token === p.expectedToken ? p.pair : file;
    }
    // firstWrite: overlay the minted pair only while the guarded snapshot still holds AND no sign-out / newer epoch has landed since.
    const snapshotHolds =
      p.expectedDigest === null
        ? file === null
        : file !== null && digestCredentials(file) === p.expectedDigest;
    if (!snapshotHolds) return file;
    const sidecar = await readSidecar(paths.metaPath);
    const blockedByTombstone =
      sidecar.kind === "malformed" ||
      (sidecar.kind === "present" &&
        (hasTombstone(sidecar.state) ||
          sidecar.state.epoch !== p.tombstoneEpoch));
    return blockedByTombstone ? file : p.credentials;
  }

  async function rotate(args: {
    readonly expectedUserId: string;
    readonly expectedToken: string;
    readonly refreshTokenOverride: string | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult> {
    return runMutation(
      args.signal,
      false,
      false,
      async ({ state, file }): Promise<MutationResult> => {
        // Guards before any spend (R7-C2).
        if (file === null) return { outcome: "deleted", credentials: null };
        // A committed/pending sign-out stands: an automatic rotate must never
        // resurrect it by spending (e.g. a raw writer recreated F after logout).
        if (hasTombstone(state)) {
          return { outcome: "tombstoned", credentials: null };
        }
        if (file.user.id !== args.expectedUserId) {
          return { outcome: "user-mismatch", credentials: file };
        }
        if (file.token !== args.expectedToken) {
          // A sibling already rotated: adopt the file's pair, spend nothing.
          return { outcome: "superseded", credentials: file };
        }
        const marker = await readSpentBaseMarker(paths.credentialsPath);
        if (marker !== null) {
          const blocked =
            marker.spentTokenDigest === digestToken(file.token) &&
            !isOwnSpentBaseMarker(marker) &&
            !markerOwnerProvablyDead(marker) &&
            markerIsFresh(marker, Date.now());
          if (blocked) {
            return { outcome: "spend-pending", credentials: null };
          }
          // Reclaimable - but do NOT unlink it here.
        }
        await writeSpentBaseMarker(paths.credentialsPath, file.token);
        const refreshToken = args.refreshTokenOverride ?? file.refreshToken;
        const refreshed = await refresh({
          token: file.token,
          refreshToken,
          signal: args.signal,
        });
        if (refreshed.kind === "network-error") {
          return { outcome: "refresh-network", credentials: null };
        }
        if (refreshed.kind === "rejected") {
          // The base is dead regardless of who spends it - nothing left for
          // the marker to protect.
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "refresh-rejected", credentials: null };
        }
        const next: StoredCredentials = {
          token: refreshed.token,
          refreshToken: refreshed.refreshToken,
          savedAt: nowIso(),
          user: file.user,
        };
        const commit = await commitMutation({
          paths: commitPaths,
          op: "rotate",
          target: { kind: "write", credentials: next },
          currentState: state,
        });
        if (commit.kind === "committed") {
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "applied", credentials: next };
        }
        // Post-spend local-commit failure: keep the minted pair active in memory and land it under a fresh lock later.
        pending = { kind: "pair", expectedToken: file.token, pair: next };
        scheduleContinuationRetry();
        return { outcome: "commit-failed", credentials: next };
      },
    );
  }

  async function signIn(
    credentials: StoredCredentials,
    preserveRefreshTokenIfBlank: boolean,
    signal: AbortSignal | null,
  ): Promise<MutationResult> {
    return runMutation(
      signal,
      true,
      false,
      async ({ state, file }): Promise<MutationResult> => {
        // Resolved under the same lock that performs the write: a caller that built `credentials` from a pre-lock read (or omits the refresh token entirely) never races a concurrent rotate for this decision.
        const resolved: StoredCredentials =
          credentials.refreshToken.length > 0 ||
          !preserveRefreshTokenIfBlank ||
          file === null ||
          file.user.id !== credentials.user.id
            ? credentials
            : { ...credentials, refreshToken: file.refreshToken };
        const commit = await commitMutation({
          paths: commitPaths,
          op: "signIn",
          target: { kind: "write", credentials: resolved },
          currentState: state,
        });
        if (commit.kind === "committed") {
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "applied", credentials: resolved };
        }
        return { outcome: "commit-failed", credentials: resolved };
      },
    );
  }

  async function signOut(signal: AbortSignal | null): Promise<MutationResult> {
    return runMutation(
      signal,
      true,
      false,
      async ({ state }): Promise<MutationResult> => {
        const commit = await commitMutation({
          paths: commitPaths,
          op: "signOut",
          target: { kind: "delete" },
          currentState: state,
        });
        // A failed explicit sign-out must surface and stay signed in (§5), never claim signed-out without the delete landing.
        if (commit.kind === "committed") {
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "deleted", credentials: null };
        }
        return { outcome: "commit-failed", credentials: null };
      },
    );
  }

  async function signOutIfToken(
    expectedToken: string,
    signal: AbortSignal | null,
  ): Promise<MutationResult> {
    return runMutation(
      signal,
      true,
      // The quarantine blocks SERVING and SPENDING, never the delete that
      // heals it - this op must see the quarantined pair to remove it.
      true,
      async ({ state, file }): Promise<MutationResult> => {
        const digest = digestToken(expectedToken);
        const quarantined = await readQuarantinedDigests(qPath);
        if (!quarantined.has(digest)) {
          quarantined.add(digest);
          await writeQuarantinedDigests(qPath, quarantined);
        }
        // The comparison lives under the same lock as the delete below: a sign-in that landed since the caller captured `expectedToken` is observed here and kept, never destroyed by the stale undo.
        if (file === null || file.token !== expectedToken) {
          quarantined.delete(digest);
          await writeQuarantinedDigests(qPath, quarantined);
          return { outcome: "superseded", credentials: file };
        }
        const commit = await commitMutation({
          paths: commitPaths,
          op: "signOut",
          target: { kind: "delete" },
          currentState: state,
        });
        // Same interactive-intent contract as `signOut`: a failed conditional delete surfaces (the stale pair is still durable and the caller must know - though the quarantine already stops every read from serving it), and a.
        if (commit.kind === "committed") {
          await clearSpentBaseMarker(paths.credentialsPath);
          quarantined.delete(digest);
          await writeQuarantinedDigests(qPath, quarantined);
          return { outcome: "deleted", credentials: null };
        }
        scheduleQuarantineRetry();
        return { outcome: "commit-failed", credentials: null };
      },
    );
  }

  async function drainQuarantine(signal: AbortSignal | null): Promise<boolean> {
    // Lock-free pre-check: the common case (nothing quarantined) must stay
    // free for the startup path that runs this before every first read.
    const preCheck = await readQuarantinedDigests(qPath);
    if (preCheck.size === 0) return true;
    const result = await runMutation(
      signal,
      true,
      true,
      async ({ state, file }): Promise<MutationResult> => {
        const quarantined = await readQuarantinedDigests(qPath);
        if (quarantined.size === 0) {
          return { outcome: "deleted", credentials: null };
        }
        if (file === null || !quarantined.has(digestToken(file.token))) {
          // Nothing quarantined is durable any more - every entry is
          // residue of a pair that was already replaced or removed.
          await writeQuarantinedDigests(qPath, new Set());
          return { outcome: "deleted", credentials: null };
        }
        const commit = await commitMutation({
          paths: commitPaths,
          op: "signOut",
          target: { kind: "delete" },
          currentState: state,
        });
        if (commit.kind === "committed") {
          await clearSpentBaseMarker(paths.credentialsPath);
          await writeQuarantinedDigests(qPath, new Set());
          return { outcome: "deleted", credentials: null };
        }
        return { outcome: "commit-failed", credentials: null };
      },
    );
    if (result.outcome === "deleted") return true;
    scheduleQuarantineRetry();
    return false;
  }

  async function updateProfile(args: {
    readonly expectedToken: string;
    readonly user: StoredCredentials["user"];
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult> {
    return runMutation(
      args.signal,
      false,
      false,
      async ({ state, file }): Promise<MutationResult> => {
        if (file === null) return { outcome: "deleted", credentials: null };
        // A committed/pending sign-out stands: the advisory profile merge must
        // not clear the tombstone and resurrect a signed-out session.
        if (hasTombstone(state)) {
          return { outcome: "tombstoned", credentials: null };
        }
        if (file.token !== args.expectedToken) {
          // A sibling rotated under us - skip the advisory profile write.
          return { outcome: "superseded", credentials: file };
        }
        const next: StoredCredentials = { ...file, user: args.user };
        const commit = await commitMutation({
          paths: commitPaths,
          op: "updateProfile",
          target: { kind: "write", credentials: next },
          currentState: state,
        });
        // The profile block is advisory; a commit failure is surfaced but arms no
        // continuation (nothing was spent, the token is unchanged).
        return commit.kind === "committed"
          ? { outcome: "applied", credentials: next }
          : { outcome: "commit-failed", credentials: next };
      },
    );
  }

  async function guardedSignIn(args: {
    readonly credentials: StoredCredentials;
    readonly expectedFile: StoredCredentials | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult> {
    const expectedDigest =
      args.expectedFile === null ? null : digestCredentials(args.expectedFile);
    return runMutation(
      args.signal,
      false,
      false,
      async ({ state, file }): Promise<MutationResult> => {
        // Never resurrect a signed-out session, and never overwrite a newer state.
        if (hasTombstone(state)) {
          return { outcome: "tombstoned", credentials: null };
        }
        const snapshotMatches =
          expectedDigest === null
            ? file === null
            : file !== null && digestCredentials(file) === expectedDigest;
        if (!snapshotMatches) {
          return { outcome: "superseded", credentials: file };
        }
        const commit = await commitMutation({
          paths: commitPaths,
          op: "signIn",
          target: { kind: "write", credentials: args.credentials },
          currentState: state,
        });
        if (commit.kind === "committed") {
          // Same rationale as `signIn`: a landed first-write replaces the
          // session wholesale, so any lingering marker is an orphan.
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "applied", credentials: args.credentials };
        }
        pending = {
          kind: "firstWrite",
          credentials: args.credentials,
          expectedDigest,
          tombstoneEpoch: state.epoch,
          spentBaseToken: null,
        };
        scheduleContinuationRetry();
        return { outcome: "commit-failed", credentials: args.credentials };
      },
    );
  }

  async function migrateFirstWrite(args: {
    readonly candidate: {
      readonly token: string;
      readonly refreshToken: string;
    };
    readonly identity: StoredCredentials["user"];
    readonly expectedFile: StoredCredentials | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult> {
    const expectedDigest =
      args.expectedFile === null ? null : digestCredentials(args.expectedFile);
    return runMutation(
      args.signal,
      false,
      false,
      async ({ state, file }): Promise<MutationResult> => {
        // Guards before the spend (R7-C2), identical to guardedSignIn: never
        // resurrect a signed-out session, never overwrite a newer state.
        if (hasTombstone(state)) {
          return { outcome: "tombstoned", credentials: null };
        }
        const snapshotMatches =
          expectedDigest === null
            ? file === null
            : file !== null && digestCredentials(file) === expectedDigest;
        if (!snapshotMatches) {
          return { outcome: "superseded", credentials: file };
        }
        const candidateDigest = digestToken(args.candidate.token);
        const marker = await readSpentBaseMarker(paths.credentialsPath);
        if (marker !== null) {
          const guardsLiveSpend =
            marker.spentTokenDigest === candidateDigest ||
            (file !== null &&
              marker.spentTokenDigest === digestToken(file.token));
          const blocked =
            guardsLiveSpend &&
            !isOwnSpentBaseMarker(marker) &&
            !markerOwnerProvablyDead(marker) &&
            markerIsFresh(marker, Date.now());
          if (blocked) {
            return { outcome: "spend-pending", credentials: null };
          }
          // Reclaimable - but do NOT unlink it here.
        }
        await writeSpentBaseMarker(paths.credentialsPath, args.candidate.token);
        // The sole remote call of the hold - every guard above has passed.
        const refreshed = await refresh({
          token: args.candidate.token,
          refreshToken: args.candidate.refreshToken,
          signal: args.signal,
        });
        if (refreshed.kind === "network-error") {
          return { outcome: "refresh-network", credentials: null };
        }
        if (refreshed.kind === "rejected") {
          // Dead regardless of who spends it - nothing left to guard.
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "refresh-rejected", credentials: null };
        }
        // Identity comes from the caller's pre-lock non-spending `/user` probe (invariant 2): the refresh response carries only the pair, so it cannot supply identity.
        const next: StoredCredentials = {
          token: refreshed.token,
          refreshToken: refreshed.refreshToken,
          savedAt: nowIso(),
          user: args.identity,
        };
        const commit = await commitMutation({
          paths: commitPaths,
          op: "signIn",
          target: { kind: "write", credentials: next },
          currentState: state,
        });
        if (commit.kind === "committed") {
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "applied", credentials: next };
        }
        // Post-spend local-commit failure: keep the minted pair and land it under a fresh lock later - the same first-write continuation guardedSignIn arms (a rotate-shaped retry cannot land against an absent F, R8-C2).
        pending = {
          kind: "firstWrite",
          credentials: next,
          expectedDigest,
          tombstoneEpoch: state.epoch,
          spentBaseToken: args.candidate.token,
        };
        scheduleContinuationRetry();
        return { outcome: "commit-failed", credentials: next };
      },
    );
  }

  return {
    read,
    rotate,
    signIn,
    signOut,
    signOutIfToken,
    drainQuarantine,
    updateProfile,
    guardedSignIn,
    migrateFirstWrite,
    hasPendingContinuation: () => pending !== null,
    dispose: () => {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (quarantineRetryTimer !== null) {
        clearTimeout(quarantineRetryTimer);
        quarantineRetryTimer = null;
      }
    },
  };
}

function pendingCredentials(p: PendingContinuation): StoredCredentials {
  return p.kind === "pair" ? p.pair : p.credentials;
}

function nowIso(): string {
  return new Date().toISOString();
}
