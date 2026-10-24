/**
 * Crash diagnostics for the host supervisor (`traycer host start`).
 *
 * A hard host abort (e.g. Windows 0xC0000409 fail-fast, POSIX SIGABRT) used
 * to leave exactly one line of evidence: `phase=crashed code=3221226505` (or
 * a bare `phase=killed signal=SIGABRT`). Three mechanisms in this module
 * close that gap:
 *
 * - a byte-bounded head+tail stderr capture, embedded in the crash marker.
 *   V8 writes `FATAL ERROR: ...` to stderr before aborting, but a fatal
 *   block can run several KB and the headline sits near its START (measured:
 *   a heap-OOM block of ~6.5KB with `FATAL ERROR` at byte ~476, followed by
 *   native frames) - a tail-only window provably loses the reason. The
 *   fd-teed copy in `host.log` can also be stranded in `host.log.1` when the
 *   host's own logger rotates the file under the supervisor's inode-bound
 *   fd; the capture is re-emitted by path at exit time, so it survives that
 *   race by construction.
 * - Node diagnostic reports: `--report-on-fatalerror` with a RELATIVE
 *   `--report-directory=crash-reports` (resolved against the spawn cwd, the
 *   host data dir - relative on purpose, so a Windows profile path with
 *   spaces never needs NODE_OPTIONS quoting, and so a crash BEFORE the
 *   host's own runtime arming still lands in the scanned directory). The
 *   newest report younger than the child is referenced from the crash
 *   marker; the directory is created and pruned at supervisor start.
 * - Exit-status decoding: `code=3221226505` means nothing at a glance;
 *   `0xC0000409 STATUS_STACK_BUFFER_OVERRUN` does. Fatal POSIX signals get
 *   the same treatment (`SIGABRT` = abort, not a shutdown).
 */
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "../runner/environment";
import { bootstrapLogPath } from "../store/paths";

/**
 * Byte caps for the stderr capture: the FIRST head bytes (where a V8 fatal
 * block's headline lives) plus the rolling LAST tail bytes (where a native
 * abort's final frames live). Middle bytes beyond both windows are elided.
 */
export const STDERR_HEAD_MAX_BYTES = 2048;
export const STDERR_TAIL_MAX_BYTES = 2048;

/**
 * Byte cap for the FATAL-anchored window. Head+tail alone is not enough: the
 * head is process-lifetime, so a host that emitted a few KB of ordinary
 * stderr before dying evicts the fatal headline into the elided middle
 * (measured: ~3KB of prior warnings + a 6.5KB OOM block left neither "FATAL
 * ERROR" nor the heap stats in a 4KB head+tail capture). Detecting the
 * headline and latching a window FROM it guarantees the reason survives no
 * matter what came before.
 */
export const STDERR_FATAL_WINDOW_MAX_BYTES = 2048;

/**
 * Substrings that open the fatal window. V8 heap exhaustion prints
 * `FATAL ERROR: ...`; V8/native assertion fatals print `# Fatal error in ...`.
 */
const FATAL_NEEDLES = ["FATAL ERROR", "# Fatal error"] as const;

/**
 * The closed set of fatal kinds a stderr capture can be sorted into, the only
 * thing about the capture that leaves the machine (as the crash event's
 * `host_fatal` tag). Never the text, a path or a number read from it.
 *
 * - `v8-heap-oom`: a `FATAL ERROR:` line naming heap exhaustion. Node's
 *   `OOMErrorHandler` (src/node_errors.cc) prints
 *   `FATAL ERROR: <location> Allocation failed - JavaScript heap out of
 *   memory` when V8 reports `is_heap_oom`, where `<location>` is V8's own
 *   (`Reached heap limit`, `Ineffective mark-compacts near heap limit`,
 *   `CALL_AND_RETRY_LAST`, ...).
 * - `v8-fatal`: any other `FATAL ERROR:` line (`OnFatalError`: a failed
 *   `ToLocalChecked`, a native addon's `napi_fatal_error`, and
 *   `Allocation failed - process out of memory`, the non-heap OOM).
 * - `check-failed`: a `# Fatal error in ...` block, V8's own CHECK/FATAL
 *   output (`V8_Fatal`).
 * - `assertion`: a native assertion line, MSVC CRT / libuv on Windows
 *   (`Assertion failed: <expr>, file src\win\..., line N`) or the glibc and
 *   Node `CHECK` form (``Assertion `<expr>' failed.``).
 * - `none`: the child wrote nothing to stderr.
 * - `incomplete`: nothing recognised and the stderr stream had not ended when
 *   the capture was read, so bytes may still have been unread.
 * - `other`: it wrote, and nothing matched.
 */
