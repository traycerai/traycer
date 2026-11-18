import { writeSync } from "node:fs";
import * as Sentry from "@sentry/node";
import { getGlobalDispatcher } from "undici";
import { destroySentryTransportRequests } from "../sentry-transport";
import { flushStdio } from "./std-write";

// How the CLI ends. Every command exit routes through `finishAndExit` instead
// of calling `process.exit()` itself. (One deliberate exception: the host
// bootstrap's injected `exit` dependency in commands/host-start.ts. That
// process is the host SUPERVISOR, and its exit is a LATENCY choice, not an
// unboundedness one - draining here is bounded, by `DRAIN_WATCHDOG_MS` below.
// The supervisor spawns children that inherit its stderr; a grandchild can
// hold that pipe open past the supervisor's own bounded stderr/tee drains, at
// which point routing through this terminator would add up to a further 15s
// before the watchdog forced the exit. Its exit code is what the service
// manager reads to decide whether to relaunch, so it reports synchronously
// after writing its terminal marker and closing what it owns; see the exit
// note in host-start.ts. NOT because signal listeners hold the loop open -
// they do not.)
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
// THE ORDER BELOW IS THE FIX, not an implementation detail. A cold review of
// the first version found the watchdog armed AFTER the teardown awaits, so the
// two steps most likely to hang were the two steps the backstop did not cover.
// The code is recorded and the watchdog armed BEFORE anything that can block,
// and every blocking step carries its own bound underneath it. An unbounded
// await here does not degrade to a slow exit; it degrades to a CLI that never
// answers its caller at all.

// Total backstop for the whole terminator. Must exceed the sum of the bounds
// below it (10s stdio + 2s Sentry + 1s dispatcher = 13s), or those bounds are
// unreachable and only this one ever fires. On the process-fatal path the
// dispatcher step is skipped (see `closeNetworkClients`), so there this is
// the bound that retires any keep-alive socket still holding the loop open -
// the fatal exit may take up to this long instead of ~1s. Still far below the desktop
// wrapper's 45s `CLI_JSON_TIMEOUT_MS`, so a wedged CLI answers its caller
// rather than being killed by it.
const DRAIN_WATCHDOG_MS = 15_000;

// Same budget the previous inline `Sentry.flush(2000)` calls used.
const SENTRY_CLOSE_TIMEOUT_MS = 2_000;

// Graceful first, then forced. `close()` waits for running requests with no
// timeout of its own, so it can outlive the process it is trying to end.
const DISPATCHER_CLOSE_TIMEOUT_MS = 1_000;

// The code the process will exit with. Not read back off `process.exitCode`:
// anything else in the process may write that, and arbitration here has to be
// over the codes THIS module was actually given.
let recordedExitCode: number | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let networkTeardown: Promise<void> | null = null;
// Distinct from "the recorded code is non-zero": a command that fails normally
// emits an `error` envelope and earns its code. This flag means the PROCESS
// failed out from under the command - an unhandled rejection or uncaught
// exception - which the command itself knows nothing about.
let processFatal = false;

/**
 * Record that a process-fatal handler has selected failure for this process.
 *
 * Draining means the interrupted command keeps running and can still finish,
 * so the runner has to be able to ask whether the process it is about to
 * report success for is already doomed. See `isProcessFatal`.
 */
export function markProcessFatal(): void {
  processFatal = true;
}

/**
 * Whether a process-fatal handler already selected failure.
 *
 * The runner checks this before emitting a terminal `ok`: with the desktop now
 * trusting a terminal `ok` over a non-zero exit, a success envelope emitted
 * after a fatal would report a failed install/update as successful. The CLI
 * must not make that claim in the first place.
 */
export function isProcessFatal(): boolean {
  return processFatal;
}

// Whether the runner is inside a command's body right now. Set by
// `runCommand` around the one `await fn(ctx)`; read by the process-fatal path
// below to decide who finishes the process.
let commandInFlight = false;

/** The runner is about to hand control to a command body. */
export function markCommandStarted(): void {
  commandInFlight = true;
}

/** The command body has settled (returned or thrown); the runner owns the exit again. */
export function markCommandSettled(): void {
  commandInFlight = false;
  if (fatalInFlightCeiling !== null) {
    clearTimeout(fatalInFlightCeiling);
    fatalInFlightCeiling = null;
  }
}

