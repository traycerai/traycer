import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATED_USER_FIXTURE_ID,
  createAuthenticatedUserFixture,
} from "../../../../shared/test-fixtures/authenticated-user";
import {
  bearerOf,
  refreshAnswer,
  REFRESHED_REFRESH_TOKEN,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_SIGN_IN_REFRESH_PATH,
  storedSignInBytes,
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
let refusedStatus: number;
let fileAtRefreshedRead: string[];
let refreshStatus: number | null;

beforeEach(async () => {
  calls = [];
  refusedBearers = [];
  refusedStatus = 401;
  fileAtRefreshedRead = [];
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
      if (bearer === REFRESHED_HEADER) {
        fileAtRefreshedRead.push(await storedSignInBytes());
      }
      if (refusedBearers.includes(bearer ?? "")) {
        return new Response("{}", { status: refusedStatus });
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

function paths(): string[] {
  return calls.map(({ pathname }) => pathname);
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

    expect(paths()).toEqual([
      NEGOTIATED_PATH,
      STORED_SIGN_IN_REFRESH_PATH,
      NEGOTIATED_PATH,
    ]);
    expect(identityReads()).toEqual([STORED_HEADER, REFRESHED_HEADER]);
    expect(fileAtRefreshedRead.map((bytes) => JSON.parse(bytes))).toEqual([
      expect.objectContaining({
        token: REFRESHED_TOKEN,
        refreshToken: REFRESHED_REFRESH_TOKEN,
      }),
    ]);
  });

  it("refreshes a sign-in authn answers 403 to, as it always has", async () => {
    refusedBearers = [STORED_HEADER];
    refusedStatus = 403;

    await readSignInEnvironments();

    expect(identityReads()).toEqual([STORED_HEADER, REFRESHED_HEADER]);
    expect(refreshCount()).toBe(1);
  });

  it("tells the person to sign in again when the refresh is refused", async () => {
    refusedBearers = [STORED_HEADER];
    refreshStatus = 401;
    const before = await storedSignInBytes();

    await expect(readSignInEnvironments()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
    });
    expect(paths()).toEqual([NEGOTIATED_PATH, STORED_SIGN_IN_REFRESH_PATH]);
    expect(await storedSignInBytes()).toBe(before);
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
