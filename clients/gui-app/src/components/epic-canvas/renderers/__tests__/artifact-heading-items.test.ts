import { afterEach, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import {
  ARTIFACT_HEADING_HIT_STRIP_MAX_WIDTH,
  ARTIFACT_HEADING_LABEL_MAX_CHARS,
  ARTIFACT_HEADING_RAIL_EDGE_INSET,
  ARTIFACT_HEADING_SCROLL_PADDING,
  compactArtifactHeadingLabel,
  deriveArtifactHeadingItems,
  measureArtifactHeadingTops,
  resolveArtifactHeadingActiveIndex,
  resolveArtifactHeadingHitStripWidth,
  sameArtifactHeadingOutline,
  toArtifactHeadingOutline,
  type ArtifactHeadingOutlineEntry,
  type ArtifactHeadingViewLike,
} from "../artifact-heading-items";

const editors: Editor[] = [];

function makeEditor(content: JSONContent): Editor {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("default");
  const awareness = new Awareness(ydoc);
  const user = deriveCollabUser({ userName: "Tester", email: "t@x.io" });
  const editor = new Editor({
    extensions: buildArtifactExtensions({
      doc: ydoc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
  editor.commands.setContent(content);
  editors.push(editor);
  return editor;
}

function heading(level: number, text: string): JSONContent {
  return {
    type: "heading",
    attrs: { level },
    content: text.length > 0 ? [{ type: "text", text }] : [],
  };
}

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("compactArtifactHeadingLabel", () => {
  it("collapses runs of whitespace to a single space and trims the ends", () => {
    expect(compactArtifactHeadingLabel("  Section   A\n\tB  ")).toBe(
      "Section A B",
    );
  });

  it("passes short labels through unchanged", () => {
    expect(compactArtifactHeadingLabel("Roadmap")).toBe("Roadmap");
  });

  it("caps at ARTIFACT_HEADING_LABEL_MAX_CHARS with a trailing ellipsis", () => {
    const long = "A".repeat(ARTIFACT_HEADING_LABEL_MAX_CHARS + 30);
    const result = compactArtifactHeadingLabel(long);
    expect(result).toBe(`${"A".repeat(ARTIFACT_HEADING_LABEL_MAX_CHARS)}…`);
    expect(result.length).toBe(ARTIFACT_HEADING_LABEL_MAX_CHARS + 1);
  });

  it("does not append an ellipsis exactly at the cap", () => {
    const exact = "B".repeat(ARTIFACT_HEADING_LABEL_MAX_CHARS);
    expect(compactArtifactHeadingLabel(exact)).toBe(exact);
  });
});

describe("deriveArtifactHeadingItems", () => {
  it("collects h1/h2 in document order and excludes h3+", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        heading(1, "Title"),
        paragraph("intro"),
        heading(2, "Section A"),
        heading(3, "Sub A"),
        heading(2, "Section B"),
      ],
    });
    const items = deriveArtifactHeadingItems(editor.state.doc);
    expect(items.map((item) => [item.level, item.label])).toEqual([
      [1, "Title"],
      [2, "Section A"],
      [2, "Section B"],
    ]);
  });

  it("skips empty headings, matching the seeded empty leading title line", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        heading(1, ""),
        { type: "paragraph" },
        heading(2, "First real section"),
      ],
    });
    const items = deriveArtifactHeadingItems(editor.state.doc);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("First real section");
  });

  it("disambiguates two identical headings (same level + text) with different keys", () => {
    const editor = makeEditor({
      type: "doc",
      content: [heading(2, "Section A"), heading(2, "Section A")],
    });
    const items = deriveArtifactHeadingItems(editor.state.doc);
    expect(items).toHaveLength(2);
    expect(items[0].key).not.toBe(items[1].key);
    expect(items[0].label).toBe(items[1].label);
    expect(items[0].level).toBe(items[1].level);
  });

  it("collapses whitespace within heading text through the same label compaction", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [
            { type: "text", text: "Foo   " },
            { type: "text", text: "  Bar" },
          ],
        },
      ],
    });
    const items = deriveArtifactHeadingItems(editor.state.doc);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Foo Bar");
  });
});

