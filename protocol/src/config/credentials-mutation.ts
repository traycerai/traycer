import { readCredentialsFile, type StoredCredentials } from "./credentials";
import { fileMtimeMsOrZero } from "./credentials-fs";
import { withCredentialsLock } from "./credentials-lock";
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
  readonly authnBaseUrl: string;
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
  | "refresh-rejected"
  | "refresh-network"
  | "commit-failed";

/**
 * The typed result of a mutation. `credentials` carries:
 *   - `applied`       -> the newly-committed pair;
 *   - `superseded`    -> the file pair the caller should adopt instead;
 *   - `user-mismatch` -> the foreign file pair (for the reconcile worker);
 *   - `commit-failed` -> the minted pair the caller keeps active in memory;
 * and is `null` for `deleted`/`tombstoned`/`lock-busy`/`refresh-rejected`/
 * `refresh-network`.
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
   * snapshot), then spends `candidate.refreshToken` and commits the refreshed
   * pair stamped with the pre-validated `identity`. `refresh-rejected` → caller
   * maps to terminal-dead; commit failure arms the same first-write continuation
   * `guardedSignIn` uses.
   */
  migrateFirstWrite(args: {
    readonly candidate: {
      readonly token: string;
      readonly refreshToken: string;
      readonly authnBaseUrl: string;
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
    };

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
      // pending pair and defer to disk (adopt on the next read).
      if (
        file === null ||
        file.user.id !== p.pair.user.id ||
        file.token !== p.expectedToken
      ) {
        pending = null;
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
        return commit.state;
      }
      return state; // still failing -> keep pending, retry later
    }

    // firstWrite: a sign-out (committed or pending) or any newer state wins. The
    // snapshot guard is a full-file digest, not just the token, so a same-token
    // content change (e.g. a sibling profile merge) is also treated as newer.
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
        const refreshToken = args.refreshTokenOverride ?? file.refreshToken;
        const refreshed = await refresh({
          authnBaseUrl: file.authnBaseUrl,
          token: file.token,
          refreshToken,
          signal: args.signal,
        });
        if (refreshed.kind === "network-error") {
          return { outcome: "refresh-network", credentials: null };
        }
        if (refreshed.kind === "rejected") {
          return { outcome: "refresh-rejected", credentials: null };
        }
        const next: StoredCredentials = {
          token: refreshed.token,
          refreshToken: refreshed.refreshToken,
          authnBaseUrl: file.authnBaseUrl,
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
          return { outcome: "applied", credentials: next };
        }
        // Post-spend local-commit failure: keep the minted pair active in memory
        // and land it under a fresh lock later.
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
        // so no background continuation is armed.
        return commit.kind === "committed"
          ? { outcome: "applied", credentials: resolved }
          : { outcome: "commit-failed", credentials: resolved };
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
        // claim signed-out without the delete landing.
        return commit.kind === "committed"
          ? { outcome: "deleted", credentials: null }
          : { outcome: "commit-failed", credentials: null };
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
          return { outcome: "applied", credentials: args.credentials };
        }
        pending = {
          kind: "firstWrite",
          credentials: args.credentials,
          expectedDigest,
          tombstoneEpoch: state.epoch,
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
      readonly authnBaseUrl: string;
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
        // The sole remote call of the hold - every guard above has passed. A
        // rejected candidate is the migration's `terminal-dead` signal; a network
        // failure spent nothing (the caller re-enters).
        const refreshed = await refresh({
          authnBaseUrl: args.candidate.authnBaseUrl,
          token: args.candidate.token,
          refreshToken: args.candidate.refreshToken,
          signal: args.signal,
        });
        if (refreshed.kind === "network-error") {
          return { outcome: "refresh-network", credentials: null };
        }
        if (refreshed.kind === "rejected") {
          return { outcome: "refresh-rejected", credentials: null };
        }
        // Identity comes from the caller's pre-lock non-spending `/user` probe
        // (invariant 2): the refresh response carries only the pair, so it cannot
        // supply identity. `authnBaseUrl` is the candidate's (main's config).
        const next: StoredCredentials = {
          token: refreshed.token,
          refreshToken: refreshed.refreshToken,
          authnBaseUrl: args.candidate.authnBaseUrl,
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
          return { outcome: "applied", credentials: next };
        }
        // Post-spend local-commit failure: keep the minted pair and land it under
        // a fresh lock later - the same first-write continuation guardedSignIn
        // arms (a rotate-shaped retry cannot land against an absent F, R8-C2).
        pending = {
          kind: "firstWrite",
          credentials: next,
          expectedDigest,
          tombstoneEpoch: state.epoch,
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
