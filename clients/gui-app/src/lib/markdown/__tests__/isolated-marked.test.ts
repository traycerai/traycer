import { describe, expect, it } from "vitest";
import { marked } from "marked";
import type { TokenizerExtension, Tokens } from "marked";
import { createIsolatedMarked } from "../isolated-marked";

/**
 * A minimal inline tokenizer recognizing `@@word@@`, matching the shape
 * `@tiptap/markdown` extensions register (see `Underline`'s `markdownTokenizer`).
 */
function buildTokenizerExtension(name: string): TokenizerExtension {
  return {
    name,
    level: "inline",
    start: (src: string) => src.indexOf("@@"),
    tokenizer(src): Tokens.Generic | undefined {
      const match = /^@@(\w+)@@/.exec(src);
      return match ? { type: name, raw: match[0], text: match[1] } : undefined;
    },
  };
}

describe("createIsolatedMarked", () => {
  it("keeps use() registrations private to the instance that registered them, leaving the real singleton untouched", () => {
    const realDefaultsBefore = marked.defaults;

    const a = createIsolatedMarked();
    const b = createIsolatedMarked();
    const extensionA = buildTokenizerExtension("isolatedTokenA");

    a.use({ extensions: [extensionA] });

    expect(a.defaults.extensions?.inline).toContain(extensionA.tokenizer);
    expect(b.defaults.extensions?.inline ?? []).not.toContain(
      extensionA.tokenizer,
    );
    // The real module-level singleton was never touched: same reference.
    expect(marked.defaults).toBe(realDefaultsBefore);
  });

  it("re-points defaults on use() so a lexer built from them applies the registered tokenizer", () => {
    const a = createIsolatedMarked();
    const tokenName = "isolatedTokenLex";
    a.use({ extensions: [buildTokenizerExtension(tokenName)] });

    const lexer = new a.Lexer(a.defaults);
    const tokens = lexer.inlineTokens("@@hello@@");

    const customToken = tokens.find(
      (token): token is Tokens.Generic => token.type === tokenName,
    );
    expect(customToken).toBeDefined();
    expect(customToken?.text).toBe("hello");
  });

  it("is self-referential and callable like the real marked module", () => {
    const a = createIsolatedMarked();

    expect(a.parse).toBe(a);
    expect(a("**x**", { async: false })).toContain("<strong>x</strong>");
  });

  it("setOptions returns the same object and re-points defaults", () => {
    const a = createIsolatedMarked();

    const result = a.setOptions({ breaks: true });

    expect(result).toBe(a);
    expect(a.defaults.breaks).toBe(true);
  });
});
