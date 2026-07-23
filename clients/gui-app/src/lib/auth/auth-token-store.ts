import type {
  CredentialsMigrationOutcome,
  ITokenStore,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/**
 * Renderer-side handle onto the shell's credentials-file token store (tech plan
 * §3). The single machine-local `~/.traycer/cli/<env>/credentials` file is owned
 * by the shell (desktop main's `FileTokenStore`, reached over IPC); this wrapper
 * only serializes the mutating operations and exposes the typed seam.
 *
 * Post-§3 the store carries the FULL identity (`StoredCredentials`) and every
 * token *spend* happens inside `rotate` (under the file lock, in main) — the
 * renderer never refreshes a token itself. Interactive sign-in is `signIn`; the
 * file is destroyed only by `delete` (reachable from `AuthService.signOut()`).
 */
export class AuthTokenStore {
  private readonly tokenStore: ITokenStore;
  // Serializes the mutating operations. `signIn`/`rotate`/`delete` are dispatched
  // from independently-awaiting flows (sign-in finalization, sign-out, the
  // refresh scheduler), and the IPC layer gives no cross-call ordering guarantee.
  // The chain makes the last-dispatched mutation own the final request order; the
  // main-process file lock is the real cross-process guarantee, this just keeps
  // one renderer from racing its own two mutations onto it (e.g. a sign-out's
  // delete overtaking a still-in-flight sign-in). Reads never join the chain —
  // reads never lock (§3), and a slow in-flight `rotate` must not stall a `get`.
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(tokenStore: ITokenStore) {
    this.tokenStore = tokenStore;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(op, op);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Current credentials (full identity), or `null` when signed out. Never locks. */
  get(): Promise<StoredCredentials | null> {
    return this.tokenStore.get();
  }

  /** Interactive create/replace — the device-flow sign-in. Main stamps the rest. */
  signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void> {
    return this.enqueue(() => this.tokenStore.signIn(tokens, identity));
  }

  /** The locked adopt-or-refresh+commit; the refresh spend happens in main. */
  rotate(expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult> {
    return this.enqueue(() => this.tokenStore.rotate(expected));
  }

  /** Sign-out delete — the only file-destroying path from the app. */
  delete(): Promise<void> {
    return this.enqueue(() => this.tokenStore.delete());
  }

  /** Owned-watcher change subscription (source lands in §4). */
  subscribe(listener: (change: TokenStoreChange) => void): Disposable {
    return this.tokenStore.subscribe(listener);
  }

  /**
   * One-time legacy→file migration (§6). A startup one-shot: main single-flights
   * it and serializes its own store ops under the file lock, so it deliberately
   * does NOT join the mutation chain — it must not stall a sign-in behind its
   * several-second reconcile, and it never mutates through this renderer wrapper.
   */
  migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    return this.tokenStore.migrateLegacyCredentials(legacy);
  }
}
