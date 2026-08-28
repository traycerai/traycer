import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listUserSessionsViaHttp,
  mintHostCredentialViaHttp,
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
    // Typed args (not `vi.fn(async () => …)`) so `mock.calls[0]` is a real
    // [url, init] tuple rather than `[]` — the assertions below read both.
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        jsonResponse(200, sessionListBody()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listUserSessionsViaHttp(AUTHN, "jwt-abc", null);

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

  it("aborts the session-list request when the reader's signal aborts", async () => {
    // The in-process shells (browser/dev) own this request, so a cancelled
    // read must abort the real fetch rather than just discard its reply. The
    // per-call timeout has to survive alongside it.
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit | undefined) => {
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        });
        return jsonResponse(200, sessionListBody());
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const pending = listUserSessionsViaHttp(
      AUTHN,
      "jwt-abc",
      controller.signal,
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal?.aborted).toBe(false);

    controller.abort();

    expect(init?.signal?.aborted).toBe(true);
    // An abort is indistinguishable from any other transport failure here; the
    // only caller re-checks its own signal before reading this result.
    await expect(pending).resolves.toEqual({ kind: "network-error" });
  });

  it("maps per-session 401 step_up_required to step-up-required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { reason: "step_up_required" })),
    );

    const result = await revokeUserSessionViaHttp(AUTHN, "jwt", "family-1");

    expect(result.kind).toBe("step-up-required");
  });

  it("maps global revoke 401 step_up_required to step-up-required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { reason: "step_up_required" })),
    );

    const result = await revokeAllSessionsViaHttp(AUTHN, "jwt");

    expect(result.kind).toBe("step-up-required");
  });

  it("maps invalid OTP verify responses to invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "invalid code" })),
    );

    const result = await verifyStepUpChallengeViaHttp(AUTHN, "jwt", "123456");

    expect(result.kind).toBe("invalid");
  });

  it("fails closed on a contract-violating verify success body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { access_token: "step-up" })),
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

  describe("mintHostCredentialViaHttp", () => {
    const request = {
      hostId: "host-abc",
      hostLabel: "Mac",
      platform: null,
    };

    const okBody = {
      token: "host-access-jws",
      refreshToken: "host-refresh-jwe",
      familyId: "family-host-1",
      hostId: "host-abc",
      expiresIn: 900,
      provisionedAt: "2026-07-08T12:00:00.123Z",
    };

    it("POSTs /api/v3/hosts/token and parses a provisioned response", async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit | undefined) =>
          jsonResponse(200, okBody),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await mintHostCredentialViaHttp(
        AUTHN,
        "step-up-jwt",
        request,
        null,
      );

      expect(result).toEqual({ kind: "ok", response: okBody });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://authn.example.test/api/v3/hosts/token");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer step-up-jwt",
      );
      expect(JSON.parse(String(init?.body))).toEqual(request);
    });

    it("maps 409 to superseded so the caller retries WITHOUT handoff", async () => {
      // 409 means another client won the race and its credential is already on
      // the way. Returning a body (or ok) would hand the host a retired row.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(409, { error: "superseded" })),
      );

      const result = await mintHostCredentialViaHttp(
        AUTHN,
        "jwt",
        request,
        null,
      );

      expect(result).toEqual({ kind: "superseded" });
    });

    it("maps 401 step_up_required to step-up-required", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(401, { reason: "step_up_required" })),
      );

      const result = await mintHostCredentialViaHttp(
        AUTHN,
        "jwt",
        request,
        null,
      );

      expect(result).toEqual({ kind: "step-up-required" });
    });

    it("fails closed when provisionedAt is unparseable (network-error, not ok)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(200, {
            ...okBody,
            provisionedAt: "yesterday-ish",
          }),
        ),
      );

      const result = await mintHostCredentialViaHttp(
        AUTHN,
        "jwt",
        request,
        null,
      );

      expect(result).toEqual({ kind: "network-error" });
    });

    it("maps 400 to rejected (unmintable hostId)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(400, { error: "invalid hostId" })),
      );

      const result = await mintHostCredentialViaHttp(
        AUTHN,
        "jwt",
        request,
        null,
      );

      expect(result).toEqual({ kind: "rejected" });
    });
  });
});
