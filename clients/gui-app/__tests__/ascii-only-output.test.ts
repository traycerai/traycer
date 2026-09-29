// @vitest-environment node
import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  escapeNonAsciiJavaScript,
  shiftMappingColumns,
} from "../vite/ascii-only-output";

/**
 * The rewrite is only worth anything if it changes nothing a program can
 * observe beyond what the plugin's header lists (a function's own source
 * text, and a replaced `globalThis.RegExp`). Each case evaluates the original
 * body and the rewritten one and compares what they return.
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
  [
    "regex source, flags and text",
    'const r = /[—–]\\/x…"/giu; return [r.source, r.flags, String(r), r.test("A–/X…\\"")];',
  ],
  [
    "regex with a slash in a class",
    'return [/[/—]/.source, /[/—]/.test("/")];',
  ],
  ["identity-escaped character in a regex source", "return /\\…/.source;"],
  ["regex straight after return", "return/—/.source;"],
  [
    "global regex state",
    'const r = /—/g; r.test("a—b—"); return [r.lastIndex, r.test("a—b—"), r.lastIndex];',
  ],
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

  it("escapes an astral identifier as one code-point escape", () => {
    const ident = String.fromCodePoint(0x1d400);
    const result = escapeNonAsciiJavaScript(`var ${ident}x = 1;`, "a.js");
    if (result === null) throw new Error("expected a rewrite");
    expect(result.code).toContain("\\u{1d400}x");
    expect(result.code.toLowerCase()).not.toContain("\\ud835");
    const edits = [...result.lineEdits.values()].flat();
    expect(edits).toHaveLength(1);
    expect(edits[0].removed).toBe(2);
    const body = `var ${ident}x = 1; return ${ident}x;`;
    expect(evaluate(rewriteBody(body))).toEqual(evaluate(body));
  });

  it("escapes an astral character in a string as a surrogate pair", () => {
    const ident = String.fromCodePoint(0x1d400);
    const result = escapeNonAsciiJavaScript(`"${ident}"`, "a.js");
    if (result === null) throw new Error("expected a rewrite");
    expect(result.code.toLowerCase()).toContain("\\ud835\\udc00");
  });

  /**
   * `lineEdits` is keyed by ECMAScript line index, the same numbering
   * rolldown uses for `mappings`. A tagged template keeps U+2028 / U+2029
   * (and a source CR / CRLF is a line break), so an edit after one belongs
   * on the next line, with its column counted from just after that break.
   * LF-only counting would leave every case below on line 0 except CRLF,
   * which LF-only and a doubled CR+LF count disagree on (line 1 vs line 2).
   */
  function emDashEdit(code: string): {
    readonly line: number;
    readonly column: number;
  } {
    const result = escapeNonAsciiJavaScript(code, "chunk.js");
    if (result === null) throw new Error("expected a rewrite");
    const entries = [...result.lineEdits.entries()];
    expect(entries).toHaveLength(1);
    const [line, edits] = entries[0];
    expect(edits).toHaveLength(1);
    expect(edits[0].removed).toBe(1);
    expect(edits[0].inserted).toBe(6);
    return { line, column: edits[0].column };
  }

  it("keys an em-dash edit after a tagged-template U+2028 to line 1", () => {
    const ls = String.fromCharCode(0x2028);
    const code = `String.raw\`${ls}\`+"—"`;
    const afterBreak = code.indexOf(ls) + 1;
    const dash = code.indexOf("—");
    expect(emDashEdit(code)).toEqual({
      line: 1,
      column: dash - afterBreak,
    });
  });

  it("keys an em-dash edit after a tagged-template U+2029 to line 1", () => {
    const ps = String.fromCharCode(0x2029);
    const code = `String.raw\`${ps}\`+"—"`;
    const afterBreak = code.indexOf(ps) + 1;
    const dash = code.indexOf("—");
    expect(emDashEdit(code)).toEqual({
      line: 1,
      column: dash - afterBreak,
    });
  });

  it("keys an em-dash edit after a bare CR to line 1", () => {
    const cr = String.fromCharCode(0x0d);
    const code = `"a"${cr}"—"`;
    const afterBreak = code.indexOf(cr) + 1;
    const dash = code.indexOf("—");
    expect(emDashEdit(code)).toEqual({
      line: 1,
      column: dash - afterBreak,
    });
  });

  it("keys an em-dash edit after CRLF to line 1, not line 2", () => {
    const crlf = `${String.fromCharCode(0x0d)}${String.fromCharCode(0x0a)}`;
    const code = `"a"${crlf}"—"`;
    const result = escapeNonAsciiJavaScript(code, "chunk.js");
    if (result === null) throw new Error("expected a rewrite");
    const afterBreak = code.indexOf(crlf) + crlf.length;
    const dash = code.indexOf("—");
    expect(result.lineEdits.get(2)).toBeUndefined();
    expect(result.lineEdits.get(1)).toEqual([
      { column: dash - afterBreak, removed: 1, inserted: 6 },
    ]);
  });
});

