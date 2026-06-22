import type { CliErrorCode } from "./errors";
import type { RuntimeContext } from "./runtime";

// NDJSON envelope shapes per the Native Packaging tech plan. Every line
// on stdout in --json mode is one of these three discriminated by
// `type`. Terminal events use `type: "result"` and discriminate further
// on `status`.

export interface ProgressEvent {
  readonly type: "progress";
  readonly stage: string;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
  readonly message: string | null;
  readonly timestamp: string;
}

export interface ResultOkEvent {
  readonly type: "result";
  readonly status: "ok";
  readonly data: unknown;
  readonly timestamp: string;
}

export interface ResultErrorEvent {
  readonly type: "result";
  readonly status: "error";
  readonly error: {
    readonly code: CliErrorCode;
    readonly message: string;
    readonly details: Record<string, unknown> | null;
  };
  readonly timestamp: string;
}

export type RunnerEvent = ProgressEvent | ResultOkEvent | ResultErrorEvent;

// What a command body passes to ctx.progress / output.progress. The
// fields mirror ProgressEvent so the sink is a thin pass-through.
// Every field is required (no optional `?:` per project style); pass
// `null` for unknowns. `stage` is the only field a caller is required
// to populate with a meaningful value.
export interface ProgressInfo {
  readonly stage: string;
  readonly message: string | null;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
}

// Output sink the runner hands to each command. In JSON mode it writes
// NDJSON events to stdout; in human mode it writes free-form text. The
// command itself doesn't branch on `runtime.json` - it calls these
// methods and the sink decides what to do.
export interface Output {
  progress(info: ProgressInfo): void;
  // Free-form human text. No-op in JSON mode; goes to stdout otherwise
  // (unless --quiet, in which case it's also suppressed).
  human(text: string): void;
  // Free-form human text that should appear even with --quiet (e.g.
  // an "ok"/"done" confirmation the caller considers essential). Still
  // suppressed in JSON mode.
  humanRequired(text: string): void;
  // Emit the terminal `result` NDJSON event with status=ok. No-op in
  // human mode.
  emitResult(data: unknown): void;
  // Emit the terminal `result` NDJSON event with status=error. In
  // human mode this writes a single `error: <message> [code=<code>]`
  // line to stderr.
  emitError(
    code: CliErrorCode,
    message: string,
    details: Record<string, unknown> | null,
  ): void;
}

function now(): string {
  return new Date().toISOString();
}

function writeStdoutLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function createOutput(runtime: RuntimeContext): Output {
  if (runtime.json) {
    return {
      progress: (info) => {
        if (runtime.noProgress) return;
        const event: ProgressEvent = {
          type: "progress",
          stage: info.stage,
          percent: info.percent,
          bytes: info.bytes,
          totalBytes: info.totalBytes,
          message: info.message,
          timestamp: now(),
        };
        writeStdoutLine(JSON.stringify(event));
      },
      human: () => {
        // In JSON mode, free-form human text is dropped on the floor -
        // downstream parsers expect each stdout line to be JSON.
      },
      humanRequired: () => {
        // Same reasoning as `human` - emit `progress` / `result` events
        // instead if the information is load-bearing.
      },
      emitResult: (data) => {
        const event: ResultOkEvent = {
          type: "result",
          status: "ok",
          data,
          timestamp: now(),
        };
        writeStdoutLine(JSON.stringify(event));
      },
      emitError: (code, message, details) => {
        const event: ResultErrorEvent = {
          type: "result",
          status: "error",
          error: { code, message, details },
          timestamp: now(),
        };
        writeStdoutLine(JSON.stringify(event));
      },
    };
  }
  return {
    progress: (info) => {
      if (runtime.noProgress || runtime.quiet) return;
      if (info.message !== null) writeStderrLine(info.message);
    },
    human: (text) => {
      if (runtime.quiet) return;
      writeStdoutLine(text);
    },
    humanRequired: (text) => {
      writeStdoutLine(text);
    },
    emitResult: () => {
      // Result events are NDJSON-only; human commands print their own
      // formatted output via `human` / `humanRequired`.
    },
    emitError: (code, message, _details) => {
      writeStderrLine(`error: ${message} [code=${code}]`);
    },
  };
}
