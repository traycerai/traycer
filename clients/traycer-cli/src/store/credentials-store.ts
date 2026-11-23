import {
  createCredentialsMutationStore,
  type CredentialsMutationStore,
  type MutationResult,
} from "@traycer/protocol/config/credentials-mutation";
import { refreshOnceAbortable } from "../../../shared/auth/auth-validation";
import type {
  BearerLease,
  OpenFrameBearerSource,
} from "../../../shared/auth/bearer-source";
import type {
  AuthRevalidator,
  AuthorityBoundAuthRevalidator,
  RevalidateOutcome,
} from "../../../shared/auth/bearer-revalidator";
import { config } from "../config";
import { cliCredentialsPath } from "./paths";

/**
 * The CLI's handle onto the cross-process credentials mutation store (§2 / §7).
 * It is the CLI counterpart to the desktop `FileTokenStore`: every token *spend*
 * (`rotate`) runs inside the shared `${credentials}.lock` file lock, so a CLI
 * command and the desktop app can never double-spend a single-use refresh token.
 *
 * Distinct from `cli-lock.ts` (the host install/update/upgrade lock over a
 * SEPARATE `.lock` file) — the two never contend.
 *
 * Lifecycle: the CLI is a short-lived process. Create one store per command,
 * run the op through {@link withCommitRetry}, and `dispose()` before exit. The
 * store's background commit-failed retry timer would never fire in a process
 * that exits immediately, so `withCommitRetry` re-drives a `commit-failed`
 * synchronously instead (the plan's "a CLI command retries before exit").
 */

// Lock hold time includes at most one bounded in-lock refresh (~10s, see
// `refreshOnceAbortable`); the wait budget sits just above it so a competing
// mutation waits it out rather than failing (matches the desktop store).
export const CREDENTIALS_LOCK_WAIT_MS = 12_000;
const LOCK_POLL_INTERVAL_MS = 50;
const CONTINUATION_RETRY_MS = 1_000;
// Bounded synchronous re-drive of a commit-failed continuation before exit.
const COMMIT_RETRY_ATTEMPTS = 3;

export function createCliCredentialsStore(): CredentialsMutationStore {
  const credentialsPath = cliCredentialsPath(config.environment);
  return createCredentialsMutationStore({
    onDiskPressure: null,
    paths: {
      credentialsPath,
      metaPath: `${credentialsPath}.meta.json`,
      lockPath: `${credentialsPath}.lock`,
    },
    // The store hands over the pair and rotation code; the endpoint is THIS build's
    // configured authn (baked, with the dev-slot env override applied at module
    // init). The file deliberately carries no URL - see `store/credentials.ts`.
    refresh: (args) =>
      refreshOnceAbortable({
        ...args,
        authnBaseUrl: config.authnBaseUrl,
        clientKind: "cli",
      }),
    lockWaitMs: CREDENTIALS_LOCK_WAIT_MS,
    lockPollIntervalMs: LOCK_POLL_INTERVAL_MS,
    continuationRetryMs: CONTINUATION_RETRY_MS,
  });
}

/** A sign-in refresh's outcome, telling an adopted sibling's rotation ("adopted") from one authn answered. */
export type SignInRotation = RevalidateOutcome | "adopted";

/**
 * A rotation's outcome, with the sign-in its own save wrote, taken from the
 * store's locked result. A rejection names the sign-in the locked rotate
 * tried (`refused`): the lease's bearer it was asked to spend past, which the
 * store compared with the file under the lock (a different file answers
 * `superseded`). `accepted` is separate from the outcome: the sign-in authn
 * issued for this call's own refresh, taken from the store's answer that
 * first carries it, whatever the commit and its retries then report (a
 * retry that finds this refresh's own pair landed answers `superseded`, and
 * the outcome says "adopted"). Held in memory only; never logged or sent.
 */
