import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAuthTokenIdentityAccessOnly } from "../auth-validation";

// The build that ships without environments negotiates the user record as the
// release before them did: it names the majors it understood then and does not
// ask authn to hold a team invite for an explicit Accept.
vi.mock("../../unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const AUTHN_BASE_URL = "https://authn.example.test";
const NEGOTIATED_URL = `${AUTHN_BASE_URL}/api/v3/user/negotiated`;
const USER_RECORD_MAJORS_REQUEST_HEADER = "x-traycer-user-record-majors";
const USER_RECORD_VERSION_RESPONSE_HEADER = "x-traycer-user-record-version";
const INVITE_ACCEPTANCE_REQUEST_HEADER = "x-traycer-invite-acceptance";

/** A raw major-2 wire body, as `response.json()` hands it back. */
function authenticatedUserRawBody(): Record<string, unknown> {
  return {
    user: {
      id: "user-1",
      name: "Test User",
      providerId: "gh-1",
      providerHandle: "test-user",
      providerType: "GITHUB",
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

let originalFetch: typeof globalThis.fetch;
let requests: Array<{ readonly url: string; readonly headers: Headers }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requests.push({ url, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(authenticatedUserRawBody()), {
      status: 200,
      headers: {
        "content-type": "application/json",
        [USER_RECORD_VERSION_RESPONSE_HEADER]: "2.0",
      },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the negotiated user record route without environments", () => {
  it("advertises majors 1 and 2 only and sends no invite-acceptance header", async () => {
    const result = await validateAuthTokenIdentityAccessOnly(
      AUTHN_BASE_URL,
      "token",
    );

    expect(result.kind).toBe("valid");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(NEGOTIATED_URL);
    expect(requests[0].headers.get(USER_RECORD_MAJORS_REQUEST_HEADER)).toBe(
      "1,2",
    );
    expect(requests[0].headers.has(INVITE_ACCEPTANCE_REQUEST_HEADER)).toBe(
      false,
    );
  });
});
