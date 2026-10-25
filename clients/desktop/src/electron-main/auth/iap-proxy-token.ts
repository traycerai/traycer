import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/** Google's OAuth token endpoint: the JWT's audience and where it is exchanged. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A Google id-token lives an hour; the host refreshes at 55 minutes less 5. */
const TOKEN_TTL_MS = 55 * 60 * 1000;
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/** Bounds one acquisition, as the host does, so a wedged endpoint cannot hold the cache. */
const ACQUISITION_TIMEOUT_MS = 15_000;

/** The assertion's own lifetime, Google's maximum. */
const ASSERTION_LIFETIME_S = 3600;

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

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * A cached provider: one acquisition at a time, reused until five minutes
 * before its expiry. A failed acquisition answers `null` and is not cached, so
 * the next call tries again; the request then goes out without the header and
 * IAP's refusal is what the caller reads.
 */
export function createCachedIapTokenProvider(
  options: IapTokenProviderOptions,
): IapProxyTokenProvider {
  const { keyFilePath, audience } = options;
  if (keyFilePath === null || audience.length === 0) {
    return async () => null;
  }
  let cached: CachedToken | null = null;
  let inflight: Promise<string | null> | null = null;
  return async () => {
    if (
      cached !== null &&
      cached.expiresAt - REFRESH_LEEWAY_MS > options.now()
    ) {
      return cached.token;
    }
    if (inflight === null) {
      inflight = acquire(keyFilePath, audience, options)
        .then((token) => {
          if (token !== null) {
            cached = { token, expiresAt: options.now() + TOKEN_TTL_MS };
          }
          return token;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string | null;
}

async function acquire(
  keyFilePath: string,
  audience: string,
  options: IapTokenProviderOptions,
): Promise<string | null> {
  const key = await readServiceAccountKey(keyFilePath);
  if (key === null) {
    options.warn("IAP proxy token unavailable: the key file is unreadable");
    return null;
  }
  let assertion: string;
  try {
    assertion = signAssertion(key, audience, options.now());
  } catch {
    options.warn("IAP proxy token unavailable: the key could not sign");
    return null;
  }
  let response: Response;
  try {
    response = await options.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(ACQUISITION_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    options.warn(
      `IAP proxy token unavailable: the token request never completed (${error instanceof Error ? error.name : "unknown"})`,
    );
    return null;
  }
  if (!response.ok) {
    options.warn(
      `IAP proxy token unavailable: the token endpoint answered HTTP ${response.status}`,
    );
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const idToken =
    typeof body === "object" && body !== null && "id_token" in body
      ? body.id_token
      : null;
  if (typeof idToken !== "string" || idToken.length === 0) {
    options.warn("IAP proxy token unavailable: the answer carried no id-token");
    return null;
  }
  return idToken;
}

async function readServiceAccountKey(
  keyFilePath: string,
): Promise<ServiceAccountKey | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(keyFilePath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const clientEmail = "client_email" in parsed ? parsed.client_email : null;
  const privateKey = "private_key" in parsed ? parsed.private_key : null;
  const privateKeyId =
    "private_key_id" in parsed ? parsed.private_key_id : null;
  if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
    return null;
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId: typeof privateKeyId === "string" ? privateKeyId : null,
  };
}

/**
 * The service account's signed JWT-bearer assertion for an id-token whose
 * audience is `audience`: Google's documented exchange, and the one
 * google-auth-library's `fetchIdToken` makes for a key file.
 */
function signAssertion(
  key: ServiceAccountKey,
  audience: string,
  nowMs: number,
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header =
    key.privateKeyId === null
      ? { alg: "RS256", typ: "JWT" }
      : { alg: "RS256", typ: "JWT", kid: key.privateKeyId };
  const claims = {
    iss: key.clientEmail,
    sub: key.clientEmail,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_S,
    target_audience: audience,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(key.privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
