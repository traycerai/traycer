import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  voiceSessionsAvailabilityViaHttp,
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

describe("voiceSessionsAvailabilityViaHttp", () => {
  it("GETs the availability route with no body and the proxy token", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { available: true }),
    );

    const result = await voiceSessionsAvailabilityViaHttp(
      BASE,
      BEARER,
      "iap-token",
    );

    expect(result).toEqual({ kind: "ok", available: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/api/voice/availability`);
    expect(init?.method).toBe("GET");
    expect(init?.body ?? null).toBeNull();
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("proxy-authorization")).toBe("Bearer iap-token");
    expect(headers.has("content-type")).toBe(false);
  });

  it("reads available false as ok", async () => {
    stubFetch(async () => jsonResponse(200, { available: false }));

    expect(await voiceSessionsAvailabilityViaHttp(BASE, BEARER, null)).toEqual({
      kind: "ok",
      available: false,
    });
  });

  it("maps 403 to unauthorized", async () => {
    stubFetch(async () => jsonResponse(403, {}));

    expect(await voiceSessionsAvailabilityViaHttp(BASE, BEARER, null)).toEqual({
      kind: "unauthorized",
    });
  });

  it("collapses a 500 and a body without available into network-error", async () => {
    stubFetch(async () => jsonResponse(500, {}));
    expect(
      (await voiceSessionsAvailabilityViaHttp(BASE, BEARER, null)).kind,
    ).toBe("network-error");

    stubFetch(async () => jsonResponse(200, { other: true }));
    expect(
      (await voiceSessionsAvailabilityViaHttp(BASE, BEARER, null)).kind,
    ).toBe("network-error");
  });
});

describe("voiceSessionsMintViaHttp on a fetch that ignores its signal", () => {
  // VOICE_MINT_FETCH_TIMEOUT_MS
  const MINT_TIMEOUT_MS = 20_000;
  const DID_NOT_COMPLETE = {
    kind: "network-error",
    detail: "the voice session request did not complete",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles at the deadline as a network error when the request never completes", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // deadline can settle the request.
    stubFetch(() => new Promise<Response>(() => undefined));
    let settled = false;

    const pending = voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual(DID_NOT_COMPLETE);
  });

  it("settles at the deadline as a network error when a 200 body never arrives", async () => {
    const response = new Response(null, { status: 200 });
    const text = vi
      .spyOn(response, "text")
      .mockImplementation(() => new Promise<string>(() => undefined));
    stubFetch(async () => response);
    let settled = false;

    const pending = voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST);
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS - 1);
    expect(text).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual(DID_NOT_COMPLETE);
  });
});