export const STDERR_FATAL_KINDS = [
  "v8-heap-oom",
  "v8-fatal",
  "check-failed",
  "assertion",
  "none",
  "incomplete",
  "other",
] as const;

export type StderrFatalKind = (typeof STDERR_FATAL_KINDS)[number];

/** Heap-exhaustion wording in a `FATAL ERROR:` line (V8 and Node's own). */
const HEAP_OOM_LINE = /heap out of memory|heap limit/;

/**
 * Node `CHECK` (`  #  Assertion failed: <expr>`), and the MSVC CRT / libuv on
 * Windows and macOS `assert` (`Assertion failed: <expr>, [function f, ]file
 * <path>, line N`). Never the bare phrase: `console.assert` writes
 * `Assertion failed: <msg>` to stderr too, and so can any log line.
 */
const ASSERTION_FAILED_FORM =
  /^[ \t]*#[ \t]*Assertion failed:|Assertion failed: [^\n]{0,512}, file [^\n]{1,512}, line \d+/m;
/** glibc `assert` and Node's `CHECK`: ``Assertion `expr' failed.``. */
const ASSERTION_QUOTED_FORM = /Assertion `[^\n]{0,512}' failed\./;

/** Carried across chunk boundaries so a split needle is still detected. */
const FATAL_BOUNDARY_CHARS = 16;

/**
 * Final clamp on the escaped, single-line marker payload. Escaping can
 * expand bytes (`\n` -> `\\n`, invalid UTF-8 -> replacement chars), so the
 * clamp is applied AFTER escaping to bound the marker line's length.
 */
export const STDERR_MARKER_MAX_CHARS = 4096;

/**
 * Upper bound on stderr bytes queued for the path-addressed log tee. A
 * stderr-spamming host must not grow supervisor memory without bound; the
 * head+tail capture still records the interesting bytes, the tee just stops
 * mirroring the flood into `host.log`.
 */
export const STDERR_TEE_MAX_PENDING_BYTES = 256 * 1024;

/** Diagnostic reports kept in `crash-reports/`; older ones are pruned. */
export const MAX_KEPT_CRASH_REPORTS = 5;

/**
 * Slack subtracted from the child spawn timestamp when scanning for a
 * diagnostic report: a loader-phase crash can write its report in the same
 * millisecond bucket as (or, across filesystems' mtime granularity, apparently
 * before) the recorded spawn time.
 */
export const CRASH_REPORT_SPAWN_SLACK_MS = 2_000;

// The post-mortem budgets - the crash-report scan, the stderr flush and the
// wait for the child's stderr to end - live in `service/spawn-edge-bounds.ts`:
// they are terms of the systemd stop bound, which must be derived in a module
// that can never sit on an import cycle.

/** Clamp for the one-line report digest embedded in logs/markers. */
export const REPORT_SUMMARY_MAX_CHARS = 512;

/**
 * Windows exit statuses worth naming. Keyed by the unsigned NTSTATUS value
 * (Node reports them as positive decimals, e.g. 3221226505). Codes below
 * 0x40000000 are ordinary exit codes and are not decoded.
 *
 * The 0xC0000409 text points at the {@link FATAL_NEEDLES} signature rather
 * than at "stderr was empty". Emptiness is the wrong test in both directions:
 * a native module or the CRT can print an unrelated warning before it
 * fail-fasts, and the decoder only ever receives the numeric code - it cannot
 * read the capture at all. What it can do is tell the reader which evidence
 * decides it, since V8 prints its fatal block BEFORE aborting and a native
 * fail-fast writes nothing on the way out.
 */
const WINDOWS_EXIT_MEANINGS: ReadonlyMap<number, string> = new Map([
  [
    0xc0000409,
    "STATUS_STACK_BUFFER_OVERRUN (fail-fast abort: look for a FATAL ERROR / # Fatal error block in the stderr capture - V8 prints one before aborting, so a capture without it points at a native module or CRT abort)",
  ],
  [0xc0000005, "STATUS_ACCESS_VIOLATION (native crash)"],
  [0xc0000142, "STATUS_DLL_INIT_FAILED (spawn during session shutdown)"],
  [
    0x40010004,
    "DBG_TERMINATE_PROCESS (terminated from outside, most often the session ending)",
  ],
  [
    0xc000026b,
    "STATUS_DLL_INIT_FAILED_LOGOFF (spawn during logoff or shutdown)",
  ],
  [0xc00000fd, "STATUS_STACK_OVERFLOW"],
]);

/**
 * The Windows exit status that is a session ending by its own name: a relaunch
 * attempted while the window station is closing
 * (`STATUS_DLL_INIT_FAILED_LOGOFF`). Not a defect of the host, and not
 * reported as a crash.
 */
const WINDOWS_SESSION_END_EXIT_CODES: ReadonlySet<number> = new Set([
  0xc000026b,
]);

/** Whether a Windows exit status is the session ending rather than a crash. */
export function isWindowsSessionEndExit(code: number): boolean {
  return WINDOWS_SESSION_END_EXIT_CODES.has(code >>> 0);
}

/**
 * `DBG_TERMINATE_PROCESS`: the child was ended from outside. Most often the
 * user's session ending, but any caller of `TerminateProcess` (a security
 * product, a debugger, another tool) leaves it, so it is not a crash and not
 * proven to be a session end either: it is reported at a lower severity under
 * its own fingerprint (see `buildHostCrashEvent`).
 */
export function isWindowsExternalTerminationExit(code: number): boolean {
  return code >>> 0 === 0x40010004;
}

/**
 * POSIX signals that mean the host CRASHED rather than being shut down. A
 * Node fatal abort surfaces on macOS/Linux as `code=null, signal=SIGABRT` -
 * routing these through the plain "killed" path would discard the report and
 * stderr evidence exactly where it matters most. Forwarded shutdown signals
 * (SIGTERM/SIGINT/SIGHUP) are NOT here.
 */
const FATAL_SIGNAL_MEANINGS: ReadonlyMap<string, string> = new Map([
  ["SIGABRT", "abort (V8 fatal/OOM, assertion, or native abort)"],
  ["SIGSEGV", "segmentation fault (native crash)"],
  ["SIGBUS", "bus error (native crash)"],
  ["SIGILL", "illegal instruction (native crash)"],
  ["SIGFPE", "arithmetic fault (native crash)"],
  ["SIGTRAP", "trap (native crash)"],
]);

export function isFatalSignal(signal: string | null | undefined): boolean {
  return signal !== null && signal !== undefined
    ? FATAL_SIGNAL_MEANINGS.has(signal)
    : false;
}

/** `"SIGABRT abort (V8 fatal/OOM, ...)"` for fatal signals, else `null`. */
export function describeFatalSignal(signal: string): string | null {
  const meaning = FATAL_SIGNAL_MEANINGS.get(signal);
  return meaning === undefined ? null : `${signal} ${meaning}`;
}

/**
 * Renders a high-bit exit code as hex plus a known NTSTATUS name, or `null`
 * for ordinary small exit codes (those stay as the bare `code=` field).
 */
export function describeExitCode(code: number): string | null {
  const unsigned = code >>> 0;
  if (unsigned < 0x40000000) {
    return null;
  }
  const hex = `0x${unsigned.toString(16).toUpperCase()}`;
  const name = WINDOWS_EXIT_MEANINGS.get(unsigned);
  return name === undefined ? hex : `${hex} ${name}`;
}

/**
 * Head+tail capture over stderr chunks: the FIRST `maxHeadBytes` seen plus a
 * rolling window of the LAST `maxTailBytes`. See the module header for why
 * tail-only capture loses the V8 fatal headline.
 */
export class StderrCaptureBuffer {
  private readonly headChunks: Buffer[] = [];
  private headBytes = 0;
  private readonly tailChunks: Buffer[] = [];
  private tailBytes = 0;
  private elidedBytes = 0;
  /**
   * FATAL-anchored window, accumulated as TEXT and anchored at the needle
   * itself - not at the chunk that happened to contain it. Anchoring at the
   * chunk drops any of the needle that arrived in the previous chunk (a
   * `FATAL ER`/`ROR: ...` split yields a window opening mid-word, losing the
   * headline the window exists to preserve), and would also carry whatever
   * unrelated output shared that chunk. `null` until a needle is seen; grows
   * to {@link STDERR_FATAL_WINDOW_MAX_BYTES} characters.
   */
  private fatalText: string | null = null;
  private detectionBoundary = "";

  constructor(
    private readonly maxHeadBytes: number,
    private readonly maxTailBytes: number,
  ) {}

  append(chunk: Buffer): void {
    this.captureFatalWindow(chunk);
    if (this.headBytes < this.maxHeadBytes) {
      const take = Math.min(chunk.length, this.maxHeadBytes - this.headBytes);
      this.headChunks.push(chunk.subarray(0, take));
      this.headBytes += take;
      chunk = chunk.subarray(take);
      if (chunk.length === 0) {
        return;
      }
    }
    this.tailChunks.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.maxTailBytes) {
      const head = this.tailChunks[0];
      if (head === undefined) {
        break;
      }
      const excess = this.tailBytes - this.maxTailBytes;
      if (head.length <= excess) {
        this.tailChunks.shift();
        this.tailBytes -= head.length;
        this.elidedBytes += head.length;
      } else {
        this.tailChunks[0] = head.subarray(excess);
        this.tailBytes -= excess;
        this.elidedBytes += excess;
      }
    }
  }

  private captureFatalWindow(chunk: Buffer): void {
    if (this.fatalText !== null) {
      if (this.fatalText.length < STDERR_FATAL_WINDOW_MAX_BYTES) {
        this.fatalText = (this.fatalText + chunk.toString("utf8")).slice(
          0,
          STDERR_FATAL_WINDOW_MAX_BYTES,
        );
      }
      return;
    }
    // The boundary carry is what lets a needle split across chunks be
    // detected AND anchored whole: the window opens at the needle's index in
    // `boundary + chunk`, so the carried first half is part of the window.
    const text = this.detectionBoundary + chunk.toString("utf8");
    let earliest = -1;
    for (const needle of FATAL_NEEDLES) {
      const index = text.indexOf(needle);
      if (index !== -1 && (earliest === -1 || index < earliest)) {
        earliest = index;
      }
    }
    if (earliest !== -1) {
      this.fatalText = text.slice(
        earliest,
        earliest + STDERR_FATAL_WINDOW_MAX_BYTES,
      );
      return;
    }
    this.detectionBoundary = text.slice(-FATAL_BOUNDARY_CHARS);
  }

  isEmpty(): boolean {
    return this.headBytes === 0 && this.tailBytes === 0;
  }

  /**
   * Which kind of fatal the capture holds (see {@link StderrFatalKind}).
   * Reads only what is already held: the FATAL-anchored window decides the
   * `FATAL ERROR` and `# Fatal error` kinds from its first line, so a heap
   * OOM block that arrived after kilobytes of earlier stderr is still seen;
   * an assertion is looked for in the head and the tail, where its line
   * lands. Bounded by the capture's own byte caps and never throws.
   *
   * `streamEnded` is whether the child's stderr had ended when the capture
   * was read; a capture with nothing recognised that was read early is
   * `incomplete`, not `none` or `other`.
   */
  classifyFatal(streamEnded: boolean): StderrFatalKind {
    try {
      if (this.fatalText !== null) {
        const newline = this.fatalText.indexOf("\n");
        const firstLine =
          newline === -1 ? this.fatalText : this.fatalText.slice(0, newline);
        if (firstLine.startsWith("# Fatal error")) return "check-failed";
        return HEAP_OOM_LINE.test(firstLine) ? "v8-heap-oom" : "v8-fatal";
      }
      if (this.isEmpty()) {
        return streamEnded ? "none" : "incomplete";
      }
      const held =
        Buffer.concat(this.headChunks).toString("utf8") +
        // Contiguous unless the middle was dropped; a separator inside an
        // unbroken stream would split a line across the head/tail boundary.
        (this.elidedBytes > 0 ? "\n" : "") +
        Buffer.concat(this.tailChunks).toString("utf8");
      if (
        ASSERTION_FAILED_FORM.test(held) ||
        ASSERTION_QUOTED_FORM.test(held)
      ) {
        return "assertion";
      }
      return streamEnded ? "other" : "incomplete";
    } catch {
      return "other";
    }
  }

  /**
   * Normalizes arbitrary text to the single-line marker grammar: escapes
   * every JS line terminator, strips remaining control characters, clamps.
   * Exposed as a static because report summaries need the identical
   * treatment - a `javascriptStack.message` carrying a newline would
   * otherwise break the same single-line contract this class exists to
   * protect for stderr.
   */
  static toSingleLine(text: string, maxChars: number): string {
    const escaped = escapeToSingleLine(text);
    return escaped.length <= maxChars
      ? escaped
      : `${escaped.slice(0, maxChars - 1)}…`;
  }

  /**
   * Single-line, marker-grammar-safe rendering: head, an elision mark when
   * middle bytes were dropped, then the tail. EVERY JS line terminator is
   * escaped (the marker parser scans one line, and U+2028/U+2029 are line
   * terminators the `.`-based line regex will not cross - an unescaped one
   * silently discards the whole marker); remaining C0 control bytes are
   * stripped; the result is clamped after escaping.
   */
  escapedForMarker(): string {
    const headText = Buffer.concat(this.headChunks).toString("utf8");
    const tailText = Buffer.concat(this.tailChunks).toString("utf8");
    // Precedence: a detected fatal window IS the evidence - render it alone
    // when it never filled (it then runs to end-of-stream, so the tail is a
    // strict subset), or fatal+tail when it capped out (the frames between
    // cap and tail are elided). Otherwise head+tail as the generic shape.
    let joined: string;
    if (this.fatalText !== null) {
      joined =
        this.fatalText.length < STDERR_FATAL_WINDOW_MAX_BYTES
          ? this.fatalText
          : `${this.fatalText}\n[... trailing bytes ...]\n${tailText}`;
    } else {
      joined =
        this.elidedBytes > 0
          ? `${headText}\n[... ${this.elidedBytes} bytes elided ...]\n${tailText}`
          : `${headText}${tailText}`;
    }
    return StderrCaptureBuffer.toSingleLine(joined, STDERR_MARKER_MAX_CHARS);
  }
}

