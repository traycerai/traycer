import { writeSync } from "node:fs";
import * as Sentry from "@sentry/node";
import { getGlobalDispatcher } from "undici";
import { destroySentryTransportRequests } from "../sentry-transport";
import { flushStdio } from "./std-write";

// Every command exit routes through `finishAndExit`. Drain stdout/stderr before `process.exit` so PIPE writes are not truncated.

// Total backstop for the whole terminator.
// Must exceed the sum of the bounds below it (10s stdio + 2s Sentry + 1s dispatcher = 13s), or those bounds are unreachable and only this one ever fires.
const DRAIN_WATCHDOG_MS = 15_000;

// Same budget the previous inline `Sentry.flush(2000)` calls used.
const SENTRY_CLOSE_TIMEOUT_MS = 2_000;

// Graceful first, then forced. `close()` waits for running requests with no
// timeout of its own, so it can outlive the process it is trying to end.
const DISPATCHER_CLOSE_TIMEOUT_MS = 1_000;

// The code the process will exit with.
// Not read back off `process.exitCode`: anything else in the process may write that, and arbitration here has to be over the codes THIS module was actually given.
let recordedExitCode: number | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let networkTeardown: Promise<void> | null = null;
// Distinct from "the recorded code is non-zero": a command that fails normally emits an `error` envelope and earns its code.
// This flag means the PROCESS failed out from under the command - an unhandled rejection or uncaught exception - which the command itself knows nothing about.
let processFatal = false;

/** Record that a process-fatal handler has selected failure for this process. Draining means the interrupted command keeps running and can still finish, so the runner has to be able to ask whether the process it is about to report success for is already doomed. */
export function markProcessFatal(): void {
  processFatal = true;
}

/** Whether a process-fatal handler already selected failure. The runner checks this before emitting a terminal `ok`: with the desktop now trusting a terminal `ok` over a non-zero exit, a success envelope emitted after a fatal would report a failed install/update as successful. */
export function isProcessFatal(): boolean {
  return processFatal;
}

/** Finish the process: record the code, arm the backstop, flush output, shut down what we own, then let the event loop end naturally. Callers should `return` immediately after awaiting this - it does not stop execution the way `process.exit()` did. */
export async function finishAndExit(exitCode: number): Promise<void> {
  // BOTH of these before the first `await`. See the ordering note above.
  recordExitCode(exitCode);
  armDrainWatchdog();

  // Still load-bearing: `process.stdout.write` is async on a pipe, and a terminal NDJSON line over 64 KiB is otherwise truncated.
  // This is a different bug from the teardown abort and its fix stays exactly as it was.
  await flushStdio();

  // Once per process: the clients are shared, and closing them twice would at
  // best be wasted work on a process that is already ending.
  networkTeardown ??= closeNetworkClients();
  await networkTeardown;
}

/** Arbitrate between codes when more than one path finishes the process. Monotonic towards failure: the first non-zero code sticks. */
function recordExitCode(exitCode: number): void {
  if (recordedExitCode === null || (recordedExitCode === 0 && exitCode !== 0)) {
    recordedExitCode = exitCode;
  }
  process.exitCode = recordedExitCode;
}

/** Force the exit if the loop is still alive well after the work is done. `unref()` is what makes this correct rather than self-defeating: an unref'd timer cannot hold the loop open by itself, so on the normal path the process exits before it ever fires. */
function armDrainWatchdog(): void {
  if (watchdogTimer !== null) return;
  const timer = setTimeout(() => {
    // Read the code at FIRE time, not at arm time: a later `finishAndExit` may
    // legitimately have upgraded it.
    const code = recordedExitCode ?? 0;
    // Self-reporting on purpose: reaching here means the drain did not work, and this line is the only evidence a field report would carry.
    // Written with `writeSync` because the tracked async writers cannot be trusted to land in front of the `process.exit` on the next line.
    try {
      writeSync(
        2,
        `traycer: exit stalled ${DRAIN_WATCHDOG_MS}ms after completion; forcing exit ${code}\n`,
      );
    } catch {
      // A closed or broken stderr must not turn a forced exit into a throw.
    }
    process.exit(code);
  }, DRAIN_WATCHDOG_MS);
  timer.unref();
  watchdogTimer = timer;
}

/** Retire the two network clients that outlive a finished command. Each step is individually bounded, and each falls back to a forced release rather than an unbounded wait - a teardown step that can hang forever turns "let the loop drain" into "never exit". */
async function closeNetworkClients(): Promise<void> {
  // `close()` rather than `flush()`: flush drains the queue but leaves the client enabled.
  // Neither, however, retires the transport's SOCKETS - in Sentry 10.x `close` is `flush` plus `enabled = false`, and its request path installs no timeout.
  await bounded(
    quietly(() => Sentry.close(SENTRY_CLOSE_TIMEOUT_MS)),
    SENTRY_CLOSE_TIMEOUT_MS,
  );
  // Silent by design: a destroyed request means one telemetry envelope was lost because the DSN endpoint was not answering.
  // That is not the user's problem and not worth a line on their stderr - and the alternative, waiting for it, is the hang this whole module exists to prevent.
  destroySentryTransportRequests();

  // Retire pooled keep-alive sockets deliberately instead of leaving them to teardown.
  // `Agent.close()` waits for RUNNING requests and has no timeout of its own, so a stalled response body (a CDN that sends 503 headers and then goes quiet) would park here indefinitely.
  const dispatcher = getGlobalDispatcher();
  const closed = await bounded(
    quietly(() => dispatcher.close()),
    DISPATCHER_CLOSE_TIMEOUT_MS,
  );
  if (!closed) {
    // `destroy()` aborts in-flight requests instead of waiting them out.
    await bounded(
      quietly(() => dispatcher.destroy()),
      DISPATCHER_CLOSE_TIMEOUT_MS,
    );
  }
}

/** Await `work`, giving up after `timeoutMs`. Resolves `true` if the work settled in time and `false` if the bound expired, so the caller can escalate to a forced shutdown. */
function bounded(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void work.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Run a teardown step, swallowing anything it throws or rejects with. Teardown is best-effort by definition: a Sentry transport that cannot reach the network, or a dispatcher already closed, must not stop the process from reporting the exit code its command actually earned. */
async function quietly(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Intentionally silent - see above.
  }
}
