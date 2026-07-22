import type { Server } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadToFile,
  fetchText,
  waitForWriterDrain,
} from "../fetch-resource";
import { CliError } from "../../runner/errors";
import {
  closeFaultServer,
  sha256,
  startFaultServer,
} from "./fault-server-test-helpers";

const RESOURCE_URL = "https://registry.example.test/host.tar.gz";
// settleRetryTimers drives ~100 real event-loop turns to advance fake
// timers past the production backoff; under CI CPU contention that real
// wall-clock cost alone can exceed vitest's 5s default test timeout.
const SETTLE_RETRY_TEST_TIMEOUT_MS = 15_000;

let workDir: string;
let originalFetch: typeof globalThis.fetch;
const faultServers: Server[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "traycer-fetch-resource-"));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  await Promise.all(
    faultServers.splice(0).map((server) => closeFaultServer(server)),
  );
  rmSync(workDir, { recursive: true, force: true });
});

function firstRequestHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function response(
  body: string | ReadableStream<Uint8Array> | null,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(body, { status, headers });
}

function failingBody(
  firstChunk: string,
  message: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
      setTimeout(() => controller.error(new Error(message)), 1);
    },
  });
}

function downloadOptions(destPath: string, expected: string) {
  return {
    url: RESOURCE_URL,
    destPath,
    expectedSizeBytes: Buffer.byteLength(expected),
    expectedSha256: sha256(expected),
    onProgress: vi.fn(),
    onHeartbeat: null,
    signal: null,
  };
}

async function settleRetryTimers<T>(promise: Promise<T>): Promise<T> {
  // Retries use a short production backoff. Advance enough timer turns to
  // cover every attempt while allowing response/body microtasks to run.
  const outcome = promise.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  const settled = await outcome;
  if (settled.kind === "rejected") throw settled.error;
  return settled.value;
}

describe("waitForWriterDrain", () => {
  it("rejects and removes listeners when the writer errors before drain", async () => {
    const writer = new PassThrough();
    const pending = waitForWriterDrain(
      writer,
      "https://example.invalid/host.tgz",
    );
    const error = new Error("disk write failed");

    writer.emit("error", error);

    await expect(pending).rejects.toBe(error);
    expect(writer.listenerCount("drain")).toBe(0);
    expect(writer.listenerCount("error")).toBe(0);
    expect(writer.listenerCount("close")).toBe(0);
  });
});

