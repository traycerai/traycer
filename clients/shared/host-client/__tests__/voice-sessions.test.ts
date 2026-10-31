import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  voiceSessionsEndViaHttp,
  voiceSessionsMintViaHttp,
} from "../voice-sessions";

const BASE = "https://server.example.test";
const BEARER = "user-jwt";
const REQUEST = { offerSdp: "v=0 offer", input: "the briefing" };
const MINTED = {
  voiceSessionId: "vs_123",
  answerSdp: "v=0 answer",
  expiresAt: 1_791_000_000_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(respond: () => Promise<Response>): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voiceSessionsMintViaHttp", () => {
  it("POSTs the offer and briefing with the bearer and returns the minted session", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, MINTED));

    const result = await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST);

    expect(result).toEqual({ kind: "ok", session: MINTED });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/api/voice/sessions`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      offerSdp: REQUEST.offerSdp,
      input: REQUEST.input,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.has("proxy-authorization")).toBe(false);
  });

  it("sends the proxy token as Proxy-Authorization when one is passed", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, MINTED));

    await voiceSessionsMintViaHttp(BASE, BEARER, "iap-token", REQUEST);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("proxy-authorization")).toBe("Bearer iap-token");
  });

  it.each([
    ["an empty body", ""],
    ["an empty object", "{}"],
  ])("reads a 200 with %s as dormant", async (_name, text) => {
    stubFetch(async () => new Response(text, { status: 200 }));

    expect(await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).toEqual(
      { kind: "dormant" },
    );
  });

  it.each([
    [402, { error: "VOICE_CREDITS_EXHAUSTED" }, { kind: "credits-exhausted" }],
    [502, { error: "VOICE_UNAVAILABLE" }, { kind: "unavailable" }],
    [401, { error: "nope" }, { kind: "unauthorized" }],
    [403, { error: "nope" }, { kind: "unauthorized" }],
  ])("maps HTTP %i to its kind", async (status, body, expected) => {
    stubFetch(async () => jsonResponse(status, body));

    expect(await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).toEqual(
      expected,
    );
  });

  it("collapses an unexpected status, a malformed session and a transport failure into network-error", async () => {
    stubFetch(async () => jsonResponse(500, { error: "boom" }));
    expect(
      (await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).kind,
    ).toBe("network-error");

    stubFetch(async () => jsonResponse(200, { voiceSessionId: "vs_1" }));
    expect(
      (await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).kind,
    ).toBe("network-error");

    stubFetch(async () => {
      throw new Error("offline");
    });
    expect(
      (await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).kind,
    ).toBe("network-error");
  });
});

describe("voiceSessionsEndViaHttp", () => {
  it("POSTs an empty object to the session's end path and returns closedAt", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { closedAt: 1_791_000_001_000 }),
    );

    const result = await voiceSessionsEndViaHttp(BASE, BEARER, null, "vs_123");

    expect(result).toEqual({ kind: "ok", closedAt: 1_791_000_001_000 });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/api/voice/sessions/vs_123/end`);
    expect(init?.body).toBe("{}");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${BEARER}`,
    );
  });

  it("reads VOICE_SESSION_NOT_FOUND as already closed", async () => {
    stubFetch(async () =>
      jsonResponse(404, { error: "VOICE_SESSION_NOT_FOUND" }),
    );

    expect(await voiceSessionsEndViaHttp(BASE, BEARER, null, "vs_123")).toEqual(
      { kind: "ok", closedAt: null },
    );
  });

  it("maps 401 to unauthorized and any other failure to network-error", async () => {
    stubFetch(async () => jsonResponse(401, {}));
    expect(await voiceSessionsEndViaHttp(BASE, BEARER, null, "vs_123")).toEqual(
      { kind: "unauthorized" },
    );

    stubFetch(async () => jsonResponse(500, {}));
    expect(
      (await voiceSessionsEndViaHttp(BASE, BEARER, null, "vs_123")).kind,
    ).toBe("network-error");
  });

  it("refuses an id that is not one path segment without calling the server", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));

    const result = await voiceSessionsEndViaHttp(BASE, BEARER, null, "a/b");

    expect(result.kind).toBe("network-error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
