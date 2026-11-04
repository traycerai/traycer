import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * What a packaged Google service-account key can be turned into: a token from
 * Google's documented JWT-bearer exchange, the one google-auth-library makes
 * for a key file, or a local signature over something else.
 *
 * The key and every token are credentials: nothing here logs them, and a
 * failure is reported by classification only.
 */

/** Google's OAuth token endpoint: the JWT's audience and where it is exchanged. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A Google token lives an hour; the host refreshes at 55 minutes less 5. */
const TOKEN_TTL_MS = 55 * 60 * 1000;
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/** Bounds one acquisition, as the host does, so a wedged endpoint cannot hold the cache. */
const ACQUISITION_TIMEOUT_MS = 15_000;

/** The assertion's own lifetime, Google's maximum. */
const ASSERTION_LIFETIME_S = 3600;

export interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string | null;
}

export type GoogleTokenProvider = () => Promise<string | null>;

export interface GoogleTokenOptions {
  readonly keyFilePath: string;
  /**
   * The claim saying what the token is for: `target_audience` asks for an
   * id-token, `scope` for an access token.
   */
  readonly grant: Readonly<Record<string, string>>;
  /** The member of the endpoint's answer that holds the token. */
  readonly tokenField: "id_token" | "access_token";
  /** Names the token in a warning. */
  readonly label: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Told why an acquisition failed, never with the key or a token. */
  readonly warn: (message: string) => void;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * A cached provider: one acquisition at a time, reused until five minutes
 * before its expiry. A failed acquisition answers `null` and is not cached, so
 * the next call tries again.
 */
export function createCachedGoogleToken(
  options: GoogleTokenOptions,
): GoogleTokenProvider {
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
      inflight = acquire(options)
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

async function acquire(options: GoogleTokenOptions): Promise<string | null> {
  const { label, tokenField } = options;
  const key = await readServiceAccountKey(options.keyFilePath);
  if (key === null) {
    options.warn(`${label} unavailable: the key file is unreadable`);
    return null;
  }
  let assertion: string;
  try {
    assertion = signAssertion(key, options.grant, options.now());
  } catch {
    options.warn(`${label} unavailable: the key could not sign`);
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
      `${label} unavailable: the token request never completed (${error instanceof Error ? error.name : "unknown"})`,
    );
    return null;
  }
  if (!response.ok) {
    options.warn(
      `${label} unavailable: the token endpoint answered HTTP ${response.status}`,
    );
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const token =
    typeof body === "object" && body !== null
      ? Reflect.get(body, tokenField)
      : null;
  if (typeof token !== "string" || token.length === 0) {
    options.warn(`${label} unavailable: the answer carried no ${tokenField}`);
    return null;
  }
  return token;
}

export async function readServiceAccountKey(
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

/** The service account's signed JWT-bearer assertion for what `grant` asks. */
function signAssertion(
  key: ServiceAccountKey,
  grant: Readonly<Record<string, string>>,
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
    ...grant,
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