describe("downloadToFile resume and integrity policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it(
    "uses the on-disk stat offset after a buffered write fails",
    async () => {
      const destPath = join(workDir, "host.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        if (call === 1) {
          return response(
            failingBody("abc", "connection reset after buffered write"),
            200,
            {
              etag: '"strong-etag"',
            },
          );
        }
        return response("def", 206, {
          "content-range": "bytes 3-5/6",
        });
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      const result = await settleRetryTimers(pending);

      expect(result).toEqual({ downloadedBytes: 6, sha256: sha256("abcdef") });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[1]?.headers.get("if-range")).toBe('"strong-etag"');
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
      expect(statSync(destPath).size).toBe(6);
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it.each([
    ["strong ETag", { etag: '"etag-1"' }, '"etag-1"'],
    [
      "Last-Modified",
      { "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" },
      "Wed, 21 Oct 2015 07:28:00 GMT",
    ],
  ] as const)(
    "uses %s as If-Range",
    async (_label, validatorHeaders, expectedValidator) => {
      const destPath = join(workDir, "validator.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        return call === 1
          ? response(
              failingBody("abc", "transient stream failure"),
              200,
              validatorHeaders,
            )
          : response("def", 206, { "content-range": "bytes 3-5/6" });
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      await settleRetryTimers(pending);

      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[1]?.headers.get("if-range")).toBe(expectedValidator);
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "restarts from zero when the failed response had no validator",
    async () => {
      const destPath = join(workDir, "no-validator.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        return call === 1
          ? response(failingBody("abc", "transient stream failure"), 200, {})
          : response("abcdef", 200, {});
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      await settleRetryTimers(pending);

      expect(requests).toHaveLength(2);
      expect(requests[1]?.headers.get("range")).toBeNull();
      expect(requests[1]?.headers.get("if-range")).toBeNull();
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "discards a mismatched Content-Range and retries from zero",
    async () => {
      const destPath = join(workDir, "bad-range.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        if (call === 1)
          return response(failingBody("abc", "stream reset"), 200, {
            etag: '"etag-1"',
          });
        if (call === 2)
          return response(null, 206, { "content-range": "bytes 2-5/6" });
        return response("abcdef", 200, {});
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      await settleRetryTimers(pending);

      expect(requests).toHaveLength(3);
      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[2]?.headers.get("range")).toBeNull();
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "accepts a 416 response when the on-disk file is already complete",
    async () => {
      const destPath = join(workDir, "complete-416.tar.gz");
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call += 1;
        return call === 1
          ? response(
              failingBody("abcdef", "connection reset after full write"),
              200,
              { etag: '"etag-1"' },
            )
          : response(null, 416, {});
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      const result = await settleRetryTimers(pending);

      expect(result.sha256).toBe(sha256("abcdef"));
      expect(call).toBe(2);
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "clears an incomplete 416 and restarts with a full response",
    async () => {
      const destPath = join(workDir, "incomplete-416.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        if (call === 1)
          return response(failingBody("abc", "stream reset"), 200, {
            etag: '"etag-1"',
          });
        if (call === 2) return response(null, 416, {});
        return response("abcdef", 200, {});
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      await settleRetryTimers(pending);

      expect(requests).toHaveLength(3);
      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[2]?.headers.get("range")).toBeNull();
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "does not reuse a validator from before an incomplete 416 restart",
    async () => {
      const destPath = join(workDir, "stale-validator-after-416.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        if (call === 1) {
          return response(failingBody("abc", "first entity reset"), 200, {
            etag: '"etag-a"',
          });
        }
        if (call === 2) return response(null, 416, {});
        if (call === 3) {
          return response(failingBody("abc", "replacement entity reset"), 200, {
            etag: '"etag-b"',
          });
        }
        return response("def", 206, { "content-range": "bytes 3-5/6" });
      }) as typeof globalThis.fetch;

      await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, "abcdef")),
      );

      expect(requests[1]?.headers.get("if-range")).toBe('"etag-a"');
      expect(requests[2]?.headers.get("range")).toBeNull();
      expect(requests[3]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[3]?.headers.get("if-range")).toBe('"etag-b"');
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "falls back from a redirecting 200 response to a clean full download",
    async () => {
      const destPath = join(workDir, "redirect-200.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        if (call === 1)
          return response(failingBody("abc", "stream reset"), 200, {
            etag: '"etag-1"',
          });
        if (call === 2) return response("abcdef", 200, {});
        return response("abcdef", 200, {});
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      await settleRetryTimers(pending);

      expect(requests).toHaveLength(3);
      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[2]?.headers.get("range")).toBeNull();
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it("preserves Range and If-Range across a real redirect before the 200 fallback", async () => {
    vi.useRealTimers();
    const requests: Array<{
      path: string;
      range: string | undefined;
      ifRange: string | undefined;
    }> = [];
    let archiveRequests = 0;
    const baseUrl = await startFaultServer((request, response) => {
      requests.push({
        path: request.url ?? "",
        range: firstRequestHeaderValue(request.headers.range),
        ifRange: firstRequestHeaderValue(request.headers["if-range"]),
      });
      if (request.url === "/archive") {
        archiveRequests += 1;
        if (archiveRequests === 1) {
          response.writeHead(200, {
            "content-length": "6",
            etag: '"etag-1"',
          });
          response.write("abc", () => response.destroy());
          return;
        }
        if (archiveRequests === 2) {
          response.writeHead(302, { location: "/redirect" });
          response.end();
          return;
        }
        response.writeHead(200, { "content-length": "6" });
        response.end("abcdef");
        return;
      }
      response.writeHead(200, { "content-length": "6" });
      response.end("abcdef");
    }, faultServers);
    const destPath = join(workDir, "real-redirect.tar.gz");

    const result = await downloadToFile({
      ...downloadOptions(destPath, "abcdef"),
      url: `${baseUrl}/archive`,
    });

    expect(result.sha256).toBe(sha256("abcdef"));
    expect(requests).toEqual([
      { path: "/archive", range: undefined, ifRange: undefined },
      { path: "/archive", range: "bytes=3-", ifRange: '"etag-1"' },
      { path: "/redirect", range: "bytes=3-", ifRange: '"etag-1"' },
      { path: "/archive", range: undefined, ifRange: undefined },
    ]);
  });

  it("arms the archive watchdog before a real server sends headers", async () => {
    vi.useRealTimers();
    const nativeSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();
    let sawRequest = false;
    const baseUrl = await startFaultServer(() => {
      sawRequest = true;
    }, faultServers);
    const server = faultServers[faultServers.length - 1];
    if (server === undefined) throw new Error("fault server was not retained");
    const heartbeats: string[] = [];
    const pending = downloadToFile({
      ...downloadOptions(join(workDir, "archive-blackhole.tar.gz"), "abcdef"),
      url: `${baseUrl}/archive`,
      onHeartbeat: (heartbeat) => heartbeats.push(heartbeat.phase),
    });
    const outcome = pending.then(
      () => ({ kind: "ok" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    for (let tick = 0; tick < 50 && !sawRequest; tick += 1) {
      await new Promise<void>((resolve) => {
        nativeSetTimeout(resolve, 10);
      });
    }
    expect(sawRequest).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await closeFaultServer(server);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise<void>((resolve) => {
        nativeSetTimeout(resolve, 10);
      });
      await vi.advanceTimersByTimeAsync(750);
    }

    const settled = await outcome;
    expect(settled.kind).toBe("error");
    if (settled.kind === "error") {
      expect(settled.error).toMatchObject({
        name: "CliError",
        code: "E_REGISTRY_UNAVAILABLE",
      });
    }
    expect(heartbeats.slice(0, 3)).toEqual(["attempt", "watchdog", "backoff"]);
  });

  it(
    "performs exactly one clean retry for a final sha256 mismatch",
    async () => {
      const destPath = join(workDir, "sha256-mismatch.tar.gz");
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call += 1;
        return response("ghijkl", 200, {});
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      await expect(settleRetryTimers(pending)).rejects.toMatchObject({
        name: "CliError",
        code: "E_HOST_VERIFY_FAILED",
      });
      expect(call).toBe(2);
      expect(() => statSync(destPath)).toThrow();
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it.each(["bytes 2-5/6", "bytes 3-5/7"])(
    "discards a Content-Range whose start or total does not match (%s)",
    async (invalidContentRange) => {
      const destPath = join(workDir, "invalid-content-range.tar.gz");
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return response(failingBody("abc", "stream reset"), 200, {
            etag: '"etag-1"',
          });
        }
        if (call === 2) {
          return response("def", 206, {
            "content-range": invalidContentRange,
          });
        }
        return response("abcdef", 200, {});
      }) as typeof globalThis.fetch;

      await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, "abcdef")),
      );

      expect(call).toBe(3);
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "does not resume a weak ETag without a Last-Modified validator",
    async () => {
      const destPath = join(workDir, "weak-etag.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        return call === 1
          ? response(failingBody("abc", "stream reset"), 200, {
              etag: 'W/"weak-etag"',
            })
          : response("abcdef", 200, {});
      }) as typeof globalThis.fetch;

      await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, "abcdef")),
      );

      expect(requests[1]?.headers.get("range")).toBeNull();
      expect(requests[1]?.headers.get("if-range")).toBeNull();
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );
});

