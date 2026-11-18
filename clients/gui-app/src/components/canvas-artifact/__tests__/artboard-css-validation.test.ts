import { setAttribute } from "@traycer/html-source";
import { describe, expect, it, vi } from "vitest";
import {
  browserSupportsCss,
  validateArtboardCss,
  type ArtboardCssDeclaration,
} from "../artboard-css-validation";

// The scanner only splits declarations; whether a value is valid CSS is the
// browser's call. Most tests inject a `supports` that accepts everything, so
// they pin the scanner's boundaries and nothing about CSS grammar.
const acceptAll = (): boolean => true;

function declarationsOf(text: string): readonly ArtboardCssDeclaration[] {
  const result = validateArtboardCss(text, acceptAll);
  if (!result.ok) throw new Error(`expected ok, got ${result.detail}`);
  return result.declarations;
}

function detailOf(
  text: string,
  supports: (p: string, v: string) => boolean,
): string {
  const result = validateArtboardCss(text, supports);
  if (result.ok) throw new Error("expected a refusal");
  return result.detail;
}

describe("validateArtboardCss splitting", () => {
  it("reads declarations separated by semicolons, with or without a trailing one", () => {
    const expected = [
      { property: "color", value: "red" },
      { property: "width", value: "10px" },
    ];
    expect(declarationsOf("color: red; width: 10px")).toEqual(expected);
    expect(declarationsOf("color: red; width: 10px;")).toEqual(expected);
    expect(declarationsOf("\n  color: red;\n  width: 10px;\n")).toEqual(
      expected,
    );
  });

  it("accepts empty and whitespace-only text as no declarations", () => {
    expect(declarationsOf("")).toEqual([]);
    expect(declarationsOf("  \n ; ; ")).toEqual([]);
  });

  it("splits at the first colon only, keeping later colons in the value", () => {
    expect(declarationsOf("background: url(http://x/y.png)")).toEqual([
      { property: "background", value: "url(http://x/y.png)" },
    ]);
  });

  it("lower-cases a standard property and keeps a custom one as written", () => {
    expect(declarationsOf("COLOR: Red; --Brand_Color: #FFF")).toEqual([
      { property: "color", value: "Red" },
      { property: "--Brand_Color", value: "#FFF" },
    ]);
  });

  it("accepts vendor-prefixed properties", () => {
    expect(declarationsOf("-webkit-box-shadow: 0 0 1px red")).toEqual([
      { property: "-webkit-box-shadow", value: "0 0 1px red" },
    ]);
  });

  describe("semicolons that are not separators", () => {
    it("ignores a semicolon inside parentheses", () => {
      expect(
        declarationsOf(
          "background: url(data:image/png;base64,AAAA); color: red",
        ),
      ).toEqual([
        { property: "background", value: "url(data:image/png;base64,AAAA)" },
        { property: "color", value: "red" },
      ]);
    });

    it("ignores a semicolon inside nested parentheses and brackets", () => {
      expect(declarationsOf("--x: f(g(a;b) [c;d]); color: red")).toEqual([
        { property: "--x", value: "f(g(a;b) [c;d])" },
        { property: "color", value: "red" },
      ]);
    });

    it("ignores a semicolon inside a double or single quoted string", () => {
      expect(declarationsOf(`font-family: "a;b", 'c;d'; color: red`)).toEqual([
        { property: "font-family", value: `"a;b", 'c;d'` },
        { property: "color", value: "red" },
      ]);
    });

    it("keeps an escaped quote from ending the string", () => {
      expect(declarationsOf(String.raw`content: "a\";b"; color: red`)).toEqual([
        { property: "content", value: String.raw`"a\";b"` },
        { property: "color", value: "red" },
      ]);
    });

    it("treats an escaped semicolon as part of the value", () => {
      expect(declarationsOf(String.raw`--x: a\;b; color: red`)).toEqual([
        { property: "--x", value: String.raw`a\;b` },
        { property: "color", value: "red" },
      ]);
    });

    it("keeps comment-looking text inside an unquoted url() untouched", () => {
      const supports = vi.fn((_property: string, _value: string) => true);
      expect(
        validateArtboardCss("background: url(a/*b*/c); color: red", supports),
      ).toEqual({
        ok: true,
        declarations: [
          { property: "background", value: "url(a/*b*/c)" },
          { property: "color", value: "red" },
        ],
      });
      expect(supports.mock.calls[0]).toEqual(["background", "url(a/*b*/c)"]);
    });

    it("does not start a comment inside a string", () => {
      expect(declarationsOf(`content: "/* x */"; color: red`)).toEqual([
        { property: "content", value: `"/* x */"` },
        { property: "color", value: "red" },
      ]);
    });

    it("ignores a semicolon inside a comment", () => {
      expect(
        declarationsOf("color: red /* ; width: 1px */; height: 2px"),
      ).toEqual([
        { property: "color", value: "red" },
        { property: "height", value: "2px" },
      ]);
    });
  });

  describe("comments", () => {
    it("drops a leading, trailing or interior comment from the value", () => {
      expect(declarationsOf("/* a */ color: /* b */ red /* c */")).toEqual([
        { property: "color", value: "red" },
      ]);
    });

    it("reads a comment as a space, so it cannot glue a name together", () => {
      expect(detailOf("col/**/or: red", acceptAll)).toBe(
        "Invalid declaration: col or: red",
      );
    });

    it("accepts a comment-only input as no declarations", () => {
      expect(declarationsOf("/* nothing here */")).toEqual([]);
    });

    it("refuses an unterminated comment", () => {
      expect(detailOf("color: red; /* open", acceptAll)).toBe(
        "Invalid declaration: unfinished value",
      );
    });
  });

  describe("custom properties", () => {
    it("passes a custom property and its value to the browser unchanged", () => {
      const supports = vi.fn((_property: string, _value: string) => true);
      const result = validateArtboardCss(
        "--brand-color: #fff; --n_1: 1",
        supports,
      );
      expect(result).toEqual({
        ok: true,
        declarations: [
          { property: "--brand-color", value: "#fff" },
          { property: "--n_1", value: "1" },
        ],
      });
      expect(supports.mock.calls).toEqual([
        ["--brand-color", "#fff"],
        ["--n_1", "1"],
      ]);
    });

    it("refuses a bare double dash", () => {
      expect(detailOf("--: x", acceptAll)).toBe("Invalid declaration: --: x");
    });
  });

  describe("!important", () => {
    it("keeps the priority in the value but asks the browser about the value alone", () => {
      const supports = vi.fn((_property: string, _value: string) => true);
      const result = validateArtboardCss(
        "color: red !important; width: 1px ! IMPORTANT",
        supports,
      );
      expect(result).toEqual({
        ok: true,
        declarations: [
          { property: "color", value: "red !important" },
          { property: "width", value: "1px ! IMPORTANT" },
        ],
      });
      expect(supports.mock.calls).toEqual([
        ["color", "red"],
        ["width", "1px"],
      ]);
    });

    it("refuses a priority with no value", () => {
      expect(detailOf("color: !important", acceptAll)).toBe(
        "Invalid declaration: color: !important",
      );
    });
  });
});

