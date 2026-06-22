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

  constructor(tokenStore: ITokenStore) {
    this.tokenStore = tokenStore;
  }

  async load(): Promise<StoredAuthTokens | null> {
    return this.tokenStore.get();
  }

  async save(tokens: StoredAuthTokens): Promise<void> {
    await this.tokenStore.set(tokens);
  }

  async clear(): Promise<void> {
    await this.tokenStore.delete();
  }
}
