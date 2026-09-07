import type { Environment } from "../runner/environment";
import type { ProgressEvent } from "../runner/output";
import { writeStdoutSync } from "../runner/std-write";
import { hostLogPath } from "../store/paths";

// Terminal feedback for `traycer host start`, which is BOTH the user-facing verb and the long-running supervisor entrypoint every service definition executes (launchd / systemd-user / Windows Scheduled Task).
// The command blocks for the life of the host, and it used to block SILENTLY: the child's stdout is bound to the host-log descriptor and the supervisor's stderr tee appends to that same file, so a person who typed `traycer host start` got an unresponsive terminal with no output and no indication that anything had happened.

/** `host start` may print only bootstrap markers and fatal diagnostics, never a TTY prompt. */
export type ForegroundStartMode = "banner" | "events" | "silent";

export interface ForegroundStartModeInput {
  /** The invocation carries service-identity flags (`--service-label` and friends), so it came from a registered service definition. Checked FIRST and on its own, because it is the only signal that is positive evidence rather than an inference. */
  readonly serviceManaged: boolean;
  readonly json: boolean;
  /** `--quiet`. Suppresses HUMAN output only - it does not gate the `--json` lifecycle event, matching the runner, whose JSON progress path checks `noProgress` alone. */
  readonly quiet: boolean;
  /** `--no-progress`. The only structured thing this command emits IS a `progress` event, so the flag that says "suppress progress events" has to suppress it - otherwise `--json --no-progress` puts a `type: "progress"` line on the stdout of automation that explicitly asked for none. */
  readonly noProgress: boolean;
  /** stdout is a terminal. */
  readonly interactive: boolean;
}

export function resolveForegroundStartMode(
  input: ForegroundStartModeInput,
): ForegroundStartMode {
  if (input.serviceManaged) return "silent";
  if (input.json) return input.noProgress ? "silent" : "events";
  if (input.quiet) return "silent";
  return input.interactive ? "banner" : "silent";
}

/** A NOTE ON WINDOWS, kept because it constrains anything richer than a banner. A TTY does not imply a human there. */

export interface ForegroundConsoleOptions {
  readonly environment: Environment;
  readonly mode: ForegroundStartMode;
}

export interface ForegroundConsoleDeps {
  readonly logPath: (environment: Environment) => string;
  readonly writeText: (text: string) => void;
  readonly now: () => string;
}

export const defaultForegroundConsoleDeps: ForegroundConsoleDeps = {
  logPath: hostLogPath,
  // Synchronous: these lines are written before the first long wait, they are exactly the output a fast exit would otherwise lose, and each is far below a pipe buffer. they are written before the first long wait, they are the output a fast exit would otherwise lose, and each is far below a pipe buffer.
  writeText: (text) => writeStdoutSync(Buffer.from(text, "utf8")),
  now: () => new Date().toISOString(),
};

export interface ForegroundConsole {
  /** Release anything the console holds. Nothing does today - the banner is one-shot and there is no follower - but the handle is kept so the supervisor's injected `exit` has a stable seam and callers never branch on the mode. */
  close(): void;
}

const INERT_CONSOLE: ForegroundConsole = {
  close: (): void => undefined,
};

/** Announce the invocation, per `options.mode`. Returns an inert handle in `silent` mode so callers never branch on the mode themselves. */
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
    // The documented NDJSON envelope, not a bespoke event type: a consumer discriminates on `type`, and inventing a fourth shape here would break readers that already exhaustively handle progress/result.
    // One event, emitted before the first long wait, is the whole contract - this command has no terminal `result` to emit because it does not terminate on its own.
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

  // Printed BEFORE the first long wait - before target resolution, the incumbent probe, and the spawn - because the whole defect is a terminal that looks hung.
  // Everything below it is streamed log content, so the banner is the last line this CLI writes in its own voice.
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

  return INERT_CONSOLE;
}
