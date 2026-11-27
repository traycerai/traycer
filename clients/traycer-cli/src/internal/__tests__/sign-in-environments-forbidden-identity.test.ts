import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import {
  bearerOf,
  REFRESHED_REFRESH_TOKEN,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_REFRESH_TOKEN,
  STORED_SIGN_IN_REFRESH_PATH,
} from "../../__tests__/support/stored-sign-in";
import { readSignInEnvironments } from "../sign-in-environments";
import { nextCasePerson } from "./case-person-test-support";

/**
 * The concurrent-refresh suite stubs `validateAuthTokenIdentityAccessOnly` and
 * returns a kind, so it cannot make a 403 a real HTTP status. This file leaves
 * that function real and answers authn only at `fetch`.
 */

const IDENTITY_PATH = "/api/v3/user/negotiated";

function acceptedIdentityResponse(): Response {
  return new Response(
    JSON.stringify({
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
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    },
  );
}

describe("readSignInEnvironments", () => {
  let storedToken = "";
  let userId = "";
  let operationSettled: Promise<void> = Promise.resolve();
  let requests: Array<{
    readonly pathname: string;
    readonly bearer: string | null;
    readonly status: number;
    readonly body: string | null;
  }> = [];

  beforeEach(async () => {
    const person = nextCasePerson();
    storedToken = person.signIn;
    userId = person.userId;
    requests = [];
    operationSettled = Promise.resolve();
    await seedStoredSignIn(storedToken, userId);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const pathname = new URL(String(input)).pathname;
        const bearer = bearerOf(init);
        const body = typeof init?.body === "string" ? init.body : null;
        if (pathname === STORED_SIGN_IN_REFRESH_PATH) {
          requests.push({ pathname, bearer, status: 200, body });
          return new Response(
            JSON.stringify({
              token: REFRESHED_TOKEN,
              refreshToken: REFRESHED_REFRESH_TOKEN,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (pathname === IDENTITY_PATH && bearer === `Bearer ${storedToken}`) {
          requests.push({ pathname, bearer, status: 403, body });
          return new Response(JSON.stringify({}), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === IDENTITY_PATH) {
          requests.push({ pathname, bearer, status: 200, body });
          return acceptedIdentityResponse();
        }
        requests.push({ pathname, bearer, status: 404, body });
        return new Response(JSON.stringify({}), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(async () => {
    await operationSettled;
    vi.unstubAllGlobals();
    await removeStoredSignIn();
  });

  it("refreshes once when the identity read is answered with HTTP 403, the same refusal as a 401", async () => {
    const pending = readSignInEnvironments(() =>
      cliError({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: "not confirmed",
        details: null,
        exitCode: 1,
      }),
    );
    operationSettled = pending.then(
      () => undefined,
      () => undefined,
    );
    const signedIn = await pending;

    expect(signedIn.userId).toBe(userId);
    expect(signedIn.environments).toEqual([]);
    // One 403 on the negotiated identity route (no frozen-route follow-up),
    // one refresh, then one accepted identity read of the refreshed sign-in.
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      IDENTITY_PATH,
      STORED_SIGN_IN_REFRESH_PATH,
      IDENTITY_PATH,
    ]);
    expect(requests.map(({ bearer }) => bearer)).toEqual([
      `Bearer ${storedToken}`,
      `Bearer ${storedToken}`,
      `Bearer ${REFRESHED_TOKEN}`,
    ]);
    const refresh = requests.filter(
      ({ pathname }) => pathname === STORED_SIGN_IN_REFRESH_PATH,
    );
    expect(JSON.parse(refresh[0].body ?? "")).toMatchObject({
      refreshToken: STORED_REFRESH_TOKEN,
    });
  });
});
