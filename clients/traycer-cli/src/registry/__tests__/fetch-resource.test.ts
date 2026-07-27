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
  type NetworkHeartbeat,
  waitForWriterDrain,
} from "../fetch-resource";
import { CliError } from "../../runner/errors";
import {
  closeFaultServer,
  sha256,
  startFaultServer,
} from "./fault-server-test-helpers";

const RESOURCE_URL = "https://registry.example.test/host.tar.gz";
// Retry tests keep production watchdogs frozen and advance only backoffs that
// the download reports through its heartbeat. The timeout remains a fail-closed
// guard for a genuine I/O hang; it is not used to poll fake time.
const SETTLE_RETRY_TEST_TIMEOUT_MS = 15_000;

function createRetryBackoffSignal() {
  let notify = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return { promise, notify };
}

let retryBackoffSignal = createRetryBackoffSignal();

let workDir: string;
let originalFetch: typeof globalThis.fetch;
const faultServers: Server[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "traycer-fetch-resource-"));
  originalFetch = globalThis.fetch;
  retryBackoffSignal = createRetryBackoffSignal();
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
  let emittedFirstChunk = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emittedFirstChunk) {
        emittedFirstChunk = true;
        controller.enqueue(new TextEncoder().encode(firstChunk));
        return;
      }
      controller.error(new Error(message));
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
    onHeartbeat: (heartbeat: NetworkHeartbeat) => {
      if (heartbeat.phase === "backoff") retryBackoffSignal.notify();
    },
    signal: null,
  };
}

