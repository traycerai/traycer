import * as Sentry from "@sentry/node";
import { errorFromUnknown } from "../logger";
import { CLI_ERROR_CODES, toCliError } from "./errors";
import { finishAndExit, isProcessFatal } from "./exit";
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
// The runner owns process termination - callers should not exit themselves.
// It terminates through `finishAndExit`, which records the code on
// `process.exitCode` and lets the loop end rather than calling
// `process.exit()`; see exit.ts for the win32 teardown abort that motivates it.
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
    // The error envelope was just written to a possibly-piped stdout, and the
    // Sentry client is still live. `finishAndExit` flushes the first and shuts
    // down the second before letting the loop end - see exit.ts for why the
    // process no longer tears itself down here.
    await finishAndExit(cliErr.exitCode);
    return;
  }
  // A process-fatal handler (unhandled rejection / uncaught exception) may
  // have fired WHILE this command was running. Draining is what makes that
  // survivable - the command keeps going and can still return a result - but
  // the process has already failed, and Desktop now trusts a terminal `ok`
  // over a non-zero exit. Emitting success here would report a failed
  // install/update/ensure as successful, so report what actually happened.
  if (isProcessFatal()) {
    runtime.logger.error(
      "CLI command completed after a process-fatal failure",
      { commandExitCode: result.exitCode, emittedAsJson: runtime.json },
      // The originating error was already captured and logged by the fatal
      // handler; this record is about the result being suppressed.
      null,
    );
    output.emitError(
      CLI_ERROR_CODES.UNEXPECTED,
      "the CLI process failed while this command was running",
      { commandExitCode: result.exitCode },
    );
    await finishAndExit(1);
    return;
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
  // Terminal `result` line just went out. `finishAndExit` still flushes it
  // first - that is the flush the `host available --include-pre-releases`
  // truncation turned on, and it is unrelated to the teardown abort the rest
  // of that helper addresses. See std-write.ts and exit.ts.
  await finishAndExit(result.exitCode);
}
