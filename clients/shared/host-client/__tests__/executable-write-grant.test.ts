import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXECUTABLE_WRITE_GRANT_FETCH_TIMEOUT_MS,
  mintExecutableWriteGrantViaHttp,
} from "../executable-write-grant";

const AUTHN = "https://authn.example.invalid";
const TOKEN = "bearer-token-1";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "env_01JABCDEFGHJKMNPQRSTVWXYZ0";
const LEGACY_UUID_ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const RAW_BODY_MARKER = "RAW-SERVER-BODY-MARKER";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

interface Answer {
  readonly status: number;
  readonly body: string;
}

function json(status: number, value: unknown): Answer {
  return { status, body: JSON.stringify(value) };
}

/**
 * Stubs the global `fetch` with the answers in order (one per call), and
 * records what each call carried. A call past the last answer is a test bug.
 */
function stubFetch(answers: readonly Answer[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: RequestInit): Promise<Response> => {
      calls.push({
        url,
        method: init.method ?? "GET",
        authorization: new Headers(init.headers).get("authorization"),
        body: typeof init.body === "string" ? init.body : null,
      });
      const answer = answers[calls.length - 1];
      if (answer === undefined) {
        return Promise.reject(new Error("unexpected extra fetch"));
      }
      return Promise.resolve(
        new Response(answer.body, { status: answer.status }),
      );
    },
  );
  return calls;
}

const ME_OK = json(200, { environmentId: ENVIRONMENT_ID });
const GRANT_OK = json(200, { grant: "grant-token-1", expiresInSeconds: 600 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mintExecutableWriteGrantViaHttp", () => {
  it("answers not-bound for a host id that is not a UUID, with no request at all", async () => {
    const calls = stubFetch([]);
    const result = await mintExecutableWriteGrantViaHttp(
      AUTHN,
      TOKEN,
      "host-a",
    );
    expect(result).toEqual({ kind: "not-bound" });
    expect(calls).toEqual([]);
  });

  it("reads the environment, then mints for the host with the bearer on both calls", async () => {
    const calls = stubFetch([ME_OK, GRANT_OK]);
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({
      kind: "ok",
      grant: "grant-token-1",
      expiresInSeconds: 600,
    });
    expect(calls).toEqual([
      {
        url: `${AUTHN}/api/v3/environments/me`,
        method: "GET",
        authorization: `Bearer ${TOKEN}`,
        body: null,
      },
      {
        url: `${AUTHN}/api/v3/environments/${ENVIRONMENT_ID}/executable-write-grants`,
        method: "POST",
        authorization: `Bearer ${TOKEN}`,
        body: JSON.stringify({ hostId: HOST_ID }),
      },
    ]);
  });

  it("joins the path onto a base URL that already ends in a slash", async () => {
    const calls = stubFetch([ME_OK, GRANT_OK]);
    await mintExecutableWriteGrantViaHttp(`${AUTHN}/`, TOKEN, HOST_ID);
    expect(calls[0]?.url).toBe(`${AUTHN}/api/v3/environments/me`);
  });

  it.each([401, 403])(
    "answers unauthorized when the environment read is %i",
    async (status) => {
      const calls = stubFetch([json(status, { error: RAW_BODY_MARKER })]);
      const result = await mintExecutableWriteGrantViaHttp(
        AUTHN,
        TOKEN,
        HOST_ID,
      );
      expect(result).toEqual({ kind: "unauthorized" });
      expect(calls).toHaveLength(1);
    },
  );

  it.each([401, 403])(
    "answers unauthorized when the mint is %i",
    async (status) => {
      stubFetch([ME_OK, json(status, { error: RAW_BODY_MARKER })]);
      const result = await mintExecutableWriteGrantViaHttp(
        AUTHN,
        TOKEN,
        HOST_ID,
      );
      expect(result).toEqual({ kind: "unauthorized" });
    },
  );

  it("answers not-bound when the environment read is 404, and mints nothing", async () => {
    const calls = stubFetch([json(404, { code: "environment_not_found" })]);
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({ kind: "not-bound" });
    expect(calls).toHaveLength(1);
  });

  it("answers not-bound when the mint is 404 (the host is not bound)", async () => {
    stubFetch([ME_OK, json(404, { code: "host_not_found" })]);
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({ kind: "not-bound" });
  });

  it("answers network-error for a 500 and never repeats the server body", async () => {
    stubFetch([ME_OK, json(500, { error: RAW_BODY_MARKER })]);
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({
      kind: "network-error",
      detail: "authn answered HTTP 500",
    });
    expect(JSON.stringify(result)).not.toContain(RAW_BODY_MARKER);
  });

  it("answers network-error for a 500 on the environment read", async () => {
    const calls = stubFetch([json(500, { error: RAW_BODY_MARKER })]);
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({
      kind: "network-error",
      detail: "authn answered HTTP 500",
    });
    expect(calls).toHaveLength(1);
  });

  it("still reads a uuid environment id from an authn that predates env_ ids", async () => {
    const calls = stubFetch([
      json(200, { environmentId: LEGACY_UUID_ENVIRONMENT_ID }),
      GRANT_OK,
    ]);
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({
      kind: "ok",
      grant: "grant-token-1",
      expiresInSeconds: 600,
    });
    expect(calls[1]?.url).toBe(
      `${AUTHN}/api/v3/environments/${LEGACY_UUID_ENVIRONMENT_ID}/executable-write-grants`,
    );
  });

  it.each([
    ["an empty id", ""],
    ["a dot segment", ".."],
    ["a slash", "env_01/../x"],
    ["a percent", "env%2F01"],
    ["a space", "env 01"],
    ["an over-long id", "a".repeat(129)],
    ["a non-string id", 42],
  ])(
    "answers network-error for %s as the environment id, without echoing the body and without minting",
    async (_label, environmentId) => {
      const calls = stubFetch([
        json(200, { environmentId, note: RAW_BODY_MARKER }),
      ]);
      const result = await mintExecutableWriteGrantViaHttp(
        AUTHN,
        TOKEN,
        HOST_ID,
      );
      expect(result).toEqual({
        kind: "network-error",
        detail: "the environment answer did not match the contract",
      });
      expect(JSON.stringify(result)).not.toContain(RAW_BODY_MARKER);
      expect(calls).toHaveLength(1);
    },
  );

  it.each([
    ["an empty grant", { grant: "", expiresInSeconds: 600 }],
    ["a non-numeric lifetime", { grant: "g", expiresInSeconds: "600" }],
    ["a zero lifetime", { grant: "g", expiresInSeconds: 0 }],
    ["a missing grant", { expiresInSeconds: 600, note: RAW_BODY_MARKER }],
  ])(
    "answers network-error for a grant body with %s, without echoing it",
    async (_label, body) => {
      stubFetch([ME_OK, json(200, body)]);
      const result = await mintExecutableWriteGrantViaHttp(
        AUTHN,
        TOKEN,
        HOST_ID,
      );
      expect(result).toEqual({
        kind: "network-error",
        detail: "the grant answer did not match the contract",
      });
      expect(JSON.stringify(result)).not.toContain(RAW_BODY_MARKER);
    },
  );

  it("answers network-error for a 200 whose body is not JSON, without echoing it", async () => {
    stubFetch([
      ME_OK,
      { status: 200, body: `<html>${RAW_BODY_MARKER}</html>` },
    ]);
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result.kind).toBe("network-error");
    expect(JSON.stringify(result)).not.toContain(RAW_BODY_MARKER);
  });

  it("answers network-error when fetch throws, naming only the error class", async () => {
    vi.stubGlobal("fetch", (): Promise<Response> => {
      return Promise.reject(new TypeError(`connect failed ${RAW_BODY_MARKER}`));
    });
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
    expect(JSON.stringify(result)).not.toContain(RAW_BODY_MARKER);
  });

  it("answers network-error when the mint call throws after a good environment read", async () => {
    let call = 0;
    vi.stubGlobal("fetch", (): Promise<Response> => {
      call += 1;
      return call === 1
        ? Promise.resolve(new Response(ME_OK.body, { status: 200 }))
        : Promise.reject(new Error("socket hang up"));
    });
    const result = await mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    expect(result).toEqual({
      kind: "network-error",
      detail: "the request never completed (Error)",
    });
  });
});

