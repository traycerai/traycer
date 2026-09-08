import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import type { DesktopAuthSessionRefusalReason } from "../../ipc-contracts/window-types";

/**
 * Local verification of the renderer-supplied user bearer, before main is
 * willing to speak for it.
 *
 * Main derives the jar plane's bearer and userId from the desktop auth
 * session, and the only writer of that session is an IPC any renderer can
 * call. Shape-parsing the snapshot is not identity: an XSS that pushes its
 * own valid Traycer token names its own host directory and gets the victim's
 * jar answered to it. So the token is verified HERE, at the set, because the
 * consumption sites (`bridge.authSession.get()`) are exactly the places where
 * the evidence is no longer around.
 *
 * The checks mirror the host's - `traycer-host/src/transport/rpc/auth/
 * host-access-token.ts` and `jwks-key-source.ts`: RS256 only (so `alg: none`
 * and HMAC-with-a-public-key are refused), the `kid` resolved ONLY against
 * authn-v3's `bearer`-class JWKS partition (a leaked attach-grant/service key
 * must not verify a bearer), `iss`/`aud` pinned as the host pins them, `exp`
 * in the future, and the `id` claim equal to the profile the renderer sent.
 *
 * It is hand-rolled on `node:crypto` rather than reusing the host's verifier:
 * that code lives in `traycer-host` and leans on `jose` and
 * `@traycerai/common`, none of which the OSS desktop workspace can import.
 * What it deliberately does NOT carry over is the host's persisted-JWKS
 * fallback: the renderer cannot obtain a bearer at all without reaching
 * authn-v3, so an unreachable key source here refuses a set that could not
 * have been minted offline either, rather than locking out a working session.
 */

/** authn-v3's `TOKEN_ISSUER` / `TOKEN_AUDIENCE` for the interactive bearer. */
const TOKEN_ISSUER = "traycer-auth";
const TOKEN_AUDIENCE = "traycer";
/** authn-v3's `SIGNING_KEY_CLASS.bearer` tag on a published JWK. */
const BEARER_SIGNING_CLASS = "bearer";
const BEARER_ALGORITHM = "RS256";
const JWKS_PATH = "/api/jwks";
/** Same tolerances the host runs with. */
const CLOCK_TOLERANCE_MS = 30_000;
const JWKS_MAX_AGE_MS = 10 * 60_000;
const JWKS_REFETCH_COOLDOWN_MS = 60_000;
const JWKS_TIMEOUT_MS = 3_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DesktopBearerVerifierConfig {
  /** Where authn-v3 lives; `/api/jwks` is resolved against it. */
  readonly authnBaseUrl: string;
  readonly fetchImpl: FetchLike;
  readonly now: () => number;
}

export interface DesktopBearerVerifier {
  /**
   * `null` when the token is authentic AND belongs to `expectedUserId`;
   * otherwise the reason it is not, which is the only thing about a refused
   * token that may be logged.
   */
  verify(
    token: string,
    expectedUserId: string,
  ): Promise<DesktopAuthSessionRefusalReason | null>;
}

const jwkSchema = z.object({
  kid: z.string().min(1),
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
  // Required, not merely honoured: an untagged key is NOT bearer-class, for
  // the same reason the host says so - treating it as one restores the
  // full-set matching the class partition exists to remove.
  traycer_class: z.string(),
});

const jwksBodySchema = z.object({ keys: z.array(z.unknown()).min(1) });

const headerSchema = z.object({ alg: z.string(), kid: z.string().min(1) });

const claimsSchema = z.object({
  id: z.string().min(1),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
});

