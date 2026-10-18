import { describe, expect, it } from "vitest";

import {
  readRootCustomProperties,
  setRootCustomProperty,
  type RootCustomProperty,
  type SourceSplice,
} from "../index";

const BOM = "﻿";

function page(css: string): string {
  return `<!doctype html><html><head><style>${css}</style></head><body></body></html>`;
}

function applySplices(
  original: string,
  splices: readonly SourceSplice[],
): string {
  let output = "";
  let cursor = 0;
  for (const splice of splices) {
    expect(splice.start).toBeGreaterThanOrEqual(cursor);
    expect(splice.end).toBeLessThanOrEqual(original.length);
    output += original.slice(cursor, splice.start) + splice.replacement;
    cursor = splice.end;
  }
  return output + original.slice(cursor);
}

function properties(text: string): readonly RootCustomProperty[] {
  const result = readRootCustomProperties(text);
  if (!result.ok) throw new Error(`expected properties, got ${result.reason}`);
  return result.properties;
}

function readMiss(text: string): string {
  const result = readRootCustomProperties(text);
  if (result.ok) throw new Error("expected a miss");
  return result.reason;
}

function set(text: string, name: string, value: string | null) {
  const result = setRootCustomProperty(text, name, value);
  if (!result.ok) throw new Error(`expected an edit, got ${result.reason}`);
  expect(applySplices(text, result.splices)).toBe(result.text);
  return result;
}

function setMiss(text: string, name: string, value: string | null): string {
  const result = setRootCustomProperty(text, name, value);
  if (result.ok) throw new Error(`expected a refusal, got ${result.text}`);
  return result.reason;
}

describe("readRootCustomProperties", () => {
  it("lists custom properties with their raw values, leaving ordinary declarations out", () => {
    expect(properties(page(":root{--a:1;--b: #fff;color:red}"))).toEqual([
      { name: "--a", value: "1", important: false },
      { name: "--b", value: "#fff", important: false },
    ]);
  });

  it("reads the first top-level :root of the first style element only", () => {
    expect(properties(page(":root{--a:1} :root{--b:2}"))).toEqual([
      { name: "--a", value: "1", important: false },
    ]);
    expect(readMiss("<style>body{}</style><style>:root{--a:1}</style>")).toBe(
      "missing-root",
    );
  });

  it("ignores a :root nested in an at-rule and finds the later top-level one", () => {
    expect(
      properties(page("@media (min-width:1px){:root{--m:9}} :root{--a:1}")),
    ).toEqual([{ name: "--a", value: "1", important: false }]);
  });

  it("finds the selector past comments and in any case, but not as part of a longer selector", () => {
    expect(properties(page("/* c */ :root /* d */ {--a:1}"))).toHaveLength(1);
    expect(properties(page(":ROOT{--a:1}"))).toHaveLength(1);
    expect(readMiss(page("html:root{--a:1}"))).toBe("missing-root");
    expect(readMiss(page("body{--a:1}"))).toBe("missing-root");
  });

  describe("which declaration wins", () => {
    it("is the last of the same name", () => {
      expect(properties(page(":root{--a:1;--a:2}"))).toEqual([
        { name: "--a", value: "2", important: false },
      ]);
    });

    it("is an earlier !important over a later ordinary one", () => {
      expect(properties(page(":root{--a:1 !important;--a:2}"))).toEqual([
        { name: "--a", value: "1", important: true },
      ]);
    });

    it("is a later !important over an earlier ordinary one", () => {
      expect(properties(page(":root{--a:1;--a:2 !important}"))).toEqual([
        { name: "--a", value: "2", important: true },
      ]);
    });

    it("keeps names that differ only in case apart", () => {
      expect(properties(page(":root{--A:1;--a:2}"))).toEqual([
        { name: "--A", value: "1", important: false },
        { name: "--a", value: "2", important: false },
      ]);
    });
  });

  describe("values the scanner must not split", () => {
    it("keeps a semicolon inside a string or a url()", () => {
      expect(properties(page(':root{--a:"x;y";--b:2}'))).toEqual([
        { name: "--a", value: '"x;y"', important: false },
        { name: "--b", value: "2", important: false },
      ]);
      expect(
        properties(page(":root{--a:url(data:image/png;base64,AAA);--b:2}")),
      ).toEqual([
        {
          name: "--a",
          value: "url(data:image/png;base64,AAA)",
          important: false,
        },
        { name: "--b", value: "2", important: false },
      ]);
    });

    it("keeps a nested block as part of the value", () => {
      expect(properties(page(":root{--a:{x:1};--b:2}"))).toEqual([
        { name: "--a", value: "{x:1}", important: false },
        { name: "--b", value: "2", important: false },
      ]);
    });

    it("reads CRLF source", () => {
      expect(
        properties(
          `${BOM}<style>\r\n:root {\r\n  --a: 1;\r\n  --b: 2;\r\n}\r\n</style>`,
        ),
      ).toEqual([
        { name: "--a", value: "1", important: false },
        { name: "--b", value: "2", important: false },
      ]);
    });
  });

  describe("misses", () => {
    it("reports a page without a style element", () => {
      expect(readMiss("<p>x</p>")).toBe("missing-style");
    });

    it("reports a style element without a :root rule", () => {
      expect(readMiss(page("body{--a:1}"))).toBe("missing-root");
    });

    it("reports a style the scanner cannot close", () => {
      expect(readMiss(page(":root{--a:1"))).toBe("malformed-style");
    });
  });
});

