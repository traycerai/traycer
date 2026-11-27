import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import type { HostTokenPersistence } from "../../../../shared/auth/host-token-source";
import { config } from "../../config";

/**
 * For the suites that keep the host tokens in memory. The CLI stores a token
 * only for the person the credentials file holds, which it reads in the check
 * the host-token file runs before each change. So the memory stand-in runs
 * that check, and the check's read answers made-up credentials of the case's
 * person. Both are for a mock factory: this module imports neither module it
 * stands in for.
 */

/** `host-token-file`, over the case's own memory. */
export function hostTokenFileOver(memory: HostTokenPersistence): {
  createHostTokenFilePersistence: (options: {
    readonly beforeChange: (() => Promise<void>) | undefined;
  }) => HostTokenPersistence;
} {
  return {
    createHostTokenFilePersistence: (options) => ({
      load: () => memory.load(),
      update: async (change) => {
        if (options.beforeChange !== undefined) await options.beforeChange();
        return memory.update(change);
      },
    }),
  };
}

type CredentialsModule = typeof import("@traycer/protocol/config/credentials");

/**
 * `config/credentials`: the read of this build's own credentials path, which
 * that check makes, answers `person` and reads no file. Every other path is
 * read as it is.
 */
export function credentialsHolding(
  actual: CredentialsModule,
  person: () => string,
): CredentialsModule {
  return {
    ...actual,
    readCredentialsFile: async (path) =>
      path === cliCredentialsPath(config.environment)
        ? {
            token: "made-up-sign-in",
            refreshToken: "made-up-refresh-token",
            savedAt: "2026-01-01T00:00:00.000Z",
            user: { id: person(), email: "user@example.test", name: "User" },
          }
        : actual.readCredentialsFile(path),
  };
}
