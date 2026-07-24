import { describe, expect, it } from "vitest";
import { parseGlobs } from "@/lib/commands/sources/open/parse-globs";

describe("parseGlobs", () => {
  it("splits multiple comma-separated patterns and trims whitespace", () => {
    expect(parseGlobs("*.ts, src/** ,  lib/*.js")).toEqual([
      "*.ts",
      "src/**",
      "lib/*.js",
    ]);
  });

  it("drops empty tokens from blank / whitespace / stray-separator input", () => {
    expect(parseGlobs("")).toEqual([]);
    expect(parseGlobs("   ")).toEqual([]);
    expect(parseGlobs(" , ,, ")).toEqual([]);
    expect(parseGlobs("*.ts,,")).toEqual(["*.ts"]);
  });

  it("expands extension shorthand into a basename glob", () => {
    expect(parseGlobs(".md, .tsx")).toEqual(["*.md", "*.tsx"]);
  });

  it("keeps commas inside a brace expression as one pattern", () => {
    expect(parseGlobs("{a,b}.ts")).toEqual(["{a,b}.ts"]);
    expect(parseGlobs("src/{a,b,c}/**, *.js")).toEqual([
      "src/{a,b,c}/**",
      "*.js",
    ]);
    // Nested braces track depth correctly.
    expect(parseGlobs("{a,{b,c}}.ts, x.js")).toEqual(["{a,{b,c}}.ts", "x.js"]);
  });

  it("keeps an escaped comma as a literal within one pattern", () => {
    // The backslash-escape survives to rg, which unescapes `\,` to a literal.
    expect(parseGlobs("a\\,b.ts")).toEqual(["a\\,b.ts"]);
    expect(parseGlobs("a\\,b, c")).toEqual(["a\\,b", "c"]);
  });

  it("handles malformed/unbalanced braces as a defined single token", () => {
    // Unbalanced OPEN brace swallows the rest (rg then rejects it) - never a
    // silent mis-split.
    expect(parseGlobs("{a,b")).toEqual(["{a,b"]);
    // An unbalanced CLOSE brace keeps depth at floor 0, so the comma still
    // splits.
    expect(parseGlobs("a,b}")).toEqual(["a", "b}"]);
  });

  it("keeps a trailing backslash without consuming a missing next char", () => {
    expect(parseGlobs("a\\")).toEqual(["a\\"]);
  });
});
