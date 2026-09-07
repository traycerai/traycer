import {
  readCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";
import { config } from "../config";
import { createCliLogger } from "../logger";
import { cliCredentialsPath } from "./paths";

// The on-disk shape now lives in `@traycer/protocol/config` (shared by the CLI, the desktop app, and the host).
// Re-exported so existing CLI importers keep resolving `StoredCredentials` from `../store/credentials`.
export type { StoredCredentials };

export async function readCredentials(): Promise<StoredCredentials | null> {
  const logger = createCliLogger(config.environment);
  const stored = await readCredentialsFile(
    cliCredentialsPath(config.environment),
  );
  logger.debug("Credentials read completed", {
    environment: config.environment,
    hasCredentials: stored !== null,
    hasToken: stored !== null && stored.token.length > 0,
    hasRefreshToken: stored !== null && stored.refreshToken.length > 0,
  });
  return stored;
}

// NB: token *writes* and *deletes* no longer live here.
// Every mutation now goes through the locked mutation store (`createCliCredentialsStore`, §2/§7) - the floor-0 `writeCredentials` and best-effort `deleteCredentials` were removed so no CLI writer can bypass the WAL/lock and stomp the store's floor.
