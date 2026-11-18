import { describe, expect, it } from "vitest";
import { parseHtmlSource, type HtmlElement } from "@traycer/html-source";
import {
  canvasRetypeEdit,
  canvasRetypeTarget,
  type CanvasRetypeTarget,
} from "../canvas-inline-text-edit";
import { textSelection } from "./canvas-edit-test-support";

function elementOf(html: string, tagName: string): HtmlElement {
  const found = parseHtmlSource(html).elements.find(
    (candidate) => candidate.tagName === tagName,
  );
  if (found === undefined) throw new Error(`no <${tagName}> in ${html}`);
  return found;
}

function targetOf(html: string, tagName: string): CanvasRetypeTarget {
  const target = canvasRetypeTarget(elementOf(html, tagName));
  if (target === null) throw new Error(`<${tagName}> is not retypable`);
  return target;
}

const MIXED = `<p data-tid="lead">Hello <b>big</b> world</p>`;
const SELECTION = textSelection(null, {
  tid: "lead",
  marker: 99,
  tagName: "p",
  textPreview: "Hello big world",
});

describe("canvasRetypeTarget", () => {
  it("lists a plain text element as one leaf covering the whole block", () => {
    const target = targetOf("<p>Hello</p>", "p");

    expect(target.text).toBe("Hello");
    expect(target.textNodeIndex).toBeNull();
    expect(target.textNodes).toMatchObject([
      { start: 0, end: 5, text: "Hello", index: 0 },
    ]);
  });

  it("joins every descendant text leaf into the block's text, each with its own range and owner", () => {
    const target = targetOf(MIXED, "p");

    expect(target.text).toBe("Hello big world");
    expect(target.textNodes?.map((leaf) => leaf.text)).toEqual([
      "Hello ",
      "big",
      " world",
    ]);
    expect(
      target.textNodes?.map((leaf) => [leaf.start, leaf.end, leaf.index]),
    ).toEqual([
      [0, 6, 0],
      [6, 9, 0],
      [9, 15, 1],
    ]);
    expect(target.textNodes?.map((leaf) => leaf.element.tagName)).toEqual([
      "p",
      "b",
      "p",
    ]);
  });

  it("reaches text nested more than one level down", () => {
    const target = targetOf("<div>a<p>b<i>c</i></p>d</div>", "div");

    expect(target.text).toBe("abcd");
    expect(target.textNodes?.map((leaf) => leaf.element.tagName)).toEqual([
      "div",
      "p",
      "i",
      "div",
    ]);
  });

  it("measures offsets in decoded text, as the page's own text would", () => {
    const target = targetOf("<p>Fish &amp; <b>chips</b></p>", "p");

    expect(target.text).toBe("Fish & chips");
    expect(target.textNodes?.map((leaf) => [leaf.start, leaf.end])).toEqual([
      [0, 7],
      [7, 12],
    ]);
  });

  it("does not count comments as text", () => {
    const target = targetOf("<p>a<!--note-->b</p>", "p");

    expect(target.text).toBe("ab");
    expect(target.textNodes?.map((leaf) => leaf.text)).toEqual(["a", "b"]);
  });

  it.each([
    ["a script", "<p>a<script>var x = 1;</script></p>", "p"],
    ["a void element", "<p>a<br>b</p>", "p"],
    ["a nested raw-text element", "<p>a<b>b<style>.x{}</style></b></p>", "p"],
    ["a raw-text block itself", "<style>.x{}</style>", "style"],
    ["a void block itself", "<br>", "br"],
    ["a descendant whose end tag is implied", "<ul><li>a<li>b</ul>", "li"],
    [
      "a descendant with no start tag",
      "<table><tr><td>x</td></tr></table>",
      "table",
    ],
    ["a reconstructed formatting copy", "<p><b>one</p>two</b>", "p"],
  ])("refuses a block containing %s", (_label, html, tagName) => {
    expect(canvasRetypeTarget(elementOf(html, tagName))).toBeNull();
  });

  it.each([
    ["an empty element", "<p></p>"],
    ["only an empty inline", "<p><b></b></p>"],
  ])("refuses %s, which has no text to retype", (_label, html) => {
    expect(canvasRetypeTarget(elementOf(html, "p"))).toBeNull();
  });
});

