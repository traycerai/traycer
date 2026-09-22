/**
 * Tests for the abort-aware boundary auth helpers in `shared/auth/`:
 * `exchangeCodeForTokens` (PKCE code → token pair, single-attempt, no retry),
 * `refreshOnceAbortable` (the single-attempt, ~10s, lock-budgeted refresh the
 * credentials mutation store injects as its `RefreshFn` — the ONLY /auth/refresh
 * spend primitive; its status mapping + single-attempt budget are pinned below),
 * and the access-only `validateAuthTokenIdentity*` validators' negotiated-route
 * + frozen-route-recovery behaviour (below, "negotiated user record route") -
 * the endpoint-selection logic `fetchIdentityOnce` owns. Their live
 * `/api/v3/user(/negotiated)` behaviour ALSO runs against a faked fetch in the
 * desktop file-token-store and gui-app auth-service suites, which exercise the
 * validators through `AuthService`/`FileTokenStore` rather than directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRecordRegistry } from "@traycer/protocol/auth/registry";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  SUPPORTED_USER_RECORD_MAJORS,
  authRetryDelayMs,
  exchangeCodeForTokens,
  refreshOnceAbortable,
  validateAuthTokenIdentityAccessOnceAbortable,
  validateAuthTokenIdentityAccessOnly,
} from "../auth-validation";

const AUTHN_BASE_URL = "https://authn.example.test";
const EXCHANGE_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/exchange-code`;
const REFRESH_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/refresh`;

interface MockFetchCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | null;
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
      body: typeof init?.body === "string" ? init.body : null,
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
        body: typeof init?.body === "string" ? init.body : null,
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
      clientKind: null,
      signal: AbortSignal.abort(),
    });

    expect(result).toEqual({ kind: "network-error" });
    // The aborted signal may short-circuit before fetch is invoked, or fetch
    // may be called and reject — either way nothing is spent (no refreshed pair).
    expect(fetchCalls === 0 || fetchCalls === 1).toBe(true);
  });

  it("returns the rotated pair and identifies the refreshing desktop client on a single POST", async () => {
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
      clientKind: "desktop",
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
    expect(JSON.parse(calls[0].body ?? "null")).toEqual({
      refreshToken: "stale-refresh",
      clientKind: "desktop",
    });
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
      clientKind: null,
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
      clientKind: null,
      signal: null,
    });

    // 401 classifies CREDENTIAL-scoped, with no `revocation_scope` on the
    // body - so `revocation` is null, which is the same value an
    // unrecognised scope would produce. See `readRefreshRejectionScope`.
    expect(result).toEqual({
      kind: "rejected",
      rejection: { kind: "credential", revocation: null },
    });
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
      clientKind: null,
      signal: null,
    });

    expect(result).toEqual({ kind: "network-error" });
    expect(calls).toHaveLength(1);
  });
});

describe("negotiated user record route, and frozen-route recovery", () => {
  const NEGOTIATED_URL = `${AUTHN_BASE_URL}/api/v3/user/negotiated`;
  const FROZEN_URL = `${AUTHN_BASE_URL}/api/v3/user`;

  // COPIED from `auth-validation.ts`, same as that file copies them from
  // authn-v3: a private constant cannot be imported, and restating the
  // literal here is what makes test 7 below an independent change-detector
  // rather than a tautology against the module's own constant.
  const USER_RECORD_MAJORS_REQUEST_HEADER = "x-traycer-user-record-majors";
  const USER_RECORD_VERSION_RESPONSE_HEADER = "x-traycer-user-record-version";

  interface UrlKeyedCall {
    readonly url: string;
    readonly headers: Headers;
  }

  interface RouteSpec {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  }

  let urlCalls: UrlKeyedCall[];

  /**
   * A fetch fake keyed by exact URL (unlike `installMockFetch` above, which
   * is keyed by call index) - the negotiated route and the frozen route are
   * two different URLs answered independently, and several cases here drive
   * the SAME URL through more than one answer in sequence (a 404 then a
   * later success). Each URL's spec list is consumed in order; the last spec
   * repeats once exhausted. Mirrors a caller-supplied pre-aborted signal the
   * way real `fetch` does: an already-aborted signal rejects before any spec
   * is consulted, and is still recorded as a call.
   */
  function installUrlKeyedMockFetch(
    routes: ReadonlyMap<string, readonly RouteSpec[]>,
  ): void {
    const nextIndexByUrl = new Map<string, number>();
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
      const headers = new Headers(init?.headers);
      urlCalls.push({ url, headers });
      if (init?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const specs = routes.get(url);
      if (specs === undefined || specs.length === 0) {
        throw new Error(`no mock route installed for ${url}`);
      }
      const index = nextIndexByUrl.get(url) ?? 0;
      nextIndexByUrl.set(url, index + 1);
      const spec = specs[Math.min(index, specs.length - 1)];
      const body =
        typeof spec.body === "string"
          ? spec.body
          : JSON.stringify(spec.body ?? {});
      return new Response(body, { status: spec.status, headers: spec.headers });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
  }

  /**
   * A raw wire body - ISO date strings, never `Date` objects: this is what a
   * real `fetch` response hands back from `response.json()`, and is what
   * `installUrlKeyedMockFetch` above serializes with `JSON.stringify`. A
   * `Date`-carrying fixture (`createAuthenticatedUserFixture`) would silently
   * round-trip through `JSON.stringify` as an ISO string too, but relying on
   * that would be testing `Date#toJSON`, not this file's wire contract.
   */
  function authenticatedUserRawBody(providerType: "GITHUB" | "APPLE"): unknown {
    return {
      user: {
        id: "user-1",
        name: "Test User",
        providerId: "gh-1",
        providerHandle: "test-user",
        providerType,
        email: "test@example.com",
        avatarUrl: null,
        activatedAt: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: "sub-1",
        userID: "user-1",
        orgID: null,
        teamID: null,
        customerId: "cus-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: [],
      payAsYouGoUsage: { allowPayAsYouGo: false },
    };
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    urlCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("1: negotiated success at major 2 is valid off a single request advertising both majors", async () => {
    installUrlKeyedMockFetch(
      new Map([
        [
          NEGOTIATED_URL,
          [
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                [USER_RECORD_VERSION_RESPONSE_HEADER]: "2.0",
              },
              body: authenticatedUserRawBody("APPLE"),
            },
          ],
        ],
      ]),
    );

    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("expected valid");
    expect(result.user.user.providerType).toBe("APPLE");
    expect(urlCalls).toHaveLength(1);
    expect(urlCalls[0].url).toBe(NEGOTIATED_URL);
    expect(urlCalls[0].headers.get(USER_RECORD_MAJORS_REQUEST_HEADER)).toBe(
      "1,2",
    );
  });

  it("2: negotiated success at major 1 is valid off a single request", async () => {
    installUrlKeyedMockFetch(
      new Map([
        [
          NEGOTIATED_URL,
          [
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                [USER_RECORD_VERSION_RESPONSE_HEADER]: "1.0",
              },
              body: authenticatedUserRawBody("GITHUB"),
            },
          ],
        ],
      ]),
    );

    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    expect(result.kind).toBe("valid");
    expect(urlCalls).toHaveLength(1);
  });

  it("2a: an APPLE body labelled 1.0 is rejected - the label, not the shape, selects the schema", async () => {
    installUrlKeyedMockFetch(
      new Map([
        [
          NEGOTIATED_URL,
          [
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                [USER_RECORD_VERSION_RESPONSE_HEADER]: "1.0",
              },
              body: authenticatedUserRawBody("APPLE"),
            },
          ],
        ],
      ]),
    );

    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    // The frozen major-1 schema's providerType enum has no APPLE value, so a
    // body claiming 1.0 while actually carrying it fails to parse.
    expect(result.kind).toBe("rejected");
  });

  it("3: a 404 recovers onto the frozen route, unadvertised, in order", async () => {
    installUrlKeyedMockFetch(
      new Map([
        [NEGOTIATED_URL, [{ status: 404 }]],
        [
          FROZEN_URL,
          [
            {
              status: 200,
              headers: { "content-type": "application/json" },
              body: authenticatedUserRawBody("GITHUB"),
            },
          ],
        ],
      ]),
    );

    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    expect(result.kind).toBe("valid");
    expect(urlCalls).toHaveLength(2);
    expect(urlCalls.map((call) => call.url)).toEqual([
      NEGOTIATED_URL,
      FROZEN_URL,
    ]);
    expect(urlCalls[1].headers.get(USER_RECORD_MAJORS_REQUEST_HEADER)).toBe(
      null,
    );
  });

  it("4: a 404 then a frozen-route 404 is rejected, not network-error, in exactly two requests", async () => {
    installUrlKeyedMockFetch(
      new Map([
        [NEGOTIATED_URL, [{ status: 404 }]],
        [FROZEN_URL, [{ status: 404 }]],
      ]),
    );

    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    expect(result.kind).toBe("rejected");
    expect(urlCalls).toHaveLength(2);
  });

  it("5: a 401 on the negotiated route does not fall back - exactly one request", async () => {
    installUrlKeyedMockFetch(new Map([[NEGOTIATED_URL, [{ status: 401 }]]]));

    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    expect(result.kind).toBe("rejected");
    expect(urlCalls).toHaveLength(1);
  });

  it("5a: a 403 on the negotiated route does not fall back - exactly one request", async () => {
    installUrlKeyedMockFetch(new Map([[NEGOTIATED_URL, [{ status: 403 }]]]));

    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    expect(result.kind).toBe("rejected");
    expect(urlCalls).toHaveLength(1);
  });

  // 6 and its siblings: every way this build can fail to LABEL an otherwise
  // good 2xx recovers onto the frozen route without ever producing `rejected`
  // - the served-version header is resolved before the body is read, so none
  // of these reach the schema-failure branch that a credential rejection
  // would.
  const UNLABELLED_HEADERS: ReadonlyArray<{
    readonly name: string;
    readonly value: string | undefined;
  }> = [
    { name: "absent", value: undefined },
    { name: "malformed (two words)", value: "two" },
    { name: "malformed (no minor)", value: "2" },
    { name: "empty string", value: "" },
    { name: "unsupported major", value: "9.0" },
  ];

  for (const { name, value } of UNLABELLED_HEADERS) {
    it(`6 (${name}): recovers onto the frozen route without ever surfacing rejected`, async () => {
      const negotiatedHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      if (value !== undefined) {
        negotiatedHeaders[USER_RECORD_VERSION_RESPONSE_HEADER] = value;
      }
      installUrlKeyedMockFetch(
        new Map([
          [
            NEGOTIATED_URL,
            [
              {
                status: 200,
                headers: negotiatedHeaders,
                body: authenticatedUserRawBody("GITHUB"),
              },
            ],
          ],
          [
            FROZEN_URL,
            [
              {
                status: 200,
                headers: { "content-type": "application/json" },
                body: authenticatedUserRawBody("GITHUB"),
              },
            ],
          ],
        ]),
      );

      const result = await validateAuthTokenIdentityAccessOnly(
        AUTHN_BASE_URL,
        "token",
      );

      expect(result.kind).toBe("valid");
      expect(urlCalls).toHaveLength(2);
      expect(urlCalls.map((call) => call.url)).toEqual([
        NEGOTIATED_URL,
        FROZEN_URL,
      ]);
    });
  }

  it("7: SUPPORTED_USER_RECORD_MAJORS is pinned against the registry's installed majors, and the advertised header value against the literal", async () => {
    const installedMajors = Object.keys(
      authRecordRegistry["authenticated-user-response"],
    )
      .map(Number)
      .sort((a, b) => a - b);
    expect([...SUPPORTED_USER_RECORD_MAJORS].sort((a, b) => a - b)).toEqual(
      installedMajors,
    );

    // Independent change-detector: restated, not derived from
    // SUPPORTED_USER_RECORD_MAJORS.join(",") - a join-based assertion would
    // pass even if the join separator itself regressed.
    installUrlKeyedMockFetch(
      new Map([
        [
          NEGOTIATED_URL,
          [
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                [USER_RECORD_VERSION_RESPONSE_HEADER]: "2.0",
              },
              body: authenticatedUserRawBody("GITHUB"),
            },
          ],
        ],
      ]),
    );
    await validateAuthTokenIdentityAccessOnly(AUTHN_BASE_URL, "token");
    expect(urlCalls[0].headers.get(USER_RECORD_MAJORS_REQUEST_HEADER)).toBe(
      "1,2",
    );
  });

  it("8a: a caller-supplied pre-aborted signal spends nothing", async () => {
    installUrlKeyedMockFetch(
      new Map([
        [
          NEGOTIATED_URL,
          [
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                [USER_RECORD_VERSION_RESPONSE_HEADER]: "2.0",
              },
              body: authenticatedUserRawBody("GITHUB"),
            },
          ],
        ],
      ]),
    );

    const result = await validateAuthTokenIdentityAccessOnceAbortable({
      authnBaseUrl: AUTHN_BASE_URL,
      token: "token",
      signal: AbortSignal.abort(),
    });

    expect(result.kind).toBe("network-error");
    // Either fetch was never entered, or it was entered and rejected on the
    // already-aborted signal - either way nothing was spent (no valid/rejected
    // verdict).
    expect(urlCalls.length === 0 || urlCalls.length === 1).toBe(true);
  });

  it("8b: a 404-then-frozen-failure pair is still ONE attempt of withAuthNetworkRetry - at most two requests per attempt, six total, not nine", async () => {
    vi.useFakeTimers();
    installUrlKeyedMockFetch(
      new Map([
        [NEGOTIATED_URL, [{ status: 404 }]],
        [FROZEN_URL, [{ status: 500 }]],
      ]),
    );

    const promise = validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    const result = await promise;

    // The frozen route's 500 is a network-error, which IS the unit
    // `withAuthNetworkRetry` re-drives - so this makes the full
    // `AUTH_FETCH_MAX_ATTEMPTS` attempts, each a negotiated-404 +
    // frozen-500 pair: 2 requests * 3 attempts = 6, never 3 * 3 = 9 (which a
    // fallback that multiplied with the retry ceiling would produce).
    expect(result.kind).toBe("network-error");
    expect(urlCalls).toHaveLength(2 * AUTH_FETCH_MAX_ATTEMPTS);
  });
});
