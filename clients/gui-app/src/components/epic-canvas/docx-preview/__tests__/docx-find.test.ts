/**
 * `DocxFindEngine`'s search/paint contract (docx-find.ts): a match may span
 * multiple text nodes (Word runs split a paragraph at every formatting
 * boundary), so the engine flattens each block's text into one string before
 * searching it. Two adjacent blocks (a `<p>`, a table cell) must never read
 * as touching text - the flattened haystack joins blocks with `\n`, so a
 * query can never match across a paragraph boundary. Painting goes through
 * the CSS Custom Highlight API, which jsdom does not implement; `CSS` and
 * `Highlight` are stubbed globally for this file and restored after every
 * test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCX_FIND_HIGHLIGHT_CSS, DocxFindEngine } from "../docx-find";

class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: readonly Range[]) {
    this.ranges = ranges;
  }
}

function installHighlightApi(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal("Highlight", FakeHighlight);
  return registry;
}

describe("docx-find", () => {
  let registry: Map<string, FakeHighlight>;

  beforeEach(() => {
    registry = installHighlightApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the ::highlight() rules for both the match and active highlight names", () => {
    expect(DOCX_FIND_HIGHLIGHT_CSS).toContain(
      "::highlight(traycer-docx-find-match)",
    );
    expect(DOCX_FIND_HIGHLIGHT_CSS).toContain(
      "::highlight(traycer-docx-find-active)",
    );
  });

  describe("search", () => {
    it("finds a match that spans two runs within the same paragraph", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p><span>Hel</span><span>lo world</span></p>";
      const engine = new DocxFindEngine(root);

      expect(engine.search("hello world")).toBe(1);
      expect(engine.result()).toEqual({ current: 1, total: 1 });
    });

    it("matches case-insensitively", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>Hello World</p>";
      const engine = new DocxFindEngine(root);

      expect(engine.search("HELLO world")).toBe(1);
    });

    it("never matches across a paragraph boundary", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>hello</p><p>world</p>";
      const engine = new DocxFindEngine(root);

      // The flattened text is "hello\nworld" - a phrase spanning the
      // boundary is absent even though the two words look adjacent.
      expect(engine.search("lo wo")).toBe(0);
      expect(engine.search("hello")).toBe(1);
      expect(engine.search("world")).toBe(1);
    });

    it("separates table cells the same way it separates paragraphs", () => {
      const root = document.createElement("div");
      root.innerHTML = "<table><tr><td>alpha</td><td>beta</td></tr></table>";
      const engine = new DocxFindEngine(root);

      expect(engine.search("alphabeta")).toBe(0);
      expect(engine.search("alpha")).toBe(1);
    });

    it("returns 0 and paints nothing for an empty query", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>hello world</p>";
      const engine = new DocxFindEngine(root);

      expect(engine.search("")).toBe(0);
      expect(engine.result()).toBeNull();
      expect(registry.size).toBe(0);
    });

    it("finds every occurrence across the document", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>cat and cat</p><p>cat again</p>";
      const engine = new DocxFindEngine(root);

      expect(engine.search("cat")).toBe(3);
      expect(engine.result()).toEqual({ current: 1, total: 3 });
    });
  });

  describe("painting", () => {
    it("paints only the active highlight when there is a single match", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>hello world</p>";
      const engine = new DocxFindEngine(root);

      engine.search("hello");

      expect(registry.size).toBe(1);
      const [highlight] = [...registry.values()];
      expect(highlight.ranges).toHaveLength(1);
    });

    it("splits matches between the match and active highlights when there are several", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>cat and cat and cat</p>";
      const engine = new DocxFindEngine(root);

      engine.search("cat");

      expect(registry.size).toBe(2);
      const totalRanges = [...registry.values()].reduce(
        (sum, highlight) => sum + highlight.ranges.length,
        0,
      );
      expect(totalRanges).toBe(3);
    });

    it("clears every highlight on dispose", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>hello world</p>";
      const engine = new DocxFindEngine(root);

      engine.search("hello");
      expect(registry.size).toBeGreaterThan(0);

      engine.dispose();
      expect(registry.size).toBe(0);
      expect(engine.result()).toBeNull();
    });
  });

  describe("next / previous", () => {
    it("cycles forward and wraps around", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>cat and cat and cat</p>";
      const engine = new DocxFindEngine(root);
      engine.search("cat");

      expect(engine.result()).toEqual({ current: 1, total: 3 });
      engine.next();
      expect(engine.result()).toEqual({ current: 2, total: 3 });
      engine.next();
      expect(engine.result()).toEqual({ current: 3, total: 3 });
      engine.next();
      expect(engine.result()).toEqual({ current: 1, total: 3 });
    });

    it("cycles backward and wraps around", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>cat and cat and cat</p>";
      const engine = new DocxFindEngine(root);
      engine.search("cat");

      engine.previous();
      expect(engine.result()).toEqual({ current: 3, total: 3 });
    });

    it("is a no-op with no matches", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>hello world</p>";
      const engine = new DocxFindEngine(root);
      engine.search("nothing to find here");

      engine.next();
      engine.previous();
      expect(engine.result()).toBeNull();
    });
  });

  describe("scrollActiveIntoView", () => {
    it("scrolls the active match's element into view, centered", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>alpha bravo charlie</p>";
      const engine = new DocxFindEngine(root);
      engine.search("bravo");

      const scrollSpy = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);

      engine.scrollActiveIntoView();

      expect(scrollSpy).toHaveBeenCalledWith({
        block: "center",
        inline: "nearest",
      });
      scrollSpy.mockRestore();
    });

    it("does nothing with no active match", () => {
      const root = document.createElement("div");
      root.innerHTML = "<p>alpha bravo charlie</p>";
      const engine = new DocxFindEngine(root);
      engine.search("nothing to find");

      const scrollSpy = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);

      engine.scrollActiveIntoView();

      expect(scrollSpy).not.toHaveBeenCalled();
      scrollSpy.mockRestore();
    });
  });
});
