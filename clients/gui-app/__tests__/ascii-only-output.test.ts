// @vitest-environment node
import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  escapeNonAsciiJavaScript,
  shiftMappingColumns,
} from "../vite/ascii-only-output";

/**
 * The rewrite is only worth anything if it changes NOTHING a program can
 * observe. Each case evaluates the original body and the rewritten one and
 * compares what they return.
 */
function evaluate(body: string): string {
  // Serialized inside the script, so a result compares as plain data.
  const result: unknown = runInThisContext(
    `JSON.stringify((function(){${body}})())`,
  );
  if (typeof result !== "string") throw new Error("expected a JSON result");
  return result;
}

/** A function body, rewritten as the declaration a chunk would carry. */
function rewriteBody(body: string): string {
  const declaration = `function run(){${body}}`;
  // `null` is "nothing to escape" - a tagged template's text or a line
  // terminator is all the non-ASCII there is - and the code stands as it is.
  const rewritten =
    escapeNonAsciiJavaScript(declaration, "chunk.js")?.code ?? declaration;
  return `${rewritten}\nreturn run();`;
}

function rewrite(code: string): string {
  const result = escapeNonAsciiJavaScript(code, "chunk.js");
  if (result === null) throw new Error("expected a rewrite");
  return result.code;
}

function nonAscii(code: string): string {
  return Array.from(code)
    .filter((character) => character.charCodeAt(0) > 0x7f)
    .join("");
}

const EQUIVALENT: ReadonlyArray<readonly [string, string]> = [
  ["string", 'return "Loading… — done";'],
  ["astral string", 'return "grin 😀 end";'],
  ["identity-escaped character in a string", 'return "a\\…b";'],
  ["escaped backslash before a character", 'return "a\\\\…b";'],
  ["regex", 'return [/[—–]/.test("—"), /[—–]/.test("-")];'],
  ["u-flag regex over an astral range", 'return /[😀-😂]/u.test("😁");'],
  ["astral regex without the u flag", 'return /😀/.test("x😀");'],
  ["identity-escaped character in a regex", 'return /\\…/.test("…");'],
  ["untagged template", 'const a = "x"; return `${a}—…${a}`;'],
  ["identity-escaped character in a template", "return `a\\…b`;"],
  ["tagged template raw text", "return String.raw`a—\\…b`;"],
  ["identifier", "const ñame = 1; return ñame + 1;"],
  ["comment", "// an em dash — and 😀\nreturn 1; /* © */"],
  ["Unicode whitespace in code", "return [1, 2];"],
  ["line separator in a string", 'return "a b".length;'],
];

describe("escapeNonAsciiJavaScript", () => {
  for (const [name, body] of EQUIVALENT) {
    it(`preserves behaviour: ${name}`, () => {
      expect(evaluate(rewriteBody(body))).toEqual(evaluate(body));
    });
  }

  it("leaves only tagged-template text and line terminators non-ASCII", () => {
    const body = [
      'const s = "…";',
      "const r = /—/;",
      "const t = `—`;",
      "const ñ = 1;",
      "// ©",
      "const raw = String.raw`kept—`;",
      'const ls = "a b";',
    ].join("\n");

    expect(nonAscii(rewrite(body))).toBe("— ");
  });

  it("returns null for ASCII-only code", () => {
    expect(escapeNonAsciiJavaScript("const a = 1;", "chunk.js")).toBeNull();
  });

  it("refuses code that does not parse, rather than guessing at it", () => {
    expect(() =>
      escapeNonAsciiJavaScript('const a = "…"; const', "chunk.js"),
    ).toThrow(/does not parse/);
  });

  it("refuses a rewrite that no longer parses", () => {
    // An astral identifier character has no `\uXXXX` spelling an identifier
    // accepts - the surrogate-pair escape is not an identifier.
    expect(() => escapeNonAsciiJavaScript("const 𝑥 = 1;", "chunk.js")).toThrow(
      /does not parse after escaping/,
    );
  });
});

describe("shiftMappingColumns", () => {
  const BASE64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  /** One-field segments: generated columns only, delta-encoded. */
  function encodeColumns(columns: readonly number[]): string {
    let previous = 0;
    return columns
      .map((column) => {
        let value =
          column - previous < 0
            ? ((previous - column) << 1) | 1
            : (column - previous) << 1;
        previous = column;
        let out = "";
        do {
          let digit = value & 31;
          value >>>= 5;
          if (value > 0) digit |= 32;
          out += BASE64[digit];
        } while (value > 0);
        return out;
      })
      .join(",");
  }

  it("moves each generated column to where its token sits after escaping", () => {
    const code = 'const e="Loading…",t=/[—–]/,u=1;';
    const result = escapeNonAsciiJavaScript(code, "chunk.js");
    if (result === null) throw new Error("expected a rewrite");
    const tokens = ["const", "e=", "t=", "u="];
    const before = tokens.map((token) => code.indexOf(token));
    const after = tokens.map((token) => result.code.indexOf(token));

    const shifted = shiftMappingColumns(
      `;${encodeColumns(before)}`,
      new Map([[1, result.lineEdits.get(0) ?? []]]),
    );

    expect(shifted).toBe(`;${encodeColumns(after)}`);
  });

  it("maps a column inside a replaced range to the start of its escape", () => {
    // `\…` at column 3 folds into one `\u2026`: two characters out, six in.
    // Column 4 - the character itself - lands where the escape starts.
    const shifted = shiftMappingColumns(
      encodeColumns([3, 4, 5]),
      new Map([[0, [{ column: 3, removed: 2, inserted: 6 }]]]),
    );

    expect(shifted).toBe(encodeColumns([3, 3, 9]));
  });

  it("leaves lines without edits untouched", () => {
    const mappings = `${encodeColumns([0, 5])};${encodeColumns([2])}`;

    expect(shiftMappingColumns(mappings, new Map())).toBe(mappings);
  });
});
