import * as Sentry from "@sentry/node";
import { errorFromUnknown } from "../logger";
import { toCliError } from "./errors";
import { createOutput, type Output, type ProgressInfo } from "./output";
import {
  type RawRunnerFlags,
  readonlyEnv,
  resolveRuntimeContext,
  type RuntimeContext,
} from "./runtime";

// Context handed to every CommandFn. `progress(info)` is a thin
// convenience mirroring output.progress so command bodies don't have
// to reach into `ctx.output` for the common case. Field shape matches
// the NDJSON progress event 1:1 - pass `null` for unknown fields.
export interface CommandContext {
  readonly runtime: RuntimeContext;
  readonly output: Output;
  progress(info: ProgressInfo): void;
}

// What a command returns to the runner:
//   - `data` is the structured payload surfaced as `result.data` in NDJSON.
//   - `human` is the optional text to print on the human path.
//     `null` means "command already emitted its own human output" (e.g.
//     host-status renders its own multi-line block).
//   - `exitCode` defaults to 0; non-zero lets a command succeed in the
//     "we did our job, here's the answer" sense while still signalling a
//     state the shell convention treats as a failure (e.g. whoami when
//     not logged in).
export interface CommandResult {
  readonly data: unknown;
  readonly human: string | null;
  readonly exitCode: number;
}

export type CommandFn = (ctx: CommandContext) => Promise<CommandResult>;

// Drives a single command end-to-end:
//   1. Resolve runtime flags + env into a RuntimeContext.
//   2. Build the appropriate Output (NDJSON or human).
//   3. Invoke the command function.
//   4. Render the human result OR emit the NDJSON `result` event.
//   5. On throw: emit the terminal `result` event with status=error and
//      exit with the code on the CliError (or 1 for unknown errors).
//
// The runner owns process.exit - callers should not exit themselves.
export async function runCommand(
  fn: CommandFn,
  flags: RawRunnerFlags,
): Promise<void> {
  const runtime = resolveRuntimeContext(flags, readonlyEnv());
  const output = createOutput(runtime);
  const ctx: CommandContext = {
    runtime,
    output,
    progress: (info) => output.progress(info),
  };
  runtime.logger.info("CLI command started", {
    environment: runtime.environment,
    json: runtime.json,
    quiet: runtime.quiet,
    noProgress: runtime.noProgress,
    noBootstrap: runtime.noBootstrap,
    nonInteractive: runtime.nonInteractive,
  });
  let result: CommandResult;
  try {
    result = await fn(ctx);
  } catch (err) {
    Sentry.captureException(err);
    const cliErr = toCliError(err);
    runtime.logger.error(
      "CLI command failed",
      {
        code: cliErr.code,
        exitCode: cliErr.exitCode,
        emittedAsJson: runtime.json,
      },
      errorFromUnknown(err),
    );
    output.emitError(cliErr.code, cliErr.message, cliErr.details);
    try {
      await Sentry.flush(2000);
    } catch (flushErr) {
      runtime.logger.warn("Sentry flush failed after command error", {
        errorName: errorFromUnknown(flushErr).name,
        errorMessage: errorFromUnknown(flushErr).message,
      });
      // best-effort; do not let a flush failure prevent exit
    }
    process.exit(cliErr.exitCode);
  }
  runtime.logger.info("CLI command completed", {
    exitCode: result.exitCode,
    emittedAsJson: runtime.json,
    hasHumanOutput: result.human !== null,
  });
  if (runtime.json) {
    output.emitResult(result.data);
  } else if (result.human !== null && !runtime.quiet) {
    output.human(result.human);
  }
  process.exit(result.exitCode);
}