export function createDesktopBearerVerifier(
  config: DesktopBearerVerifierConfig,
): DesktopBearerVerifier {
  const jwksUrl = new URL(JWKS_PATH, config.authnBaseUrl).toString();
  let keys: ReadonlyMap<string, KeyObject> | null = null;
  let fetchedAtMs = 0;
  let lastAttemptAtMs = Number.NEGATIVE_INFINITY;
  /** Whether the most recent fetch ATTEMPT failed - see {@link resolveKey}. */
  let lastAttemptFailed = false;

  async function fetchBearerKeys(): Promise<ReadonlyMap<string, KeyObject>> {
    const response = await config.fetchImpl(jwksUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`JWKS fetch returned status ${response.status}`);
    }
    const body = jwksBodySchema.parse(await response.json());
    const parsed = new Map<string, KeyObject>();
    for (const raw of body.keys) {
      const key = jwkSchema.safeParse(raw);
      if (!key.success || key.data.traycer_class !== BEARER_SIGNING_CLASS) {
        continue;
      }
      // Guarded per key rather than per response: `jwkSchema` proves `n` and
      // `e` are non-empty strings, not that they are valid base64url RSA
      // parameters, and `createPublicKey` throws on one that is not. An
      // uncaught throw here leaves the loop and rejects `fetchBearerKeys`, so
      // one malformed entry would discard every other bearer-class key in the
      // same response and turn a partial publish into a total refusal.
      try {
        parsed.set(
          key.data.kid,
          createPublicKey({
            key: { kty: "RSA", n: key.data.n, e: key.data.e },
            format: "jwk",
          }),
        );
      } catch {
        // Skipped, not fatal. If it was the only key, `parsed.size === 0`
        // below still makes this a failed fetch rather than a verdict.
      }
    }
    if (parsed.size === 0) {
      // Every published key was of another class, so this response verifies
      // nothing. A failed fetch, not an answer: it must not overwrite a good
      // prior set nor become a verdict against every token.
      throw new Error("JWKS carried no bearer-class signing keys");
    }
    return parsed;
  }

  async function refresh(force: boolean): Promise<void> {
    const nowMs = config.now();
    if (keys !== null && !force && nowMs - fetchedAtMs < JWKS_MAX_AGE_MS) {
      // A set inside its max age was confirmed live when it was fetched, so
      // its silence about a `kid` is an ANSWER again - even if a later refetch
      // attempt failed in between.
      lastAttemptFailed = false;
      return;
    }
    // The cooldown applies from the FIRST attempt, cache or no cache:
    // otherwise a cold start with authn down costs two fetches per verify,
    // and a renderer looping the IPC is an amplifier onto authn.
    if (nowMs - lastAttemptAtMs < JWKS_REFETCH_COOLDOWN_MS) {
      return;
    }
    lastAttemptAtMs = nowMs;
    try {
      keys = await fetchBearerKeys();
      fetchedAtMs = nowMs;
      lastAttemptFailed = false;
    } catch {
      // Keep serving the stale set: it is public key material, and a network
      // blip must not turn every token into a forgery.
      lastAttemptFailed = true;
    }
  }

  async function resolveKey(
    kid: string,
  ): Promise<KeyObject | DesktopAuthSessionRefusalReason> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // The second pass forces a refetch: an unrecognized `kid` is what a key
      // rotated in since the last fetch looks like.
      await refresh(attempt === 1);
      const key = keys === null ? undefined : keys.get(kid);
      if (key !== undefined) {
        return key;
      }
    }
    // "Not in the set" is only an ANSWER when the set was confirmed live.
    return keys !== null && !lastAttemptFailed
      ? "unknown-signing-key"
      : "key-source-unavailable";
  }

  return {
    async verify(token, expectedUserId) {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return "malformed-token";
      }
      const [headerPart, payloadPart, signaturePart] = parts;
      const header = decodeSegment(headerPart, headerSchema);
      if (header === null) {
        return "malformed-token";
      }
      if (header.alg !== BEARER_ALGORITHM) {
        return "unsupported-algorithm";
      }
      const claims = decodeSegment(payloadPart, claimsSchema);
      if (claims === null) {
        return "malformed-token";
      }
      const key = await resolveKey(header.kid);
      if (typeof key === "string") {
        return key;
      }
      const authentic = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
        key,
        Buffer.from(signaturePart, "base64url"),
      );
      if (!authentic) {
        return "bad-signature";
      }
      if (claims.exp * 1_000 + CLOCK_TOLERANCE_MS <= config.now()) {
        return "expired";
      }
      if (claims.iss !== TOKEN_ISSUER) {
        return "issuer-mismatch";
      }
      const audiences =
        typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (!audiences.includes(TOKEN_AUDIENCE)) {
        return "audience-mismatch";
      }
      if (claims.id !== expectedUserId) {
        return "subject-mismatch";
      }
      return null;
    },
  };
}

function decodeSegment<T>(segment: string, schema: z.ZodType<T>): T | null {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    );
    const parsed = schema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