export type SignInRotationResult = {
  readonly accepted: string | null;
} & (
  | {
      readonly outcome: "rotated";
      readonly installed: string;
      readonly refused: null;
    }
  | {
      readonly outcome: "rejected";
      readonly installed: null;
      readonly refused: string;
    }
  | {
      readonly outcome: Exclude<SignInRotation, "rotated" | "rejected">;
      readonly installed: null;
      readonly refused: null;
    }
);

/**
 * The CLI's on-`UNAUTHORIZED` bearer revalidator, backed by the locked `rotate`
 * mutation (§7). Replaces the retired `createBearerRevalidator` + `cliBearerStore`
 * pair, which spent a multi-attempt refresh directly, outside any lock; every
 * refresh now runs inside the shared credentials file lock, so a CLI refresh and
 * a concurrent desktop refresh can never double-spend the single-use refresh
 * token.
 *
 * Satisfies both transport consumers with one shape (`Promise<RevalidateOutcome>`,
 * assignable to the unary `AuthRevalidator`'s `Promise<unknown>`): the unary
 * auth-aware messenger observes the rotated lease; the stream monitor + proactive
 * scheduler key on the outcome kind.
 *
 * The injected refresh closes over this process's configured authn origin and
 * the store reads the file's `refreshToken`, so — unlike the old revalidator —
 * no `authnBaseUrl` is threaded here. The lock also makes
 * the old reject-reread poll unnecessary: a concurrent winner's pair is observed
 * as `superseded` (adopt, spend nothing) rather than a lost race to recover from.
 */