async function settleRetryTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return { kind: "fulfilled" as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { kind: "rejected" as const, error };
    },
  );
  const settlement = outcome.then(() => undefined);
  while (!settled) {
    await Promise.race([settlement, retryBackoffSignal.promise]);
    if (settled) break;
    retryBackoffSignal = createRetryBackoffSignal();
    await vi.advanceTimersToNextTimerAsync();
  }
  const result = await outcome;
  if (result.kind === "rejected") throw result.error;
  return result.value;
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
    "resumes with a bare Range when the failed response had no validator",
    async () => {
      const destPath = join(workDir, "no-validator.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        return call === 1
          ? response(failingBody("abc", "transient stream failure"), 200, {})
          : response("def", 206, { "content-range": "bytes 3-5/6" });
      }) as typeof globalThis.fetch;

      const pending = downloadToFile(downloadOptions(destPath, "abcdef"));
      await settleRetryTimers(pending);

      expect(requests).toHaveLength(2);
      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[1]?.headers.get("if-range")).toBeNull();
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "resumes a partial left behind by a previous process",
    async () => {
      // The cross-invocation case (traycer#588): a fresh downloader sees
      // bytes on disk and no validator for them - it must put the offset on
      // the wire, not delete the file before the first request.
      const destPath = join(workDir, "prior-process.tar.gz");
      writeFileSync(destPath, "abc");
      const requests: Request[] = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        return response("def", 206, { "content-range": "bytes 3-5/6" });
      }) as typeof globalThis.fetch;

      const result = await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, "abcdef")),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[0]?.headers.get("if-range")).toBeNull();
      expect(result).toEqual({ downloadedBytes: 6, sha256: sha256("abcdef") });
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "reports the resumed offset before the attempt's first byte arrives",
    async () => {
      // Desktop carries the last concrete progress value forward, but a
      // freshly spawned process has no prior value to carry. A resumed
      // download that stays silent until its first chunk therefore renders
      // no progress bar at all while a large partial sits on disk - the
      // resume itself becomes invisible, which reads as "it started over".
      // The offset has to be published before the request goes out.
      const destPath = join(workDir, "resume-progress.tar.gz");
      writeFileSync(destPath, "abc");
      const opts = downloadOptions(destPath, "abcdef");
      let progressTicksWhenRequestIssued = -1;
      globalThis.fetch = vi.fn(async () => {
        progressTicksWhenRequestIssued = opts.onProgress.mock.calls.length;
        return response("def", 206, { "content-range": "bytes 3-5/6" });
      }) as typeof globalThis.fetch;

      await settleRetryTimers(downloadToFile(opts));

      expect(opts.onProgress.mock.calls[0]?.[0]).toEqual({
        downloadedBytes: 3,
        totalBytes: 6,
      });
      // Published by the time the request was issued, so it is the partial
      // being reported rather than a byte of the new response.
      expect(progressTicksWhenRequestIssued).toBe(1);
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "reports the rewind when a resume is forced to restart from zero",
    async () => {
      // An origin that answers 200 to a Range makes the downloader discard
      // the partial. The offset tick at the top of the next attempt is what
      // moves the bar back to 0 immediately; without it the bar would hold
      // the stale pre-restart percentage until the next chunk landed.
      const destPath = join(workDir, "restart-progress.tar.gz");
      writeFileSync(destPath, "abc");
      const opts = downloadOptions(destPath, "abcdef");
      globalThis.fetch = vi.fn(async () =>
        response("abcdef", 200, {}),
      ) as typeof globalThis.fetch;

      await settleRetryTimers(downloadToFile(opts));

      const reported = opts.onProgress.mock.calls.map(
        (call) => call[0].downloadedBytes,
      );
      expect(reported[0]).toBe(3);
      expect(reported[1]).toBe(0);
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "resumes a body that ends short without raising a stream error",
    async () => {
      // Not every truncation surfaces as a stream error: bun's fetch
      // reports some mid-body connection drops as a clean end-of-stream,
      // and a response without a usable length can end short on any
      // runtime. Trusting `done` alone let a truncated transfer be reported
      // as a finished download, so the size check failed terminally and
      // took the partial with it - traycer#585's "downloaded 231 MB of
      // 721 MB before failure". A short body must stay a retryable
      // transfer failure that the next attempt resumes.
      const destPath = join(workDir, "short-clean-eof.tar.gz");
      const requests: Request[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        call += 1;
        // Ends cleanly after 3 of 6 bytes - no error on the stream.
        return call === 1
          ? response("abc", 200, { etag: '"etag-1"' })
          : response("def", 206, { "content-range": "bytes 3-5/6" });
      }) as typeof globalThis.fetch;

      const result = await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, "abcdef")),
      );

      expect(requests).toHaveLength(2);
      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(result).toEqual({ downloadedBytes: 6, sha256: sha256("abcdef") });
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "keeps going after a forced restart as long as every attempt transfers",
    async () => {
      // One Range-ignoring hop (a CDN edge, a corporate proxy) forces a
      // restart from zero mid-resume. Everything after it makes real forward
      // progress and must be allowed to finish. Judging that progress against
      // a high-water mark left over from BEFORE the restart made it
      // unreachable, so a 700MB resume gave up inside six attempts while
      // genuinely transferring on every one of them.
      const destPath = join(workDir, "restart-then-progress.tar.gz");
      // The pre-restart partial has to sit far enough above what the post-
      // restart dribble can reach inside the stall budget, or the download
      // escapes the stale mark by accident and the regression hides: 30 of 40
      // bytes already on disk, then 2 bytes per attempt, needs 16 attempts to
      // climb back past 30 against a budget of 6.
      const expected = "a".repeat(40);
      writeFileSync(destPath, "a".repeat(30));
      let call = 0;
      globalThis.fetch = vi.fn(async (input, init) => {
        const request = new Request(input, init);
        call += 1;
        // 1: ignores the Range and answers 200 -> partial discarded.
        if (call === 1) return response(expected, 200, {});
        // Then two bytes per attempt, each body ending short of its promise
        // so the attempt stays a retryable transfer failure.
        const range = request.headers.get("range");
        const offset =
          range === null ? 0 : Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
        const slice = expected.slice(offset, offset + 2);
        return offset === 0
          ? response(slice, 200, {})
          : response(slice, 206, {
              "content-range": `bytes ${offset}-${expected.length - 1}/${expected.length}`,
            });
      }) as typeof globalThis.fetch;

      const result = await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, expected)),
      );

      expect(result).toEqual({
        downloadedBytes: expected.length,
        sha256: sha256(expected),
      });
      expect(readFileSync(destPath, "utf8")).toBe(expected);
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "gives up promptly when the origin's entity is shorter than the manifest declares",
    async () => {
      // A truncated publish, or a mirror serving a partial object. Judging
      // progress against the attempt's own starting offset let this run
      // forever: the short body looked like progress, the next attempt's
      // Range past the end took a 416 and restarted from zero, and the one
      // after that "progressed" over the same bytes again - resetting the
      // stall counter every other attempt and burning the whole runaway
      // guard on ~100 complete re-transfers of an archive that can never
      // verify. Against a high-water mark that only ever rises, re-reading
      // the same bytes is correctly not progress.
      const destPath = join(workDir, "short-entity.tar.gz");
      const requests: Request[] = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        // The origin only ever holds 3 of the 6 declared bytes.
        return request.headers.get("range") === null
          ? response("abc", 200, { etag: '"short-entity"' })
          : response(null, 416, { "content-range": "bytes */3" });
      }) as typeof globalThis.fetch;

      await expect(
        settleRetryTimers(downloadToFile(downloadOptions(destPath, "abcdef"))),
      ).rejects.toBeInstanceOf(CliError);

      // Two attempts per stall (a transfer then a 416 restart) plus a little
      // slack - nowhere near `MAX_DOWNLOAD_ATTEMPTS`.
      expect(requests.length).toBeLessThanOrEqual(16);
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the partial file when the attempt budget is exhausted",
    async () => {
      // The next CLI invocation resumes from these bytes. Deleting them is
      // what made a throttled download restart from zero forever.
      const destPath = join(workDir, "exhausted.tar.gz");
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call += 1;
        // One byte per attempt, then a reset: never completes, and each
        // attempt is a stall (no forward progress) after the first.
        return call === 1
          ? response(failingBody("abc", "reset"), 200, { etag: '"etag-1"' })
          : response(null, 500, {});
      }) as typeof globalThis.fetch;

      await expect(
        settleRetryTimers(downloadToFile(downloadOptions(destPath, "abcdef"))),
      ).rejects.toBeInstanceOf(CliError);

      expect(readFileSync(destPath, "utf8")).toBe("abc");
    },
    SETTLE_RETRY_TEST_TIMEOUT_MS,
  );

  it(
    "spends stall budget only on attempts that made no progress",
    async () => {
      // Six resets that each append a byte must not exhaust a budget that a
      // dead endpoint burns in six attempts - forward progress is what buys
      // the next round (traycer#589).
      const destPath = join(workDir, "progress-budget.tar.gz");
      const payload = "abcdefghij";
      let call = 0;
      globalThis.fetch = vi.fn(async (_input, _init) => {
        call += 1;
        if (call > payload.length) {
          throw new Error(`unexpected attempt ${call}`);
        }
        const next = payload.slice(call - 1, call);
        return call === payload.length
          ? response(next, 206, {
              "content-range": `bytes ${call - 1}-${call - 1}/${payload.length}`,
            })
          : response(
              failingBody(next, "reset after one byte"),
              call === 1 ? 200 : 206,
              call === 1
                ? {}
                : {
                    "content-range": `bytes ${call - 1}-${payload.length - 1}/${payload.length}`,
                  },
            );
      }) as typeof globalThis.fetch;

      const result = await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, payload)),
      );

      expect(call).toBe(payload.length);
      expect(result.sha256).toBe(sha256(payload));
      expect(readFileSync(destPath, "utf8")).toBe(payload);
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
    // A blackholed archive never transfers a byte, so every attempt counts
    // against the stall budget. Drive enough rounds (watchdog + the growing
    // backoff) for that budget to run out; each iteration advances past the
    // longest single wait either can impose.
    let done = false;
    void outcome.then(() => {
      done = true;
    });
    for (let attempt = 0; attempt < 20 && !done; attempt += 1) {
      await new Promise<void>((resolve) => {
        nativeSetTimeout(resolve, 10);
      });
      await vi.advanceTimersByTimeAsync(30_000);
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
    "never sends a weak ETag as If-Range, but still resumes by offset",
    async () => {
      // A weak validator cannot certify byte-for-byte identity, so it must
      // not gate the server's resume decision. The bare Range still goes
      // out - Content-Range and sha256 are what make that safe.
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
          : response("def", 206, { "content-range": "bytes 3-5/6" });
      }) as typeof globalThis.fetch;

      await settleRetryTimers(
        downloadToFile(downloadOptions(destPath, "abcdef")),
      );

      expect(requests[1]?.headers.get("range")).toBe("bytes=3-");
      expect(requests[1]?.headers.get("if-range")).toBeNull();
      expect(readFileSync(destPath, "utf8")).toBe("abcdef");
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
