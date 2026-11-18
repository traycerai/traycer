import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryMountedChatBlock,
  queryMountedChatFindUnit,
  queryMountedChatMessageRoot,
} from "@/components/chat/chat-find";
import { ChatFindHighlighter } from "../chat-find-highlighter";
import {
  FIND_BLOCK_ATTR,
  FIND_HIT_ATTR,
  FIND_MIRROR_ATTR,
  FIND_VISIBLE_ATTR,
} from "@/lib/find-engine/find-blocks";

const SVG_NS = "http://www.w3.org/2000/svg";

// Local copy of the CSS.highlights / Highlight stub from
// `lib/find-engine/__tests__/range-highlighter.test.ts` - kept in this file
// per its own describe block so this suite's DOM/registry setup stays self
// contained.
class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: readonly Range[]) {
    this.ranges = ranges;
  }
}

describe("queryMountedChatFindUnit", () => {
  it("resolves a unit id containing selector-significant characters", () => {
    const messageRoot = document.createElement("div");
    // Persisted segment/message ids flow into unit ids unescaped, so an id can
    // carry quotes, brackets, and backslashes that would break or mis-target a
    // raw `[data-chat-find-unit="..."]` attribute selector.
    const trickyUnitId = "segment:weird\"]\\:id [data-x='y']";
    const decoy = document.createElement("div");
    decoy.dataset.chatFindUnit = "segment:other";
    decoy.textContent = "decoy";
    const target = document.createElement("div");
    target.dataset.chatFindUnit = trickyUnitId;
    target.textContent = "target";
    messageRoot.append(decoy);
    messageRoot.append(target);

    expect(queryMountedChatFindUnit(messageRoot, trickyUnitId)).toBe(target);
    expect(queryMountedChatFindUnit(messageRoot, "segment:other")).toBe(decoy);
    expect(queryMountedChatFindUnit(messageRoot, "segment:missing")).toBeNull();
  });
});

describe("queryMountedChatMessageRoot", () => {
  it("resolves a message id containing selector-significant characters", () => {
    const scroller = document.createElement("div");
    const trickyId = 'assistant:weird"]\\:id';
    const decoy = document.createElement("div");
    decoy.dataset.messageId = "assistant:other";
    const target = document.createElement("div");
    target.dataset.messageId = trickyId;
    scroller.append(decoy);
    scroller.append(target);

    expect(queryMountedChatMessageRoot(scroller, trickyId)).toBe(target);
    expect(queryMountedChatMessageRoot(scroller, "assistant:other")).toBe(
      decoy,
    );
    expect(queryMountedChatMessageRoot(scroller, "missing")).toBeNull();
  });
});

describe("queryMountedChatBlock", () => {
  it("resolves a block id containing selector-significant characters", () => {
    const messageRoot = document.createElement("div");
    const trickyId = 'tool:weird"]\\:id';
    const decoy = document.createElement("div");
    decoy.dataset.blockId = "tool:other";
    const target = document.createElement("div");
    target.dataset.blockId = trickyId;
    messageRoot.append(decoy);
    messageRoot.append(target);

    expect(queryMountedChatBlock(messageRoot, trickyId)).toBe(target);
    expect(queryMountedChatBlock(messageRoot, "tool:other")).toBe(decoy);
    expect(queryMountedChatBlock(messageRoot, "missing")).toBeNull();
  });
});

