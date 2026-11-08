import { readFile, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { hashFileSha256 } from "../installer/sha256";
import { registryFetch } from "./staging-release-auth";

// Tiny resource fetcher used by the registry client. Supports the two
// schemes the manifest URLs are allowed to use:
//
//   - `https://...` / `http://...` - Node's built-in `fetch`.
//   - `file://...` - local filesystem reads, used by test fixtures and
//                    by the smoke-test publishing script which exercises
//                    the same client against a local staging dir.
//
// Failures (network, non-2xx, missing file) surface as
// REGISTRY_UNAVAILABLE so the caller can decide whether to escalate
// (explicit CLI command) or swallow (background launch-time check -
// landed in NP-5/NP-6, contract reserved here).
//
// `fetchText` is used for `versions.json` and `.minisig` files (both
// small). `downloadToFile` streams arbitrarily-large archives to disk
// with progress callbacks so the install UX can render a live %.
//
// Both paths enforce a streaming size cap and abort the underlying
// fetch the moment the cap is exceeded. This stops a hostile CDN from
// streaming gigabytes into the user's tmpdir before the post-hoc
// sha256/size verification has a chance to fail.

// Hard cap for `fetchText` payloads (manifests + minisign files). A
// production versions.json with thousands of entries is well under
// 1MB, and minisign signature files are <1KB; anything larger is a
// red flag.
const FETCH_TEXT_MAX_BYTES = 1024 * 1024;

// Small absolute slack added on top of `expectedSizeBytes` when
// streaming an archive to disk. Lets implementations append a few
// trailing bytes (e.g. a final \r\n on the wire) without aborting,
// while still capping a hostile run-on stream.
const DOWNLOAD_SIZE_SLACK_BYTES = 1024;

// A download can be large, but a healthy connection should still produce a
// byte regularly. Keeping this well below Desktop's inactivity policy lets the
// CLI emit a bounded registry failure instead of being SIGKILLed first.
const DOWNLOAD_WATCHDOG_MS = 30_000;
const FETCH_TEXT_WATCHDOG_MS = 10_000;
// Unlike an archive, registry text is always small. Cap a whole attempt so a
// peer that drips one byte just inside the gap watchdog cannot hold the
// Desktop's progress-inactivity timer forever.
const FETCH_TEXT_ATTEMPT_CAP_MS = 20_000;
const NETWORK_RETRY_BACKOFF_MS = 750;

// Archive downloads get their own budget, separate from `fetchText`'s
// small-payload one (traycer#585/#588). On a throttled link the connection
// is reset every few MB, so a flat 4-attempt cap gives up after ~20MB of a
// 700MB archive even though every attempt made real progress.
//
// What terminates a download is therefore the CONSECUTIVE-STALL count, not
// the attempt count: an attempt that appended bytes to the partial file
// resets it, so a reset-prone-but-advancing link keeps going while a
// genuinely dead endpoint still fails within seconds. `MAX_DOWNLOAD_
// ATTEMPTS` is only a runaway guard for a peer that dribbles a byte per
// attempt - it is not the budget that is expected to bind.
const MAX_DOWNLOAD_ATTEMPTS = 200;
const MAX_DOWNLOAD_STALL_ATTEMPTS = 6;
// A restart discards every byte on disk, so it is the one event the stall
// budget cannot police - it resets the yardstick progress is measured
// against. Bounded separately: a healthy origin restarts a resume at most
// once or twice (one edge in a CDN ignoring `Range`), while an origin whose
// entity simply does not match the manifest restarts on every single
// attempt and must not be allowed to re-transfer the archive indefinitely.
const MAX_DOWNLOAD_RESTARTS = 3;
// Backoff grows only while the download is STALLED (750ms, 1.5s, 3s, 6s,
// 12s, capped) - an ISP that resets connections once a data threshold is
// crossed needs a pause to recover, and hammering it every 750ms just
// re-enters the same throttling window. An attempt that transferred bytes
// resets the exponent with it, so an occasional reset on an otherwise
// healthy link never pays more than the base delay.
const DOWNLOAD_RETRY_BACKOFF_CAP_MS = 15_000;

interface DrainableWriter {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  once(event: "drain", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export interface FetchOptions {
  readonly signal: AbortSignal | null;
  readonly onHeartbeat: NetworkHeartbeatListener | null;
}

export interface NetworkHeartbeat {
  readonly phase: "attempt" | "watchdog" | "backoff";
  readonly attempt: number;
  // The ceiling this attempt counter is actually judged against, or `null`
  // when the counter has no meaningful ceiling to show. `fetchText` reports
  // a per-document attempt budget. An archive
  // download does not: what terminates it is the consecutive-stall count,
  // while `MAX_DOWNLOAD_ATTEMPTS` is only a runaway guard set far above any
  // real transfer. Rendering "attempt 41/200" there describes a countdown
  // that does not exist - the download would survive 200 more resets as
  // long as each one moved bytes.
  readonly maxAttempts: number | null;
}

export type NetworkHeartbeatListener = (heartbeat: NetworkHeartbeat) => void;

export async function fetchText(
  url: string,
  opts: FetchOptions,
): Promise<string> {
  return fetchTextFromOrigins([url], opts, async (body) => body, null);
}

// One document owns one budget, including origin switches and integrity checks.
export async function fetchTextFromOrigins<T>(
  urls: readonly string[],
  opts: FetchOptions,
  accept: (body: string, url: string, signal: AbortSignal) => Promise<T>,
  fetchDocument: ((url: string, opts: FetchOptions) => Promise<string>) | null,
): Promise<T> {
  const controller = new AbortController();
  const signal = linkAbortSignals(controller, opts.signal);
  let cap: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    cap = setTimeout(() => {
      controller.abort();
      reject(
        networkError(urls.join(", "), "document exceeded 180-second budget"),
      );
    }, 180_000);
  });
  let lastError: unknown = null;
  let attempt = 0;
  let integrityError: unknown = null;
  const retryable = new Set(urls);
  const readOrigins = async (): Promise<T> => {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (cycle > 0 && retryable.size > 0) {
        emitHeartbeat(opts.onHeartbeat, "backoff", attempt, urls.length * 4);
        await waitForRetry(NETWORK_RETRY_BACKOFF_MS);
      }
      for (const url of urls) {
        if (cycle > 0 && !retryable.has(url)) continue;
        for (let local = 0; local < 2; local += 1) {
          if (signal.aborted) throw networkError(url, lastError);
          attempt += 1;
          emitHeartbeat(opts.onHeartbeat, "attempt", attempt, urls.length * 4);
          let body: string;
          try {
            body =
              fetchDocument === null
                ? await fetchTextAttempt(
                    url,
                    { ...opts, signal },
                    attempt,
                    urls.length * 4,
                  )
                : await fetchDocument(url, { ...opts, signal });
          } catch (err) {
            const shutdownCode = httpClientShutdownCode(err);
            if (shutdownCode !== null)
              throw httpClientShutdownError(url, shutdownCode);
            lastError = err;
            if (signal.aborted) throw networkError(url, err);
            if (
              isCliError(err) ||
              (err instanceof HttpStatusError && !err.retryable)
            ) {
              retryable.delete(url);
              break;
            }
            continue;
          }
          try {
            return await accept(body, url, signal);
          } catch (err) {
            integrityError = err;
            lastError = err;
            retryable.delete(url);
            break;
          }
        }
      }
    }
    if (integrityError !== null) throw integrityError;
    if (isCliError(lastError)) throw lastError;
    throw exhaustedNetworkError(urls.join(", "), lastError, attempt);
  };
  try {
    return await Promise.race([readOrigins(), timeout]);
  } finally {
    if (cap !== null) clearTimeout(cap);
    controller.abort();
  }
}