/**
 * How long a command may keep running after a process-fatal handler fired
 * inside it before this module ends the process anyway.
 *
 * Sized for the command's WORK, not for a drain: a `host update` that took
 * the fatal mid-download may still have the rest of the download, the
 * install-directory swap, the service restart and the health probe ahead of
 * it, each bounded by its own timeout. The ceiling exists for the command
 * that never settles at all - the callback that threw was the one that would
 * have resolved the promise the runner awaits, and a keep-alive socket holds
 * the loop open - and it is deliberately far above swap-plus-restart so that
 * it lands there only for a command that was already stuck.
 */
const FATAL_IN_FLIGHT_CEILING_MS = 10 * 60_000;
let fatalInFlightCeiling: NodeJS.Timeout | null = null;

/**
 * Finish the process after a process-fatal handler has fired - at once when
 * no command is in flight, and otherwise no sooner than the command's work.
 *
 * The handlers used to fire-and-forget `finishAndExit(1)` on the spot. That
 * ARMS THE DRAIN WATCHDOG, a `process.exit` in `DRAIN_WATCHDOG_MS`, while the
 * interrupted command keeps running by design. As long as the fatal also tore
 * the network out from under the command (see `closeNetworkClients`), the
 * command died at its next request and the watchdog only ever ended a process
 * with nothing left to do. Once the dispatcher stays open on the fatal path,
 * the command can REACH ITS WORK: the real-host matrix watched a `host update`
 * take an undici assertion mid download, carry on, and finish the
 * install-directory swap and the service restart at 14 s - one second inside
 * the watchdog. A slower disk and that `process.exit` lands between "stopping
 * service" and "starting service", with the host down and the install
 * half-replaced. The fatal handler cannot know what the command is in the
 * middle of; the command can.
 *
 * So while a command is in flight this records the code and NOTHING ELSE.
 * The code is recorded here and now because it cannot interrupt anything and
 * because its absence has a failure of its own: a command whose resolver died
 * with the throw never settles, and once its last handle closes the loop
 * drains and the process exits with whatever `process.exitCode` holds - 0,
 * for a process that printed a fatal (B, round 8). The watchdog is what waits:
 * the runner checks `isProcessFatal()` when the body settles, emits the
 * process-fatal envelope instead of `ok`, and calls `finishAndExit(1)` itself,
 * which arms it after the work the command owns is done. Behind that sits
 * `FATAL_IN_FLIGHT_CEILING_MS` for the command that never settles. With no
 * command in flight - a fatal during bootstrap or teardown - nothing will
 * finish the process for us, and this does what the handler always did.
 */
export function finishAfterProcessFatal(): Promise<void> {
  if (!commandInFlight) return finishAndExit(1);
  recordExitCode(1);
  if (fatalInFlightCeiling === null) {
    const timer = setTimeout(() => {
      fatalInFlightCeiling = null;
      void finishAndExit(1);
    }, FATAL_IN_FLIGHT_CEILING_MS);
    timer.unref();
    fatalInFlightCeiling = timer;
  }
  return Promise.resolve();
}

/**
 * Finish the process: record the code, arm the backstop, flush output, shut
 * down what we own, then let the event loop end naturally.
 *
 * Callers should `return` immediately after awaiting this - it does not stop
 * execution the way `process.exit()` did.
 */
export async function finishAndExit(exitCode: number): Promise<void> {
  // BOTH of these before the first `await`. See the ordering note above.
  recordExitCode(exitCode);
  armDrainWatchdog();

  // Still load-bearing: `process.stdout.write` is async on a pipe, and a
  // terminal NDJSON line over 64 KiB is otherwise truncated. This is a
  // different bug from the teardown abort and its fix stays exactly as it was.
  // Re-run per call - a second caller may have written more output.
  // See std-write.ts.
  await flushStdio();

  // Once per process: the clients are shared, and closing them twice would at
  // best be wasted work on a process that is already ending.
  networkTeardown ??= closeNetworkClients();
  await networkTeardown;
}

/**
 * Arbitrate between codes when more than one path finishes the process.
 *
 * Monotonic towards failure: the first non-zero code sticks. The process-fatal
 * handler (`exitAfterUnhandledFailure`, via `finishAfterProcessFatal`) records
 * a 1 the moment it fires and draining lets the interrupted command keep
 * running, so without this a command that went on to finish with a 0 - the
 * runner's own teardown after a fatal that fired during it, or any caller
 * that does not consult `isProcessFatal()` - would overwrite the fatal 1 and
 * report success for a process that failed.
 */
function recordExitCode(exitCode: number): void {
  if (recordedExitCode === null || (recordedExitCode === 0 && exitCode !== 0)) {
    recordedExitCode = exitCode;
  }
  process.exitCode = recordedExitCode;
}

