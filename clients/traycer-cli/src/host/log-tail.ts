import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

// `tail -f` over a file OTHER processes append to, shared by the two callers
// that need it: `host logs --follow` and the foreground `host start` mirror.
//
// One definition because the two would otherwise have to agree, byte for byte,
// on the rotation rule that makes this correct. A stat-based poll rather than
// `fs.watch`: `fs.watch` does not reliably surface FSEvents truncation on
// macOS and races on the read offset under concurrent appends, and the host
// log is rotated (renamed aside, recreated) by `rotateHostLogIfOversized`
// while a follower is attached.
//
// The file is re-opened every tick rather than held: that is what makes a
// rotation transparent (the next open lands on whatever file now holds the
// path) and closes the TOCTOU window between "stat the path" and "read the
// handle".
export const LOG_TAIL_POLL_INTERVAL_MS = 500;
/** ~30s at the default poll interval. */
export const LOG_TAIL_MAX_MISSING_RETRIES = 60;

// Bound for the single synchronous catch-up read `drainSync` performs on the
// way out. The whole point of that path is that it costs a bounded, known
// amount of work on an exit that is otherwise synchronous, so it reads a tail
// rather than an arbitrarily large backlog.
const MAX_SYNC_DRAIN_BYTES = 256 * 1024;

// Bound for ONE poll's read. `host.log` is unbounded within a host's lifetime
// (nothing truncates it; rotation only happens at a start), so a follower that
// allocated `size - offset` in one go would size a buffer off a file another
// process controls. A supervisor that is mirroring for weeks, or one that
// resumes after any gap, could allocate gigabytes. Reading a capped slice per
// tick loses nothing: the offset advances by what was read and the next tick
// (500ms later) takes the next slice.
const MAX_TICK_READ_BYTES = 1024 * 1024;

export interface LogTailOptions {
  readonly path: string;
  /**
   * Sink for newly appended bytes. Called OUTSIDE the file I/O try/catch, so a
   * throwing sink can never be mistaken for a missing file and rewind the
   * offset to zero (which would replay the whole log).
   */
  onBytes(chunk: Buffer): void;
  /** The file stayed unreadable past `maxMissingRetries`; the tail has stopped. */
  onExhausted(): void;
  /**
   * `drainSync` had more pending than it is allowed to read in one go and
   * skipped `bytes` to reach the tail. Reported rather than swallowed: output
   * with a silent hole in it is worse than output that says where the hole is.
   */
  onSkipped(bytes: number): void;
  readonly pollIntervalMs: number;
  readonly maxMissingRetries: number;
}

export interface LogTail {
  /** Stop polling. Idempotent; never emits again afterwards. */
  stop(): void;
  /**
   * Emit anything appended since the last poll, SYNCHRONOUSLY.
   *
   * For callers that end the process with a bare `process.exit` and would
   * otherwise drop up to one poll interval of output - notably the host
   * supervisor, whose exit is deliberately synchronous (see runner/exit.ts).
   * Best-effort: any I/O failure is swallowed, because a drain on the way out
   * must never be the reason a process fails to exit.
   */
  drainSync(): void;
}

/**
 * Follow `path` from its CURRENT end, so a follower never replays history it
 * was not asked for. Callers that want the existing tail print it themselves
 * first (`host logs`) or deliberately do not (`host start`).
 */