async function fetchTextAttempt(
  url: string,
  opts: FetchOptions,
  attempt: number,
  maxAttempts: number,
): Promise<string> {
  if (isFileUrl(url)) {
    const path = fileUrlToPath(url);
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch (err) {
      throw networkError(url, err);
    }
    if (raw.byteLength > FETCH_TEXT_MAX_BYTES) {
      throw oversizeError(url, raw.byteLength, FETCH_TEXT_MAX_BYTES);
    }
    return raw.toString("utf8");
  }
  const controller = new AbortController();
  const linkedSignal = linkAbortSignals(controller, opts.signal);
  const watchdog = createWatchdog({
    controller,
    timeoutMs: FETCH_TEXT_WATCHDOG_MS,
    onTimeout: () =>
      emitHeartbeat(opts.onHeartbeat, "watchdog", attempt, maxAttempts),
  });
  const attemptCap = setTimeout(() => {
    emitHeartbeat(opts.onHeartbeat, "watchdog", attempt, maxAttempts);
    controller.abort();
  }, FETCH_TEXT_ATTEMPT_CAP_MS);
  try {
    const response = await registryFetch(url, { signal: linkedSignal });
    if (!response.ok) {
      throw await httpStatusFailure(url, response);
    }
    if (response.body === null) {
      const body = await response.text();
      const byteLength = Buffer.byteLength(body);
      if (byteLength > FETCH_TEXT_MAX_BYTES) {
        throw oversizeError(url, byteLength, FETCH_TEXT_MAX_BYTES);
      }
      return body;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (chunk === undefined) continue;
      watchdog.reset();
      received += chunk.byteLength;
      if (received > FETCH_TEXT_MAX_BYTES) {
        controller.abort();
        throw oversizeError(url, received, FETCH_TEXT_MAX_BYTES);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    controller.abort();
    watchdog.clear();
    clearTimeout(attemptCap);
  }
}

export interface DownloadToFileOptions extends FetchOptions {
  readonly url: string;
  readonly mirrorUrls?: readonly string[];
  readonly destPath: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
  readonly onProgress: (info: {
    readonly downloadedBytes: number;
    readonly totalBytes: number;
  }) => void;
}

export interface DownloadToFileResult {
  readonly downloadedBytes: number;
  readonly sha256: string;
}

export async function downloadToFile(
  opts: DownloadToFileOptions,
): Promise<DownloadToFileResult> {
  if (isFileUrl(opts.url)) {
    return downloadFileScheme(opts);
  }
  return downloadWithRetries(opts);
}

interface DownloadState {
  entityValidator: string | null;
  sawFirstSuccessfulResponse: boolean;
}

type DownloadAttemptResult =
  | { readonly kind: "complete" }
  | { readonly kind: "restart"; readonly reason: string };

type DownloadVerification =
  | { readonly kind: "verified"; readonly result: DownloadToFileResult }
  | { readonly kind: "mismatch"; readonly error: Error };

async function downloadWithRetries(
  opts: DownloadToFileOptions,
): Promise<DownloadToFileResult> {
  const state: DownloadState = {
    entityValidator: null,
    sawFirstSuccessfulResponse: false,
  };
  let lastError: unknown = null;
  let stalledAttempts = 0;
  let attempt = 1;
  const urls = [opts.url, ...(opts.mirrorUrls ?? [])];
  let origin = 0;
  let originStalls = 0;
  let retriedIntegrity = false;
  const hardFailed = new Set<number>();
  // The most bytes on disk since the last restart. Progress is judged
  // against this high-water mark rather than against the attempt's own
  // starting offset, so re-reading ground the download has already covered
  // is correctly not progress: without that, an origin whose entity is
  // shorter than the manifest declares oscillates forever - transfer the
  // short body (looks like progress), Range past the end, 416, restart,
  // transfer it again - resetting the stall counter every other attempt and
  // running the full runaway guard on ~100 complete re-transfers.
  //
  // It is reset by a restart, and must be: a restart deletes the partial, so
  // the mark would otherwise describe bytes that no longer exist and every
  // subsequent attempt would be measured against a total it cannot reach.
  // A 700MB resume that meets one Range-ignoring proxy would then give up
  // inside six attempts while genuinely transferring on every one of them.
  // `MAX_DOWNLOAD_RESTARTS` is what bounds the oscillation instead.
  let bytesHighWaterMark = await partialSize(opts.destPath);
  let restarts = 0;
  for (; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    // No pre-flight restart: a partial file left by a PREVIOUS process is
    // exactly what we want to resume, and this process has no validator for
    // it yet. `downloadAttempt` puts the offset on the wire as a Range and
    // handles every answer the server can give (206 resume, 416 already
    // complete, 200 range-ignored -> restart), which is what makes the
    // validator-less resume safe.
    const offset = await partialSize(opts.destPath);
    emitHeartbeat(opts.onHeartbeat, "attempt", attempt, null);
    // Publish the starting point BEFORE the request goes out. A resumed
    // process otherwise reports nothing until the first byte of the new
    // attempt lands, so Desktop - whose carry-forward has no prior value in
    // a fresh process - renders no progress bar at all while a 400MB partial
    // sits on disk. On a stalling link that silence lasts a watchdog period
    // per attempt, which is exactly the "it starts over every time" the
    // resume work is meant to disprove. Emitted on every attempt, not just
    // resumes, so a `restartFromZero` reports its rewind immediately instead
    // of holding a stale percentage until the next chunk arrives.
    opts.onProgress({
      downloadedBytes: offset,
      totalBytes: opts.expectedSizeBytes,
    });
    let restarted = false;
    let switchOrigin = false;
    const attemptOpts = { ...opts, url: urls[origin] ?? opts.url };
    try {
      const result = await downloadAttempt({
        opts: attemptOpts,
        state,
        offset,
        attempt,
      });
      if (result.kind === "complete") {
        const verification = await verifyDownloadedFile(attemptOpts);
        if (verification.kind === "verified") return verification.result;
        await discardPartial(opts.destPath);
        state.entityValidator = null;
        state.sawFirstSuccessfulResponse = false;
        bytesHighWaterMark = 0;
        if (urls.length === 1) {
          if (retriedIntegrity) throw verification.error;
          retriedIntegrity = true;
        } else {
          hardFailed.add(origin);
          if (hardFailed.size >= urls.length) throw verification.error;
          switchOrigin = true;
        }
        lastError = verification.error;
      } else {
        restarted = true;
        lastError = new Error(result.reason);
      }
    } catch (err) {
      const shutdownCode = httpClientShutdownCode(err);
      if (shutdownCode !== null) {
        throw httpClientShutdownError(opts.url, shutdownCode);
      }
      // Preserve partial bytes on transport and authentication failures.
      if (opts.signal?.aborted === true)
        throw networkError(attemptOpts.url, err);
      if (
        isCliError(err) ||
        (err instanceof HttpStatusError && !err.retryable)
      ) {
        hardFailed.add(origin);
        if (hardFailed.size >= urls.length)
          throw isCliError(err) ? err : networkError(attemptOpts.url, err);
        switchOrigin = true;
      }
      lastError = err;
    }
    if (restarted) {
      restarts += 1;
      if (restarts > MAX_DOWNLOAD_RESTARTS) break;
      // The partial is gone, so the mark it described is meaningless now.
      bytesHighWaterMark = 0;
    }
    // Forward progress buys another round: only an attempt that pushed the
    // partial file past its high-water mark counts as progress.
    const landedBytes = await partialSize(opts.destPath);
    if (landedBytes > bytesHighWaterMark) {
      bytesHighWaterMark = landedBytes;
      stalledAttempts = 0;
      originStalls = 0;
    } else {
      stalledAttempts += 1;
      originStalls += 1;
    }
    if ((switchOrigin || originStalls >= 2) && urls.length > 1) {
      for (let next = 1; next <= urls.length; next += 1) {
        const candidate = (origin + next) % urls.length;
        if (!hardFailed.has(candidate)) {
          origin = candidate;
          break;
        }
      }
      // Validators describe an origin's HTTP entity, not the signed bytes.
      state.entityValidator = null;
      state.sawFirstSuccessfulResponse = false;
      originStalls = 0;
    }
    if (stalledAttempts >= MAX_DOWNLOAD_STALL_ATTEMPTS) break;
    emitHeartbeat(opts.onHeartbeat, "backoff", attempt, null);
    await waitForRetry(downloadRetryBackoffMs(stalledAttempts));
  }
  // The partial file deliberately SURVIVES an exhausted budget: the next
  // invocation resumes it from `destPath` (registry/download-cache.ts keeps
  // that path stable across processes). Only positively-bad bytes get
  // discarded - a size-cap abort above, or the sha256 mismatch in
  // `downloadToFile`.
  throw exhaustedNetworkError(
    opts.url,
    lastError,
    Math.min(attempt, MAX_DOWNLOAD_ATTEMPTS),
  );
}

function downloadRetryBackoffMs(stalledAttempts: number): number {
  // Zero stalls (the attempt transferred bytes) and the first stall both
  // pay only the base delay; the exponent starts climbing from the second
  // consecutive stall.
  const exponential =
    NETWORK_RETRY_BACKOFF_MS * 2 ** Math.max(0, stalledAttempts - 1);
  return Math.min(exponential, DOWNLOAD_RETRY_BACKOFF_CAP_MS);
}

interface DownloadAttemptOptions {
  readonly opts: DownloadToFileOptions;
  readonly state: DownloadState;
  readonly offset: number;
  readonly attempt: number;
}

async function downloadAttempt(
  options: DownloadAttemptOptions,
): Promise<DownloadAttemptResult> {
  const { opts, state, offset, attempt } = options;
  // Set only by the size-cap abort below. The bytes on disk are the ones a
  // run-on stream already over-wrote, so THIS attempt owns discarding them -
  // see the catch at the end of the write loop.
  let oversize = false;
  const controller = new AbortController();
  const linkedSignal = linkAbortSignals(controller, opts.signal);
  const resuming = offset > 0;
  const headers = new Headers();
  if (resuming) {
    headers.set("Range", `bytes=${offset}-`);
    // `If-Range` only when this process has seen the entity itself. Without
    // it the server may answer a Range against a DIFFERENT entity than the
    // partial bytes came from - so the 206 branch below refuses any
    // Content-Range whose total is not the manifest's declared size, and
    // the sha256 check in `downloadToFile` is the final backstop for a
    // replacement entity of identical length.
    if (state.entityValidator !== null) {
      headers.set("If-Range", state.entityValidator);
    }
  }
  const watchdog = createWatchdog({
    controller,
    timeoutMs: DOWNLOAD_WATCHDOG_MS,
    onTimeout: () => emitHeartbeat(opts.onHeartbeat, "watchdog", attempt, null),
  });
  try {
    const response = await registryFetch(opts.url, {
      signal: linkedSignal,
      headers,
    });
    if (!state.sawFirstSuccessfulResponse && response.ok) {
      state.sawFirstSuccessfulResponse = true;
      state.entityValidator = entityValidatorFrom(response);
    }
    if (resuming) {
      if (response.status === 416) {
        await cancelResponseBody(response);
        if ((await partialSize(opts.destPath)) === opts.expectedSizeBytes) {
          return { kind: "complete" };
        }
        await restartFromZero(opts.destPath, state);
        return {
          kind: "restart",
          reason: `host registry: range request for ${opts.url} was not satisfiable before the expected size was reached`,
        };
      }
      if (response.status === 200) {
        await cancelResponseBody(response);
        await restartFromZero(opts.destPath, state);
        return {
          kind: "restart",
          reason: `host registry: ${opts.url} ignored the resume range request`,
        };
      }
      if (response.status !== 206) {
        throw await httpStatusFailure(opts.url, response);
      }
      const contentRange = parseContentRange(
        response.headers.get("content-range"),
      );
      if (
        contentRange === null ||
        contentRange.start !== offset ||
        contentRange.total !== opts.expectedSizeBytes
      ) {
        await cancelResponseBody(response);
        await restartFromZero(opts.destPath, state);
        return {
          kind: "restart",
          reason: `host registry: ${opts.url} returned a mismatched Content-Range for offset ${offset}`,
        };
      }
    } else if (!response.ok) {
      throw await httpStatusFailure(opts.url, response);
    }
    if (response.body === null) {
      throw new Error(`host registry: GET ${opts.url} returned no body`);
    }
    const writer = createWriteStream(opts.destPath, {
      flags: offset > 0 ? "a" : "w",
    });
    let downloadedBytes = offset;
    try {
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (chunk === undefined) continue;
        watchdog.reset();
        downloadedBytes += chunk.byteLength;
        if (
          downloadedBytes >
          opts.expectedSizeBytes + DOWNLOAD_SIZE_SLACK_BYTES
        ) {
          controller.abort();
          oversize = true;
          throw cliError({
            code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
            message: `host registry: ${opts.url} exceeded declared size ${opts.expectedSizeBytes} bytes (received ${downloadedBytes}); aborted to protect local disk`,
            details: {
              url: opts.url,
              expectedSizeBytes: opts.expectedSizeBytes,
              receivedBytes: downloadedBytes,
              sizeCapBytes: opts.expectedSizeBytes + DOWNLOAD_SIZE_SLACK_BYTES,
            },
            exitCode: 1,
          });
        }
        if (!writer.write(chunk)) {
          await waitForWriterDrain(writer, opts.url);
        }
        opts.onProgress({
          downloadedBytes,
          totalBytes: opts.expectedSizeBytes,
        });
      }
      await finishWriter(writer);
      if (downloadedBytes < opts.expectedSizeBytes) {
        // The body ended early. Most runtimes raise a stream error for a
        // truncated response, but not all of them do for every truncation
        // shape - bun's fetch reports some mid-body connection drops as a
        // clean end-of-stream, and a response without a usable length can
        // end short on any runtime. Treating "the reader said done" as
        // proof of a finished transfer is what turned a resumable network
        // failure into a terminal `HOST_VERIFY_FAILED` on the size check,
        // burning the partial with it (traycer#585's "downloaded 231 MB of
        // 721 MB before failure").
        //
        // Failing here instead keeps this a plain transfer error: the bytes
        // that did land stay on disk and the next attempt resumes from
        // them.
        throw new Error(
          `host registry: ${opts.url} ended after ${downloadedBytes} of ${opts.expectedSizeBytes} bytes`,
        );
      }
      return { kind: "complete" };
    } catch (err) {
      controller.abort();
      await closeWriter(writer);
      // AFTER `closeWriter`, never before: deleting while the writer still has
      // a pending flush races it (EBUSY on Windows, or a file recreated by the
      // flush that lands after the unlink).
      if (oversize) {
        // BEST EFFORT, and it must not replace `err`. `rm(..., { force: true })`
        // suppresses ENOENT but not EPERM or EBUSY, and this branch already
        // treats Windows file locking as a real condition: an antivirus
        // scanner or indexer can hold the just-closed file.
        //
        // A rejection escaping here would replace the size-cap CliError, with
        // two consequences. The caller loses the diagnosis and sees a
        // filesystem error instead; and `isCliError(err)` becomes false, so
        // `downloadWithRetries` reclassifies a PERMANENT refusal as transient
        // and re-downloads an origin that streams past its declared size until
        // the stall budget is exhausted.
        //
        // Leaving a partial file behind is strictly the better failure: the
        // next attempt truncates it.
        try {
          await discardPartial(opts.destPath);
        } catch {
          // Intentionally ignored; `err` below is the verdict that matters.
        }
      }
      throw err;
    }
  } finally {
    controller.abort();
    watchdog.clear();
  }
}

async function verifyDownloadedFile(
  opts: DownloadToFileOptions,
): Promise<DownloadVerification> {
  const downloadedStat = await stat(opts.destPath);
  if (downloadedStat.size !== opts.expectedSizeBytes) {
    return {
      kind: "mismatch",
      error: cliError({
        code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
        message: `host registry: ${opts.url} downloaded ${downloadedStat.size} bytes but manifest declared ${opts.expectedSizeBytes}`,
        details: {
          url: opts.url,
          expectedSizeBytes: opts.expectedSizeBytes,
          actualSizeBytes: downloadedStat.size,
        },
        exitCode: 1,
      }),
    };
  }
  const sha256 = await hashFileSha256(opts.destPath, null);
  if (sha256 !== opts.expectedSha256) {
    return {
      kind: "mismatch",
      error: cliError({
        code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
        message: `host registry: ${opts.url} sha256=${sha256} but manifest declared ${opts.expectedSha256}`,
        details: {
          url: opts.url,
          expectedSha256: opts.expectedSha256,
          actualSha256: sha256,
        },
        exitCode: 1,
      }),
    };
  }
  return {
    kind: "verified",
    result: { downloadedBytes: downloadedStat.size, sha256 },
  };
}

function emitHeartbeat(
  listener: NetworkHeartbeatListener | null,
  phase: NetworkHeartbeat["phase"],
  attempt: number,
  maxAttempts: number | null,
): void {
  if (listener === null) return;
  listener({ phase, attempt, maxAttempts });
}

function createWatchdog(opts: {
  readonly controller: AbortController;
  readonly timeoutMs: number;
  readonly onTimeout: () => void;
}): { readonly clear: () => void; readonly reset: () => void } {
  let timer: NodeJS.Timeout | null = null;
  const reset = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      opts.onTimeout();
      opts.controller.abort();
    }, opts.timeoutMs);
  };
  reset();
  return {
    clear: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    reset,
  };
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Build the error for a non-2xx registry response, releasing its body first.
 *
 * The cancel is not tidiness. An un-consumed, un-cancelled body leaves the
 * undici request RUNNING, and the CLI's exit path calls `Agent.close()`, which
 * waits for running requests and has no timeout of its own. A CDN that answers
 * `503` with a partial body and then goes quiet would therefore park the whole
 * process in teardown - the command has already produced its terminal error
 * envelope, so it would look like a hang after a completed run (int#4840).
 *
 * Async for that reason alone; call it as `throw await httpStatusFailure(...)`.
 */
async function httpStatusFailure(
  url: string,
  response: Response,
): Promise<Error> {
  await cancelResponseBody(response);
  return new HttpStatusError(url, response.status, response.statusText);
}

class HttpStatusError extends Error {
  readonly retryable: boolean;
  constructor(url: string, status: number, statusText: string) {
    super(`host registry: GET ${url} returned ${status} ${statusText}`);
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

function exhaustedNetworkError(
  url: string,
  lastError: unknown,
  attempts: number,
): Error {
  return cliError({
    code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
    message: `host registry: GET ${url} failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    details: {
      url,
      attempts,
      lastError:
        lastError instanceof Error ? lastError.message : String(lastError),
    },
    exitCode: 1,
  });
}

function isCliError(err: unknown): err is Error {
  return err instanceof Error && err.name === "CliError";
}

// undici retires a dispatcher by making it REFUSE work, not by making it
// disappear: once `Agent.close()` or `.destroy()` has been called, every
// subsequent dispatch rejects with `ClientClosedError` / `ClientDestroyedError`
// for the life of the process. The CLI has exactly one global dispatcher, and
// its normal exit path closes it. The process-fatal path no longer does (it
// leaves the interrupted command alive by design and the dispatcher open for
// it; see runner/exit.ts), so a request meets these only when some other exit
// closed the client first - the non-runner paths, or a fatal that fired after
// the command settled - and the classification stays for exactly those.
//
// `fetch` does not surface them directly. It reports its own opaque
// `TypeError: fetch failed` and hangs the real error off `cause`, so the code
// is the only reliable identifier and it lives one level down. Walked, rather
// than read at a fixed depth, because a proxying dispatcher can add a link -
// and bounded, because nothing stops a `cause` chain from being cyclic.
const HTTP_CLIENT_SHUTDOWN_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
]);
const MAX_CAUSE_DEPTH = 4;

function httpClientShutdownCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return null;
    if (
      "code" in current &&
      typeof current.code === "string" &&
      HTTP_CLIENT_SHUTDOWN_CODES.has(current.code)
    ) {
      return current.code;
    }
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

/**
 * Fail a registry request that the CLI's own HTTP client refused to carry.
 *
 * Deliberately NOT `REGISTRY_UNAVAILABLE`, and deliberately not retried. The
 * retry budget exists for a peer that might answer differently in 750ms; a
 * closed dispatcher will not, ever, so retrying only spends four attempts to
 * arrive at a verdict about a registry that was never asked. That verdict was
 * the visible failure: a Mac install died of an unrelated uncaught exception,
 * the exit path closed the dispatcher out from under the download that was
 * still running, and what the user was told - what the support report led with
 * - was that the release registry was unreachable. It was not.
 *
 * The message is fixed text plus the URL and the closed-set undici code, so
 * nothing an origin controls reaches the terminal through it.
 */
function httpClientShutdownError(url: string, shutdownCode: string): Error {
  return cliError({
    code: CLI_ERROR_CODES.UNEXPECTED,
    message: `host registry: GET ${url} was abandoned because this CLI's HTTP client was shut down mid-request (${shutdownCode}) - the registry was not asked and is not implicated`,
    details: { url, shutdownCode },
    exitCode: 1,
  });
}

async function partialSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if (isNotFoundError(err)) return 0;
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  return err.code === "ENOENT";
}

async function discardPartial(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function restartFromZero(
  path: string,
  state: DownloadState,
): Promise<void> {
  await discardPartial(path);
  // A fresh start must not carry a validator from an entity whose partial
  // bytes have just been discarded. The next successful response captures a
  // new validator before any later Range request is constructed.
  state.entityValidator = null;
  state.sawFirstSuccessfulResponse = false;
}

function entityValidatorFrom(response: Response): string | null {
  const etag = response.headers.get("etag");
  if (etag !== null && !etag.trimStart().startsWith("W/")) return etag;
  return response.headers.get("last-modified");
}

function parseContentRange(
  value: string | null,
): { readonly start: number; readonly total: number } | null {
  if (value === null) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (!Number.isSafeInteger(total) || start > end || end >= total) return null;
  return { start, total };
}

/**
 * The CLI's own copy of the shared helper of the same name, and it has to keep
 * that helper's non-throwing contract or the name lies.
 *
 * Every caller here is already carrying a verdict: `httpStatusFailure` cancels
 * BEFORE constructing the error it returns, so a rejecting cancel meant
 * `throw await httpStatusFailure(...)` threw a stream error and the
 * "GET <url> returned 404 Not Found" diagnosis was never built; the three
 * resume-path callers would have lost their `{ kind: "restart" }` the same way,
 * turning a recoverable resume into a hard failure. `cancel()` rejects when the
 * connection has already errored - exactly when these paths run - so the leak
 * this prevents is bounded either way: a body that cannot be cancelled belongs
 * to a connection that is already gone.
 */
async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Best effort; the caller's verdict is the one that matters.
  }
}

async function finishWriter(writer: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      writer.off("close", onClose);
      writer.off("error", onError);
    };
    writer.once("close", onClose);
    writer.once("error", onError);
    writer.end();
  });
}