describe("toArtifactHeadingOutline / sameArtifactHeadingOutline", () => {
  it("projects items down to key/level/label with no document positions", () => {
    const editor = makeEditor({
      type: "doc",
      content: [heading(1, "Title"), heading(2, "Section A")],
    });
    const outline = toArtifactHeadingOutline(
      deriveArtifactHeadingItems(editor.state.doc),
    );
    expect(outline).toEqual([
      { key: "1:Title#0", level: 1, label: "Title" },
      { key: "2:Section A#0", level: 2, label: "Section A" },
    ]);
  });

  it("treats equal outlines as the same", () => {
    const left: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "1:Title#0", level: 1, label: "Title" },
      { key: "2:Section A#0", level: 2, label: "Section A" },
    ];
    const right: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "1:Title#0", level: 1, label: "Title" },
      { key: "2:Section A#0", level: 2, label: "Section A" },
    ];
    expect(sameArtifactHeadingOutline(left, right)).toBe(true);
  });

  it("detects a changed label as a different outline", () => {
    const left: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "1:Title#0", level: 1, label: "Title" },
    ];
    const right: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "1:Titled#0", level: 1, label: "Titled" },
    ];
    expect(sameArtifactHeadingOutline(left, right)).toBe(false);
  });

  it("detects a changed level as a different outline", () => {
    const left: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "1:Title#0", level: 1, label: "Title" },
    ];
    const right: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "2:Title#0", level: 2, label: "Title" },
    ];
    expect(sameArtifactHeadingOutline(left, right)).toBe(false);
  });

  it("detects a changed length as a different outline", () => {
    const left: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "1:Title#0", level: 1, label: "Title" },
    ];
    const right: ReadonlyArray<ArtifactHeadingOutlineEntry> = [
      { key: "1:Title#0", level: 1, label: "Title" },
      { key: "2:Section A#0", level: 2, label: "Section A" },
    ];
    expect(sameArtifactHeadingOutline(left, right)).toBe(false);
  });
});

describe("resolveArtifactHeadingActiveIndex", () => {
  it("returns null for an empty tops array", () => {
    expect(
      resolveArtifactHeadingActiveIndex({
        tops: [],
        scrollTop: 0,
        clientHeight: 500,
        scrollHeight: 500,
      }),
    ).toBeNull();
  });

  it("resolves to the first heading when scrolled above it", () => {
    expect(
      resolveArtifactHeadingActiveIndex({
        tops: [100, 300, 600],
        scrollTop: 0,
        clientHeight: 400,
        scrollHeight: 2000,
      }),
    ).toBe(0);
  });

  it("uses the section at the top of the viewport", () => {
    const tops = [0, 200, 400];
    expect(
      resolveArtifactHeadingActiveIndex({
        tops,
        scrollTop: 100,
        clientHeight: 400,
        scrollHeight: 2000,
      }),
    ).toBe(0);
  });

  it("keeps the earlier section on an exact visibility tie", () => {
    const tops = [0, 200, 400];
    expect(
      resolveArtifactHeadingActiveIndex({
        tops,
        scrollTop: 0,
        clientHeight: 400,
        scrollHeight: 2000,
      }),
    ).toBe(0);
  });

  it("hands over when the next heading reaches the top", () => {
    expect(
      resolveArtifactHeadingActiveIndex({
        tops: [0, 200, 400],
        scrollTop: 1,
        clientHeight: 400,
        scrollHeight: 2000,
      }),
    ).toBe(0);
    expect(
      resolveArtifactHeadingActiveIndex({
        tops: [0, 200, 400],
        scrollTop: 200,
        clientHeight: 400,
        scrollHeight: 2000,
      }),
    ).toBe(1);
  });

  it("keeps a jumped-to heading active at its padded landing offset", () => {
    const tops = [0, 300, 600];
    expect(
      resolveArtifactHeadingActiveIndex({
        tops,
        scrollTop: tops[1] - ARTIFACT_HEADING_SCROLL_PADDING,
        clientHeight: 100,
        scrollHeight: 2000,
      }),
    ).toBe(1);
  });

  it("resolves to the last index at the bottom of the scroller even if its heading never crosses the line", () => {
    const tops = [0, 50];
    expect(
      resolveArtifactHeadingActiveIndex({
        tops,
        scrollTop: 1950,
        clientHeight: 50,
        scrollHeight: 2000,
      }),
    ).toBe(1);
  });
});

