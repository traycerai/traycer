import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { StrictMode, useRef, useState, type RefObject } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import { ArtifactHeadingMinimap } from "../artifact-heading-minimap";
import { ARTIFACT_HEADING_SCROLL_PADDING } from "../artifact-heading-items";

const editors: Editor[] = [];

function heading(level: number, text: string): JSONContent {
  return {
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  };
}

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

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

function rectAt(input: { top: number; left: number }): DOMRect {
  return {
    x: input.left,
    y: input.top,
    width: 0,
    height: 0,
    top: input.top,
    right: input.left,
    bottom: input.top,
    left: input.left,
    toJSON: () => ({}),
  };
}

interface ScrollerStub {
  readonly element: HTMLElement;
  /** Captured separately so assertions never read `element.scrollTo` as an
   *  unbound method reference. */
  readonly scrollTo: Mock;
}

function makeScroller(input: {
  top: number;
  left: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): ScrollerStub {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => rectAt({ top: input.top, left: input.left });
  Object.defineProperty(el, "scrollTop", {
    value: input.scrollTop,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: input.clientHeight,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: input.scrollHeight,
    configurable: true,
  });
  const scrollTo = vi.fn();
  el.scrollTo = scrollTo;
  return { element: el, scrollTo };
}

/** Order matches document order, which matches `deriveArtifactHeadingItems`. */
function stubHeadingTops(editor: Editor, tops: ReadonlyArray<number>): void {
  const headingEls = Array.from(editor.view.dom.querySelectorAll("h1, h2"));
  headingEls.forEach((el, index) => {
    el.getBoundingClientRect = () => rectAt({ top: tops[index], left: 0 });
  });
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function makeRefreshRef(): RefObject<() => void> {
  return { current: () => undefined };
}

afterEach(() => {
  cleanup();
  editors.splice(0).forEach((editor) => editor.destroy());
});

const THREE_HEADING_CONTENT: JSONContent = {
  type: "doc",
  content: [
    heading(1, "Title"),
    paragraph("intro"),
    heading(2, "Section A"),
    paragraph("body a"),
    heading(2, "Section B"),
  ],
};

function findRegion(): HTMLElement {
  return screen.getByRole("group", { name: "Document outline controls" });
}

/**
 * Three headings (h1, h2, h2) laid out at scroller-relative tops 0/300/600,
 * with a wide-enough gutter (contentLeft 60, scrollerLeft 0) that the hit
 * strip is not inert. Scrolled to the very top, so section 0 is active.
 */
async function mountThreeHeadingRail(): Promise<{
  editor: Editor;
  scroller: ScrollerStub;
}> {
  const editor = makeEditor(THREE_HEADING_CONTENT);
  editor.view.dom.getBoundingClientRect = () => rectAt({ top: 0, left: 60 });
  const scroller = makeScroller({
    top: 0,
    left: 0,
    scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 700,
  });
  stubHeadingTops(editor, [0, 300, 600]);
  render(
    <ArtifactHeadingMinimap
      editor={editor}
      scroller={scroller.element}
      refreshRef={makeRefreshRef()}
    />,
  );
  await flushFrame();
  return { editor, scroller };
}

describe("ArtifactHeadingMinimap", () => {
  it("renders nothing with fewer than ARTIFACT_HEADING_MIN_ITEMS headings", () => {
    const editor = makeEditor({
      type: "doc",
      content: [heading(1, "Only heading"), paragraph("body")],
    });
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        scroller={null}
        refreshRef={makeRefreshRef()}
      />,
    );
    expect(screen.queryByTestId("artifact-heading-minimap")).toBeNull();
  });

  it("renders one tick per heading with data-level reflecting h1 vs h2", async () => {
    await mountThreeHeadingRail();
    const ticks = screen.getAllByTestId("artifact-heading-minimap-tick");
    expect(ticks).toHaveLength(3);
    expect(ticks.map((tick) => tick.getAttribute("data-level"))).toEqual([
      "1",
      "2",
      "2",
    ]);
  });

  it("keeps the card absent until hover, then shows one row per heading with the deeper indent on level-2 rows", async () => {
    await mountThreeHeadingRail();
    expect(screen.queryByTestId("artifact-heading-minimap-card")).toBeNull();

    fireEvent.mouseEnter(findRegion());

    const card = await screen.findByTestId("artifact-heading-minimap-card");
    const rows = within(card).getAllByTestId("artifact-heading-minimap-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute("data-level"))).toEqual([
      "1",
      "2",
      "2",
    ]);
    expect(rows[0].className).toContain("pl-3");
    expect(rows[1].className).toContain("pl-7");
    expect(rows[2].className).toContain("pl-7");
  });

  it("closes the card on mouseleave", async () => {
    await mountThreeHeadingRail();
    const region = findRegion();
    fireEvent.mouseEnter(region);
    await screen.findByTestId("artifact-heading-minimap-card");

    fireEvent.mouseLeave(region);

    expect(screen.queryByTestId("artifact-heading-minimap-card")).toBeNull();
  });

  it("calls scrollTo on the scroller with the row's measured top minus the scroll padding when a row is clicked", async () => {
    const { scroller } = await mountThreeHeadingRail();
    fireEvent.mouseEnter(findRegion());
    const card = await screen.findByTestId("artifact-heading-minimap-card");
    const rows = within(card).getAllByTestId("artifact-heading-minimap-row");

    fireEvent.click(rows[1]);

    expect(scroller.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 300 - ARTIFACT_HEADING_SCROLL_PADDING }),
    );
  });

  it("marks the active section's tick and row (scrolled to the top, section 0 is active)", async () => {
    await mountThreeHeadingRail();
    const ticks = screen.getAllByTestId("artifact-heading-minimap-tick");
    expect(ticks[0].getAttribute("data-active")).toBe("true");
    expect(ticks[1].getAttribute("data-active")).toBe("false");
    expect(ticks[2].getAttribute("data-active")).toBe("false");

    fireEvent.mouseEnter(findRegion());
    const card = await screen.findByTestId("artifact-heading-minimap-card");
    const rows = within(card).getAllByTestId("artifact-heading-minimap-row");
    expect(rows[0].getAttribute("data-active")).toBe("true");
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[1].getAttribute("data-active")).toBe("false");
    expect(rows[1].getAttribute("aria-current")).toBeNull();
  });

  it("updates the active tick after the tile's own scroll handler invokes refreshRef (no internal scroll listener)", async () => {
    const editor = makeEditor(THREE_HEADING_CONTENT);
    editor.view.dom.getBoundingClientRect = () => rectAt({ top: 0, left: 60 });
    const scroller = makeScroller({
      top: 0,
      left: 0,
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 700,
    });
    stubHeadingTops(editor, [0, 300, 600]);
    const refreshRef = makeRefreshRef();
    render(
      <ArtifactHeadingMinimap
        editor={editor}
        scroller={scroller.element}
        refreshRef={refreshRef}
      />,
    );
    await flushFrame();
    expect(
      screen
        .getAllByTestId("artifact-heading-minimap-tick")[1]
        .getAttribute("data-active"),
    ).toBe("false");

    // activationLine = scrollTop(205) + 96 = 301, which now sits past heading
    // 1's top (300), so the rail hands the active section over to it.
    Object.defineProperty(scroller.element, "scrollTop", {
      value: 205,
      configurable: true,
    });
    act(() => {
      refreshRef.current();
    });

    const ticks = screen.getAllByTestId("artifact-heading-minimap-tick");
    expect(ticks[0].getAttribute("data-active")).toBe("false");
    expect(ticks[1].getAttribute("data-active")).toBe("true");
  });

  it("closes the card on Escape", async () => {
    await mountThreeHeadingRail();
    const region = findRegion();
    fireEvent.mouseEnter(region);
    await screen.findByTestId("artifact-heading-minimap-card");

    fireEvent.keyDown(region, { key: "Escape" });

    expect(screen.queryByTestId("artifact-heading-minimap-card")).toBeNull();
  });

  it("keeps the card open when focus moves from the rail into a row inside it", async () => {
    await mountThreeHeadingRail();
    const hitStrip = screen.getByTestId("artifact-heading-minimap-hit-strip");
    fireEvent.focus(hitStrip);
    const card = await screen.findByTestId("artifact-heading-minimap-card");
    const row = within(card).getAllByTestId("artifact-heading-minimap-row")[0];

    fireEvent.focusOut(hitStrip, { relatedTarget: row });

    expect(screen.queryByTestId("artifact-heading-minimap-card")).toBe(card);
  });

  it("closes the card when focus leaves the region entirely", async () => {
    await mountThreeHeadingRail();
    const hitStrip = screen.getByTestId("artifact-heading-minimap-hit-strip");
    fireEvent.focus(hitStrip);
    await screen.findByTestId("artifact-heading-minimap-card");

    const outsideEl = document.createElement("button");
    fireEvent.focusOut(hitStrip, { relatedTarget: outsideEl });

    expect(screen.queryByTestId("artifact-heading-minimap-card")).toBeNull();
  });

  /**
   * The tile hands the scroller down through `useState`, set from a ref
   * callback, so the rail's first render always sees `scroller === null` and
   * the element arrives on the next render - before the first animation frame
   * has run. Every other test here passes the scroller at first render, which
   * is a sequence the real tile can never produce, and that gap shipped a rail
   * whose ticks painted but whose pointer target stayed 0px wide and `inert`.
   *
   * The re-render deliberately happens with no frame flushed in between.
   */
  it("measures its hit target when the scroller arrives on the render after mount", async () => {
    const editor = makeEditor(THREE_HEADING_CONTENT);
    editor.view.dom.getBoundingClientRect = () => rectAt({ top: 0, left: 60 });
    const scroller = makeScroller({
      top: 0,
      left: 0,
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 700,
    });
    stubHeadingTops(editor, [0, 300, 600]);
    const refreshRef = makeRefreshRef();

    const { rerender } = render(
      <ArtifactHeadingMinimap
        editor={editor}
        scroller={null}
        refreshRef={refreshRef}
      />,
    );
    rerender(
      <ArtifactHeadingMinimap
        editor={editor}
        scroller={scroller.element}
        refreshRef={refreshRef}
      />,
    );
    await flushFrame();

    const hitStrip = screen.getByTestId("artifact-heading-minimap-hit-strip");
    expect(hitStrip.style.width).not.toBe("0px");
    expect(hitStrip.hasAttribute("inert")).toBe(false);

    fireEvent.mouseEnter(findRegion());
    expect(screen.getByTestId("artifact-heading-minimap-card")).toBeTruthy();
  });

  it("replaces the rail with the index rather than showing both at once", async () => {
    await mountThreeHeadingRail();
    const hitStrip = screen.getByTestId("artifact-heading-minimap-hit-strip");
    expect(hitStrip.getAttribute("data-rail-hidden")).toBe("false");

    fireEvent.mouseEnter(findRegion());

    expect(screen.getByTestId("artifact-heading-minimap-card")).toBeTruthy();
    expect(hitStrip.getAttribute("data-rail-hidden")).toBe("true");
    for (const tick of screen.getAllByTestId("artifact-heading-minimap-tick")) {
      expect(tick.className).toContain("opacity-0");
    }

    fireEvent.mouseLeave(findRegion());

    expect(screen.queryByTestId("artifact-heading-minimap-card")).toBeNull();
    expect(hitStrip.getAttribute("data-rail-hidden")).toBe("false");
  });

  /**
   * A canvas pane can shrink to `MIN_PANE_PX` (240px) and clips its overflow,
   * so the card has to be sized from the pane. Sizing it from the viewport -
   * which is what it did when review caught this - leaves a 20rem card hanging
   * off the edge of a narrow split with its labels cut off. jsdom does not lay
   * out container queries, so this asserts the sizing SOURCE rather than a
   * measured width.
   */
  it("sizes the outline card from the pane, not the viewport", async () => {
    await mountThreeHeadingRail();
    fireEvent.mouseEnter(findRegion());
    const card = await screen.findByTestId("artifact-heading-minimap-card");

    expect(card.className).toContain("100cqw");
    expect(card.className).not.toContain("100vw");
    expect(screen.getByTestId("artifact-heading-minimap").className).toContain(
      "[container-type:size]",
    );
  });

  it("opens the outline when the rail is activated by keyboard", async () => {
    const { scroller } = await mountThreeHeadingRail();
    const hitStrip = screen.getByTestId("artifact-heading-minimap-hit-strip");

    fireEvent.click(hitStrip);

    expect(screen.getByTestId("artifact-heading-minimap-card")).toBeTruthy();
    // Activating the rail reveals the index; it never navigates on its own.
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  /**
   * The desktop shell renders the whole app inside `<StrictMode>`
   * (`clients/desktop/src/renderer-shell/main.tsx`), which replays mount
   * effects. A cleanup that cancelled the pending measurement frame without
   * clearing the id left the replayed mount looking at a frame that could
   * never fire, so the rAF-coalescing guard rejected every later measurement
   * and the rail stayed 0px wide and `inert` - the shipped bug. Nothing else
   * in this suite runs under StrictMode, so this is the only test that can see
   * it.
   */
  it("still measures when StrictMode replays the mount effects", async () => {
    const editor = makeEditor(THREE_HEADING_CONTENT);
    editor.view.dom.getBoundingClientRect = () => rectAt({ top: 0, left: 60 });
    const scroller = makeScroller({
      top: 0,
      left: 0,
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 700,
    });
    stubHeadingTops(editor, [0, 300, 600]);

    // Mirrors the tile: the scroller reaches the rail through state written by
    // a callback ref, so the first render always sees `null`.
    function TileHarness() {
      const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
      const refreshRef = useRef<() => void>(() => undefined);
      return (
        <div
          ref={(element) => {
            setScrollerEl(element === null ? null : scroller.element);
          }}
        >
          <ArtifactHeadingMinimap
            editor={editor}
            refreshRef={refreshRef}
            scroller={scrollerEl}
          />
        </div>
      );
    }

    render(
      <StrictMode>
        <TileHarness />
      </StrictMode>,
    );
    await flushFrame();
    await flushFrame();

    const hitStrip = screen.getByTestId("artifact-heading-minimap-hit-strip");
    expect(hitStrip.style.width).not.toBe("0px");
    expect(hitStrip.hasAttribute("inert")).toBe(false);

    fireEvent.mouseEnter(findRegion());
    expect(screen.getByTestId("artifact-heading-minimap-card")).toBeTruthy();
  });
});
