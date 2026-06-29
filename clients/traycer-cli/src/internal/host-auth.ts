import type { BearerStore } from "../../../shared/auth/bearer-revalidator";
import { config } from "../config";
import { createCliLogger } from "../logger";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "../store/credentials";

/**
 * The CLI's host-auth boundary.
 *
 * The CLI talks to the host (unary `/rpc` and the `/stream` inbox monitor)
 * with a bearer it reads from `~/.traycer/cli/credentials` - the single,
 * durable source seeded by `traycer login` (the Desktop runs
 * `traycer login --token` after sign-in). The credentials file is the sole
 * authority for the host bearer, so a refresh can persist and every
 * subsequent invocation reuses the rotated value.
 *
 * The refresh-on-401 flow itself lives in the shared `createBearerRevalidator`
 * (used by both the renderer and the CLI); this module only supplies the CLI's
 * file-backed `BearerStore` and the initial bearer.
 */
export interface HostAuth {
  readonly token: string;
  readonly authnBaseUrl: string;
  readonly userId: string;
}

/**
 * Reads the active host bearer from the stored credentials. Returns `null`
 * when the user is not logged in (no credentials file, or an empty token) so
 * callers can surface a "run `traycer login`" error rather than dialing the
 * host with an empty bearer.
 */
export async function resolveHostAuth(): Promise<HostAuth | null> {
  const logger = createCliLogger(config.environment);
  const stored = await readCredentials();
  if (stored === null || stored.token.length === 0) {
    logger.info("Host auth credentials unavailable", {
      environment: config.environment,
      hasStoredCredentials: stored !== null,
      hasToken: stored !== null && stored.token.length > 0,
    });
    return null;
  }
  logger.debug("Host auth credentials resolved", {
    environment: config.environment,
    hasStoredCredentials: true,
    hasToken: true,
    hasRefreshToken: stored.refreshToken.length > 0,
  });
  return {
    token: stored.token,
    authnBaseUrl: stored.authnBaseUrl,
    userId: stored.user.id,
  };
}

/**
 * `BearerStore` over `~/.traycer/cli/credentials`, plugged into the shared
 * refresh revalidator. `write` merges so a token rotation keeps the advisory
 * `user` block and `authnBaseUrl`; `read` lets the shared revalidator adopt a
 * token a sibling CLI process (or the Desktop re-seeding) already rotated to,
 * instead of burning another single-use refresh; `clear` removes the file. If
 * the file vanished mid-flight (a concurrent `logout`), `write` is a no-op -
 * the in-memory lease still carries the rotated token for the in-flight retry.
 */
export const cliBearerStore: BearerStore = {
  read: async () => {
    const logger = createCliLogger(config.environment);
    const stored = await readCredentials();
    logger.debug("Bearer store read completed", {
      environment: config.environment,
      hasStoredCredentials: stored !== null,
      hasToken: stored !== null && stored.token.length > 0,
      hasRefreshToken: stored !== null && stored.refreshToken.length > 0,
    });
    return stored === null
      ? null
      : {
          token: stored.token,
          refreshToken: stored.refreshToken,
          userId: stored.user.id,
        };
  },
  write: async (tokens) => {
    const logger = createCliLogger(config.environment);
    const stored = await readCredentials();
    if (stored === null) {
      logger.warn("Bearer store skipped token write because credentials disappeared", {
        environment: config.environment,
        receivedToken: tokens.token.length > 0,
        receivedRefreshToken: tokens.refreshToken.length > 0,
      });
      return;
    }
    await writeCredentials({
      ...stored,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      savedAt: new Date().toISOString(),
    });
    logger.info("Bearer store persisted rotated credentials", {
      environment: config.environment,
      receivedToken: tokens.token.length > 0,
      receivedRefreshToken: tokens.refreshToken.length > 0,
    });
  },
  clear: async () => {
    const logger = createCliLogger(config.environment);
    await deleteCredentials();
    logger.warn("Bearer store cleared credentials", {
      environment: config.environment,
    });
  },
};
