import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceFlowController,
  type DeviceFlowResultPayload,
} from "../device-flow-controller";

/**
 * Drives the main-process device-flow controller against a mocked global
 * `fetch` so the `/device/authorize` + `/device/token` poll loop runs end to
 * end without a real authn service. Covers the Finding 7/9 guarantees: a
 * terminal result is delivered exactly once, cancellation stops the loop and
 * delivers nothing, and an authorize failure is reported as `ok: false`.
 */
const AUTHN = "http://authn.test";

type FetchHandler = (url: string) => Response;

function installFetch(handler: FetchHandler): () => void {
  const original: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> =>
      Promise.resolve(
        handler(typeof input === "string" ? input : String(input)),
      ),
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

function authorizeOk(): Response {
  return new Response(
    JSON.stringify({
      device_code: "device-code-123",
      user_code: "ABCDE-FGHIJ",
      verification_uri: "https://app.test/device",
      verification_uri_complete:
        "https://app.test/device?user_code=ABCDE-FGHIJ",
      expires_in: 600,
      interval: 1,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function tokenAuthorized(): Response {
  return new Response(
    JSON.stringify({ token: "tok", refreshToken: "tok-refresh" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("DeviceFlowController", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFetch();
  });

  it("delivers an authorized result after polling through a pending state", async () => {
    let tokenCalls = 0;
    restoreFetch = installFetch((url) => {
      if (url.endsWith("/device/authorize")) {
        return authorizeOk();
      }
      if (url.endsWith("/device/token")) {
        tokenCalls += 1;
        return tokenCalls === 1
          ? new Response(null, { status: 428 }) // authorization-pending
          : tokenAuthorized();
      }
      return new Response(null, { status: 500 });
    });

    const results: Array<{
      attemptId: string;
      result: DeviceFlowResultPayload;
    }> = [];
    const controller = new DeviceFlowController(AUTHN);
    const outcome = await controller.start({
      onResult: (attemptId, result) => results.push({ attemptId, result }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.authorization.userCode).toBe("ABCDE-FGHIJ");

    // First poll (428) → 1s backoff → second poll (200 authorized).
    await vi.advanceTimersByTimeAsync(1500);

    expect(results).toEqual([
      {
        attemptId: outcome.attemptId,
        result: {
          kind: "authorized",
          token: "tok",
          refreshToken: "tok-refresh",
        },
      },
    ]);
  });

  it("nudges an immediate re-poll on pollNow, collapsing the interval wait", async () => {
    let tokenCalls = 0;
    restoreFetch = installFetch((url) => {
      if (url.endsWith("/device/authorize")) {
        return authorizeOk();
      }
      if (url.endsWith("/device/token")) {
        tokenCalls += 1;
        return tokenCalls === 1
          ? new Response(null, { status: 428 }) // authorization-pending
          : tokenAuthorized();
      }
      return new Response(null, { status: 500 });
    });

    const results: Array<{
      attemptId: string;
      result: DeviceFlowResultPayload;
    }> = [];
    const controller = new DeviceFlowController(AUTHN);
    const outcome = await controller.start({
      onResult: (attemptId, result) => results.push({ attemptId, result }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    // Let the first poll resolve (428) so the loop parks in its ~1s sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(tokenCalls).toBe(1);
    expect(results).toEqual([]);

    // The browser-return nudge collapses the remaining interval into an
    // immediate re-poll WITHOUT advancing the interval timer.
    controller.pollNow(outcome.attemptId);
    await vi.advanceTimersByTimeAsync(0);

    expect(tokenCalls).toBe(2);
    expect(results).toEqual([
      {
        attemptId: outcome.attemptId,
        result: {
          kind: "authorized",
          token: "tok",
          refreshToken: "tok-refresh",
        },
      },
    ]);
  });

  it("ignores pollNow for an unknown or settled attempt", async () => {
    restoreFetch = installFetch((url) => {
      if (url.endsWith("/device/authorize")) {
        return authorizeOk();
      }
      return new Response(null, { status: 428 });
    });

    const controller = new DeviceFlowController(AUTHN);
    const outcome = await controller.start({ onResult: () => undefined });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    // No throw for an unknown attempt id, and a known id is a safe no-op.
    expect(() => controller.pollNow("does-not-exist")).not.toThrow();
    expect(() => controller.pollNow(outcome.attemptId)).not.toThrow();
    controller.cancel(outcome.attemptId);
  });

  it("delivers nothing once the attempt is cancelled (no leaked poll)", async () => {
    restoreFetch = installFetch((url) => {
      if (url.endsWith("/device/authorize")) {
        return authorizeOk();
      }
      // Never approves: stays pending forever.
      return new Response(null, { status: 428 });
    });

    const results: DeviceFlowResultPayload[] = [];
    const controller = new DeviceFlowController(AUTHN);
    const outcome = await controller.start({
      onResult: (_attemptId, result) => results.push(result),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    // Let the first poll resolve, then cancel before the next one.
    await vi.advanceTimersByTimeAsync(0);
    controller.cancel(outcome.attemptId);

    // Advancing well past several poll intervals yields no delivery.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(results).toEqual([]);
  });

  it("reports ok:false when /device/authorize fails (renderer surfaces a launch failure)", async () => {
    restoreFetch = installFetch(() => new Response(null, { status: 500 }));

    const controller = new DeviceFlowController(AUTHN);
    const outcome = await controller.start({ onResult: () => undefined });

    expect(outcome.ok).toBe(false);
  });

  it("delivers a denied result terminally", async () => {
    restoreFetch = installFetch((url) => {
      if (url.endsWith("/device/authorize")) {
        return authorizeOk();
      }
      return new Response(JSON.stringify({ error: "access_denied" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });

    const results: DeviceFlowResultPayload[] = [];
    const controller = new DeviceFlowController(AUTHN);
    const outcome = await controller.start({
      onResult: (_attemptId, result) => results.push(result),
    });
    expect(outcome.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(results).toEqual([{ kind: "denied" }]);
  });
});
