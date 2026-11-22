import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";
import {
  refreshAnswer,
  REFRESHED_REFRESH_TOKEN,
  REFRESHED_TOKEN,
  removeStoredSignIn,
  seedStoredSignIn,
  STORED_SIGN_IN_REFRESH_PATH,
  storedSignInBytes,
} from "../../__tests__/support/stored-sign-in";
import type { HostAuth } from "../host-auth";
import { openStoredSignIn } from "../stored-sign-in-ask";

const STORED_TOKEN = "stored-bearer";
const USER_ID = "member-1";
const AUTH: HostAuth = {
  token: STORED_TOKEN,
  authnBaseUrl: config.authnBaseUrl,
  userId: USER_ID,
};

type Answer = "ok" | "refused";

let refreshRequests: number;
let refreshStatus: number | null;
/** Holds the refresh request open until `releaseRefresh` is called. */
let refreshGate: Promise<void>;
let releaseRefresh: () => void;
let refreshArrived: Promise<void>;
let markRefreshArrived: () => void;

beforeEach(async () => {
  refreshRequests = 0;
  refreshStatus = 200;
  refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  refreshArrived = new Promise((resolve) => {
    markRefreshArrived = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      if (new URL(String(input)).pathname !== STORED_SIGN_IN_REFRESH_PATH) {
        return new Response("{}", { status: 404 });
      }
      refreshRequests += 1;
      markRefreshArrived();
      await refreshGate;
      return refreshAnswer(refreshStatus);
    }),
  );
  await seedStoredSignIn(STORED_TOKEN, USER_ID);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await removeStoredSignIn();
});

const isRefused = (answer: Answer): boolean => answer === "refused";

describe("openStoredSignIn", () => {
  it("sends one refresh for two asks refused at the same time, and both retry on the refreshed token", async () => {
    const sentOn: string[] = [];
    let settleSecond: (answer: Answer) => void = () => {};
    const secondAnswer = new Promise<Answer>((resolve) => {
      settleSecond = resolve;
    });
    const signIn = openStoredSignIn(AUTH);

    const first = signIn.ask(
      async (token) => {
        sentOn.push(token);
        return token === STORED_TOKEN ? "refused" : "ok";
      },
      isRefused,
      null,
    );
    const second = signIn.ask(
      (token) => {
        sentOn.push(token);
        return token === STORED_TOKEN
          ? secondAnswer
          : Promise.resolve<Answer>("ok");
      },
      isRefused,
      null,
    );
    // The first ask's refresh is in flight when the second ask is refused.
    await refreshArrived;
    settleSecond("refused");
    releaseRefresh();

    expect(await first).toEqual({ kind: "answered", answer: "ok" });
    expect(await second).toEqual({ kind: "answered", answer: "ok" });
    expect(refreshRequests).toBe(1);
    expect(sentOn.filter((token) => token === STORED_TOKEN)).toHaveLength(2);
    expect(sentOn.filter((token) => token === REFRESHED_TOKEN)).toHaveLength(2);
  });

  it("does not send an ask a third time when it is refused again after the refresh landed", async () => {
    releaseRefresh();
    const signIn = openStoredSignIn(AUTH);
    const sentOn: string[] = [];
    const refusedEverywhere = async (token: string): Promise<Answer> => {
      sentOn.push(token);
      return "refused";
    };

    const first = await signIn.ask(refusedEverywhere, isRefused, null);
    const second = await signIn.ask(refusedEverywhere, isRefused, null);

    expect(first).toEqual({ kind: "answered", answer: "refused" });
    expect(second).toEqual({ kind: "answered", answer: "refused" });
    expect(sentOn).toEqual([STORED_TOKEN, REFRESHED_TOKEN, REFRESHED_TOKEN]);
    expect(refreshRequests).toBe(1);
  });

  it("returns the refreshed token from current(), with the same user and sign-in service, and saves it before the retry", async () => {
    releaseRefresh();
    const signIn = openStoredSignIn(AUTH);
    expect(signIn.current()).toEqual(AUTH);
    let savedAtRetry: unknown = null;

    await signIn.ask(
      async (token) => {
        if (token === STORED_TOKEN) return "refused";
        savedAtRetry = JSON.parse(await storedSignInBytes());
        return "ok";
      },
      isRefused,
      null,
    );

    expect(signIn.current()).toEqual({ ...AUTH, token: REFRESHED_TOKEN });
    expect(savedAtRetry).toMatchObject({
      token: REFRESHED_TOKEN,
      refreshToken: REFRESHED_REFRESH_TOKEN,
    });
  });

  it("keeps the first answer and the stored token, and sends no second refresh, when the refresh is refused", async () => {
    releaseRefresh();
    refreshStatus = 401;
    const signIn = openStoredSignIn(AUTH);

    const first = await signIn.ask(
      async (): Promise<Answer> => "refused",
      isRefused,
      null,
    );
    const second = await signIn.ask(
      async (): Promise<Answer> => "refused",
      isRefused,
      null,
    );

    expect(first).toEqual({ kind: "refresh-rejected", first: "refused" });
    expect(second).toEqual({ kind: "refresh-rejected", first: "refused" });
    expect(refreshRequests).toBe(1);
    expect(signIn.current()).toEqual(AUTH);
  });
});
