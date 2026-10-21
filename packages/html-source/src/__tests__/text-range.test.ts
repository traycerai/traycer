import { describe, expect, it } from "vitest";

import {
  parseHtmlSource,
  unwrapTextRange,
  wrapTextRange,
  type EditResult,
  type ElementLocator,
  type SourceSplice,
  type TextFormatTag,
} from "../index";

const BOM = "﻿";

// Offsets count UTF-16 units of the element's DECODED textContent (so `&amp;`
// is one unit and a CRLF in the source is one), while the splices are ranges of
// the source bytes. Every success is therefore checked twice: the returned text
// against an expected string, and the splices re-applied to the original.

function at(text: string, startTag: string): ElementLocator {
  const startTagOffset = text.indexOf(startTag);
  if (startTagOffset < 0) throw new Error(`fixture has no ${startTag}`);
  const tagName = /^<([a-z0-9]+)/i.exec(startTag)?.[1];
  if (tagName === undefined) throw new Error("start tag has no name");
  return { kind: "position", startTagOffset, tagName };
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

function success(
  original: string,
  result: EditResult,
): { text: string; splices: SourceSplice[] } {
  if (!result.ok) throw new Error(`expected an edit, got ${result.reason}`);
  expect(applySplices(original, result.splices)).toBe(result.text);
  return result;
}

function refusal(result: EditResult): string {
  if (result.ok) throw new Error(`expected a refusal, got ${result.text}`);
  return result.reason;
}

function wrap(
  original: string,
  startTag: string,
  start: number,
  end: number,
  tag: TextFormatTag,
  href: string | null,
): EditResult {
  return wrapTextRange(original, at(original, startTag), start, end, tag, href);
}

function unwrap(
  original: string,
  startTag: string,
  start: number,
  end: number,
  tag: TextFormatTag,
): EditResult {
  return unwrapTextRange(original, at(original, startTag), start, end, tag);
}

describe("wrapTextRange", () => {
  it("wraps the selection and splices only the selected bytes", () => {
    const original = "<p>Hello world</p>";
    const result = success(original, wrap(original, "<p", 0, 5, "b", null));
    expect(result.text).toBe("<p><b>Hello</b> world</p>");
    expect(result.splices).toEqual([
      { start: 3, end: 8, replacement: "<b>Hello</b>" },
    ]);
  });

  it.each(["b", "i", "u"] as const)("writes a bare <%s> wrapper", (tag) => {
    const original = "<p>Hello world</p>";
    const result = success(original, wrap(original, "<p", 6, 11, tag, null));
    expect(result.text).toBe(`<p>Hello <${tag}>world</${tag}></p>`);
  });

  it("offsets past a byte-order mark are in decoded text, the BOM not counting", () => {
    const original = `${BOM}<p>Hello world</p>`;
    const result = success(original, wrap(original, "<p", 3, 8, "i", null));
    expect(result.text).toBe(`${BOM}<p>Hel<i>lo wo</i>rld</p>`);
    expect(result.splices).toEqual([
      { start: 7, end: 12, replacement: "<i>lo wo</i>" },
    ]);
  });

  it("counts a CRLF as one unit and leaves every CRLF outside the selection alone", () => {
    const original = `${BOM}<p>line1\r\nHello world</p>\r\n`;
    const result = success(original, wrap(original, "<p", 6, 11, "u", null));
    expect(result.text).toBe(`${BOM}<p>line1\r\n<u>Hello</u> world</p>\r\n`);
    expect(result.splices).toEqual([
      { start: 11, end: 16, replacement: "<u>Hello</u>" },
    ]);
  });

  it("keeps a CRLF that sits inside the selection", () => {
    const original = `${BOM}<p>line1\r\nHello</p>`;
    const result = success(original, wrap(original, "<p", 3, 8, "b", null));
    expect(result.text).toBe(`${BOM}<p>lin<b>e1\r\nHe</b>llo</p>`);
  });

  describe("entities", () => {
    it("selects a whole entity as the one unit it decodes to, and writes it escaped", () => {
      const original = "<p>a &amp; b</p>";
      const result = success(original, wrap(original, "<p", 2, 3, "b", null));
      expect(result.text).toBe("<p>a <b>&amp;</b> b</p>");
      expect(result.splices).toEqual([
        { start: 5, end: 10, replacement: "<b>&amp;</b>" },
      ]);
    });

    it("escapes a decoded less-than sign", () => {
      const original = "<p>a &lt; b</p>";
      const result = success(original, wrap(original, "<p", 2, 3, "b", null));
      expect(result.text).toBe("<p>a <b>&lt;</b> b</p>");
    });

    it("lets a selection start or end beside an entity", () => {
      const original = "<p>a &amp; b</p>";
      const result = success(original, wrap(original, "<p", 1, 3, "b", null));
      expect(result.text).toBe("<p>a<b> &amp;</b> b</p>");
    });

    it("covers the whole source of an entity that decodes to two code points", () => {
      const original = "<p>x&NotEqualTilde;y</p>";
      const result = success(original, wrap(original, "<p", 1, 3, "b", null));
      expect(result.splices).toHaveLength(1);
      expect(result.splices[0].start).toBe(original.indexOf("&"));
      expect(result.splices[0].end).toBe(original.indexOf("y"));
      expect(result.splices[0].replacement).toMatch(/^<b>.*<\/b>$/su);
      const wrapper = parseHtmlSource(result.text).elements.find(
        (element) => element.tagName === "b",
      );
      expect(
        wrapper?.children.map((child) =>
          child.kind === "text" ? child.value : "",
        ),
      ).toEqual(["\u2242\u0338"]);
    });

    it.each([
      [1, 2],
      [2, 3],
    ])(
      "refuses a boundary inside a multi-code-point entity (%i..%i)",
      (start, end) => {
        const original = "<p>x&NotEqualTilde;y</p>";
        expect(refusal(wrap(original, "<p", start, end, "b", null))).toBe(
          "unsafe-context",
        );
      },
    );
  });

  describe("astral characters", () => {
    it("wraps a whole surrogate pair", () => {
      const original = "<p>a😀b</p>";
      const result = success(original, wrap(original, "<p", 1, 3, "b", null));
      expect(result.text).toBe("<p>a<b>😀</b>b</p>");
      expect(result.splices).toEqual([
        { start: 4, end: 6, replacement: "<b>😀</b>" },
      ]);
    });

    it("counts a pair as two units for what follows it", () => {
      const original = "<p>😀 hi</p>";
      const result = success(original, wrap(original, "<p", 3, 5, "b", null));
      expect(result.text).toBe("<p>😀 <b>hi</b></p>");
    });

    it.each([
      [1, 2],
      [2, 3],
    ])("refuses a split surrogate pair (%i..%i)", (start, end) => {
      const original = "<p>a😀b</p>";
      expect(refusal(wrap(original, "<p", start, end, "b", null))).toBe(
        "unsafe-context",
      );
    });
  });

  describe("which text may be wrapped", () => {
    it("wraps text inside a descendant element's own text node", () => {
      const original = "<p>ab<i>cd</i>ef</p>";
      const result = success(original, wrap(original, "<p", 2, 4, "b", null));
      expect(result.text).toBe("<p>ab<i><b>cd</b></i>ef</p>");
    });

    it("refuses a selection that crosses two text nodes", () => {
      const original = "<p>ab<i>cd</i>ef</p>";
      expect(refusal(wrap(original, "<p", 1, 3, "b", null))).toBe(
        "unsafe-context",
      );
    });

    it("wraps inside a table cell", () => {
      const original = "<table><tr><td>cell</td></tr></table>";
      const result = success(
        original,
        wrap(original, "<table", 0, 2, "b", null),
      );
      expect(result.text).toBe("<table><tr><td><b>ce</b>ll</td></tr></table>");
    });

    it("refuses whitespace directly inside a table, which the parser would move out of it", () => {
      const original = "<table> <tr><td>c</td></tr></table>";
      expect(refusal(wrap(original, "<table", 0, 1, "b", null))).toBe(
        "unsafe-context",
      );
    });

    it.each(["textarea", "script", "title"])(
      "refuses the raw text of <%s>",
      (name) => {
        const original = `<div><${name}>abc</${name}></div>`;
        expect(refusal(wrap(original, "<div", 0, 2, "b", null))).toBe(
          "unsafe-context",
        );
      },
    );

    it("refuses text inside SVG", () => {
      const original = "<svg><text>abc</text></svg>";
      expect(refusal(wrap(original, "<svg", 0, 2, "b", null))).toBe(
        "unsafe-context",
      );
    });

    it("does not count the contents of a template", () => {
      const original = "<p><template>abc</template>def</p>";
      const result = success(original, wrap(original, "<p", 0, 2, "b", null));
      expect(result.text).toBe("<p><template>abc</template><b>de</b>f</p>");
    });

    it("counts text after the line feed a <pre> ignores", () => {
      const original = "<pre>\nabc</pre>";
      const result = success(original, wrap(original, "<pre", 0, 2, "b", null));
      expect(result.text).toBe("<pre>\n<b>ab</b>c</pre>");
    });

    it("finds the element by tid as well as by position", () => {
      const original = '<p data-tid="t">abc def</p>';
      const result = success(
        original,
        wrapTextRange(original, { kind: "tid", tid: "t" }, 4, 7, "b", null),
      );
      expect(result.text).toBe('<p data-tid="t">abc <b>def</b></p>');
    });

    it("wraps the whole text of the element", () => {
      const original = "<p>abc</p>";
      const result = success(original, wrap(original, "<p", 0, 3, "b", null));
      expect(result.text).toBe("<p><b>abc</b></p>");
    });
  });

  describe("ranges", () => {
    it.each([
      ["empty", 2, 2],
      ["reversed", 2, 1],
      ["past the end", 1, 9],
      ["negative", -1, 2],
      ["fractional", 0.5, 2],
    ])("refuses an %s range", (_label, start, end) => {
      const original = "<p>abc</p>";
      expect(refusal(wrap(original, "<p", start, end, "b", null))).toBe(
        "unsafe-context",
      );
    });
  });

  describe("links", () => {
    it.each(["https://example.com/a", "http://x.org"])("accepts %s", (href) => {
      const original = "<p>go there</p>";
      const result = success(original, wrap(original, "<p", 0, 2, "a", href));
      expect(result.text).toBe(`<p><a href="${href}">go</a> there</p>`);
    });

    it("escapes quotes and ampersands in the href", () => {
      const original = "<p>go there</p>";
      const result = success(
        original,
        wrap(original, "<p", 0, 2, "a", 'https://x.com/?a="b"&c=d'),
      );
      expect(result.text).toBe(
        '<p><a href="https://x.com/?a=&quot;b&quot;&amp;c=d">go</a> there</p>',
      );
    });

    it.each([
      "javascript:alert(1)",
      "/relative",
      "//host/path",
      "mailto:a@b.c",
      "data:text/html,x",
      "not a url",
    ])("refuses the href %j", (href) => {
      const original = "<p>go there</p>";
      expect(refusal(wrap(original, "<p", 0, 2, "a", href))).toBe(
        "unsafe-context",
      );
    });

    it("refuses a link without an href", () => {
      const original = "<p>go there</p>";
      expect(refusal(wrap(original, "<p", 0, 2, "a", null))).toBe(
        "unsafe-context",
      );
    });

    it.each(["b", "i", "u"] as const)("refuses an href on <%s>", (tag) => {
      const original = "<p>go</p>";
      expect(refusal(wrap(original, "<p", 0, 2, tag, "https://x.org"))).toBe(
        "unsafe-context",
      );
    });

    it("refuses a link inside a link", () => {
      const direct = '<a href="https://x.org">link text</a>';
      expect(refusal(wrap(direct, "<a", 0, 4, "a", "https://y.org"))).toBe(
        "unsafe-context",
      );
      const ancestor = '<p><a href="https://x.org"><span>link</span></a></p>';
      expect(refusal(wrap(ancestor, "<p", 0, 4, "a", "https://y.org"))).toBe(
        "unsafe-context",
      );
    });
  });

  it("reports an element it cannot find as a locate miss", () => {
    expect(
      refusal(
        wrapTextRange(
          "<p>abc</p>",
          { kind: "tid", tid: "nope" },
          0,
          2,
          "b",
          null,
        ),
      ),
    ).toBe("not-found");
  });
});

describe("unwrapTextRange", () => {
  it("removes the whole wrapper when the selection is all of it", () => {
    const original = "<p>x<b>Hello world</b>y</p>";
    const result = success(original, unwrap(original, "<p", 1, 12, "b"));
    expect(result.text).toBe("<p>xHello worldy</p>");
    expect(result.splices).toEqual([
      { start: 4, end: 22, replacement: "Hello world" },
    ]);
  });

  it("splits the wrapper into a prefix and a suffix around the selection", () => {
    const original = "<p>x<b>Hello world</b>y</p>";
    const result = success(original, unwrap(original, "<p", 4, 7, "b"));
    expect(result.text).toBe("<p>x<b>Hel</b>lo <b>world</b>y</p>");
    expect(result.splices).toEqual([
      { start: 4, end: 22, replacement: "<b>Hel</b>lo <b>world</b>" },
    ]);
  });

  it("keeps only a suffix wrapper when the selection starts the wrapper", () => {
    const original = "<p><b>Hello world</b></p>";
    const result = success(original, unwrap(original, "<p", 0, 5, "b"));
    expect(result.text).toBe("<p>Hello<b> world</b></p>");
  });

  it("keeps only a prefix wrapper when the selection ends the wrapper", () => {
    const original = "<p><b>Hello world</b></p>";
    const result = success(original, unwrap(original, "<p", 5, 11, "b"));
    expect(result.text).toBe("<p><b>Hello</b> world</p>");
  });

  it.each(["u", "i"] as const)("works on <%s>", (tag) => {
    const original = `<p><${tag}>abcdef</${tag}></p>`;
    const result = success(original, unwrap(original, "<p", 2, 4, tag));
    expect(result.text).toBe(`<p><${tag}>ab</${tag}>cd<${tag}>ef</${tag}></p>`);
  });

  describe("identity metadata", () => {
    const META = '<p><b data-tid="t1" data-traycer-pos="5">Hello world</b></p>';

    it("stays on the first retained part only", () => {
      const result = success(META, unwrap(META, "<p", 2, 5, "b"));
      expect(result.text).toBe(
        '<p><b data-tid="t1" data-traycer-pos="5">He</b>llo<b> world</b></p>',
      );
    });

    it("stays on the suffix when there is no prefix", () => {
      const original = '<p><b data-tid="t1">Hello world</b></p>';
      const result = success(original, unwrap(original, "<p", 0, 5, "b"));
      expect(result.text).toBe('<p>Hello<b data-tid="t1"> world</b></p>');
    });

    it("goes with the wrapper when nothing is retained", () => {
      const result = success(META, unwrap(META, "<p", 0, 11, "b"));
      expect(result.text).toBe("<p>Hello world</p>");
    });

    it("removes a wrapper that carries a tid", () => {
      const original = '<p>x <u data-tid="u1">abc</u></p>';
      const result = success(original, unwrap(original, "<p", 2, 5, "u"));
      expect(result.text).toBe("<p>x abc</p>");
    });
  });

  describe("links", () => {
    it("keeps the href on both parts and the metadata on the first", () => {
      const original =
        '<p><a href="https://x.org" data-tid="t">Hello world</a></p>';
      const result = success(original, unwrap(original, "<p", 2, 5, "a"));
      expect(result.text).toBe(
        '<p><a href="https://x.org" data-tid="t">He</a>llo<a href="https://x.org"> world</a></p>',
      );
    });

    it("removes a whole link, href and all", () => {
      const original = '<p><a href="https://x.org">Hello</a></p>';
      const result = success(original, unwrap(original, "<p", 0, 5, "a"));
      expect(result.text).toBe("<p>Hello</p>");
    });

    it("refuses an href on any other wrapper", () => {
      const original = '<p><b href="x">Hello</b></p>';
      expect(refusal(unwrap(original, "<p", 0, 5, "b"))).toBe("unsafe-context");
    });
  });

  describe("refusals", () => {
    it.each([
      ['<p><b class="x">Hello</b></p>', "a class"],
      ['<p><b style="x:y">Hello</b></p>', "a style"],
      ['<p><b id="i">Hello</b></p>', "an id"],
    ])(
      "refuses a wrapper with attributes that would be lost: %s (%s)",
      (original) => {
        expect(refusal(unwrap(original, "<p", 0, 5, "b"))).toBe(
          "unsafe-context",
        );
      },
    );

    it("refuses a wrapper that owns an element", () => {
      const original = "<p><b>a<i>b</i></b></p>";
      expect(refusal(unwrap(original, "<p", 0, 1, "b"))).toBe("unsafe-context");
    });

    it("refuses when the text's parent is a different tag", () => {
      expect(refusal(unwrap("<p><i>abc</i></p>", "<p", 0, 2, "b"))).toBe(
        "unsafe-context",
      );
      expect(refusal(unwrap("<p><b><i>abc</i></b></p>", "<p", 0, 2, "b"))).toBe(
        "unsafe-context",
      );
    });

    it("refuses plain text that has no wrapper", () => {
      expect(refusal(unwrap("<p>abc</p>", "<p", 0, 2, "b"))).toBe(
        "unsafe-context",
      );
    });

    it("refuses a selection that spans text in and out of the wrapper", () => {
      expect(refusal(unwrap("<p><b>ab</b>cd</p>", "<p", 1, 3, "b"))).toBe(
        "unsafe-context",
      );
    });

    it.each([
      ["empty", 0, 0],
      ["past the end", 0, 10],
    ])("refuses an %s range", (_label, start, end) => {
      expect(refusal(unwrap("<p><b>abc</b></p>", "<p", start, end, "b"))).toBe(
        "unsafe-context",
      );
    });
  });

  describe("source fidelity", () => {
    it("keeps the BOM and the CRLF inside and outside the wrapper", () => {
      const original = `${BOM}<p>x\r\n<b>Hello\r\nworld</b></p>\r\n`;
      const result = success(original, unwrap(original, "<p", 3, 8, "b"));
      expect(result.text).toBe(
        `${BOM}<p>x\r\n<b>H</b>ello\r\n<b>world</b></p>\r\n`,
      );
    });

    it("unwraps one entity as a single unit", () => {
      const original = "<p><b>a &amp; b</b></p>";
      const result = success(original, unwrap(original, "<p", 2, 3, "b"));
      expect(result.text).toBe("<p><b>a </b>&amp;<b> b</b></p>");
    });

    it("refuses a boundary inside a multi-code-point entity", () => {
      expect(
        refusal(unwrap("<p><b>x&NotEqualTilde;y</b></p>", "<p", 1, 2, "b")),
      ).toBe("unsafe-context");
    });

    it("unwraps a whole surrogate pair and refuses half of one", () => {
      const original = "<p><b>a😀b</b></p>";
      const result = success(original, unwrap(original, "<p", 1, 3, "b"));
      expect(result.text).toBe("<p><b>a</b>😀<b>b</b></p>");
      expect(refusal(unwrap(original, "<p", 1, 2, "b"))).toBe("unsafe-context");
    });
  });

  it("round-trips: wrapping a range and unwrapping it again restores the source", () => {
    const original = "<p>Hello world</p>";
    const wrapped = success(original, wrap(original, "<p", 0, 5, "b", null));
    const restored = success(
      wrapped.text,
      unwrap(wrapped.text, "<p", 0, 5, "b"),
    );
    expect(restored.text).toBe(original);
  });
});
