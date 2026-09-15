import { describe, expect, it } from "vitest";
import {
  STYLE_TWEAK_MAX_DECLARATIONS,
  commentWithStyleTweaks,
  describeStyleTweaks,
  parseStyleDeclarations,
  type BrowserStyleTweak,
} from "../browser-style-tweaks";

function tweak(
  selector: string,
  property: string,
  previousValue: string,
  value: string,
): BrowserStyleTweak {
  return { selector, property, previousValue, value };
}

describe("parseStyleDeclarations", () => {
  it("reads a declaration list the way a stylesheet would", () => {
    expect(parseStyleDeclarations("padding: 12px; color: #333")).toEqual([
      { property: "padding", value: "12px" },
      { property: "color", value: "#333" },
    ]);
  });

  it("tolerates a trailing semicolon and stray whitespace", () => {
    expect(parseStyleDeclarations("  font-size :  15px ;  ")).toEqual([
      { property: "font-size", value: "15px" },
    ]);
  });

  it("skips a half-typed declaration instead of guessing", () => {
    // The input is a textarea mid-keystroke; incomplete is the normal state.
    expect(parseStyleDeclarations("color: red; font-siz")).toEqual([
      { property: "color", value: "red" },
    ]);
  });

  it("keeps a value containing colons intact", () => {
    expect(
      parseStyleDeclarations("background: url(https://example.com/a.png)"),
    ).toEqual([
      { property: "background", value: "url(https://example.com/a.png)" },
    ]);
  });

  it("lowercases property names, which CSS treats case-insensitively", () => {
    expect(parseStyleDeclarations("Font-Weight: 600")).toEqual([
      { property: "font-weight", value: "600" },
    ]);
  });

  it("allows a custom property, which is how a themed page is tuned", () => {
    expect(parseStyleDeclarations("--brand-accent: #0af")).toEqual([
      { property: "--brand-accent", value: "#0af" },
    ]);
  });

  it("refuses text that is not a property name", () => {
    // This string reaches `setProperty`, where a non-property is a silent no-op
    // that would still be recorded as a tweak.
    expect(parseStyleDeclarations("color red: blue")).toEqual([]);
    expect(parseStyleDeclarations("<script>: 1")).toEqual([]);
    expect(parseStyleDeclarations("-: 1")).toEqual([]);
  });

  it("drops a declaration with no value", () => {
    expect(parseStyleDeclarations("color:   ; padding: 4px")).toEqual([
      { property: "padding", value: "4px" },
    ]);
  });

  it("bounds how many declarations one annotation carries", () => {
    const many = Array.from(
      { length: STYLE_TWEAK_MAX_DECLARATIONS + 10 },
      (_, index) => `margin-top: ${String(index)}px`,
    ).join(";");
    expect(parseStyleDeclarations(many).length).toBe(
      STYLE_TWEAK_MAX_DECLARATIONS,
    );
  });

  it("bounds a single enormous value", () => {
    const parsed = parseStyleDeclarations(`content: "${"x".repeat(5_000)}"`);
    expect((parsed[0]?.value ?? "").length).toBeLessThanOrEqual(300);
  });

  it("answers empty for empty input", () => {
    expect(parseStyleDeclarations("")).toEqual([]);
    expect(parseStyleDeclarations("   ")).toEqual([]);
  });
});

describe("describeStyleTweaks", () => {
  it("says what changed and what it was", () => {
    const summary = describeStyleTweaks([
      tweak("button.save", "font-size", "13px", "15px"),
    ]);
    // The previous value is what makes the tweak legible as a CHANGE, and what
    // an agent looks for in the stylesheet.
    expect(summary).toContain("button.save");
    expect(summary).toContain("font-size: 15px (was 13px)");
  });

  it("groups by element, the shape a stylesheet edit takes", () => {
    const summary = describeStyleTweaks([
      tweak("button.save", "color", "#111", "#fff"),
      tweak("button.save", "background-color", "#eee", "#06c"),
      tweak("nav", "gap", "4px", "12px"),
    ]);
    expect(summary.match(/button\.save/g)?.length).toBe(1);
    expect(summary).toContain("nav");
  });

  it("is empty when nothing was tried", () => {
    expect(describeStyleTweaks([])).toBe("");
  });
});

