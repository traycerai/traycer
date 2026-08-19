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
  /**
   * Monotonic count of DISCRETE UNITS OF WORK the producer has observed
   * complete within this stage - archive entries extracted, and nothing else so
   * far.
   *
   * ⚠ INCREMENTS ONLY WHEN A UNIT OF WORK HAS COMPLETED, AND NEVER ON A TIMER.
   * That prohibition is the field's entire content. A consumer uses it to tell
   * "this stage is advancing" from "this stage has gone quiet", so a producer
   * that ticked it on an interval would report a wedged install as healthy - the
   * exact defect this field exists to remove, reintroduced with the mechanism
   * meant to prevent it.
   *
   * `null` where the producer has no discrete unit to count, which is most
   * stages. A stage with a real measured position reports it through
   * `bytes`/`percent` instead; this is for work that advances in steps rather
   * than in bytes.
   */
  readonly workUnits: number | null;
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
  /**
   * Monotonic count of DISCRETE UNITS OF WORK the producer has observed
   * complete within this stage - archive entries extracted, and nothing else so
   * far.
   *
   * ⚠ INCREMENTS ONLY WHEN A UNIT OF WORK HAS COMPLETED, AND NEVER ON A TIMER.
   * That prohibition is the field's entire content. A consumer uses it to tell
   * "this stage is advancing" from "this stage has gone quiet", so a producer
   * that ticked it on an interval would report a wedged install as healthy - the
   * exact defect this field exists to remove, reintroduced with the mechanism
   * meant to prevent it.
   *
   * `null` where the producer has no discrete unit to count, which is most
   * stages. A stage with a real measured position reports it through
   * `bytes`/`percent` instead; this is for work that advances in steps rather
   * than in bytes.
   */
  readonly workUnits: number | null;
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

// Renders a single-line progress bar for a percent-bearing tick, e.g.
//   downloading host 1.5.0  ━━━━━━━━━━━━╹───────────   52%
// The caller rewrites this in place with a carriage return on a TTY.
//
// A THIN RAIL, and NO BYTE COUNT. Both are the same decision the GUI's boot
// card made: this bar is on screen while a user waits for Traycer to start,
// and "(5.2 MB / 10.0 MB)" there reads as "it began downloading something
// because I ran a command" - reported as alarming. The percentage says the
// same thing about the wait without naming a size. The byte figures stay on
// the wire (`ProgressEvent.bytes` / `totalBytes`, consumed by Desktop) and in
// the diagnostics that describe a FAILED transfer, where a size is the point.
//
// The rail replaces `[████░░░░]`: box-drawing weights rather than block shading, so
// the filled and empty halves differ by line weight instead of by fill
// density, and no brackets are needed to delimit something that already
// reads as one rail. Same Unicode neighbourhood as the blocks it replaces
// (U+2500 vs U+2580), so it asks nothing new of a terminal font.
const PROGRESS_BAR_WIDTH = 24;

// The leading edge, drawn when the fill lands past the middle of a cell:
// U+2578, the LEFT half of a heavy rail, so it continues the filled run and
// stops halfway rather than sitting beside it as a separate mark. It halves
// the rail's step - one cell of 24 is worth ~4.2%, this makes the smallest
// visible advance ~2.1% - which is what keeps a slow transfer looking like it
// is moving at all.
const PROGRESS_BAR_FILLED = "━";
const PROGRESS_BAR_HALF = "╸";
const PROGRESS_BAR_EMPTY = "─";

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
/**
 * The integer a human reads, from a position that need not be one.
 *
 * `ProgressInfo.percent` is a `number`: every producer in this repo happens to
 * `Math.round` its byte ratio, but that is each caller remembering, not a
 * property of the sink - and the rail's whole promise is that its figure
 * occupies a fixed three-column slot ("2.5%" is five characters and moves it).
 * Normalising HERE makes the promise the renderer's own.
 *
 * FLOOR, matching the rail's own fill: `Math.round(99.6)` would print 100%
 * beside a rail that is deliberately not full (see the half-cell rule), and a
 * label disagreeing with the bar it labels is worse than a rounded digit.
 */
