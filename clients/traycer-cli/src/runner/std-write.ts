// Every stdout/stderr byte goes through here so `process.exit` cannot drop a PIPE write. File redirects are synchronous and hide the bug.

import { writeSync } from "node:fs";

const FLUSH_TIMEOUT_MS = 10_000;

/** Bound for the EAGAIN retry in `writeStdoutSync`. A non-blocking pipe can refuse a write; the bound keeps a wedged reader from hanging a supervisor start rather than letting it spin forever. */
const MAX_SYNC_WRITE_RETRIES = 1_000;

/** SYNCHRONOUS stdout, for the one caller whose exit cannot await a flush. Everything else in this module queues and relies on `flushStdio()` before exit. */
export function writeStdoutSync(chunk: Buffer): void {
  let written = 0;
  let attempts = 0;
  while (written < chunk.length && attempts < MAX_SYNC_WRITE_RETRIES) {
    try {
      written += writeSync(1, chunk, written, chunk.length - written);
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as { readonly code: unknown }).code
          : null;
      // Anything but a "try again" is unrecoverable here - a closed or broken
      // pipe has no reader left to serve.
      if (code !== "EAGAIN") return;
      attempts += 1;
    }
  }
}

// Tail of the write-completion chain per descriptor.
// Replaced on every write, so resolved links are collectable and a long-running `host logs --follow` does not accumulate them.
let stdoutTail: Promise<void> = Promise.resolve();
let stderrTail: Promise<void> = Promise.resolve();

function tracked(
  stream: NodeJS.WriteStream,
  chunk: string | Buffer,
  tail: Promise<void>,
): Promise<void> {
  const written = new Promise<void>((resolve) => {
    // The callback fires once the chunk has been handed off, INCLUDING on error (e.g.
    // EPIPE when the reader closed), so this always settles and a failed write cannot wedge the flush.
    stream.write(chunk, () => resolve());
  });
  return tail.then(() => written);
}

/** Like `tracked`, but additionally reports whether THIS specific write's own completion callback fired with no error - `outcome` resolves `false` on a write error (e.g. EPIPE), never rejects. */
function trackedWithOutcome(
  stream: NodeJS.WriteStream,
  chunk: string | Buffer,
  tail: Promise<void>,
): { readonly settled: Promise<void>; readonly outcome: Promise<boolean> } {
  const outcome = new Promise<boolean>((resolve) => {
    stream.write(chunk, (error) =>
      resolve(error === undefined || error === null),
    );
  });
  const settled = tail.then(() => outcome.then(() => undefined));
  return { settled, outcome };
}

export function writeStdout(text: string): void {
  stdoutTail = tracked(process.stdout, text, stdoutTail);
}

// Raw byte passthrough for callers already holding a Buffer (`host logs --follow` streams file chunks verbatim).
// Kept separate from `writeStdout` so those bytes are never round-tripped through a string.
export function writeStdoutBytes(chunk: Buffer): void {
  stdoutTail = tracked(process.stdout, chunk, stdoutTail);
}

export function writeStderr(text: string): void {
  stderrTail = tracked(process.stderr, text, stderrTail);
}

/** Writes to stdout and exposes both a bounded confirmation and THIS write's eventual callback outcome. The bounded result is `false` on a write error or when the callback has not arrived in time; the eventual result lets a durable caller distinguish a late success from a permanent stall. */
export function writeStdoutForAck(text: string): {
  readonly confirmation: Promise<boolean>;
  readonly eventualOutcome: Promise<boolean>;
} {
  const { settled, outcome } = trackedWithOutcome(
    process.stdout,
    text,
    stdoutTail,
  );
  stdoutTail = settled;
  return {
    confirmation: boundedOutcome(outcome),
    eventualOutcome: outcome,
  };
}

function boundedOutcome(outcome: Promise<boolean>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
    void outcome.then((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

/** Await every write issued through this module. MUST be awaited before any `process.exit()` that follows CLI output - see the module comment for what gets lost otherwise. */
export async function flushStdio(): Promise<void> {
  await Promise.all([bounded(stdoutTail), bounded(stderrTail)]);
}

function bounded(tail: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
    void tail.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