export function startLogTail(options: LogTailOptions): LogTail {
  let offset = initialOffset(options.path);
  let stopped = false;
  let missingRetries = 0;
  let timer: NodeJS.Timeout | null = null;
  // Identity of the file the current `offset` counts bytes in. Size alone
  // cannot answer "same file or a replacement?": a follower that consumed N
  // bytes, missed the file during a rotation, and returns to a REPLACEMENT
  // already past N bytes sees `size > offset` and resumes at N - silently
  // eating the new file's first N bytes. That is reachable whenever the log is
  // rotated under a live `host logs --follow` and the host is reinstalled
  // promptly.
  //
  // Two independent signals, because neither covers every platform:
  //   - the inode, when the OS supplies a real one. Definitive on POSIX;
  //     `fs.Stats.ino` is frequently 0 on Windows, hence the second.
  //   - a CONFIRMED disappearance (ENOENT) since the last successful read.
  //     Narrower than "any error on purpose": an EACCES or a locked handle
  //     must NOT rewind, which is the whole point of preserving the offset
  //     across transient failures.
  let fileIdentity: number | null = null;
  let sawFileMissing = false;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, options.pollIntervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let chunk: Buffer | null = null;
    try {
      const handle = await open(options.path, "r");
      try {
        const stats = await handle.stat();
        missingRetries = 0;
        const identity = stats.ino > 0 ? stats.ino : null;
        // Replacement, established rather than guessed: a different inode, or
        // the path having genuinely vanished since the last read.
        const replaced =
          sawFileMissing ||
          (identity !== null &&
            fileIdentity !== null &&
            identity !== fileIdentity);
        // Truncated in place, or a replacement: re-read from the top either
        // way. Size is still the right signal for truncation - same file,
        // fewer bytes.
        if (replaced || stats.size < offset) offset = 0;
        fileIdentity = identity;
        sawFileMissing = false;
        if (stats.size > offset) {
          const length = Math.min(stats.size - offset, MAX_TICK_READ_BYTES);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead > 0) {
            // Advanced BEFORE the sink runs, so the bytes are accounted for
            // exactly once whatever the sink does with them.
            offset += bytesRead;
            chunk = buffer.subarray(0, bytesRead);
          }
        }
      } finally {
        await handle.close();
      }
    } catch (cause) {
      // A CONFIRMED disappearance is the one error that licenses a rewind on
      // the next successful open - see `sawFileMissing`. Everything else
      // (EACCES, a Windows scanner lock, a failed close) leaves the offset and
      // the recorded identity alone.
      if (isFileMissingError(cause)) sawFileMissing = true;
      // ENOENT or transient. The supervisor recreates the log on the next
      // start, so a short gap during rotation is expected rather than fatal.
      //
      // The offset is deliberately NOT rewound here. This catch cannot tell a
      // deleted file from a one-poll Windows scanner lock, a momentary EACCES,
      // or a failed close - and rewinding on those re-emits the whole log from
      // byte zero on the next successful tick, which for the foreground mirror
      // means flooding a terminal with history it started at EOF precisely to
      // avoid. Replacement and truncation are already handled where they can
      // be OBSERVED rather than guessed: the `stats.size < offset` check above
      // rewinds as soon as a readable file turns out to be shorter than what
      // has been consumed, which is exactly what a rotated-and-recreated log
      // looks like.
      missingRetries += 1;
      if (missingRetries > options.maxMissingRetries) {
        stopped = true;
        options.onExhausted();
        return;
      }
    }
    // Re-checked AFTER the awaits, not just at entry. `stop()` can land while
    // this tick is inside open/stat/read/close, and emitting here would break
    // `stop()`'s stated guarantee that nothing arrives afterwards - which
    // `host logs --follow` relies on to stop writing once its signal cleanup
    // has resolved, and which would otherwise let a poll race the foreground
    // console's synchronous drain. The bytes are simply dropped; the offset
    // has already advanced, and a stopped follower has no one left to tell.
    if (stopped) return;
    if (chunk !== null) options.onBytes(chunk);
    schedule();
  };

  const drainSync = (): void => {
    let fd: number | null = null;
    let chunk: Buffer | null = null;
    try {
      fd = openSync(options.path, "r");
      const size = fstatSync(fd).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        // Read the TAIL of the backlog, not its head. This runs immediately
        // before `process.exit`, so whatever it does not emit is lost - and
        // the lines worth saving are the last ones the host wrote on its way
        // down, not the oldest 256 KiB of a burst. Skipping forward is what
        // makes the cap honest about which end it keeps.
        const pending = size - offset;
        const skipped = Math.max(0, pending - MAX_SYNC_DRAIN_BYTES);
        const readFrom = offset + skipped;
        const length = pending - skipped;
        const buffer = Buffer.alloc(length);
        const bytesRead = readSync(fd, buffer, 0, length, readFrom);
        if (bytesRead > 0) {
          offset = readFrom + bytesRead;
          chunk = buffer.subarray(0, bytesRead);
          if (skipped > 0) options.onSkipped(skipped);
        }
      }
    } catch {
      // Best effort - see the doc comment.
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Nothing useful to do with a failed close on the way out.
        }
      }
    }
    if (chunk !== null) options.onBytes(chunk);
  };

  schedule();

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    drainSync,
  };
}

function isFileMissingError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code: unknown }).code === "ENOENT"
  );
}

function initialOffset(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
