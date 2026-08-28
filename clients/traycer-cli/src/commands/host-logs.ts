import { readFile } from "node:fs/promises";
import type { CommandFn, CommandResult } from "../runner/runner";
import { hostLogPath } from "../store/paths";
import { writeStdoutBytes } from "../runner/std-write";
import {
  LOG_TAIL_MAX_MISSING_RETRIES,
  LOG_TAIL_POLL_INTERVAL_MS,
  startLogTail,
  type LogTail,
} from "../host/log-tail";

// `traycer host logs [--tail N] [--follow]` - surfaces the host
// log file the supervisor writes into. JSON mode emits the tail string
// as `result.data.tail`; human mode prints it directly so users get a
// `tail -f`-equivalent experience without leaving the CLI.
//
// `--follow` delegates the offset/rotation bookkeeping to `host/log-tail.ts` -
// see that module for why it polls rather than watches, and for the identity
// and continuity rules that stop a rotation swallowing the new file's prefix.
// This file owns only the signal handling that ends an interactive follow.

export interface HostLogsArgs {
  readonly follow: boolean;
  readonly tailLines: number;
}

export function buildHostLogsCommand(args: HostLogsArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const path = hostLogPath(ctx.runtime.environment);
    const tailContent = await readTail(path, args.tailLines);
    if (!args.follow) {
      // Route the tail through ctx.output.human so `--quiet` and JSON
      // mode are honored: in JSON mode the result envelope carries the
      // tail under `data.tail`; in human mode `output.human` writes to
      // stdout (no-op when `--quiet`). `output.human` appends its own
      // newline, so strip a trailing newline from the tail to avoid a
      // double blank line.
      if (tailContent.length > 0) {
        const normalized = tailContent.endsWith("\n")
          ? tailContent.slice(0, -1)
          : tailContent;
        ctx.output.human(normalized);
      }
      return {
        data: { path, tail: tailContent },
        human: null,
        exitCode: 0,
      };
    }
    // --follow: print the existing tail, then stream subsequent
    // appends. JSON mode does not stream - it emits a single result
    // with the snapshot tail and exits, since NDJSON consumers want a
    // terminal event.
    if (ctx.runtime.json) {
      return {
        data: {
          path,
          tail: tailContent,
          follow: false,
          reason: "json-mode-no-follow",
        },
        human: null,
        exitCode: 0,
      };
    }
    if (tailContent.length > 0) {
      const normalized = tailContent.endsWith("\n")
        ? tailContent.slice(0, -1)
        : tailContent;
      ctx.output.human(normalized);
    }
    // Thread `--quiet` into the streaming loop so it matches the
    // non-follow path and `output.ts` semantics: `--quiet --follow`
    // keeps the follower alive (offset tracking, rotation handling) but
    // suppresses every streamed line, since the raw `writeStdoutBytes`
    // below bypasses `ctx.output.human`'s quiet gate.
    await followLog(path, ctx.runtime.quiet);
    return {
      data: { path, tail: tailContent, follow: true },
      human: null,
      exitCode: 0,
    };
  };
}

async function readTail(path: string, lines: number): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return "";
  }
  const all = raw.split(/\r?\n/);
  const slice = all.slice(-lines);
  return slice.join("\n");
}

// Runs the shared tail until the user interrupts it (or the file stays gone
// long enough that the tail gives up on its own).
function followLog(path: string, quiet: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopped = false;
    // Keep a reference to the bound handler so we can deregister it on
    // resolve. `process.once` removes its own listener AFTER the signal
    // fires, but a clean `resolve()` (e.g. the tail exhausting its bounded
    // retries and calling cleanup itself) leaves both SIGINT/SIGTERM
    // listeners attached. That leak is invisible in a real CLI process (it
    // exits anyway) but accumulates in in-process test runners that invoke
    // followLog repeatedly across tests.
    //
    // `tail` is a mutable binding because it and its cleanup refer to each
    // other: `onExhausted` ends the follow, and ending the follow stops the
    // tail.
    let tail: LogTail | null = null;
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      tail?.stop();
      resolve();
    };
    tail = startLogTail({
      path,
      // The tail advances its offset regardless, so a later un-quieted follow
      // would not re-emit these bytes; only the write is gated, mirroring
      // `ctx.output.human`'s own `--quiet` suppression.
      onBytes: (chunk) => {
        if (!quiet) writeStdoutBytes(chunk);
      },
      onExhausted: cleanup,
      pollIntervalMs: LOG_TAIL_POLL_INTERVAL_MS,
      maxMissingRetries: LOG_TAIL_MAX_MISSING_RETRIES,
    });
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}
