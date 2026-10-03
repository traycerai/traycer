import { act, cleanup, renderHook } from "@testing-library/react";
import { Editor, type JSONContent } from "@tiptap/core";
import type { ReactNode, RefObject } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { ARTIFACT_HEADING_SCROLL_PADDING } from "../artifact-heading-items";
import { useArtifactHeadingMetrics } from "../use-artifact-heading-metrics";

const editors: Editor[] = [];

function rect(input: {
  readonly left: number;
  readonly right: number;
  readonly top?: number;
}): DOMRect {
  const top = input.top ?? 0;
  return {
    x: input.left,
    y: top,
    width: input.right - input.left,
    height: 0,
    top,
    right: input.right,
    bottom: top,
    left: input.left,
    toJSON: () => ({}),
  };
}

function headingDoc(labels: ReadonlyArray<string>): JSONContent {
  return {
    type: "doc",
    content: labels.map((text) => ({
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text }],
    })),
  };
}

function makeEditor(content: JSONContent): Editor {
  const ydoc = new Y.Doc();
  const editor = new Editor({
    extensions: buildArtifactExtensions({
      doc: ydoc,
      fragment: ydoc.getXmlFragment("default"),
      awareness: new Awareness(ydoc),
      user: deriveCollabUser({ userName: "Tester", email: "t@x.io" }),
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
  editor.commands.setContent(content);
  editors.push(editor);
  return editor;
}

function appendHeading(editor: Editor, text: string): void {
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "heading",
    attrs: { level: 1 },
    content: [{ type: "text", text }],
  });
}

function makeScroller(): {
  readonly element: HTMLElement;
  readonly scrollTo: Mock<(options: ScrollToOptions) => void>;
} {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => rect({ left: 0, right: 600 });
  Object.defineProperty(element, "scrollTop", {
    value: 0,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(element, "clientHeight", {
    value: 400,
    configurable: true,
  });
  Object.defineProperty(element, "scrollHeight", {
    value: 900,
    configurable: true,
  });
  const scrollTo = vi.fn<(options: ScrollToOptions) => void>();
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return { element, scrollTo };
}

/** Stubs each mounted h1/h2 300px apart, matching the minimap suite's fixture. */
function stubLayout(editor: Editor): void {
  editor.view.dom.getBoundingClientRect = () => rect({ left: 60, right: 540 });
  Array.from(editor.view.dom.querySelectorAll("h1, h2")).forEach(
    (heading, index) => {
      heading.getBoundingClientRect = () =>
        rect({ left: 60, right: 540, top: index * 300 });
    },
  );
}

/** The global test shim answers every media query with `matches: false`. */
function stubCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function renderMetrics(input: {
  readonly editor: Editor;
  readonly scroller: HTMLElement;
  readonly side: EdgeSide;
  readonly shown: boolean;
  readonly visible?: boolean;
}) {
  // A plain mutable holder, not React state: the wrapper re-reads it on every
  // `rerender()` call, which is how the test flips visibility without a
  // second render pass being driven by React itself.
  const state = { visible: input.visible ?? true };
  const refreshRef: RefObject<() => void> = { current: () => undefined };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TabBodySelectedContext.Provider value={state.visible}>
      {children}
    </TabBodySelectedContext.Provider>
  );
  const hook = renderHook(
    () =>
      useArtifactHeadingMetrics({
        editor: input.editor,
        scroller: input.scroller,
        refreshRef,
        side: input.side,
        shown: input.shown,
      }),
    { wrapper },
  );
  const setVisible = (visible: boolean): void => {
    state.visible = visible;
    hook.rerender();
  };
  return { ...hook, setVisible };
}

afterEach(() => {
  cleanup();
  editors.splice(0).forEach((editor) => editor.destroy());
  vi.useRealTimers();
  stubCoarsePointer(false);
});

describe("useArtifactHeadingMetrics", () => {
  it("debounces a doc update 150ms before re-deriving the outline", () => {
    vi.useFakeTimers();
    const editor = makeEditor(headingDoc(["First"]));
    const scroller = makeScroller();
    stubLayout(editor);
    const { result } = renderMetrics({
      editor,
      scroller: scroller.element,
      side: "left",
      shown: true,
    });

    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
    ]);

    act(() => {
      appendHeading(editor, "Second");
    });
    // Still the pre-edit outline - the walk has not run yet.
    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
    ]);

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
    ]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("skips the doc walk entirely while concealed, then catches up outline and geometry on reveal", () => {
    vi.useFakeTimers();
    const editor = makeEditor(headingDoc(["First"]));
    const scroller = makeScroller();
    stubLayout(editor);
    const { result, setVisible } = renderMetrics({
      editor,
      scroller: scroller.element,
      side: "left",
      shown: true,
      visible: false,
    });

    // No listener attached, so even the initial pass never ran.
    expect(result.current.outline).toEqual([]);

    act(() => {
      appendHeading(editor, "Second");
      vi.advanceTimersByTime(500);
    });

    expect(result.current.outline).toEqual([]);
    expect(result.current.hitStripWidth).toBe(0);
    expect(result.current.activeIndex).toBeNull();

    act(() => {
      setVisible(true);
    });
    // Reveal runs the walk immediately (not debounced) and picks up every
    // edit that happened while concealed.
    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
      "Second",
    ]);

    // Geometry catches up too, once the newly-scheduled frame runs.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.hitStripWidth).toBeGreaterThan(0);
  });

  it("keeps the outline current on a hidden rail for the picker, but never measures geometry", () => {
    vi.useFakeTimers();
    const editor = makeEditor(headingDoc(["First"]));
    const scroller = makeScroller();
    stubLayout(editor);
    const { result } = renderMetrics({
      editor,
      scroller: scroller.element,
      side: "left",
      shown: false,
    });

    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
    ]);
    expect(result.current.hitStripWidth).toBe(0);

    act(() => {
      appendHeading(editor, "Second");
      vi.advanceTimersByTime(150);
    });

    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
      "Second",
    ]);
    expect(result.current.hitStripWidth).toBe(0);
    expect(result.current.activeIndex).toBeNull();
  });

  it("also freezes geometry on a coarse pointer, proven by zero rect reads even after every pending frame runs", () => {
    vi.useFakeTimers();
    stubCoarsePointer(true);
    const editor = makeEditor(headingDoc(["First"]));
    const scroller = makeScroller();
    stubLayout(editor);

    // `measure()` always reads these two together right before publishing
    // geometry - spying on them catches a bypassed guard even if the specific
    // heading rect a bug reads happens to be a freshly-inserted node with no
    // stub of its own.
    const scrollerRectSpy = vi.spyOn(scroller.element, "getBoundingClientRect");
    const editorRectSpy = vi.spyOn(editor.view.dom, "getBoundingClientRect");

    const { result } = renderMetrics({
      editor,
      scroller: scroller.element,
      side: "left",
      shown: true,
    });

    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
    ]);
    expect(result.current.hitStripWidth).toBe(0);

    act(() => {
      appendHeading(editor, "Second");
      // Generous enough to flush the 150ms debounce and any rAF the guard
      // should have prevented from ever being scheduled.
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
      "Second",
    ]);
    expect(result.current.hitStripWidth).toBe(0);
    expect(result.current.activeIndex).toBeNull();
    expect(scrollerRectSpy).not.toHaveBeenCalled();
    expect(editorRectSpy).not.toHaveBeenCalled();
  });

  it("scrollToIndex measures the target heading fresh even when geometry has never run", () => {
    const editor = makeEditor(headingDoc(["First", "Second"]));
    const scroller = makeScroller();
    stubLayout(editor);
    const { result } = renderMetrics({
      editor,
      scroller: scroller.element,
      side: "left",
      shown: false,
    });

    expect(result.current.outline.map((entry) => entry.label)).toEqual([
      "First",
      "Second",
    ]);
    // Geometry never ran on a hidden rail.
    expect(result.current.hitStripWidth).toBe(0);

    act(() => {
      result.current.scrollToIndex(1);
    });

    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTo.mock.calls[0][0].top).toBe(
      300 - ARTIFACT_HEADING_SCROLL_PADDING,
    );
  });
});