describe("commentWithStyleTweaks", () => {
  it("keeps the user's words first and unedited", () => {
    const merged = commentWithStyleTweaks("Make this stand out", [
      tweak("button.save", "font-weight", "400", "600"),
    ]);
    expect(merged.startsWith("Make this stand out")).toBe(true);
    expect(merged).toContain("font-weight: 600 (was 400)");
  });

  it("carries the tweaks alone when there is no comment", () => {
    const merged = commentWithStyleTweaks("   ", [
      tweak("nav", "gap", "4px", "12px"),
    ]);
    // The tweaks are a complete enough instruction on their own.
    expect(merged.startsWith("Style tweaks")).toBe(true);
  });

  it("leaves a comment untouched when nothing was tried", () => {
    expect(commentWithStyleTweaks("Just this", [])).toBe("Just this");
  });

  it("keeps custom property casing, which is significant", () => {
    // --Brand and --brand are different properties; lowercasing set one the
    // page never declared.
    expect(parseStyleDeclarations("--Brand: #fff")).toEqual([
      { property: "--Brand", value: "#fff" },
    ]);
  });

  it("still lowercases ordinary property names, which are not", () => {
    expect(parseStyleDeclarations("COLOR: red")).toEqual([
      { property: "color", value: "red" },
    ]);
  });

  it("accepts an underscore in a custom property name", () => {
    expect(parseStyleDeclarations("--brand_alt: #000")).toEqual([
      { property: "--brand_alt", value: "#000" },
    ]);
  });
});

/**
 * Both delimiters occur inside legal CSS values, so splitting on them naively
 * destroyed exactly the declarations that are hardest to retype.
 */
describe("parseStyleDeclarations structural splitting", () => {
  it("keeps a data URL whole, semicolon and colon and all", () => {
    const declarations = parseStyleDeclarations(
      "background-image: url(data:image/png;base64,AAAA)",
    );

    expect(declarations).toEqual([
      { property: "background-image", value: "url(data:image/png;base64,AAAA)" },
    ]);
  });

  it("keeps a semicolon inside a quoted string", () => {
    expect(parseStyleDeclarations('content: "a;b"')).toEqual([
      { property: "content", value: '"a;b"' },
    ]);
  });

  it("keeps a colon inside a quoted string out of the property name", () => {
    expect(parseStyleDeclarations('content: "a:b"')).toEqual([
      { property: "content", value: '"a:b"' },
    ]);
  });

  it("still separates real declarations after a tricky value", () => {
    const declarations = parseStyleDeclarations(
      "background: url(data:image/png;base64,AA); color: red",
    );

    expect(declarations).toEqual([
      { property: "background", value: "url(data:image/png;base64,AA)" },
      { property: "color", value: "red" },
    ]);
  });

  it("tolerates an escaped quote inside a string", () => {
    const declarations = parseStyleDeclarations('content: "a\\";b"; color: red');

    // The VALUE is the point: the escaped quote does not close the string, so the
    // semicolon after it is still inside one. Asserting only the property names
    // would pass on a parser that split there and truncated the value.
    expect(declarations).toEqual([
      { property: "content", value: '"a\\";b"' },
      { property: "color", value: "red" },
    ]);
  });

  it("does not split inside a comment", () => {
    const declarations = parseStyleDeclarations(
      "color: red /* ; not a split : here */; margin: 0",
    );

    // Values asserted, not just names: a parser that split at the comment's
    // semicolon still produces "color" and "margin" while mangling what they say.
    expect(declarations).toEqual([
      { property: "color", value: "red /* ; not a split : here */" },
      { property: "margin", value: "0" },
    ]);
  });

  it("keeps a semicolon nested two parentheses deep", () => {
    // One level of nesting would be caught by a naive depth flag; two is what
    // distinguishes a counter from a boolean.
    expect(
      parseStyleDeclarations(
        "background: image-set(url(data:image/png;base64,AA) 1x); color: red",
      ),
    ).toEqual([
      {
        property: "background",
        value: "image-set(url(data:image/png;base64,AA) 1x)",
      },
      { property: "color", value: "red" },
    ]);
  });

  it("keeps a declaration typed before an unbalanced parenthesis", () => {
    // Half-typed text is the normal state of this textarea. The earlier
    // declaration must survive the unclosed one rather than being swallowed by
    // it, which is what a depth counter that never reset would do.
    //
    // The unfinished one is passed through rather than judged: validating CSS is
    // not this parser's job, and `setProperty` refuses a value it cannot parse -
    // which is exactly why the tweak report reads the inline style back instead
    // of trusting what was typed.
    expect(parseStyleDeclarations("color: red; background: url(")).toEqual([
      { property: "color", value: "red" },
      { property: "background", value: "url(" },
    ]);
  });

  it("keeps a declaration typed before an unterminated string", () => {
    expect(parseStyleDeclarations('color: red; content: "abc')).toEqual([
      { property: "color", value: "red" },
      { property: "content", value: '"abc' },
    ]);
  });

  it("keeps a declaration typed before an unterminated comment", () => {
    expect(parseStyleDeclarations("color: red; margin: 0 /* open")).toEqual([
      { property: "color", value: "red" },
      { property: "margin", value: "0 /* open" },
    ]);
  });

  it("does not let a stray closing parenthesis break later splitting", () => {
    // Depth must clamp at zero: going negative would make every later
    // delimiter look nested.
    expect(parseStyleDeclarations("color: red); margin: 0")).toEqual([
      { property: "color", value: "red)" },
      { property: "margin", value: "0" },
    ]);
  });
});

