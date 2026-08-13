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

/**
 * The cross-process credentials mutation store (credentials-file token-store
 * tech plan, §2) - the stateful core shared by the desktop main process, the
 * CLI, and migration. It ties the lock, the WAL sidecar, and the file
 * primitives into the intents and typed outcomes the callers act on.
 *
 * Governing rule: **any operation that can spend a single-use refresh token runs
 * inside the lock, with every guard evaluated before the spend, immediately
 * followed by the commit** - so at most one process ever spends a given refresh
 * token. The HTTP refresh itself is injected (`RefreshFn`) so this module stays
 * dependency-light; the desktop/CLI supply the one-shot abortable helper.
 *
 * Every locked operation runs the same preamble under the lock: WAL recovery of
 * any interrupted mutation, then resolution of this process's own outstanding
 * commit-failed continuation (the R9 first-gate rule - a rotate that skipped
 * this would raw-CAS against its own spent base and adopt it back), then the
 * intent against the freshly-read state.
 */
export interface CredentialsMutationPaths {
  readonly credentialsPath: string;
  readonly metaPath: string;
  readonly lockPath: string;
}

/**
 * Injected single-attempt refresh. Mirrors the shared `AuthTokenRefreshResult`
 * shape; never throws (every failure maps to a kind). The store calls it as the
 * last fallible-remote step under the lock, honoring the abort signal.
 *
 * The refresh ENDPOINT is deliberately absent from these args: the store knows
 * only the file, and the file carries no authn URL — the injected fn must close
 * over the caller's own configured authn base URL. That inversion is what keeps
 * a pair minted by one dev-desktop slot refreshable from every other slot (each
 * refreshes against its own live local authn), instead of every process chasing
 * whichever stack happened to sign in last.
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

/**
 * The typed result of a mutation. `credentials` carries:
 *   - `applied`       -> the newly-committed pair;
 *   - `superseded`    -> the file pair the caller should adopt instead;
 *   - `user-mismatch` -> the foreign file pair (for the reconcile worker);
 *   - `commit-failed` -> the minted pair the caller keeps active in memory;
 * and is `null` for `deleted`/`tombstoned`/`lock-busy`/`spend-pending`/
 * `refresh-rejected`/`refresh-network`.
 *
 * `spend-pending` is transient, exactly like `lock-busy`: a SIBLING process
 * spent the on-disk refresh token but has not landed the successor pair yet
 * (its local commit failed; its in-process continuation is retrying). Spending
 * the same base again would be a server-side reuse - with rotation-replay
 * controls live that reads as credential theft and can kill the whole refresh
 * family - so the intent defers instead. The caller retries later; by then the
 * sibling has landed (adopt via `superseded`) or its marker has aged out.
 */
