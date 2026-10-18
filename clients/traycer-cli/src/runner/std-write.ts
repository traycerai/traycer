// Every byte this CLI writes to stdout/stderr goes through here, so that
// `flushStdio()` can guarantee it actually reached the OS before the process
// exits.
//
// Why this exists: `process.stdout.write` is ASYNCHRONOUS whenever stdout is
// a pipe, which is every Desktop invocation (`execFile` / `spawn` in
// desktop/src/electron-main/cli/traycer-cli.ts). The runner and the script
// entrypoint both `process.exit()` immediately after emitting their terminal
// NDJSON line, and `process.exit` tears the process down WITHOUT draining the
// stream buffer. Only what the kernel pipe buffer accepted synchronously
// (65,536 bytes on macOS and Linux) was ever delivered - the remainder was
// discarded and the process still exited 0. Desktop then read a truncated,
// unparseable JSON line and reported "traycer-cli emitted no terminal result
// line for: <args>", with no coded envelope to diagnose from.
//
// This is a payload-size cliff, not a code regression: `host available --json
// --include-pre-releases` emits its whole listing on ONE line, and that line
// crossed 64 KiB when host 1.1.8 was published (2026-07-25), breaking the
// Settings -> Host "Include release candidates" row with no change on either
// side. Stable-only is at ~22 KiB and grows ~2.4 KiB per release, so the
// same cliff is ahead for the default listing too.
//
// Two "obvious" flushes that DO NOT work - both measured against bun, the
// runtime of this CLI's tree and dev paths, writing 70,000 bytes to a pipe.
// (The released binary is a Node SEA built by `build:sea`.) Both delivered
// exactly 65,536:
//
//   - `process.stdout.write("", cb)` as a flush sentinel after the real
//     write: bun fires that callback immediately rather than behind the
//     preceding write, so the process still exits mid-flush.
//   - awaiting `"drain"` / testing `writableLength`: `drain` only fires after
//     a write returns false, and bun reports `writableLength === 0` with
//     bytes still outstanding.
//
// What does work, and what this module relies on, is the per-write completion
// callback (`stream.write(chunk, cb)`) - verified end-to-end on both bun and
// node at 500 KB. Because a sentinel write cannot be trusted to queue behind
// earlier ones, each write's own callback is captured and chained, and
// `flushStdio()` awaits the accumulated tail rather than probing the stream.
//
// Queued writes go through `process.stdout` / `process.stderr` rather than a
// raw `fs.writeSync(1, ...)`: that keeps the stream the rest of the codebase
// (and its tests) observes as the single output seam. The one exception is
// `writeStdoutSync` below, for the supervisor whose exit cannot await a
// flush - it still lives here so the seam stays one module.

import { writeSync } from "node:fs";

const FLUSH_TIMEOUT_MS = 10_000;

/**
 * Bound for the EAGAIN retry in `writeStdoutSync`. A non-blocking pipe can
 * refuse a write; the bound keeps a wedged reader from hanging a supervisor
 * start rather than letting it spin forever.
 */
const MAX_SYNC_WRITE_RETRIES = 1_000;

/**
 * SYNCHRONOUS stdout, for the one caller whose exit cannot await a flush.
 *
 * Everything else in this module queues and relies on `flushStdio()` before
 * exit. `traycer host start` cannot: its exit is a bare `process.exit` by
 * design (see runner/exit.ts on why the supervisor does not route through the
 * terminator), so anything still queued is simply lost. Its fast paths - the
 * incumbent-declined and invalid-probe branches - exit within milliseconds of
 * writing the banner or the `--json` lifecycle event, which is exactly the
 * output an operator or an automation consumer is waiting on.
 *
 * Deliberately lives here rather than in the caller: this module's whole
 * premise is that every byte this CLI writes to stdout goes through one seam.
 */
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

// Tail of the write-completion chain per descriptor. Replaced on every write,
// so resolved links are collectable and a long-running `host logs --follow`
// does not accumulate them.
let stdoutTail: Promise<void> = Promise.resolve();
let stderrTail: Promise<void> = Promise.resolve();

// Streams that already carry the `error` listener below. A WeakSet so a
// stream a test swaps out is not kept alive by this module.
const guardedStreams = new WeakSet<NodeJS.WriteStream>();

// Aborted, once, the first time a write to `process.stdout` fails with EPIPE.
// One controller for the process: a reader that went away does not come back.
const stdoutReaderClosedController = new AbortController();

/**
 * Aborts once stdout's reader has closed the pipe (`traycer host logs
 * --follow | head -20`, an agent harness that stopped reading `traycer
 * monitor`).
 *
 * The guard below keeps that EPIPE from crashing the process, which also
 * removes the only thing that used to END a command that streams until
 * interrupted: before the guard, the unhandled error reached the fatal
 * handler. A streaming command passes this signal into the cleanup path its
 * own interrupt takes and exits 0. A one-shot command ignores it and
 * finishes with its own code - a process-wide exit here would cut `host
 * update` mid-swap over a reader that merely stopped listening.
 */
export function stdoutReaderClosed(): AbortSignal {
  return stdoutReaderClosedController.signal;
}

function noteWriteError(
  stream: NodeJS.WriteStream,
  error: Error | null | undefined,
): void {
  if (stream !== process.stdout) return;
  if (error === null || error === undefined) return;
  if (!("code" in error) || error.code !== "EPIPE") return;
  if (stdoutReaderClosedController.signal.aborted) return;
  stdoutReaderClosedController.abort();
}

