import { describe, expect, it } from "vitest";
import {
  PHONE_LAYOUT_ONLY_CLASS,
  withPhoneTiersAtEveryWidth,
} from "../scripts/phone-tier-css";

describe("withPhoneTiersAtEveryWidth", () => {
  it("repeats a max-width tier under the installed app's class", () => {
    const css = "@media (max-width: 767px) {\n  .a { top: 0; }\n}";

    expect(withPhoneTiersAtEveryWidth(css)).toBe(
      `${css}\n.${PHONE_LAYOUT_ONLY_CLASS} {\n  .a { top: 0; }\n}\n`,
    );
  });

  it("repeats a coarse-pointer tier under the installed app's class", () => {
    const css = "@media (pointer: coarse) {\n  .b { height: 44px; }\n}";

    expect(withPhoneTiersAtEveryWidth(css)).toBe(
      `${css}\n.${PHONE_LAYOUT_ONLY_CLASS} {\n  .b { height: 44px; }\n}\n`,
    );
  });

  it("returns a stylesheet with no phone tier unchanged", () => {
    const css =
      "@media (min-width: 1024px) { .c { color: red; } }\n.d { x: 1; }";

    expect(withPhoneTiersAtEveryWidth(css)).toBe(css);
  });

  it("does not match a query quoted in a comment", () => {
    const css =
      "/* the @media (max-width: 767px) { tier below */\n.e { color: red; }\n";

    expect(withPhoneTiersAtEveryWidth(css)).toBe(css);
  });

  it("copies a tier whose body nests braces whole, and leaves what follows", () => {
    const css = [
      "@media (max-width: 767px) {",
      "  .f { &:hover { color: red; } }",
      "  .g { margin: 0; }",
      "}",
      ".after { x: 1; }",
    ].join("\n");

    const result = withPhoneTiersAtEveryWidth(css);

    expect(result).toBe(
      `${css.split("\n.after")[0]}\n.${PHONE_LAYOUT_ONLY_CLASS} {\n  .f { &:hover { color: red; } }\n  .g { margin: 0; }\n}\n\n.after { x: 1; }`,
    );
  });

  it("repeats every tier in the stylesheet, each with its own body", () => {
    const css =
      "@media (max-width: 767px) { .h { a: 1; } }\n@media (pointer: coarse) { .i { b: 2; } }";

    const result = withPhoneTiersAtEveryWidth(css);

    expect(result).toContain(`.${PHONE_LAYOUT_ONLY_CLASS} { .h { a: 1; } }`);
    expect(result).toContain(`.${PHONE_LAYOUT_ONLY_CLASS} { .i { b: 2; } }`);
    expect(result.split(`.${PHONE_LAYOUT_ONLY_CLASS} {`)).toHaveLength(3);
  });

  it("throws on a tier that never closes", () => {
    expect(() =>
      withPhoneTiersAtEveryWidth("@media (max-width: 767px) { .j { a: 1; }"),
    ).toThrow(/Unbalanced phone tier/);
  });
});