export interface MutationResult {
  readonly outcome: MutationOutcome;
  readonly credentials: StoredCredentials | null;
}

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
   * Current credentials with a process-local overlay: while a commit-failed
   * continuation is outstanding, this process never sees its own spent base on
   * disk - it sees the minted pair it is still trying to land. Never locks.
   */
  read(): Promise<StoredCredentials | null>;
  /** Locked adopt-or-refresh+commit. `refreshTokenOverride` lets migration spend a candidate refresh token. */
  rotate(args: {
    readonly expectedUserId: string;
    readonly expectedToken: string;
    readonly refreshTokenOverride: string | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  /**
   * Interactive create/replace; clears the tombstone. Unconditional except for
   * the refresh token: when `credentials.refreshToken` is blank AND
   * `preserveRefreshTokenIfBlank` is true, the on-disk refresh token (read
   * fresh under this same lock) is carried over instead of being clobbered to
   * "" - closing the TOCTOU a caller would otherwise have if it read the
   * current file before acquiring the lock to build `credentials`.
   */
  signIn(
    credentials: StoredCredentials,
    preserveRefreshTokenIfBlank: boolean,
    signal: AbortSignal | null,
  ): Promise<MutationResult>;
  /** Delete under the lock (ENOENT-tolerant); always advances the tombstone. */
  signOut(signal: AbortSignal | null): Promise<MutationResult>;
  /** CAS'd merge of the `user` block only; tokens untouched. */
  updateProfile(args: {
    readonly expectedToken: string;
    readonly user: StoredCredentials["user"];
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  /**
   * Migration first-write of a known pair (§6 step 4 continuation shape): guarded
   * by the file snapshot + tombstone/epoch, so a sign-out or newer state wins. On
   * commit-failure the pair is retained and retried under a fresh lock.
   */
  guardedSignIn(args: {
    readonly credentials: StoredCredentials;
    readonly expectedFile: StoredCredentials | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  /**
   * Migration first-write that must SPEND a candidate refresh token first (§6
   * step 4, F absent/invalid). Guards before the spend (tombstone / file
   * snapshot / spent-base marker - a sibling slot migrating the same legacy
   * pair defers with `spend-pending`), then spends `candidate.refreshToken`
   * under its own armed marker and commits the refreshed pair stamped with the
   * pre-validated `identity`. `refresh-rejected` → caller maps to
   * terminal-dead; commit failure arms the same first-write continuation
   * `guardedSignIn` uses, with the marker held until it lands or drops.
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

// Process-local commit-failed continuation - the only in-memory persisted
// authority, never written to disk (that on-disk overlay was the condemned
// round-4 design). Set only by rotate (a spent base exists) and guardedSignIn
// (migration first-write); interactive signIn/signOut surface the error instead.
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
      /**
       * Access token keying the on-disk spent-base marker this continuation is
       * still guarding: the migration candidate whose refresh token was spent
       * (`migrateFirstWrite`), or `null` when nothing was spent
       * (`guardedSignIn`). Cleared with the continuation on land or drop.
       */
      readonly spentBaseToken: string | null;
    };

/**
 * The spent-base marker - the cross-PROCESS complement of the in-memory
 * commit-failed continuation. The continuation (below) is deliberately never
 * written to disk, so without a marker a SIBLING process reading a spent base
 * off disk would pass the CAS guard and spend the same refresh token a second
 * time - server-side reuse, which rotation-replay controls read as credential
 * theft (and can kill the whole refresh family).
 *
 * Lifecycle: armed under the lock IMMEDIATELY BEFORE the refresh spend (an
 * intent record, so a crash at ANY point between spend and commit still
 * leaves the base guarded), and cleared on every locally-settled outcome - a
 * landed commit, an explicit `rejected` (the base is dead anyway), a landed
 * or abandoned continuation, or a landed sign-in/sign-out. It deliberately
 * SURVIVES a `network-error` refresh: whether that request spent the base
 * server-side is unknowable, so siblings stay deferred while the owner (who
 * recognizes its own marker) retries.
 *
 * The record carries ONLY a sha256 digest of the base's access token plus the
 * owner's pid + start-time fingerprint - no secret material, nothing
 * replayable. It lives in its own file (not a new `credentials.meta.json`
 * key) because older builds' strict sidecar parsers would read an unknown key
 * as malformed and fail automatic mutations closed; an extra sibling file is
 * invisible to them.
 *
 * Unblocking mirrors the lock's holder-liveness rules exactly: a marker whose
 * owner is provably dead (pid gone, or start-time fingerprint mismatch) is
 * reclaimed immediately. `SPENT_BASE_MARKER_TTL_MS` then bounds EVERY other
 * hold - including one whose owner is positively confirmed alive. That is
 * deliberate, not an oversight: a live owner can stop retrying without ever
 * releasing its marker (`dispose()` drops the continuation retry timer and
 * leaves the file behind; a dropped continuation does the same), so a hold
 * that liveness alone could extend would block every sibling of a still-running
 * process forever - the permanent sticky signed-out this store exists to kill.
 * Reclaiming risks at most one server-side replay/reject of an already-spent
 * base - strictly better than both the unconditional sibling re-spend it
 * replaces and an unbounded wait on an owner that may never come back.
 *
 * Known residual (client-side bound): after a network-AMBIGUOUS refresh the
 * OWNER's own retry re-presents the base - the only client-side recovery
 * (refusing forever guarantees the forced re-login the retry merely risks).
 * Within authn's replay grace that re-present adopts the already-minted
 * successor; past it, prod replay controls may kill the family. Fully closing
 * this needs a server-side durable per-base successor, not more client state.
 */
interface SpentBaseMarker {
  readonly spentTokenDigest: string;
  readonly at: string;
  readonly ownerPid: number;
  readonly ownerFingerprint: string | null;
}

const SPENT_BASE_MARKER_TTL_MS = 60_000;

/**
 * Exported so tests assert against the path production actually writes. A test
 * that rebuilds this suffix locally keeps passing if the suffix ever changes -
 * every "the marker was cleared" assertion would then hold vacuously against a
 * path nothing ever wrote.
 */
export function spentBaseMarkerPath(credentialsPath: string): string {
  return `${credentialsPath}.pending-spend.json`;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Absent and malformed both read as "no marker": the marker is written BEFORE
 * the refresh spend, so a torn record (crash mid-write) proves the spend never
 * happened - there is nothing left to guard. An I/O fault (EACCES/EIO/...)
 * proves nothing about the marker's content, so it fails CLOSED - spending
 * past an unreadable marker could re-spend a sibling's in-flight base.
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
  // Liveness dominates freshness: a future `at` (a backward clock step landed
  // between the owner's write and this read) clamps to age 0 - fully fresh -
  // rather than reading as stale. Stale would reclaim a marker whose owner may
  // be alive MID-SPEND and re-spend its base. The extra block a clamp can add
  // is bounded by the step size plus the TTL, and a dead owner is still
  // reclaimed immediately by the liveness probe regardless of age.
  return Math.max(0, nowMs - atMs) < SPENT_BASE_MARKER_TTL_MS;
}

/** This process armed the marker. A live pid is unique, so a pid match while
 *  we are running means us; the fingerprint only tightens the recycled-pid
 *  case (where a mismatch is ALSO caught by the provably-dead probe). */
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
 * Fail-closed arm, run BEFORE the spend. The marker lives beside the
 * credentials file, so a failed write here is the cheapest proof that the
 * post-spend credentials commit would likely fail too - which is exactly the
 * commit-failed double-spend window the marker exists to close. Refusing to
 * spend (a store-unavailable the caller retries) is strictly safer than
 * spending unguarded into a store that cannot record the spend.
 *
 * ATOMIC (temp + rename), and it overwrites in place rather than being
 * preceded by an unlink. Both matter for the same reason: a marker that is
 * momentarily absent or torn reads as "no marker", and a sibling that acquires
 * the lock in that state re-spends the base. An in-place truncating write
 * leaves a torn record if the process dies mid-write; an unlink-then-write
 * leaves NO record at all in the gap. The rename makes replacement a single
 * step - readers see either the old marker or the new one, never neither.
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
    await writeJsonFileAtomic(spentBaseMarkerPath(credentialsPath), marker, 0o600);
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
  let disposed = false;

  /**
   * Clear the spent-base marker ONLY if it still names `spentToken`'s digest.
   * Runs under the lock. Guarded so a process resolving a long-abandoned
   * continuation can never clobber a NEWER marker a sibling wrote for a later
   * base (that marker still protects a live pending spend).
   */
  async function clearOwnSpentBaseMarker(spentToken: string): Promise<void> {
    const marker = await readSpentBaseMarker(paths.credentialsPath);
    if (marker !== null && marker.spentTokenDigest === digestToken(spentToken)) {
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

  // Drive the outstanding commit-failed continuation to resolution. Runs under
  // the lock, as the FIRST gate of every locked operation, so a subsequent
  // intent proceeds against committed state instead of the spent base.
  async function resolveContinuationLocked(
    state: SidecarState,
  ): Promise<SidecarState> {
    const p = pending;
    if (p === null) return state;
    const file = await readCredentialsFile(paths.credentialsPath);

    if (p.kind === "pair") {
      // Sign-out won, a sibling rotated, or the account switched -> drop the
      // pending pair and defer to disk (adopt on the next read). The marker
      // for OUR spent base is released with it: the base it guarded is no
      // longer on disk, so there is nothing left to protect.
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

    // firstWrite: a sign-out (committed or pending) or any newer state wins. The
    // snapshot guard is a full-file digest, not just the token, so a same-token
    // content change (e.g. a sibling profile merge) is also treated as newer.
    // Land or drop, the marker guarding a spent migration candidate (if any)
    // is released with the continuation - mirroring the pair branch above.
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
      // Best-effort background retry: a transient fault (or a disposed store /
      // vanished file during shutdown) must never surface as an unhandled
      // rejection. The next scheduled attempt re-drives it.
    }
    if (pending !== null && !disposed) scheduleContinuationRetry();
  }

  // Every mutating intent runs under the lock with the same preamble: WAL
  // recovery, then resolution of this process's own outstanding commit-failed
  // continuation. If that continuation is STILL unresolved afterwards, the disk
  // holds a spent base (or a stale first-write snapshot) - running the intent
  // would guard/CAS against it, re-adopting the spent base or re-spending its
  // refresh family (the R9 first-gate). So the intent is refused with
  // commit-failed, carrying the pair the store is still trying to land, until
  // the continuation clears.
  //
  // CALLER CONTRACT: that carried pair is this store's *process-wide* pending
  // continuation. In a shared main-process store (multiple renderer windows over
  // one file) it may belong to a DIFFERENT user than the current caller, and
  // this generic gate cannot know the caller's identity without short-circuiting
  // the per-intent user-mismatch guard. A caller binding a `commit-failed` pair
  // to a live session MUST first check `pair.user.id` against its own expected
  // identity (enforced renderer-side in AuthService.applyLiveRotateOutcome).
  async function runMutation(
    signal: AbortSignal | null,
    interactive: boolean,
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
        const file = await readCredentialsFile(paths.credentialsPath);
        return body({ state, file });
      },
    );
    return result.acquired
      ? result.value
      : { outcome: "lock-busy", credentials: null };
  }

  async function read(): Promise<StoredCredentials | null> {
    const file = await readCredentialsFile(paths.credentialsPath);
    const p = pending;
    if (p === null) return file;
    if (p.kind === "pair") {
      // Overlay only while disk still holds the exact base we spent past; a
      // sibling sign-out (file null) or rotation (token changed) self-corrects.
      return file !== null && file.token === p.expectedToken ? p.pair : file;
    }
    // firstWrite: overlay the minted pair only while the guarded snapshot still
    // holds AND no sign-out / newer epoch has landed since. `file === null`
    // collides with a sibling sign-out, so a lock-free sidecar read gates the
    // overlay - otherwise a logged-out session could be ghosted back in.
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
        // Cross-process spent-base gate (before the spend, like every other
        // guard): a live sibling armed a marker for THIS base - it spent (or
        // may have spent) the refresh token and has not landed the successor
        // yet. Spending it again would be a server-side reuse, so defer. Our
        // own residue, an orphan for a superseded base, a provably-dead
        // owner's marker, or an aged-out one is reclaimed instead.
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
          // Reclaimable - but do NOT unlink it here. The arm below replaces it
          // atomically, and unlinking first would leave the base momentarily
          // unguarded: if this process dies in that gap - and the marker we are
          // reclaiming is OUR OWN residue from a network-ambiguous attempt, so
          // the base may already be spent - a sibling takes the lock, sees no
          // marker, and spends it again.
        }
        // Arm the marker BEFORE the spend (an intent record): a crash at any
        // point past the refresh call leaves the base guarded on disk, a
        // network-ambiguous refresh (below) keeps it armed on purpose, and a
        // failed arm throws store-unavailable with nothing yet spent.
        //
        // Keyed by the BASE PAIR's access token - not the token handed to
        // `refresh` - because that is the one value a deferring sibling can
        // compare against its own read of the file (the gate above). In the
        // migration-override case the spend still replaces THIS base pair, so
        // the gate serializes every competitor either way; keying on the
        // override token would make siblings read the marker as an orphan.
        await writeSpentBaseMarker(paths.credentialsPath, file.token);
        const refreshToken = args.refreshTokenOverride ?? file.refreshToken;
        const refreshed = await refresh({
          token: file.token,
          refreshToken,
          signal: args.signal,
        });
        if (refreshed.kind === "network-error") {
          // Whether the request spent the base server-side is unknowable, so
          // the marker deliberately stays armed: siblings defer while this
          // process (which recognizes its own marker) retries.
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
        // Post-spend local-commit failure: keep the minted pair active in
        // memory and land it under a fresh lock later. The armed marker is
        // what stops a SIBLING process from re-spending the base this
        // process just burned.
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
      async ({ state, file }): Promise<MutationResult> => {
        // Resolved under the same lock that performs the write: a caller that
        // built `credentials` from a pre-lock read (or omits the refresh token
        // entirely) never races a concurrent rotate for this decision. Only
        // preserve across a SAME-user re-seed - the on-disk pair may belong to
        // a different account than the one just validated, and pairing a
        // foreign refresh token with this identity would corrupt later rotation.
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
        // Interactive intent: on a persistent local failure the caller surfaces
        // the error and the user retries - the device-flow pair is re-obtainable,
        // so no background continuation is armed. A landed sign-in replaces the
        // session wholesale, so any spent-base marker is an orphan - clear it
        // rather than leave it to lazy cleanup.
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
      async ({ state }): Promise<MutationResult> => {
        const commit = await commitMutation({
          paths: commitPaths,
          op: "signOut",
          target: { kind: "delete" },
          currentState: state,
        });
        // A failed explicit sign-out must surface and stay signed in (§5), never
        // claim signed-out without the delete landing. A landed sign-out deletes
        // the file the marker was guarding - remove the marker with it.
        if (commit.kind === "committed") {
          await clearSpentBaseMarker(paths.credentialsPath);
          return { outcome: "deleted", credentials: null };
        }
        return { outcome: "commit-failed", credentials: null };
      },
    );
  }

  async function updateProfile(args: {
    readonly expectedToken: string;
    readonly user: StoredCredentials["user"];
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult> {
    return runMutation(
      args.signal,
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
      async ({ state, file }): Promise<MutationResult> => {
        // Never resurrect a signed-out session, and never overwrite a newer
        // state. The snapshot guard is a full-file digest, so a same-token
        // content change (e.g. a sibling profile merge) still supersedes.
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
        // Cross-process spent-base gate + arm, mirroring `rotate`: on upgrade
        // every slot migrates the SAME legacy pair, and the first-write
        // continuation is process-local - it proves nothing to a sibling. The
        // migration marker is keyed by the CANDIDATE's access token (the one
        // value every competing migrator derives from the same legacy source);
        // a marker for the file's base pair also defers us, letting the
        // sibling's in-flight rotate land before the snapshot guard re-judges.
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
          // Reclaimable - but do NOT unlink it here. The arm below replaces it
          // atomically, and unlinking first would leave the base momentarily
          // unguarded: if this process dies in that gap - and the marker we are
          // reclaiming is OUR OWN residue from a network-ambiguous attempt, so
          // the base may already be spent - a sibling takes the lock, sees no
          // marker, and spends it again.
        }
        await writeSpentBaseMarker(paths.credentialsPath, args.candidate.token);
        // The sole remote call of the hold - every guard above has passed. A
        // rejected candidate is the migration's `terminal-dead` signal. A
        // network failure is AMBIGUOUS - a lost response may have consumed the
        // candidate server-side - so the marker stays armed while the caller
        // re-enters, keeping sibling migrators deferred.
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
        // Identity comes from the caller's pre-lock non-spending `/user` probe
        // (invariant 2): the refresh response carries only the pair, so it cannot
        // supply identity.
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
        // Post-spend local-commit failure: keep the minted pair and land it under
        // a fresh lock later - the same first-write continuation guardedSignIn
        // arms (a rotate-shaped retry cannot land against an absent F, R8-C2).
        // The armed marker keeps sibling migrators off the spent candidate
        // until the continuation lands or drops.
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
    },
  };
}

function pendingCredentials(p: PendingContinuation): StoredCredentials {
  return p.kind === "pair" ? p.pair : p.credentials;
}

function nowIso(): string {
  return new Date().toISOString();
}
