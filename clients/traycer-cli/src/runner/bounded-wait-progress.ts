import { AsyncLocalStorage } from "node:async_hooks";
import type { ProgressInfo } from "./output";

/**
 * Progress for the bounded waits deep inside a command, where no
 * `CommandContext` reaches.
 *
 * Desktop runs every lifecycle verb under an idle timer that any NDJSON line
 * re-arms and that kills the CLI after `CLI_STREAM_IDLE_TIMEOUT_MS` (ten
 * minutes) of silence. Each wait below a command is bounded, but a command
 * can stack them - the Windows `host restart` ran its stop ladder, a
 * relaunch, the post-timeout reads, two refused-supervisor waits and a
 * second relaunch without one line, ~693 s under the timer model, and a
 * Desktop-owned macOS stop spends up to three host RPCs in one silent
 * stand-down. A kill there lands in the middle of the restart.
 *
 * So each such wait reports as it BEGINS (`reportBoundedWait`), and the
 * longest silence a caller can see is one wait's own bound rather than the
 * sum of a command's. Never on a timer, and deliberately so: a heartbeat
 * would re-arm Desktop's kill forever and hide a wedged CLI, which is the one
 * thing that kill is for. A wait that never ends still goes silent.
 *
 * Same request-scoped shape as `service/spawn-edge.ts`: `runCommand` arms the
 * reporter around the command body, and code outside a command (a bare
 * controller call in a test, a library caller) reports nothing.
 */
const boundedWaitReporter = new AsyncLocalStorage<
  (info: ProgressInfo) => void
>();

/**
 * One stage for every such wait. The renderer's stall detection keys on the
 * stage, never the message (`laneProgressAdvanceKey`), so a run of waits reads
 * to it as one step: these lines keep the CLI alive, and they do not hold off
 * the Retry surface a slow step earns. The message says which wait began.
 */
export const BOUNDED_WAIT_PROGRESS_STAGE = "lifecycle-wait";

export function withBoundedWaitProgress<T>(
  report: (info: ProgressInfo) => void,
  run: () => Promise<T>,
): Promise<T> {
  return boundedWaitReporter.run(report, run);
}

/**
 * Report that a bounded wait is about to begin. `message` is shown to a
 * person - Desktop's lane detail line, a terminal's progress line - so it is
 * plain prose and names no account, host or process.
 */
export function reportBoundedWait(message: string): void {
  const report = boundedWaitReporter.getStore();
  if (report === undefined) return;
  try {
    report({
      stage: BOUNDED_WAIT_PROGRESS_STAGE,
      message,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
  } catch {
    // A progress line never changes what the lifecycle step does: the wait
    // that follows runs whether or not its announcement was written.
  }
}
