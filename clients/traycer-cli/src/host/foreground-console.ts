import type { Environment } from "../runner/environment";
import type { ProgressEvent } from "../runner/output";
import { writeStdout, writeStdoutBytes } from "../runner/std-write";
import { hostLogPath } from "../store/paths";
import {
  LOG_TAIL_MAX_MISSING_RETRIES,
  LOG_TAIL_POLL_INTERVAL_MS,
  startLogTail,
  type LogTail,
  type LogTailOptions,
} from "./log-tail";

// Terminal feedback for `traycer host start`, which is BOTH the user-facing
// verb and the long-running supervisor entrypoint every service definition
// executes (launchd / systemd-user / Windows Scheduled Task).
//
// The command blocks for the life of the host, and it used to block SILENTLY:
// the child's stdout is bound to the host-log descriptor and the supervisor's
// stderr tee appends to that same file, so a person who typed
// `traycer host start` got an unresponsive terminal with no output and no
// indication that anything had happened. This module is the repair -
// announce what the invocation is doing, then mirror newly appended
// `host.log` content for as long as it runs.
//
// The child's stdio contract is deliberately UNCHANGED: the mirror reads the
// log file by path, so it picks up supervisor markers and child stdout/stderr
// alike while the single log sink stays exactly where every other reader
// (Doctor, `host logs`, Desktop) already looks.

/**
 * What a `host start` invocation is allowed to print.
 *
 * - `mirror` - a person is watching: banner plus streamed `host.log` appends.
 * - `banner` - announce and stop there. The banner is one-shot and a few lines
 *   long; the mirror polls and reads for the entire life of a supervisor that
 *   can run for weeks. Where interactivity cannot be established beyond doubt,
 *   the cheap half is still worth printing and the expensive half is not.
 * - `events` - `--json`: one structured lifecycle event, and NEVER raw log
 *   lines. Mirrors `host logs`, whose `--follow` is likewise inert under
 *   `--json` because an NDJSON consumer wants events, not a file firehose.
 * - `silent` - a service manager, a script, or `--quiet`: byte-for-byte the
 *   behaviour this command has always had.
 */
export type ForegroundStartMode = "mirror" | "banner" | "events" | "silent";

export interface ForegroundStartModeInput {
  /**
   * The invocation carries service-identity flags (`--service-label` and
   * friends), so it came from a registered service definition.
   *
   * Checked FIRST and on its own, because it is the only signal that is
   * positive evidence rather than an inference. TTY detection alone would
   * make the boundary depend on how a service manager happened to wire
   * stdout; a labelled start says who it is.
   */
  readonly serviceManaged: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  /**
   * `--no-progress`. The only structured thing this command emits IS a
   * `progress` event, so the flag that says "suppress progress events" has to
   * suppress it - otherwise `--json --no-progress` puts a `type: "progress"`
   * line on the stdout of automation that explicitly asked for none.
   */
  readonly noProgress: boolean;
  /** stdout is a terminal. */
  readonly interactive: boolean;
  /**
   * `process.platform`. Windows is the one platform where a TTY does NOT imply
   * a human - see the mirror gate below.
   */
  readonly platform: NodeJS.Platform;
}

export function resolveForegroundStartMode(
  input: ForegroundStartModeInput,
): ForegroundStartMode {
  if (input.serviceManaged) return "silent";
  if (input.json) return input.noProgress ? "silent" : "events";
  if (input.quiet) return "silent";
  if (!input.interactive) return "silent";
  return canMirrorOnPlatform(input.platform) ? "mirror" : "banner";
}

/**
 * Is a TTY on this platform sufficient evidence that a PERSON is watching?
 *
 * Everywhere but Windows, yes. launchd runs the supervisor under `/bin/sh -c`
 * with its output bound to a file, and systemd binds it to the journal socket;
 * neither ever allocates a controlling terminal, so a TTY means a shell.
 *
 * On Windows it is NOT sufficient, and this is a live case rather than a
 * theoretical one. Scheduled Tasks registered before the launcher was hidden
 * (`fix(windows): hide host task launcher`) execute the CLI DIRECTLY with a
 * bare `host start`, no identity flags, `LogonType=InteractiveToken` and
 * `Hidden=false` - so Task Scheduler allocates a console and `stdout.isTTY` is
 * true. Those definitions are still attested by
 * `host-lifecycle/identity.ts` and still on machines, because the task
 * definition is replaced independently of the CLI slot it invokes. From inside
 * the process that invocation is byte-for-byte identical to a person typing
 * `traycer host start`.
 *
 * So Windows gets the banner and not the mirror. The audit's own rule is that
 * TTY inference must not be the sole safety boundary; where the inference is
 * known-unreliable, the unbounded half of the behaviour does not run. A
 * Windows user still learns the command is blocking, where the log is, and how
 * to follow it - which is the defect this feature exists to fix.
 */