describe("RegExp shadow guard", () => {
  const THROWS: ReadonlyArray<readonly [string, string]> = [
    ["const RegExp = 1", "const RegExp = 1;\nconst r = /—/;"],
    ["let RegExp", "let RegExp;\nconst r = /—/;"],
    ["var RegExp", "var RegExp;\nconst r = /—/;"],
    ["function RegExp() {}", "function RegExp() {}\nconst r = /—/;"],
    [
      "named function expression",
      "const f = function RegExp() {};\nconst r = /—/;",
    ],
    ["class RegExp {}", "class RegExp {}\nconst r = /—/;"],
    ["named class expression", "const C = class RegExp {};\nconst r = /—/;"],
    ["plain parameter", "function f(RegExp) { return /—/; }"],
    ["arrow parameter", "const f = (RegExp) => { return /—/; };"],
    ["default parameter", "function f(RegExp = 1) { return /—/; }"],
    ["rest parameter", "function f(...RegExp) { return /—/; }"],
    ["destructured parameter", "function f({ RegExp }) { return /—/; }"],
    ["destructuring const", "const { RegExp } = o;\nconst r = /—/;"],
    ["renamed destructuring", "const { a: RegExp } = o;\nconst r = /—/;"],
    ["array destructuring", "const [RegExp] = a;\nconst r = /—/;"],
    [
      "nested destructuring with a default",
      "const { a: [{ b: RegExp = 1 }] } = o;\nconst r = /—/;",
    ],
    ["catch parameter", "try {} catch (RegExp) { const r = /—/; }"],
    [
      "destructured catch parameter",
      "try {} catch ({ RegExp }) { const r = /—/; }",
    ],
    ["named import", 'import { RegExp } from "x";\nconst r = /—/;'],
    ["default import", 'import RegExp from "x";\nconst r = /—/;'],
    ["namespace import", 'import * as RegExp from "x";\nconst r = /—/;'],
    ["assignment", "RegExp = function () {};\nconst r = /—/;"],
    ["destructuring assignment", "({ RegExp } = o);\nconst r = /—/;"],
    ["for-of target", "for (RegExp of a);\nconst r = /—/;"],
    ["update expression", "RegExp++;\nconst r = /—/;"],
    [
      "a with statement whose object shadows RegExp",
      'function f(){ with ({ RegExp: function () { return { source: "wrong" }; } }) { return /é/.source; } }',
    ],
    [
      "a direct eval that could declare RegExp",
      "function f(){ eval(\"var RegExp = function () { return { source: 'wrong' }; }\"); return /é/.source; }",
    ],
    [
      "a direct eval elsewhere in the chunk",
      'function g(){ eval("1"); }\nfunction f(){ return /é/.source; }',
    ],
    [
      "a with statement unrelated to RegExp",
      "function f(o){ with (o) { return 1; } return /é/.source; }",
    ],
    [
      "a parenthesized eval callee that could declare RegExp",
      "function f(){ (eval)(\"var RegExp = function () { return { source: 'wrong' }; }\"); return /é/.source; }",
    ],
    [
      "a doubly-parenthesized eval callee",
      'function f(){ ((eval))("1"); return /é/; }',
    ],
  ];

  it.each(THROWS)("throws when the chunk has: %s", (_name, code) => {
    expect(() => escapeNonAsciiJavaScript(code, "chunk.js")).toThrow(
      /binds or assigns the name RegExp/,
    );
  });

  it.each(THROWS.slice(-6))(
    "mentions with or eval when the chunk has: %s",
    (_name, code) => {
      expect(() => escapeNonAsciiJavaScript(code, "chunk.js")).toThrow(
        /with.*eval|eval.*with/,
      );
    },
  );

  const CONTROLS: ReadonlyArray<readonly [string, string]> = [
    ["a member is not a binding", "x.RegExp = 1;\nconst r = /—/;"],
    [
      "an object key is not a binding",
      "const o = { RegExp: 1 };\nconst r = /—/;",
    ],
    ["a use is not a binding", 'const x = new RegExp("a");\nconst r = /—/;'],
    [
      "a member call named eval is not a direct eval",
      'x.eval("1");\nconst r = /é/;',
    ],
    [
      "an object key named eval is not a direct eval",
      "const o = { eval: 1 };\nconst r = /é/;",
    ],
    [
      "a comma-sequence eval callee is an indirect eval",
      'function f(){ (0, eval)("1"); return /é/; }',
    ],
    [
      "a globalThis.eval member call is not a direct eval",
      'globalThis.eval("1");\nconst r = /é/;',
    ],
  ];

  it.each(CONTROLS)("does not throw when %s", (_name, code) => {
    expect(() => escapeNonAsciiJavaScript(code, "chunk.js")).not.toThrow();
  });

  it.each(CONTROLS.slice(-2))(
    "still returns a rewrite when %s",
    (_name, code) => {
      expect(escapeNonAsciiJavaScript(code, "chunk.js")).not.toBeNull();
    },
  );

  it("still rewrites a chunk that binds RegExp but has no non-ASCII regex literal", () => {
    const result = escapeNonAsciiJavaScript(
      'const RegExp = 1;\nconst s = "…";',
      "chunk.js",
    );
    expect(result).not.toBeNull();
  });

  it("still rewrites a chunk with a direct eval but no non-ASCII regex literal", () => {
    const result = escapeNonAsciiJavaScript(
      'eval("1");\nconst s = "é";',
      "chunk.js",
    );
    expect(result).not.toBeNull();
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
