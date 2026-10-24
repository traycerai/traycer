import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  CanvasEditingPanel,
  CanvasElementEditingPanel,
} from "../canvas-editing-panel";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import {
  ARTIFACT_ID,
  BOARD_PATH,
  canvasElement,
  disposeBridges,
  pendingSaves,
  realBridge,
  registryServing,
  textSelection,
} from "./canvas-edit-test-support";
import {
  elementFor,
  FRAME_ACTUAL,
  layoutOf,
  placedAt,
  selectionFor,
  selectOnly,
  settleLayout,
  startedSaves,
  structureDocument,
  structureHarness,
} from "./canvas-structure-test-support";

const PAGE = vi.hoisted(
  () =>
    `<style>:root{--gap:12px}</style><section><p style="color: red">Hello</p></section>`,
);
const NO_TWEAKS = vi.hoisted(
  () => `<section><p style="color: red">Hello</p></section>`,
);
// Which board text the panel is handed; a test switches it for one case.
const served = vi.hoisted(() => ({ text: "" }));

// The document read is a query over the host's files; the panel is what is
// under test, so it is handed an already-read board.
vi.mock("../use-canvas-board-document", async () => {
  type CanvasBoardDocument =
    import("../canvas-board-document").CanvasBoardDocument;
  const { boardDocument } = await import("./canvas-edit-test-support");
  const read = new Map<string, CanvasBoardDocument>();
  return {
    useCanvasBoardDocument: () => {
      const cached = read.get(served.text) ?? boardDocument(served.text);
      read.set(served.text, cached);
      return { data: cached, error: null };
    },
  };
});

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);

vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => null,
}));

function selectionInBoard(boardPath: string): CanvasSelection {
  return {
    ...textSelection(null, {
      marker: PAGE.indexOf("<p"),
      inlineStyle: "color: red",
    }),
    boardPath,
  };
}

function mountPanel() {
  return render(
    <CanvasEditingPanel
      artifactId={ARTIFACT_ID}
      boardPath={BOARD_PATH}
      registry={registryServing(realBridge(), "sha-served")}
      owner={Symbol("editing-panel-test")}
    >
      <p>Selected element properties</p>
    </CanvasEditingPanel>,
  );
}

function openTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

describe("CanvasEditingPanel", () => {
  beforeEach(() => {
    // TanStack Virtual reads the scroll element's offset size when it
    // attaches; jsdom's permanent 0 by 0 would describe an invisible list.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
    pendingSaves.length = 0;
    served.text = PAGE;
    useCanvasSelectionStore.getState().clear();
  });
  afterEach(() => {
    cleanup();
    disposeBridges();
    vi.restoreAllMocks();
    useCanvasSelectionStore.getState().clear();
  });

  it("offers Design, Code and Tweaks in one strip, opening on Design", () => {
    mountPanel();

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Design",
      "Code",
      "Tweaks",
    ]);
    expect(
      screen.getByRole("tab", { name: "Design" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("puts the layers and the selected element's properties together on Design", () => {
    mountPanel();

    expect(screen.getByRole("tree", { name: "Artboard layers" })).toBeDefined();
    expect(screen.getByText("Selected element properties")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Tweaks" })).toBeNull();
    expect(screen.queryByLabelText("Element styles")).toBeNull();
  });

  it("keeps the page's tweaks on their own tab", () => {
    mountPanel();
    openTab("Tweaks");

    expect(screen.getByRole("region", { name: "Tweaks" })).toBeDefined();
    expect(screen.getByLabelText("--gap")).toBeDefined();
    expect(screen.queryByRole("tree", { name: "Artboard layers" })).toBeNull();
    expect(screen.queryByText("Selected element properties")).toBeNull();
  });

  it("says so on Tweaks when the artboard has none", () => {
    served.text = NO_TWEAKS;
    mountPanel();
    openTab("Tweaks");

    expect(screen.getByText("No tweaks in this artboard.")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Tweaks" })).toBeNull();
  });

  it("asks for a selection on Code until an element of this board is selected", () => {
    mountPanel();
    openTab("Code");
    expect(
      screen.getByText("Select an element to edit its CSS."),
    ).toBeDefined();
    expect(screen.queryByLabelText("Element styles")).toBeNull();

    act(() => {
      useCanvasSelectionStore
        .getState()
        .select(selectionInBoard("boards/other.html"));
    });
    expect(
      screen.getByText("Select an element to edit its CSS."),
    ).toBeDefined();
    expect(screen.queryByLabelText("Element styles")).toBeNull();
  });

  it("edits the selected element's CSS on Code, saving it as the style attribute", () => {
    act(() => {
      useCanvasSelectionStore.getState().select(selectionInBoard(BOARD_PATH));
    });
    mountPanel();
    openTab("Code");

    expect(screen.queryByText("Select an element to edit its CSS.")).toBeNull();
    const css = screen.getByLabelText("Element styles");
    expect(css).toHaveProperty("value", "color: red");
    expect(screen.queryByLabelText("Width")).toBeNull();

    fireEvent.change(css, { target: { value: "color: blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply styles" }));

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toEqual({
      kind: "set-attribute",
      name: "style",
      value: "color: blue",
    });
  });

  it("asks for a single element on Code while several are selected", () => {
    act(() => {
      useCanvasSelectionStore.getState().select(selectionInBoard(BOARD_PATH));
      useCanvasSelectionStore.setState({
        additionalElements: [canvasElement({ marker: 0 })],
      });
    });
    mountPanel();
    openTab("Code");

    expect(
      screen.getByText("Select one element to edit its CSS."),
    ).toBeDefined();
    expect(screen.queryByLabelText("Element styles")).toBeNull();
  });
});

describe("CanvasElementEditingPanel structure controls", () => {
  const WRAPPERS = `<div data-tid="stage"><div data-tid="wrap"><p>Hi</p></div><ul data-tid="list"><li>x</li></ul></div>`;

  async function mountSelected(tid: string) {
    served.text = WRAPPERS;
    const document = structureDocument(WRAPPERS);
    const harness = structureHarness(
      layoutOf(document, "stage", {
        wrap: placedAt(0, 0, 50, 20),
        list: placedAt(0, 30, 50, 20),
      }),
      FRAME_ACTUAL,
    );
    const selection = selectionFor(elementFor(document, tid));
    selectOnly(selection);
    render(
      <TooltipProvider>
        <CanvasElementEditingPanel
          selection={selection}
          registry={harness.registry}
        />
      </TooltipProvider>,
    );
    await settleLayout();
  }

  beforeEach(() => {
    pendingSaves.length = 0;
    useCanvasSelectionStore.getState().clear();
  });
  afterEach(() => {
    cleanup();
    disposeBridges();
    vi.restoreAllMocks();
    useCanvasSelectionStore.getState().clear();
  });

  it("lets a selected wrapper be ungrouped, with the properties still beside it and no arrangement controls", async () => {
    await mountSelected("wrap");

    expect(
      screen.getByRole("region", { name: "Element properties" }),
    ).toBeDefined();
    expect(screen.queryByText(/Arrange/)).toBeNull();
    for (const name of ["Align left", "Group", "Wrap"])
      expect(screen.queryByRole("button", { name })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));
    await startedSaves(1);

    expect(pendingSaves[0].variables.edit).toEqual({ kind: "unwrap-element" });
    expect(pendingSaves[0].variables.selection.element.tid).toBe("wrap");
  });

  it("offers no Ungroup for an element that cannot be ungrouped", async () => {
    await mountSelected("list");

    expect(
      screen.getByRole("region", { name: "Element properties" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Ungroup" })).toBeNull();
  });
});