export function createStoreBackedRevalidator(args: {
  readonly store: CredentialsMutationStore;
  readonly lease: BearerLease;
  // Cancels a rotation mid-flight - the lock wait and the refresh fetch both
  // honor it, and both map an abort to a TRANSIENT outcome (`lock-busy` /
  // `refresh-network` -> "network-error"), never to "rejected". Callers whose
  // lifetime is the process pass null; a deadline-bounded caller (the host
  // install probe) passes its own controller's signal so an abandoned
  // rotation cannot keep the drain-to-exit CLI alive past its bound.
  readonly signal: AbortSignal | null;
}): AuthRevalidator &
  AuthorityBoundAuthRevalidator & {
    revalidateCurrentContext(): Promise<RevalidateOutcome>;
    /** As `revalidateCurrentContext`, but "adopted" when a sibling's rotation was taken from the store (authn was not asked), and with the sign-in its own save wrote. */
    rotateSignIn(): Promise<SignInRotationResult>;
    /**
     * Adopts into the lease the sign-in the credentials file holds now, read
     * through the store's own read (which includes this process's
     * commit-failed overlay), when it is this person's: "the stored sign-in"
     * is the file's, not this process's memory. Adopting reads are the
     * lease's one writer and run one at a time: a caller that arrives while
     * a read runs is answered by a read that started after it arrived, so
     * once this resolves the lease is not older than any file snapshot the
     * read observed. Spends nothing, and never throws.
     */
    adoptStoredSignIn(): Promise<void>;
  } {
  const { store, lease, signal } = args;
  // One adopting read at a time, and at most one queued behind it: every
  // caller that arrives while a read runs shares the queued read, which
  // starts only once the running one has returned.
  let reading: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const readAndAdopt = async (): Promise<void> => {
    try {
      for (;;) {
        const before = lease.getBearerToken();
        const stored = await store.read();
        // Changed during the read by a writer outside this path: read again,
        // so the snapshot installed is one taken after that change.
        if (lease.getBearerToken() !== before) continue;
        // No file, another person's, or the lease's own: the lease stands, so
        // a signed-out file never sends a retry on a sign-in nobody holds.
        if (
          stored !== null &&
          stored.user.id === lease.identity.userId &&
          stored.token !== before
        )
          lease.rotate(stored.token);
        return;
      }
    } catch {
      // An unreadable file or a released lease leaves the lease as it is.
    }
  };
  const startRead = (): Promise<void> => {
    const read = readAndAdopt().finally(() => {
      if (reading === read && queued === null) reading = null;
    });
    reading = read;
    return read;
  };
  const adoptStoredSignIn = (): Promise<void> => {
    if (reading === null) return startRead();
    if (queued === null) {
      queued = reading.then(() => {
        queued = null;
        return startRead();
      });
    }
    return queued;
  };
  const rotateSignIn = async (): Promise<SignInRotationResult> => {
    // Boundary contract (matches the retired `createBearerRevalidator`): NEVER
    // throws — every failure, including a released lease or a store I/O fault,
    // maps to an outcome so the unary messenger and the stream monitor decide
    // recovery without a try/catch and without risking an unhandled rejection.
    // Declared outside the try, so a throw after authn accepted (an aborted
    // commit retry's wait) still reports it.
    let accepted: string | null = null;
    try {
      const current = lease.getBearerToken();
      const result = await withCommitRetry(
        async () => {
          const attempt = await store.rotate({
            expectedUserId: lease.identity.userId,
            expectedToken: current,
            // `null` → rotate spends the file's own refresh token (the CLI never
            // overrides it; that override is migration-only, §6).
            refreshTokenOverride: null,
            signal,
          });
          // Only these two answer a refresh authn accepted on this call; a
          // retry's `superseded` is the pair already landed, never a new one.
          if (
            (attempt.outcome === "applied" ||
              attempt.outcome === "commit-failed") &&
            attempt.credentials !== null
          )
            accepted = attempt.credentials.token;
          return attempt;
        },
        // The deadline-bounded caller's signal, so an abandoned commit
        // retry cannot outlive the probe that started it.
        signal,
      );
      switch (result.outcome) {
        case "applied":
        case "superseded":
        case "commit-failed":
          // applied     → refreshed + committed;
          // superseded  → a sibling / the desktop already rotated — adopt it,
          //               spend nothing;
          // commit-failed → the refresh was spent but the local commit failed;
          //               the minted pair is server-issued and live in the
          //               store's in-memory overlay (withCommitRetry already
          //               re-drove the landing), so the host accepts it.
          // Rotate the lease to whichever token we settled on.
          // The protocol types `credentials` as nullable for every outcome;
          // these three always carry one. With none the lease is untouched,
          // which is what "network-error" says.
          if (result.credentials === null)
            return {
              outcome: "network-error",
              installed: null,
              refused: null,
              accepted,
            };
          // The lease takes the result through the adopting read, its one
          // writer, never by a direct write that could land after a newer
          // adoption. The read serves the committed pair, or this process's
          // overlay of a commit-failed one, or whatever is newer by then.
          await adoptStoredSignIn();
          // A sibling's rotation adopted is no sign-in this save wrote.
          return result.outcome === "superseded"
            ? { outcome: "adopted", installed: null, refused: null, accepted }
            : {
                outcome: "rotated",
                installed: result.credentials.token,
                refused: null,
                accepted,
              };
        case "refresh-network":
        case "lock-busy":
        case "spend-pending":
        case "disk-full":
          // Transient, bearer untouched: a refresh transport blip, a lock held
          // past the wait budget, or a sibling's still-landing spend of this
          // base. None is a dead credential — stay in reconnect backoff and
          // retry (the sibling's landed pair adopts via `superseded`).
          return {
            outcome: "network-error",
            installed: null,
            refused: null,
            accepted,
          };
        case "deleted":
        case "tombstoned":
        case "user-mismatch":
        // Terminal for this lease on either side of the split - see the note in
        // `auth/validate.ts`: the CLI holds no local plane to keep alive, so
        // the credential/account distinction changes nothing it can do.
        case "refresh-rejected-credential":
        case "refresh-rejected-account":
          // Terminal for this lease: the file is gone (concurrent logout), a
          // sign-out stands, the file switched to a different account (never
          // adopt cross-user), or the refresh token is dead. The CLI leaves the
          // file in place (no clear) — a transient authn outage surfacing as
          // `refresh-rejected` must not force a re-login; the host re-spawn path
          // re-authenticates.
          return {
            outcome: "rejected",
            installed: null,
            refused: current,
            accepted,
          };
      }
    } catch {
      return {
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted,
      };
    }
  };
  const revalidateCurrentContext = async (): Promise<RevalidateOutcome> => {
    const { outcome } = await rotateSignIn();
    return outcome === "adopted" ? "rotated" : outcome;
  };
  return {
    revalidateCurrentContext,
    rotateSignIn,
    adoptStoredSignIn,
    // The unary auth-aware messenger (#534) is authority-bound: it revalidates
    // the exact bearer that produced the rejected open frame. Refresh only when
    // that bearer is still THIS lease; a `superseded` bearer means a newer
    // context already replaced it, so spend nothing (mirrors the retired
    // `createBearerRevalidator`'s `revalidateExpectedBearer`).
    async revalidateExpectedBearer(
      expected: OpenFrameBearerSource,
    ): Promise<RevalidateOutcome | "superseded"> {
      if (expected !== lease) {
        return "superseded";
      }
      return revalidateCurrentContext();
    },
  };
}

