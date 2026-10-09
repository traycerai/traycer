import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerDevicePushTokenViaHttp,
  removeDevicePushTokenViaHttp,
} from "../push-token-fetcher";
import {
  removeNativeAbortHelpers,
  signalOfLastFetch,
  stubHangingFetch,
} from "./no-native-abort-helpers";

const AUTHN = "https://authn.example.test";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("push-token fetcher", () => {
  it("POSTs the token with the user bearer and reads a 2xx as ok", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerDevicePushTokenViaHttp(AUTHN, "jwt-abc", {
      token: "apns-token",
      platform: "ios",
      environment: "production",
    });

    expect(result).toEqual({ kind: "ok" });
    expect(fetchMock.mock.lastCall?.[0]).toBe(
      "https://authn.example.test/api/v3/user/push-tokens",
    );
    expect(fetchMock.mock.lastCall?.[1]?.method).toBe("POST");
  });

  it("maps 401 to unauthorized and 400 to rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 })),
    );
    expect(await removeDevicePushTokenViaHttp(AUTHN, "jwt", "tok")).toEqual({
      kind: "unauthorized",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("{}", { status: 400 })),
    );
    expect(await removeDevicePushTokenViaHttp(AUTHN, "jwt", "tok")).toEqual({
      kind: "rejected",
    });
  });

  it("leaves no timer behind once the request has answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })),
    );

    await removeDevicePushTokenViaHttp(AUTHN, "jwt", "tok");

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("push-token fetcher on a WebView without AbortSignal.timeout or AbortSignal.any (iOS 15.5)", () => {
  beforeEach(() => {
    removeNativeAbortHelpers();
  });

  it("still makes the register request", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerDevicePushTokenViaHttp(AUTHN, "jwt-abc", {
      token: "apns-token",
      platform: "ios",
      environment: "production",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: "ok" });
  });

  it("aborts a register that never answers once its 10 s timeout passes, and resolves to network-error", async () => {
    const fetchMock = stubHangingFetch();

    const pending = registerDevicePushTokenViaHttp(AUTHN, "jwt-abc", {
      token: "apns-token",
      platform: "ios",
      environment: "production",
    });
    const signal = signalOfLastFetch(fetchMock);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "network-error" });
  });

  it("aborts a remove that never answers the same way", async () => {
    const fetchMock = stubHangingFetch();

    const pending = removeDevicePushTokenViaHttp(AUTHN, "jwt-abc", "tok");
    const signal = signalOfLastFetch(fetchMock);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "network-error" });
  });
});
