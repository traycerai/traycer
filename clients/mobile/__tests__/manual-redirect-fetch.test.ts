import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeCodeForTokens } from "@traycer-clients/shared/auth/auth-validation";
import { listCreditOffersViaHttp } from "@traycer-clients/shared/auth/credit-offers";
import { manualRedirectFetch } from "../src/manual-redirect-fetch";
import {
  nativeRequest,
  type NativeAnswer,
  type NativeRequest,
  type NativeRequester,
} from "../src/native-environment-transport";

const capacitorHttp = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@capacitor/core", () => ({
  CapacitorHttp: { request: capacitorHttp.request },
}));

const AUTHN = "https://authn.example.invalid";
const EXCHANGE_URL = `${AUTHN}/api/v3/auth/exchange-code`;
const OFFERS_URL = `${AUTHN}/api/user/credit-campaigns`;
const REDIRECT_URL = "https://elsewhere.example.invalid/credential";

interface RecordedNative {
  readonly calls: ReadonlyArray<NativeRequest>;
  readonly requester: NativeRequester;
}

function recordAnswer(answer: NativeAnswer): RecordedNative {
  const calls: NativeRequest[] = [];
  const requester: NativeRequester = async (request) => {
    calls.push(request);
    return answer;
  };
  return { calls, requester };
}

function unusedPlatformFetch(
  _input: RequestInfo | URL,
  _init: RequestInit | undefined,
): Promise<Response> {
  return Promise.resolve(new Response("platform"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  capacitorHttp.request.mockReset();
});

describe("manual redirect fetch on the phone", () => {
  it("keeps real PKCE exchange POSTs on native for 307/308 and accepts 2xx", async () => {
    let redirectBodyReads = 0;
    const answers: NativeAnswer[] = [
      {
        status: 307,
        headers: { location: REDIRECT_URL },
        get text() {
          redirectBodyReads += 1;
          return "redirect body";
        },
      },
      {
        status: 308,
        headers: { location: REDIRECT_URL },
        get text() {
          redirectBodyReads += 1;
          return "redirect body";
        },
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          token: "fake-access",
          refreshToken: "fake-refresh",
        }),
      },
    ];
    const calls: NativeRequest[] = [];
    const requester: NativeRequester = async (request) => {
      calls.push(request);
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error("no native answer was arranged");
      }
      return answer;
    };
    const platform = vi.fn(unusedPlatformFetch);
    vi.stubGlobal("fetch", manualRedirectFetch(platform, requester));

    await expect(
      exchangeCodeForTokens(AUTHN, "fake-code", "fake-verifier"),
    ).resolves.toEqual({ kind: "network-error" });
    await expect(
      exchangeCodeForTokens(AUTHN, "fake-code", "fake-verifier"),
    ).resolves.toEqual({ kind: "network-error" });
    await expect(
      exchangeCodeForTokens(AUTHN, "fake-code", "fake-verifier"),
    ).resolves.toMatchObject({ kind: "exchanged" });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call).toEqual({
        url: EXCHANGE_URL,
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        data: '{"code":"fake-code","code_verifier":"fake-verifier"}',
      });
    }
    expect(redirectBodyReads).toBe(0);
    expect(platform).not.toHaveBeenCalled();
  });

  it("routes the real credit-offers GET through native and maps its 302", async () => {
    const native = recordAnswer({
      status: 302,
      headers: { location: REDIRECT_URL },
      text: "redirect body",
    });
    const platform = vi.fn(unusedPlatformFetch);
    vi.stubGlobal("fetch", manualRedirectFetch(platform, native.requester));

    await expect(
      listCreditOffersViaHttp(AUTHN, "fake-user-bearer", null),
    ).resolves.toEqual({ kind: "network-error" });

    expect(native.calls).toEqual([
      {
        url: OFFERS_URL,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer fake-user-bearer",
        },
        data: null,
      },
    ]);
    expect(platform).not.toHaveBeenCalled();
  });

  it("sends native requests with redirects disabled and preserves the body", async () => {
    capacitorHttp.request.mockResolvedValue({
      status: 307,
      headers: { location: REDIRECT_URL },
      data: "redirect body",
    });
    const body = '{"code":"fake-code"}';

    await expect(
      nativeRequest({
        url: EXCHANGE_URL,
        method: "POST",
        headers: { authorization: "Bearer fake-bearer" },
        data: body,
      }),
    ).resolves.toEqual({
      status: 307,
      headers: { location: REDIRECT_URL },
      text: "redirect body",
    });

    expect(capacitorHttp.request).toHaveBeenCalledTimes(1);
    expect(capacitorHttp.request).toHaveBeenCalledWith({
      url: EXCHANGE_URL,
      method: "POST",
      headers: { authorization: "Bearer fake-bearer" },
      data: body,
      disableRedirects: true,
      responseType: "text",
    });
  });

  it("passes requests without manual redirect mode to platform fetch unchanged", async () => {
    const native = recordAnswer({ status: 200, headers: {}, text: "native" });
    const response = new Response("platform answer");
    const platform = vi.fn(
      async (_input: RequestInfo | URL, _init: RequestInit | undefined) =>
        response,
    );
    const fetch = manualRedirectFetch(platform, native.requester);
    const input = new URL(OFFERS_URL);
    const init: RequestInit = { method: "GET", redirect: "follow" };

    await expect(fetch(input, init)).resolves.toBe(response);
    expect(platform).toHaveBeenCalledExactlyOnceWith(input, init);
    expect(native.calls).toHaveLength(0);
  });

  it("does not send an already-aborted request and ignores an in-flight late answer", async () => {
    vi.useFakeTimers();
    const calls: NativeRequest[] = [];
    let resolveAnswer: ((answer: NativeAnswer) => void) | undefined;
    const answerPromise = new Promise<NativeAnswer>((resolve) => {
      resolveAnswer = resolve;
    });
    let markRequested: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    const requester: NativeRequester = async (request) => {
      calls.push(request);
      markRequested?.();
      return answerPromise;
    };
    const fetch = manualRedirectFetch(unusedPlatformFetch, requester);
    const beforeController = new AbortController();
    beforeController.abort();

    await expect(
      fetch(EXCHANGE_URL, {
        redirect: "manual",
        signal: beforeController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);

    let lateBodyReads = 0;
    const controller = new AbortController();
    const responsePromise = fetch(EXCHANGE_URL, {
      redirect: "manual",
      signal: controller.signal,
    });
    await requested;
    const outcome = responsePromise.then(
      () => "resolved",
      (error: unknown) => {
        if (typeof error === "object" && error !== null && "name" in error) {
          return String(error.name);
        }
        return "other error";
      },
    );
    const deadline = new Promise<string>((resolve) => {
      setTimeout(() => resolve("still pending"), 10);
    });
    const result = Promise.race([outcome, deadline]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe("AbortError");

    if (resolveAnswer === undefined) {
      throw new Error("the native requester did not capture its resolver");
    }
    resolveAnswer({
      status: 200,
      headers: {},
      get text() {
        lateBodyReads += 1;
        return "late answer";
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateBodyReads).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("maps a native status outside Response's range to the real helper's network error", async () => {
    const native = recordAnswer({ status: 600, headers: {}, text: "invalid" });
    const platform = vi.fn(unusedPlatformFetch);
    vi.stubGlobal("fetch", manualRedirectFetch(platform, native.requester));

    await expect(
      listCreditOffersViaHttp(AUTHN, "fake-user-bearer", null),
    ).resolves.toEqual({ kind: "network-error" });

    expect(native.calls).toHaveLength(1);
    expect(platform).not.toHaveBeenCalled();
  });
});
