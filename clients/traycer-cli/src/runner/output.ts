import type { CliErrorCode } from "./errors";
import type { RuntimeContext } from "./runtime";
import { writeStderr, writeStdout } from "./std-write";

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

// Synchronous by way of `std-write`: the runner `process.exit()`s the instant
// `emitResult` / `emitError` returns, so a buffered write here loses
// everything past the 64 KiB pipe buffer. See std-write.ts.
function writeStdoutLine(line: string): void {
  writeStdout(`${line}\n`);
}

function writeStderrLine(line: string): void {
  writeStderr(`${line}\n`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// Renders a single-line progress bar for a percent-bearing tick, e.g.
//   downloading host 1.5.0 [████████░░░░░░░░] 52% (5.2 MB / 10.0 MB)
// The caller rewrites this in place with a carriage return on a TTY.
const PROGRESS_BAR_WIDTH = 24;

// Percent-less liveness heartbeats for the archive transfer. The registry
// client publishes these as `registry-archive-<phase>` ticks (phases:
// attempt / watchdog / backoff - see `emitRegistryHeartbeat` in
// ../registry/client.ts) BETWEEN the byte-progress ticks of the same
// download: fetch-resource.ts opens every attempt with one, immediately
// before publishing the resume offset. While the download bar is on screen
// they are status updates on that bar, not stage transitions - rendering
// them down the discrete-line path finalized the live bar with a newline
// and the next byte tick started a NEW bar, stacking one frozen bar per
// retry. This predicate is what lets the renderer keep ONE bar per
// download and redraw it in place instead.
const ARCHIVE_HEARTBEAT_STAGE_PREFIX = "registry-archive-";
function isArchiveHeartbeatStage(stage: string): boolean {
  return stage.startsWith(ARCHIVE_HEARTBEAT_STAGE_PREFIX);
}
function renderProgressBar(info: ProgressInfo): string {
  const percent = Math.max(0, Math.min(100, info.percent ?? 0));
  const filled = Math.round((percent / 100) * PROGRESS_BAR_WIDTH);
  const bar = `${"█".repeat(filled)}${"░".repeat(PROGRESS_BAR_WIDTH - filled)}`;
  const bytes =
    info.bytes !== null && info.totalBytes !== null && info.totalBytes > 0
      ? ` (${formatBytes(info.bytes)} / ${formatBytes(info.totalBytes)})`
      : "";
  const label = info.message !== null ? `${info.message} ` : "";
  return `${label}[${bar}] ${String(percent).padStart(3)}%${bytes}`;
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
  // Human-mode progress rendering. Percent-bearing ticks (e.g. the host
  // download) update a single in-place bar on a TTY instead of printing one
  // line per chunk; on a non-TTY pipe (CI logs) we can't rewrite a line, so
  // we emit at most one line per 10% instead of thousands. `progressOpen`
  // tracks whether an in-place bar is currently on screen so the next
  // discrete line (or human text) terminates it with a newline first.
  const isTty = process.stderr.isTTY === true;
  let progressOpen = false;
  // The last percent-bearing tick rendered as the open TTY bar. An archive
  // liveness heartbeat borrows these numbers so its in-place redraw holds
  // the bar at the last real transfer values instead of rewinding to 0%.
  let openBarInfo: ProgressInfo | null = null;
  let lastDiscreteMessage: string | null = null;
  let lastNonTtyDecile = -1;
  const closeProgressLine = (): void => {
    if (progressOpen) {
      writeStderr("\n");
      progressOpen = false;
      openBarInfo = null;
    }
  };
  return {
    progress: (info) => {
      if (runtime.noProgress || runtime.quiet) return;
      if (info.percent !== null) {
        if (isTty) {
          // `\r` returns to column 0; `\x1b[2K` clears the line so a shorter
          // render can't leave stale characters from a longer previous one.
          writeStderr(`\r\x1b[2K${renderProgressBar(info)}`);
          progressOpen = true;
          openBarInfo = info;
          return;
        }
        const decile = Math.floor(
          Math.max(0, Math.min(100, info.percent)) / 10,
        );
        if (decile === lastNonTtyDecile) return;
        lastNonTtyDecile = decile;
        if (info.message !== null) {
          writeStderrLine(`${info.message} ${info.percent}%`);
        }
        return;
      }
      // Archive liveness heartbeat while the download bar is live: redraw
      // the SAME bar in place, with the heartbeat text as its label and the
      // last real transfer numbers - never the newline that would freeze
      // the bar on screen (that is exactly what stacked one frozen bar per
      // retry). `progressOpen` is only ever set on a TTY, so this path is
      // TTY-only by construction; without a live bar (attempt 1 fires
      // before any byte progress exists) the heartbeat falls through and
      // prints as an ordinary discrete line.
      if (
        progressOpen &&
        openBarInfo !== null &&
        isArchiveHeartbeatStage(info.stage)
      ) {
        writeStderr(
          `\r\x1b[2K${renderProgressBar({
            stage: info.stage,
            message: info.message ?? openBarInfo.message,
            percent: openBarInfo.percent,
            bytes: openBarInfo.bytes,
            totalBytes: openBarInfo.totalBytes,
          })}`,
        );
        return;
      }
      // Discrete (percent-less) stage line. Close any open bar, reset the
      // download trackers, and collapse repeats of the same message.
      closeProgressLine();
      lastNonTtyDecile = -1;
      if (info.message === null || info.message === lastDiscreteMessage) return;
      lastDiscreteMessage = info.message;
      writeStderrLine(info.message);
    },
    human: (text) => {
      if (runtime.quiet) return;
      closeProgressLine();
      lastDiscreteMessage = null;
      writeStdoutLine(text);
    },
    humanRequired: (text) => {
      closeProgressLine();
      lastDiscreteMessage = null;
      writeStdoutLine(text);
    },
    emitResult: () => {
      // Result events are NDJSON-only; human commands print their own
      // formatted output via `human` / `humanRequired`.
    },
    emitError: (code, message, _details) => {
      closeProgressLine();
      writeStderrLine(`error: ${message} [code=${code}]`);
    },
  };
}
