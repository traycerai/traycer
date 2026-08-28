import {
  readCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";
import { config } from "../config";
import { createCliLogger } from "../logger";
import { cliCredentialsPath } from "./paths";

// The on-disk shape now lives in `@traycer/protocol/config` (shared by the CLI,
// the desktop app, and the host). Re-exported so existing CLI importers keep
// resolving `StoredCredentials` from `../store/credentials`.
//
// The file carries only the session (token pair + cached identity). The authn
// endpoint every auth call targets is `config.authnBaseUrl` - baked at build
// time, with the dev-slot env override applied at module init (config.ts). It
// is never read off disk: a stored URL is whichever stack happened to write
// last (a sibling dev slot's dead port, after that slot stops), not the
// authority this process is configured against.
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

// NB: token *writes* and *deletes* no longer live here. Every mutation now goes
// through the locked mutation store (`createCliCredentialsStore`, §2/§7) - the
// floor-0 `writeCredentials` and best-effort `deleteCredentials` were removed so
// no CLI writer can bypass the WAL/lock and stomp the store's floor. `login`,
// `whoami`, and `logout` call `store.signIn`/`rotate`/`updateProfile`/`signOut`;
// host-rpc/monitor refresh via `store.rotate`. This module keeps only the plain,
// non-spending `readCredentials` (a fresh-process snapshot needs no lock).