async function closeWriter(writer: WriteStream): Promise<void> {
  if (writer.closed) return;
  await new Promise<void>((resolve) => {
    const onClose = (): void => {
      writer.off("error", onError);
      resolve();
    };
    const onError = (): void => {
      // A writer-side failure cannot be flushed. Destroy it only in that
      // case; normal retryable network failures must use end() so bytes that
      // write() already accepted are visible to the next attempt's stat.
      writer.destroy();
    };
    writer.once("close", onClose);
    writer.once("error", onError);
    writer.end();
  });
}

async function downloadFileScheme(
  opts: DownloadToFileOptions,
): Promise<DownloadToFileResult> {
  const sourcePath = fileUrlToPath(opts.url);
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch (err) {
    throw networkError(opts.url, err);
  }
  if (sourceStat.size !== opts.expectedSizeBytes) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `host registry: ${opts.url} is ${sourceStat.size} bytes but manifest declared ${opts.expectedSizeBytes}`,
      details: {
        url: opts.url,
        expectedSizeBytes: opts.expectedSizeBytes,
        actualSizeBytes: sourceStat.size,
      },
      exitCode: 1,
    });
  }
  let downloadedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const reader = createReadStream(sourcePath);
    const writer = createWriteStream(opts.destPath);
    reader.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      opts.onProgress({
        downloadedBytes,
        totalBytes: opts.expectedSizeBytes,
      });
    });
    reader.on("error", (err) => {
      writer.destroy();
      reject(err);
    });
    writer.on("error", (err) => {
      reader.destroy();
      reject(err);
    });
    writer.on("close", () => resolve());
    reader.pipe(writer);
  });
  const sha256 = await hashFileSha256(opts.destPath, null);
  if (sha256 !== opts.expectedSha256) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `host registry: ${opts.url} sha256=${sha256} but manifest declared ${opts.expectedSha256}`,
      details: {
        url: opts.url,
        expectedSha256: opts.expectedSha256,
        actualSha256: sha256,
      },
      exitCode: 1,
    });
  }
  return { downloadedBytes, sha256 };
}

