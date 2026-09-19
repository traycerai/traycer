/**
 * The CLI's line framer for JSON-per-line streams: today, the host-maintenance
 * lease's request stream on stdin.
 *
 * It exists because `node:readline` is the wrong tool for framing JSON. Node
 * ends a line on U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) as
 * well as on `\n`, and both are legal RAW inside a JSON string - `JSON.stringify`
 * emits them unescaped - so one message arrives as several fragments, none of
 * which parses. Measured on node v24.20.0.
 *
 * ## This file is a COPY. A change here is a change in two places.
 *
 * The host has the same framer at `traycer-host/src/util/jsonl-line-framer.ts`
 * (internal repo). The CLI cannot import a host-internal module and there is no
 * package both repos legitimately share, so the code is duplicated on purpose,
 * and the duplication is held together by two things that must not be weakened:
 *
 *  - `src/util/__tests__/jsonl-line-framer-vectors.json` - ONE table of
 *    behaviour, run by this repo's suite AND by the host's
 *    (`jsonl-line-framer-parity.test.ts`, which reads this very file through
 *    the submodule checkout and fails if it is missing);
 *  - a parity assertion in that host test: the two files must be identical
 *    below their module header. Edit one alone and it goes red.
 *
 * Deliberately dependency-free (not even `node:buffer`).
 */

/**
 * The framer's own figure for one line: 64 MiB. Two orders of magnitude above
 * the largest line measured on a real store - a 100-row `thread/list` page is
 * ~503 KB, the turn-end readback that wedged a chat was ~1.3 MB - and above a
 * `thread/read` of a large thread, measured in tens of MiB (72 MiB for a 160
 * MiB rollout).
 *
 * It is what a caller with nothing better to say takes, and the two repos now
 * differ in whether they have something better:
 *
 *  - the host derives a ceiling per stream instead - from a job's remaining
 *    budget for a metered read, and from the heap the process can still grow
 *    into for an unmetered one - and passes that in. There this constant is the
 *    FLOOR under the unmetered figure, not the figure: a single Codex turn
 *    measures 70 MiB and a single tool-output item 42 MiB, so refusing at 64 MiB
 *    would end chats the release before it carried, and a bound added for
 *    memory safety must not do that;
 *  - the CLI's lease reader keeps this figure as its ceiling: it reads its own
 *    small records, and has no budget and no heap bound of its own.
 */
export const MAX_JSONL_LINE_BYTES = 64 * 1024 * 1024;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * A line longer than the framer's bound. NOT recoverable by truncating: a
 * truncated JSON line is malformed, which is exactly the silent drop this
 * module exists to remove. A stream that produces one is desynchronized, so a
 * transport treats this as fatal and a file reader fails that one file.
 */
export class JsonlLineTooLongError extends Error {
  constructor(
    readonly lineBytes: number,
    readonly maxLineBytes: number,
  ) {
    // No path, no id: this message travels into INFO+ logs and thrown errors.
    super(
      `a JSON line exceeded ${maxLineBytes} bytes (${lineBytes} bytes and no newline yet)`,
    );
    this.name = "JsonlLineTooLongError";
  }
}

export type JsonlLineFramer = {
  /**
   * The complete lines this chunk finished, in order. A chunk that finishes
   * none returns an empty array; the bytes are held until a `\n` arrives.
   * Throws {@link JsonlLineTooLongError} when the line in progress passes the
   * bound, before anything is handed back - and the framer is FAULTED from
   * then on (see below), so a later push returns nothing.
   */
  push(chunk: Uint8Array): readonly string[];
  /**
   * The trailing line that never got its `\n`, or `null`.
   *
   * The two callers answer this differently on purpose, which is why it is a
   * separate call rather than something `push` decides: a FILE's last row
   * without a trailing newline is data (`meteredJsonlLines` yields it), while
   * a CHILD's partial line at exit is not a message and is discarded - what
   * `readline` did instead was hand that fragment to the client's line
   * handler, which failed to parse it and logged a warning about a stream
   * that had simply been cut.
   *
   * `null` once the framer has faulted, whatever was buffered.
   */
  flush(): string | null;
  /**
   * Drops whatever is buffered: a caller that has stopped reading. Also the
   * only way out of the faulted state.
   */
  discard(): void;
};