/**
 * Force the exit if the loop is still alive well after the work is done.
 *
 * `unref()` is what makes this correct rather than self-defeating: an unref'd
 * timer cannot hold the loop open by itself, so on the normal path the process
 * exits before it ever fires. It only fires when something ELSE is holding the
 * loop - exactly the case it exists for.
 *
 * Armed at most once. Two watchdogs for one process would mean two racing
 * `process.exit` calls, and the second could report a code the first had
 * already superseded.
 */
function armDrainWatchdog(): void {
  if (watchdogTimer !== null) return;
  const timer = setTimeout(() => {
    // Read the code at FIRE time, not at arm time: a later `finishAndExit` may
    // legitimately have upgraded it.
    const code = recordedExitCode ?? 0;
    // Self-reporting on purpose: reaching here means the drain did not work,
    // and this line is the only evidence a field report would carry. Written
    // with `writeSync` because the tracked async writers cannot be trusted to
    // land in front of the `process.exit` on the next line.
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

/**
 * Retire the two network clients that outlive a finished command.
 *
 * Each step is individually bounded, and each falls back to a forced release
 * rather than an unbounded wait - a teardown step that can hang forever turns
 * "let the loop drain" into "never exit".
 */
async function closeNetworkClients(): Promise<void> {
  // `close()` rather than `flush()`: flush drains the queue but leaves the
  // client enabled. Neither, however, retires the transport's SOCKETS - in
  // Sentry 10.x `close` is `flush` plus `enabled = false`, and its request
  // path installs no timeout. So bound the flush, then destroy whatever is
  // still in flight. See sentry-transport.ts for the measurement.
  await bounded(
    quietly(() => Sentry.close(SENTRY_CLOSE_TIMEOUT_MS)),
    SENTRY_CLOSE_TIMEOUT_MS,
  );
  // Silent by design: a destroyed request means one telemetry envelope was
  // lost because the DSN endpoint was not answering. That is not the user's
  // problem and not worth a line on their stderr - and the alternative,
  // waiting for it, is the hang this whole module exists to prevent.
  destroySentryTransportRequests();

  // Retire pooled keep-alive sockets deliberately instead of leaving them to
  // teardown. `Agent.close()` waits for RUNNING requests and has no timeout of
  // its own, so a stalled response body (a CDN that sends 503 headers and then
  // goes quiet) would park here indefinitely.
  //
  // Not on the process-fatal path, and that exception is the whole reason this
  // step is guarded rather than unconditional. A fatal lets the interrupted
  // work KEEP RUNNING by design (see `markProcessFatal`): a runner command
  // reaches this step only after its body settled (`finishAfterProcessFatal`
  // defers the whole exit to the runner while one is in flight), but the
  // paths that run OUTSIDE the runner - `monitor`, the relocation parent
  // waiting on its child, `maintenance-lease` - take the fatal handler's own
  // `finishAndExit(1)` at once and are still fetching through this very
  // dispatcher, because there is only one. And once this step has been
  // skipped it stays skipped (below), so a runner command that settles after
  // a fatal never closes it either. undici's `DispatcherBase` rejects every dispatch after a
  // close with `ClientClosedError`, which `fetch` surfaces as a bare
  // `TypeError: fetch failed`. So closing here does not tidy up after the
  // failure, it MANUFACTURES a second one: an in-flight host download burns its
  // whole retry budget against a registry that was answering fine and reports
  // `E_REGISTRY_UNAVAILABLE`, and that invented outage is the line the user
  // reads and reports, not the real fault. Giving the sockets up unclosed costs
  // nothing here - the process is ending with a failure code either way, and
  // `DRAIN_WATCHDOG_MS` above already bounds a loop that will not end on its
  // own once the command has settled and armed it (see
  // `finishAfterProcessFatal` for why the fatal itself no longer arms it). A
  // normal exit - one that never marked the process fatal - is unchanged. Note
  // the reach of the skip: `finishAndExit` memoizes this teardown, so once a
  // fatal has taken this early return, a later `finishAndExit` reuses the
  // settled promise and the dispatcher is never closed for the rest of that
  // process. That is the intent, stated so nobody reads "skipped once" into it.
  if (processFatal) return;

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

/**
 * Await `work`, giving up after `timeoutMs`.
 *
 * Resolves `true` if the work settled in time and `false` if the bound
 * expired, so the caller can escalate to a forced shutdown. The timer is
 * cleared on the normal path so it cannot itself hold the loop open.
 */
function bounded(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void work.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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
