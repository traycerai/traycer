import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProfileRecordEnabledViaHttp } from "../provider-profile-enablement";

const AUTHN = "https://authn.example.test/";
const ENVIRONMENT_ID = "environment-1";
const HARNESS_ID = "claude-code";
const PROFILE_ID = "profile-1";
const ITEM_KEY = `${HARNESS_ID}:${PROFILE_ID}`;

const managedProfile = {
  kind: "managed_profile",
  key: ITEM_KEY,
  os: "linux",
  value: {
    enabled: true,
    displayName: "Account",
    retained: { source: "person" },
  },
  revision: 17,
};

function response(status: number, body: string): Response {
  return new Response(status === 204 ? null : body, { status });
}

function fetchMockFor(...responses: Response[]) {
  const queue = [...responses];
  return vi.fn((_input: RequestInfo | URL, _init: RequestInit | undefined) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("Unexpected fetch request");
    return Promise.resolve(next);
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setProfileRecordEnabledViaHttp", () => {
  it("preserves item fields and accepts a bodyless 204 write", async () => {
    const fetchMock = fetchMockFor(
      response(200, JSON.stringify({ items: [managedProfile] })),
      response(204, ""),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await setProfileRecordEnabledViaHttp(
      AUTHN,
      "session-token",
      ENVIRONMENT_ID,
      HARNESS_ID,
      PROFILE_ID,
      false,
      null,
    );

    expect(result).toEqual({ kind: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://authn.example.test/api/v3/environments/environment-1/items?kind=managed_profile",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    const [writeUrl, writeInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(writeUrl)).toBe(
      "https://authn.example.test/api/v3/environments/environment-1/items/managed_profile",
    );
    expect(writeInit.method).toBe("PUT");
    expect(JSON.parse(String(writeInit.body))).toEqual({
      key: ITEM_KEY,
      os: null,
      value: {
        enabled: false,
        displayName: "Account",
        retained: { source: "person" },
      },
      revision: 17,
      upload: null,
    });
    expect(new Headers(writeInit.headers).get("Authorization")).toBe(
      "Bearer session-token",
    );
  });

  it.each([
    { stage: "GET", status: 403, expected: "forbidden" },
    { stage: "GET", status: 409, expected: "failed" },
    { stage: "PUT", status: 403, expected: "forbidden" },
    { stage: "PUT", status: 409, expected: "conflict" },
  ] as const)(
    "maps $stage refusal $status without retry",
    async ({ stage, status, expected }) => {
      const fetchMock =
        stage === "GET"
          ? fetchMockFor(response(status, ""))
          : fetchMockFor(
              response(200, JSON.stringify({ items: [managedProfile] })),
              response(status, "refusal detail"),
            );
      vi.stubGlobal("fetch", fetchMock);

      const result = await setProfileRecordEnabledViaHttp(
        AUTHN,
        "session-token",
        ENVIRONMENT_ID,
        HARNESS_ID,
        PROFILE_ID,
        false,
        null,
      );

      expect(result).toEqual({ kind: expected });
      expect(fetchMock).toHaveBeenCalledTimes(stage === "GET" ? 1 : 2);
    },
  );

  it("reports a missing item as a conflict and does not write", async () => {
    const fetchMock = fetchMockFor(
      response(200, JSON.stringify({ items: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await setProfileRecordEnabledViaHttp(
      AUTHN,
      "session-token",
      ENVIRONMENT_ID,
      HARNESS_ID,
      PROFILE_ID,
      false,
      null,
    );

    expect(result).toEqual({ kind: "conflict" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails without writing when the matched item's value is not an object", async () => {
    const fetchMock = fetchMockFor(
      response(
        200,
        JSON.stringify({
          items: [{ ...managedProfile, value: "scalar" }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await setProfileRecordEnabledViaHttp(
      AUTHN,
      "session-token",
      ENVIRONMENT_ID,
      HARNESS_ID,
      PROFILE_ID,
      false,
      null,
    );

    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates only the matched item's object value and adds enabled", async () => {
    const profileWithoutEnabled = {
      kind: "managed_profile",
      key: ITEM_KEY,
      os: "linux",
      value: { displayName: "Account", retained: { source: "person" } },
      revision: 18,
    };
    const unrelatedScalarItem = {
      kind: "managed_profile",
      key: "other-harness:other-profile",
      value: "scalar",
      revision: 19,
    };
    const fetchMock = fetchMockFor(
      response(
        200,
        JSON.stringify({ items: [unrelatedScalarItem, profileWithoutEnabled] }),
      ),
      response(204, ""),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await setProfileRecordEnabledViaHttp(
      AUTHN,
      "session-token",
      ENVIRONMENT_ID,
      HARNESS_ID,
      PROFILE_ID,
      false,
      null,
    );

    expect(result).toEqual({ kind: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, writeInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(JSON.parse(String(writeInit.body))).toEqual({
      key: ITEM_KEY,
      os: null,
      value: {
        displayName: "Account",
        retained: { source: "person" },
        enabled: false,
      },
      revision: 18,
      upload: null,
    });
  });

  it("returns only the failed result for malformed bodies and fetch errors", async () => {
    const malformedFetch = fetchMockFor(
      response(200, "malformed response detail"),
    );
    vi.stubGlobal("fetch", malformedFetch);
    const malformed = await setProfileRecordEnabledViaHttp(
      AUTHN,
      "session-token",
      ENVIRONMENT_ID,
      HARNESS_ID,
      PROFILE_ID,
      false,
      null,
    );
    expect(malformed).toEqual({ kind: "failed" });
    expect(malformedFetch).toHaveBeenCalledTimes(1);

    const rejectedFetch = vi.fn(() =>
      Promise.reject(new Error("transport detail")),
    );
    vi.stubGlobal("fetch", rejectedFetch);
    const rejected = await setProfileRecordEnabledViaHttp(
      AUTHN,
      "session-token",
      ENVIRONMENT_ID,
      HARNESS_ID,
      PROFILE_ID,
      false,
      null,
    );
    expect(rejected).toEqual({ kind: "failed" });
    expect(rejectedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not write after the caller aborts the list request", async () => {
    const caller = new AbortController();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init: RequestInit | undefined) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("Request signal missing"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = setProfileRecordEnabledViaHttp(
      AUTHN,
      "session-token",
      ENVIRONMENT_ID,
      HARNESS_ID,
      PROFILE_ID,
      false,
      caller.signal,
    );
    caller.abort();

    const result = await pending;
    expect(result).toEqual({ kind: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
