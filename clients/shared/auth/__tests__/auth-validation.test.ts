/**
 * Tests for the abort-aware boundary auth helpers in `shared/auth/`:
 * `exchangeCodeForTokens` (PKCE code → token pair, single-attempt, no retry) and
 * `refreshOnceAbortable` (the single-attempt, ~10s, lock-budgeted refresh the
 * credentials mutation store injects as its `RefreshFn` — the ONLY /auth/refresh
 * spend primitive; its status mapping + single-attempt budget are pinned below).
 * The access-only `validateAuthTokenIdentity*` validators are consumed (and
 * mocked) by the CLI/runner-host store paths; their live `/api/v3/user` behaviour
 * runs against a faked fetch in the desktop file-token-store and gui-app
 * auth-service suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCodeForTokens,
  refreshOnceAbortable,
} from "../auth-validation";

const AUTHN_BASE_URL = "https://authn.example.test";
const EXCHANGE_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/exchange-code`;
const REFRESH_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/refresh`;

interface MockFetchCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly hasSignal: boolean;
}

interface MockSpec {
  readonly status: number;
  readonly body: unknown;
}

let originalFetch: typeof globalThis.fetch;
let calls: MockFetchCall[];

function installMockFetch(specs: ReadonlyArray<MockSpec>): MockFetchCall[] {
  let index = 0;
  const fetchMock = (async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      authorization: headers.get("Authorization"),
      hasSignal: init?.signal instanceof AbortSignal,
    });
    const spec = specs[index] ?? specs[specs.length - 1];
    index++;
    const body =
      typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    return new Response(body, {
      status: spec.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  globalThis.fetch = fetchMock;
  return calls;
}

// A real `Response` (so it stays `Response`-typed with no casts) whose body read
// rejects with a `TimeoutError` - mirrors `AbortSignal.timeout` firing during
// `response.json()`, after the status/headers have already arrived.
function responseWithAbortingBody(status: number): Response {
  const response = new Response("{}", { status });
  Object.defineProperty(response, "json", {
    value: async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  });
  return response;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("exchangeCodeForTokens - timeout without retry", () => {
  it("attaches an AbortSignal and maps a transport failure to network-error without retrying", async () => {
    let attempts = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      attempts += 1;
      calls.push({
        url: EXCHANGE_ENDPOINT,
        method: init?.method ?? "GET",
        authorization: null,
        hasSignal: init?.signal instanceof AbortSignal,
      });
      // Mirror what a fired `AbortSignal.timeout` throws into `fetch`.
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;

    const result = await exchangeCodeForTokens(
      AUTHN_BASE_URL,
      "pkce-code",
      "pkce-verifier",
    );

    expect(result.kind).toBe("network-error");
    // The PKCE code is single-use, so a lost/timed-out response must NOT be
    // replayed: exactly one attempt, unlike validation/refresh.
    expect(attempts).toBe(1);
    expect(calls[0].hasSignal).toBe(true);
  });

  it("returns the exchanged token pair on success", async () => {
    installMockFetch([
      {
        status: 200,
        body: { token: "exchanged-bearer", refreshToken: "exchanged-refresh" },
      },
    ]);

    const result = await exchangeCodeForTokens(
      AUTHN_BASE_URL,
      "pkce-code",
      "pkce-verifier",
    );

    expect(result.kind).toBe("exchanged");
    if (result.kind !== "exchanged") {
      throw new Error("expected exchanged result");
    }
    expect(result.token).toBe("exchanged-bearer");
    expect(result.refreshToken).toBe("exchanged-refresh");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(EXCHANGE_ENDPOINT);
  });

  it("maps a body-read timeout to network-error (transient), still without retrying", async () => {
    let attempts = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      attempts += 1;
      return responseWithAbortingBody(200);
    }) as typeof fetch;

    const result = await exchangeCodeForTokens(
      AUTHN_BASE_URL,
      "pkce-code",
      "pkce-verifier",
    );

    // A mid-read timeout is transient (the caller can retry the whole sign-in),
    // NOT a consumed code - so it must not be a terminal `rejected`.
    expect(result.kind).toBe("network-error");
    expect(attempts).toBe(1);
  });

  it("maps a genuinely malformed 2xx body to rejected (a parse failure stays terminal)", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("not-json{", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const result = await exchangeCodeForTokens(
      AUTHN_BASE_URL,
      "pkce-code",
      "pkce-verifier",
    );

    // A SyntaxError from response.json() is NOT an abort/timeout, so it stays a
    // terminal `rejected` - proving the transient/terminal distinction holds.
    expect(result.kind).toBe("rejected");
  });
});

describe("refreshOnceAbortable", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns network-error when the caller supplies a pre-aborted AbortSignal", async () => {
    // Production currently only passes `signal: null` (FileTokenStore + mock),
    // so the `AbortSignal.any([caller, timeout])` combine branch is otherwise
    // dormant. A pre-aborted signal exercises that path: fetch throws →
    // network-error (nothing spent).
    let fetchCalls = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      fetchCalls += 1;
      // Mirror real fetch: a pre-aborted signal rejects immediately.
      if (init?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(JSON.stringify({ token: "t", refreshToken: "r" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await refreshOnceAbortable({
      authnBaseUrl: AUTHN_BASE_URL,
      token: "access",
      refreshToken: "refresh",
      signal: AbortSignal.abort(),
    });

    expect(result).toEqual({ kind: "network-error" });
    // The aborted signal may short-circuit before fetch is invoked, or fetch
    // may be called and reject — either way nothing is spent (no refreshed pair).
    expect(fetchCalls === 0 || fetchCalls === 1).toBe(true);
  });

  it("returns the rotated pair on a 200 — a single POST, one spend", async () => {
    installMockFetch([
      {
        status: 200,
        body: { token: "rotated-bearer", refreshToken: "rotated-refresh" },
      },
    ]);

    const result = await refreshOnceAbortable({
      authnBaseUrl: AUTHN_BASE_URL,
      token: "stale-bearer",
      refreshToken: "stale-refresh",
      signal: null,
    });

    expect(result).toEqual({
      kind: "refreshed",
      token: "rotated-bearer",
      refreshToken: "rotated-refresh",
    });
    // Exactly one POST to /auth/refresh — the single-spend budget.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(REFRESH_ENDPOINT);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].authorization).toBe("Bearer stale-bearer");
  });

  it("maps a 409 refresh-grace race to network-error WITHOUT retrying", async () => {
    // A 409 means a concurrent refresher won the grace window: transient
    // (retriable under a FRESH lock), NOT a dead credential — it must map to
    // network-error, never `rejected` (which would sign the session out). And
    // unlike the retired multi-attempt helper, this single-attempt primitive must
    // NOT re-POST: a retry inside the lock would blow the lock-hold budget.
    installMockFetch([{ status: 409, body: { error: "in progress" } }]);

    const result = await refreshOnceAbortable({
      authnBaseUrl: AUTHN_BASE_URL,
      token: "stale-bearer",
      refreshToken: "stale-refresh",
      signal: null,
    });

    expect(result).toEqual({ kind: "network-error" });
    expect(calls).toHaveLength(1);
  });

  it("maps a 401 to rejected (dead refresh credential) in a single attempt", async () => {
    installMockFetch([{ status: 401, body: { error: "Unauthorized" } }]);

    const result = await refreshOnceAbortable({
      authnBaseUrl: AUTHN_BASE_URL,
      token: "stale-bearer",
      refreshToken: "dead-refresh",
      signal: null,
    });

    expect(result).toEqual({ kind: "rejected" });
    expect(calls).toHaveLength(1);
  });

  it("makes exactly one attempt on a transient 5xx (no retry → no double-spend)", async () => {
    // installMockFetch replays the last spec for every call, so a retry would
    // surface as calls.length > 1. The single-attempt property is what keeps a
    // refresh inside the lock-hold budget.
    installMockFetch([{ status: 503, body: { error: "unavailable" } }]);

    const result = await refreshOnceAbortable({
      authnBaseUrl: AUTHN_BASE_URL,
      token: "stale-bearer",
      refreshToken: "stale-refresh",
      signal: null,
    });

    expect(result).toEqual({ kind: "network-error" });
    expect(calls).toHaveLength(1);
  });
});
