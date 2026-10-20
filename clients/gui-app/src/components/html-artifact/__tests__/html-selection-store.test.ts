import { beforeEach, describe, expect, it } from "vitest";
import type {
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";
import { useHtmlSelectionStore } from "../html-selection-store";

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

function textRange(target: CanvasElement, quote: string): CanvasTextSelection {
  return { element: target, start: 0, end: quote.length, quote, rects: [] };
}

function selectionOf(artifactId: string) {
  return (
    useHtmlSelectionStore.getState().byArtifact.get(artifactId)?.selection ??
    null
  );
}

function pick(artifactId: string, target: CanvasElement | null): void {
  const store = useHtmlSelectionStore.getState();
  store.setEnabled(artifactId, true);
  const ticket = store.beginPick(artifactId);
  if (ticket === null) throw new Error("the layer is on, so a pick must begin");
  store.completePick(artifactId, ticket, target, "sha");
}

beforeEach(() => {
  useHtmlSelectionStore.setState({ byArtifact: new Map() });
});

describe("html selection store", () => {
  it("never shares state between two artifacts", () => {
    pick("first", element({ tid: "a" }));
    useHtmlSelectionStore.getState().setEnabled("second", true);

    expect(selectionOf("first")?.kind).toBe("element");
    expect(selectionOf("second")).toBeNull();

    useHtmlSelectionStore.getState().setEnabled("second", false);
    expect(selectionOf("first")?.kind).toBe("element");
    expect(
      useHtmlSelectionStore.getState().byArtifact.get("first")?.enabled,
    ).toBe(true);
  });

  it.each([
    [
      "the layer was turned off",
      (artifactId: string) =>
        useHtmlSelectionStore.getState().setEnabled(artifactId, false),
    ],
    [
      "the selection was cleared and the generation moved",
      (artifactId: string) =>
        useHtmlSelectionStore.getState().clearSelection(artifactId),
    ],
  ])("ignores a pick that completes after %s", (_cause, interrupt) => {
    const store = useHtmlSelectionStore.getState();
    store.setEnabled("art", true);
    const ticket = store.beginPick("art");
    if (ticket === null)
      throw new Error("the layer is on, so a pick must begin");

    interrupt("art");
    store.completePick("art", ticket, element({ tid: "late" }), "sha");

    expect(selectionOf("art")).toBeNull();
    expect(
      useHtmlSelectionStore.getState().byArtifact.get("art")?.pending,
    ).toBe(false);
  });

  it("accepts a text range only while an element is selected and only for that element", () => {
    const store = useHtmlSelectionStore.getState();
    const picked = element({ tid: "p1" });
    const other = element({ tid: "p2", marker: 2 });

    store.setEnabled("art", true);
    store.setTextRange("art", textRange(picked, "hello"));
    expect(selectionOf("art")).toBeNull();

    pick("art", null);
    store.setTextRange("art", textRange(picked, "hello"));
    expect(selectionOf("art")).toEqual({ kind: "page" });

    pick("art", picked);
    store.setTextRange("art", textRange(other, "hello"));
    expect(selectionOf("art")?.kind).toBe("element");

    store.setTextRange("art", textRange(picked, "hello"));
    expect(selectionOf("art")).toMatchObject({
      kind: "text",
      range: { quote: "hello" },
    });

    store.setTextRange("art", null);
    expect(selectionOf("art")?.kind).toBe("element");
  });

  it.each([
    ["body", element({ tagName: "BODY" })],
    ["html", element({ tagName: "html" })],
    ["nothing", null],
  ])("selects the whole page when the hit test finds %s", (_label, hit) => {
    pick("art", hit);

    expect(selectionOf("art")).toEqual({ kind: "page" });
  });

  it("clears the selection when the frame reports no box for it", () => {
    pick("art", element({ tid: "a" }));
    const generation = useHtmlSelectionStore
      .getState()
      .byArtifact.get("art")?.generation;
    if (generation === undefined) throw new Error("the pick created an entry");

    useHtmlSelectionStore.getState().updateBox("art", generation, null);

    expect(selectionOf("art")).toBeNull();
  });

  it("keeps a generated element selectable", () => {
    const generated = element({ tid: "g1", generated: true });

    pick("art", generated);

    expect(selectionOf("art")).toMatchObject({
      kind: "element",
      element: { tid: "g1", generated: true },
    });
  });
});
