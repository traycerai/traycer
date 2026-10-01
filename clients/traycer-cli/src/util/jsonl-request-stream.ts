import { createJsonlLineFramer } from "./jsonl-line-framer";

/**
 * Reads a JSON-per-line REQUEST stream - today, the host-maintenance lease's
 * stdin - and hands each whole line to its caller.
 *
 * It exists as its own function so the framing can be driven at runtime by a
 * test: the lease command itself needs an update capability, a contender lock
 * and a root executor to reach its loop, and the one suite it had reads the
 * file as TEXT, so a rewrite of the loop could not fail it. The seam is the
 * smallest thing that can be tested: a stream in, a handler out.
 *
 * Its three decisions, each pinned in `__tests__/jsonl-request-stream.test.ts`:
 *
 *  - **lines end at `\n` only** (`./jsonl-line-framer`), never at U+2028 /
 *    U+2029, which `readline` would also end a line on although both are legal
 *    raw inside a JSON string. A request carrying either used to arrive as
 *    fragments that failed to parse, and the sender was answered "malformed"
 *    for a request it had sent correctly;
 *  - **the trailing fragment at end of stream is DROPPED**, not delivered. Half
 *    a request is not a request: the peer closed the pipe mid-write, and
 *    handing that fragment on would answer "malformed" for something nobody
 *    finished sending;
 *  - **an over-long line is FATAL to the stream, not a skipped request.** The
 *    framer throws {@link JsonlLineTooLongError}, and this function lets it
 *    out: the reader can no longer tell where the next line begins, so every
 *    later request would be answered against the wrong boundary. The caller
 *    reports the refusal and stops reading.
 */

/** What the handler tells the reader to do next. */
export type JsonlRequestOutcome = "continue" | "stop";

export async function readJsonlRequestLines(
  stream: AsyncIterable<unknown>,
  maxLineBytes: number,
  onRequestLine: (line: string) => Promise<JsonlRequestOutcome>,
): Promise<void> {
  const framer = createJsonlLineFramer({ maxLineBytes });
  try {
    for await (const chunk of stream) {
      for (const line of framer.push(toRequestBytes(chunk))) {
        const outcome = await onRequestLine(line);
        if (outcome === "stop") return;
      }
    }
    // No `flush()`: see the header - a trailing fragment is not a request.
  } finally {
    framer.discard();
  }
}

/**
 * A chunk of the request stream. `process.stdin` is opened with no encoding,
 * so node yields Buffers; anything else means a caller changed how the stream
 * is read, and framing text that node has already decoded per chunk would put
 * a U+FFFD at every chunk seam that split a character.
 */
function toRequestBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  throw new TypeError("a JSON Lines request stream yielded a non-Buffer chunk");
}