/**
 * Escapes every JS line terminator and strips remaining control characters.
 * Shared by the stderr capture and the report summary: both end up on a
 * single `key=value` marker line, and the parser's `.`-based line regex will
 * not cross U+2028/U+2029 - an unescaped one silently discards the WHOLE
 * marker. Tab survives; the marker quoting handles ordinary whitespace.
 */
function escapeToSingleLine(text: string): string {
  const newlinesEscaped = text
    .replace(/\r/g, "")
    .replace(/[\n\u2028\u2029]/g, "\\n");
  // By code point rather than a regex range: a control-character range would
  // trip no-control-regex, and this states the same rule plainly.
  let escaped = "";
  for (const ch of newlinesEscaped) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 || code === 0x09) {
      escaped += ch;
    }
  }
  return escaped;
}

/**
 * Structural surface of the stderr tee that `runHostStart` consumes.
 * `RunHostStartDeps` is typed with THIS, not the concrete class: naming the
 * class drags its private fields into the dependency type, which forced test
 * doubles through an `as unknown` chain the repo's type rules ban. A method
 * added here later breaks a stub at compile time instead of at runtime.
 */
export interface StderrTee {
  readonly capture: StderrCaptureBuffer;
  append(chunk: Buffer): void;
  teeDroppedBytes(): number;
  flush(timeoutMs: number): Promise<void>;
}