describe("ChatFindHighlighter", () => {
  const registry = new Map<string, FakeHighlight>();

  beforeEach(() => {
    registry.clear();
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, highlight: FakeHighlight): void => {
          registry.set(name, highlight);
        },
        delete: (name: string): void => {
          registry.delete(name);
        },
      },
    });
    vi.stubGlobal("Highlight", FakeHighlight);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function activeRanges(): readonly Range[] {
    const entry = [...registry.entries()].find(([name]) =>
      name.startsWith("traycer-find-active-"),
    );
    return entry?.[1].ranges ?? [];
  }

  function matchRanges(): readonly Range[] {
    const entry = [...registry.entries()].find(([name]) =>
      name.startsWith("traycer-find-match-"),
    );
    return entry?.[1].ranges ?? [];
  }

  /** A block whose mirror carries `mirrorText` and no visible region. */
  function mermaidMirrorBlock(mirrorText: string): HTMLDivElement {
    const block = document.createElement("div");
    block.setAttribute(FIND_BLOCK_ATTR, "mermaid");
    const mirror = document.createElement("span");
    mirror.setAttribute(FIND_MIRROR_ATTR, "");
    mirror.textContent = mirrorText;
    block.append(mirror);
    return block;
  }

  /**
   * A leading paragraph plus a mermaid block whose mirror holds
   * "graph TD\n  A[Save] --> B[Done]" and whose visible figure draws "Save"
   * (inside a foreignObject, the way a mermaid node label renders) and
   * "Done" (a plain svg `<text>`, the way an edge label renders).
   */
  function buildIntroAndMermaidWithVisibleSave(): {
    readonly root: HTMLDivElement;
    readonly block: HTMLDivElement;
    readonly foSpan: HTMLSpanElement;
  } {
    const root = document.createElement("div");
    document.body.append(root);
    const intro = document.createElement("p");
    intro.textContent = "intro";
    root.append(intro);

    const block = mermaidMirrorBlock("graph TD\n  A[Save] --> B[Done]");
    const figure = document.createElement("figure");
    figure.setAttribute(FIND_VISIBLE_ATTR, "");
    const svg = document.createElementNS(SVG_NS, "svg");
    const g = document.createElementNS(SVG_NS, "g");
    const foreignObject = document.createElementNS(SVG_NS, "foreignObject");
    const foDiv = document.createElement("div");
    const foSpan = document.createElement("span");
    foSpan.textContent = "Save";
    foDiv.append(foSpan);
    foreignObject.append(foDiv);
    const svgText = document.createElementNS(SVG_NS, "text");
    svgText.textContent = "Done";
    g.append(foreignObject, svgText);
    svg.append(g);
    figure.append(svg);
    block.append(figure);
    root.append(block);

    return { root, block, foSpan };
  }

  /**
   * A mermaid block whose mirror holds a single "Carol" hit
   * ("sequenceDiagram\n  participant Carol") but whose visible figure draws
   * "Carol" twice, in two plain svg `<text>` nodes - the way a sequence
   * diagram repeats a participant's name at the top and bottom of its
   * lifeline.
   */
  function buildSequenceDiagramWithDuplicateVisibleCarol(): {
    readonly root: HTMLDivElement;
    readonly block: HTMLDivElement;
    readonly firstCarol: SVGTextElement;
    readonly secondCarol: SVGTextElement;
  } {
    const root = document.createElement("div");
    document.body.append(root);
    const block = mermaidMirrorBlock("sequenceDiagram\n  participant Carol");
    const figure = document.createElement("figure");
    figure.setAttribute(FIND_VISIBLE_ATTR, "");
    const svg = document.createElementNS(SVG_NS, "svg");
    const firstCarol = document.createElementNS(SVG_NS, "text");
    firstCarol.textContent = "Carol";
    const secondCarol = document.createElementNS(SVG_NS, "text");
    secondCarol.textContent = "Carol";
    svg.append(firstCarol, secondCarol);
    figure.append(svg);
    block.append(figure);
    root.append(block);

    return { root, block, firstCarol, secondCarol };
  }

  /** A wireframe's raw source includes two Save hits plus a prose hit. */
  function buildWireframeAndParagraph(): {
    readonly root: HTMLDivElement;
    readonly wireBlock: HTMLDivElement;
    readonly paragraph: HTMLParagraphElement;
  } {
    const root = document.createElement("div");
    document.body.append(root);
    const wireBlock = document.createElement("div");
    wireBlock.setAttribute(FIND_BLOCK_ATTR, "wireframe");
    const mirror = document.createElement("span");
    mirror.setAttribute(FIND_MIRROR_ATTR, "");
    mirror.textContent =
      '<button class="primary">Save</button><script>track("Save")</script>';
    wireBlock.append(mirror);
    const iframe = document.createElement("iframe");
    wireBlock.append(iframe);
    root.append(wireBlock);
    const paragraph = document.createElement("p");
    paragraph.textContent = "Save";
    root.append(paragraph);
    return { root, wireBlock, paragraph };
  }

  it("paints an ordinary-text match and active range with no block marks", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const first = document.createElement("p");
    first.textContent = "save";
    const second = document.createElement("p");
    second.textContent = "save";
    root.append(first, second);
    const highlighter = new ChatFindHighlighter();

    const result = highlighter.paint({
      root,
      query: "save",
      matchCase: false,
      activeMatchIndex: 1,
      scrollActiveIntoView: false,
    });

    expect(result).toBe(true);
    expect(activeRanges()).toHaveLength(1);
    expect(matchRanges()).toHaveLength(1);
    expect(root.querySelectorAll(`[${FIND_HIT_ATTR}]`)).toHaveLength(0);
    highlighter.dispose();
  });

  it("marks a source hit's block active and paints drawn labels as non-active ranges", () => {
    const { root, block, foSpan } = buildIntroAndMermaidWithVisibleSave();
    const highlighter = new ChatFindHighlighter();

    const result = highlighter.paint({
      root,
      query: "save",
      matchCase: false,
      activeMatchIndex: 0,
      scrollActiveIntoView: false,
    });

    expect(result).toBe(true);
    expect(activeRanges()).toHaveLength(0);
    expect(matchRanges()).toHaveLength(1);
    expect(matchRanges()[0].startContainer).toBe(foSpan.firstChild);
    expect(block.getAttribute(FIND_HIT_ATTR)).toBe("active");
    highlighter.dispose();
  });

  it("marks the block active and scrolls it into view when the active hit is source syntax", () => {
    const { root, block } = buildIntroAndMermaidWithVisibleSave();
    const scroll = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const highlighter = new ChatFindHighlighter();

    const result = highlighter.paint({
      root,
      query: "graph",
      matchCase: false,
      activeMatchIndex: 0,
      scrollActiveIntoView: true,
    });

    expect(result).toBe(true);
    expect(activeRanges()).toHaveLength(0);
    expect(matchRanges()).toHaveLength(0);
    expect(block.getAttribute(FIND_HIT_ATTR)).toBe("active");
    // The whole block is the mark, so it is centred rather than merely
    // brought to the nearest edge.
    expect(scroll).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
    expect(scroll.mock.contexts[0]).toBe(block);
    highlighter.dispose();
  });

  it("marks only the active of two match blocks as active, the other as match", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const first = mermaidMirrorBlock("graph TD\n  A --> B");
    const second = mermaidMirrorBlock("graph LR\n  C --> D");
    root.append(first, second);
    const highlighter = new ChatFindHighlighter();

    const result = highlighter.paint({
      root,
      query: "graph",
      matchCase: false,
      activeMatchIndex: 1,
      scrollActiveIntoView: false,
    });

    expect(result).toBe(true);
    expect(second.getAttribute(FIND_HIT_ATTR)).toBe("active");
    expect(first.getAttribute(FIND_HIT_ATTR)).toBe("match");
    highlighter.dispose();
  });

  it("marks a wireframe block active for its own hit, and match when a sibling hit is active", () => {
    const first = buildWireframeAndParagraph();
    const highlighterA = new ChatFindHighlighter();
    const resultA = highlighterA.paint({
      root: first.root,
      query: "save",
      matchCase: false,
      activeMatchIndex: 0,
      scrollActiveIntoView: false,
    });
    expect(resultA).toBe(true);
    expect(first.wireBlock.getAttribute(FIND_HIT_ATTR)).toBe("active");
    highlighterA.dispose();

    const second = buildWireframeAndParagraph();
    const highlighterB = new ChatFindHighlighter();
    const resultB = highlighterB.paint({
      root: second.root,
      query: "save",
      matchCase: false,
      activeMatchIndex: 2,
      scrollActiveIntoView: false,
    });
    expect(resultB).toBe(true);
    expect(second.wireBlock.getAttribute(FIND_HIT_ATTR)).toBe("match");
    const active = activeRanges();
    expect(active).toHaveLength(1);
    expect(active[0].startContainer).toBe(second.paragraph.firstChild);
    highlighterB.dispose();
  });

  it("clear() removes the marks it set, and a second paint moves the active block", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const first = mermaidMirrorBlock("graph TD\n  A --> B");
    const second = mermaidMirrorBlock("graph LR\n  C --> D");
    root.append(first, second);
    const highlighter = new ChatFindHighlighter();

    highlighter.paint({
      root,
      query: "graph",
      matchCase: false,
      activeMatchIndex: 0,
      scrollActiveIntoView: false,
    });
    expect(first.getAttribute(FIND_HIT_ATTR)).toBe("active");
    expect(second.getAttribute(FIND_HIT_ATTR)).toBe("match");

    highlighter.clear();

    expect(first.hasAttribute(FIND_HIT_ATTR)).toBe(false);
    expect(second.hasAttribute(FIND_HIT_ATTR)).toBe(false);

    highlighter.paint({
      root,
      query: "graph",
      matchCase: false,
      activeMatchIndex: 1,
      scrollActiveIntoView: false,
    });

    expect(first.getAttribute(FIND_HIT_ATTR)).toBe("match");
    expect(second.getAttribute(FIND_HIT_ATTR)).toBe("active");
    highlighter.dispose();
  });

  it("returns false and marks nothing when the active index is beyond the aligned ranges", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const paragraph = document.createElement("p");
    paragraph.textContent = "save";
    root.append(paragraph);
    const highlighter = new ChatFindHighlighter();

    const result = highlighter.paint({
      root,
      query: "save",
      matchCase: false,
      activeMatchIndex: 5,
      scrollActiveIntoView: false,
    });

    expect(result).toBe(false);
    expect(root.querySelectorAll(`[${FIND_HIT_ATTR}]`)).toHaveLength(0);
    highlighter.dispose();
  });

  it("tints every repeated diagram label even when the source has one hit", () => {
    const { root, block, firstCarol, secondCarol } =
      buildSequenceDiagramWithDuplicateVisibleCarol();
    const highlighter = new ChatFindHighlighter();

    const result = highlighter.paint({
      root,
      query: "carol",
      matchCase: false,
      activeMatchIndex: 0,
      scrollActiveIntoView: false,
    });

    expect(result).toBe(true);
    expect(activeRanges()).toHaveLength(0);
    expect(matchRanges()).toHaveLength(2);
    expect(matchRanges().map((range) => range.startContainer)).toEqual([
      firstCarol.firstChild,
      secondCarol.firstChild,
    ]);
    expect(block.getAttribute(FIND_HIT_ATTR)).toBe("active");
    highlighter.dispose();
  });

  it("restarts a 280ms pulse on same-block navigation without pulsing on passive paint", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const block = mermaidMirrorBlock("graph graph");
    root.append(block);
    const scroll = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const animate = vi
      .fn()
      .mockReturnValueOnce({ cancel: firstCancel })
      .mockReturnValueOnce({ cancel: secondCancel });
    Object.defineProperty(block, "animate", {
      configurable: true,
      value: animate,
    });
    const highlighter = new ChatFindHighlighter();

    const paint = (activeMatchIndex: number, scrollActiveIntoView: boolean) =>
      highlighter.paint({
        root,
        query: "graph",
        matchCase: false,
        activeMatchIndex,
        scrollActiveIntoView,
      });

    expect(paint(0, true)).toBe(true);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 280 });
    expect(scroll).toHaveBeenLastCalledWith({
      block: "center",
      inline: "nearest",
    });

    expect(paint(0, false)).toBe(true);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(firstCancel).not.toHaveBeenCalled();

    expect(paint(1, true)).toBe(true);
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(scroll).toHaveBeenLastCalledWith({
      block: "nearest",
      inline: "nearest",
    });

    highlighter.clear();
    expect(secondCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a pulse on block exit and dispose", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const first = mermaidMirrorBlock("graph");
    const second = mermaidMirrorBlock("graph");
    root.append(first, second);
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const firstAnimate = vi.fn().mockReturnValue({ cancel: firstCancel });
    const secondAnimate = vi.fn().mockReturnValue({ cancel: secondCancel });
    Object.defineProperty(first, "animate", {
      configurable: true,
      value: firstAnimate,
    });
    Object.defineProperty(second, "animate", {
      configurable: true,
      value: secondAnimate,
    });
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(
      () => undefined,
    );
    const highlighter = new ChatFindHighlighter();

    highlighter.paint({
      root,
      query: "graph",
      matchCase: false,
      activeMatchIndex: 0,
      scrollActiveIntoView: true,
    });
    highlighter.paint({
      root,
      query: "graph",
      matchCase: false,
      activeMatchIndex: 1,
      scrollActiveIntoView: true,
    });
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(secondAnimate).toHaveBeenCalledTimes(1);

    highlighter.dispose();
    expect(secondCancel).toHaveBeenCalledTimes(1);
  });

  it("skips pulses for reduced motion or a block without animate", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const root = document.createElement("div");
    document.body.append(root);
    const block = mermaidMirrorBlock("graph");
    root.append(block);
    const animate = vi.fn();
    Object.defineProperty(block, "animate", {
      configurable: true,
      value: animate,
    });
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(
      () => undefined,
    );
    const highlighter = new ChatFindHighlighter();

    expect(
      highlighter.paint({
        root,
        query: "graph",
        matchCase: false,
        activeMatchIndex: 0,
        scrollActiveIntoView: true,
      }),
    ).toBe(true);
    expect(animate).not.toHaveBeenCalled();
    highlighter.dispose();

    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    Reflect.deleteProperty(block, "animate");
    const noAnimate = new ChatFindHighlighter();
    expect(
      noAnimate.paint({
        root,
        query: "graph",
        matchCase: false,
        activeMatchIndex: 0,
        scrollActiveIntoView: true,
      }),
    ).toBe(true);
    noAnimate.dispose();
  });
});
