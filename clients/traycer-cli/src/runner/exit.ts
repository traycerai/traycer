import { writeSync } from "node:fs";
import * as Sentry from "@sentry/node";
import { getGlobalDispatcher } from "undici";
import { flushStdio } from "./std-write";

// How the CLI ends. Every exit path routes through `finishAndExit` instead of
// calling `process.exit()` itself.
//
// Why: on win32 the SEA aborted during exit teardown AFTER completing its work
// (int#4840; field OSS #955 and #995, both 1.1.9):
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//
// That assertion is inside `uv_async_send()` - a thread signalled an async
// handle that was already closing. libuv's POSIX `uv_async_send` carries no
// such assertion, which is why only Windows users saw it. `process.exit()` is
// what creates the window: it stops the loop while handles are mid-teardown,
// so a late signal lands on a closing handle and aborts a process whose work
// had already succeeded. The desktop then read the non-zero exit as a failed
// command.
//
// Letting the loop end on its own instead means libuv closes its handles in an
// order the assertion is designed to permit. The exit code travels via
// `process.exitCode`, so the shell contract is unchanged.
//
// MEASURED, so the obvious objection is answered up front: on Node 24 neither
// `fetch`'s default dispatcher nor an explicitly constructed undici `Agent`
// holds the loop open - a process doing a real registry fetch exits within
// ~2ms of the response landing. Draining does NOT strand the CLI behind a
// keep-alive timeout. The watchdog below exists for the case we have not
// thought of, not for the network.

// Bounded backstop for a handle that never lets go. Deliberately far below the
// desktop wrapper's 45s `CLI_JSON_TIMEOUT_MS`, so a wedged CLI still answers
// its caller rather than being killed by it.
const DRAIN_WATCHDOG_MS = 5_000;

// Same budget the previous inline `Sentry.flush(2000)` calls used.
const SENTRY_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Finish the process: flush output, shut down what we own, then let the event
 * loop end naturally with `exitCode` recorded.
 *
 * Callers should `return` immediately after awaiting this - it does not stop
 * execution the way `process.exit()` did.
 */
export async function finishAndExit(exitCode: number): Promise<void> {
  // FIRST, and still load-bearing: `process.stdout.write` is async on a pipe,
  // and a terminal NDJSON line over 64 KiB is otherwise truncated. This is a
  // different bug from the teardown abort and its fix stays exactly as it was.
  // See std-write.ts.
  await flushStdio();

  // `close()` rather than `flush()`: flush drains the queue but leaves the
  // client and its transport running, which is precisely the kind of live
  // machinery the teardown then races. Close before the dispatcher below -
  // sending the last event needs the network.
  await quietly(() => Sentry.close(SENTRY_CLOSE_TIMEOUT_MS));

  // Retire pooled keep-alive sockets deliberately instead of leaving them to
  // teardown. Not required to avoid a hang (see the measurement above); it
  // removes one of the two named suspects from the exit window.
  await quietly(() => getGlobalDispatcher().close());

  process.exitCode = exitCode;
  armDrainWatchdog(exitCode);
}

/**
 * Force the exit if the loop is still alive well after the work is done.
 *
 * `unref()` is what makes this correct rather than self-defeating: an unref'd
 * timer cannot hold the loop open by itself, so on the normal path the process
 * exits before it ever fires. It only fires when something ELSE is holding the
 * loop - exactly the case it exists for.
 */
function armDrainWatchdog(exitCode: number): void {
  const timer = setTimeout(() => {
    // Self-reporting on purpose: reaching here means the drain did not work,
    // and this line is the only evidence a field report would carry. Written
    // with `writeSync` because the tracked async writers cannot be trusted to
    // land in front of the `process.exit` on the next line.
    try {
      writeSync(
        2,
        `traycer: exit stalled ${DRAIN_WATCHDOG_MS}ms after completion; forcing exit ${exitCode}\n`,
      );
    } catch {
      // A closed or broken stderr must not turn a forced exit into a throw.
    }
    process.exit(exitCode);
  }, DRAIN_WATCHDOG_MS);
  timer.unref();
}

/**
 * Run a teardown step, swallowing anything it throws or rejects with.
 *
 * Teardown is best-effort by definition: a Sentry transport that cannot reach
 * the network, or a dispatcher already closed, must not stop the process from
 * reporting the exit code its command actually earned.
 */
async function quietly(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Intentionally silent - see above.
  }
}
