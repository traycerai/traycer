/**
 * Tests for the shared device-flow client (`device-auth.ts`).
 *
 * The load-bearing requirement (tech plan v2, Finding 10): every wire status
 * from `POST /device/token` maps to its own explicit variant and NONE collapse
 * into a single `network-error` / `rejected`. This suite pins that mapping
 * status-by-status, the `/device/authorize` parsing, and the backoff helper.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySlowDown,
  createPollSchedule,
  isDeviceExpired,
  MAX_POLL_INTERVAL_SECONDS,
  pollDeviceToken,
  startDeviceAuthorization,
} from "../device-auth";

const AUTHN_BASE_URL = "https://authn.example.test";
const AUTHORIZE_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/device/authorize`;
const TOKEN_ENDPOINT = `${AUTHN_BASE_URL}/api/v3/auth/device/token`;

// Default request options for tests that don't exercise cancellation/timeout:
// no caller abort, generous timeout the mocked fetch resolves well within.
const REQUEST_OPTIONS = {
  signal: undefined,
  timeoutMs: 30_000,
} as const;

interface MockFetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface MockSpec {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string> | null;
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
    const rawBody = init?.body;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody,
    });
    const spec = specs[index] ?? specs[specs.length - 1];
    index++;
    const body =
      typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    return new Response(body, {
      status: spec.status,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  }) as typeof fetch;
  globalThis.fetch = fetchMock;
  return calls;
}

function installThrowingFetch(): void {
  globalThis.fetch = (async (): Promise<Response> => {
    throw new TypeError("network failure");
  }) as typeof fetch;
}

function spec(
  status: number,
  body: unknown,
  headers: Record<string, string> | null,
): MockSpec {
  return { status, body, headers };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("startDeviceAuthorization", () => {
  it("returns the parsed authorize fields on 200", async () => {
    installMockFetch([
      spec(
        200,
        {
          device_code: "dev-code",
          user_code: "ABCDE-FGHIJ",
          verification_uri: "https://traycer.test/device",
          verification_uri_complete:
            "https://traycer.test/device?user_code=ABCDE-FGHIJ",
          expires_in: 600,
          interval: 5,
        },
        null,
      ),
    ]);

    const result = await startDeviceAuthorization(
      AUTHN_BASE_URL,
      {
        clientId: "cli",
        hostLabel: "my-host",
      },
      REQUEST_OPTIONS,
    );

    expect(result).toEqual({
      kind: "started",
      deviceCode: "dev-code",
      userCode: "ABCDE-FGHIJ",
      verificationUri: "https://traycer.test/device",
      verificationUriComplete:
        "https://traycer.test/device?user_code=ABCDE-FGHIJ",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });
    expect(calls[0].url).toBe(AUTHORIZE_ENDPOINT);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      client_id: "cli",
      host_label: "my-host",
    });
  });

  it("returns network-error on transport failure", async () => {
    installThrowingFetch();
    const result = await startDeviceAuthorization(
      AUTHN_BASE_URL,
      {
        clientId: "desktop",
        hostLabel: "host",
      },
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("network-error");
  });

  it("returns network-error on a non-200 status", async () => {
    installMockFetch([spec(503, { error: "unavailable" }, null)]);
    const result = await startDeviceAuthorization(
      AUTHN_BASE_URL,
      {
        clientId: "cli",
        hostLabel: "host",
      },
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("network-error");
  });

  it("returns network-error when required fields are missing", async () => {
    installMockFetch([
      spec(200, { device_code: "dev-code", user_code: "ABCDE-FGHIJ" }, null),
    ]);
    const result = await startDeviceAuthorization(
      AUTHN_BASE_URL,
      {
        clientId: "cli",
        hostLabel: "host",
      },
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("network-error");
  });
});

describe("pollDeviceToken - HTTP status to variant mapping", () => {
  it("200 -> authorized with the rotated token pair", async () => {
    installMockFetch([
      spec(200, { token: "access-jws", refreshToken: "refresh-jws" }, null),
    ]);

    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );

    expect(result).toEqual({
      kind: "authorized",
      token: "access-jws",
      refreshToken: "refresh-jws",
    });
    expect(calls[0].url).toBe(TOKEN_ENDPOINT);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      device_code: "dev-code",
      client_id: "cli",
    });
  });

  it("200 with an unparseable body -> network-error (retryable)", async () => {
    installMockFetch([spec(200, { token: "" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("network-error");
  });

  it("428 -> authorization-pending", async () => {
    installMockFetch([spec(428, { error: "authorization_pending" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("authorization-pending");
  });

  it("429 -> slow-down honoring Retry-After", async () => {
    installMockFetch([
      spec(429, { error: "slow_down" }, { "Retry-After": "12" }),
    ]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result).toEqual({ kind: "slow-down", retryAfterSeconds: 12 });
  });

  it("429 without Retry-After -> slow-down with null retryAfterSeconds", async () => {
    installMockFetch([spec(429, { error: "slow_down" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result).toEqual({ kind: "slow-down", retryAfterSeconds: null });
  });

  it("400 access_denied -> access-denied", async () => {
    installMockFetch([spec(400, { error: "access_denied" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("access-denied");
  });

  it("400 expired -> expired", async () => {
    installMockFetch([spec(400, { error: "expired" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("expired");
  });

  it("400 invalid_grant -> invalid (terminal, not network-error)", async () => {
    installMockFetch([spec(400, { error: "invalid_grant" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("invalid");
  });

  it("400 with an unknown error code -> invalid (terminal)", async () => {
    installMockFetch([spec(400, { error: "something_else" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("invalid");
  });

  it("503 (Redis down) -> network-error", async () => {
    installMockFetch([spec(503, { error: "unavailable" }, null)]);
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("network-error");
  });

  it("transport failure -> network-error", async () => {
    installThrowingFetch();
    const result = await pollDeviceToken(
      AUTHN_BASE_URL,
      "dev-code",
      "cli",
      REQUEST_OPTIONS,
    );
    expect(result.kind).toBe("network-error");
  });
});

describe("cancellation and timeout", () => {
  // A fetch that never resolves on its own and only rejects when its `signal`
  // aborts (mirroring the real abortable fetch), so we can prove a caller abort
  // or per-request timeout collapses to the retryable `network-error`.
  function installHangingFetch(): void {
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
  }

  it("pollDeviceToken surfaces a caller abort as network-error", async () => {
    installHangingFetch();
    const controller = new AbortController();
    const poll = pollDeviceToken(AUTHN_BASE_URL, "dev-code", "cli", {
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    controller.abort();
    expect((await poll).kind).toBe("network-error");
  });

  it("pollDeviceToken surfaces a per-request timeout as network-error", async () => {
    installHangingFetch();
    const result = await pollDeviceToken(AUTHN_BASE_URL, "dev-code", "cli", {
      signal: undefined,
      timeoutMs: 5,
    });
    expect(result.kind).toBe("network-error");
  });

  it("startDeviceAuthorization surfaces a per-request timeout as network-error", async () => {
    installHangingFetch();
    const result = await startDeviceAuthorization(
      AUTHN_BASE_URL,
      { clientId: "cli", hostLabel: "host" },
      { signal: undefined, timeoutMs: 5 },
    );
    expect(result.kind).toBe("network-error");
  });
});

describe("backoff helper", () => {
  it("createPollSchedule clamps the interval and derives the deadline", () => {
    const schedule = createPollSchedule({
      intervalSeconds: 5,
      expiresInSeconds: 600,
      startedAtMs: 1_000,
    });
    expect(schedule.intervalMs).toBe(5_000);
    expect(schedule.expiresAtMs).toBe(601_000);
  });

  it("createPollSchedule falls back to the default for a non-positive interval", () => {
    const schedule = createPollSchedule({
      intervalSeconds: 0,
      expiresInSeconds: 600,
      startedAtMs: 0,
    });
    expect(schedule.intervalMs).toBe(5_000);
  });

  it("applySlowDown adds at least 5s when no Retry-After is given", () => {
    const schedule = createPollSchedule({
      intervalSeconds: 5,
      expiresInSeconds: 600,
      startedAtMs: 0,
    });
    expect(applySlowDown(schedule, null).intervalMs).toBe(10_000);
  });

  it("applySlowDown honors a larger Retry-After", () => {
    const schedule = createPollSchedule({
      intervalSeconds: 5,
      expiresInSeconds: 600,
      startedAtMs: 0,
    });
    expect(applySlowDown(schedule, 30).intervalMs).toBe(30_000);
  });

  it("applySlowDown never decreases the interval below the +5s floor", () => {
    const schedule = createPollSchedule({
      intervalSeconds: 20,
      expiresInSeconds: 600,
      startedAtMs: 0,
    });
    // Retry-After of 1s is smaller than current+5s (25s), so 25s wins.
    expect(applySlowDown(schedule, 1).intervalMs).toBe(25_000);
  });

  it("applySlowDown caps the interval at MAX_POLL_INTERVAL_SECONDS", () => {
    const schedule = createPollSchedule({
      intervalSeconds: 5,
      expiresInSeconds: 600,
      startedAtMs: 0,
    });
    expect(applySlowDown(schedule, 10_000).intervalMs).toBe(
      MAX_POLL_INTERVAL_SECONDS * 1000,
    );
  });

  it("isDeviceExpired reports the deadline relative to now", () => {
    const schedule = createPollSchedule({
      intervalSeconds: 5,
      expiresInSeconds: 600,
      startedAtMs: 1_000,
    });
    expect(isDeviceExpired(schedule, 600_999)).toBe(false);
    expect(isDeviceExpired(schedule, 601_000)).toBe(true);
  });
});
