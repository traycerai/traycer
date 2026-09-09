import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

/**
 * A real RS256 signing key plus the JWK authn-v3 would publish for it, so the
 * bearer-verification suites drive the actual crypto rather than a stubbed
 * "is valid" answer. Shared with the auth-IPC arms in `runner-ipc.test.ts`.
 */
export interface BearerSigningKey {
  readonly kid: string;
  /** The published public JWK, tagged with its signing class. */
  readonly publicJwk: Record<string, unknown>;
  sign(payload: Record<string, unknown>): string;
}

export function createSigningKey(
  kid: string,
  signingClass: string,
): BearerSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    kid,
    publicJwk: {
      ...exportJwk(publicKey),
      kid,
      alg: "RS256",
      use: "sig",
      traycer_class: signingClass,
    },
    sign(payload) {
      const signingInput = `${encodeSegment({ alg: "RS256", typ: "JWT", kid })}.${encodeSegment(payload)}`;
      const signature = createSign("RSA-SHA256")
        .update(signingInput)
        .sign(privateKey)
        .toString("base64url");
      return `${signingInput}.${signature}`;
    },
  };
}

/** The claim set authn-v3 mints on an interactive user bearer. */
export function userBearerClaims(
  userId: string,
  expiresAtMs: number,
): Record<string, unknown> {
  return {
    id: userId,
    tokenVersion: 1,
    iss: "traycer-auth",
    aud: "traycer",
    typ: "bearer",
    exp: Math.floor(expiresAtMs / 1_000),
  };
}

export function encodeSegment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** A `fetch` double that answers one JWKS body and counts the calls. */
export function jwksResponse(
  keys: readonly Record<string, unknown>[],
): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function exportJwk(key: KeyObject): Record<string, unknown> {
  const jwk = key.export({ format: "jwk" });
  return { kty: jwk.kty, n: jwk.n, e: jwk.e };
}
