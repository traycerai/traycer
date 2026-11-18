import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  updateHostVersionPolicyViaHttp,
  type UpdateHostVersionPolicyInput,
} from "../host-version-policy-fetcher";
import {
  removeNativeAbortHelpers,
  signalOfLastFetch,
  stubHangingFetch,
} from "../../auth/__tests__/no-native-abort-helpers";

const AUTHN = "https://authn.example.test";

function okBody() {
  return {
    host_id: "host-1",
    update_policy: "manual",
    desired_version: "1.5.0",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function updateInput(): UpdateHostVersionPolicyInput {
  return {
    updatePolicy: "manual",
    desiredVersion: "1.5.0",
    force: undefined,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updateHostVersionPolicyViaHttp", () => {
  it("PATCHes /api/v3/hosts/:hostId with the user bearer and returns the applied policy", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, okBody()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateHostVersionPolicyViaHttp(
      AUTHN,
      "jwt-abc",
      "host-1",
      updateInput(),
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.result.hostId).toBe("host-1");
      expect(result.result.updatePolicy).toBe("manual");
      expect(result.result.desiredVersion).toBe("1.5.0");
    }
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://authn.example.test/api/v3/hosts/host-1");
    expect(init?.method).toBe("PATCH");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-abc",
    );
  });

  it("maps 404 to not-found (host doesn't exist or isn't owned by the caller)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(404, {})),
    );
    const result = await updateHostVersionPolicyViaHttp(
      AUTHN,
      "x",
      "host-1",
      updateInput(),
    );
    expect(result.kind).toBe("not-found");
  });

  it("maps 400 to invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(400, {})),
    );
    const result = await updateHostVersionPolicyViaHttp(
      AUTHN,
      "x",
      "host-1",
      updateInput(),
    );
    expect(result.kind).toBe("invalid");
  });

  it("maps 401/403 to unauthorized", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => jsonResponse(status, {})),
      );
      const result = await updateHostVersionPolicyViaHttp(
        AUTHN,
        "x",
        "host-1",
        updateInput(),
      );
      expect(result.kind).toBe("unauthorized");
    }
  });

  it("maps a 5xx to network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(503, {})),
    );
    const result = await updateHostVersionPolicyViaHttp(
      AUTHN,
      "x",
      "host-1",
      updateInput(),
    );
    expect(result.kind).toBe("network-error");
  });

  it("maps a thrown fetch (transport/timeout) to network-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("boom");
      }),
    );
    const result = await updateHostVersionPolicyViaHttp(
      AUTHN,
      "x",
      "host-1",
      updateInput(),
    );
    expect(result.kind).toBe("network-error");
  });

  it("fails closed on a contract-violating 2xx body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(200, { host_id: "host-1" })),
    );
    const result = await updateHostVersionPolicyViaHttp(
      AUTHN,
      "x",
      "host-1",
      updateInput(),
    );
    expect(result.kind).toBe("network-error");
  });
});

describe("updateHostVersionPolicyViaHttp on a WebView without AbortSignal.timeout or AbortSignal.any (iOS 15.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    removeNativeAbortHelpers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("still makes the request and returns the applied policy", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, okBody()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateHostVersionPolicyViaHttp(
      AUTHN,
      "jwt-abc",
      "host-1",
      updateInput(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("ok");
  });

  it("aborts a request that never answers once its 10 s timeout passes, and resolves to network-error", async () => {
    const fetchMock = stubHangingFetch();

    const pending = updateHostVersionPolicyViaHttp(
      AUTHN,
      "jwt-abc",
      "host-1",
      updateInput(),
    );
    const signal = signalOfLastFetch(fetchMock);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "network-error" });
  });
});

describe("updateHostVersionPolicyViaHttp on a fetch that ignores its signal", () => {
  // HOST_VERSION_POLICY_FETCH_TIMEOUT_MS
  const POLICY_TIMEOUT_MS = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles at the deadline as a network error when the request never completes", async () => {
    // Like CapacitorHttp's patched fetch: the signal is dropped, so only the
    // deadline can settle the request.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
    let settled = false;

    const pending = updateHostVersionPolicyViaHttp(
      AUTHN,
      "jwt-abc",
      "host-1",
      updateInput(),
    );
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(POLICY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({ kind: "network-error" });
  });

  it("settles at the deadline as a network error when a 200 body never arrives", async () => {
    const response = new Response(null, { status: 200 });
    const json = vi
      .spyOn(response, "json")
      .mockImplementation(() => new Promise<unknown>(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response),
    );
    let settled = false;

    const pending = updateHostVersionPolicyViaHttp(
      AUTHN,
      "jwt-abc",
      "host-1",
      updateInput(),
    );
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(POLICY_TIMEOUT_MS - 1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({ kind: "network-error" });
  });
});