describe("setRootCustomProperty", () => {
  describe("changing a declaration", () => {
    it("replaces only the value of an existing one", () => {
      const original = page(":root{--a:1;--b:2}");
      const result = set(original, "--a", "9");
      expect(result.text).toBe(page(":root{--a:9;--b:2}"));
      expect(result.splices).toEqual([
        { start: 44, end: 45, replacement: "9" },
      ]);
    });

    it("keeps an existing !important", () => {
      const result = set(page(":root{--a:1 !important}"), "--a", "9");
      expect(result.text).toBe(page(":root{--a:9 !important}"));
    });

    it("changes the winning declaration when a name is declared twice", () => {
      const result = set(page(":root{--a:1;--a:2}"), "--a", "9");
      expect(result.text).toBe(page(":root{--a:1;--a:9}"));
    });

    it("appends a new declaration, inside an empty rule as well", () => {
      expect(set(page(":root{--a:1}"), "--b", "2").text).toBe(
        page(":root{--a:1; --b: 2}"),
      );
      expect(set(page(":root{}"), "--b", "2").text).toBe(page(":root{--b: 2}"));
    });

    it("accepts a quoted value holding a semicolon", () => {
      expect(set(page(":root{--a:1}"), "--a", '"x;y"').text).toBe(
        page(':root{--a:"x;y"}'),
      );
    });
  });

  describe("removing a declaration", () => {
    it("removes it with its semicolon", () => {
      const result = set(page(":root{--a:1;--b:2}"), "--a", null);
      expect(result.text).toBe(page(":root{--b:2}"));
    });

    it("removes every declaration of that name, and no other", () => {
      const result = set(page(":root{--a:1;--b:2;--a:3}"), "--a", null);
      expect(result.text).toBe(page(":root{--b:2;}"));
      expect(result.splices).toHaveLength(2);
    });

    it("changes nothing for a name that is not there", () => {
      const original = page(":root{--a:1}");
      const result = set(original, "--z", null);
      expect(result.text).toBe(original);
      expect(result.splices).toEqual([]);
    });
  });

  describe("everything else in the style stays byte for byte", () => {
    it("keeps comments", () => {
      expect(
        set(page(":root{/* keep */ --a:1; /* tail */}"), "--a", "2").text,
      ).toBe(page(":root{/* keep */ --a:2; /* tail */}"));
    });

    it("keeps strings and urls holding a semicolon", () => {
      expect(set(page(':root{--s:"a;b"; --a:1}'), "--a", "2").text).toBe(
        page(':root{--s:"a;b"; --a:2}'),
      );
      expect(set(page(":root{--u:url(a;b); --a:1}"), "--a", "2").text).toBe(
        page(":root{--u:url(a;b); --a:2}"),
      );
    });

    it("keeps an earlier at-rule that holds a :root of its own", () => {
      expect(
        set(page("@media x{:root{--m:1}} :root{--a:1}"), "--a", "2").text,
      ).toBe(page("@media x{:root{--m:1}} :root{--a:2}"));
    });

    it("keeps the BOM and every CRLF, adding the new declaration on the document's own lines", () => {
      const original = `${BOM}<style>\r\n:root {\r\n  --a: 1;\r\n}\r\n</style>`;
      expect(set(original, "--a", "7").text).toBe(
        `${BOM}<style>\r\n:root {\r\n  --a: 7;\r\n}\r\n</style>`,
      );
      const added = set(original, "--b", "2").text;
      expect(
        added.startsWith(`${BOM}<style>\r\n:root {\r\n  --a: 1;\r\n`),
      ).toBe(true);
      expect(added.endsWith("}\r\n</style>")).toBe(true);
      expect(added).toContain("--b: 2");
      expect(added.split("\r\n")).toHaveLength(original.split("\r\n").length);
      expect(added).not.toMatch(/[^\r]\n/);
    });

    it("writes the value raw: no HTML decoding or escaping", () => {
      expect(set(page(":root{--a:1}"), "--a", "'a' > \"b\"").text).toBe(
        page(":root{--a:'a' > \"b\"}"),
      );
    });
  });

  describe("refusals", () => {
    it.each([
      ["a value that would close the style element", "x</style><script>"],
      ["the same in another case and spacing", "x</STYLE >"],
      ["the same inside a CSS comment", "x/*</style>*/"],
      ["a NUL character", "x\0y"],
      ["a lone surrogate", "\ud800"],
      ["a semicolon outside a string", "a;b"],
      ["a stray closing brace", "a}b"],
      ["an unclosed parenthesis", "f("],
      ["an empty value", ""],
    ])("refuses %s", (_label, value) => {
      const original = page(":root{--a:1}");
      expect(setMiss(original, "--a", value)).toBe("invalid-style-value");
    });

    it.each(["color", "--a b", "--", "a", "--a;b", ""])(
      "refuses the property name %j",
      (name) => {
        expect(setMiss("<style>:root{--a:1}</style>", name, "1")).toBe(
          "invalid-style-property",
        );
      },
    );

    it("refuses a page without a style element or without a :root rule", () => {
      expect(setMiss("<p></p>", "--a", "1")).toBe("missing-style");
      expect(setMiss(page("body{}"), "--a", "1")).toBe("missing-root");
    });

    it("refuses a style it cannot close", () => {
      expect(setMiss(page(":root{--a:1"), "--a", "2")).toBe("malformed-style");
    });
  });

  it("reads back what it wrote", () => {
    const original = page(":root{--a:1}");
    const written = set(original, "--b", "#abc").text;
    expect(properties(written)).toEqual([
      { name: "--a", value: "1", important: false },
      { name: "--b", value: "#abc", important: false },
    ]);
    const removed = set(written, "--a", null).text;
    expect(properties(removed)).toEqual([
      { name: "--b", value: "#abc", important: false },
    ]);
  });
});
