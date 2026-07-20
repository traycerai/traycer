/**
 * Tests for the boundary auth-validation helpers in `shared/auth/`.
 *
 * The narrow-profile path (`validateAuthTokenViaHttp`) is exercised
 * indirectly through runner-host implementations elsewhere; this suite
 * pins the new full-identity path (`validateAuthTokenIdentityViaHttp`),
 * which returns a complete `AuthenticatedUser` so the client
 * `RequestContextProvider` can mint a context whose identity shape
 * matches host-minted contexts. Spec: aca3ac84 §1.10 / §3.1 / §4
 * "Token validation/refresh preserves full AuthenticatedUser when minting
 * or updating client contexts."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  exchangeCodeForTokens,
  refreshAuthTokenViaHttp,
  validateAuthTokenViaHttp,
  validateAuthTokenIdentityViaHttp,
  type AuthIdentityValidationResult,
} from "../auth-validation";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";

const AUTHN_BASE_URL = "https://authn.example.test";
const USER_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/user`;
const REFRESH_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/refresh`;
const EXCHANGE_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/exchange-code`;

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

function serializeAuthenticatedUserForHttp(): unknown {
  const user = createAuthenticatedUserFixture({});
  return JSON.parse(JSON.stringify(user));
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

describe("validateAuthTokenIdentityViaHttp - full AuthenticatedUser", () => {
  it("returns the parsed full AuthenticatedUser on a successful lookup", async () => {
    const userBody = serializeAuthenticatedUserForHttp();
    installMockFetch([{ status: 200, body: userBody }]);

    const result = await validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer-token",
      "bearer-token-refresh",
    );

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") {
      throw new Error("expected valid result");
    }
    expect(result.user.user.id).toBe("user-fixture-1");
    expect(result.user.user.providerHandle).toBe("testuser");
    expect(result.user.userSubscription.id).toBe("sub-fixture-1");
    expect(result.user.payAsYouGoUsage.allowPayAsYouGo).toBe(false);
    expect(result.user.teamSubscriptions).toEqual([]);
    expect(
      (result as AuthIdentityValidationResult & { refreshedToken?: string })
        .refreshedToken,
    ).toBeUndefined();
  });

  it("calls /api/v3/user with the supplied bearer", async () => {
    installMockFetch([
      { status: 200, body: serializeAuthenticatedUserForHttp() },
    ]);

    await validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer-1",
      "bearer-1-refresh",
    );

    expect(calls[0].url).toBe(USER_ENDPOINT);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].authorization).toBe("Bearer bearer-1");
  });

  it("refreshes once on initial 401 and reports the rotated bearer", async () => {
    const userBody = serializeAuthenticatedUserForHttp();
    installMockFetch([
      { status: 401, body: { error: "Unauthorized" } },
      {
        status: 200,
        body: { token: "rotated-bearer", refreshToken: "rotated-refresh" },
      },
      { status: 200, body: userBody },
    ]);

    const result = await validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "stale-bearer",
      "stale-bearer-refresh",
    );

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") {
      throw new Error("expected valid result");
    }
    expect(result.user.user.id).toBe("user-fixture-1");
    expect(
      (result as AuthIdentityValidationResult & { refreshedToken?: string })
        .refreshedToken,
    ).toBe("rotated-bearer");

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(USER_ENDPOINT);
    expect(calls[0].authorization).toBe("Bearer stale-bearer");
    expect(calls[1].url).toBe(REFRESH_ENDPOINT);
    expect(calls[1].method).toBe("POST");
    expect(calls[1].authorization).toBe("Bearer stale-bearer");
    expect(calls[2].url).toBe(USER_ENDPOINT);
    expect(calls[2].authorization).toBe("Bearer rotated-bearer");
  });

  it("returns rejected when both initial lookup and refresh are unauthorized", async () => {
    installMockFetch([
      { status: 401, body: { error: "Unauthorized" } },
      { status: 401, body: { error: "Unauthorized" } },
    ]);

    const result = await validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "expired",
      "expired-refresh",
    );

    expect(result.kind).toBe("rejected");
  });

  it("returns network-error when initial lookup is unauthorized but refresh is transient", async () => {
    vi.useFakeTimers();
    installMockFetch([
      { status: 401, body: { error: "Unauthorized" } },
      { status: 503, body: { error: "unavailable" } },
    ]);

    const pending = validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "fail-closed-bearer",
      "fail-closed-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.kind).toBe("network-error");
    expect(calls).toHaveLength(1 + AUTH_FETCH_MAX_ATTEMPTS);
    expect(calls[0].url).toBe(USER_ENDPOINT);
    expect(calls.slice(1).every((call) => call.url === REFRESH_ENDPOINT)).toBe(
      true,
    );
  });

  it("returns network-error when transport fails after exhausting retries", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      attempts += 1;
      throw new TypeError("network failure");
    }) as typeof fetch;

    const pending = validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer",
      "bearer-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.kind).toBe("network-error");
    // The initial user lookup and the follow-up refresh each exhaust the cap,
    // and the whole thing settles in bounded time instead of hanging.
    expect(attempts).toBe(AUTH_FETCH_MAX_ATTEMPTS * 2);
  });

  it("time-boxes each request with an AbortSignal and maps a timeout to network-error", async () => {
    vi.useFakeTimers();
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      calls.push({
        url: USER_ENDPOINT,
        method: init?.method ?? "GET",
        authorization: null,
        hasSignal: init?.signal instanceof AbortSignal,
      });
      // Mirror what a fired `AbortSignal.timeout` throws into `fetch`.
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;

    const pending = validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer",
      "bearer-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.kind).toBe("network-error");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.hasSignal)).toBe(true);
  });

  it("retries a transient user-lookup failure and then succeeds", async () => {
    vi.useFakeTimers();
    installMockFetch([
      { status: 503, body: { error: "unavailable" } },
      { status: 200, body: serializeAuthenticatedUserForHttp() },
    ]);

    const pending = validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer",
      "bearer-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.kind).toBe("valid");
    // One transient 5xx retried straight into a success - no refresh round trip.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url === USER_ENDPOINT)).toBe(true);
    expect(calls.every((call) => call.hasSignal)).toBe(true);
  });

  it("retries a user lookup whose body read times out (mid-read abort maps to network-error)", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) {
        return responseWithAbortingBody(200);
      }
      return new Response(JSON.stringify(serializeAuthenticatedUserForHttp()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const pending = validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer",
      "bearer-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    // A timeout during response.json() (after headers) is transient, so the
    // lookup retries and succeeds instead of collapsing to a `rejected` sign-out.
    expect(result.kind).toBe("valid");
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it("returns rejected when the response body fails AuthenticatedUser parsing", async () => {
    installMockFetch([
      { status: 200, body: { user: { id: "u" }, partial: true } },
    ]);

    const result = await validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer",
      "bearer-refresh",
    );

    expect(result.kind).toBe("rejected");
  });
});

describe("validateAuthTokenViaHttp - refresh failure classification", () => {
  it("keeps a transient refresh failure retriable after a fail-closed user lookup", async () => {
    vi.useFakeTimers();
    installMockFetch([
      { status: 401, body: { error: "Unauthorized" } },
      { status: 503, body: { error: "unavailable" } },
    ]);

    const pending = validateAuthTokenViaHttp(
      AUTHN_BASE_URL,
      "fail-closed-bearer",
      "fail-closed-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.kind).toBe("network-error");
    expect(calls).toHaveLength(1 + AUTH_FETCH_MAX_ATTEMPTS);
    expect(calls[0].url).toBe(USER_ENDPOINT);
    expect(calls.slice(1).every((call) => call.url === REFRESH_ENDPOINT)).toBe(
      true,
    );
  });
});

describe("refreshAuthTokenViaHttp - status mapping", () => {
  it("maps a 409 (refresh grace window in progress) to network-error and retries", async () => {
    vi.useFakeTimers();
    installMockFetch([{ status: 409, body: { error: "in progress" } }]);

    const pending = refreshAuthTokenViaHttp(
      AUTHN_BASE_URL,
      "stale-bearer",
      "stale-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    // A concurrent refresher is mid-rotation: transient/retriable, NOT a dead
    // credential. Must NOT downgrade to `rejected` (which signs the GUI out) -
    // the bounded retry re-drives to land on the winner's replayed pair.
    expect(result.kind).toBe("network-error");
    expect(calls).toHaveLength(AUTH_FETCH_MAX_ATTEMPTS);
    expect(calls[0].url).toBe(REFRESH_ENDPOINT);
    expect(calls[0].method).toBe("POST");
  });

  it("maps a 401 to rejected", async () => {
    installMockFetch([{ status: 401, body: { error: "Unauthorized" } }]);

    const result = await refreshAuthTokenViaHttp(
      AUTHN_BASE_URL,
      "stale-bearer",
      "stale-refresh",
    );

    expect(result.kind).toBe("rejected");
  });

  it("returns the rotated pair on success", async () => {
    installMockFetch([
      {
        status: 200,
        body: { token: "rotated-bearer", refreshToken: "rotated-refresh" },
      },
    ]);

    const result = await refreshAuthTokenViaHttp(
      AUTHN_BASE_URL,
      "stale-bearer",
      "stale-refresh",
    );

    expect(result.kind).toBe("refreshed");
    if (result.kind !== "refreshed") {
      throw new Error("expected refreshed result");
    }
    expect(result.token).toBe("rotated-bearer");
    expect(result.refreshToken).toBe("rotated-refresh");
  });

  it("retries a refresh whose body read times out (mid-read abort maps to network-error)", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) {
        return responseWithAbortingBody(200);
      }
      return new Response(
        JSON.stringify({
          token: "rotated-bearer",
          refreshToken: "rotated-refresh",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const pending = refreshAuthTokenViaHttp(
      AUTHN_BASE_URL,
      "stale-bearer",
      "stale-refresh",
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    // A mid-read timeout on a 200 is transient, not a bad body: it retries into
    // the rotated pair rather than downgrading to `rejected` (a sign-out).
    expect(result.kind).toBe("refreshed");
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });
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
