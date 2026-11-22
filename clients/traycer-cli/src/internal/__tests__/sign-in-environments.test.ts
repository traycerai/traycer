import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATED_USER_FIXTURE_ID,
  createAuthenticatedUserFixture,
} from "../../../../shared/test-fixtures/authenticated-user";
import {
  bearerOf,
  refreshAnswer,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_SIGN_IN_REFRESH_PATH,
} from "../../__tests__/support/stored-sign-in";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { readSignInEnvironments } from "../sign-in-environments";

const STORED_TOKEN = "stored-bearer";
const STORED_HEADER = `Bearer ${STORED_TOKEN}`;
const REFRESHED_HEADER = `Bearer ${REFRESHED_TOKEN}`;
const NEGOTIATED_PATH = "/api/v3/user/negotiated";
const PERSONAL_ENVIRONMENT_ID = "environment-personal";

let calls: Array<{ readonly pathname: string; readonly bearer: string | null }>;
let refusedBearers: string[];
let refreshStatus: number | null;

beforeEach(async () => {
  calls = [];
  refusedBearers = [];
  refreshStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const bearer = bearerOf(init);
      calls.push({ pathname, bearer });
      if (pathname === STORED_SIGN_IN_REFRESH_PATH) {
        return refreshAnswer(refreshStatus);
      }
      if (refusedBearers.includes(bearer ?? "")) {
        return new Response("{}", { status: 401 });
      }
      return new Response(
        JSON.stringify(
          createAuthenticatedUserFixture({
            environments: { personal: PERSONAL_ENVIRONMENT_ID, teams: [] },
          }),
        ),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-traycer-user-record-version": "3.0",
          },
        },
      );
    }),
  );
  await seedStoredSignIn(STORED_TOKEN, "member-1");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await removeStoredSignIn();
});

function identityReads(): Array<string | null> {
  return calls
    .filter(({ pathname }) => pathname === NEGOTIATED_PATH)
    .map(({ bearer }) => bearer);
}

function refreshCount(): number {
  return calls.filter(
    ({ pathname }) => pathname === STORED_SIGN_IN_REFRESH_PATH,
  ).length;
}

describe("readSignInEnvironments", () => {
  it("refreshes a refused sign-in once and returns the environments read on the refreshed one", async () => {
    refusedBearers = [STORED_HEADER];

    expect(await readSignInEnvironments()).toEqual([
      {
        environmentId: PERSONAL_ENVIRONMENT_ID,
        ownerKind: "user",
        ownerId: AUTHENTICATED_USER_FIXTURE_ID,
        label: "Personal",
      },
    ]);

    expect(identityReads()).toEqual([STORED_HEADER, REFRESHED_HEADER]);
    expect(refreshCount()).toBe(1);
  });

  it("tells the person to sign in again when the refresh is refused", async () => {
    refusedBearers = [STORED_HEADER];
    refreshStatus = 401;

    await expect(readSignInEnvironments()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
    });
    expect(identityReads()).toEqual([STORED_HEADER]);
  });

  it("tells the person to sign in again, after one refresh, when the refreshed sign-in is refused too", async () => {
    refusedBearers = [STORED_HEADER, REFRESHED_HEADER];

    await expect(readSignInEnvironments()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
    });
    expect(identityReads()).toEqual([STORED_HEADER, REFRESHED_HEADER]);
    expect(refreshCount()).toBe(1);
  });
});
