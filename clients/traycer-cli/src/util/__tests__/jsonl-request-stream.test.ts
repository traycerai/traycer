import { describe, expect, it } from "vitest";
import { JsonlLineTooLongError } from "../jsonl-line-framer";
import {
  readJsonlRequestLines,
  type JsonlRequestOutcome,
} from "../jsonl-request-stream";

/**
 * The maintenance lease's request framing, driven for real.
 *
 * `host-maintenance-lease.ts` reads its requests through this seam, and its own
 * suite (`commands/__tests__/host-maintenance-lease-completion.test.ts`) is a
 * SOURCE-TEXT suite: it asserts the order of statements in the file and would
 * pass over a loop that never ran. So the framing is pinned here instead, at
 * runtime, against the three decisions the seam documents.
 */

async function* streamOf(
  ...chunks: readonly (string | Uint8Array)[]
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  }
}

/** Collects every line the seam delivers, never stopping. */
async function collect(
  stream: AsyncIterable<unknown>,
  maxLineBytes: number,
): Promise<readonly string[]> {
  const seen: string[] = [];
  await readJsonlRequestLines(stream, maxLineBytes, async (line) => {
    seen.push(line);
    return "continue";
  });
  return seen;
}

const BIG = 1024 * 1024;

describe("readJsonlRequestLines", () => {
  it("a request split across two chunks arrives as ONE line", async () => {
    const request = JSON.stringify({ v: 1, id: "a", kind: "verify" });
    const seen = await collect(
      streamOf(request.slice(0, 7), `${request.slice(7)}\n`),
      BIG,
    );
    expect(seen).toEqual([request]);
  });

  it("two requests in one chunk arrive in order", async () => {
    const first = JSON.stringify({ v: 1, id: "1", kind: "verify" });
    const second = JSON.stringify({ v: 1, id: "2", kind: "release" });
    const seen = await collect(streamOf(`${first}\n${second}\n`), BIG);
    expect(seen).toEqual([first, second]);
  });

  it("a raw U+2028 and U+2029 inside one request stay inside ONE request", async () => {
    // Built with fromCharCode: an escape a formatter turns into a raw
    // character would leave this fixture claiming what it no longer contains.
    const message = `before${String.fromCharCode(0x2028)}middle${String.fromCharCode(0x2029)}after`;
    const request = JSON.stringify({ v: 1, id: "a", kind: "execute", message });
    const bytes = Buffer.from(`${request}\n`, "utf8");
    expect(bytes.includes(Buffer.from([0xe2, 0x80, 0xa8]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xe2, 0x80, 0xa9]))).toBe(true);

    const seen = await collect(streamOf(bytes), BIG);

    expect(seen).toHaveLength(1);
    const parsed: unknown = JSON.parse(seen[0] ?? "");
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("the delivered request did not parse to an object");
    }
    expect(Reflect.get(parsed, "message")).toBe(message);
  });

  it("trims one trailing CR on CRLF framing", async () => {
    const request = JSON.stringify({ v: 1, id: "a", kind: "verify" });
    const seen = await collect(streamOf(`${request}\r\n`), BIG);
    expect(seen).toEqual([request]);
  });

  it("the trailing fragment at end of stream is DROPPED, not delivered", async () => {
    const whole = JSON.stringify({ v: 1, id: "1", kind: "verify" });
    const seen = await collect(
      streamOf(`${whole}\n`, '{"v":1,"id":"2","kind":"rel'),
      BIG,
    );
    // Half a request is not a request: delivering it would answer
    // "malformed" for something the peer never finished sending.
    expect(seen).toEqual([whole]);
  });

  it("an over-long line is fatal to the stream, and nothing after it is delivered", async () => {
    const seen: string[] = [];
    const stream = streamOf(
      '{"v":1,"id":"1","kind":"verify"}\n',
      `${"x".repeat(64)}`,
      '{"v":1,"id":"2","kind":"verify"}\n',
    );
    await expect(
      readJsonlRequestLines(stream, 32, async (line) => {
        seen.push(line);
        return "continue";
      }),
    ).rejects.toBeInstanceOf(JsonlLineTooLongError);
    expect(seen).toEqual(['{"v":1,"id":"1","kind":"verify"}']);
  });

  it('"stop" ends the read: no later line in the chunk, and no later chunk', async () => {
    const seen: string[] = [];
    let chunksPulled = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for (const text of ['{"id":"1"}\n{"id":"2"}\n', '{"id":"3"}\n']) {
        chunksPulled += 1;
        yield Buffer.from(text, "utf8");
      }
    }
    await readJsonlRequestLines(counted(), BIG, async (line) => {
      seen.push(line);
      const outcome: JsonlRequestOutcome = "stop";
      return outcome;
    });
    expect(seen).toEqual(['{"id":"1"}']);
    expect(chunksPulled).toBe(1);
  });
});
