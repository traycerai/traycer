import { beforeAll, describe, expect, it } from "vitest";

import {
  findLiteralText,
  insertTid,
  locateElement,
  parseHtmlSource,
  replaceRange,
  setAttribute,
  setStyleDeclaration,
  setTextContent,
  setTextNode,
  stampPositions,
  type EditMissReason,
  type EditResult,
  type ElementLocator,
  type HtmlChild,
  type HtmlElement,
  type HtmlSourceDocument,
  type LocateResult,
  type SourceRange,
  type SourceSplice,
} from "../index";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

// ---------------------------------------------------------------------------
// Helpers. They are deliberately independent of the implementation: splices are
// re-applied here, and ranges are checked by slicing the original string.
// ---------------------------------------------------------------------------

/** Applies ordered, non-overlapping splices that are relative to `original`. */
function applySplices(original: string, splices: SourceSplice[]): string {
  let cursor = 0;
  let output = "";
  for (const splice of splices) {
    expect(splice.start).toBeGreaterThanOrEqual(cursor);
    expect(splice.end).toBeGreaterThanOrEqual(splice.start);
    expect(splice.end).toBeLessThanOrEqual(original.length);
    output += original.slice(cursor, splice.start) + splice.replacement;
    cursor = splice.end;
  }
  return output + original.slice(cursor);
}

function sliceOf(text: string, range: SourceRange | null): string {
  if (range === null) {
    throw new Error("expected a source range, got null");
  }
  return text.slice(range.start, range.end);
}

function positionLocator(
  text: string,
  needle: string,
  occurrence: number,
): ElementLocator {
  let index = -1;
  for (let seen = 0; seen <= occurrence; seen++) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) {
      throw new Error(`fixture is missing occurrence ${seen} of ${needle}`);
    }
  }
  const match = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(needle);
  if (match === null) {
    throw new Error(`needle ${needle} is not a start tag prefix`);
  }
  // The tag name keeps the fixture's casing so uppercase fixtures also prove
  // that the locator compares tag names case-insensitively.
  return { kind: "position", startTagOffset: index, tagName: match[1] };
}

function at(text: string, needle: string): ElementLocator {
  return positionLocator(text, needle, 0);
}

function tid(value: string): ElementLocator {
  return { kind: "tid", tid: value };
}

function elementsNamed(
  document: HtmlSourceDocument,
  tagName: string,
): HtmlElement[] {
  return document.elements.filter((element) => element.tagName === tagName);
}

function onlyElement(text: string, tagName: string): HtmlElement {
  const matches = elementsNamed(parseHtmlSource(text), tagName);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one <${tagName}>, got ${matches.length}`);
  }
  return matches[0];
}

function attributeValueIn(
  text: string,
  tagName: string,
  attributeName: string,
): string | null {
  const attribute = onlyElement(text, tagName).attrs.find(
    (candidate) => candidate.name === attributeName,
  );
  return attribute === undefined ? null : attribute.value;
}

function directTexts(element: HtmlElement): string[] {
  return element.children.flatMap((child) =>
    child.kind === "text" ? [child.value] : [],
  );
}

function located(result: LocateResult): HtmlElement {
  if (!result.ok) {
    throw new Error(`locate missed: ${result.reason}`);
  }
  return result.element;
}

function refused(result: EditResult): EditMissReason {
  if (result.ok) {
    throw new Error(`expected a refusal, but the edit produced ${result.text}`);
  }
  return result.reason;
}

/**
 * Asserts a successful edit: exact resulting bytes, the same bytes when the
 * returned splices are applied independently to the original, and that the
 * returned element still describes the ORIGINAL text.
 */
function expectEdit(
  original: string,
  result: EditResult,
  expectedText: string,
): SourceSplice[] {
  if (!result.ok) {
    throw new Error(`edit refused: ${result.reason}`);
  }
  expect(result.text).toBe(expectedText);
  expect(applySplices(original, result.splices)).toBe(expectedText);
  const { element } = result;
  expect(sliceOf(original, element.startTag).startsWith("<")).toBe(true);
  expect(sliceOf(original, element.tagNameRange).toLowerCase()).toBe(
    element.tagName,
  );
  return result.splices;
}

/** Edits that also have to survive a re-parse: the decoded value round-trips. */
function expectAttributeRoundTrip(
  original: string,
  result: EditResult,
  tagName: string,
  attributeName: string,
  expectedValue: string,
): void {
  if (!result.ok) {
    throw new Error(`edit refused: ${result.reason}`);
  }
  expect(applySplices(original, result.splices)).toBe(result.text);
  expect(attributeValueIn(result.text, tagName, attributeName)).toBe(
    expectedValue,
  );
}

// ---------------------------------------------------------------------------
// parseHtmlSource
// ---------------------------------------------------------------------------

describe("parseHtmlSource", () => {
  it("records ranges and decoded values for every attribute form", () => {
    const text = `<DIV id="a" class='b c' data-x=c hidden DATA-Y="q>r" title='x > y'>t</DIV>`;
    const div = onlyElement(text, "div");

    expect(sliceOf(text, div.tagNameRange)).toBe("DIV");
    expect(sliceOf(text, div.startTag)).toBe(
      `<DIV id="a" class='b c' data-x=c hidden DATA-Y="q>r" title='x > y'>`,
    );
    expect(sliceOf(text, div.endTag)).toBe("</DIV>");
    expect(div.namespaceURI).toBe(HTML_NAMESPACE);
    expect(div.isVoid).toBe(false);
    expect(div.isRawText).toBe(false);

    expect(
      div.attrs.map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
        quote: attribute.quote,
        raw:
          attribute.valueRange === null
            ? null
            : sliceOf(text, attribute.valueRange),
        nameText: sliceOf(text, attribute.nameRange),
        whole: sliceOf(text, attribute.range),
      })),
    ).toEqual([
      {
        name: "id",
        value: "a",
        quote: '"',
        raw: "a",
        nameText: "id",
        whole: `id="a"`,
      },
      {
        name: "class",
        value: "b c",
        quote: "'",
        raw: "b c",
        nameText: "class",
        whole: `class='b c'`,
      },
      {
        name: "data-x",
        value: "c",
        quote: null,
        raw: "c",
        nameText: "data-x",
        whole: "data-x=c",
      },
      {
        name: "hidden",
        value: "",
        quote: null,
        raw: null,
        nameText: "hidden",
        whole: "hidden",
      },
      {
        name: "data-y",
        value: "q>r",
        quote: '"',
        raw: "q>r",
        nameText: "DATA-Y",
        whole: `DATA-Y="q>r"`,
      },
      {
        name: "title",
        value: "x > y",
        quote: "'",
        raw: "x > y",
        nameText: "title",
        whole: `title='x > y'`,
      },
    ]);
  });

  it("decodes entities while keeping ranges on the raw source", () => {
    const text = `<p title="a &amp; b">x &lt; y &#65;</p>`;
    const paragraph = onlyElement(text, "p");
    const [attribute] = paragraph.attrs;
    expect(attribute.value).toBe("a & b");
    expect(sliceOf(text, attribute.valueRange)).toBe("a &amp; b");

    const [child] = paragraph.children;
    if (child.kind !== "text") {
      throw new Error("expected a text child");
    }
    expect(child.value).toBe("x < y A");
    expect(sliceOf(text, child.range)).toBe("x &lt; y &#65;");
  });

  it("keeps script and style contents out of the element tree", () => {
    const text = `<script>var s = "<div id=x>"; if (a < b) {}</script><style>/* <div> */ p > b {}</style><div id="real">r</div>`;
    const document = parseHtmlSource(text);

    expect(elementsNamed(document, "div")).toHaveLength(1);
    const script = onlyElement(text, "script");
    expect(script.isRawText).toBe(true);
    expect(script.children).toHaveLength(1);
    expect(script.children[0].kind).toBe("text");
    expect(sliceOf(text, script.endTag)).toBe("</script>");
    expect(onlyElement(text, "style").isRawText).toBe(true);
  });

  it("treats comments and conditional comments as opaque", () => {
    const comment = "<!-- <div id=x> -->";
    const conditional = "<!--[if IE]><div id=y>old</div><![endif]-->";
    const text = `${comment}${conditional}<p>ok</p>`;
    const document = parseHtmlSource(text);

    expect(elementsNamed(document, "div")).toHaveLength(0);
    const paragraph = onlyElement(text, "p");
    expect(paragraph.attrs).toEqual([]);

    const comments: string[] = [];
    const collect = (children: HtmlChild[]): void => {
      for (const child of children) {
        if (child.kind === "comment") {
          comments.push(sliceOf(text, child.range));
        } else if (child.kind === "element") {
          collect(child.children);
        }
      }
    };
    collect(document.children);
    expect(comments).toEqual([comment, conditional]);
  });

  it("marks void elements and ignores a self-closing slash on non-void ones", () => {
    const text = `<div/>a<br><img src="x"/><input disabled></div>`;
    const div = onlyElement(text, "div");
    expect(sliceOf(text, div.endTag)).toBe("</div>");
    expect(directTexts(div)).toEqual(["a"]);

    for (const name of ["br", "img", "input"]) {
      const element = onlyElement(text, name);
      expect(element.isVoid).toBe(true);
      expect(element.endTag).toBeNull();
      expect(element.startTag).not.toBeNull();
    }
    expect(sliceOf(text, onlyElement(text, "img").startTag)).toBe(
      `<img src="x"/>`,
    );
  });

  it("reports foreign self-closing elements without an end tag", () => {
    const text = `<svg><circle r="1"/></svg>`;
    const circle = onlyElement(text, "circle");
    expect(circle.namespaceURI).toBe(SVG_NAMESPACE);
    expect(circle.isVoid).toBe(false);
    expect(circle.endTag).toBeNull();
    expect(sliceOf(text, circle.startTag)).toBe(`<circle r="1"/>`);
    expect(onlyElement(text, "svg").namespaceURI).toBe(SVG_NAMESPACE);
  });

  it("represents implied html, head and body without source ranges", () => {
    const text = "hello";
    const document = parseHtmlSource(text);

    for (const name of ["html", "head", "body"]) {
      const element = onlyElement(text, name);
      expect(element.startTag).toBeNull();
      expect(element.tagNameRange).toBeNull();
      expect(element.endTag).toBeNull();
      expect(element.isUniqueSource).toBe(false);
    }
    const body = onlyElement(text, "body");
    expect(body.children).toHaveLength(1);
    const [child] = body.children;
    if (child.kind !== "text") {
      throw new Error("expected body text");
    }
    expect(child.value).toBe("hello");
    expect(sliceOf(text, child.range)).toBe("hello");
    expect(document.elements.length).toBeGreaterThanOrEqual(3);
  });

  it("lists literal elements before implied ones, in source order", () => {
    const text = `<!DOCTYPE html><div><p>x</p><span>y</span></div>`;
    const { elements } = parseHtmlSource(text);

    const literalNames = elements
      .filter((element) => element.startTag !== null)
      .map((element) => element.tagName);
    expect(literalNames).toEqual(["div", "p", "span"]);

    const firstImplied = elements.findIndex(
      (element) => element.startTag === null,
    );
    const lastLiteral = elements.findLastIndex(
      (element) => element.startTag !== null,
    );
    expect(firstImplied).toBeGreaterThan(lastLiteral);
  });

  it("keeps literal html and body tags while implying the missing head", () => {
    const text = `<html lang="en"><body class=x>hi</body></html>`;
    expect(sliceOf(text, onlyElement(text, "html").startTag)).toBe(
      `<html lang="en">`,
    );
    expect(sliceOf(text, onlyElement(text, "body").endTag)).toBe("</body>");
    expect(onlyElement(text, "head").startTag).toBeNull();
  });

  it("has no end tag for elements closed by the parser", () => {
    const text = `<ul><li>a<li>b</ul><p>one<p>two`;
    const items = elementsNamed(parseHtmlSource(text), "li");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.endTag).toBeNull();
    }
    expect(sliceOf(text, onlyElement(text, "ul").endTag)).toBe("</ul>");
    const paragraphs = elementsNamed(parseHtmlSource(text), "p");
    expect(paragraphs.map((paragraph) => paragraph.endTag)).toEqual([
      null,
      null,
    ]);
  });

  it("exposes template content as children and keeps it markup", () => {
    const text = `<template><div id="t">x</div></template><p>y</p>`;
    const template = onlyElement(text, "template");
    expect(template.isRawText).toBe(false);
    const inner = template.children.filter(
      (child): child is HtmlElement =>
        child.kind === "element" && child.tagName === "div",
    );
    expect(inner).toHaveLength(1);
    expect(sliceOf(text, inner[0].startTag)).toBe(`<div id="t">`);
    expect(elementsNamed(parseHtmlSource(text), "div")).toHaveLength(1);
  });

  it("treats textarea and title as raw text with decoded values", () => {
    const text = `<title>A &amp; B</title><textarea>x &lt;div&gt; y</textarea>`;
    for (const [name, decoded, raw] of [
      ["title", "A & B", "A &amp; B"],
      ["textarea", "x <div> y", "x &lt;div&gt; y"],
    ] as const) {
      const element = onlyElement(text, name);
      expect(element.isRawText).toBe(true);
      const [child] = element.children;
      if (child.kind !== "text") {
        throw new Error(`expected text inside ${name}`);
      }
      expect(child.value).toBe(decoded);
      expect(sliceOf(text, child.range)).toBe(raw);
    }
  });

  it("counts a byte order mark and CRLF in UTF-16 offsets", () => {
    const text = "﻿<div>\r\na\r\n</div>\r\n";
    const div = onlyElement(text, "div");
    expect(div.startTag).toEqual({ start: 1, end: 6 });
    expect(sliceOf(text, div.endTag)).toBe("</div>");

    const [child] = div.children;
    if (child.kind !== "text") {
      throw new Error("expected text child");
    }
    expect(sliceOf(text, child.range)).toBe("\r\na\r\n");
    expect(child.value.replace(/\r\n/g, "\n")).toBe("\na\n");
  });

  it("exposes real html, head and body tags after a leading BOM", () => {
    const text =
      '\uFEFF<!doctype html><html><head><title>t</title></head><body class="b"><p>x</p></body></html>';
    expect(onlyElement(text, "html").startTag).toEqual({ start: 16, end: 22 });
    expect(onlyElement(text, "head").startTag).toEqual({ start: 22, end: 28 });
    const body = onlyElement(text, "body");
    expect(sliceOf(text, body.startTag)).toBe('<body class="b">');
    expect(body.startTag?.start).toBe(51);
    expect(sliceOf(text, body.endTag)).toBe("</body>");
    expect(sliceOf(text, onlyElement(text, "p").startTag)).toBe("<p>");
    expect(
      located(
        locateElement(text, {
          kind: "position",
          startTagOffset: 51,
          tagName: "body",
        }),
      ).tagName,
    ).toBe("body");
    // The BOM must not leak into the body as text.
    for (const child of body.children) {
      expect(child.kind).toBe("element");
    }
  });

  it("marks ordinary literal elements as a unique source", () => {
    const text = `<div><p>x</p><br></div>`;
    for (const element of parseHtmlSource(text).elements) {
      expect(element.isUniqueSource).toBe(element.startTag !== null);
    }
  });

  it("marks every member of a reconstructed formatting element as not unique", () => {
    // `</p>` leaves b in the formatting list, so "two" gets a copy of b that
    // shares the original start tag.
    const text = `<p><b>one</p>two</b>`;
    const bolds = elementsNamed(parseHtmlSource(text), "b");
    expect(bolds).toHaveLength(2);
    for (const bold of bolds) {
      expect(bold.isUniqueSource).toBe(false);
      expect(bold.startTag).toEqual({ start: 3, end: 6 });
      expect(sliceOf(text, bold.startTag)).toBe("<b>");
    }
    expect(onlyElement(text, "p").isUniqueSource).toBe(true);
  });

  it("marks the original and the source-less copy of an adopted formatting element as not unique", () => {
    const text = `<b>x<p>y</b>z</p>`;
    const bolds = elementsNamed(parseHtmlSource(text), "b");
    expect(bolds.length).toBeGreaterThanOrEqual(2);
    for (const bold of bolds) {
      expect(bold.isUniqueSource).toBe(false);
    }
    expect(
      bolds.flatMap((bold) => (bold.startTag === null ? [] : [bold.startTag])),
    ).toEqual([{ start: 0, end: 3 }]);
    expect(bolds.some((bold) => bold.startTag === null)).toBe(true);
    expect(onlyElement(text, "p").isUniqueSource).toBe(true);
  });

  it("reports the first data-tid as the effective tid, copies included", () => {
    const duplicated = `<p data-tid=a data-tid=b>x</p><p>y</p>`;
    const [first, second] = elementsNamed(parseHtmlSource(duplicated), "p");
    expect(first.effectiveTid).toBe("a");
    expect(second.effectiveTid).toBeNull();
    expect(
      first.attrs
        .filter((attribute) => attribute.name === "data-tid")
        .map((attribute) => attribute.value),
    ).toEqual(["a", "b"]);

    const adopted = `<b data-tid="t">x<p>y</b>z</p>`;
    for (const bold of elementsNamed(parseHtmlSource(adopted), "b")) {
      expect(bold.effectiveTid).toBe("t");
    }
  });

  it("counts astral characters as two UTF-16 units", () => {
    const text = `<p>😀日本</p><b id="x">y</b>`;
    const bold = onlyElement(text, "b");
    expect(bold.startTag?.start).toBe(text.indexOf("<b"));
    expect(sliceOf(text, bold.startTag)).toBe(`<b id="x">`);
  });

  it("splits nested inline mixed content into direct text nodes", () => {
    const text = `<p>a <b>b <i>c</i> d</b> e</p>`;
    const paragraph = onlyElement(text, "p");
    expect(directTexts(paragraph)).toEqual(["a ", " e"]);
    expect(directTexts(onlyElement(text, "b"))).toEqual(["b ", " d"]);
    expect(directTexts(onlyElement(text, "i"))).toEqual(["c"]);
    expect(paragraph.children.map((child) => child.kind)).toEqual([
      "text",
      "element",
      "text",
    ]);
  });

  it("lowercases uppercase tag and attribute names but not their source", () => {
    const text = `<SECTION ID="X" Data-Foo=1><P>t</P></SECTION>`;
    const section = onlyElement(text, "section");
    expect(section.attrs.map((attribute) => attribute.name)).toEqual([
      "id",
      "data-foo",
    ]);
    expect(sliceOf(text, section.tagNameRange)).toBe("SECTION");
    expect(sliceOf(text, onlyElement(text, "p").endTag)).toBe("</P>");
  });
});