/**
 * Bounded, serialized, PATH-addressed tee of stderr bytes into `host.log`,
 * plus the head+tail capture above. By path on purpose: the host's own
 * logger rotates `host.log` by rename, and a held-open fd follows the old
 * inode. Queue growth is capped ({@link STDERR_TEE_MAX_PENDING_BYTES}) so a
 * stderr-spamming child cannot grow supervisor memory without bound, and
 * {@link flush} lets the exit path drain queued writes (bounded) before the
 * terminal marker - `process.exit` would otherwise abandon them. Failures
 * are swallowed: a diagnostics write must never take the supervisor down.
 */
export class StderrLogTee implements StderrTee {
  readonly capture = new StderrCaptureBuffer(
    STDERR_HEAD_MAX_BYTES,
    STDERR_TAIL_MAX_BYTES,
  );
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly environment: Environment) {}

  append(chunk: Buffer): void {
    this.capture.append(chunk);
    if (this.pendingBytes + chunk.length > STDERR_TEE_MAX_PENDING_BYTES) {
      this.droppedBytes += chunk.length;
      return;
    }
    this.pendingBytes += chunk.length;
    const settle = (): void => {
      this.pendingBytes -= chunk.length;
    };
    this.queue = this.queue
      .then(() => appendFile(bootstrapLogPath(this.environment), chunk))
      .then(settle, settle);
  }

  /** Bytes skipped by the log tee (never by the capture); diagnostics only. */
  teeDroppedBytes(): number {
    return this.droppedBytes;
  }

  /** Resolves when queued writes have drained, or after `timeoutMs`. */
  flush(timeoutMs: number): Promise<void> {
    return Promise.race([
      this.queue.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
}

/** `<childCwd>/crash-reports` - the directory the relative report flag targets. */
export function crashReportsDirFor(childCwd: string): string {
  return join(childCwd, "crash-reports");
}

/**
 * Creates the crash-reports directory (so a report has a destination even
 * before the host's own runtime arming runs), prunes it to the newest `keep`
 * reports, and returns the names that SURVIVED the prune. The caller records
 * those as pre-existing so the post-exit scan can never attribute a previous
 * child's report to this crash (a crash-looping host can die within the
 * mtime slack of its successor's spawn). Never throws.
 */
export async function prepareCrashReportsDir(
  dir: string,
  keep: number,
): Promise<readonly string[]> {
  try {
    // 0700: a Node diagnostic report embeds `environmentVariables`, and the
    // host child inherits `process.env` plus the Traycer env overrides - so a
    // fatal crash writes the operator's secrets to disk. Under a default
    // umask the directory would be world-readable and every local user on the
    // machine could read them. Mode is applied to the leaf only; an existing
    // directory keeps its mode (chmod-ing a path the operator may have
    // deliberately relaxed is not this function's call).
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Unwritable data dir: the spawn will surface real failures; a missing
    // report destination must not block the host from starting.
  }
  await pruneCrashReports(dir, keep);
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Keeps the newest `keep` diagnostic reports and unlinks the rest. Never
 * throws - a missing directory (no crash yet) is the normal case.
 */
export async function pruneCrashReports(
  dir: string,
  keep: number,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const stamped: Array<{ readonly name: string; readonly mtimeMs: number }> =
    [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const info = await stat(join(dir, name));
      stamped.push({ name, mtimeMs: info.mtimeMs });
    } catch {
      // Raced a concurrent unlink; nothing to keep.
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of stamped.slice(keep)) {
    try {
      await unlink(join(dir, item.name));
    } catch {
      // Best-effort.
    }
  }
}

/**
 * The three numbers a heap-exhaustion report states, in bytes: the V8 heap
 * limit, the heap in use and the resident set. A value the report does not
 * carry, or carries as anything but a non-negative whole number, is `null`.
 */
export interface CrashReportMemory {
  readonly heapLimitBytes: number | null;
  readonly heapUsedBytes: number | null;
  readonly rssBytes: number | null;
}

const NO_REPORT_MEMORY: CrashReportMemory = {
  heapLimitBytes: null,
  heapUsedBytes: null,
  rssBytes: null,
};

export interface CrashReportMatch {
  readonly filename: string;
  /**
   * One-line digest of the report (`event`, `trigger`, first JS stack
   * frame), or `null` when the JSON could not be read - the filename alone
   * still tells support where to look.
   */
  readonly summary: string | null;
  /** The report's memory numbers; every field `null` when unreadable. */
  readonly memory: CrashReportMemory;
}

/**
 * Newest diagnostic report written at or after `sinceMs`, excluding names
 * that pre-existed this child's spawn, or `null`. Callers pass the child
 * spawn time minus {@link CRASH_REPORT_SPAWN_SLACK_MS}; the exclusion set
 * (from {@link prepareCrashReportsDir}) is what makes the slack safe - a
 * stale report attributed to this crash would be worse than none.
 */
export async function findCrashReportSince(
  dir: string,
  sinceMs: number,
  excludeNames: ReadonlySet<string>,
): Promise<CrashReportMatch | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (excludeNames.has(name)) continue;
    try {
      const info = await stat(join(dir, name));
      if (info.mtimeMs < sinceMs) continue;
      if (newest === null || info.mtimeMs > newest.mtimeMs) {
        newest = { name, mtimeMs: info.mtimeMs };
      }
    } catch {
      // Raced a prune.
    }
  }
  if (newest === null) {
    return null;
  }
  const read = await summarizeReport(join(dir, newest.name));
  return { filename: newest.name, summary: read.summary, memory: read.memory };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asByteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * `resourceUsage.rss` and `maxRss` as a byte count. Node's documentation shows
 * them as quoted decimal strings (`"rss": "35766272"`) while the Node the host
 * runs writes numbers, so both are read. A string must be plain decimal
 * digits that fit a safe integer: no sign, space, fraction or exponent.
 */
function asResidentBytes(value: unknown): number | null {
  if (typeof value === "string") {
    if (!/^[0-9]+$/.test(value)) return null;
    return asByteCount(Number(value));
  }
  return asByteCount(value);
}

interface ReportReading {
  readonly summary: string | null;
  readonly memory: CrashReportMemory;
}

async function summarizeReport(path: string): Promise<ReportReading> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(path, "utf8")));
    const header = asRecord(parsed?.["header"]);
    const event = asString(header?.["event"]);
    const trigger = asString(header?.["trigger"]);
    const stackRecord = asRecord(parsed?.["javascriptStack"]);
    const message = asString(stackRecord?.["message"]);
    const heap = asRecord(parsed?.["javascriptHeap"]);
    const usage = asRecord(parsed?.["resourceUsage"]);
    const memory: CrashReportMemory = {
      heapLimitBytes: asByteCount(heap?.["memoryLimit"]),
      heapUsedBytes: asByteCount(heap?.["usedMemory"]),
      // `rss` is the figure at the report; `maxRss` is the peak, the answer
      // only when the report has no current reading.
      rssBytes:
        asResidentBytes(usage?.["rss"]) ?? asResidentBytes(usage?.["maxRss"]),
    };
    const parts: string[] = [];
    if (event !== null) parts.push(`event=${event}`);
    if (trigger !== null) parts.push(`trigger=${trigger}`);
    // Before the stack message, which is clamped from the end: a long message
    // must never be what cuts the numbers off.
    if (memory.heapLimitBytes !== null) {
      parts.push(`heapLimitBytes=${memory.heapLimitBytes}`);
    }
    if (memory.heapUsedBytes !== null) {
      parts.push(`heapUsedBytes=${memory.heapUsedBytes}`);
    }
    if (memory.rssBytes !== null) parts.push(`rssBytes=${memory.rssBytes}`);
    if (message !== null) parts.push(`js=${message}`);
    if (parts.length === 0) {
      return { summary: null, memory };
    }
    // ENFORCED, not just documented: these values come verbatim out of the
    // report JSON, and a `javascriptStack.message` carrying a line
    // terminator would break the one-line contract this digest promises -
    // the same hazard `escapedForMarker` exists to prevent for stderr, and
    // `persistChildExit` already passes this straight into a log line.
    return {
      summary: StderrCaptureBuffer.toSingleLine(
        parts.join(" "),
        REPORT_SUMMARY_MAX_CHARS,
      ),
      memory,
    };
  } catch {
    return { summary: null, memory: NO_REPORT_MEMORY };
  }
}