describe("describeStyleTweaks bounds", () => {
  it("stays within the character cap, marker included", () => {
    // The previous form sliced to the limit and THEN appended the marker, so the
    // returned string was longer than the bound it exists to enforce.
    const tweaks = Array.from({ length: 200 }, (_, index) => ({
      selector: `#row-${index}`,
      property: "background-image",
      value: "x".repeat(300),
      previousValue: "y".repeat(300),
    }));

    const summary = describeStyleTweaks(tweaks);
    expect(summary.length).toBeLessThanOrEqual(4_000);
    expect(summary.endsWith("(truncated)")).toBe(true);
  });

  it("says when it stopped, so a partial list is not read as the whole intent", () => {
    const tweaks = Array.from({ length: 200 }, (_, index) => ({
      selector: `#row-${index}`,
      property: "color",
      value: "red",
      previousValue: "blue",
    }));

    expect(describeStyleTweaks(tweaks)).toContain("omitted");
  });

  it("returns an unbounded-looking summary untouched when it is small", () => {
    const summary = describeStyleTweaks([
      { selector: "#a", property: "color", value: "red", previousValue: "blue" },
    ]);

    expect(summary).toContain("color: red (was blue)");
    expect(summary).not.toContain("truncated");
  });
});

describe("parseStyleDeclarations escapes outside strings", () => {
  it("keeps an escaped semicolon in a custom property value", () => {
    // CSS removes the syntactic meaning of an escaped code point, so this is one
    // declaration, not two.
    expect(parseStyleDeclarations("--x: a\\;b; color: red")).toEqual([
      { property: "--x", value: "a\\;b" },
      { property: "color", value: "red" },
    ]);
  });

  it("keeps an escaped colon out of the property split", () => {
    expect(parseStyleDeclarations("--y: a\\:b")).toEqual([
      { property: "--y", value: "a\\:b" },
    ]);
  });

  it("does not run past the end on a trailing backslash", () => {
    expect(() => parseStyleDeclarations("color: red\\")).not.toThrow();
  });
});
