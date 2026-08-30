import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

// `tail -f` over a file OTHER processes append to, behind `host logs --follow`.
//
// It was extracted to be shared with a foreground `host start` mirror; that
// mirror was removed (writing log volume from the supervisor's own event loop
// blocks on a TTY and can stop Ctrl-C reaching the host), so this is again a
// single-caller module - but a considerably more correct one than the inline
// version it replaced. A stat-based poll rather than
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

// Bound for ONE poll's read. `host.log` is unbounded within a host's lifetime
// (nothing truncates it; rotation only happens at a start), so a follower that
// allocated `size - offset` in one go would size a buffer off a file another
// process controls. A supervisor that is mirroring for weeks, or one that
// resumes after any gap, could allocate gigabytes. Reading a capped slice per
// tick loses nothing: the offset advances by what was read and the next tick
// (500ms later) takes the next slice.
const MAX_TICK_READ_BYTES = 1024 * 1024;

// Trailing bytes remembered from what has already been consumed, re-verified
// at the same position before each read. This is the RELIABLE replacement
// check; the inode below is only a fast path.
//
// Inode comparison is not sufficient on its own: `unlink` followed by
// `writeFileSync` routinely REUSES the just-freed inode, so a rotation can
// present the identical `ino` and defeat identity entirely. That is not
// theoretical - it is exactly how this was caught, passing locally and failing
// in CI on a different allocator. If the bytes we already read are no longer
// where we read them, the file underneath changed, whatever its inode says.
const CONTINUITY_BYTES = 64;

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
  readonly pollIntervalMs: number;
  readonly maxMissingRetries: number;
}

export interface LogTail {
  /** Stop polling. Idempotent; never emits again afterwards. */
  stop(): void;
}

/**
 * Follow `path` from its CURRENT end, so a follower never replays history it
 * was not asked for. `host logs` prints the existing tail itself first.
 */