describe("resolveArtifactHeadingHitStripWidth", () => {
  it("returns the floored gutter minus the rail edge inset when under the cap", () => {
    const gutter = 20;
    expect(resolveArtifactHeadingHitStripWidth(gutter)).toBe(
      Math.floor(gutter - ARTIFACT_HEADING_RAIL_EDGE_INSET),
    );
  });

  it("caps the width at ARTIFACT_HEADING_HIT_STRIP_MAX_WIDTH for a wide gutter", () => {
    expect(resolveArtifactHeadingHitStripWidth(1000)).toBe(
      ARTIFACT_HEADING_HIT_STRIP_MAX_WIDTH,
    );
  });

  it("returns 0 for a zero gutter", () => {
    expect(resolveArtifactHeadingHitStripWidth(0)).toBe(0);
  });

  it("returns 0 for a negative gutter", () => {
    expect(resolveArtifactHeadingHitStripWidth(-30)).toBe(0);
  });

  it("returns 0 for a non-finite gutter", () => {
    expect(resolveArtifactHeadingHitStripWidth(Number.NaN)).toBe(0);
    expect(resolveArtifactHeadingHitStripWidth(Number.POSITIVE_INFINITY)).toBe(
      0,
    );
  });
});

describe("measureArtifactHeadingTops", () => {
  function rectAt(top: number): DOMRect {
    return {
      x: 0,
      y: top,
      width: 0,
      height: 0,
      top,
      right: 0,
      bottom: top,
      left: 0,
      toJSON: () => ({}),
    };
  }

  function makeScroller(rectTop: number, scrollTop: number): HTMLElement {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => rectAt(rectTop);
    Object.defineProperty(el, "scrollTop", {
      value: scrollTop,
      configurable: true,
    });
    return el;
  }

  it("measures scroller-relative tops (rect.top - scrollerRect.top + scroller.scrollTop)", () => {
    const scroller = makeScroller(50, 20);
    const nodes = new Map<number, HTMLElement>([
      [
        10,
        Object.assign(document.createElement("div"), {
          getBoundingClientRect: () => rectAt(150),
        }),
      ],
      [
        30,
        Object.assign(document.createElement("div"), {
          getBoundingClientRect: () => rectAt(300),
        }),
      ],
    ]);
    const view: ArtifactHeadingViewLike = {
      nodeDOM: (pos) => nodes.get(pos) ?? null,
    };
    const tops = measureArtifactHeadingTops({
      view,
      scroller,
      positions: [10, 30],
    });
    expect(tops).toEqual([120, 270]);
  });

  it("has a scroller with 0 scrollTop measure as a plain rect delta", () => {
    const scroller = makeScroller(10, 0);
    const view: ArtifactHeadingViewLike = {
      nodeDOM: () =>
        Object.assign(document.createElement("div"), {
          getBoundingClientRect: () => rectAt(60),
        }),
    };
    const tops = measureArtifactHeadingTops({
      view,
      scroller,
      positions: [5],
    });
    expect(tops).toEqual([50]);
  });

  it("a position whose nodeDOM returns null inherits the previous top and keeps the array length equal to positions.length", () => {
    const scroller = makeScroller(50, 20);
    const nodes = new Map<number, HTMLElement>([
      [
        10,
        Object.assign(document.createElement("div"), {
          getBoundingClientRect: () => rectAt(150),
        }),
      ],
      [
        30,
        Object.assign(document.createElement("div"), {
          getBoundingClientRect: () => rectAt(300),
        }),
      ],
    ]);
    const view: ArtifactHeadingViewLike = {
      nodeDOM: (pos) => nodes.get(pos) ?? null,
    };
    const tops = measureArtifactHeadingTops({
      view,
      scroller,
      positions: [10, 20, 30],
    });
    expect(tops).toHaveLength(3);
    expect(tops).toEqual([120, 120, 270]);
  });

  it("inherits 0 when the very first position's nodeDOM returns null", () => {
    const scroller = makeScroller(0, 0);
    const view: ArtifactHeadingViewLike = { nodeDOM: () => null };
    const tops = measureArtifactHeadingTops({
      view,
      scroller,
      positions: [1, 2],
    });
    expect(tops).toEqual([0, 0]);
  });
});
