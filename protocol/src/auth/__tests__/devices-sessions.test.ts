import { describe, expect, it } from "vitest";
import {
  listUserSessionsResponseSchema,
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
});