export function createJsonlLineFramer(options: {
  readonly maxLineBytes: number;
}): JsonlLineFramer {
  const { maxLineBytes } = options;
  // Streaming decode: a multi-byte character split across two chunks is
  // completed by the next `decode` call rather than turning into U+FFFD, which
  // is what a per-chunk `toString()` would produce at the seam.
  const decoder = new TextDecoder("utf-8");
  let pendingText = "";
  // Tracked in BYTES, not code points: the bound is a memory bound, and the
  // two differ by up to 4x on non-ASCII text.
  let pendingBytes = 0;
  /**
   * Set by an over-length line, cleared only by `discard`.
   *
   * A line past the bound is not a bad line, it is a bad STREAM: nothing after
   * it can be located, and what is buffered is the PREFIX of a line whose end
   * was never seen. Without this, `flush()` after the throw handed that prefix
   * back as a line - a truncated one, which is the exact silent corruption
   * this module exists to remove, arriving through its own error path. No
   * caller in either repo flushes after a fault today; the property is here so
   * that staying correct does not depend on every future caller knowing that.
   */
  let faulted = false;

  /**
   * Faults the framer and throws. Never returns.
   *
   * It deliberately does NOT clear the buffer, and that is not an oversight:
   * clearing here would make the `faulted` checks in `push` and `flush`
   * unreachable, and an unreachable guard is one no test can redden. One
   * mechanism, checked where it is read. The buffer it leaves behind cannot
   * grow - a faulted `push` accumulates nothing - so it is bounded by
   * `maxLineBytes` and released by `discard()`, which every caller in both
   * repos already calls on a fault.
   */
  const fail = (lineBytes: number): never => {
    faulted = true;
    throw new JsonlLineTooLongError(lineBytes, maxLineBytes);
  };

  const takeLine = (decoded: string): string => {
    const line = pendingText + decoded;
    pendingText = "";
    pendingBytes = 0;
    // Exactly one trailing CR, the JSON Lines grammar: an interior `\r` is
    // part of the data, and a CRLF pair is a line ending.
    return line.length > 0 &&
      line.charCodeAt(line.length - 1) === CARRIAGE_RETURN
      ? line.slice(0, -1)
      : line;
  };

  return {
    push(chunk: Uint8Array): readonly string[] {
      // Faulted: the stream is desynchronised, so these bytes cannot be
      // located either. They are dropped rather than framed - a `\n` in them
      // is not a line boundary, it is a byte that happens to be 0x0a.
      if (faulted) return [];
      const lines: string[] = [];
      let from = 0;
      for (;;) {
        const newline = indexOfNewline(chunk, from);
        if (newline === -1) break;
        const lineBytes = pendingBytes + (newline - from);
        if (lineBytes > maxLineBytes) {
          // A complete over-length line, and `pendingText` may already hold
          // the start of it from an earlier chunk: the same prefix, reached
          // through the other of the two bounds checks.
          fail(lineBytes);
        }
        // Decoded in stream mode up to the separator. A `\n` byte can never be
        // part of a multi-byte sequence in UTF-8, so a line boundary is always
        // a safe place to read the decoder's output.
        lines.push(
          takeLine(
            decoder.decode(chunk.subarray(from, newline), { stream: true }),
          ),
        );
        from = newline + 1;
      }
      if (from < chunk.byteLength) {
        const rest = chunk.subarray(from);
        pendingBytes += rest.byteLength;
        if (pendingBytes > maxLineBytes) {
          // Thrown BEFORE the finished lines are returned, so a caller cannot
          // act on half a chunk and then be told the stream is unusable.
          fail(pendingBytes);
        }
        pendingText += decoder.decode(rest, { stream: true });
      }
      return lines;
    },

    flush(): string | null {
      // The final, non-streaming decode releases an incomplete multi-byte
      // sequence at the end of the stream as U+FFFD rather than dropping it.
      // It runs even when faulted, to leave the decoder in the same state
      // either way.
      const tail = pendingText + decoder.decode();
      pendingText = "";
      pendingBytes = 0;
      if (faulted) return null;
      return tail.length === 0 ? null : tail;
    },

    discard(): void {
      pendingText = "";
      pendingBytes = 0;
      faulted = false;
      decoder.decode();
    },
  };
}

/**
 * `Uint8Array` has no `indexOf` for a byte value the way `Buffer` does, and
 * the framer must not import `node:buffer` (the worker bundle takes this
 * module), so the scan is written out.
 */
function indexOfNewline(chunk: Uint8Array, from: number): number {
  for (let index = from; index < chunk.byteLength; index += 1) {
    if (chunk[index] === NEWLINE) return index;
  }
  return -1;
}