export function waitForWriterDrain(
  writer: DrainableWriter,
  url: string,
): Promise<void> {
  if (writer.destroyed || writer.writableEnded) {
    return Promise.reject(writerClosedBeforeDrainError(url));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      writer.off("drain", onDrain);
      writer.off("error", onError);
      writer.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(writerClosedBeforeDrainError(url));
    };
    writer.once("drain", onDrain);
    writer.once("error", onError);
    writer.once("close", onClose);
  });
}

function writerClosedBeforeDrainError(url: string): Error {
  return new Error(
    `host registry: file writer closed before drain while downloading ${url}`,
  );
}

function isFileUrl(url: string): boolean {
  return url.startsWith("file://");
}

function fileUrlToPath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch (err) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `host registry: '${url}' is not a parseable file:// URL: ${err instanceof Error ? err.message : String(err)}`,
      details: { url },
      exitCode: 1,
    });
  }
}

function networkError(url: string, cause: unknown): Error {
  return cliError({
    code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
    message: `host registry: GET ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    details: {
      url,
      error: cause instanceof Error ? cause.message : String(cause),
    },
    exitCode: 1,
  });
}

function oversizeError(url: string, received: number, cap: number): Error {
  return cliError({
    code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
    message: `host registry: GET ${url} exceeded ${cap}-byte cap (received >= ${received}); aborted to protect local disk`,
    details: { url, receivedBytes: received, capBytes: cap },
    exitCode: 1,
  });
}

// Wire a caller-provided AbortSignal so triggering it also aborts the
// internal controller (which is what cancels in-flight reads). Returns
// the controller's own signal - that's what we pass into `fetch`.
function linkAbortSignals(
  internal: AbortController,
  external: AbortSignal | null,
): AbortSignal {
  return external === null
    ? internal.signal
    : AbortSignal.any([internal.signal, external]);
}
