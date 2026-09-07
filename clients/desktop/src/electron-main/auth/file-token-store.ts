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
import {
  createCredentialsMutationStore,
  type CredentialsMutationStore,
} from "@traycer/protocol/config/credentials-mutation";
import { runInitGate } from "@traycer/protocol/config/credentials-wal";
import { runLegacyCredentialsMigration } from "./credentials-migration";
import { describeLogError, log } from "../app/logger";

/**
 * The path is ENV-scoped (never slot-scoped): all `make dev-desktop` slots and the CLI share one file per environment, which is the whole point - sign in once, signed in everywhere.
 * Reconcile never writes/spends, so self-write echoes are fine (sibling windows adopt; origin re-reads to the same state).
 */
export type WatchImpl = (
  dir: string,
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher;

export interface FileTokenStoreOptions {
  readonly environment: Environment;
  readonly authnBaseUrl: string;
  readonly watchImpl: WatchImpl | undefined;
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
// Reinstall backoff after a watcher error or a failed install. A dead watcher
// leaves this slot permanently blind to sibling rotations (no reconcile, no
// adoption), so it is retried forever rather than given up on.
const WATCHER_REINSTALL_INITIAL_MS = 1_000;
const WATCHER_REINSTALL_MAX_MS = 30_000;
const WATCHER_STABILITY_MS = 30_000;

const CATCH_UP_RETRY_INITIAL_MS = 1_000;
const CATCH_UP_RETRY_MAX_MS = 30_000;
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
  private watcherReinstallTimer: NodeJS.Timeout | null = null;
  private watcherReinstallDelayMs: number = WATCHER_REINSTALL_INITIAL_MS;
  private watcherWasInterrupted = false;
  private watcherInstalledAtMs = 0;
  private catchUpPending = false;
  private catchUpRetryTimer: NodeJS.Timeout | null = null;
  private catchUpRetryDelayMs: number = CATCH_UP_RETRY_INITIAL_MS;
  private migrationInFlight: Promise<CredentialsMigrationOutcome> | null = null;
  private readonly watchImpl: WatchImpl;

  constructor(options: FileTokenStoreOptions) {
    this.authnBaseUrl = options.authnBaseUrl;
    this.watchImpl = options.watchImpl ?? watch;
    const credentialsPath = cliCredentialsPath(options.environment);
    this.credentialsPath = credentialsPath;
    this.credentialsDir = dirname(credentialsPath);
    this.credentialsBasename = basename(credentialsPath);
    const lockPath = `${credentialsPath}.lock`;
    const metaPath = `${credentialsPath}.meta.json`;
    this.store = createCredentialsMutationStore({
      paths: { credentialsPath, metaPath, lockPath },
      refresh: (args) =>
        refreshOnceAbortable({
          ...args,
          authnBaseUrl: options.authnBaseUrl,
          clientKind: "desktop",
        }),
      lockWaitMs: LOCK_WAIT_MS,
      lockPollIntervalMs: LOCK_POLL_INTERVAL_MS,
      continuationRetryMs: CONTINUATION_RETRY_MS,
    });
    // Kick the gate immediately; do not block the constructor / IPC install.
    // The first `get()` (and every subsequent one  -  a settled promise is free)
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
    try {
      // Drain any quarantined conditional deletes BEFORE the first read is served: a pair whose delete was pending when the app died must be removed - not rehydrated - on this launch.
      const clean = await this.store.drainQuarantine(
        AbortSignal.timeout(INIT_GATE_WAIT_MS),
      );
      if (!clean) {
        log.warn(
          "[file-token-store] quarantined credential delete still pending",
        );
      }
    } catch (error) {
      log.warn("[file-token-store] quarantine drain failed at startup", {
        error: describeLogError(error),
      });
    }
  }

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
      this.watcherWasInterrupted = true;
      this.scheduleWatcherReinstall();
      return;
    }
    try {
      const watcher = this.watchImpl(
        this.credentialsDir,
        (_event, filename) => {
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
        },
      );
      watcher.on("error", (err) => {
        // Close + null the reference and schedule the reinstall. Without
        // this, an FSEvents stream-reset leaves the store blind for the rest
        // of the process lifetime (host-lifecycle pattern, now with recovery).
        log.warn("[file-token-store] credentials watcher error", {
          error: describeLogError(err),
        });
        if (this.watcher === watcher) {
          try {
            watcher.close();
          } catch {
            // An errored watcher may already be torn down; the reference drop
            // below is what matters.
          }
          this.watcher = null;
          this.watcherWasInterrupted = true;
          // Backoff resets only after a STABLE run (see WATCHER_STABILITY_MS)
          // - construction success alone proves nothing about the stream.
          if (Date.now() - this.watcherInstalledAtMs >= WATCHER_STABILITY_MS) {
            this.watcherReinstallDelayMs = WATCHER_REINSTALL_INITIAL_MS;
          }
          this.scheduleWatcherReinstall();
        }
      });
      this.watcher = watcher;
      this.watcherInstalledAtMs = Date.now();
      if (this.watcherWasInterrupted) {
        this.watcherWasInterrupted = false;
        log.info("[file-token-store] credentials watcher reinstalled");
        this.catchUpPending = true;
        this.catchUpRetryDelayMs = CATCH_UP_RETRY_INITIAL_MS;
        this.scheduleEmitChange();
      }
    } catch (error) {
      log.warn("[file-token-store] unable to install credentials watcher", {
        error: describeLogError(error),
      });
      this.watcherWasInterrupted = true;
      this.scheduleWatcherReinstall();
    }
  }

  private scheduleWatcherReinstall(): void {
    if (this.disposed || this.watcherReinstallTimer !== null) {
      return;
    }
    const delayMs = this.watcherReinstallDelayMs;
    this.watcherReinstallDelayMs = Math.min(
      delayMs * 2,
      WATCHER_REINSTALL_MAX_MS,
    );
    this.watcherReinstallTimer = setTimeout(() => {
      this.watcherReinstallTimer = null;
      this.installWatcher();
    }, delayMs);
  }

  private scheduleCatchUpRetry(): void {
    if (this.disposed || this.catchUpRetryTimer !== null) {
      return;
    }
    const delayMs = this.catchUpRetryDelayMs;
    this.catchUpRetryDelayMs = Math.min(delayMs * 2, CATCH_UP_RETRY_MAX_MS);
    this.catchUpRetryTimer = setTimeout(() => {
      this.catchUpRetryTimer = null;
      if (this.catchUpPending) {
        this.scheduleEmitChange();
      }
    }, delayMs);
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
      // Through the store, not a raw file read: the change fan-out must be
      // quarantine-aware  -  a pair whose conditional delete is pending is
      // never advertised as present to any window.
      file = await this.store.read();
    } catch (error) {
      log.warn("[file-token-store] credentials read after watch event failed", {
        error: describeLogError(error),
      });
      // An ordinary watch event can be dropped - the next one re-reads. An
      // outstanding reinstall catch-up cannot: it is standing in for events
      // that already happened and will never be re-delivered.
      if (this.catchUpPending) {
        this.scheduleCatchUpRetry();
      }
      return;
    }
    if (this.disposed) {
      return;
    }
    // Any successful read satisfies the catch-up, whoever triggered it.
    this.catchUpPending = false;
    this.catchUpRetryDelayMs = CATCH_UP_RETRY_INITIAL_MS;
    if (this.catchUpRetryTimer !== null) {
      clearTimeout(this.catchUpRetryTimer);
      this.catchUpRetryTimer = null;
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
   * Never locks.
   * Awaits the bounded init recovery gate first so a cold-start rehydration cannot race a mid-sign-out WAL completion (ghost sign-in).
   */
  get(): Promise<StoredCredentials | null> {
    return this.recoveryGate.then(() => this.store.read());
  }

  /** Rejects on a non-`applied` outcome (a persistent local failure) so the sign-in surfaces as failed rather than a signed-in state the next launch cannot rehydrate. */
  signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void> {
    return this.enqueue(async () => {
      const credentials: StoredCredentials = {
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        savedAt: new Date().toISOString(),
        user: identity,
      };
      const result = await this.store.signIn(credentials, false, null);
      if (result.outcome !== "applied") {
        throw new Error(`credentials sign-in did not apply: ${result.outcome}`);
      }
    });
  }

  /** Returns the typed outcome + the pair the caller should act on. */
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

  /** Rejects if the delete cannot land, so a failed sign-out stays signed in rather than falsely reporting success. */
  delete(): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.store.signOut(null);
      if (result.outcome !== "deleted") {
        throw new Error(`credentials sign-out did not land: ${result.outcome}`);
      }
    });
  }

  /**
   * The comparison and the delete run inside ONE locked mutation (`signOutIfToken`), so a sibling window's sign-in - or an external CLI writer.
   * Rejects when the store cannot decide (lock-busy) or the delete cannot land, so a still-durable stale pair is never reported as cleaned up.
   */
  deleteIfToken(expectedToken: string): Promise<"deleted" | "kept"> {
    return this.enqueue(async () => {
      const result = await this.store.signOutIfToken(expectedToken, null);
      if (result.outcome === "deleted") {
        return "deleted";
      }
      if (result.outcome === "superseded") {
        return "kept";
      }
      throw new Error(
        `conditional credentials delete did not land: ${result.outcome}`,
      );
    });
  }

  /** Reconcile never writes/spends. */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The renderer reads and decrypts the legacy per-window localStorage token pair and hands it here; this single-flights the reconcile across windows and NEVER deletes the file.
   * The caller wipes the legacy slots per `shouldWipeLegacyCredentials(outcome)` and then runs its normal file rehydrate.
   */
  migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    if (this.migrationInFlight === null) {
      const run = this.runMigration(legacy);
      this.migrationInFlight = run;
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
    // Telemetry (§6): the outcome mix  -  especially the measured-rare
    // `identity-unknown`  -  is watched during rollout. Never logs tokens.
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
    if (this.watcherReinstallTimer !== null) {
      clearTimeout(this.watcherReinstallTimer);
      this.watcherReinstallTimer = null;
    }
    if (this.catchUpRetryTimer !== null) {
      clearTimeout(this.catchUpRetryTimer);
      this.catchUpRetryTimer = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    this.store.dispose();
    this.listeners.clear();
  }
}
