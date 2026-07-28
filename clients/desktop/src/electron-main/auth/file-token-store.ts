import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type {
  CredentialsMigrationOutcome,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import {
  refreshOnceAbortable,
  validateAuthTokenIdentityAccessOnceAbortable,
} from "@traycer-clients/shared/auth/auth-validation";
import type { Environment } from "@traycer/protocol/config/paths";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import { readCredentialsFile } from "@traycer/protocol/config/credentials";
import {
  createCredentialsMutationStore,
  type CredentialsMutationStore,
} from "@traycer/protocol/config/credentials-mutation";
import { runInitGate } from "@traycer/protocol/config/credentials-wal";
import { runLegacyCredentialsMigration } from "./credentials-migration";
import { describeLogError, log } from "../app/logger";

/**
 * Main-process owner of the single machine-local credentials file
 * (`~/.traycer/cli/<env>/credentials`), the store half of the credentials-file
 * token-store tech plan (§3 + §4). It wraps the cross-process mutation store
 * (§2) — lock + WAL + typed outcomes — and injects the one-shot abortable
 * refresh, so every token *spend* runs inside the file lock, immediately
 * followed by its commit. The renderer reaches this through the token-store
 * IPC channels; the host reads the same file independently to pin its owner
 * gate.
 *
 * The path is ENV-scoped (never slot-scoped): all `make dev-desktop` slots and
 * the CLI share one file per environment, which is the whole point — sign in
 * once, signed in everywhere. `authnBaseUrl` is stamped here (from this
 * process's config) on interactive sign-in, so the renderer can never write a
 * mismatched authn origin into the shared file.
 *
 * §4 owns the file watcher: directory watch + basename filter, debounced
 * revisioned `TokenStoreChange` fan-out (external writes AND self-writes).
 * Reconcile never writes/spends, so self-write echoes are fine (sibling
 * windows adopt; origin re-reads to the same state).
 */
export interface FileTokenStoreOptions {
  readonly environment: Environment;
  readonly authnBaseUrl: string;
}

type ChangeListener = (change: TokenStoreChange) => void;

// Lock hold time includes at most one bounded in-lock refresh (~10s, see
// `refreshOnceAbortable`); a competing mutation (e.g. a sign-out click) must be
// able to wait that out rather than fail, so the wait budget sits just above it.
const LOCK_WAIT_MS = 12_000;
const LOCK_POLL_INTERVAL_MS = 50;
// Backoff before a background retry of an outstanding commit-failed continuation.
const CONTINUATION_RETRY_MS = 1_000;
// Bounded so a live lock holder can never block startup: the gate is a
// best-effort head start on WAL recovery; each mutation still self-recovers at
// its own lock acquisition.
const INIT_GATE_WAIT_MS = 2_000;
// Collapse FS event bursts (rename + rename of .tmp, multi-process writers) to
// one revisioned emit.
const WATCHER_DEBOUNCE_MS = 50;
// §6 migration: overall abort deadline threaded through the probes, lock waits,
// and the in-lock refresh. Set above one healthy probe + one refresh timeout
// (~10s each is the inner bound) so a slow-but-alive rotate finishes on its own
// network timeout instead of being cut into the post-dispatch response-loss
// window; a truly black-hole network trips it → `retryable`, and start()
// proceeds against F.
const MIGRATION_DEADLINE_MS = 15_000;
// Bounded re-entry for superseded / mid-flight state changes (§6).
const MIGRATION_MAX_ATTEMPTS = 3;

export class FileTokenStore {
  private readonly store: CredentialsMutationStore;
  private readonly authnBaseUrl: string;
  private readonly credentialsPath: string;
  private readonly credentialsDir: string;
  private readonly credentialsBasename: string;
  private readonly listeners = new Set<ChangeListener>();
  // In-process serialization of the owning-store mutations. The file lock is the
  // real cross-process guarantee (§3); this just keeps a single main process
  // from racing two of its own mutations onto the same lock.
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  // Bounded store-init recovery (WAL finish/rollback). `get()` awaits this so a
  // cold-start rehydration never observes a mid-sign-out ghost credential that
  // recovery is about to delete. Mutations still self-recover at lock acquisition.
  private readonly recoveryGate: Promise<void>;
  // Monotonic emit counter for TokenStoreChange (dedup / WindowsBridge fence).
  private revision = 0;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  // §6 single-flight: every window reads the same shared localStorage pair, so
  // the first migration call drives it and all concurrent/later calls adopt the
  // same result (retained for the process lifetime; a `retryable` outcome
  // re-migrates on the NEXT launch, which is a fresh process).
  private migrationInFlight: Promise<CredentialsMigrationOutcome> | null = null;

  constructor(options: FileTokenStoreOptions) {
    this.authnBaseUrl = options.authnBaseUrl;
    const credentialsPath = cliCredentialsPath(options.environment);
    this.credentialsPath = credentialsPath;
    this.credentialsDir = dirname(credentialsPath);
    this.credentialsBasename = basename(credentialsPath);
    const lockPath = `${credentialsPath}.lock`;
    const metaPath = `${credentialsPath}.meta.json`;
    this.store = createCredentialsMutationStore({
      paths: { credentialsPath, metaPath, lockPath },
      refresh: refreshOnceAbortable,
      lockWaitMs: LOCK_WAIT_MS,
      lockPollIntervalMs: LOCK_POLL_INTERVAL_MS,
      continuationRetryMs: CONTINUATION_RETRY_MS,
    });
    // Kick the gate immediately; do not block the constructor / IPC install.
    // The first `get()` (and every subsequent one — a settled promise is free)
    // awaits completion so the initial auth check reflects recovered state.
    this.recoveryGate = this.runRecoveryGate({
      credentialsPath,
      metaPath,
      lockPath,
    });
    // Watcher is independent of the recovery gate: watching the dir tolerates a
    // missing file, and must never block startup.
    this.installWatcher();
  }

  private async runRecoveryGate(paths: {
    readonly credentialsPath: string;
    readonly metaPath: string;
    readonly lockPath: string;
  }): Promise<void> {
    try {
      const result = await runInitGate({
        paths: {
          credentialsPath: paths.credentialsPath,
          metaPath: paths.metaPath,
        },
        lockPath: paths.lockPath,
        waitMs: INIT_GATE_WAIT_MS,
        pollIntervalMs: LOCK_POLL_INTERVAL_MS,
      });
      log.debug("[file-token-store] init recovery gate", { result });
    } catch (error) {
      log.warn("[file-token-store] init recovery gate failed", {
        error: describeLogError(error),
      });
    }
  }

  /**
   * Directory watch + basename filter (same pattern as host-lifecycle pid
   * metadata watcher). More reliable than watching the file path itself, which
   * drops when the file is deleted and recreated.
   */
  private installWatcher(): void {
    if (this.disposed || this.watcher !== null) {
      return;
    }
    try {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      log.warn(
        "[file-token-store] unable to ensure credentials dir for watch",
        {
          error: describeLogError(error),
        },
      );
      return;
    }
    try {
      const watcher = watch(this.credentialsDir, (_event, filename) => {
        if (filename === null) {
          this.scheduleEmitChange();
          return;
        }
        if (
          typeof filename === "string" &&
          filename === this.credentialsBasename
        ) {
          this.scheduleEmitChange();
        }
      });
      watcher.on("error", (err) => {
        // Null the reference so a later reinstall path can recover. Without
        // this, an FSEvents stream-reset leaves `watcher` non-null but inert
        // for the rest of the process lifetime (host-lifecycle pattern).
        log.warn("[file-token-store] credentials watcher error", {
          error: describeLogError(err),
        });
        if (this.watcher === watcher) {
          this.watcher = null;
        }
      });
      this.watcher = watcher;
    } catch (error) {
      log.warn("[file-token-store] unable to install credentials watcher", {
        error: describeLogError(error),
      });
    }
  }

  private scheduleEmitChange(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.emitChange();
    }, WATCHER_DEBOUNCE_MS);
  }

  private async emitChange(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let file: StoredCredentials | null;
    try {
      file = await readCredentialsFile(this.credentialsPath);
    } catch (error) {
      log.warn("[file-token-store] credentials read after watch event failed", {
        error: describeLogError(error),
      });
      return;
    }
    if (this.disposed) {
      return;
    }
    this.revision += 1;
    const change: TokenStoreChange = {
      present: file !== null,
      userId: file?.user.id ?? null,
      revision: this.revision,
    };
    for (const listener of this.listeners) {
      listener(change);
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Current credentials (with the store's process-local commit-failed overlay),
   * or `null` when signed out. Never locks. Awaits the bounded init recovery
   * gate first so a cold-start rehydration cannot race a mid-sign-out WAL
   * completion (ghost sign-in). Rejects on a genuine I/O fault (EACCES, EIO, …);
   * the renderer maps that to a UI-only signed-out state and never a write.
   */
  get(): Promise<StoredCredentials | null> {
    return this.recoveryGate.then(() => this.store.read());
  }

  /**
   * Interactive create/replace — the device-flow sign-in. The renderer supplies
   * only the freshly-minted pair and the validated identity; this process stamps
   * the env-scoped `authnBaseUrl` and `savedAt`. Rejects on a non-`applied`
   * outcome (a persistent local failure) so the sign-in surfaces as failed
   * rather than a signed-in state the next launch cannot rehydrate.
   */
  signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void> {
    return this.enqueue(async () => {
      const credentials: StoredCredentials = {
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        authnBaseUrl: this.authnBaseUrl,
        savedAt: new Date().toISOString(),
        user: identity,
      };
      const result = await this.store.signIn(credentials, false, null);
      if (result.outcome !== "applied") {
        throw new Error(`credentials sign-in did not apply: ${result.outcome}`);
      }
    });
  }

  /**
   * The locked adopt-or-refresh+commit. The refresh HTTP spend happens here, in
   * main, inside the file lock — so at most one process ever spends a given
   * refresh token. Returns the typed outcome + the pair the caller should act on.
   */
  rotate(expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult> {
    return this.enqueue(async () => {
      const result = await this.store.rotate({
        expectedUserId: expected.userId,
        expectedToken: expected.token,
        refreshTokenOverride: null,
        signal: null,
      });
      return { outcome: result.outcome, pair: result.credentials };
    });
  }

  /**
   * Sign-out delete. Reachable only from `AuthService.signOut()` / `traycer
   * logout` per the governing principle (only explicit user intent destroys the
   * shared file). Rejects if the delete cannot land, so a failed sign-out stays
   * signed in rather than falsely reporting success.
   */
  delete(): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.store.signOut(null);
      if (result.outcome !== "deleted") {
        throw new Error(`credentials sign-out did not land: ${result.outcome}`);
      }
    });
  }

  /**
   * Change subscription. The owned watcher (§4) fires revisioned
   * `TokenStoreChange` events for external and self-writes; consumers re-read
   * the store (disk is the truth). Reconcile never writes/spends.
   */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * One-time legacy→file credentials migration (§6). The renderer reads and
   * decrypts the legacy per-window localStorage token pair and hands it here;
   * this single-flights the reconcile across windows and NEVER deletes the file.
   * The caller wipes the legacy slots per `shouldWipeLegacyCredentials(outcome)`
   * and then runs its normal file rehydrate — the file, not this outcome,
   * establishes the resulting session.
   */
  migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    if (this.migrationInFlight === null) {
      const run = this.runMigration(legacy);
      this.migrationInFlight = run;
      // Re-arm on a TRANSIENT result so a later window (or a reconnect) re-runs
      // instead of re-serving a cached deadline/network miss for the process
      // lifetime — with F absent that would strand the user signed-out until an
      // app restart. Committed / terminal / commit-failed stay cached
      // (idempotent; commit-failed already has a background continuation). The
      // `=== run` guard only clears our own promise, never a newer migration.
      void run.then(
        (outcome) => {
          if (outcome === "retryable" && this.migrationInFlight === run) {
            this.migrationInFlight = null;
          }
        },
        () => {
          if (this.migrationInFlight === run) this.migrationInFlight = null;
        },
      );
    }
    return this.migrationInFlight;
  }

  private async runMigration(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    // Settle any interrupted WAL mutation before classifying F (as `get()`
    // does), so migration never reads a mid-sign-out ghost credential.
    await this.recoveryGate;
    const outcome = await runLegacyCredentialsMigration({
      store: this.store,
      authnBaseUrl: this.authnBaseUrl,
      legacy: { token: legacy.token, refreshToken: legacy.refreshToken },
      probe: validateAuthTokenIdentityAccessOnceAbortable,
      signal: AbortSignal.timeout(MIGRATION_DEADLINE_MS),
      maxAttempts: MIGRATION_MAX_ATTEMPTS,
    });
    // Telemetry (§6): the outcome mix — especially the measured-rare
    // `identity-unknown` — is watched during rollout. Never logs tokens.
    log.info("[file-token-store] legacy credentials migration", { outcome });
    return outcome;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    this.store.dispose();
    this.listeners.clear();
  }
}
