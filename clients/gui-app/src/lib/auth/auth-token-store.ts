import type {
  ITokenStore,
  StoredAuthTokens,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * Persists the Traycer bearer token in the runner-host typed token store.
 *
 * Mirrors the token-store contract on the runner host so each shell controls
 * its own native keychain backing without `gui-app` picking a key. Desktop
 * resolves this through the Electron preload bridge into the OS keychain;
 * mobile resolves it through the native secure store; in-memory hosts
 * (dev runner, tests) keep a single round-trippable entry.
 */
export class AuthTokenStore {
  private readonly tokenStore: ITokenStore;
  // Serializes every persisted-token operation. save/clear are dispatched
  // from independently-awaiting flows (sign-in finalization, sign-out,
  // refresh rotation), and the underlying keychain IPC gives no cross-call
  // ordering guarantee - without this chain a sign-out's delete could be
  // applied BEFORE a still-in-flight save, leaving the signed-out user's
  // token on disk for the next launch to rehydrate. The chain makes the
  // last-dispatched operation own the final on-disk state; loads join it so
  // they always read a settled value.
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

  async load(): Promise<StoredAuthTokens | null> {
    return this.enqueue(() => this.tokenStore.get());
  }

  async save(tokens: StoredAuthTokens): Promise<void> {
    await this.enqueue(() => this.tokenStore.set(tokens));
  }

  async clear(): Promise<void> {
    await this.enqueue(() => this.tokenStore.delete());
  }
}