function canMirrorOnPlatform(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

export interface ForegroundConsoleOptions {
  readonly environment: Environment;
  readonly mode: ForegroundStartMode;
}

export interface ForegroundConsoleDeps {
  readonly logPath: (environment: Environment) => string;
  readonly writeText: (text: string) => void;
  readonly writeBytes: (chunk: Buffer) => void;
  readonly startTail: (options: LogTailOptions) => LogTail;
  readonly now: () => string;
}

export const defaultForegroundConsoleDeps: ForegroundConsoleDeps = {
  logPath: hostLogPath,
  writeText: writeStdout,
  writeBytes: writeStdoutBytes,
  startTail: startLogTail,
  now: () => new Date().toISOString(),
};

export interface ForegroundConsole {
  /**
   * Stop mirroring and flush whatever landed since the last poll.
   *
   * Called from the supervisor's injected `exit`, which is deliberately a bare
   * synchronous `process.exit` (see runner/exit.ts) - so the catch-up read has
   * to be synchronous too or the last lines before shutdown never reach the
   * terminal that was watching for them.
   */
  close(): void;
}

const INERT_CONSOLE: ForegroundConsole = {
  close: (): void => undefined,
};

/**
 * Announce the invocation and start mirroring, per `options.mode`.
 *
 * Returns an inert handle in `silent` mode so callers never branch on the
 * mode themselves.
 */
export function openForegroundConsole(
  options: ForegroundConsoleOptions,
  injected: Partial<ForegroundConsoleDeps>,
): ForegroundConsole {
  const deps: ForegroundConsoleDeps = {
    ...defaultForegroundConsoleDeps,
    ...injected,
  };
  if (options.mode === "silent") return INERT_CONSOLE;
  const path = deps.logPath(options.environment);

  if (options.mode === "events") {
    // The documented NDJSON envelope, not a bespoke event type: a consumer
    // discriminates on `type`, and inventing a fourth shape here would break
    // readers that already exhaustively handle progress/result. One event,
    // emitted before the first long wait, is the whole contract - this command
    // has no terminal `result` to emit because it does not terminate on its
    // own.
    const event: ProgressEvent = {
      type: "progress",
      stage: "host-supervise",
      percent: null,
      bytes: null,
      totalBytes: null,
      message: `supervising the Traycer host in the foreground; log=${path}`,
      workUnits: null,
      timestamp: deps.now(),
    };
    deps.writeText(`${JSON.stringify(event)}\n`);
    return INERT_CONSOLE;
  }

  // Printed BEFORE the first long wait - before target resolution, the
  // incumbent probe, and the spawn - because the whole defect is a terminal
  // that looks hung. Everything below it is streamed log content, so the
  // banner is the last line this CLI writes in its own voice.
  deps.writeText(
    [
      `Running the Traycer host in the foreground (environment=${options.environment}).`,
      `  log:  ${path}`,
      `  stop: press Ctrl-C`,
      ...(options.mode === "banner"
        ? [
            `To watch the log, run 'traycer host logs --follow' in another terminal.`,
          ]
        : []),
      `To run the host in the background instead, press Ctrl-C and run 'traycer host service start'.`,
      ``,
    ].join("\n"),
  );

  if (options.mode === "banner") return INERT_CONSOLE;

  const tail = deps.startTail({
    path,
    // Raw bytes, verbatim: the mirror is a view of one existing sink, not a
    // second formatter of host output. Re-rendering it here would make the
    // terminal and `host logs` disagree about what the host actually said.
    onBytes: (chunk) => deps.writeBytes(chunk),
    onExhausted: () => {
      deps.writeText(
        `traycer host start: ${path} stayed unreadable; stopped mirroring the host log. The host is still being supervised.\n`,
      );
    },
    onSkipped: (bytes) => {
      deps.writeText(
        `\ntraycer host start: skipped ${bytes} bytes of host log to print the most recent output; the full log is at ${path}.\n`,
      );
    },
    pollIntervalMs: LOG_TAIL_POLL_INTERVAL_MS,
    maxMissingRetries: LOG_TAIL_MAX_MISSING_RETRIES,
  });

  return {
    close: (): void => {
      tail.stop();
      tail.drainSync();
    },
  };
}
