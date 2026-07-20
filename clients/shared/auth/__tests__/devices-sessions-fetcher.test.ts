import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listUserSessionsViaHttp,
  revokeAllSessionsViaHttp,
  revokeUserSessionViaHttp,
  toRetainedStepUpVerifyResult,
  verifyStepUpChallengeViaHttp,
} from "../devices-sessions-fetcher";

const AUTHN = "https://authn.example.test";

function sessionListBody() {
  return {
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
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("devices/sessions authn fetcher", () => {
  it("GETs /api/v3/user/sessions with the user bearer and parses the session list", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, sessionListBody()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listUserSessionsViaHttp(AUTHN, "jwt-abc");

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.response.sessions[0]?.familyId).toBe("family-1");
    }
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://authn.example.test/api/v3/user/sessions");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-abc",
    );
  });

  it("maps per-session 401 step_up_required to step-up-required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(401, { reason: "step_up_required" }),
      ),
    );

    const result = await revokeUserSessionViaHttp(AUTHN, "jwt", "family-1");

    expect(result.kind).toBe("step-up-required");
  });

  it("maps global revoke 401 step_up_required to step-up-required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(401, { reason: "step_up_required" }),
      ),
    );

    const result = await revokeAllSessionsViaHttp(AUTHN, "jwt");

    expect(result.kind).toBe("step-up-required");
  });

  it("maps invalid OTP verify responses to invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(400, { error: "invalid code" }),
      ),
    );

    const result = await verifyStepUpChallengeViaHttp(AUTHN, "jwt", "123456");

    expect(result.kind).toBe("invalid");
  });

  it("fails closed on a contract-violating verify success body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(200, { access_token: "step-up" }),
      ),
    );

    const result = await verifyStepUpChallengeViaHttp(AUTHN, "jwt", "123456");

    expect(result.kind).toBe("network-error");
  });

  it("strips the raw step-up bearer from retained verify results", () => {
    expect(
      toRetainedStepUpVerifyResult({
        kind: "ok",
        response: {
          access_token: "step-up-secret",
          token_type: "Bearer",
          expires_in: 900,
        },
      }),
    ).toEqual({
      kind: "ok",
      response: { expires_in: 900 },
    });
  });
});