describe("canvasRetypeEdit", () => {
  const target = targetOf(MIXED, "p");

  it("sends nothing when the text is unchanged", () => {
    expect(canvasRetypeEdit(target, "Hello big world", SELECTION)).toBeNull();
  });

  it("edits the block's own leaf when the change sits inside it", () => {
    const change = canvasRetypeEdit(target, "Howdy big world", SELECTION);

    expect(change?.edit).toEqual({
      kind: "set-text-node",
      index: 0,
      expectedText: "Hello ",
      text: "Howdy ",
    });
    expect(change?.selection.element).toMatchObject({
      tid: "lead",
      tagName: "p",
      marker: elementOf(MIXED, "p").startTag?.start,
    });
  });

  it("addresses the block's second leaf by its position among the block's own text", () => {
    const change = canvasRetypeEdit(target, "Hello big there", SELECTION);

    expect(change?.edit).toEqual({
      kind: "set-text-node",
      index: 1,
      expectedText: " world",
      text: " there",
    });
  });

  it("retargets the selection at the inline element that owns the changed leaf", () => {
    const change = canvasRetypeEdit(target, "Hello bag world", SELECTION);

    expect(change?.edit).toEqual({
      kind: "set-text-node",
      index: 0,
      expectedText: "big",
      text: "bag",
    });
    expect(change?.selection.element).toMatchObject({
      tagName: "b",
      tid: null,
      generated: false,
      marker: elementOf(MIXED, "b").startTag?.start,
    });
  });

  it("keeps everything else about the selection", () => {
    const change = canvasRetypeEdit(target, "Hello bag world", SELECTION);

    expect(change?.selection.artifactId).toBe(SELECTION.artifactId);
    expect(change?.selection.boardPath).toBe(SELECTION.boardPath);
    expect(change?.selection.servedSha256).toBe(SELECTION.servedSha256);
    expect(change?.selection.element.box).toEqual(SELECTION.element.box);
  });

  it("compares and replaces decoded text", () => {
    const entities = targetOf("<p>Fish &amp; <b>chips</b></p>", "p");

    expect(canvasRetypeEdit(entities, "Fish + chips", SELECTION)?.edit).toEqual(
      {
        kind: "set-text-node",
        index: 0,
        expectedText: "Fish & ",
        text: "Fish + ",
      },
    );
  });

  it("writes a one-leaf block back as a text-node edit too", () => {
    const single = targetOf("<p>Hello</p>", "p");

    expect(canvasRetypeEdit(single, "Bye", SELECTION)?.edit).toEqual({
      kind: "set-text-node",
      index: 0,
      expectedText: "Hello",
      text: "Bye",
    });
    expect(canvasRetypeEdit(single, "Hello!", SELECTION)?.edit).toMatchObject({
      text: "Hello!",
    });
  });

  it.each([
    ["replaces text across two leaves", "Bye"],
    ["deletes text spanning an inline's edge", "Hello world"],
    ["inserts exactly where an inline ends", "Hello bigger world"],
    ["inserts exactly where an inline begins", "Hello a big world"],
  ])("refuses a change that %s", (_label, value) => {
    expect(canvasRetypeEdit(target, value, SELECTION)).toBeNull();
  });

  describe("a target that is not a full block", () => {
    const whole = { text: "Hello", textNodeIndex: null };
    const oneNode = { text: "Hello", textNodeIndex: 2 };

    it("still replaces the whole element text", () => {
      expect(canvasRetypeEdit(whole, "Hi", SELECTION)?.edit).toEqual({
        kind: "set-text-content",
        text: "Hi",
      });
    });

    it("still replaces its one text node, expecting the text it opened with", () => {
      expect(canvasRetypeEdit(oneNode, "Hi", SELECTION)?.edit).toEqual({
        kind: "set-text-node",
        index: 2,
        text: "Hi",
        expectedText: "Hello",
      });
    });

    it("leaves the selection exactly as it was", () => {
      expect(canvasRetypeEdit(whole, "Hi", SELECTION)?.selection).toBe(
        SELECTION,
      );
    });

    it("sends nothing when the text is unchanged", () => {
      expect(canvasRetypeEdit(whole, "Hello", SELECTION)).toBeNull();
    });
  });
});
