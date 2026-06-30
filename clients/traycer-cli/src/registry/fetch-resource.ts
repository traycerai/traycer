import { readFile, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { hashFileSha256 } from "../installer/sha256";

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
  // AbortSignal for caller-side cancellation. Not used yet but reserved
  // so callers don't have to refactor when host-install grows a
  // `--timeout` flag.
  readonly signal: AbortSignal | null;
}

export async function fetchText(
  url: string,
  opts: FetchOptions,
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
  let response: Response;
  try {
    response = await fetch(url, { signal: linkedSignal });
  } catch (err) {
    throw networkError(url, err);
  }
  if (!response.ok) {
    controller.abort();
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `host registry: GET ${url} returned ${response.status} ${response.statusText}`,
      details: { url, status: response.status },
      exitCode: 1,
    });
  }
  if (response.body === null) {
    // No streaming body - fall through to a single-shot read which is
    // already bounded by the response.text() path. Apply the size check
    // after reading.
    const body = await response.text();
    if (body.length > FETCH_TEXT_MAX_BYTES) {
      throw oversizeError(url, body.length, FETCH_TEXT_MAX_BYTES);
    }
    return body;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (chunk === undefined) continue;
      received += chunk.byteLength;
      if (received > FETCH_TEXT_MAX_BYTES) {
        controller.abort();
        throw oversizeError(url, received, FETCH_TEXT_MAX_BYTES);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    controller.abort();
    if (err instanceof Error && err.name === "CliError") throw err;
    throw networkError(url, err);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface DownloadToFileOptions extends FetchOptions {
  readonly url: string;
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
  const controller = new AbortController();
  const linkedSignal = linkAbortSignals(controller, opts.signal);
  let response: Response;
  try {
    response = await fetch(opts.url, { signal: linkedSignal });
  } catch (err) {
    throw networkError(opts.url, err);
  }
  if (!response.ok) {
    controller.abort();
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `host registry: GET ${opts.url} returned ${response.status} ${response.statusText}`,
      details: { url: opts.url, status: response.status },
      exitCode: 1,
    });
  }
  if (response.body === null) {
    controller.abort();
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `host registry: GET ${opts.url} returned no body`,
      details: { url: opts.url },
      exitCode: 1,
    });
  }
  const totalBytes = opts.expectedSizeBytes;
  const sizeCap = opts.expectedSizeBytes + DOWNLOAD_SIZE_SLACK_BYTES;
  let downloadedBytes = 0;
  const writer = createWriteStream(opts.destPath);
  try {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (chunk === undefined) continue;
      downloadedBytes += chunk.byteLength;
      if (downloadedBytes > sizeCap) {
        controller.abort();
        throw cliError({
          code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
          message: `host registry: ${opts.url} exceeded declared size ${opts.expectedSizeBytes} bytes (received ${downloadedBytes}); aborted to protect local disk`,
          details: {
            url: opts.url,
            expectedSizeBytes: opts.expectedSizeBytes,
            receivedBytes: downloadedBytes,
            sizeCapBytes: sizeCap,
          },
          exitCode: 1,
        });
      }
      if (!writer.write(chunk)) {
        await waitForWriterDrain(writer, opts.url);
      }
      opts.onProgress({ downloadedBytes, totalBytes });
    }
    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.once("error", (err) => reject(err));
    });
  } catch (err) {
    writer.destroy();
    controller.abort();
    // Scrub the partial file before re-throwing so it can never be
    // confused with a complete download by a later code path (and so
    // the caller's `finally` doesn't have to race the OS to close the
    // fd before unlinking).
    await rm(opts.destPath, { force: true }).catch(() => undefined);
    if (err instanceof Error && err.name === "CliError") throw err;
    throw networkError(opts.url, err);
  }
  const downloadedStat = await stat(opts.destPath);
  if (downloadedStat.size !== opts.expectedSizeBytes) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      message: `host registry: ${opts.url} downloaded ${downloadedStat.size} bytes but manifest declared ${opts.expectedSizeBytes}`,
      details: {
        url: opts.url,
        expectedSizeBytes: opts.expectedSizeBytes,
        actualSizeBytes: downloadedStat.size,
      },
      exitCode: 1,
    });
  }
  const sha256 = await hashFileSha256(opts.destPath);
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
  const sha256 = await hashFileSha256(opts.destPath);
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
  if (external !== null) {
    if (external.aborted) {
      internal.abort();
    } else {
      external.addEventListener("abort", () => internal.abort(), {
        once: true,
      });
    }
  }
  return internal.signal;
}