describe("mintExecutableWriteGrantViaHttp on a fetch that ignores its signal", () => {
  const TIMED_OUT = {
    kind: "network-error",
    detail: "the request never completed (TimeoutError)",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The environment lookup answers; the mint is the call under test. */
  function stubMintAfterEnvironment(mint: Promise<Response>): void {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      new Response(ME_OK.body, { status: ME_OK.status }),
    );
    fetchMock.mockReturnValueOnce(mint);
    vi.stubGlobal("fetch", fetchMock);
  }

  it("settles the mint at the deadline as a network error when the request never completes", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // deadline can settle the request.
    stubMintAfterEnvironment(new Promise<Response>(() => undefined));
    let settled = false;

    const pending = mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(
      EXECUTABLE_WRITE_GRANT_FETCH_TIMEOUT_MS - 1,
    );
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual(TIMED_OUT);
  });

  it("settles the mint at the deadline as a network error when a 200 body never arrives", async () => {
    const response = new Response(null, { status: 200 });
    const text = vi
      .spyOn(response, "text")
      .mockImplementation(() => new Promise<string>(() => undefined));
    stubMintAfterEnvironment(Promise.resolve(response));
    let settled = false;

    const pending = mintExecutableWriteGrantViaHttp(AUTHN, TOKEN, HOST_ID);
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(
      EXECUTABLE_WRITE_GRANT_FETCH_TIMEOUT_MS - 1,
    );
    expect(text).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual(TIMED_OUT);
  });
});