function displayPercent(percent: number): string {
  return String(Math.floor(percent));
}

function renderProgressBar(
  info: ProgressInfo,
  dim: (s: string) => string,
): string {
  const percent = Math.max(0, Math.min(100, info.percent ?? 0));
  // FLOOR plus a half cell, never `Math.round` on the whole cell: rounding
  // draws a full cell for anything past its midpoint, so a bar reads as 4%
  // done at 2% and - at the other end - as complete two cells before it is.
  const exact = (percent / 100) * PROGRESS_BAR_WIDTH;
  const full = Math.floor(exact);
  const half = exact - full >= 0.5 && full < PROGRESS_BAR_WIDTH;
  const empty = PROGRESS_BAR_WIDTH - full - (half ? 1 : 0);
  // The rail is ALWAYS `PROGRESS_BAR_WIDTH` cells, so the percentage after it
  // never moves. `dim` is skipped on an empty run rather than wrapping "" -
  // a completed bar should not end in a stray pair of escape codes.
  const bar = `${PROGRESS_BAR_FILLED.repeat(full)}${half ? PROGRESS_BAR_HALF : ""}${
    empty === 0 ? "" : dim(PROGRESS_BAR_EMPTY.repeat(empty))
  }`;
  const label = info.message !== null ? `${info.message}  ` : "";
  // The number column is padded so a rail does not shuffle sideways as the
  // figure grows a digit, and it trails the rail (rather than leading it) so
  // the eye tracks one moving edge.
  return `${label}${bar}  ${displayPercent(percent).padStart(3)}%`;
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
          // FORWARDED, not nulled. This line used to drop the field, and
          // dropping it here disabled the whole mechanism on the ONLY
          // population it was written for: `workUnits` exists so Desktop can
          // tell an advancing extract from a wedged one, and Desktop runs this
          // CLI in JSON mode. Extraction reports no `percent` and no byte
          // position - an archive entry count is all it has - so with this
          // nulled every heartbeat serialized byte-identically, the host
          // controller's advance key never moved, and a healthy first install
          // was promoted to the Retry surface while it was actively
          // extracting. That is the exact symptom `fa9c6093` set out to fix;
          // the producer and the consumer both landed, and only the wire
          // between them kept saying `null`.
          workUnits: info.workUnits,
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
  // Dim on the rail's UNFILLED half only, so the two halves differ by weight
  // AND by intensity on a terminal that has colour, and by weight alone on
  // one that does not. Resolved once here, on the same gate `host-status`
  // uses (`NO_COLOR` plus a TTY) - read from `stderr`, which is where this
  // bar is written. The non-TTY path never renders a rail at all.
  const useColor = isTty && process.env.NO_COLOR === undefined;
  // `\x1b[0m` to close, matching `host-status`'s colorizer: nothing else on
  // this line is styled, so a full reset is the safer of the two closers.
  const dim = (text: string): string =>
    useColor ? `\x1b[2m${text}\x1b[0m` : text;
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
          writeStderr(`\r\x1b[2K${renderProgressBar(info, dim)}`);
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
          // Same normalisation as the rail's: a CI log line reading
          // "downloading host 1.5.0 52.34000000000001%" is the other half of
          // the same defect.
          writeStderrLine(
            `${info.message} ${displayPercent(Math.max(0, Math.min(100, info.percent)))}%`,
          );
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
          `\r\x1b[2K${renderProgressBar(
            {
              stage: info.stage,
              message: info.message ?? openBarInfo.message,
              percent: openBarInfo.percent,
              bytes: openBarInfo.bytes,
              totalBytes: openBarInfo.totalBytes,
              workUnits: null,
            },
            dim,
          )}`,
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