describe("validateArtboardCss refusals", () => {
  it("reports the first invalid declaration and asks the browser about no later one", () => {
    const supports = vi.fn(
      (_property: string, value: string) => value !== "banana",
    );
    expect(
      detailOf("color: red; width: banana; height: nope; margin: 0", supports),
    ).toBe("Invalid declaration: width: banana");
    expect(supports.mock.calls.map(([property]) => property)).toEqual([
      "color",
      "width",
    ]);
  });

  it("reports a declaration with no colon by its text", () => {
    expect(detailOf("color: red; nonsense; width: 1px", acceptAll)).toBe(
      "Invalid declaration: nonsense",
    );
  });

  it.each([
    [": red", "a missing property"],
    ["1color: red", "a digit-led property"],
    ["co lor: red", "a property with a space"],
    ["color:", "a missing value"],
    ["color:   ", "a blank value"],
  ])("refuses %j (%s)", (text) => {
    const result = validateArtboardCss(text, acceptAll);
    expect(result.ok).toBe(false);
  });

  it("refuses what the browser rejects, using the whole declaration as the message", () => {
    expect(detailOf("color: notacolor", () => false)).toBe(
      "Invalid declaration: color: notacolor",
    );
  });

  it("shortens a very long declaration in the message", () => {
    const detail = detailOf(`color: ${"a".repeat(500)}`, () => false);
    expect(detail).toBe(`Invalid declaration: color: ${"a".repeat(113)}`);
  });

  describe("unbalanced input", () => {
    it.each([
      ["width: calc(1px;", "an unclosed parenthesis"],
      ["--x: [1px", "an unclosed bracket"],
      [`font-family: "abc`, "an unclosed double quote"],
      [`font-family: 'abc`, "an unclosed single quote"],
      [String.raw`color: red\ `.trimEnd(), "a trailing escape"],
    ])("refuses %j (%s)", (text) => {
      expect(validateArtboardCss(text, acceptAll).ok).toBe(false);
    });

    it("refuses a closer with no opener, naming it", () => {
      expect(detailOf("width: 1px)", acceptAll)).toBe(
        "Invalid declaration: width: 1px)",
      );
    });

    it("refuses a closer that does not match its opener", () => {
      expect(detailOf("--x: [1px)", acceptAll)).toBe(
        "Invalid declaration: --x: [1px)",
      );
    });

    it("refuses a stray brace that would end the block early", () => {
      expect(
        validateArtboardCss("color: red; } width: 1px", acceptAll).ok,
      ).toBe(false);
    });

    it("never asks the browser about an unbalanced tail", () => {
      const supports = vi.fn((_property: string, _value: string) => true);
      validateArtboardCss("color: red; width: calc(1px", supports);
      expect(supports.mock.calls).toEqual([["color", "red"]]);
    });
  });
});

