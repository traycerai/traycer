import type {
  CredentialsMigrationOutcome,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { IpcAuthTokenStore } from "../runner-ipc-bridge";

export class FakeAuthTokenStore implements IpcAuthTokenStore {
  private readonly listeners = new Set<(change: TokenStoreChange) => void>();
  readCount = 0;

  constructor(private readonly read: () => Promise<StoredCredentials | null>) {}

  get(): Promise<StoredCredentials | null> {
    this.readCount += 1;
    return this.read();
  }

  getSignInStorageLow(): boolean {
    return false;
  }

  subscribeSignInStorageLow(): () => void {
    return () => undefined;
  }

  async signIn(
    _tokens: StoredAuthTokens,
    _identity: StoredCredentialsIdentity,
  ): Promise<"saved" | "disk-full"> {
    return Promise.resolve("saved");
  }

  async rotate(_expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult> {
    return {
      outcome: "deleted",
      pair: null,
      rejection: null,
      diskPressure: null,
    };
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  async deleteIfToken(_expectedToken: string): Promise<"deleted" | "kept"> {
    return "kept";
  }

  subscribe(listener: (change: TokenStoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async migrateLegacyCredentials(
    _legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    return "retryable";
  }

  dispose(): void {
    this.listeners.clear();
  }

  emit(change: TokenStoreChange): void {
    for (const listener of Array.from(this.listeners)) listener(change);
  }
}

export function buildStoredCredentials(
  userId: string,
  token: string,
): StoredCredentials {
  return {
    token,
    refreshToken: "refresh-token",
    savedAt: "2026-01-01T00:00:00.000Z",
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Local User",
    },
  };
}
