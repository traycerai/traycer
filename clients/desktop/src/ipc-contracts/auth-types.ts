export type { AuthTokenRefreshResult } from "@traycer-clients/shared/platform/runner-host";

// Credentials-file token-store payloads (tech plan §3) crossing the preload
// boundary. Canonical definitions live in the shared runner-host contract; the
// preload bridge imports them from here per the ipc-contracts boundary rule.
export type {
  CredentialsMigrationOutcome,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
