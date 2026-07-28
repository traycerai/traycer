import { describe, expect, it } from "vitest";
import {
  listUserSessionsResponseSchema,
  mintHostCredentialResponseSchema,
  verifyStepUpResponseSchema,
} from "../devices-sessions";

describe("devices and sessions auth DTO schemas", () => {
  it("accepts the user session list wire shape", () => {
    const parsed = listUserSessionsResponseSchema.parse({
      sessions: [
        {
          familyId: "family-1",
          clientKind: "desktop",
          displayLabel: "Traycer on Mac",
          platform: "macOS",
          appVersion: "1.2.3",
          location: "Ahmedabad, Gujarat, IN",
          createdAt: "2026-07-01T00:00:00.000Z",
          lastSeenAt: "2026-07-08T00:00:00.000Z",
          revoked: false,
          revokedAt: null,
          revokedBy: null,
          current: true,
        },
      ],
    });

    expect(parsed.sessions[0]?.familyId).toBe("family-1");
  });

  it("rejects unexpected fields so account-security contract drift fails closed", () => {
    expect(() =>
      verifyStepUpResponseSchema.parse({
        access_token: "token",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "not-part-of-step-up",
      }),
    ).toThrow();
  });

  /**
   * Phase-3 host adoption orders by `(provisionedAt, familyId)`, never the
   * access token's `iat`. Phase 2 can only pin that the mint response schema
   * carries a parseable `provisionedAt` and fails closed otherwise.
   */
  describe("mintHostCredentialResponseSchema", () => {
    const validBody = {
      token: "host-access-jws",
      refreshToken: "host-refresh-jwe",
      familyId: "family-host-1",
      hostId: "host-abc",
      expiresIn: 900,
      provisionedAt: "2026-07-08T12:00:00.123Z",
    };

    it("accepts a body that carries provisionedAt and familyId (the adoption tuple)", () => {
      const parsed = mintHostCredentialResponseSchema.parse(validBody);
      expect(parsed.provisionedAt).toBe("2026-07-08T12:00:00.123Z");
      expect(parsed.familyId).toBe("family-host-1");
      expect(Number.isNaN(Date.parse(parsed.provisionedAt))).toBe(false);
    });

    it("rejects an unparseable provisionedAt so a stuck host cannot adopt NaN ordering", () => {
      const result = mintHostCredentialResponseSchema.safeParse({
        ...validBody,
        provisionedAt: "not-a-timestamp",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a body missing provisionedAt", () => {
      const { provisionedAt: _drop, ...without } = validBody;
      void _drop;
      expect(mintHostCredentialResponseSchema.safeParse(without).success).toBe(
        false,
      );
    });
  });
});