export function startLogTail(options: LogTailOptions): LogTail {
  // Size AND identity together. Recording the size alone left `fileIdentity`
  // null through the first poll, so a replacement that landed BEFORE that poll
  // had no signal to compare against and resumed at the old offset - the same
  // dropped-prefix bug this identity tracking exists to close, in the one
  // window it did not cover.
  const start = initialPosition(options.path);
  let offset = start.size;
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
  let fileIdentity: number | null = start.identity;
  let sawFileMissing = false;
  let continuity: Buffer | null = start.continuity;
  // The initial stat failed for a reason that is NOT "the file is absent" - a
  // transient EACCES, a Windows sharing violation. Offset 0 would then treat a
  // pre-existing log as newly appended and replay all of it into a terminal
  // that asked to start at the end, so instead the first successful
  // observation establishes EOF and emits nothing.
  let establishEofOnFirstRead = start.kind === "unreadable";

  /**
   * Is the file under `path` still the one `offset` counts bytes in? Rewinds
   * when it is not, so a rotation cannot make the follower skip the new file's
   * first N bytes.
   */
  const rewindIfReplaced = (
    identity: number | null,
    size: number,
    continuityHolds: boolean,
  ): void => {
    const replaced =
      sawFileMissing ||
      !continuityHolds ||
      (identity !== null && fileIdentity !== null && identity !== fileIdentity);
    // Truncated in place, or replaced: re-read from the top either way. Size
    // is still the right signal for truncation - same file, fewer bytes.
    if (replaced || size < offset) {
      offset = 0;
      continuity = null;
    }
    fileIdentity = identity;
    sawFileMissing = false;
  };

  const rememberTail = (chunk: Buffer): void => {
    const combined =
      continuity === null ? chunk : Buffer.concat([continuity, chunk]);
    continuity =
      combined.length <= CONTINUITY_BYTES
        ? Buffer.from(combined)
        : Buffer.from(combined.subarray(combined.length - CONTINUITY_BYTES));
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      // `tick` catches its own I/O, but a throwing sink (or anything else
      // unexpected) would otherwise surface as an unhandled rejection from a
      // detached timer. Stop polling and contain it.
      void tick().catch(() => {
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      });
    }, options.pollIntervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let chunk: Buffer | null = null;
    try {
      const handle = await open(options.path, "r");
      try {
        const stats = await handle.stat();
        if (establishEofOnFirstRead && !sawFileMissing) {
          // First readable observation after an unreadable start: adopt its
          // end rather than replaying everything that was already there - and
          // seed continuity from THIS handle while we have it. Leaving it null
          // recreated the very gap the construction-time seed closes, one
          // observation later: an in-place rewrite after this point had no
          // signal and resumed at the adopted offset.
          offset = stats.size;
          establishEofOnFirstRead = false;
          fileIdentity = stats.ino > 0 ? stats.ino : null;
          continuity = null;
          const seed = Math.min(stats.size, CONTINUITY_BYTES);
          if (seed > 0) {
            const seedBuffer = Buffer.alloc(seed);
            const seedRead = await handle.read(
              seedBuffer,
              0,
              seed,
              stats.size - seed,
            );
            if (seedRead.bytesRead === seed) continuity = seedBuffer;
          }
          sawFileMissing = false;
        } else {
          // A confirmed disappearance after the unreadable construction-time
          // observation means this readable file is a replacement. Its bytes
          // did not predate the follower, so consume it from byte zero instead
          // of adopting its current EOF and silently dropping its prefix.
          if (establishEofOnFirstRead) {
            establishEofOnFirstRead = false;
            offset = 0;
            continuity = null;
          }
          let continuityHolds = true;
          if (continuity !== null && offset >= continuity.length) {
            const probe = Buffer.alloc(continuity.length);
            const read = await handle.read(
              probe,
              0,
              continuity.length,
              offset - continuity.length,
            );
            continuityHolds =
              read.bytesRead === continuity.length && probe.equals(continuity);
          }
          rewindIfReplaced(
            stats.ino > 0 ? stats.ino : null,
            stats.size,
            continuityHolds,
          );
        }
        if (stats.size > offset) {
          const length = Math.min(stats.size - offset, MAX_TICK_READ_BYTES);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead > 0) chunk = buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
      // Reset only after the WHOLE cycle - open, stat, read, close - has
      // succeeded. Resetting right after the stat meant a persistent later
      // failure (an `EIO` read, a close that always throws) took the counter
      // from zero to one on every poll, so `maxMissingRetries` was never
      // reached, `onExhausted` never fired, and `host logs --follow` could sit
      // forever emitting nothing.
      missingRetries = 0;
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
    // The offset is committed HERE, after the stop re-check, not at read time.
    // Advancing it inside the await window meant a `stop()` landing mid-read
    // left bytes that neither path would deliver: this tick discards its chunk,
    // and `drainSync` sees an offset that has already passed them. Leaving the
    // offset alone until delivery keeps them pending for the drain - which is
    // the whole point of having a drain on the exit path.
    if (stopped) return;
    if (chunk !== null) {
      // Advanced BEFORE the sink runs, so the bytes are accounted for exactly
      // once whatever the sink does with them.
      offset += chunk.length;
      rememberTail(chunk);
      options.onBytes(chunk);
    }
    schedule();
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

function initialPosition(path: string): {
  readonly size: number;
  readonly identity: number | null;
  readonly continuity: Buffer | null;
  readonly kind: "observed" | "absent" | "unreadable";
} {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stats = fstatSync(fd);
    // Seed the continuity bytes HERE, from the same descriptor. Recording only
    // size and inode left continuity null through the first poll, so a file
    // rewritten IN PLACE before that poll - same inode, longer than the
    // starting offset - had no signal at all and resumed at the old offset,
    // dropping the replacement's prefix. That is the identical defect the
    // continuity check exists to close, in the one window it did not cover.
    const length = Math.min(stats.size, CONTINUITY_BYTES);
    let continuity: Buffer | null = null;
    if (length > 0) {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, stats.size - length);
      if (read === length) continuity = buffer;
    }
    return {
      size: stats.size,
      identity: stats.ino > 0 ? stats.ino : null,
      continuity,
      kind: "observed",
    };
  } catch (cause) {
    // Absent is a real observation - the file starts empty, so offset 0 IS its
    // end. Unreadable is not: an EACCES or sharing violation says nothing
    // about the size, and treating it as 0 replays an existing log in full.
    return {
      size: 0,
      identity: null,
      continuity: null,
      kind: isFileMissingError(cause) ? "absent" : "unreadable",
    };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do with a failed close here.
      }
    }
  }
}