/**
 * Create a CLI credentials store, run `fn` against it, and dispose it — the
 * one-shot lifecycle for a short-lived command (`login`, `whoami`, `logout`).
 * `dispose` stops any `commit-failed` continuation timer `fn`'s mutations armed.
 * (host-rpc / monitor manage the store's lifetime themselves — the store must
 * outlive a single call there, so they don't use this wrapper.)
 */
export async function runWithCliStore<T>(
  fn: (store: CredentialsMutationStore) => Promise<T>,
): Promise<T> {
  const store = createCliCredentialsStore();
  try {
    return await fn(store);
  } finally {
    store.dispose();
  }
}

/**
 * Run a store op, and if it returns `commit-failed` (the refresh was spent but
 * the local commit failed, arming an in-memory continuation), re-drive it a
 * bounded number of times before the CLI exits — the background timer that would
 * normally land it never fires in a short-lived process.
 *
 * Re-invoking the op re-runs the store's first-gate, which drives the pending
 * continuation under the lock: for a `rotate` a landed continuation surfaces as
 * `superseded` (the file now holds the minted pair); an interactive `signIn`
 * simply re-attempts its own commit. If it still fails after the budget, the
 * caller surfaces the error and the user re-runs / re-logs in (the plan's named
 * manual-login loss — a persistent local FS fault, not a crash-only window).
 */
export async function withCommitRetry(
  op: () => Promise<MutationResult>,
  // Cancels the WAIT between attempts, and stops the loop re-driving `op`
  // once aborted. Threading it into the op alone is not enough: this
  // wrapper's own inter-attempt timer is an ordinary `setTimeout`, and the
  // CLI exits by draining the event loop (`runner/exit.ts` sets
  // `process.exitCode`), so an abandoned retry keeps the process sitting at
  // the prompt for up to `COMMIT_RETRY_ATTEMPTS * CONTINUATION_RETRY_MS`
  // after the command already printed its result - the exact bound-escape
  // `createStoreBackedRevalidator`'s `signal` exists to prevent.
  //
  // `null` is the right value for a caller whose lifetime IS the process
  // (`login`, `logout`, `validate`): landing the commit before exit is the
  // whole point there, so the retry must not be cut short.
  signal: AbortSignal | null,
): Promise<MutationResult> {
  let result = await op();
  for (
    let attempt = 0;
    attempt < COMMIT_RETRY_ATTEMPTS && result.outcome === "commit-failed";
    attempt += 1
  ) {
    await delay(CONTINUATION_RETRY_MS, signal);
    // Re-checked after the wait as well as inside it: an abort that lands
    // while we sleep must not spend another attempt, and `op` itself would
    // only fail again on a signal it already honors.
    if (signal !== null && signal.aborted) {
      break;
    }
    result = await op();
  }
  if (
    result.outcome === "disk-full" ||
    (result.outcome === "commit-failed" && result.diskPressure === "low")
  ) {
    process.stderr.write(
      "Disk is full: could not save your sign-in. Free up some space and run the command again.\n",
    );
  }
  return result;
}

function delay(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal !== null && signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (signal !== null) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (signal !== null) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
