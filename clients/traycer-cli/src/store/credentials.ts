import {
  readCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";
import { config } from "../config";
import { createCliLogger } from "../logger";
import { cliCredentialsPath } from "./paths";
import { devDesktopSlotForEnvironment } from "./dev-desktop-slot";

// The on-disk shape now lives in `@traycer/protocol/config` (shared by the CLI,
// the desktop app, and the host). Re-exported so existing CLI importers keep
// resolving `StoredCredentials` from `../store/credentials`.
export type { StoredCredentials };

// Dev credentials are shared across every `make dev-desktop` run (worktree),
// but each run's local authn stack listens on its own allocated port. Only
// override the serialized URL when THIS process is actually inside a
// dev-desktop run slot (`DEV_DESKTOP_SLOT` set) - a plain from-source `dev`
// CLI invocation outside dev-desktop has no local stack and must keep using
// whatever authn URL is actually stored (matches the config.ts committed
// default, or a prior explicit login), or every unrelated dev CLI call would
// start validating tokens against the wrong backend.
export function effectiveAuthnBaseUrl(storedAuthnBaseUrl: string): string {
  if (devDesktopSlotForEnvironment(config.environment, process.env) !== null) {
    return config.authnBaseUrl;
  }
  return storedAuthnBaseUrl;
}

export function credentialsWithEffectiveAuthnBaseUrl(
  creds: StoredCredentials,
): StoredCredentials {
  const authnBaseUrl = effectiveAuthnBaseUrl(creds.authnBaseUrl);
  if (authnBaseUrl === creds.authnBaseUrl) return creds;
  return {
    ...creds,
    authnBaseUrl,
  };
}

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
// non-spending `readCredentials` (a fresh-process snapshot needs no lock) and the
// dev-desktop `effectiveAuthnBaseUrl` helpers.
