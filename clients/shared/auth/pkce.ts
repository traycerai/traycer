/**
 * PKCE (RFC 7636, S256) helpers for the sign-in handoff.
 *
 * Browser-safe: uses the Web Crypto API on `globalThis.crypto`, which is
 * present in every shell runtime that runs this code - the Electron renderer,
 * the Capacitor webview, the web app, and Node/Bun (the CLI). The verifier is
 * generated and kept in-memory by the shell at sign-in start; only its S256
 * challenge travels in the sign-in URL, so a leaked redirect URL never exposes
 * the secret needed to exchange the auth code.
 */

export const CODE_CHALLENGE_METHOD = "S256";

function webCrypto(): Crypto {
  const c = globalThis.crypto;
  if (c === undefined || c.subtle === undefined) {
    throw new Error("Web Crypto API unavailable: cannot run the PKCE flow");
  }
  return c;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  // base64url: '+'→'-', '/'→'_', strip '=' padding (matches Node's
  // `digest("base64url")` on the authn side so the challenge bytes match).
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A high-entropy, URL-safe `code_verifier` (43 chars from 32 random bytes). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  webCrypto().getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * The S256 `code_challenge` for `verifier`: `base64url(SHA-256(verifier))`.
 * Must match authn's `createHash("sha256").update(verifier).digest("base64url")`.
 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await webCrypto().subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}
