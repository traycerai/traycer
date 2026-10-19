import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasSiblingLayout } from "@/lib/sandbox/canvas-layout-bridge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CanvasStructureToolbar } from "../canvas-structure-toolbar";
import { useCanvasSelectionStore } from "../canvas-selection-store";
import {
  ARTIFACT_ID,
  BOARD_PATH,
  disposeBridges,
  pendingSaves,
  SAVED,
  settleSave,
} from "./canvas-edit-test-support";
import {
  elementFor,
  FRAME_ACTUAL,
  layoutOf,
  placedAt,
  selectionFor,
  selectSet,
  settleLayout,
  structureDocument,
  structureHarness,
  type StructureHarness,
} from "./canvas-structure-test-support";

vi.mock("../use-artboard-edit", async () =>
  (await import("./canvas-edit-test-support")).artboardEditModule(),
);

const CHANGED = "The page changed this layout. Select the elements again.";
const DOCUMENT = structureDocument(
  `<div data-tid="stage"><div data-tid="a"></div><div data-tid="b"></div><div data-tid="c"></div></div>`,
);

/** Three absolutely positioned boxes, which is what alignment needs. */
function stageLayout(overrides: {
  readonly bLeft: number;
}): CanvasSiblingLayout {
  return layoutOf(DOCUMENT, "stage", {
    a: placedAt(10, 10, 50, 20),
    b: placedAt(overrides.bLeft, 60, 70, 20),
    c: placedAt(200, 110, 30, 20),
  });
}

/** `a` and `b` picked together, with the toolbar over the board. */
async function mountToolbar(): Promise<StructureHarness> {
  const layout = stageLayout({ bLeft: 40 });
  const harness = structureHarness(layout, FRAME_ACTUAL);
  const primary = selectionFor(elementFor(DOCUMENT, "a"));
  selectSet(primary, [selectionFor(elementFor(DOCUMENT, "b"))], layout);
  render(
    <TooltipProvider>
      <CanvasStructureToolbar
        selection={primary}
        registry={harness.registry}
        document={DOCUMENT}
      />
    </TooltipProvider>,
  );
  await settleLayout();
  return harness;
}

function alignLeft(): HTMLElement {
  return screen.getByRole("button", { name: "Align left" });
}

/** Clicks Align left while the page is slow to answer, then lets it answer. */
async function clickWhileHeld(
  harness: StructureHarness,
  whileWaiting: () => void,
): Promise<void> {
  const answer = harness.hold();
  fireEvent.click(alignLeft());
  whileWaiting();
  await act(async () => {
    answer();
    await Promise.resolve();
  });
  await settleLayout();
}

beforeEach(() => {
  pendingSaves.length = 0;
  useCanvasSelectionStore.setState({
    selection: null,
    additionalElements: [],
    selectionMessage: null,
    selectionOwner: null,
    generation: 0,
    pendingPick: null,
  });
});

afterEach(() => {
  cleanup();
  disposeBridges();
  vi.restoreAllMocks();
});

