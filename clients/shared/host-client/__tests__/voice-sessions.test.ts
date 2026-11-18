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
  isVoiceName,
  voiceSessionsAvailabilityViaHttp,
  voiceSessionsEndViaHttp,
  voiceSessionsMintViaHttp,
} from "../voice-sessions";

const BASE = "https://server.example.test";
const BEARER = "user-jwt";
const REQUEST = {
  offerSdp: "v=0 offer",
  input: "the briefing",
  voice: null,
  voicePolicy: null,
} as const;
const MINTED = {
  voiceSessionId: "vs_123",
  answerSdp: "v=0 answer",
  expiresAt: 1_791_000_000_000,
  acknowledgementLines: ["Okay.", "One moment.", "Got it."],
};

const CAPABILITY = {
  version: 1,
  defaultVoice: "cedar",
  voices: ["cedar", "marin"],
  exactVoiceRenewal: true,
};

describe("isVoiceName", () => {
  it.each(["cedar", "a", "voice_1-x", "0abc", "a".repeat(64)])(
    "accepts %s",
    (name) => {
      expect(isVoiceName(name)).toBe(true);
    },
  );

  it.each(["", "Cedar", "-a", "_a", "a b", "a".repeat(65), 3, null])(
    "rejects %s",
    (name) => {
      expect(isVoiceName(name)).toBe(false);
    },
  );
});

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

    expect(result).toEqual({
      kind: "ok",
      session: { ...MINTED, voiceSelection: { kind: "absent" } },
    });
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

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "Okay."],
    ["an object", {}],
    ["an array with a non-string", ["Okay.", 2]],
  ])(
    "reads a session whose acknowledgement lines are %s as one with none, keeping its id",
    async (_name, lines) => {
      stubFetch(async () =>
        jsonResponse(200, { ...MINTED, acknowledgementLines: lines }),
      );

      expect(
        await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST),
      ).toEqual({
        kind: "ok",
        session: {
          voiceSessionId: MINTED.voiceSessionId,
          answerSdp: MINTED.answerSdp,
          expiresAt: MINTED.expiresAt,
          acknowledgementLines: null,
          voiceSelection: { kind: "absent" },
        },
      });
    },
  );

  it("sends voice and voicePolicy in the body when the request names them", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, MINTED));

    await voiceSessionsMintViaHttp(BASE, BEARER, null, {
      ...REQUEST,
      voice: "marin",
      voicePolicy: "exact",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      offerSdp: REQUEST.offerSdp,
      input: REQUEST.input,
      voice: "marin",
      voicePolicy: "exact",
    });
  });

  it("sends exactly the offer and briefing when voice and voicePolicy are both null", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, MINTED));

    await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ offerSdp: REQUEST.offerSdp, input: REQUEST.input }),
    );
  });

  it("reads a 409 VOICE_SELECTION_UNAVAILABLE as voice-unavailable", async () => {
    stubFetch(async () =>
      jsonResponse(409, { error: "VOICE_SELECTION_UNAVAILABLE" }),
    );

    expect(await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).toEqual(
      { kind: "voice-unavailable" },
    );
  });

  it("reads a 409 with any other body as network-error", async () => {
    stubFetch(async () => jsonResponse(409, { error: "SOMETHING_ELSE" }));

    expect(
      (await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).kind,
    ).toBe("network-error");
  });

  it("returns a valid voice selection with the session", async () => {
    const voiceSelection = {
      kind: "valid",
      requestedVoice: "marin",
      effectiveVoice: "cedar",
      reason: "unavailable",
    };
    stubFetch(async () => jsonResponse(200, { ...MINTED, voiceSelection }));

    expect(await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).toEqual(
      { kind: "ok", session: { ...MINTED, voiceSelection } },
    );
  });

  it("accepts a valid voice selection whose requestedVoice is null", async () => {
    const voiceSelection = {
      kind: "valid",
      requestedVoice: null,
      effectiveVoice: "cedar",
      reason: "default",
    };
    stubFetch(async () => jsonResponse(200, { ...MINTED, voiceSelection }));

    expect(await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST)).toEqual(
      { kind: "ok", session: { ...MINTED, voiceSelection } },
    );
  });

  it.each([
    ["a string", "marin"],
    [
      "an unknown reason",
      { requestedVoice: null, effectiveVoice: "cedar", reason: "other" },
    ],
    [
      "an effective voice that is not a voice name",
      {
        requestedVoice: null,
        effectiveVoice: "Not A Voice",
        reason: "default",
      },
    ],
    [
      "a requested voice that is not a voice name",
      { requestedVoice: "UPPER", effectiveVoice: "cedar", reason: "selected" },
    ],
  ])(
    "keeps the core session and marks the selection invalid when it is %s",
    async (_name, voiceSelection) => {
      stubFetch(async () => jsonResponse(200, { ...MINTED, voiceSelection }));

      expect(
        await voiceSessionsMintViaHttp(BASE, BEARER, null, REQUEST),
      ).toEqual({
        kind: "ok",
        session: { ...MINTED, voiceSelection: { kind: "invalid" } },
      });
    },
  );

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

    expect(result).toEqual({
      kind: "ok",
      available: true,
      voiceSelection: null,
    });
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
      voiceSelection: null,
    });
  });

  it("returns the voice selection capability the server names", async () => {
    stubFetch(async () =>
      jsonResponse(200, { available: true, voiceSelection: CAPABILITY }),
    );

    expect(await voiceSessionsAvailabilityViaHttp(BASE, BEARER, null)).toEqual({
      kind: "ok",
      available: true,
      voiceSelection: CAPABILITY,
    });
  });

  it.each([
    ["version is not 1", { ...CAPABILITY, version: 2 }],
    [
      "exactVoiceRenewal is not true",
      { ...CAPABILITY, exactVoiceRenewal: false },
    ],
    ["voices is empty", { ...CAPABILITY, voices: [] }],
    [
      "voices has more than 256 names",
      {
        ...CAPABILITY,
        voices: Array.from({ length: 257 }, (_, i) => `voice-${i}`),
        defaultVoice: "voice-0",
      },
    ],
    [
      "a voice name is not valid",
      { ...CAPABILITY, voices: ["cedar", "Bad Name"] },
    ],
    ["voices has a duplicate", { ...CAPABILITY, voices: ["cedar", "cedar"] }],
    ["defaultVoice is not in voices", { ...CAPABILITY, defaultVoice: "verse" }],
  ])(
    "reads the capability as null and keeps available when %s",
    async (_name, voiceSelection) => {
      stubFetch(async () =>
        jsonResponse(200, { available: true, voiceSelection }),
      );

      expect(
        await voiceSessionsAvailabilityViaHttp(BASE, BEARER, null),
      ).toEqual({ kind: "ok", available: true, voiceSelection: null });
    },
  );

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
