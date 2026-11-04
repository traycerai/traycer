import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCachedGoogleToken } from "./google-service-account";

/**
 * The Google IAP id-token a staging desktop sends as `Proxy-Authorization` on
 * its sandbox control-plane calls. Staging's traycer-server sits behind IAP,
 * which refuses a call that carries the user's bearer alone; the host crosses
 * it the same way (`createCachedIapTokenProvider` in the host's cloud-data
 * client factory).
 *
 * The service-account key is written at build time from the release secret
 * and packaged only by a staging build (`set-deploy-target.cjs`,
 * `release-target-electron-builder.cjs`); the audience is stamped into
 * `config.iapAudience` from the client target stamp. A production or dev build
 * has neither, so its provider answers `null` and every request goes out
 * exactly as before.
 *
 * The token is a credential: nothing here logs it, and a failure is reported
 * by classification only.
 */
export type IapProxyTokenProvider = () => Promise<string | null>;

/** Must match `IAP_KEY_FILENAME` in `scripts/set-deploy-target.cjs`. */
const IAP_KEY_FILENAME = "iap-service-account.json";

export interface IapTokenProviderOptions {
  /** The packaged key, or `null` when this build ships none. */
  readonly keyFilePath: string | null;
  /** The IAP OAuth client id; empty when this build is not behind IAP. */
  readonly audience: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Told why an acquisition failed, never with the key or a token. */
  readonly warn: (message: string) => void;
}

/** The packaged key under `resources/keys/`, or `null` outside a packaged staging app. */
export function resolveIapKeyFilePath(
  resourcesPath: string | undefined,
): string | null {
  if (resourcesPath === undefined || resourcesPath.length === 0) return null;
  const candidate = join(resourcesPath, "keys", IAP_KEY_FILENAME);
  return existsSync(candidate) ? candidate : null;
}

/**
 * The id-token provider for this build. A failed acquisition answers `null`,
 * the request then goes out without the header, and IAP's refusal is what the
 * caller reads.
 */
export function createCachedIapTokenProvider(
  options: IapTokenProviderOptions,
): IapProxyTokenProvider {
  const { keyFilePath, audience, fetch, now, warn } = options;
  if (keyFilePath === null || audience.length === 0) {
    return async () => null;
  }
  return createCachedGoogleToken({
    keyFilePath,
    grant: { target_audience: audience },
    tokenField: "id_token",
    label: "IAP proxy token",
    fetch,
    now,
    warn,
  });
}
