import { describe, expect, it } from "vitest";
import {
  CODE_CHALLENGE_METHOD,
  deriveCodeChallenge,
  generateCodeVerifier,
} from "../pkce";

describe("pkce", () => {
  it("uses the S256 method", () => {
    expect(CODE_CHALLENGE_METHOD).toBe("S256");
  });

  it("generates a high-entropy, URL-safe verifier (43 chars, no padding)", () => {
    const verifier = generateCodeVerifier();
    // 32 random bytes → 43 base64url chars, no '+', '/', or '=' padding.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeVerifier()).not.toBe(verifier);
  });

  it("derives the S256 challenge to the RFC 7636 test vector", async () => {
    // RFC 7636 Appendix B. This also pins base64url(SHA-256(verifier)) to the
    // exact bytes authn's `createHash("sha256").digest("base64url")` produces,
    // so the shell's challenge matches the server's verification.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await deriveCodeChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("derives a stable challenge for the same verifier", async () => {
    const verifier = generateCodeVerifier();
    expect(await deriveCodeChallenge(verifier)).toBe(
      await deriveCodeChallenge(verifier),
    );
  });
});
