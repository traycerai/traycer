import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintHostTokenViaHttp,
  mintRelayPassWithHostTokenViaHttp,
} from "../grant-client";

const BASE_URL = "https://authn.test";
const HOST_ID = "computer-a";
const SIGN_IN_TOKEN = "sign-in-secret";

interface RequestCapture {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

function stubResponse(status: number, body: unknown): RequestCapture[] {
  const calls: RequestCapture[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function requestUrl(capture: RequestCapture): string {
  return capture.input instanceof Request
    ? capture.input.url
    : capture.input.toString();
}

describe("host-only token mint response mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps session-grant refusals without exposing their response body in the warning", async () => {
    const membership = stubResponse(403, { code: "team_membership_required" });
    expect(
      await mintHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN, null),
    ).toEqual({ kind: "not-a-member" });
    expect(requestUrl(membership[0])).toBe(
      `${BASE_URL}/api/v3/hosts/${HOST_ID}/session-grant`,
    );
    expect(membership[0].init?.body).toBeUndefined();

    stubResponse(404, { private: "body is ignored" });
    expect(
      await mintHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN, null),
    ).toEqual({ kind: "not-admitted" });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubResponse(403, { code: "remote_access_off", token: "private" });
    expect(
      await mintHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN, null),
    ).toEqual({ kind: "not-admitted" });
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0][0]).toContain("HTTP 403");
    expect(warning.mock.calls[0][0]).not.toContain("remote_access_off");
  });

  it("maps rejected sign-in, frozen sandbox and unavailable authn answers", async () => {
    stubResponse(401, {});
    expect(
      await mintHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN, null),
    ).toEqual({ kind: "sign-in-rejected" });

    stubResponse(402, { code: "sandbox_frozen" });
    expect(
      await mintHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN, null),
    ).toEqual({ kind: "sandbox-frozen" });

    stubResponse(503, {});
    expect(
      await mintHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN, null),
    ).toEqual({ kind: "unavailable", detail: "authn answered HTTP 503" });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(
      await mintHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN, null),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("mints a host token with an empty session-grant request body", async () => {
    const calls = stubResponse(200, {
      session_grant: "host-token-a",
      session_grant_expires_in: 300,
    });
    const result = await mintHostTokenViaHttp(
      BASE_URL,
      HOST_ID,
      SIGN_IN_TOKEN,
      null,
    );

    expect(result).toMatchObject({
      kind: "ok",
      token: { token: "host-token-a" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.body).toBeUndefined();
    expect(requestUrl(calls[0])).toContain("/session-grant");
  });

  it("sends only the attach role and session-grant version, and accepts both returned credentials", async () => {
    const calls = stubResponse(200, {
      grant: "relay-pass-a",
      expires_in: 60,
      session_grant: "host-token-a",
      session_grant_expires_in: 300,
    });
    const result = await mintRelayPassWithHostTokenViaHttp(
      BASE_URL,
      HOST_ID,
      SIGN_IN_TOKEN,
    );

    expect(result).toMatchObject({
      kind: "ok",
      grant: { grant: "relay-pass-a", expiresInSeconds: 60 },
      hostToken: { token: "host-token-a" },
    });
    expect(calls).toHaveLength(1);
    expect(requestUrl(calls[0])).toContain("/attach-grant");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      role: "client",
      session_grant_version: 2,
    });
  });

  it("keeps an attach-grant 403 on the existing refusal path", async () => {
    stubResponse(403, { code: "remote_access_off" });
    expect(
      await mintRelayPassWithHostTokenViaHttp(BASE_URL, HOST_ID, SIGN_IN_TOKEN),
    ).toMatchObject({ kind: "as-today", provision: { kind: "unavailable" } });
  });
});
