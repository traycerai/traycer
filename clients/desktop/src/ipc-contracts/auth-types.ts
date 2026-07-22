/**
 * Desktop IPC re-export of the shared auth result contracts. The canonical
 * definitions live in `@traycer-clients/shared/platform/runner-host`; this file
 * lets the Electron preload bridge import them from `src/ipc-contracts/` (per
 * the preload boundary rule) rather than reaching into the shared package,
 * mirroring how `host-management-types.ts` re-exports the host contract.
 */
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
