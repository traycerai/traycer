import { open, readFile, stat } from "node:fs/promises";
import type { CommandFn, CommandResult } from "../runner/runner";
import { hostLogPath } from "../store/paths";

// `traycer host logs [--tail N] [--follow]` - surfaces the host
// log file the supervisor writes into. JSON mode emits the tail string
// as `result.data.tail`; human mode prints it directly so users get a
// `tail -f`-equivalent experience without leaving the CLI.
//
// `--follow` uses a stat-based polling loop instead of `fs.watch` so
// log rotation (file truncated to 0 bytes, file deleted-and-recreated)
// is handled cleanly across macOS / Linux / Windows. `fs.watch` doesn't
// reliably surface FSEvents truncation on macOS and races on the read
// offset under concurrent appends.
const POLL_INTERVAL_MS = 500;
const MAX_MISSING_FILE_RETRIES = 60; // ~30s at 500ms

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
    // suppresses every streamed line, since the raw `process.stdout.write`
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

// Stat-based tail follower. Wakes every POLL_INTERVAL_MS, compares the
// observed file size to the last offset we read, and emits any new
// bytes to stdout. Truncation (size shrank) resets the offset to 0 so
// the rotated file is re-read from the beginning; deletion enters a
// bounded retry loop waiting for the file to reappear. Uses
// `setTimeout`-recursive scheduling rather than `setInterval` to avoid
// drift if a read takes longer than the poll interval.
async function followLog(path: string, quiet: boolean): Promise<void> {
  let offset: number;
  try {
    offset = (await stat(path)).size;
  } catch {
    offset = 0;
  }
  let stopped = false;
  let missingRetries = 0;
  return new Promise<void>((resolve) => {
    // Keep a reference to the bound handler so we can deregister it on
    // resolve. `process.once` removes its own listener AFTER the signal
    // fires, but a clean `resolve()` (e.g. the bounded-retry path
    // calling cleanup itself) leaves both SIGINT/SIGTERM listeners
    // attached. That leak is invisible in a real CLI process (it exits
    // anyway) but accumulates in in-process test runners that invoke
    // followLog repeatedly across tests.
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      resolve();
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        // Open first, then size and read through the same handle, so the size
        // we act on is the file we read rather than re-resolving the path twice
        // (a TOCTOU window). Re-opening each tick also transparently follows a
        // rotation: the next open lands on whatever file now holds the path.
        const fh = await open(path, "r");
        try {
          const stats = await fh.stat();
          missingRetries = 0;
          if (stats.size < offset) {
            // Truncated / rotated: re-read from the top.
            offset = 0;
          }
          if (stats.size > offset) {
            const length = stats.size - offset;
            const buf = Buffer.alloc(length);
            const { bytesRead } = await fh.read(buf, 0, length, offset);
            if (bytesRead > 0) {
              // Advance the offset unconditionally so a later un-quieted
              // follow wouldn't re-emit these bytes; gate only the write
              // so `--quiet` mirrors `ctx.output.human`'s suppression.
              if (!quiet) {
                process.stdout.write(buf.subarray(0, bytesRead));
              }
              offset += bytesRead;
            }
          }
        } finally {
          await fh.close();
        }
      } catch {
        // ENOENT or transient: bounded retry then give up. Restart of
        // the host supervisor recreates the log file, so a short
        // gap during rotation is expected.
        missingRetries += 1;
        if (missingRetries > MAX_MISSING_FILE_RETRIES) {
          cleanup();
          return;
        }
        offset = 0;
      }
      if (!stopped) {
        setTimeout(() => {
          void tick();
        }, POLL_INTERVAL_MS);
      }
    };
    setTimeout(() => {
      void tick();
    }, POLL_INTERVAL_MS);
  });
}
