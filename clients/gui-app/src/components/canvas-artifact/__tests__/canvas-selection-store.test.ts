import { beforeEach, describe, expect, it } from "vitest";
import type {
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";
import {
  sameCanvasElement,
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";

function element(overrides: Partial<CanvasElement>): CanvasElement {
  return {
    marker: 1,
    tid: null,
    tagName: "div",
    selector: "div.a",
    elementId: null,
    classNames: [],
    textPreview: "",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 0, y: 0, width: 10, height: 10 },
    computedStyles: [],
    generated: false,
    ...overrides,
  };
}

function selectionOf(target: CanvasElement): CanvasSelection {
  return {
    artifactId: "art",
    boardPath: "board.html",
    page: null,
    servedSha256: "sha",
    element: target,
    textRange: null,
  };
}

function textRange(target: CanvasElement, quote: string): CanvasTextSelection {
  return { element: target, start: 0, end: quote.length, quote, rects: [] };
}

function currentSelection(): CanvasSelection | null {
  return useCanvasSelectionStore.getState().selection;
}

beforeEach(() => {
  useCanvasSelectionStore.setState({ selection: null });
});

describe("sameCanvasElement", () => {
  it("compares tids when both have one, ignoring marker and selector", () => {
    expect(
      sameCanvasElement(
        element({ tid: "t1", marker: 1, selector: "a" }),
        element({ tid: "t1", marker: 2, selector: "b" }),
      ),
    ).toBe(true);
    expect(
      sameCanvasElement(
        element({ tid: "t1", marker: 1 }),
        element({ tid: "t2", marker: 1 }),
      ),
    ).toBe(false);
  });

  it("falls back to the marker when a tid is missing", () => {
    expect(
      sameCanvasElement(
        element({ tid: "t1", marker: 3 }),
        element({ tid: null, marker: 3 }),
      ),
    ).toBe(true);
    expect(
      sameCanvasElement(
        element({ tid: null, marker: 3 }),
        element({ tid: null, marker: 4 }),
      ),
    ).toBe(false);
    expect(
      sameCanvasElement(
        element({ tid: null, marker: 3 }),
        element({ tid: null, marker: null }),
      ),
    ).toBe(false);
  });

  it("falls back to the selector when neither has a marker", () => {
    expect(
      sameCanvasElement(
        element({ marker: null, selector: "p" }),
        element({ marker: null, selector: "p" }),
      ),
    ).toBe(true);
    expect(
      sameCanvasElement(
        element({ marker: null, selector: "p" }),
        element({ marker: null, selector: "span" }),
      ),
    ).toBe(false);
  });
});

describe("select and clear", () => {
  it("stores and removes the selection", () => {
    const selection = selectionOf(element({}));
    useCanvasSelectionStore.getState().select(selection);
    expect(currentSelection()).toBe(selection);
    useCanvasSelectionStore.getState().clear();
    expect(currentSelection()).toBeNull();
  });

  it("replaces a prior text range when a new element is selected", () => {
    const first = element({ marker: 1 });
    useCanvasSelectionStore.getState().select(selectionOf(first));
    useCanvasSelectionStore
      .getState()
      .setTextRange("art", "board.html", textRange(first, "hello"));
    expect(currentSelection()?.textRange?.quote).toBe("hello");

    useCanvasSelectionStore
      .getState()
      .select(selectionOf(element({ marker: 2, selector: "div.b" })));
    expect(currentSelection()?.textRange).toBeNull();
  });
});

describe("updateElement", () => {
  it("applies when artifact, board, marker and element all match", () => {
    useCanvasSelectionStore
      .getState()
      .select(selectionOf(element({ marker: 1 })));
    const fresh = element({ marker: 1, textPreview: "fresh" });
    useCanvasSelectionStore
      .getState()
      .updateElement("art", "board.html", 1, fresh);
    expect(currentSelection()?.element).toBe(fresh);
  });

  it("ignores another artifact or board", () => {
    const original = element({ marker: 1 });
    useCanvasSelectionStore.getState().select(selectionOf(original));
    const fresh = element({ marker: 1, textPreview: "fresh" });
    useCanvasSelectionStore
      .getState()
      .updateElement("other", "board.html", 1, fresh);
    useCanvasSelectionStore
      .getState()
      .updateElement("art", "other.html", 1, fresh);
    expect(currentSelection()?.element).toBe(original);
  });

  it("ignores a different marker", () => {
    const original = element({ marker: 1 });
    useCanvasSelectionStore.getState().select(selectionOf(original));
    useCanvasSelectionStore
      .getState()
      .updateElement(
        "art",
        "board.html",
        2,
        element({ marker: 1, textPreview: "fresh" }),
      );
    expect(currentSelection()?.element).toBe(original);
  });

  it("ignores a stale update for an element that is no longer selected", () => {
    const selected = element({ marker: 1, tid: "new" });
    useCanvasSelectionStore.getState().select(selectionOf(selected));
    useCanvasSelectionStore
      .getState()
      .updateElement(
        "art",
        "board.html",
        1,
        element({ marker: 1, tid: "old" }),
      );
    expect(currentSelection()?.element).toBe(selected);
  });

  it("does nothing without a selection", () => {
    useCanvasSelectionStore
      .getState()
      .updateElement("art", "board.html", 1, element({}));
    expect(currentSelection()).toBeNull();
  });
});

describe("updateTid", () => {
  it("assigns the tid for a matching artifact, board and marker", () => {
    useCanvasSelectionStore
      .getState()
      .select(selectionOf(element({ marker: 1 })));
    useCanvasSelectionStore.getState().updateTid("art", "board.html", 1, "t9");
    expect(currentSelection()?.element.tid).toBe("t9");
  });

  it("ignores another artifact, board or marker", () => {
    useCanvasSelectionStore
      .getState()
      .select(selectionOf(element({ marker: 1 })));
    useCanvasSelectionStore
      .getState()
      .updateTid("other", "board.html", 1, "t9");
    useCanvasSelectionStore.getState().updateTid("art", "other.html", 1, "t9");
    useCanvasSelectionStore.getState().updateTid("art", "board.html", 2, "t9");
    expect(currentSelection()?.element.tid).toBeNull();
  });

  it("ignores a null marker even when the selected element has none", () => {
    useCanvasSelectionStore
      .getState()
      .select(selectionOf(element({ marker: null, generated: true })));
    useCanvasSelectionStore
      .getState()
      .updateTid("art", "board.html", null, "t9");
    expect(currentSelection()?.element.tid).toBeNull();
  });

  it("does nothing without a selection", () => {
    useCanvasSelectionStore.getState().updateTid("art", "board.html", 1, "t9");
    expect(currentSelection()).toBeNull();
  });
});

describe("setTextRange", () => {
  it("applies when the range belongs to the selected element", () => {
    const target = element({ marker: 1, tid: "t1" });
    useCanvasSelectionStore.getState().select(selectionOf(target));
    const range = textRange(target, "quote");
    useCanvasSelectionStore.getState().setTextRange("art", "board.html", range);
    expect(currentSelection()?.textRange).toBe(range);
  });

  it("matches by marker when the tid is missing", () => {
    useCanvasSelectionStore
      .getState()
      .select(selectionOf(element({ marker: 5 })));
    const range = textRange(element({ marker: 5, tid: "t1" }), "quote");
    useCanvasSelectionStore.getState().setTextRange("art", "board.html", range);
    expect(currentSelection()?.textRange).toBe(range);
  });

  it("matches by selector for generated elements", () => {
    useCanvasSelectionStore
      .getState()
      .select(
        selectionOf(
          element({ marker: null, generated: true, selector: "p.x" }),
        ),
      );
    const range = textRange(
      element({ marker: null, generated: true, selector: "p.x" }),
      "quote",
    );
    useCanvasSelectionStore.getState().setTextRange("art", "board.html", range);
    expect(currentSelection()?.textRange).toBe(range);
  });

  it("ignores another artifact or board", () => {
    const target = element({ marker: 1 });
    useCanvasSelectionStore.getState().select(selectionOf(target));
    useCanvasSelectionStore
      .getState()
      .setTextRange("other", "board.html", textRange(target, "quote"));
    useCanvasSelectionStore
      .getState()
      .setTextRange("art", "other.html", textRange(target, "quote"));
    expect(currentSelection()?.textRange).toBeNull();
  });

  it("ignores a range from a different element", () => {
    useCanvasSelectionStore
      .getState()
      .select(selectionOf(element({ marker: 1 })));
    useCanvasSelectionStore
      .getState()
      .setTextRange(
        "art",
        "board.html",
        textRange(element({ marker: 2 }), "quote"),
      );
    expect(currentSelection()?.textRange).toBeNull();
  });

  it("clears the text range when the quote is empty", () => {
    const target = element({ marker: 1 });
    useCanvasSelectionStore.getState().select(selectionOf(target));
    useCanvasSelectionStore
      .getState()
      .setTextRange("art", "board.html", textRange(target, "quote"));
    useCanvasSelectionStore
      .getState()
      .setTextRange("art", "board.html", textRange(target, ""));
    expect(currentSelection()?.textRange).toBeNull();
  });
});