describe("browserSupportsCss", () => {
  // These ride the environment's own CSS parser; the cases are the plainest
  // ones both a real browser and jsdom agree on.
  it.skipIf(typeof CSS === "undefined")("defers to CSS.supports", () => {
    expect(browserSupportsCss("color", "red")).toBe(true);
    expect(browserSupportsCss("color", "notacolor")).toBe(false);
    expect(browserSupportsCss("width", "10px")).toBe(true);
    expect(browserSupportsCss("width", "banana")).toBe(false);
  });

  it.skipIf(typeof CSS === "undefined")(
    "lets the scanner end to end accept real values and refuse a bad one",
    () => {
      expect(
        validateArtboardCss(
          "color: red; width: 10px !important; --x: anything;",
          browserSupportsCss,
        ),
      ).toEqual({
        ok: true,
        declarations: [
          { property: "color", value: "red" },
          { property: "width", value: "10px !important" },
          { property: "--x", value: "anything" },
        ],
      });
      expect(
        validateArtboardCss("color: red; width: banana", browserSupportsCss),
      ).toEqual({ ok: false, detail: "Invalid declaration: width: banana" });
    },
  );
});

// The panel writes the typed text into the element's style attribute as is, so
// what matters is that the text survives the source edit and the DOM parse
// untouched, and that the document's own cascade then decides the outcome.
// jsdom (cssstyle 5, jsdom 30) is not a browser here: for `margin: 10px;
// margin-left: 5px` its style declaration parser AND getComputedStyle both
// report margin-left as 10px, where a browser reports 5px (a later longhand
// beats an earlier shorthand). So that ordering case is pinned as exact text
// fidelity only, and its real outcome needs a real browser. The cases below
// that assert an effective value are the ones jsdom resolves like a browser.
describe("a typed style in the document", () => {
  function elementWithStyle(style: string): HTMLElement {
    const edited = setAttribute(
      '<div class="t">x</div>',
      { kind: "position", startTagOffset: 0, tagName: "div" },
      "style",
      style,
    );
    if (!edited.ok) throw new Error(`style write refused: ${edited.reason}`);
    document.body.innerHTML = edited.text;
    const element = document.querySelector<HTMLElement>(".t");
    if (element === null) throw new Error("no element");
    return element;
  }

  it.each([
    "margin: 10px; margin-left: 5px",
    "margin-left: 5px; margin: 10px",
    "color: red; /* kept */ color: blue",
    "font-family: \"a;b\", serif; content: 'x'",
    "color: red !important;\n  width: 1px",
  ])("keeps %j exactly as written", (style) => {
    expect(elementWithStyle(style).getAttribute("style")).toBe(style);
  });

  it("lets a later duplicate win", () => {
    const element = elementWithStyle("color: red; color: blue");
    expect(getComputedStyle(element).color).toBe("rgb(0, 0, 255)");
  });

  it("lets an earlier !important beat a later ordinary duplicate", () => {
    const element = elementWithStyle("color: red !important; color: blue");
    expect(getComputedStyle(element).color).toBe("rgb(255, 0, 0)");
  });

  it("ignores a comment between duplicates", () => {
    const element = elementWithStyle("color: red; /* c */ color: blue");
    expect(getComputedStyle(element).color).toBe("rgb(0, 0, 255)");
  });

  it("lets an !important longhand beat a later shorthand", () => {
    const element = elementWithStyle(
      "margin-left: 5px !important; margin: 10px",
    );
    expect(getComputedStyle(element).marginLeft).toBe("5px");
  });
});