// ---------------------------------------------------------------------------
// locateElement
// ---------------------------------------------------------------------------

describe("locateElement", () => {
  const text = `<div id="a"><span data-tid="s">x</span><!-- <i data-tid="c"> --></div><script>"<b data-tid='t'>"</script>`;

  it("finds an element by the offset of its start tag", () => {
    const span = located(locateElement(text, at(text, "<span")));
    expect(span.tagName).toBe("span");
    expect(span.startTag?.start).toBe(text.indexOf("<span"));
  });

  it("matches the tag name case-insensitively", () => {
    const span = located(
      locateElement(text, {
        kind: "position",
        startTagOffset: text.indexOf("<span"),
        tagName: "SPAN",
      }),
    );
    expect(span.tagName).toBe("span");
  });

  it("reports a tag mismatch at a real start tag of another element", () => {
    expect(
      locateElement(text, {
        kind: "position",
        startTagOffset: text.indexOf("<span"),
        tagName: "div",
      }),
    ).toEqual({ ok: false, reason: "tag-mismatch" });
  });

  it("reports not-found for offsets that are not a start tag", () => {
    const spanOffset = text.indexOf("<span");
    for (const startTagOffset of [
      spanOffset + 1,
      spanOffset - 1,
      text.indexOf("x</span>"),
      text.length + 10,
    ]) {
      expect(
        locateElement(text, {
          kind: "position",
          startTagOffset,
          tagName: "span",
        }),
      ).toEqual({ ok: false, reason: "not-found" });
    }
  });

  it("cannot locate markup that only appears inside comments or scripts", () => {
    expect(locateElement(text, positionLocator(text, "<i", 0))).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(locateElement(text, positionLocator(text, "<b", 0))).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(locateElement(text, tid("c"))).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(locateElement(text, tid("t"))).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("cannot locate implied elements", () => {
    const fragment = "hello";
    for (const tagName of ["html", "head", "body"]) {
      expect(
        locateElement(fragment, {
          kind: "position",
          startTagOffset: 0,
          tagName,
        }),
      ).toEqual({ ok: false, reason: "not-found" });
    }
  });

  it("locates a literal element that starts at offset 0 and one after a BOM", () => {
    const plain = `<p>a</p>`;
    expect(
      located(
        locateElement(plain, {
          kind: "position",
          startTagOffset: 0,
          tagName: "p",
        }),
      ).tagName,
    ).toBe("p");

    const bom = `﻿<p>a</p>`;
    expect(
      located(
        locateElement(bom, {
          kind: "position",
          startTagOffset: 1,
          tagName: "p",
        }),
      ).tagName,
    ).toBe("p");
    expect(
      locateElement(bom, { kind: "position", startTagOffset: 0, tagName: "p" }),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("finds an element by tid", () => {
    const element = located(locateElement(text, tid("s")));
    expect(element.tagName).toBe("span");
  });

  it("matches the tid attribute name case-insensitively and the value decoded", () => {
    const upper = `<i DATA-TID="u">x</i><b data-tid="a&amp;b">y</b>`;
    expect(located(locateElement(upper, tid("u"))).tagName).toBe("i");
    expect(located(locateElement(upper, tid("a&b"))).tagName).toBe("b");
  });

  it("reports an unknown tid as not-found and a repeated tid as ambiguous", () => {
    const duplicated = `<p data-tid="d">a</p><p data-tid="d">b</p><p data-tid="one">c</p>`;
    expect(locateElement(duplicated, tid("missing"))).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(locateElement(duplicated, tid("d"))).toEqual({
      ok: false,
      reason: "ambiguous",
    });
    expect(located(locateElement(duplicated, tid("one"))).tagName).toBe("p");
  });

  it("uses the first data-tid of an element and ignores its later duplicates", () => {
    const duplicated = `<p data-tid=a data-tid=b>x</p>`;
    expect(located(locateElement(duplicated, tid("a"))).tagName).toBe("p");
    expect(locateElement(duplicated, tid("b"))).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("does not let a shadowed duplicate data-tid collide with another element", () => {
    const text = `<p data-tid="a" data-tid="b">x</p><p data-tid="b">y</p>`;
    expect(located(locateElement(text, tid("b"))).startTag?.start).toBe(
      text.lastIndexOf("<p"),
    );
    expect(located(locateElement(text, tid("a"))).startTag?.start).toBe(0);
  });

  it("returns elements whose ranges refer to the text it was given", () => {
    const crlf = '﻿<div>\r\n<p id="k">😀</p>\r\n</div>';
    const paragraph = located(locateElement(crlf, at(crlf, "<p")));
    expect(sliceOf(crlf, paragraph.startTag)).toBe(`<p id="k">`);
    expect(sliceOf(crlf, paragraph.endTag)).toBe("</p>");
  });
});

// ---------------------------------------------------------------------------
// replaceRange
// ---------------------------------------------------------------------------

describe("replaceRange", () => {
  it("replaces, inserts and deletes by half-open UTF-16 range", () => {
    const replacement: SourceSplice = { start: 1, end: 3, replacement: "ipp" };
    expect(replaceRange("hello", replacement)).toEqual({
      text: "hipplo",
      splices: [replacement],
    });

    const insertion: SourceSplice = { start: 2, end: 2, replacement: "-" };
    expect(replaceRange("hello", insertion)).toEqual({
      text: "he-llo",
      splices: [insertion],
    });

    const deletion: SourceSplice = { start: 0, end: 5, replacement: "" };
    expect(replaceRange("hello", deletion)).toEqual({
      text: "",
      splices: [deletion],
    });
  });

  it("accepts the boundaries of the text", () => {
    expect(
      replaceRange("ab", { start: 0, end: 0, replacement: ">" }).text,
    ).toBe(">ab");
    expect(
      replaceRange("ab", { start: 2, end: 2, replacement: "<" }).text,
    ).toBe("ab<");
    expect(replaceRange("", { start: 0, end: 0, replacement: "x" }).text).toBe(
      "x",
    );
  });

  it("indexes in UTF-16 code units", () => {
    const text = "😀a";
    expect(text.length).toBe(3);
    expect(
      replaceRange(text, { start: 2, end: 3, replacement: "b" }).text,
    ).toBe("😀b");
    expect(replaceRange(text, { start: 0, end: 2, replacement: "" }).text).toBe(
      "a",
    );
  });

  it("throws RangeError for every invalid range", () => {
    const invalid: SourceSplice[] = [
      { start: -1, end: 1, replacement: "" },
      { start: 0, end: 6, replacement: "" },
      { start: 6, end: 6, replacement: "" },
      { start: 3, end: 2, replacement: "" },
      { start: Number.NaN, end: 2, replacement: "" },
      { start: 0, end: Number.NaN, replacement: "" },
      { start: 0, end: Number.POSITIVE_INFINITY, replacement: "" },
      { start: Number.NEGATIVE_INFINITY, end: 1, replacement: "" },
      { start: 0.5, end: 2, replacement: "" },
      { start: 0, end: 1.5, replacement: "" },
    ];
    for (const splice of invalid) {
      expect(() => replaceRange("hello", splice)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// Behaviour shared by every locator edit
// ---------------------------------------------------------------------------

const LOCATOR_EDITS: ReadonlyArray<{
  name: string;
  run: (text: string, locator: ElementLocator) => EditResult;
}> = [
  {
    name: "setAttribute",
    run: (text, locator) => setAttribute(text, locator, "title", "x"),
  },
  {
    name: "setTextNode",
    run: (text, locator) => setTextNode(text, locator, 0, "x"),
  },
  {
    name: "setTextContent",
    run: (text, locator) => setTextContent(text, locator, "x"),
  },
  {
    name: "insertTid",
    run: (text, locator) => insertTid(text, locator, "t1"),
  },
  {
    name: "setStyleDeclaration",
    run: (text, locator) => setStyleDeclaration(text, locator, "color", "red"),
  },
];

describe("locator edits", () => {
  const edits = LOCATOR_EDITS;
  const text = `<p data-tid="dup">a</p><p data-tid="dup">b</p><p data-tid="one">c</p><span>d</span><!-- <b> -->`;

  for (const { name, run } of edits) {
    it(`${name} surfaces locator misses`, () => {
      expect(refused(run(text, tid("missing")))).toBe("not-found");
      expect(refused(run(text, tid("dup")))).toBe("ambiguous");
      expect(
        refused(
          run(text, {
            kind: "position",
            startTagOffset: text.indexOf("<span"),
            tagName: "p",
          }),
        ),
      ).toBe("tag-mismatch");
      expect(
        refused(
          run(text, {
            kind: "position",
            startTagOffset: text.indexOf("<span") + 1,
            tagName: "span",
          }),
        ),
      ).toBe("not-found");
      expect(refused(run(text, positionLocator(text, "<b", 0)))).toBe(
        "not-found",
      );
    });

    it(`${name} cannot edit implied elements`, () => {
      for (const tagName of ["html", "head", "body"]) {
        expect(
          refused(
            run("hello", { kind: "position", startTagOffset: 0, tagName }),
          ),
        ).toBe("not-found");
      }
    });
  }

  it("returns the element as it appears in the original text", () => {
    const original = `<div id="a"><p class="k">before</p></div>`;
    const locator = at(original, "<p");
    const result = setAttribute(original, locator, "class", "changed");
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.element).toEqual(located(locateElement(original, locator)));
    expect(sliceOf(original, result.element.startTag)).toBe(`<p class="k">`);
  });
});

describe("reconstructed formatting elements", () => {
  // `</p>` closes the p but leaves b in the formatting list, so "two" gets a
  // copy of b that shares the original start tag.
  // The adoption agency copies b for the moved p and gives the copy no source.
  const cases = [
    {
      label: "shared source offsets",
      text: `<p><b>one</p>two</b>`,
      boldOffset: 3,
      taggedText: `<p><b data-tid="t">one</p>two</b>`,
      paragraphOffset: 0,
      stamped: `<p data-src="0"><b>one</p>two</b>`,
    },
    {
      label: "source-less copy",
      text: `<b>x<p>y</b>z</p>`,
      boldOffset: 0,
      taggedText: `<b data-tid="t">x<p>y</b>z</p>`,
      paragraphOffset: 4,
      stamped: `<b>x<p data-src="4">y</b>z</p>`,
    },
  ] as const;
  const notUnique = { ok: false, reason: "not-unique" } as const;

  for (const reconstructed of cases) {
    const { label, text, boldOffset, taggedText } = reconstructed;
    const boldAt = (): ElementLocator => ({
      kind: "position",
      startTagOffset: boldOffset,
      tagName: "b",
    });

    it(`${label}: locating the formatting element by position is not unique`, () => {
      expect(locateElement(text, boldAt())).toEqual(notUnique);
      expect(locateElement(taggedText, boldAt())).toEqual(notUnique);
    });

    it(`${label}: locating the formatting element by its tid is not unique`, () => {
      expect(locateElement(taggedText, tid("t"))).toEqual(notUnique);
    });

    for (const { name, run } of LOCATOR_EDITS) {
      it(`${label}: ${name} refuses the formatting element as not unique`, () => {
        expect(refused(run(text, boldAt()))).toBe("not-unique");
        expect(refused(run(taggedText, boldAt()))).toBe("not-unique");
        expect(refused(run(taggedText, tid("t")))).toBe("not-unique");
      });
    }

    it(`${label}: stamping leaves every copy of the formatting element unmarked`, () => {
      const result = stampPositions(text, { attributeName: "data-src" });
      expect(result.text).toBe(reconstructed.stamped);
      expect(applySplices(text, result.splices)).toBe(result.text);
      expect(result.text.replace(/ data-src="\d+"/g, "")).toBe(text);

      const tagged = stampPositions(taggedText, { attributeName: "data-src" });
      expect(tagged.text.replace(/ data-src="\d+"/g, "")).toBe(taggedText);
      expect(tagged.text).not.toContain(`<b data-src`);
      expect(tagged.text).not.toContain(`<b data-tid="t" data-src`);
    });

    it(`${label}: stamping also strips a stamp left on the formatting element`, () => {
      const stale = text.replace("<b>", `<b data-src="99">`);
      const result = stampPositions(stale, { attributeName: "data-src" });
      // Offsets refer to the stale text, so compare what is left once the
      // stamps are gone.
      expect(result.text).not.toContain("<b data-src");
      expect(result.text.replace(/ data-src="\d+"/g, "")).toBe(text);
      expect(applySplices(stale, result.splices)).toBe(result.text);
    });

    it(`${label}: the paragraph around it stays addressable`, () => {
      const paragraph = located(
        locateElement(text, {
          kind: "position",
          startTagOffset: reconstructed.paragraphOffset,
          tagName: "p",
        }),
      );
      expect(paragraph.isUniqueSource).toBe(true);
    });
  }

  it("edits the paragraph that holds a reconstructed formatting element", () => {
    const text = `<p><b>one</p>two</b>`;
    expectEdit(
      text,
      setAttribute(text, at(text, "<p"), "class", "c"),
      `<p class="c"><b>one</p>two</b>`,
    );
  });

  it("keeps addressing siblings that come after a reconstruction", () => {
    const text = `<p><b>one</p>two</b><i>after</i>`;
    expectEdit(
      text,
      setTextContent(text, at(text, "<i"), "changed"),
      `<p><b>one</p>two</b><i>changed</i>`,
    );
    const stamped = stampPositions(text, { attributeName: "data-src" }).text;
    expect(stamped).toBe(
      `<p data-src="0"><b>one</p>two</b><i data-src="20">after</i>`,
    );
  });
});

/** Start offsets of every literal element, copies included, ascending. */
function sourceStarts(text: string): number[] {
  return parseHtmlSource(text)
    .elements.flatMap((element) =>
      element.startTag === null ? [] : [element.startTag.start],
    )
    .sort((left, right) => left - right);
}

/** `sourceStarts` of the original, moved to where the splices put them. */
function adjustedSourceStarts(
  original: string,
  splices: SourceSplice[],
): number[] {
  return sourceStarts(original)
    .map((start) => {
      const shift = splices
        .filter((splice) => splice.end <= start)
        .reduce(
          (sum, splice) =>
            sum + splice.replacement.length - (splice.end - splice.start),
          0,
        );
      return start + shift;
    })
    .sort((left, right) => left - right);
}

/** Every marker in the text the editor will serve names one unique element. */
function expectServedMarkersUnique(
  served: string,
  attributeName: string,
  label: string,
): void {
  const byValue = new Map<string, HtmlElement[]>();
  for (const element of parseHtmlSource(served).elements) {
    for (const attribute of element.attrs) {
      if (attribute.name === attributeName) {
        byValue.set(attribute.value, [
          ...(byValue.get(attribute.value) ?? []),
          element,
        ]);
      }
    }
  }
  for (const [value, elements] of byValue) {
    expect(elements, `${label} marker ${value}`).toHaveLength(1);
    expect(elements[0].isUniqueSource, `${label} marker ${value}`).toBe(true);
  }
}

describe("formatting elements that stop being unique once they are edited", () => {
  // Four identical formatting start tags: the Noah's Ark rule drops the first
  // from the formatting list, so only the last three are reopened as copies
  // after `</p>`. Giving the first one an attribute makes it differ from the
  // others, the rule no longer drops it, and it is reopened as a copy as well.
  const reproducers = [
    {
      label: "plain",
      text: `<p><b><b><b><b>one</p>two`,
      offsets: [3, 6, 9, 12],
    },
    {
      label: "identical class",
      text: `<p><b class="x"><b class="x"><b class="x"><b class="x">one</p>two`,
      offsets: [3, 16, 29, 42],
    },
  ] as const;

  for (const { label, text, offsets } of reproducers) {
    const [first, ...others] = offsets;
    const boldAt = (offset: number): ElementLocator => ({
      kind: "position",
      startTagOffset: offset,
      tagName: "b",
    });

    it(`${label}: only the first start tag is a unique source`, () => {
      const elements = parseHtmlSource(text).elements;
      const sharing = (offset: number): HtmlElement[] =>
        elements.filter((element) => element.startTag?.start === offset);

      expect(sharing(first)).toHaveLength(1);
      expect(sharing(first)[0].isUniqueSource).toBe(true);
      for (const offset of others) {
        expect(sharing(offset)).toHaveLength(2);
        for (const element of sharing(offset)) {
          expect(element.isUniqueSource).toBe(false);
        }
      }
    });

    it(`${label}: locating still succeeds for the first and misses for the rest`, () => {
      const element = located(locateElement(text, boldAt(first)));
      expect(element.tagName).toBe("b");
      expect(element.isUniqueSource).toBe(true);
      for (const offset of others) {
        expect(locateElement(text, boldAt(offset))).toEqual({
          ok: false,
          reason: "not-unique",
        });
      }
    });

    it(`${label}: edits that give the first start tag a new identity are refused`, () => {
      const target = boldAt(first);
      expect(refused(insertTid(text, target, "t"))).toBe("unsafe-context");
      expect(refused(setAttribute(text, target, "title", "T"))).toBe(
        "unsafe-context",
      );
      expect(refused(setAttribute(text, target, "class", "y"))).toBe(
        "unsafe-context",
      );
      expect(refused(setStyleDeclaration(text, target, "color", "red"))).toBe(
        "unsafe-context",
      );
    });

    it(`${label}: stamping leaves every formatting start tag unmarked`, () => {
      const result = stampPositions(text, { attributeName: "data-src" });
      expect(result.text).toBe(text.replace("<p>", `<p data-src="0">`));
      expect(applySplices(text, result.splices)).toBe(result.text);
      expectServedMarkersUnique(result.text, "data-src", label);

      // Serving the stamped text again must not change its markers.
      const again = stampPositions(result.text, { attributeName: "data-src" });
      expect(again.text).toBe(result.text);
    });

    it(`${label}: the paragraph around the formatting elements stays editable`, () => {
      const paragraph = at(text, "<p");
      const tagged = insertTid(text, paragraph, "t");
      expectEdit(text, tagged, text.replace("<p>", `<p data-tid="t">`));
      const attributed = setAttribute(text, paragraph, "class", "c");
      expectEdit(text, attributed, text.replace("<p>", `<p class="c">`));
      const styled = setStyleDeclaration(text, paragraph, "color", "red");
      expectEdit(text, styled, text.replace("<p>", `<p style="color: red">`));

      for (const result of [tagged, attributed, styled]) {
        if (!result.ok) {
          throw new Error(result.reason);
        }
        expect(sourceStarts(result.text)).toEqual(
          adjustedSourceStarts(text, result.splices),
        );
      }
    });
  }
});

describe("edits that change which element a source-less copy repeats", () => {
  // The three y start tags are reopened as copies with no source of their own.
  // Making the last x start tag a y one moves the Noah's Ark cutoff, so the
  // copy around "w" would repeat an x start tag instead of a y one. The copies
  // repeat start tags at offsets 33, 44 and 55 until then.
  const text = `<b class=x><b class=x><b class=x><b class=y><b class=y><b class=y><b class=x>x</b><p>y</b>z</b>w</b>t</p>`;
  const lastX: ElementLocator = {
    kind: "position",
    startTagOffset: 66,
    tagName: "b",
  };

  it("keeps the last start tag addressable on its own", () => {
    expect(text.slice(66, 77)).toBe("<b class=x>");
    const element = located(locateElement(text, lastX));
    expect(element.isUniqueSource).toBe(true);
  });

  it("refuses to turn it into the same class as the copied start tags", () => {
    expect(refused(setAttribute(text, lastX, "class", "y"))).toBe(
      "unsafe-context",
    );
  });

  it("accepts edits that leave every copy repeating the same start tag", () => {
    const retargeted = setAttribute(text, lastX, "class", "z");
    expectEdit(
      text,
      retargeted,
      text.replace("<b class=x>x</b>", "<b class=z>x</b>"),
    );
    const titled = setAttribute(text, lastX, "title", "T");
    expectEdit(
      text,
      titled,
      text.replace("<b class=x>x</b>", `<b class=x title="T">x</b>`),
    );

    for (const result of [retargeted, titled]) {
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(sourceStarts(result.text)).toEqual(
        adjustedSourceStarts(text, result.splices),
      );
    }
  });

  it("accepts edits to an element the copies do not repeat", () => {
    const paragraph = at(text, "<p>");
    expectEdit(
      text,
      setAttribute(text, paragraph, "class", "c"),
      text.replace("<p>", `<p class="c">`),
    );
  });
});

// ---------------------------------------------------------------------------
// insertTid
// ---------------------------------------------------------------------------

describe("insertTid", () => {
  it("inserts one splice right after the tag name", () => {
    const original = `<div class="a">t</div>`;
    const splices = expectEdit(
      original,
      insertTid(original, at(original, "<div"), "T1"),
      `<div data-tid="T1" class="a">t</div>`,
    );
    expect(splices).toEqual([
      { start: 4, end: 4, replacement: ` data-tid="T1"` },
    ]);
  });

  it("works for uppercase, void, self-closing and attribute-less tags", () => {
    const upper = `<DIV>x</DIV>`;
    expectEdit(
      upper,
      insertTid(upper, at(upper, "<DIV"), "a"),
      `<DIV data-tid="a">x</DIV>`,
    );

    const voided = `<br>`;
    expectEdit(
      voided,
      insertTid(voided, at(voided, "<br"), "b"),
      `<br data-tid="b">`,
    );

    const selfClosing = `<img src="x"/>`;
    expectEdit(
      selfClosing,
      insertTid(selfClosing, at(selfClosing, "<img"), "c"),
      `<img data-tid="c" src="x"/>`,
    );
  });

  it("targets the right element among nested siblings with BOM, CRLF and astral text", () => {
    const original = "﻿<div>\r\n😀<p>one</p>\r\n<p>two</p></div>";
    const result = insertTid(
      original,
      positionLocator(original, "<p", 1),
      "second",
    );
    expectEdit(
      original,
      result,
      '﻿<div>\r\n😀<p>one</p>\r\n<p data-tid="second">two</p></div>',
    );
  });

  it("refuses an element that already has a data-tid in any form", () => {
    for (const startTag of [
      `<div data-tid="x">`,
      `<div data-tid='x'>`,
      `<div data-tid=x>`,
      `<div data-tid>`,
      `<div data-tid="">`,
      `<div DATA-TID="x">`,
      `<div id="a" data-tid="x">`,
      `<div data-tid=a data-tid=b>`,
    ]) {
      const original = `${startTag}t</div>`;
      expect(refused(insertTid(original, at(original, "<div"), "new"))).toBe(
        "already-has-tid",
      );
    }
  });

  it("only looks at the target element's own attributes", () => {
    const original = `<div><p data-tid="child">t</p></div>`;
    expectEdit(
      original,
      insertTid(original, at(original, "<div"), "outer"),
      `<div data-tid="outer"><p data-tid="child">t</p></div>`,
    );
  });

  it("produces a tid that locateElement can use on the result", () => {
    const original = `<ul><li>a</li><li>b</li></ul>`;
    const result = insertTid(
      original,
      positionLocator(original, "<li", 1),
      "second",
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const found = located(locateElement(result.text, tid("second")));
    expect(directTexts(found)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// stampPositions
// ---------------------------------------------------------------------------

describe("stampPositions", () => {
  it("stamps every real start tag with its original offset", () => {
    const original = `<div><p>x</p><br></div>`;
    const result = stampPositions(original, { attributeName: "data-src" });
    expect(result.text).toBe(
      `<div data-src="0"><p data-src="5">x</p><br data-src="13"></div>`,
    );
    expect(applySplices(original, result.splices)).toBe(result.text);
    expect(result.splices.map((splice) => splice.start)).toEqual([4, 7, 16]);
  });

  it("offsets count the byte order mark and CRLF", () => {
    const bom = "﻿<div></div>";
    expect(stampPositions(bom, { attributeName: "data-src" }).text).toBe(
      '﻿<div data-src="1"></div>',
    );

    const crlf = "<p>\r\n<b>x</b></p>";
    expect(stampPositions(crlf, { attributeName: "data-src" }).text).toBe(
      '<p data-src="0">\r\n<b data-src="5">x</b></p>',
    );
  });

  it("stamps the real html, head and body tags after a leading BOM", () => {
    const original =
      '\uFEFF<!doctype html><html><head><title>t</title></head><body class="b"><p>x</p></body></html>';
    const result = stampPositions(original, { attributeName: "data-src" });
    expect(result.text).toBe(
      '\uFEFF<!doctype html><html data-src="16"><head data-src="22"><title data-src="28">t</title></head><body data-src="51" class="b"><p data-src="67">x</p></body></html>',
    );
    expect(applySplices(original, result.splices)).toBe(result.text);
  });

  it("leaves a marker authored on an ignored body token alone", () => {
    // The second body tag is dropped by the parser and its attributes land on
    // the implied body, which has no source of its own. That case is not
    // supported, so the authored value is kept and only the real tags change.
    const original = `<html><p>x<body data-pos=1>`;
    const body = onlyElement(original, "body");
    expect(body.startTag).toBeNull();
    // Source-less elements expose no attributes, since each one needs ranges.
    expect(body.attrs).toEqual([]);

    const result = stampPositions(original, { attributeName: "data-pos" });
    expect(result.text).toBe(
      `<html data-pos="0"><p data-pos="6">x<body data-pos=1>`,
    );
    expect(applySplices(original, result.splices)).toBe(result.text);

    expect(
      locateElement(original, {
        kind: "position",
        startTagOffset: original.indexOf("<body"),
        tagName: "body",
      }),
    ).toEqual({ ok: false, reason: "not-found" });
    // The authored marker value read as an offset does not find a body either.
    expect(
      locateElement(original, {
        kind: "position",
        startTagOffset: 1,
        tagName: "body",
      }),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("exposes a tid authored on an ignored body token as the implied body's effective tid", () => {
    const original = `<html><p>x<body data-tid=1>`;
    const body = onlyElement(original, "body");
    expect(body.startTag).toBeNull();
    expect(body.effectiveTid).toBe("1");

    const result = stampPositions(original, { attributeName: "data-tid" });
    expect(result.text).toBe(
      `<html data-tid="0"><p data-tid="6">x<body data-tid=1>`,
    );
  });

  it("does not touch markup that only appears inside raw text", () => {
    const original = `<script>"<body data-pos=1>"</script>`;
    expect(stampPositions(original, { attributeName: "data-pos" }).text).toBe(
      `<script data-pos="0">"<body data-pos=1>"</script>`,
    );
  });

  it("stamps in front of the self-closing slash", () => {
    expect(
      stampPositions(`<br/><img src="a"/>`, { attributeName: "data-src" }).text,
    ).toBe(`<br data-src="0"/><img data-src="5" src="a"/>`);
  });

  it("skips closing tags, comments, doctypes, raw text and implied elements", () => {
    const original = `<!DOCTYPE html><!-- <div> --><script>"<div>";</script><textarea><div></textarea><p>x</p>`;
    const result = stampPositions(original, { attributeName: "data-src" });
    expect(result.text).toBe(
      `<!DOCTYPE html><!-- <div> --><script data-src="29">"<div>";</script><textarea data-src="54"><div></textarea><p data-src="80">x</p>`,
    );
    expect(applySplices(original, result.splices)).toBe(result.text);
  });

  it("returns the text untouched when there is no start tag", () => {
    const original = `just <!-- <b> --> text`;
    expect(stampPositions(original, { attributeName: "data-src" })).toEqual({
      text: original,
      splices: [],
    });
  });

  it("stamps elements inside templates and foreign content", () => {
    const original = `<template><div>x</div></template><svg><circle/></svg>`;
    const stamped = stampPositions(original, {
      attributeName: "data-src",
    }).text;
    expect(stamped).toBe(
      `<template data-src="0"><div data-src="10">x</div></template><svg data-src="33"><circle data-src="38"/></svg>`,
    );
  });

  it("leaves a plain data-tid alone unless it is the requested attribute", () => {
    const original = `<div data-tid="x"><p>y</p></div>`;
    expect(stampPositions(original, { attributeName: "data-src" }).text).toBe(
      `<div data-src="0" data-tid="x"><p data-src="18">y</p></div>`,
    );
    expect(stampPositions(original, { attributeName: "data-tid" }).text).toBe(
      `<div data-tid="0"><p data-tid="18">y</p></div>`,
    );
  });

  it("restamps by replacing the old attribute, whatever its form", () => {
    expect(
      stampPositions(`<div data-src="99"><p data-src='3'>x</p></div>`, {
        attributeName: "data-src",
      }).text,
    ).toBe(`<div data-src="0"><p data-src="19">x</p></div>`);

    for (const oldForm of [
      "data-src",
      "data-src=5",
      `DATA-SRC="1"`,
      `data-src=''`,
    ]) {
      const original = `<div ${oldForm}>x</div>`;
      const result = stampPositions(original, { attributeName: "data-src" });
      expect(result.text).toBe(`<div data-src="0">x</div>`);
      expect(applySplices(original, result.splices)).toBe(result.text);
    }
  });

  it("restamping stamped text records offsets in the text it was given", () => {
    const original = `<div><p>x</p></div>`;
    const first = stampPositions(original, { attributeName: "data-src" });
    expect(first.text).toBe(`<div data-src="0"><p data-src="5">x</p></div>`);

    const second = stampPositions(first.text, { attributeName: "data-src" });
    expect(second.text).toBe(`<div data-src="0"><p data-src="18">x</p></div>`);
    expect(second.text.replace(/ data-src="\d+"/g, "")).toBe(original);
  });

  it("keeps other attributes of stamped elements byte for byte", () => {
    const original = `<a title="x>y" href=z hidden DATA-Q='1'>t</a>`;
    expect(stampPositions(original, { attributeName: "data-src" }).text).toBe(
      `<a data-src="0" title="x>y" href=z hidden DATA-Q='1'>t</a>`,
    );
  });
});

// ---------------------------------------------------------------------------
// setAttribute
// ---------------------------------------------------------------------------

describe("setAttribute", () => {
  const original = `<div id="a" class='b' data-x=c hidden>t</div>`;
  const div = at(original, "<div");

  it("replaces only the value and keeps the existing quote style", () => {
    expectEdit(
      original,
      setAttribute(original, div, "id", "z"),
      `<div id="z" class='b' data-x=c hidden>t</div>`,
    );
    expectEdit(
      original,
      setAttribute(original, div, "class", "q"),
      `<div id="a" class='q' data-x=c hidden>t</div>`,
    );
    expectEdit(
      original,
      setAttribute(original, div, "data-x", "d"),
      `<div id="a" class='b' data-x=d hidden>t</div>`,
    );
  });

  it("wraps an unquoted attribute in double quotes when the new value is not legal unquoted", () => {
    expectEdit(
      original,
      setAttribute(original, div, "data-x", "a b"),
      `<div id="a" class='b' data-x="a b" hidden>t</div>`,
    );
    expectEdit(
      original,
      setAttribute(original, div, "data-x", ""),
      `<div id="a" class='b' data-x="" hidden>t</div>`,
    );
    expectEdit(
      original,
      setAttribute(original, div, "data-x", 'a"b'),
      `<div id="a" class='b' data-x="a&quot;b" hidden>t</div>`,
    );
    expectEdit(
      original,
      setAttribute(original, div, "data-x", "a=b"),
      `<div id="a" class='b' data-x="a=b" hidden>t</div>`,
    );
  });

  it("gives a valueless attribute a quoted value", () => {
    expectEdit(
      original,
      setAttribute(original, div, "hidden", "yes"),
      `<div id="a" class='b' data-x=c hidden="yes">t</div>`,
    );
  });

  it("gives a valueless attribute an explicit empty value", () => {
    const valueless = `<p hidden>t</p>`;
    expectEdit(
      valueless,
      setAttribute(valueless, at(valueless, "<p"), "hidden", ""),
      `<p hidden="">t</p>`,
    );
  });

  it("appends a missing attribute before the end of the start tag", () => {
    expectEdit(
      original,
      setAttribute(original, div, "title", "T"),
      `<div id="a" class='b' data-x=c hidden title="T">t</div>`,
    );

    const selfClosing = `<img src="a"/>`;
    expectEdit(
      selfClosing,
      setAttribute(selfClosing, at(selfClosing, "<img"), "alt", "x"),
      `<img src="a" alt="x"/>`,
    );

    const bare = `<br/>`;
    expectEdit(
      bare,
      setAttribute(bare, at(bare, "<br"), "class", "x"),
      `<br class="x"/>`,
    );

    const none = `<p>t</p>`;
    expectEdit(
      none,
      setAttribute(none, at(none, "<p"), "id", "n"),
      `<p id="n">t</p>`,
    );
  });

  it("removes an attribute together with one preceding space", () => {
    expectEdit(
      original,
      setAttribute(original, div, "id", null),
      `<div class='b' data-x=c hidden>t</div>`,
    );
    expectEdit(
      original,
      setAttribute(original, div, "class", null),
      `<div id="a" data-x=c hidden>t</div>`,
    );
    expectEdit(
      original,
      setAttribute(original, div, "hidden", null),
      `<div id="a" class='b' data-x=c>t</div>`,
    );

    const sole = `<div id="a">t</div>`;
    expectEdit(
      sole,
      setAttribute(sole, at(sole, "<div"), "id", null),
      `<div>t</div>`,
    );
  });

  it("matches existing names case-insensitively and keeps their source casing", () => {
    const upper = `<DIV ID="X" Data-Foo=1>t</DIV>`;
    expectEdit(
      upper,
      setAttribute(upper, at(upper, "<DIV"), "id", "Y"),
      `<DIV ID="Y" Data-Foo=1>t</DIV>`,
    );
    expectEdit(
      upper,
      setAttribute(upper, at(upper, "<DIV"), "data-foo", "2"),
      `<DIV ID="X" Data-Foo=2>t</DIV>`,
    );
  });

  it("refuses to pick between two attributes of the same name", () => {
    const duplicated = `<div id=a id=b>t</div>`;
    expect(
      refused(setAttribute(duplicated, at(duplicated, "<div"), "id", "z")),
    ).toBe("duplicate-attribute");
    expect(
      refused(setAttribute(duplicated, at(duplicated, "<div"), "id", null)),
    ).toBe("duplicate-attribute");
  });

  it("still edits other names on an element that repeats one attribute", () => {
    const duplicated = `<div id=a id=b>t</div>`;
    expectEdit(
      duplicated,
      setAttribute(duplicated, at(duplicated, "<div"), "title", "T"),
      `<div id=a id=b title="T">t</div>`,
    );
  });

  it("rejects names that could not be written as an attribute", () => {
    for (const name of [
      "",
      "a b",
      'a"b',
      "a'b",
      "a=b",
      "a/b",
      "a>b",
      "a<b",
      "a\u0001b",
      "a\tb",
      "a\nb",
    ]) {
      expect(refused(setAttribute(original, div, name, "v"))).toBe(
        "invalid-attribute-name",
      );
    }
  });

  it("leaves a quoted `>` in other attributes alone", () => {
    const tricky = `<a title="x>y" data-q='>' href=z>t</a>`;
    expectEdit(
      tricky,
      setAttribute(tricky, at(tricky, "<a"), "href", "w"),
      `<a title="x>y" data-q='>' href=w>t</a>`,
    );
    expectEdit(
      tricky,
      setAttribute(tricky, at(tricky, "<a"), "rel", "r"),
      `<a title="x>y" data-q='>' href=z rel="r">t</a>`,
    );
  });

  it("is not fooled by tag-like text in scripts, comments and earlier elements", () => {
    const decoys = `<script>"<div id=x>"</script><!-- <div id=y> --><div id="real">t</div>`;
    expectEdit(
      decoys,
      setAttribute(decoys, at(decoys, `<div id="real"`), "id", "done"),
      `<script>"<div id=x>"</script><!-- <div id=y> --><div id="done">t</div>`,
    );
  });

  it("preserves BOM, CRLF and astral text around the edit", () => {
    const text = '﻿😀<div id="a">\r\n日本\r\n</div>\r\n';
    expectEdit(
      text,
      setAttribute(text, at(text, "<div"), "id", "b"),
      '﻿😀<div id="b">\r\n日本\r\n</div>\r\n',
    );
  });

  describe("value escaping", () => {
    it("escapes ampersands and the delimiter of a double-quoted value", () => {
      const text = `<p id="a">t</p>`;
      const p = at(text, "<p");
      expectEdit(
        text,
        setAttribute(text, p, "id", 'say "hi"'),
        `<p id="say &quot;hi&quot;">t</p>`,
      );
      expectEdit(
        text,
        setAttribute(text, p, "id", "a&b"),
        `<p id="a&amp;b">t</p>`,
      );
      expectEdit(
        text,
        setAttribute(text, p, "id", "&amp;"),
        `<p id="&amp;amp;">t</p>`,
      );
      expectEdit(
        text,
        setAttribute(text, p, "id", "&lt;"),
        `<p id="&amp;lt;">t</p>`,
      );
      expectEdit(
        text,
        setAttribute(text, p, "id", "&&"),
        `<p id="&amp;&amp;">t</p>`,
      );
    });

    it("escapes the delimiter of a single-quoted value", () => {
      const text = `<p class='b'>t</p>`;
      const p = at(text, "<p");
      expectEdit(
        text,
        setAttribute(text, p, "class", "it's"),
        `<p class='it&#39;s'>t</p>`,
      );
      expectEdit(
        text,
        setAttribute(text, p, "class", 'say "hi"'),
        `<p class='say "hi"'>t</p>`,
      );
    });

    it("leaves the other quote character and angle brackets alone", () => {
      const text = `<p id="a" title='t'>t</p>`;
      const p = at(text, "<p");
      expectEdit(
        text,
        setAttribute(text, p, "id", "it's p>q"),
        `<p id="it's p>q" title='t'>t</p>`,
      );
    });

    it("writes non-ASCII values as they are", () => {
      const text = `<p id="a">t</p>`;
      expectEdit(
        text,
        setAttribute(text, at(text, "<p"), "id", "日本😀"),
        `<p id="日本😀">t</p>`,
      );
    });

    it("round-trips awkward values through every quote style and a re-parse", () => {
      const values = [
        "",
        "plain",
        "a b",
        `"`,
        "'",
        `"'`,
        "&",
        "&amp;",
        "&#65;",
        "&copy",
        "&unknown;",
        "a&b=c&amp;d",
        "<>",
        "line\nbreak",
        "tab\there",
        "日本語😀",
        "a=b",
        "`tick`",
      ];
      for (const start of [
        `<p id="a">t</p>`,
        `<p id='a'>t</p>`,
        `<p id=a>t</p>`,
        `<p id>t</p>`,
        `<p>t</p>`,
      ]) {
        for (const value of values) {
          const result = setAttribute(start, at(start, "<p"), "id", value);
          expectAttributeRoundTrip(start, result, "p", "id", value);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// setTextNode
// ---------------------------------------------------------------------------

describe("setTextNode", () => {
  it("replaces the whole text node, including its entities", () => {
    const original = `<p>x &amp; y</p>`;
    expectEdit(
      original,
      setTextNode(original, at(original, "<p"), 0, "z"),
      `<p>z</p>`,
    );
  });

  it("indexes direct text children only, ignoring elements and comments", () => {
    const original = `<p>a <b>x</b> c<!--k--> d</p>`;
    const p = at(original, "<p");
    expectEdit(
      original,
      setTextNode(original, p, 0, "Z"),
      `<p>Z<b>x</b> c<!--k--> d</p>`,
    );
    expectEdit(
      original,
      setTextNode(original, p, 1, "Z"),
      `<p>a <b>x</b>Z<!--k--> d</p>`,
    );
    expectEdit(
      original,
      setTextNode(original, p, 2, "Z"),
      `<p>a <b>x</b> c<!--k-->Z</p>`,
    );
    expect(refused(setTextNode(original, p, 3, "Z"))).toBe(
      "text-node-not-found",
    );
  });

  it("does not reach into descendants", () => {
    const original = `<div><b>deep</b></div>`;
    expect(refused(setTextNode(original, at(original, "<div"), 0, "x"))).toBe(
      "text-node-not-found",
    );
    expectEdit(
      original,
      setTextNode(original, at(original, "<b"), 0, "shallow"),
      `<div><b>shallow</b></div>`,
    );
  });

  it("counts whitespace-only text nodes", () => {
    const original = `<div> <b>x</b> </div>`;
    const div = at(original, "<div");
    expectEdit(
      original,
      setTextNode(original, div, 0, "A"),
      `<div>A<b>x</b> </div>`,
    );
    expectEdit(
      original,
      setTextNode(original, div, 1, "B"),
      `<div> <b>x</b>B</div>`,
    );
  });

  it("reports an element without text as text-node-not-found", () => {
    const original = `<p></p><br>`;
    expect(refused(setTextNode(original, at(original, "<p"), 0, "x"))).toBe(
      "text-node-not-found",
    );
  });

  it("escapes ampersands and angle brackets, but not quotes", () => {
    const original = `<p>old</p>`;
    expectEdit(
      original,
      setTextNode(original, at(original, "<p"), 0, `a & b <c> "d" 'e'`),
      `<p>a &amp; b &lt;c&gt; "d" 'e'</p>`,
    );
    expectEdit(
      original,
      setTextNode(original, at(original, "<p"), 0, "&lt;"),
      `<p>&amp;lt;</p>`,
    );
  });

  it("refuses raw-text elements", () => {
    for (const original of [
      `<script>var a;</script>`,
      `<style>p {}</style>`,
      `<textarea>x</textarea>`,
      `<title>x</title>`,
    ]) {
      const name = /^<([a-z]+)/.exec(original)?.[1];
      if (name === undefined) {
        throw new Error("fixture has no tag");
      }
      expect(
        refused(setTextNode(original, at(original, `<${name}`), 0, "new")),
      ).toBe("raw-text");
    }
  });

  it("works on astral, CRLF and BOM text", () => {
    const original = "﻿<div>😀<b>b</b>日本\r\n</div>";
    expectEdit(
      original,
      setTextNode(original, at(original, "<div"), 1, "Z"),
      "﻿<div>😀<b>b</b>Z</div>",
    );
    expectEdit(
      original,
      setTextNode(original, at(original, "<div"), 0, "Z"),
      "﻿<div>Z<b>b</b>日本\r\n</div>",
    );
  });

  it("round-trips awkward text through a re-parse", () => {
    const original = `<p>old</p>`;
    for (const value of ["&", "&amp;", "<b>", "a\nb", "日本😀", "&#65;"]) {
      const result = setTextNode(original, at(original, "<p"), 0, value);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(applySplices(original, result.splices)).toBe(result.text);
      expect(directTexts(onlyElement(result.text, "p"))).toEqual([value]);
    }
  });
});

// ---------------------------------------------------------------------------
// setTextContent
// ---------------------------------------------------------------------------

describe("setTextContent", () => {
  it("replaces everything between the start and end tag", () => {
    const original = `<p class="k">Hello</p>`;
    expectEdit(
      original,
      setTextContent(original, at(original, "<p"), "Bye"),
      `<p class="k">Bye</p>`,
    );
  });

  it("fills an empty element and can empty a full one", () => {
    const empty = `<p></p>`;
    expectEdit(
      empty,
      setTextContent(empty, at(empty, "<p"), "Bye"),
      `<p>Bye</p>`,
    );
    const full = `<p>Hello</p>`;
    expectEdit(full, setTextContent(full, at(full, "<p"), ""), `<p></p>`);
  });

  it("escapes ampersands and angle brackets", () => {
    const original = `<p>x</p>`;
    expectEdit(
      original,
      setTextContent(original, at(original, "<p"), `a & b <c> "d"`),
      `<p>a &amp; b &lt;c&gt; "d"</p>`,
    );
  });

  it("replaces entity-laden, CRLF and astral content in one splice", () => {
    const original = '﻿<div id="a">\r\n😀 &amp; 日本\r\n</div>';
    const splices = expectEdit(
      original,
      setTextContent(original, at(original, "<div"), "new"),
      '﻿<div id="a">new</div>',
    );
    expect(splices).toHaveLength(1);
  });

  it("refuses element children, even deeply mixed ones", () => {
    for (const original of [
      `<p>a<b>x</b></p>`,
      `<p><b>x</b></p>`,
      `<div>a <span>b <i>c</i></span> d</div>`,
    ]) {
      const name = original.startsWith("<p") ? "<p" : "<div";
      expect(refused(setTextContent(original, at(original, name), "x"))).toBe(
        "has-element-children",
      );
    }
  });

  it("refuses comment children", () => {
    for (const original of [`<p>a<!--c--></p>`, `<p><!--c--></p>`]) {
      expect(refused(setTextContent(original, at(original, "<p"), "x"))).toBe(
        "has-non-text-children",
      );
    }
  });

  it("refuses text that the parser foster-parented out of the element", () => {
    const original = `<table>outside</table>`;
    expect(
      refused(setTextContent(original, at(original, "<table"), "new")),
    ).toBe("unsafe-source-range");
  });

  it("refuses raw-text, void and unclosed elements", () => {
    const script = `<script>var a;</script>`;
    expect(refused(setTextContent(script, at(script, "<script"), "x"))).toBe(
      "raw-text",
    );
    const title = `<title>t</title>`;
    expect(refused(setTextContent(title, at(title, "<title"), "x"))).toBe(
      "raw-text",
    );
    const voided = `<br>`;
    expect(refused(setTextContent(voided, at(voided, "<br"), "x"))).toBe(
      "void-element",
    );

    const unclosed = `<p>one<p>two</p>`;
    expect(
      refused(
        setTextContent(unclosed, positionLocator(unclosed, "<p", 0), "x"),
      ),
    ).toBe("missing-end-tag");
    expectEdit(
      unclosed,
      setTextContent(unclosed, positionLocator(unclosed, "<p", 1), "TWO"),
      `<p>one<p>TWO</p>`,
    );
  });
});

// ---------------------------------------------------------------------------
// Text edits must survive a re-parse
// ---------------------------------------------------------------------------

describe("text edits that must survive a re-parse", () => {
  function editedText(result: EditResult): string {
    if (!result.ok) {
      throw new Error(`edit refused: ${result.reason}`);
    }
    return result.text;
  }

  describe("pre and listing", () => {
    for (const name of ["pre", "listing"]) {
      it(`${name}: a leading line feed doubles when it lands directly after the start tag`, () => {
        const original = `<${name}>a</${name}>`;
        const locator = at(original, `<${name}`);
        for (const [value, written] of [
          ["\nx", "\n\nx"],
          ["\n", "\n\n"],
          ["\n\ny", "\n\n\ny"],
          ["x\ny", "x\ny"],
          ["", ""],
        ] as const) {
          const result = setTextContent(original, locator, value);
          expectEdit(original, result, `<${name}>${written}</${name}>`);
          expect(directTexts(onlyElement(editedText(result), name))).toEqual(
            value === "" ? [] : [value],
          );
        }
      });

      it(`${name}: only the first text node after the start tag gets the extra line feed`, () => {
        const original = `<${name}>a<b>c</b>d</${name}>`;
        const locator = at(original, `<${name}`);

        const first = setTextNode(original, locator, 0, "\nx");
        expectEdit(original, first, `<${name}>\n\nx<b>c</b>d</${name}>`);
        expect(directTexts(onlyElement(editedText(first), name))).toEqual([
          "\nx",
          "d",
        ]);

        expectEdit(
          original,
          setTextNode(original, locator, 1, "\nz"),
          `<${name}>a<b>c</b>\nz</${name}>`,
        );

        const afterElement = `<${name}><b>c</b>a</${name}>`;
        expectEdit(
          afterElement,
          setTextNode(afterElement, at(afterElement, `<${name}`), 0, "\nz"),
          `<${name}><b>c</b>\nz</${name}>`,
        );
      });
    }
  });

  it("pre and listing: an ignored line feed outside the splice already provides the padding", () => {
    for (const name of ["pre", "listing"]) {
      const original = `<${name}>\nabc</${name}>`;
      const locator = at(original, `<${name}`);

      const nodeEdit = setTextNode(original, locator, 0, "\nx");
      expectEdit(original, nodeEdit, `<${name}>\n\nx</${name}>`);
      expect(directTexts(onlyElement(editedText(nodeEdit), name))).toEqual([
        "\nx",
      ]);

      expectEdit(
        original,
        setTextContent(original, locator, "\nx"),
        `<${name}>\n\nx</${name}>`,
      );
    }
  });

  describe("table structure", () => {
    const fixtures = [
      ["table", `<table> <tr><td>a</td></tr></table>`],
      ["thead", `<table><thead> <tr><td>a</td></tr></thead></table>`],
      ["tbody", `<table><tbody> <tr><td>a</td></tr></tbody></table>`],
      ["tfoot", `<table><tfoot> <tr><td>a</td></tr></tfoot></table>`],
      ["tr", `<table><tbody><tr> <td>a</td></tr></tbody></table>`],
    ] as const;

    for (const [name, original] of fixtures) {
      it(`${name}: direct text nodes accept only HTML whitespace`, () => {
        const locator = at(original, `<${name}`);
        expect(directTexts(onlyElement(original, name))).toEqual([" "]);

        for (const value of ["x", " x ", " ", "&", "a b"]) {
          expect(refused(setTextNode(original, locator, 0, value))).toBe(
            "unsafe-context",
          );
        }
        expectEdit(
          original,
          setTextNode(original, locator, 0, "\n\t "),
          original.replace(" ", "\n\t "),
        );
      });
    }
  });

  describe("text the parser would change", () => {
    const original = `<p>a</p>`;
    const locator = at(original, "<p");

    it("refuses NUL and carriage returns, which re-parse differently", () => {
      for (const value of ["x\u0000y", "\u0000", "a\rb", "a\r\nb", "\r"]) {
        expect(refused(setTextContent(original, locator, value))).toBe(
          "unsafe-context",
        );
        expect(refused(setTextNode(original, locator, 0, value))).toBe(
          "unsafe-context",
        );
      }
    });

    it("keeps accepting line feeds, tabs and other text that survives", () => {
      expectEdit(
        original,
        setTextContent(original, locator, "a\nb\tc"),
        `<p>a\nb\tc</p>`,
      );
      expectEdit(
        original,
        setTextNode(original, locator, 0, "a\nb\tc"),
        `<p>a\nb\tc</p>`,
      );
    });
  });

  it("keeps refusing raw-text elements, whatever the replacement", () => {
    for (const name of ["script", "style", "textarea", "title"]) {
      const original = `<${name}>a</${name}>`;
      const locator = at(original, `<${name}`);
      for (const value of ["x", "\nx", "&"]) {
        expect(refused(setTextContent(original, locator, value))).toBe(
          "raw-text",
        );
        expect(refused(setTextNode(original, locator, 0, value))).toBe(
          "raw-text",
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// findLiteralText
// ---------------------------------------------------------------------------

describe("findLiteralText", () => {
  function found(text: string, needle: string, quote: string): string | null {
    const range = findLiteralText(text, at(text, needle), quote);
    return range === null ? null : text.slice(range.start, range.end);
  }

  it("returns the source range of a quote inside the element", () => {
    const text = `<p>Hello world</p>`;
    const range = findLiteralText(text, at(text, "<p"), "world");
    expect(range).toEqual({ start: 9, end: 14 });
  });

  it("searches descendant text", () => {
    const text = `<p>Hello <b>big <i>bold</i></b> world</p>`;
    expect(found(text, "<p", "bold")).toBe("bold");
    expect(found(text, "<p", "big")).toBe("big");
    expect(found(text, "<b", "bold")).toBe("bold");
    expect(found(text, "<i", "big")).toBeNull();
  });

  it("returns the first match when the quote repeats", () => {
    const text = `<p>ab ab ab</p>`;
    expect(findLiteralText(text, at(text, "<p"), "ab")).toEqual({
      start: 3,
      end: 5,
    });
  });

  it("returns null when nothing matches or the locator misses", () => {
    const text = `<p>Hello world</p><div>other</div>`;
    expect(found(text, "<p", "absent")).toBeNull();
    expect(found(text, "<p", "other")).toBeNull();
    expect(found(text, "<p", "WORLD")).toBeNull();
    expect(findLiteralText(text, tid("none"), "Hello")).toBeNull();
    expect(
      findLiteralText(
        text,
        { kind: "position", startTagOffset: 1, tagName: "p" },
        "Hello",
      ),
    ).toBeNull();
    expect(
      findLiteralText(
        text,
        { kind: "position", startTagOffset: 0, tagName: "div" },
        "Hello",
      ),
    ).toBeNull();
  });

  it("does not look into comments", () => {
    const text = `<p>a<!-- hidden -->b</p>`;
    expect(found(text, "<p", "hidden")).toBeNull();
    expect(found(text, "<p", "a")).toBe("a");
  });

  it("matches decoded text but returns raw source ranges", () => {
    const text = `<p>a &amp; b &lt;c&gt; &#65;BC</p>`;
    expect(found(text, "<p", "a & b")).toBe("a &amp; b");
    expect(found(text, "<p", "<c>")).toBe("&lt;c&gt;");
    expect(found(text, "<p", "&")).toBe("&amp;");
    expect(found(text, "<p", "ABC")).toBe("&#65;BC");
  });

  it("returns the whole source span of semicolon entities", () => {
    const named = `<p>a&semi;b c</p>`;
    expect(found(named, "<p", ";")).toBe("&semi;");
    expect(found(named, "<p", "a;b")).toBe("a&semi;b");
    expect(found(named, "<p", "b c")).toBe("b c");

    const numeric = `<p>x &#59; y</p>`;
    expect(found(numeric, "<p", ";")).toBe("&#59;");
    expect(found(numeric, "<p", "x ; y")).toBe("x &#59; y");
    expect(found(numeric, "<p", "; y")).toBe("&#59; y");
  });

  it("spans inline markup between the first and last matched characters", () => {
    const text = `<p>A <b>&amp;</b> B</p>`;
    expect(found(text, "<p", "A & B")).toBe("A <b>&amp;</b> B");
  });

  it("does not confuse an entity's source text with decoded text", () => {
    const text = `<p>a &amp;amp; b</p>`;
    // Decoded text is "a &amp; b": the quote matches the entity plus "amp;".
    expect(found(text, "<p", "&amp;")).toBe("&amp;amp;");
    // A naive source search would hit the entity itself at offset 5.
    const range = findLiteralText(text, at(text, "<p"), "amp;");
    expect(range).toEqual({ start: 10, end: 14 });
    expect(text.slice(10, 14)).toBe("amp;");
  });

  it("falls back to whitespace-normalized matching and keeps the source whitespace", () => {
    const text = `<p>Hello\n   world   again</p>`;
    expect(found(text, "<p", "Hello world")).toBe("Hello\n   world");
    expect(found(text, "<p", "world again")).toBe("world   again");
    expect(found(text, "<p", "Hello world again")).toBe(
      "Hello\n   world   again",
    );
  });

  it("normalizes CRLF as whitespace but still reports it in the range", () => {
    const text = "<p>a\r\nb c</p>";
    expect(found(text, "<p", "a b")).toBe("a\r\nb");
    expect(found(text, "<p", "b c")).toBe("b c");
  });

  it("prefers an exact match over an earlier normalized one", () => {
    const text = `<p>a  b a b</p>`;
    expect(findLiteralText(text, at(text, "<p"), "a b")).toEqual({
      start: 8,
      end: 11,
    });
  });

  it("reports offsets in UTF-16 units across astral characters", () => {
    const text = `<p>日本語😀 text 😀</p>`;
    expect(findLiteralText(text, at(text, "<p"), "text")).toEqual({
      start: text.indexOf("text"),
      end: text.indexOf("text") + 4,
    });
    expect(found(text, "<p", "😀")).toBe("😀");
    expect(findLiteralText(text, at(text, "<p"), "😀")?.start).toBe(
      text.indexOf("😀"),
    );
    expect(found(text, "<p", "語😀")).toBe("語😀");
  });

  it("finds text next to unrelated entities and elements in the same container", () => {
    const text = `<div>&lt;one&gt;<b>two</b> &amp; three</div>`;
    expect(found(text, "<div", "<one>")).toBe("&lt;one&gt;");
    expect(found(text, "<div", "& three")).toBe("&amp; three");
  });
});

// ---------------------------------------------------------------------------
// setStyleDeclaration
// ---------------------------------------------------------------------------

describe("setStyleDeclaration", () => {
  function withStyle(style: string): string {
    return `<div style="${style}">x</div>`;
  }

  function setStyle(
    style: string,
    property: string,
    value: string | null,
  ): { original: string; result: EditResult } {
    const original = withStyle(style);
    return {
      original,
      result: setStyleDeclaration(
        original,
        at(original, "<div"),
        property,
        value,
      ),
    };
  }

  function expectStyle(
    style: string,
    property: string,
    value: string | null,
    expectedStyle: string,
  ): void {
    const { original, result } = setStyle(style, property, value);
    expectEdit(original, result, withStyle(expectedStyle));
  }

  describe("replacing and appending", () => {
    it("replaces the value of an existing declaration", () => {
      expectStyle(
        "color: red; margin: 0",
        "color",
        "blue",
        "color: blue; margin: 0",
      );
      expectStyle(
        "color: red; margin: 0",
        "margin",
        "4px",
        "color: red; margin: 4px",
      );
    });

    it("appends a missing declaration with the right separator", () => {
      expectStyle("color: red", "margin", "0", "color: red; margin: 0");
      expectStyle("color: red;", "margin", "0", "color: red; margin: 0");
      expectStyle("", "margin", "0", "margin: 0");
    });

    it("creates the style attribute when there is none", () => {
      const original = `<div id="a">x</div>`;
      const result = setStyleDeclaration(
        original,
        at(original, "<div"),
        "margin",
        "0",
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(applySplices(original, result.splices)).toBe(result.text);
      expect(attributeValueIn(result.text, "div", "style")).toBe("margin: 0");
      expect(attributeValueIn(result.text, "div", "id")).toBe("a");
    });

    it("keeps !important when the value is replaced", () => {
      expectStyle(
        "color: red !important; margin: 0",
        "color",
        "blue",
        "color: blue !important; margin: 0",
      );
    });

    it("matches standard properties case-insensitively", () => {
      expectStyle("COLOR: red", "color", "blue", "COLOR: blue");
      expectStyle("color: red", "Color", "blue", "color: blue");
    });

    it("matches custom properties case-sensitively", () => {
      expectStyle(
        "--Brand: red; --brand: blue",
        "--brand",
        "green",
        "--Brand: red; --brand: green",
      );
      expectStyle(
        "--Brand: red; --brand: blue",
        "--Brand",
        "green",
        "--Brand: green; --brand: blue",
      );
      expectStyle("--x: 1", "--X", "2", "--x: 1; --X: 2");
    });

    it("works with uppercase element and attribute names", () => {
      const original = `<DIV STYLE="color: red">x</DIV>`;
      expectEdit(
        original,
        setStyleDeclaration(original, at(original, "<DIV"), "color", "blue"),
        `<DIV STYLE="color: blue">x</DIV>`,
      );
    });
  });

  describe("duplicate declarations", () => {
    it("edits the declaration that wins: the last one", () => {
      expectStyle(
        "color: red; margin: 0; color: blue",
        "color",
        "green",
        "color: red; margin: 0; color: green",
      );
      expectStyle(
        "COLOR: red; color: blue",
        "Color",
        "green",
        "COLOR: red; color: green",
      );
    });

    it("edits the important declaration even when it comes first", () => {
      expectStyle(
        "color: red !important; color: blue",
        "color",
        "green",
        "color: green !important; color: blue",
      );
    });

    it("edits the last of several important declarations", () => {
      expectStyle(
        "color: red !important; color: blue !important",
        "color",
        "green",
        "color: red !important; color: green !important",
      );
    });
  });

  describe("removal", () => {
    // A declaration runs from its property token through its own semicolon.
    // The whitespace before it stays, so a removal can leave spacing behind.
    it("removes a declaration from its property through its own semicolon", () => {
      expectStyle("a: 1; b: 2; c: 3", "b", null, "a: 1;  c: 3");
      expectStyle("a: 1; b: 2; c: 3", "a", null, " b: 2; c: 3");
      expectStyle("a: 1; b: 2; c: 3", "c", null, "a: 1; b: 2; ");
      expectStyle("color: red; width: 2px", "color", null, " width: 2px");
    });

    it("removes every match, whatever its case or importance", () => {
      expectStyle(
        "color: red; margin: 0; color: blue",
        "color",
        null,
        " margin: 0; ",
      );
      expectStyle(
        "COLOR: red !important; margin: 0; Color: blue",
        "color",
        null,
        " margin: 0; ",
      );
    });

    it("leaves other declarations that merely contain the name", () => {
      expectStyle(
        "background-color: red; color: blue",
        "color",
        null,
        "background-color: red; ",
      );
    });

    it("is a no-op when the property or the style attribute is missing", () => {
      const withOther = withStyle("margin: 0");
      expect(
        setStyleDeclaration(withOther, at(withOther, "<div"), "color", null),
      ).toMatchObject({ ok: true, text: withOther, splices: [] });

      const noStyle = `<div id="a">x</div>`;
      expect(
        setStyleDeclaration(noStyle, at(noStyle, "<div"), "color", null),
      ).toMatchObject({ ok: true, text: noStyle, splices: [] });
    });

    it("leaves the remaining declarations parseable", () => {
      const { original, result } = setStyle(
        "a: 1; b: url(x;y); c: ';'; b: 2",
        "b",
        null,
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(applySplices(original, result.splices)).toBe(result.text);
      expect(result.text).toBe(withStyle("a: 1;  c: ';'; "));
    });
  });

  describe("CSS syntax scanning", () => {
    it("ignores semicolons inside strings, parentheses and comments", () => {
      const style = `background: url(a;b); content: ';'; /* x; y */ color: red`;
      expectStyle(
        style,
        "color",
        "blue",
        `background: url(a;b); content: ';'; /* x; y */ color: blue`,
      );
      expectStyle(
        style,
        "content",
        "'z'",
        `background: url(a;b); content: 'z'; /* x; y */ color: red`,
      );
      expectStyle(
        style,
        "background",
        "none",
        `background: none; content: ';'; /* x; y */ color: red`,
      );
    });

    it("handles nested parentheses", () => {
      expectStyle(
        "width: calc(1px + (2px * (3px))); color: red",
        "color",
        "blue",
        "width: calc(1px + (2px * (3px))); color: blue",
      );
      expectStyle(
        "width: calc(1px + (2px * (3px))); color: red",
        "width",
        "1px",
        "width: 1px; color: red",
      );
    });

    it("handles escaped quotes inside CSS strings", () => {
      expectStyle(
        `content: 'it\\'s;'; color: red`,
        "color",
        "blue",
        `content: 'it\\'s;'; color: blue`,
      );
    });

    it("scans decoded text but edits the raw source", () => {
      const original = `<div style="content: &quot;/* ) ;&quot;; color: red">x</div>`;
      expectEdit(
        original,
        setStyleDeclaration(original, at(original, "<div"), "color", "blue"),
        `<div style="content: &quot;/* ) ;&quot;; color: blue">x</div>`,
      );
      expectEdit(
        original,
        setStyleDeclaration(original, at(original, "<div"), "content", "none"),
        `<div style="content: none; color: red">x</div>`,
      );
    });

    it("keeps entities in untouched declarations", () => {
      const original = `<div style="background: url(a?x=1&amp;y=2); color: red">x</div>`;
      expectEdit(
        original,
        setStyleDeclaration(original, at(original, "<div"), "color", "blue"),
        `<div style="background: url(a?x=1&amp;y=2); color: blue">x</div>`,
      );
      expectEdit(
        original,
        setStyleDeclaration(
          original,
          at(original, "<div"),
          "background",
          "none",
        ),
        `<div style="background: none; color: red">x</div>`,
      );
    });

    it("keeps a literal &semi; separator and the declarations around it", () => {
      const original = `<p style="color: red&semi; width: 2px">x</p>`;
      const result = setStyleDeclaration(
        original,
        at(original, "<p"),
        "color",
        "blue",
      );
      expectEdit(
        original,
        result,
        `<p style="color: blue&semi; width: 2px">x</p>`,
      );
      expect(attributeValueIn(result.ok ? result.text : "", "p", "style")).toBe(
        "color: blue; width: 2px",
      );
    });

    it("keeps CRLF, BOM and astral text in the style attribute", () => {
      const original =
        "﻿<div style=\"content: '日本😀';\r\n  margin: 0\">x</div>";
      expectEdit(
        original,
        setStyleDeclaration(original, at(original, "<div"), "margin", "4px"),
        "﻿<div style=\"content: '日本😀';\r\n  margin: 4px\">x</div>",
      );
    });
  });

  describe("value escaping", () => {
    it("escapes ampersands and the double quote of a double-quoted attribute", () => {
      const { original, result } = setStyle(
        "color: red",
        "font-family",
        `"Helvetica", sans`,
      );
      expectEdit(
        original,
        result,
        withStyle(`color: red; font-family: &quot;Helvetica&quot;, sans`),
      );
      expect(
        attributeValueIn(result.ok ? result.text : "", "div", "style"),
      ).toBe(`color: red; font-family: "Helvetica", sans`);

      expectStyle(
        "background: none",
        "background",
        "url(a?x=1&y=2)",
        "background: url(a?x=1&amp;y=2)",
      );
    });

    it("escapes the apostrophe of a single-quoted attribute", () => {
      const original = `<div style='color: red'>x</div>`;
      const div = at(original, "<div");
      expectEdit(
        original,
        setStyleDeclaration(original, div, "margin", "0"),
        `<div style='color: red; margin: 0'>x</div>`,
      );
      expectEdit(
        original,
        setStyleDeclaration(original, div, "font-family", `"A", b`),
        `<div style='color: red; font-family: "A", b'>x</div>`,
      );
      expectEdit(
        original,
        setStyleDeclaration(original, div, "content", "'x'"),
        `<div style='color: red; content: &#39;x&#39;'>x</div>`,
      );
    });

    it("accepts semicolons that are protected by a string or parentheses", () => {
      expectStyle("color: red", "content", `';'`, `color: red; content: ';'`);
      expectStyle(
        "color: red",
        "background",
        "url(a;b)",
        "color: red; background: url(a;b)",
      );
    });
  });

  describe("appending after the existing declarations", () => {
    it("treats an escaped final semicolon as part of the value", () => {
      expectStyle("--x: foo\\;", "color", "green", "--x: foo\\;; color: green");
      expectStyle(
        "--x: a\\;b; color: red",
        "color",
        "blue",
        "--x: a\\;b; color: blue",
      );
    });

    it("adds no semicolon after a real separator followed by a comment", () => {
      expectStyle(
        "color: red; /* c */",
        "margin",
        "0",
        "color: red; /* c */ margin: 0",
      );
    });

    it("adds one when the only semicolon sits inside a trailing comment", () => {
      expectStyle(
        "color: red /* ; */",
        "margin",
        "0",
        "color: red /* ; */; margin: 0",
      );
    });
  });

  describe("existing priority", () => {
    it("lets an escaped !important win over later plain declarations", () => {
      for (const priority of [
        "!im\\70ortant",
        "!im\\70 ortant",
        "!\\69 mportant",
        "! /* c */ important",
        "!/**/important",
      ]) {
        expectStyle(
          `color: red ${priority}; color: blue`,
          "color",
          "green",
          `color: green ${priority}; color: blue`,
        );
      }
    });

    it("does not duplicate priority when the new value carries its own", () => {
      expectStyle(
        "color: red !important; margin: 0",
        "color",
        "green !important",
        "color: green !important; margin: 0",
      );
      expectStyle(
        "color: red !im\\70ortant",
        "color",
        "green !important",
        "color: green !im\\70ortant",
      );
      expectStyle(
        "color: red",
        "color",
        "green !important",
        "color: green !important",
      );
    });

    it("does not mistake an escaped bang in a custom value for priority", () => {
      expectStyle("--x: a \\!important", "--x", "b", "--x: b");
      expectStyle(
        "--x: a \\!important; --x: later",
        "--x",
        "b",
        "--x: a \\!important; --x: b",
      );
    });
  });

  describe("unquoted url tokens", () => {
    const style = "background:url(https://x.test/*asset.png); color:red";

    it("keeps /* inside an unquoted url when editing another declaration", () => {
      expectStyle(
        style,
        "color",
        "blue",
        "background:url(https://x.test/*asset.png); color:blue",
      );
    });

    it("accepts an unquoted url containing /* as a new value", () => {
      expectStyle(
        style,
        "background",
        "url(https://y.test/*b.png)",
        "background:url(https://y.test/*b.png); color:red",
      );
      expectStyle(
        "color: red",
        "background",
        "url(https://y.test/*b.png)",
        "color: red; background: url(https://y.test/*b.png)",
      );
    });

    it("still reads /* as a comment everywhere else", () => {
      expectStyle(
        "background: url(a/*b); /* x; y */ color: red",
        "color",
        "blue",
        "background: url(a/*b); /* x; y */ color: blue",
      );
      expectStyle(
        "/* url( */ color: red",
        "color",
        "blue",
        "/* url( */ color: blue",
      );
      expectStyle(
        "content: 'url('; color: red",
        "color",
        "blue",
        "content: 'url('; color: blue",
      );
      expectStyle(
        "background: url(&quot;a/*b&quot;); color: red",
        "color",
        "blue",
        "background: url(&quot;a/*b&quot;); color: blue",
      );
    });

    it("still rejects an unclosed url or comment", () => {
      expect(
        refused(setStyle("color: red", "background", "url(a/*b").result),
      ).toBe("invalid-style-value");
      expect(
        refused(setStyle("color: red", "color", "red /* open").result),
      ).toBe("invalid-style-value");
    });
  });

  describe("duplicated style attributes", () => {
    it("refuses to choose between them", () => {
      const original = `<div style="color: red" style="margin: 0">x</div>`;
      for (const value of ["blue", null]) {
        expect(
          refused(
            setStyleDeclaration(original, at(original, "<div"), "color", value),
          ),
        ).toBe("duplicate-attribute");
      }
    });
  });

  describe("refusals", () => {
    it("rejects property names that are not a CSS identifier", () => {
      for (const property of [
        "",
        "a b",
        "a:b",
        "a;b",
        "a{",
        "a/*",
        "a(",
        '"a"',
      ]) {
        expect(refused(setStyle("color: red", property, "x").result)).toBe(
          "invalid-style-property",
        );
      }
    });

    it("rejects values that would break out of the declaration", () => {
      for (const value of [
        "red; margin: 0",
        "red;",
        "'unclosed",
        '"unclosed',
        "url(a",
        "a )",
        "/* open",
        "calc((1px)",
      ]) {
        expect(refused(setStyle("color: red", "color", value).result)).toBe(
          "invalid-style-value",
        );
      }
    });

    it("rejects an existing style attribute with an unterminated construct", () => {
      for (const style of [
        "color: 'red",
        "content: &quot;x",
        "background: url(b",
        "color: red /* c",
        "color: red)",
      ]) {
        expect(refused(setStyle(style, "margin", "0").result)).toBe(
          "malformed-style",
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Property-style tests over seeded random documents
// ---------------------------------------------------------------------------

/** mulberry32: small, fast and reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type StartTagKind = "stable" | "fragile" | "unsafe";

interface GeneratedDocument {
  text: string;
  /** Unique sources that stay unique when an attribute is added. */
  stableStartTagOffsets: number[];
  /**
   * Unique sources today, but an added attribute gives the formatting element a
   * new identity, so the parser reopens it as a copy. In source order.
   */
  fragileStartTagOffsets: number[];
  /**
   * Start tags of formatting elements the parser reconstructs or copies, so no
   * single element can be addressed by them. In source order.
   */
  unsafeStartTagOffsets: number[];
}

const TEXT_SNIPPETS = [
  "hello",
  " a &amp; b ",
  "日本語",
  "😀",
  "\r\n",
  "  ",
  "x < y",
  "&#65;&copy;",
  "1 > 0",
] as const;
const COMMENTS = [
  "<!-- <div> -->",
  "<!--[if IE]><div>x</div><![endif]-->",
  "<!---->",
] as const;
const ATTRIBUTES = [
  ` id="a"`,
  ` class='b c'`,
  ` data-x=c`,
  ` hidden`,
  ` title="x>y"`,
  ` DATA-Y="1"`,
  ` aria-label="&amp; é"`,
] as const;
const CONTAINERS = ["div", "span", "section", "article"] as const;
const VOIDS = ["br", "img", "input", "hr"] as const;
const FORMATTING = ["b", "i", "em", "strong", "u"] as const;

/**
 * Never writes the stamp attribute the stamping test uses, so removing the
 * inserted stamps has to give back the original document. Start tag offsets are
 * recorded while writing, not read back from the parser. Misnested formatting
 * fixtures record their formatting start tags as fragile or unsafe and
 * everything else as stable, which the HTML spec decides and not the code under
 * test.
 */
function generateDocument(seed: number): GeneratedDocument {
  const random = createRandom(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  let text = "";
  const offsets: Record<StartTagKind, number[]> = {
    stable: [],
    fragile: [],
    unsafe: [],
  };

  const casing = (name: string): string =>
    random() < 0.2 ? name.toUpperCase() : name;
  const writeStartTag = (
    name: string,
    attributes: string,
    slash: string,
    kind: StartTagKind,
  ) => {
    offsets[kind].push(text.length);
    text += `<${name}${attributes}${slash}>`;
  };
  const writeAttributes = (): string => {
    const chosen: string[] = [];
    const count = Math.floor(random() * 4);
    for (let index = 0; index < count; index++) {
      const attribute = pick(ATTRIBUTES);
      if (!chosen.includes(attribute)) {
        chosen.push(attribute);
      }
    }
    return chosen.join("");
  };

  const writeNode = (depth: number): void => {
    const roll = random();
    if (roll < 0.2) {
      text += pick(TEXT_SNIPPETS);
    } else if (roll < 0.3) {
      text += pick(COMMENTS);
    } else if (roll < 0.4) {
      const name = casing(pick(VOIDS));
      const attributes = writeAttributes();
      // A slash after an unquoted value would become part of that value.
      const slash = attributes === "" && random() < 0.5 ? "/" : "";
      writeStartTag(name, attributes, slash, "stable");
    } else if (roll < 0.45) {
      const name = casing("script");
      writeStartTag(name, writeAttributes(), "", "stable");
      text += `if (a<b) { s = "<div>"; }</${name}>`;
    } else if (roll < 0.5) {
      const name = casing("textarea");
      writeStartTag(name, writeAttributes(), "", "stable");
      text += `<div> &amp; x</${name}>`;
    } else if (roll < 0.55) {
      const name = casing("p");
      writeStartTag(name, writeAttributes(), "", "stable");
      text += pick(TEXT_SNIPPETS);
      text += `</${name}>`;
    } else if (roll < 0.6 && depth < 3) {
      writeStartTag("template", writeAttributes(), "", "stable");
      writeStartTag("div", "", "", "stable");
      text += pick(TEXT_SNIPPETS);
      text += "</div></template>";
    } else if (roll < 0.66 && depth < 3) {
      const formatting = casing(pick(FORMATTING));
      const paragraph = casing("p");
      if (random() < 0.5) {
        // `</p>` leaves the formatting element in the formatting list, so the
        // parser reopens a copy of it that shares this start tag.
        writeStartTag(paragraph, "", "", "stable");
        writeStartTag(formatting, writeAttributes(), "", "unsafe");
        text += `one</${paragraph}>two</${formatting}>`;
      } else {
        // The adoption agency copies the formatting element for the moved p.
        // The closing tags leave nothing open for the nodes written later.
        writeStartTag(formatting, writeAttributes(), "", "unsafe");
        text += "x";
        writeStartTag(paragraph, "", "", "stable");
        text += `y</${formatting}>z</${paragraph}></${formatting}>`;
      }
    } else if (roll < 0.72 && depth < 3) {
      // Four identical formatting start tags: the fourth pushes the first out
      // of the formatting list, so only the first is a unique source, and it
      // stops being one as soon as it differs from the other three.
      const formatting = casing(pick(FORMATTING));
      const paragraph = casing("p");
      const attributes = writeAttributes();
      writeStartTag(paragraph, "", "", "stable");
      writeStartTag(formatting, attributes, "", "fragile");
      for (let copy = 0; copy < 3; copy++) {
        writeStartTag(formatting, attributes, "", "unsafe");
      }
      text += `one</${paragraph}>two</${formatting}></${formatting}></${formatting}>`;
    } else if (depth < 3) {
      const name = casing(pick(CONTAINERS));
      writeStartTag(name, writeAttributes(), "", "stable");
      const count = Math.floor(random() * 4);
      for (let index = 0; index < count; index++) {
        writeNode(depth + 1);
      }
      text += `</${name}>`;
    } else {
      text += pick(TEXT_SNIPPETS);
    }
  };

  if (random() < 0.2) {
    text += "﻿";
  }
  if (random() < 0.2) {
    text += "<!DOCTYPE html>";
  }
  const topLevelCount = 1 + Math.floor(random() * 5);
  for (let index = 0; index < topLevelCount; index++) {
    writeNode(0);
  }
  return {
    text,
    stableStartTagOffsets: offsets.stable,
    fragileStartTagOffsets: offsets.fragile,
    unsafeStartTagOffsets: offsets.unsafe,
  };
}

const RANDOM_DOCUMENT_COUNT = 300;
const STAMP_ATTRIBUTE = "data-stamp-x";

function stripStamps(text: string): string {
  return text.replace(new RegExp(` ${STAMP_ATTRIBUTE}="\\d+"`, "g"), "");
}

function positionLocatorAtOffset(
  text: string,
  offset: number,
  label: string,
): ElementLocator {
  const nameMatch = /^<([A-Za-z][A-Za-z0-9]*)/.exec(text.slice(offset));
  if (nameMatch === null) {
    throw new Error(`${label}: no start tag at ${offset}`);
  }
  return { kind: "position", startTagOffset: offset, tagName: nameMatch[1] };
}

describe("seeded random documents", () => {
  it("includes stable, fragile and misnested start tags", () => {
    let withUnsafe = 0;
    let withFragile = 0;
    let withStable = 0;
    for (let seed = 1; seed <= RANDOM_DOCUMENT_COUNT; seed++) {
      const generated = generateDocument(seed);
      withUnsafe += generated.unsafeStartTagOffsets.length > 0 ? 1 : 0;
      withFragile += generated.fragileStartTagOffsets.length > 0 ? 1 : 0;
      withStable += generated.stableStartTagOffsets.length > 0 ? 1 : 0;
    }
    expect(withUnsafe).toBeGreaterThan(20);
    expect(withFragile).toBeGreaterThan(10);
    expect(withStable).toBeGreaterThan(200);
  });

  it("stamps exactly the stable start tags and strips back to the original", () => {
    for (let seed = 1; seed <= RANDOM_DOCUMENT_COUNT; seed++) {
      const { text, stableStartTagOffsets } = generateDocument(seed);
      const label = `seed ${seed}`;

      const result = stampPositions(text, { attributeName: STAMP_ATTRIBUTE });

      const stamped = Array.from(
        result.text.matchAll(new RegExp(` ${STAMP_ATTRIBUTE}="(\\d+)"`, "g")),
        (match) => Number(match[1]),
      );
      expect(stamped, label).toEqual(stableStartTagOffsets);

      const stampsAfterTagName = Array.from(
        result.text.matchAll(
          new RegExp(`<[A-Za-z][A-Za-z0-9]* ${STAMP_ATTRIBUTE}="\\d+"`, "g"),
        ),
      );
      expect(stampsAfterTagName, label).toHaveLength(
        stableStartTagOffsets.length,
      );

      expect(stripStamps(result.text), label).toBe(text);
      expect(applySplices(text, result.splices), label).toBe(result.text);
      // The served text, not just the input, must give every marker one owner.
      expectServedMarkersUnique(result.text, STAMP_ATTRIBUTE, label);
    }
  });

  it("restamping and then stripping still gives back the original", () => {
    for (let seed = 1; seed <= RANDOM_DOCUMENT_COUNT; seed++) {
      const { text } = generateDocument(seed);
      const once = stampPositions(text, { attributeName: STAMP_ATTRIBUTE });
      const twice = stampPositions(once.text, {
        attributeName: STAMP_ATTRIBUTE,
      });
      expect(stripStamps(twice.text), `seed ${seed}`).toBe(text);
      expect(applySplices(once.text, twice.splices), `seed ${seed}`).toBe(
        twice.text,
      );
      expectServedMarkersUnique(twice.text, STAMP_ATTRIBUTE, `seed ${seed}`);
    }
  });

  it("produces a tree whose ranges match the source, allowing repaired nesting", () => {
    for (let seed = 1; seed <= RANDOM_DOCUMENT_COUNT; seed++) {
      const {
        text,
        stableStartTagOffsets,
        fragileStartTagOffsets,
        unsafeStartTagOffsets,
      } = generateDocument(seed);
      const label = `seed ${seed}`;
      const document = parseHtmlSource(text);
      const wellNested =
        fragileStartTagOffsets.length === 0 &&
        unsafeStartTagOffsets.length === 0;
      const byNumber = (left: number, right: number): number => left - right;

      const startsOf = (element: HtmlElement): number[] =>
        element.startTag === null ? [] : [element.startTag.start];
      const literal = document.elements.filter(
        (element) => element.startTag !== null,
      );
      // Reconstruction repeats a start tag, so compare the distinct offsets.
      const distinctStarts = Array.from(
        new Set(literal.flatMap(startsOf)),
      ).sort(byNumber);
      expect(distinctStarts, label).toEqual(
        [
          ...stableStartTagOffsets,
          ...fragileStartTagOffsets,
          ...unsafeStartTagOffsets,
        ].sort(byNumber),
      );

      const sharing = (offset: number): HtmlElement[] =>
        literal.filter((element) => element.startTag?.start === offset);
      for (const offset of [
        ...stableStartTagOffsets,
        ...fragileStartTagOffsets,
      ]) {
        expect(sharing(offset), `${label} unique ${offset}`).toHaveLength(1);
        expect(sharing(offset)[0].isUniqueSource, `${label} ${offset}`).toBe(
          true,
        );
      }
      for (const offset of unsafeStartTagOffsets) {
        expect(
          sharing(offset).length,
          `${label} unsafe ${offset}`,
        ).toBeGreaterThan(0);
        for (const element of sharing(offset)) {
          expect(element.isUniqueSource, `${label} unsafe ${offset}`).toBe(
            false,
          );
        }
      }

      for (const element of document.elements) {
        if (element.startTag === null) {
          expect(element.tagNameRange, label).toBeNull();
          expect(element.isUniqueSource, label).toBe(false);
          continue;
        }
        const { startTag } = element;
        expect(text[startTag.start], label).toBe("<");
        expect(text[startTag.end - 1], label).toBe(">");
        const nameRange = element.tagNameRange;
        if (nameRange === null) {
          throw new Error(`${label}: literal element without a tag name range`);
        }
        expect(nameRange.start, label).toBe(startTag.start + 1);
        expect(sliceOf(text, nameRange).toLowerCase(), label).toBe(
          element.tagName,
        );
        for (const attribute of element.attrs) {
          expect(attribute.nameRange.start, label).toBeGreaterThanOrEqual(
            startTag.start,
          );
          expect(attribute.range.end, label).toBeLessThanOrEqual(startTag.end);
          expect(sliceOf(text, attribute.nameRange).toLowerCase(), label).toBe(
            attribute.name,
          );
        }
        if (element.endTag !== null) {
          expect(sliceOf(text, element.endTag).startsWith("</"), label).toBe(
            true,
          );
          expect(element.endTag.start, label).toBeGreaterThanOrEqual(
            startTag.end,
          );
        }
        let previousStart = startTag.end - 1;
        for (const child of element.children) {
          const range = child.kind === "element" ? child.startTag : child.range;
          if (range === null) {
            continue;
          }
          expect(range.start, label).toBeGreaterThanOrEqual(startTag.end);
          if (wellNested) {
            expect(range.start, label).toBeGreaterThan(previousStart);
          }
          if (child.kind === "comment") {
            expect(sliceOf(text, range).startsWith("<!--"), label).toBe(true);
            expect(sliceOf(text, range).endsWith("-->"), label).toBe(true);
          }
          previousStart = range.start;
        }
      }
    }
  });

  it("edits stable start tags, refuses fragile ones and misses unsafe ones", () => {
    for (let seed = 1; seed <= RANDOM_DOCUMENT_COUNT; seed++) {
      const {
        text,
        stableStartTagOffsets,
        fragileStartTagOffsets,
        unsafeStartTagOffsets,
      } = generateDocument(seed);
      const label = `seed ${seed}`;

      for (const offset of stableStartTagOffsets.slice(0, 5)) {
        const locator = positionLocatorAtOffset(text, offset, label);
        expect(
          located(locateElement(text, locator)).startTag?.start,
          label,
        ).toBe(offset);

        const tagged = insertTid(text, locator, "zz-random");
        if (!tagged.ok) {
          throw new Error(`${label}: ${tagged.reason}`);
        }
        expect(applySplices(text, tagged.splices), label).toBe(tagged.text);
        expect(tagged.text.replace(` data-tid="zz-random"`, ""), label).toBe(
          text,
        );
        // No other element may gain, lose or move a start tag.
        expect(sourceStarts(tagged.text), label).toEqual(
          adjustedSourceStarts(text, tagged.splices),
        );

        const attributed = setAttribute(text, locator, "title", "zz");
        if (!attributed.ok) {
          throw new Error(`${label}: ${attributed.reason}`);
        }
        expect(sourceStarts(attributed.text), label).toEqual(
          adjustedSourceStarts(text, attributed.splices),
        );
      }

      for (const offset of fragileStartTagOffsets) {
        const locator = positionLocatorAtOffset(text, offset, label);
        expect(
          located(locateElement(text, locator)).isUniqueSource,
          label,
        ).toBe(true);
        expect(refused(insertTid(text, locator, "zz-random")), label).toBe(
          "unsafe-context",
        );
        expect(refused(setAttribute(text, locator, "title", "zz")), label).toBe(
          "unsafe-context",
        );
        expect(
          refused(setStyleDeclaration(text, locator, "color", "red")),
          label,
        ).toBe("unsafe-context");
      }

      for (const offset of unsafeStartTagOffsets) {
        const locator = positionLocatorAtOffset(text, offset, label);
        expect(locateElement(text, locator), label).toEqual({
          ok: false,
          reason: "not-unique",
        });
        for (const { name, run } of LOCATOR_EDITS) {
          expect(refused(run(text, locator)), `${label} ${name}`).toBe(
            "not-unique",
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Performance guard: catches quadratic or worse growth, not small regressions.
// ---------------------------------------------------------------------------

describe("performance on large documents", () => {
  const LIMIT_MS = 1000;

  function buildDocument(minimumLength: number): string {
    const rows: string[] = [];
    let length = 0;
    for (let index = 0; length < minimumLength; index++) {
      const row = `<div class="row" id="r${index}" style="color: red; margin: ${index}px">text ${index} &amp; <b>x</b><!-- c --><br></div>\n`;
      rows.push(row);
      length += row.length;
    }
    return `<!DOCTYPE html><html><body>${rows.join("")}</body></html>`;
  }

  function timed<T>(operation: () => T): { value: T; elapsedMs: number } {
    const startedAt = performance.now();
    const value = operation();
    return { value, elapsedMs: performance.now() - startedAt };
  }

  function exerciseEveryOperation(text: string): void {
    const lastRow = text.lastIndexOf(`<div class="row"`);
    const locator: ElementLocator = {
      kind: "position",
      startTagOffset: lastRow,
      tagName: "div",
    };
    parseHtmlSource(text);
    locateElement(text, locator);
    stampPositions(text, { attributeName: "data-src" });
    setAttribute(text, locator, "title", "t");
    setStyleDeclaration(text, locator, "color", "blue");
    setTextNode(text, locator, 0, "t");
    insertTid(text, locator, "tid");
    findLiteralText(text, locator, "text");
  }

  // Compile and JIT everything on a small document first so the timed runs
  // below measure steady-state cost.
  beforeAll(() => {
    exerciseEveryOperation(buildDocument(20_000));
    exerciseEveryOperation(buildDocument(20_000));
  });

  const large = buildDocument(300_000);
  const lastRowOffset = large.lastIndexOf(`<div class="row"`);
  const lastRow: ElementLocator = {
    kind: "position",
    startTagOffset: lastRowOffset,
    tagName: "div",
  };

  it("builds a document of at least 300KB", () => {
    expect(large.length).toBeGreaterThanOrEqual(300_000);
  });

  it("parses within the limit", () => {
    const { value, elapsedMs } = timed(() => parseHtmlSource(large));
    expect(value.elements.length).toBeGreaterThan(1000);
    expect(elapsedMs).toBeLessThan(LIMIT_MS);
  });

  it("locates the last element within the limit", () => {
    const { value, elapsedMs } = timed(() => locateElement(large, lastRow));
    expect(value.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(LIMIT_MS);
  });

  it("stamps the whole document within the limit", () => {
    const { value, elapsedMs } = timed(() =>
      stampPositions(large, { attributeName: "data-src" }),
    );
    expect(value.text.length).toBeGreaterThan(large.length);
    expect(elapsedMs).toBeLessThan(LIMIT_MS);
  });

  it("applies single-element edits within the limit", () => {
    const operations: ReadonlyArray<() => EditResult> = [
      () => setAttribute(large, lastRow, "title", "t"),
      () => setAttribute(large, lastRow, "class", null),
      () => setStyleDeclaration(large, lastRow, "color", "blue"),
      () => setStyleDeclaration(large, lastRow, "margin", null),
      () => setTextNode(large, lastRow, 0, "changed"),
      () => insertTid(large, lastRow, "tid"),
    ];
    for (const operation of operations) {
      const { value, elapsedMs } = timed(operation);
      expect(value.ok).toBe(true);
      expect(elapsedMs).toBeLessThan(LIMIT_MS);
    }
  });

  it("finds literal text near the end of a large document within the limit", () => {
    const { value, elapsedMs } = timed(() =>
      findLiteralText(large, lastRow, "text"),
    );
    expect(value).not.toBeNull();
    expect(elapsedMs).toBeLessThan(LIMIT_MS);
  });

  it("does not degrade on a single huge text node with no match", () => {
    const words = `<p>${"a ".repeat(75_000)}</p>`;
    const entities = `<p>${"&amp; ".repeat(40_000)}</p>`;
    const quote = `${"a ".repeat(50)}b`;
    for (const [text, needle] of [
      [words, quote],
      [entities, "& & & x"],
    ] as const) {
      const { value, elapsedMs } = timed(() =>
        findLiteralText(text, at(text, "<p"), needle),
      );
      expect(value).toBeNull();
      expect(elapsedMs).toBeLessThan(LIMIT_MS);
    }
  });

  it("does not degrade on many unclosed siblings or many attributes", () => {
    const unclosed = "<p>x".repeat(20_000);
    const parsed = timed(() => parseHtmlSource(unclosed));
    expect(parsed.value.elements.length).toBeGreaterThanOrEqual(20_000);
    expect(parsed.elapsedMs).toBeLessThan(LIMIT_MS);

    const attributes = Array.from(
      { length: 5000 },
      (_, index) => ` a${index}="v"`,
    ).join("");
    const crowded = `<div${attributes}>t</div>`;
    const edited = timed(() =>
      setAttribute(crowded, at(crowded, "<div"), "a4999", "changed"),
    );
    expect(edited.value.ok).toBe(true);
    expect(edited.elapsedMs).toBeLessThan(LIMIT_MS);
  });
});
