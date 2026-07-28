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
// runtime the CLI ships as (`bun --compile`), writing 70,000 bytes to a pipe.
// Both delivered exactly 65,536:
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
// Writes still go through `process.stdout` / `process.stderr` rather than a
// raw `fs.writeSync(1, ...)`: that keeps the stream the rest of the codebase
// (and its tests) observes as the single output seam.

const FLUSH_TIMEOUT_MS = 10_000;

// Tail of the write-completion chain per descriptor. Replaced on every write,
// so resolved links are collectable and a long-running `host logs --follow`
// does not accumulate them.
let stdoutTail: Promise<void> = Promise.resolve();
let stderrTail: Promise<void> = Promise.resolve();

function tracked(
  stream: NodeJS.WriteStream,
  chunk: string | Buffer,
  tail: Promise<void>,
): Promise<void> {
  const written = new Promise<void>((resolve) => {
    // The callback fires once the chunk has been handed off, INCLUDING on
    // error (e.g. EPIPE when the reader closed), so this always settles and
    // a failed write cannot wedge the flush.
    stream.write(chunk, () => resolve());
  });
  return tail.then(() => written);
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
