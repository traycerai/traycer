import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deregisterHostViaHttp } from "../host-deregister-fetcher";
import {
  removeNativeAbortHelpers,
  signalOfLastFetch,
  stubHangingFetch,
} from "../../auth/__tests__/no-native-abort-helpers";

const AUTHN = "https://authn.example.test";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deregisterHostViaHttp", () => {
  it("POSTs /api/v3/hosts/:hostId/deregister with the user bearer and reads a 200 as ok", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deregisterHostViaHttp(AUTHN, "jwt-abc", "host-1");

    expect(result).toEqual({ kind: "ok" });
    expect(fetchMock.mock.lastCall?.[0]).toBe(
      "https://authn.example.test/api/v3/hosts/host-1/deregister",
    );
    expect(fetchMock.mock.lastCall?.[1]?.method).toBe("POST");
  });

  it("maps 404 to not-found, 409 to revoked and 401 to unauthorized", async () => {
    for (const [status, kind] of [
      [404, "not-found"],
      [409, "revoked"],
      [401, "unauthorized"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response("{}", { status })),
      );
      expect(await deregisterHostViaHttp(AUTHN, "jwt", "host-1")).toEqual({
        kind,
      });
    }
  });

  it("leaves no timer behind once the request has answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })),
    );

    await deregisterHostViaHttp(AUTHN, "jwt", "host-1");

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("deregisterHostViaHttp on a WebView without AbortSignal.timeout or AbortSignal.any (iOS 15.5)", () => {
  beforeEach(() => {
    removeNativeAbortHelpers();
  });

  it("still makes the request", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deregisterHostViaHttp(AUTHN, "jwt-abc", "host-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: "ok" });
  });

  it("aborts a request that never answers once its timeout passes, and resolves to network-error", async () => {
    const fetchMock = stubHangingFetch();

    const pending = deregisterHostViaHttp(AUTHN, "jwt-abc", "host-1");
    const signal = signalOfLastFetch(fetchMock);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "network-error" });
  });
});