describe("CanvasStructureToolbar applying an arrangement", () => {
  it("reads the layout again before it saves, and saves the aligned set", async () => {
    const harness = await mountToolbar();
    const askedBefore = harness.asked().length;

    fireEvent.click(alignLeft());
    await settleLayout();

    expect(harness.asked().length).toBeGreaterThan(askedBefore);
    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toMatchObject({
      kind: "align-elements",
      mode: "left",
    });
    expect(pendingSaves[0].variables.structureGeneration).toBe(
      useCanvasSelectionStore.getState().generation,
    );
  });

  it("saves nothing when the page rearranged the boxes since they were shown", async () => {
    const harness = await mountToolbar();
    await clickWhileHeld(harness, () => {
      harness.report(stageLayout({ bLeft: 90 }));
    });
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByText(CHANGED).textContent).toBe(CHANGED);
  });

  it("saves nothing when the page stopped answering for the element", async () => {
    const harness = await mountToolbar();
    await clickWhileHeld(harness, () => {
      harness.report(null);
    });
    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByText(CHANGED).textContent).toBe(CHANGED);
  });

  it("saves nothing when another element was picked in the meantime", async () => {
    const harness = await mountToolbar();
    await clickWhileHeld(harness, () => {
      act(() => {
        useCanvasSelectionStore
          .getState()
          .select(selectionFor(elementFor(DOCUMENT, "c")));
      });
    });
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing when the selection was cleared in the meantime", async () => {
    const harness = await mountToolbar();
    await clickWhileHeld(harness, () => {
      act(() => {
        useCanvasSelectionStore.getState().clear();
      });
    });
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing when the board was rewritten in the meantime", async () => {
    const harness = await mountToolbar();
    await clickWhileHeld(harness, () => {
      act(() => {
        harness.registry.update(BOARD_PATH, { sha256: "sha-rewritten" });
      });
    });
    expect(pendingSaves).toHaveLength(0);
  });

  it("saves nothing when a newer pick began, even if it finds the same set", async () => {
    const harness = await mountToolbar();
    await clickWhileHeld(harness, () => {
      act(() => {
        useCanvasSelectionStore
          .getState()
          .beginPick(Symbol("another pick"), ARTIFACT_ID, BOARD_PATH);
      });
    });
    expect(pendingSaves).toHaveLength(0);
  });

  it("sends one save for two quick clicks", async () => {
    const harness = await mountToolbar();
    const answer = harness.hold();
    fireEvent.click(alignLeft());
    fireEvent.click(alignLeft());
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await settleLayout();
    expect(pendingSaves).toHaveLength(1);
  });

  it("can arrange again after a save is answered", async () => {
    await mountToolbar();
    fireEvent.click(alignLeft());
    await settleLayout();
    await settleSave(0, SAVED);
    await settleLayout();

    fireEvent.click(alignLeft());
    await settleLayout();
    expect(pendingSaves).toHaveLength(2);
  });
});

describe("CanvasStructureToolbar for one element", () => {
  // `wrap` is a plain wrapper; a list and an image cannot be ungrouped.
  const WRAPPER_DOCUMENT = structureDocument(
    `<div data-tid="stage"><div data-tid="wrap"><p>Hi</p></div><ul data-tid="list"><li>x</li></ul><img data-tid="pic" alt=""></div>`,
  );
  const wrapperLayout = () =>
    layoutOf(WRAPPER_DOCUMENT, "stage", {
      wrap: placedAt(0, 0, 50, 20),
      list: placedAt(0, 30, 50, 20),
      pic: placedAt(0, 60, 50, 20),
    });

  async function mountSingle(
    tid: string,
    document: typeof DOCUMENT | null,
  ): Promise<StructureHarness> {
    const harness = structureHarness(wrapperLayout(), FRAME_ACTUAL);
    const primary = selectionFor(elementFor(WRAPPER_DOCUMENT, tid));
    act(() => {
      useCanvasSelectionStore.getState().select(primary);
    });
    render(
      <TooltipProvider>
        <CanvasStructureToolbar
          selection={primary}
          registry={harness.registry}
          document={document}
        />
      </TooltipProvider>,
    );
    await settleLayout();
    return harness;
  }
  const ungroup = (): HTMLElement =>
    screen.getByRole("button", { name: "Ungroup" });

  it("offers only Ungroup for a wrapper, and saves it against that wrapper", async () => {
    await mountSingle("wrap", WRAPPER_DOCUMENT);

    for (const name of [
      "Align left",
      "Distribute horizontally",
      "Group",
      "Wrap",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByText(/Arrange/)).toBeNull();
    fireEvent.click(ungroup());
    await settleLayout();

    expect(pendingSaves).toHaveLength(1);
    expect(pendingSaves[0].variables.edit).toEqual({ kind: "unwrap-element" });
    expect(pendingSaves[0].variables.selection.element.tid).toBe("wrap");
  });

  it.each(["list", "pic"])(
    "shows no controls for %s, which cannot be ungrouped",
    async (tid) => {
      await mountSingle(tid, WRAPPER_DOCUMENT);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    },
  );

  it("shows no controls until the board's source has been read", async () => {
    await mountSingle("wrap", null);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps the explanation when the page changed the layout under an Ungroup", async () => {
    const harness = await mountSingle("wrap", WRAPPER_DOCUMENT);
    const answer = harness.hold();
    fireEvent.click(ungroup());
    harness.report(null);
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await settleLayout();

    expect(pendingSaves).toHaveLength(0);
    expect(screen.getByText(CHANGED)).toBeDefined();
  });
});

describe("CanvasStructureToolbar for several elements", () => {
  it("shows the arrangement controls, and no Ungroup", async () => {
    await mountToolbar();
    expect(alignLeft()).toBeDefined();
    expect(screen.getByText(/Arrange/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Ungroup" })).toBeNull();
  });
});
