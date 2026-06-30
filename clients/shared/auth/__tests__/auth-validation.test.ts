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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  refreshAuthTokenViaHttp,
  validateAuthTokenIdentityViaHttp,
  type AuthIdentityValidationResult,
} from "../auth-validation";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";

const AUTHN_BASE_URL = "https://authn.example.test";
const USER_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/user`;
const REFRESH_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/refresh`;

interface MockFetchCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

  it("returns network-error when transport fails", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      throw new TypeError("network failure");
    }) as typeof fetch;

    const result = await validateAuthTokenIdentityViaHttp(
      AUTHN_BASE_URL,
      "bearer",
      "bearer-refresh",
    );

    expect(result.kind).toBe("network-error");
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

describe("refreshAuthTokenViaHttp - status mapping", () => {
  it("maps a 409 (refresh grace window in progress) to network-error", async () => {
    installMockFetch([{ status: 409, body: { error: "in progress" } }]);

    const result = await refreshAuthTokenViaHttp(
      AUTHN_BASE_URL,
      "stale-bearer",
      "stale-refresh",
    );

    // A concurrent refresher is mid-rotation: transient/retriable, NOT a dead
    // credential. Must NOT downgrade to `rejected` (which signs the GUI out).
    expect(result.kind).toBe("network-error");
    expect(calls).toHaveLength(1);
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
});
