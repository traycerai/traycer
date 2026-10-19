import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import { CanvasLayersTree } from "../canvas-layers-tree";
import { canvasLayerRows, describeCanvasLayer } from "../canvas-layer-model";
import type { CanvasFrameRegistry } from "../canvas-frame-registry";
import { useCanvasSelectionStore } from "../canvas-selection-store";
import {
  ARTIFACT_ID,
  BOARD_PATH,
  boardDocument,
  canvasElement,
  disposeBridges,
  realBridge,
  registryServing,
  textSelection,
} from "./canvas-edit-test-support";

const SHA = "sha-served";

function rowsOf(text: string) {
  return canvasLayerRows(boardDocument(text));
}

describe("canvasLayerRows", () => {
  const PAGE = `<main id="app" class="a b"><h1>Title</h1><p>one <b>two</b></p></main>`;

  it("lists elements in source order with their nesting depth", () => {
    expect(rowsOf(PAGE).map((row) => [row.tagName, row.depth])).toEqual([
      ["main", 0],
      ["h1", 1],
      ["p", 1],
      ["b", 2],
    ]);
  });

  it("labels a row by what the element is, never by its id or classes", () => {
    const labels = rowsOf(PAGE).map((row) => row.label);
    expect(labels).toEqual(["Section", "Heading", "Paragraph", "Text"]);
    expect(labels.join(" ")).not.toMatch(/app|#|\./);
  });

  it("previews all the text inside an element in source order, tidied", () => {
    const rows = rowsOf(`<p>  one \n  <b>two</b>   three </p>`);
    expect(rows[0].preview).toBe("one two three");
    expect(rows[1].preview).toBe("two");
    expect(rowsOf(PAGE)[0].preview).toBe("Titleone two");
  });

  it("reads inline markup as running text, without spaces the page does not have", () => {
    const rows = rowsOf(
      `<p>Read the <a href="#">second <em>board</em></a> soon.</p><p>un<b>believ</b><i>able</i></p>`,
    );
    expect(
      rows.filter((row) => row.tagName === "p").map((row) => row.preview),
    ).toEqual(["Read the second board soon.", "unbelievable"]);
  });

  it("caps a preview at 80 characters, however the text is split up", () => {
    expect(rowsOf(`<p>${"a".repeat(200)}</p>`)[0].preview).toHaveLength(80);
    const split = rowsOf(
      `<div><p>${"a".repeat(60)}</p><p>${"b".repeat(60)}</p></div>`,
    )[0].preview;
    expect(split).toBe(`${"a".repeat(60)}${"b".repeat(20)}`);
  });

  it("names a literal element by the offset of its start tag", () => {
    const text = `<div><p>x</p></div>`;
    const rows = rowsOf(text);
    expect(rows.map((row) => row.marker)).toEqual([
      text.indexOf("<div"),
      text.indexOf("<p"),
    ]);
    expect(rows.every((row) => !row.generated)).toBe(true);
  });

  it("hides the containers the parser implies without nesting everything under them", () => {
    expect(rowsOf(`<p>x</p>`).map((row) => row.tagName)).toEqual(["p"]);
    expect(rowsOf(`<p>x</p>`)[0].depth).toBe(0);
    const table = rowsOf(`<table><tr><td>x</td></tr></table>`);
    expect(table.map((row) => [row.tagName, row.depth])).toEqual([
      ["table", 0],
      ["tr", 1],
      ["td", 2],
    ]);
  });

  it("lists a document's content as the board, without its html and body wrappers", () => {
    const text = `<!doctype html><html><body><main><p>x</p></main></body></html>`;
    const rows = rowsOf(text);
    expect(rows.map((row) => [row.tagName, row.depth, row.marker])).toEqual([
      ["main", 0, text.indexOf("<main")],
      ["p", 1, text.indexOf("<p>")],
    ]);
    expect(rows.every((row) => !row.generated)).toBe(true);
  });

  it("skips a document's metadata and script elements with everything inside them", () => {
    const text = `<!doctype html><html><head><title>T</title><meta charset="utf-8"><link rel="stylesheet" href="a.css"><style>p{color:red}</style><script>1</script></head><body><script>2</script><div><style>b{}</style><span>s</span></div><p>x</p></body></html>`;
    expect(
      rowsOf(text).map((row) => [row.tagName, row.depth, row.marker]),
    ).toEqual([
      ["div", 0, text.indexOf("<div")],
      ["span", 1, text.indexOf("<span")],
      ["p", 0, text.indexOf("<p>")],
    ]);
  });
  it("marks elements the browser created without a source tag as generated", () => {
    const rows = rowsOf(`<b>x<p>y</b>z</p>`);
    const bolds = rows.filter((row) => row.tagName === "b");
    expect(bolds.length).toBeGreaterThanOrEqual(2);
    for (const bold of bolds) {
      expect(bold.generated).toBe(true);
      expect(bold.marker).toBeNull();
    }
    expect(rows.find((row) => row.tagName === "p")?.generated).toBe(false);
  });

  it("gives every row its own key", () => {
    const keys = rowsOf(`<b>x<p>y</b>z</p><p>1</p><p>2</p>`).map(
      (row) => row.key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("describeCanvasLayer", () => {
  afterEach(() => {
    disposeBridges();
    vi.restoreAllMocks();
  });
  const board = { ...boardDocument(`<p>hi</p>`), sha256: SHA };
  const describeAt = (registry: CanvasFrameRegistry, marker: number) =>
    describeCanvasLayer(
      {
        artifactId: ARTIFACT_ID,
        boardPath: BOARD_PATH,
        document: board,
        registry,
      },
      marker,
    );

  it("builds a selection from what the page says about that marker", async () => {
    const bridge = realBridge();
    const spy = vi
      .spyOn(bridge, "describeElement")
      .mockResolvedValue(canvasElement({ marker: 0, tid: null }));
    const selection = await describeAt(registryServing(bridge, SHA), 0);
    expect(spy).toHaveBeenCalledWith({ marker: 0 });
    expect(selection).toMatchObject({
      artifactId: ARTIFACT_ID,
      boardPath: BOARD_PATH,
      page: null,
      servedSha256: SHA,
      element: { marker: 0 },
      textRange: null,
    });
  });

  it("answers null when the board has no bridge", async () => {
    await expect(describeAt(registryServing(null, SHA), 0)).resolves.toBeNull();
  });

  it("answers null without asking when the board shows a different revision", async () => {
    const bridge = realBridge();
    const spy = vi.spyOn(bridge, "describeElement");
    await expect(
      describeAt(registryServing(bridge, "sha-other"), 0),
    ).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing for that marker", null],
    ["a different element", canvasElement({ marker: 5 })],
  ])("answers null when the page returns %s", async (_label, answer) => {
    const bridge = realBridge();
    vi.spyOn(bridge, "describeElement").mockResolvedValue(answer);
    await expect(
      describeAt(registryServing(bridge, SHA), 0),
    ).resolves.toBeNull();
  });

  it("answers null when the frame was replaced while the page was thinking", async () => {
    const bridge = realBridge();
    const registry = registryServing(bridge, SHA);
    vi.spyOn(bridge, "describeElement").mockImplementation(() => {
      registry.update(BOARD_PATH, { bridge: realBridge() });
      return Promise.resolve(canvasElement({ marker: 0 }));
    });
    await expect(describeAt(registry, 0)).resolves.toBeNull();
  });

  it("answers null when the board moved to a new revision while the page was thinking", async () => {
    const bridge = realBridge();
    const registry = registryServing(bridge, SHA);
    vi.spyOn(bridge, "describeElement").mockImplementation(() => {
      registry.update(BOARD_PATH, { sha256: "sha-newer" });
      return Promise.resolve(canvasElement({ marker: 0 }));
    });
    await expect(describeAt(registry, 0)).resolves.toBeNull();
  });
});

describe("CanvasLayersTree", () => {
  const PAGE = `<main id="app" class="a b"><h1>Title</h1><p>one</p></main>`;
  const owner = Symbol("layers-test");
  const markerOf = (needle: string): number => PAGE.indexOf(needle);

  beforeEach(() => {
    // TanStack Virtual reads the scroll element's offset size when it
    // attaches; jsdom's permanent 0 by 0 would describe an invisible list.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
    useCanvasSelectionStore.getState().clear();
  });
  afterEach(() => {
    cleanup();
    disposeBridges();
    vi.restoreAllMocks();
    useCanvasSelectionStore.getState().clear();
  });

  function mount(
    text: string,
    answer: (marker: number) => Promise<CanvasElement | null>,
  ) {
    const bridge = realBridge();
    const describe = vi
      .spyOn(bridge, "describeElement")
      .mockImplementation((locator) =>
        "marker" in locator ? answer(locator.marker) : Promise.resolve(null),
      );
    const registry = registryServing(bridge, SHA);
    const view = render(
      <CanvasLayersTree
        artifactId={ARTIFACT_ID}
        boardPath={BOARD_PATH}
        document={{ ...boardDocument(text), sha256: SHA }}
        registry={registry}
        owner={owner}
      />,
    );
    return { bridge, describe, registry, unmount: view.unmount };
  }
  const answersWith = (marker: number) =>
    Promise.resolve(canvasElement({ marker, tid: null, tagName: "p" }));
  const rowButton = (name: RegExp): HTMLElement =>
    screen.getByRole("button", { name });
  const selectedMarker = (): number | null =>
    useCanvasSelectionStore.getState().selection?.element.marker ?? null;

  it("shows the board's elements as a tree with their depth", () => {
    mount(PAGE, answersWith);
    expect(screen.getByRole("tree", { name: "Artboard layers" })).toBeDefined();
    const levels = screen
      .getAllByRole("treeitem")
      .map((item) => Number(item.getAttribute("aria-level")));
    expect(levels).toEqual([1, 2, 2]);
    expect(rowButton(/^Section Titleone$/)).toBeDefined();
    expect(rowButton(/^Heading Title$/)).toBeDefined();
    expect(screen.queryByText(/app|\.a\.b/)).toBeNull();
  });

  it("indents a row by its depth", () => {
    mount(PAGE, answersWith);
    expect(rowButton(/^Section/).style.paddingLeft).toBe("8px");
    expect(rowButton(/^Heading/).style.paddingLeft).toBe("20px");
  });

  it("selects the element through the page when a row is chosen", async () => {
    const { describe, registry } = mount(PAGE, answersWith);
    await act(async () => {
      fireEvent.click(rowButton(/^Paragraph one$/));
      await Promise.resolve();
    });

    expect(describe).toHaveBeenCalledExactlyOnceWith({
      marker: markerOf("<p>"),
    });
    expect(selectedMarker()).toBe(markerOf("<p>"));
    expect(useCanvasSelectionStore.getState().selection).toMatchObject({
      artifactId: ARTIFACT_ID,
      boardPath: BOARD_PATH,
      servedSha256: SHA,
    });
    expect(registry.boardPath).toBe(BOARD_PATH);
    expect(
      within(
        screen.getByRole("treeitem", { name: /^Paragraph one$/ }),
      ).getByRole("button"),
    ).toBeDefined();
    expect(
      screen
        .getByRole("treeitem", { name: /^Paragraph one$/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("marks only the row of the current selection", async () => {
    mount(PAGE, answersWith);
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      await Promise.resolve();
    });
    const selected = screen
      .getAllByRole("treeitem")
      .filter((item) => item.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Heading");
  });

  it("does not mark a row for a selection in another board or artifact", () => {
    mount(PAGE, answersWith);
    act(() => {
      useCanvasSelectionStore.getState().select({
        ...textSelection(null, { marker: markerOf("<h1") }),
        boardPath: "boards/other.html",
      });
    });
    expect(
      screen
        .getAllByRole("treeitem")
        .some((item) => item.getAttribute("aria-selected") === "true"),
    ).toBe(false);
  });

  it("says so when the element is not on the page right now", async () => {
    mount(PAGE, () => Promise.resolve(null));
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe(
      "This element is not visible in the current artboard.",
    );
    expect(selectedMarker()).toBeNull();
  });

  it("says so when the page cannot be asked", async () => {
    mount(PAGE, () => Promise.reject(new Error("gone")));
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe(
      "This element is unavailable. Try again.",
    );
  });

  it("clears an earlier complaint once a pick succeeds", async () => {
    let answers = false;
    mount(PAGE, (marker) =>
      answers ? answersWith(marker) : Promise.resolve(null),
    );
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toBeDefined();

    answers = true;
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the latest pick when an earlier one answers late", async () => {
    const waiting = new Map<number, (value: CanvasElement | null) => void>();
    mount(
      PAGE,
      (marker) =>
        new Promise<CanvasElement | null>((resolve) => {
          waiting.set(marker, resolve);
        }),
    );
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      fireEvent.click(rowButton(/^Paragraph one$/));
      await Promise.resolve();
    });
    await act(async () => {
      waiting.get(markerOf("<p>"))?.(
        canvasElement({ marker: markerOf("<p>"), tid: null }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      waiting.get(markerOf("<h1"))?.(
        canvasElement({ marker: markerOf("<h1"), tid: null }),
      );
      await Promise.resolve();
    });
    expect(selectedMarker()).toBe(markerOf("<p>"));
  });

  it("drops a pick the owner retired while the page was thinking", async () => {
    let resolve: (value: CanvasElement | null) => void = () => undefined;
    mount(
      PAGE,
      () =>
        new Promise<CanvasElement | null>((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      await Promise.resolve();
    });
    act(() => {
      useCanvasSelectionStore.getState().retire(owner, null);
    });
    await act(async () => {
      resolve(canvasElement({ marker: markerOf("<h1"), tid: null }));
      await Promise.resolve();
    });
    expect(selectedMarker()).toBeNull();
  });

  it("drops a pick whose answer arrives after the list has left the screen", async () => {
    let resolve: (value: CanvasElement | null) => void = () => undefined;
    const { registry, unmount } = mount(
      PAGE,
      () =>
        new Promise<CanvasElement | null>((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      fireEvent.click(rowButton(/^Heading/));
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      resolve(canvasElement({ marker: markerOf("<h1"), tid: null }));
      await Promise.resolve();
    });

    expect(selectedMarker()).toBeNull();
    expect(registry.boardPath).toBeNull();
  });

  it("lists generated elements but will not select them", () => {
    const { describe } = mount(`<b>x<p>y</b>z</p>`, answersWith);
    const generated = screen
      .getAllByRole("button")
      .filter((button) => button.textContent.includes("Generated"));
    expect(generated.length).toBeGreaterThanOrEqual(1);
    for (const button of generated) {
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
    }
    expect(describe).not.toHaveBeenCalled();
  });

  it("explains a generated selection made some other way", () => {
    mount(PAGE, answersWith);
    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(
          textSelection(null, { marker: null, tagName: "b", generated: true }),
        );
    });
    expect(
      screen.getByText(/Generated — ask the agent to change this element/),
    ).toBeDefined();
  });

  it("renders only the rows near the viewport of a long list", () => {
    const items = Array.from(
      { length: 300 },
      (_, index) => `<li>item ${index}</li>`,
    ).join("");
    mount(`<ul>${items}</ul>`, answersWith);
    const rendered = screen.getAllByRole("treeitem").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
    expect(screen.queryByRole("button", { name: /item 299/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^List item 0item 1/ }),
    ).toBeDefined();
  });
});
