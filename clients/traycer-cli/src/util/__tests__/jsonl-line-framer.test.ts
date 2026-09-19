import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createJsonlLineFramer,
  JsonlLineTooLongError,
  MAX_JSONL_LINE_BYTES,
} from "../jsonl-line-framer";

/**
 * The CLI half of the framer's shared behaviour table. The host runs the SAME
 * `jsonl-line-framer-vectors.json` against its own copy
 * (`traycer-host/src/util/__tests__/jsonl-line-framer-parity.test.ts`), which
 * also asserts the two copies are identical below their headers - that pair is
 * what keeps the duplication honest.
 */

type FramerCase = {
  readonly name: string;
  readonly maxLineBytes: number;
  readonly chunks: readonly Uint8Array[];
  readonly linesPerChunk: readonly (readonly string[])[] | null;
  readonly flush: string | null;
  readonly throwsAtChunk: number | null;
  readonly afterDiscardChunk: Uint8Array | null;
  readonly afterDiscardLines: readonly string[] | null;
};

const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "jsonl-line-framer-vectors.json",
);

function field(source: unknown, key: string, what: string): unknown {
  if (typeof source !== "object" || source === null) {
    throw new Error(`${what} is not an object`);
  }
  return Reflect.get(source, key);
}

function stringField(source: unknown, key: string, what: string): string {
  const value = field(source, key, what);
  if (typeof value !== "string")
    throw new Error(`${what}.${key} is not a string`);
  return value;
}

function stringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value.map((entry) => {
    if (typeof entry !== "string")
      throw new Error(`${what} holds a non-string`);
    return entry;
  });
}

function loadCases(): readonly FramerCase[] {
  const parsed: unknown = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
  const cases = field(parsed, "cases", "the vector file");
  if (!Array.isArray(cases))
    throw new Error("the vector file carries no cases");
  return cases.map((entry: unknown) => {
    const expectation = field(entry, "expect", "a vector case");
    const maxLineBytes = field(entry, "maxLineBytes", "a vector case");
    if (typeof maxLineBytes !== "number") {
      throw new Error("a vector case has no numeric maxLineBytes");
    }
    const throwsAt = field(expectation, "throwsAtChunk", "a case's expect");
    const perChunk = field(expectation, "linesPerChunk", "a case's expect");
    const flush = field(expectation, "flush", "a case's expect");
    const name = stringField(entry, "name", "a vector case");
    const afterDiscardBase64 = field(
      expectation,
      "afterDiscardBase64",
      "a case's expect",
    );
    const afterDiscardLines = field(
      expectation,
      "afterDiscardLines",
      "a case's expect",
    );
    // A half-specified vector is a bad vector, not a skipped assertion.
    if (
      (afterDiscardBase64 === undefined) !==
      (afterDiscardLines === undefined)
    ) {
      throw new Error(
        `vector "${name}" carries only one of afterDiscardBase64 / afterDiscardLines`,
      );
    }
    return {
      name,
      afterDiscardChunk:
        afterDiscardBase64 === undefined
          ? null
          : new Uint8Array(
              Buffer.from(
                stringField(
                  expectation,
                  "afterDiscardBase64",
                  "a case's expect",
                ),
                "base64",
              ),
            ),
      afterDiscardLines:
        afterDiscardLines === undefined
          ? null
          : stringArray(afterDiscardLines, "a case's afterDiscardLines"),
      maxLineBytes,
      chunks: stringArray(
        field(entry, "chunksBase64", "a vector case"),
        "chunksBase64",
      ).map((chunk) => new Uint8Array(Buffer.from(chunk, "base64"))),
      linesPerChunk: Array.isArray(perChunk)
        ? perChunk.map((lines: unknown) =>
            stringArray(lines, "a case's linesPerChunk entry"),
          )
        : null,
      flush: typeof flush === "string" ? flush : null,
      throwsAtChunk: typeof throwsAt === "number" ? throwsAt : null,
    };
  });
}

const CASES = loadCases();

describe("createJsonlLineFramer against the shared vector table", () => {
  it("the table is present and non-trivial", () => {
    // A vector file that lost its cases would turn every test below into a
    // pass over nothing.
    expect(CASES.length).toBeGreaterThanOrEqual(15);
    const separators = CASES.filter((entry) =>
      entry.chunks.some((chunk) =>
        Buffer.from(chunk).includes(Buffer.from([0xe2, 0x80, 0xa8])),
      ),
    );
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  for (const framerCase of CASES) {
    it(framerCase.name, () => {
      const framer = createJsonlLineFramer({
        maxLineBytes: framerCase.maxLineBytes,
      });
      // Hoisted: a property narrowing does not survive into the closure
      // `expect(() => ...)` builds, and a missing chunk must read as a bad
      // VECTOR rather than as "the framer did not throw".
      const throwsAt = framerCase.throwsAtChunk;
      if (throwsAt !== null) {
        for (let index = 0; index < throwsAt; index += 1) {
          const chunk = framerCase.chunks[index];
          if (chunk === undefined) {
            throw new Error(
              `vector "${framerCase.name}" has no chunk ${index}`,
            );
          }
          framer.push(chunk);
        }
        const throwing = framerCase.chunks[throwsAt];
        if (throwing === undefined) {
          throw new Error(
            `vector "${framerCase.name}" throws at chunk ${throwsAt} but carries only ${framerCase.chunks.length}`,
          );
        }
        expect(() => framer.push(throwing)).toThrow(JsonlLineTooLongError);
        // Faulted: the buffered prefix is not a line, and a 0x0a in a later
        // chunk is not a boundary. The probe is a chunk a HEALTHY framer
        // would frame into a line, so an un-poisoned framer cannot pass.
        expect(framer.flush()).toBeNull();
        expect([
          ...framer.push(new Uint8Array(Buffer.from("probe\n"))),
        ]).toEqual([]);
        framer.discard();
        if (
          framerCase.afterDiscardChunk !== null &&
          framerCase.afterDiscardLines !== null
        ) {
          expect([...framer.push(framerCase.afterDiscardChunk)]).toEqual(
            framerCase.afterDiscardLines,
          );
        }
        return;
      }
      const seen = framerCase.chunks.map((chunk) => [...framer.push(chunk)]);
      expect(seen).toEqual(framerCase.linesPerChunk);
      expect(framer.flush()).toBe(framerCase.flush);
    });
  }
});

describe("the regression the framer exists for, with readline as the control", () => {
  it("a line carrying raw U+2028/U+2029 survives the framer and is shredded by node:readline", async () => {
    // Under bun's readline the control cannot split, so this pin would pass
    // while proving nothing. The CLI ships as a node binary; assert the
    // runtime rather than trusting it.
    expect(process.versions.bun).toBeUndefined();

    const separator = String.fromCharCode(0x2028);
    const paragraph = String.fromCharCode(0x2029);
    const text = `{"a":"x${separator}y${paragraph}z"}\n`;
    const bytes = Buffer.from(text, "utf8");
    expect(bytes.includes(Buffer.from([0xe2, 0x80, 0xa8]))).toBe(true);

    const framer = createJsonlLineFramer({
      maxLineBytes: MAX_JSONL_LINE_BYTES,
    });
    const lines = framer.push(bytes);
    expect(lines).toHaveLength(1);

    const collected: string[] = [];
    const rl = createInterface({ input: Readable.from([bytes]) });
    for await (const line of rl) collected.push(line);
    expect(collected.length).toBeGreaterThanOrEqual(3);
  });
});