/**
 * Keeps a reader that has gone away from killing the CLI.
 *
 * The write callbacks below settle on EPIPE, but the stream ALSO emits
 * `error`, and an `error` event with no listener is thrown as an uncaught
 * exception: `traycer ... | head -1`, or a desktop that stopped reading the
 * child, crashed the CLI with exit 1 and a fatal Sentry event
 * (TRAYCER-CLI-25) over a closed pipe that is not a CLI fault. Only EPIPE is
 * absorbed - a listener's presence would otherwise swallow every other stream
 * error too, so anything else is rethrown to reach the uncaught-exception
 * path exactly as it did before the listener existed. "Exactly as before"
 * includes another listener owning the error: a relocated host-stopping
 * command installs its own `error` handler on these streams to outlive the
 * closed PTY (`acknowledgeRelocationEntry`), and EventEmitter calls every
 * listener, so this one only rethrows when it is the sole listener left.
 * The guard is PREPENDED so it runs first: Node removes a `once` listener
 * before invoking it, so a guard that ran after one would see the count
 * already dropped and rethrow an error that was handled. Running first, every
 * other listener, `once` included, is still counted.
 */
function ignoreClosedReader(stream: NodeJS.WriteStream): void {
  if (guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  stream.prependListener("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      noteWriteError(stream, error);
      return;
    }
    // Another listener has taken responsibility for the error; the stream
    // would not have been unhandled without this one, so do not make it so.
    if (stream.listenerCount("error") > 1) return;
    throw error;
  });
}

/**
 * Installs the closed-reader guard on stdout and stderr. Called once at
 * process entry (`index.ts`, beside the process failure handlers) before any
 * command runs, NOT on the first write through this module: several writers
 * bypass this seam - the maintenance-lease protocol frames
 * (`process.stdout.write`), worktree-delete's relayed output, every
 * `console.error` / `console.warn` - and a lazily attached guard left each of
 * them crashing on EPIPE whenever nothing had written through here first.
 * Idempotent.
 */
export function installStdioErrorGuards(): void {
  ignoreClosedReader(process.stdout);
  ignoreClosedReader(process.stderr);
}

function tracked(
  stream: NodeJS.WriteStream,
  chunk: string | Buffer,
  tail: Promise<void>,
): Promise<void> {
  const written = new Promise<void>((resolve) => {
    // The callback fires once the chunk has been handed off, INCLUDING on
    // error (e.g. EPIPE when the reader closed), so this always settles and
    // a failed write cannot wedge the flush.
    stream.write(chunk, (error) => {
      noteWriteError(stream, error);
      resolve();
    });
  });
  return tail.then(() => written);
}

/**
 * Like `tracked`, but additionally reports whether THIS specific write's own
 * completion callback fired with no error - `outcome` resolves `false` on a
 * write error (e.g. EPIPE), never rejects. Kept separate from `tracked`
 * (used by the plain fire-and-forget writers below) because most callers
 * never need a per-write result and `flushStdio`'s bounded, always-resolving
 * shape is deliberately unsuitable for anyone who does - see
 * `writeStdoutForAck`'s doc comment.
 */
function trackedWithOutcome(
  stream: NodeJS.WriteStream,
  chunk: string | Buffer,
  tail: Promise<void>,
): { readonly settled: Promise<void>; readonly outcome: Promise<boolean> } {
  const outcome = new Promise<boolean>((resolve) => {
    stream.write(chunk, (error) => {
      noteWriteError(stream, error);
      resolve(error === undefined || error === null);
    });
  });
  const settled = tail.then(() => outcome.then(() => undefined));
  return { settled, outcome };
}

export function writeStdout(text: string): void {
  stdoutTail = tracked(process.stdout, text, stdoutTail);
}

// Raw byte passthrough for callers already holding a Buffer (`host logs
// --follow` streams file chunks verbatim). Kept separate from `writeStdout`
// so those bytes are never round-tripped through a string.
export function writeStdoutBytes(chunk: Buffer): void {
  stdoutTail = tracked(process.stdout, chunk, stdoutTail);
}

export function writeStderr(text: string): void {
  stderrTail = tracked(process.stderr, text, stderrTail);
}

/**
 * Writes to stdout and exposes both a bounded confirmation and THIS write's
 * eventual callback outcome. The bounded result is `false` on a write error
 * or when the callback has not arrived in time; the eventual result lets a
 * durable caller distinguish a late success from a permanent stall. Still
 * chains into the shared `stdoutTail` so `flushStdio` ordering is unaffected.
 *
 * For callers that must know a SPECIFIC write actually reached the OS
 * before doing something durable in response - e.g. the inbox monitor
 * acknowledging a message only once its text has genuinely been printed.
 * `flushStdio()` alone cannot answer that: it is deliberately non-rejecting
 * and resolves after its own bounded timeout REGARDLESS of whether the
 * write ever completed, so "awaited flushStdio" is not the same claim as
 * "this write succeeded" - conflating the two is exactly how an ack could
 * previously fire for text that was never written.
 */
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

/**
 * Await every write issued through this module. MUST be awaited before any
 * `process.exit()` that follows CLI output - see the module comment for what
 * gets lost otherwise.
 *
 * Never rejects, and never blocks teardown indefinitely: a write whose
 * completion callback never arrives (a stubbed stream in a test, an exotic
 * descriptor) falls back to a bounded wait rather than hanging the CLI. The
 * timer is cleared on the normal path so it cannot hold the event loop open.
 */
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