describe("fetch watchdogs and heartbeat semantics", () => {
  it("fails closed when connect/redirect/TTFB never produces a response", async () => {
    vi.useFakeTimers();
    const heartbeats: string[] = [];
    globalThis.fetch = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        }),
    ) as typeof globalThis.fetch;

    const pending = fetchText(RESOURCE_URL, {
      signal: null,
      onHeartbeat: (heartbeat) => heartbeats.push(heartbeat.phase),
    });
    const settled = pending.then(
      (value) => ({ kind: "ok" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(750);
    }

    const outcome = await settled;
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toMatchObject({
        name: "CliError",
        code: "E_REGISTRY_UNAVAILABLE",
      });
    }
    expect(heartbeats.filter((phase) => phase === "watchdog")).toHaveLength(4);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("resets the gap watchdog after each received chunk", async () => {
    vi.useFakeTimers();
    const heartbeats: string[] = [];
    globalThis.fetch = vi.fn(async () =>
      response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            }, 9_000);
          },
        }),
        200,
        {},
      ),
    ) as typeof globalThis.fetch;

    const pending = fetchText(RESOURCE_URL, {
      signal: null,
      onHeartbeat: (heartbeat) => heartbeats.push(heartbeat.phase),
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(9_000);

    await expect(pending).resolves.toBe("firstsecond");
    expect(heartbeats).toEqual(["attempt"]);
  });

  it("caps a slow-drip text response before Desktop inactivity can win", async () => {
    vi.useFakeTimers();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    globalThis.fetch = vi.fn((_input, init) => {
      let dripTimer: NodeJS.Timeout | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode("x"));
          dripTimer = setInterval(() => {
            controller.enqueue(new TextEncoder().encode("x"));
          }, 9_000);
        },
        cancel() {
          if (dripTimer !== null) clearInterval(dripTimer);
          streamController = null;
        },
      });
      init?.signal?.addEventListener(
        "abort",
        () => {
          if (dripTimer !== null) clearInterval(dripTimer);
          if (streamController !== null) {
            streamController.error(new Error("attempt aborted"));
          }
        },
        { once: true },
      );
      return Promise.resolve(response(body, 200, {}));
    }) as typeof globalThis.fetch;
    let inactivityExpired = false;
    let inactivityTimer: NodeJS.Timeout | null = null;
    const resetInactivity = (): void => {
      if (inactivityTimer !== null) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        inactivityExpired = true;
      }, 45_000);
    };
    resetInactivity();
    const pending = fetchText(RESOURCE_URL, {
      signal: null,
      onHeartbeat: () => resetInactivity(),
    });
    const outcome = pending.then(
      () => ({ kind: "ok" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(750);
    }

    const settled = await outcome;
    expect(settled.kind).toBe("error");
    if (settled.kind === "error") {
      expect(settled.error).toMatchObject({
        name: "CliError",
        code: "E_REGISTRY_UNAVAILABLE",
      });
    }
    expect(inactivityExpired).toBe(false);
  });
});
