import { describe, expect, it } from "vitest";
import { parseStoredCredentials } from "@traycer-clients/webapp/web-token-store";

/**
 * The decoder in isolation, which is where the "signed out" answer is
 * MANUFACTURED. Everything downstream reads `null` as signed out, so a record
 * this function accepts is a record the shell will try to use - and the only
 * place to refuse one that cannot work is here, before a round trip is spent
 * proving it.
 */
function credentialRecord(
  overrides: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({
    token: "access-token",
    refreshToken: "refresh-token",
    savedAt: "2026-08-28T00:00:00.000Z",
    user: { id: "user-1", email: "a@b.test", name: "A" },
    ...overrides,
  });
}

describe("parseStoredCredentials", () => {
  it("accepts a complete record", () => {
    const parsed = parseStoredCredentials(credentialRecord({}));

    expect(parsed?.token).toBe("access-token");
    expect(parsed?.refreshToken).toBe("refresh-token");
    expect(parsed?.user.id).toBe("user-1");
  });

  it("rejects a record whose refresh token is empty", () => {
    // Not a shape complaint: a credential with no refresh token cannot
    // rotate, so accepting it costs a round trip to authn and then signs the
    // tab out anyway (`rotate` -> `refresh-rejected`). Refusing it here lands
    // the visitor on sign-in directly, which is the same destination.
    expect(parseStoredCredentials(credentialRecord({ refreshToken: "" }))).toBe(
      null,
    );
  });

  it("rejects a record whose access token is empty", () => {
    expect(parseStoredCredentials(credentialRecord({ token: "" }))).toBe(null);
  });

  it("rejects absent bytes and undecodable bytes alike", () => {
    expect(parseStoredCredentials(null)).toBe(null);
    expect(parseStoredCredentials("{not json")).toBe(null);
    expect(parseStoredCredentials("[]")).toBe(null);
  });

  it("rejects a record missing its identity", () => {
    expect(parseStoredCredentials(credentialRecord({ user: null }))).toBe(null);
  });
});
