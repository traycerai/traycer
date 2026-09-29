import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SurfacePlacementBar } from "@/components/layout-editor/surface-placement-bar";
import { setMobileApp } from "@/lib/mobile-app";
import {
  useLayoutEditorStore,
  type PlacementSurfaceId,
} from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The floating bar's own writes (D14, ticket 09): the pictogram row (through
 * `writeArrangementField`, the same writer as the dock's rows) and the View
 * pair that joins it while the tab strip is vertical. Both are one recorded
 * gesture, undoable, and both honour the same availability the dock rows do.
 */

function historyDepth(): number {
  return useLayoutEditorStore.getState().history.past.length;
}

function beginSession(): void {
  useLayoutEditorStore.getState().beginSession({
    entry: "keyboard",
    source: "direct_ui",
    startedAt: 0,
    origin: { kind: "tab" },
  });
}

/** Registers a real node for the surface and selects it, through the store's own writers. */
function selectSurfaceWithNode(surface: PlacementSurfaceId): HTMLElement {
  const node = document.createElement("div");
  document.body.append(node);
  act(() => {
    useLayoutEditorStore.getState().registerSurfaceNode(surface, node);
    useLayoutEditorStore.getState().selectSurface(surface);
  });
  return node;
}

function pictogram(label: string): HTMLElement {
  return screen.getByRole("radio", { name: label });
}

/** The bar's own DOM marker: `role="toolbar"` is gone (finding 3), so
 * presence/absence is asserted on this attribute instead. */
function placementBar(): HTMLElement | null {
  return document.querySelector("[data-layout-placement-bar]");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A real arrow-key press, held long enough to select: Radix's radio group
 * moves focus through a `setTimeout` and only auto-selects the newly focused
 * item while `RadioGroupItemTrigger`'s own document-level listener still
 * thinks the arrow key is down (`isArrowKeyPressedRef`). `userEvent.keyboard`
 * fires its keydown/keyup back to back with no real gap between them, which
 * beats that `setTimeout` and leaves the move unselected - reported to the
 * assigning agent. A held `keydown` with a real (non-fake-timer) wait before
 * `keyup` reproduces what a real key-hold does.
 */
async function pressAndHoldArrowKey(
  target: HTMLElement,
  key: "ArrowLeft" | "ArrowRight",
): Promise<void> {
  fireEvent.keyDown(target, { key, code: key });
  await act(async () => {
    await wait(20);
  });
  fireEvent.keyUp(target, { key, code: key });
}

function withVerticalStrip(): void {
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
    arrangement: {
      ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
      tabStripPlacement: "left",
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({ surfaceNodes: new Map() });
});

afterEach(() => {
  cleanup();
  setMobileApp(false);
  useLayoutEditorStore.getState().endSession();
  document.body.replaceChildren();
});

describe("<SurfacePlacementBar />", () => {
  it("draws nothing with no surface selected", () => {
    render(<SurfacePlacementBar />);

    expect(placementBar()).toBeNull();
  });

  // Finding 3: unlike the no-selection case above, the bar now MOUNTS as
  // soon as a surface is selected, even before its node is registered - it
  // only stays hidden (`opacity-0`, no `data-placed`) until `followNode`'s
  // first rAF tick places it. Losing this radiogroup here would drop a
  // keyboard user's focus target the instant the surface node is swapped.
  it("mounts hidden (not placed) while the selected surface has no registered node yet", () => {
    beginSession();
    act(() => {
      useLayoutEditorStore.getState().selectSurface("topBar");
    });

    render(<SurfacePlacementBar />);

    const bar = placementBar();
    expect(bar).not.toBeNull();
    expect(bar?.dataset.placed).toBeUndefined();
    expect(
      screen.getByRole("radiogroup", { name: "Tabs position" }),
    ).toBeTruthy();
  });

  it("draws the tab strip's Top / Left / Right pictograms", () => {
    beginSession();
    selectSurfaceWithNode("topBar");

    render(<SurfacePlacementBar />);

    const options = screen
      .getByRole("radiogroup", { name: "Tabs position" })
      .querySelectorAll("[role='radio']");
    expect(
      Array.from(options).map((option) => option.getAttribute("aria-label")),
    ).toEqual(["Top", "Left", "Right"]);
    expect(pictogram("Top").getAttribute("aria-checked")).toBe("true");
  });

  it("draws the sidebar's Left / Right pictograms", () => {
    beginSession();
    selectSurfaceWithNode("sidebar");

    render(<SurfacePlacementBar />);

    const options = screen
      .getByRole("radiogroup", { name: "Sidebar side" })
      .querySelectorAll("[role='radio']");
    expect(
      Array.from(options).map((option) => option.getAttribute("aria-label")),
    ).toEqual(["Left", "Right"]);
    expect(pictogram("Left").getAttribute("aria-checked")).toBe("true");
  });

  describe.each([
    {
      surface: "topBar" as const,
      label: "Left",
      field: "tabStripPlacement" as const,
      value: "left" as const,
      revert: "top" as const,
    },
    {
      surface: "topBar" as const,
      label: "Right",
      field: "tabStripPlacement" as const,
      value: "right" as const,
      revert: "top" as const,
    },
    {
      surface: "sidebar" as const,
      label: "Right",
      field: "sidebarSide" as const,
      value: "right" as const,
      revert: "left" as const,
    },
  ])(
    "clicking $label on the $surface bar",
    ({ surface, label, field, value, revert }) => {
      it(`writes ${field} as one recorded gesture, and undo restores it`, () => {
        beginSession();
        selectSurfaceWithNode(surface);
        render(<SurfacePlacementBar />);

        fireEvent.click(pictogram(label));

        expect(useLayoutStore.getState().arrangement[field]).toBe(value);
        expect(historyDepth()).toBe(1);

        useLayoutEditorStore.getState().undo();
        expect(useLayoutStore.getState().arrangement[field]).toBe(revert);
      });
    },
  );

  describe.each([
    { surface: "topBar" as const, label: "Top" },
    { surface: "sidebar" as const, label: "Left" },
  ])(
    "clicking the already-checked $label on the $surface bar",
    ({ surface, label }) => {
      it("records nothing", () => {
        beginSession();
        selectSurfaceWithNode(surface);
        render(<SurfacePlacementBar />);

        fireEvent.click(pictogram(label));

        expect(historyDepth()).toBe(0);
      });
    },
  );

  // Finding 3: the pictogram row is a real Radix radio group now, not a
  // set of separate Tab stops with no arrow behavior.
  describe("keyboard navigation on the pictogram row", () => {
    it("is one Tab stop: entering the group focuses the checked pictogram, and the others are not tabbable", async () => {
      beginSession();
      selectSurfaceWithNode("topBar");
      render(<SurfacePlacementBar />);

      // Base's roving tabindex marks only the checked pictogram a tab stop
      // (asserted below); a real Tab press is what lands the browser there,
      // so a real Tab press through user-event is what proves it, rather
      // than firing `focus` at the (non-tabbable) group wrapper.
      await userEvent.tab();

      expect(document.activeElement).toBe(pictogram("Top"));
      expect(pictogram("Top").getAttribute("tabindex")).toBe("0");
      expect(pictogram("Left").getAttribute("tabindex")).toBe("-1");
      expect(pictogram("Right").getAttribute("tabindex")).toBe("-1");
    });

    it("ArrowRight moves focus to the next pictogram and selects it as one gesture", async () => {
      beginSession();
      selectSurfaceWithNode("topBar");
      render(<SurfacePlacementBar />);

      pictogram("Top").focus();
      await pressAndHoldArrowKey(pictogram("Top"), "ArrowRight");

      expect(document.activeElement).toBe(pictogram("Left"));
      expect(pictogram("Left").getAttribute("aria-checked")).toBe("true");
      expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
        "left",
      );
      expect(historyDepth()).toBe(1);
    });

    it("ArrowLeft moves focus to the previous pictogram and selects it as one gesture", async () => {
      useLayoutStore.setState({
        ...DEFAULT_LAYOUT_SNAPSHOT,
        arrangement: {
          ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
          tabStripPlacement: "right",
        },
      });
      beginSession();
      selectSurfaceWithNode("topBar");
      render(<SurfacePlacementBar />);

      pictogram("Right").focus();
      await pressAndHoldArrowKey(pictogram("Right"), "ArrowLeft");

      expect(document.activeElement).toBe(pictogram("Left"));
      expect(pictogram("Left").getAttribute("aria-checked")).toBe("true");
      expect(useLayoutStore.getState().arrangement.tabStripPlacement).toBe(
        "left",
      );
      expect(historyDepth()).toBe(1);
    });
  });

  // Finding 3: the bar used to unmount for the commit where the strip's old
  // node has unregistered and the new one has not registered yet, dropping a
  // keyboard user's focus. It is now held mounted across that gap
  // (`PlacementBarBody` is keyed by `surface`, not by `node`).
  it("stays mounted, keeping focus, while its surface node is briefly unregistered", () => {
    beginSession();
    const node = selectSurfaceWithNode("topBar");
    render(<SurfacePlacementBar />);

    const bar = placementBar();
    pictogram("Top").focus();
    expect(document.activeElement).toBe(pictogram("Top"));

    act(() => {
      useLayoutEditorStore.getState().unregisterSurfaceNode("topBar", node);
    });

    expect(placementBar()).toBe(bar);
    expect(document.activeElement).toBe(pictogram("Top"));

    const nextNode = document.createElement("div");
    document.body.append(nextNode);
    act(() => {
      useLayoutEditorStore.getState().registerSurfaceNode("topBar", nextNode);
    });

    expect(placementBar()).toBe(bar);
  });
});

describe("the tab strip bar's View pair", () => {
  it("is absent while the strip is at the top", () => {
    beginSession();
    selectSurfaceWithNode("topBar");

    render(<SurfacePlacementBar />);

    expect(screen.queryByRole("radiogroup", { name: "Tabs view" })).toBeNull();
  });

  it("is present once the strip is vertical", () => {
    withVerticalStrip();
    beginSession();
    selectSurfaceWithNode("topBar");

    render(<SurfacePlacementBar />);

    const options = screen
      .getByRole("radiogroup", { name: "Tabs view" })
      .querySelectorAll("[role='radio']");
    expect(Array.from(options).map((option) => option.textContent)).toEqual([
      "Tabs only",
      "Tabs and agents",
    ]);
  });

  it("is never drawn on the sidebar's bar, even with a vertical strip", () => {
    withVerticalStrip();
    beginSession();
    selectSurfaceWithNode("sidebar");

    render(<SurfacePlacementBar />);

    expect(screen.queryByRole("radiogroup", { name: "Tabs view" })).toBeNull();
  });

  // The bar withholds itself entirely once its own surface row is
  // unavailable (the installed mobile app, `isSurfacePlacementRowAvailable`)
  // - the same predicate `sideStripView`'s own row reads, mirroring how
  // `surface-placement-rows.test.tsx` controls availability. There is no
  // context in which the surface's own row is available while the View row
  // alone is not: both rows are gated by the identical availability check.
  it("is absent, with the whole bar, when the availability context says unavailable", () => {
    withVerticalStrip();
    setMobileApp(true);
    beginSession();
    selectSurfaceWithNode("topBar");

    render(<SurfacePlacementBar />);

    expect(placementBar()).toBeNull();
  });

  it("writes sideStripView as one recorded gesture, and undo restores it", () => {
    withVerticalStrip();
    beginSession();
    selectSurfaceWithNode("topBar");
    render(<SurfacePlacementBar />);

    fireEvent.click(screen.getByRole("radio", { name: "Tabs and agents" }));

    expect(useLayoutStore.getState().arrangement.sideStripView).toBe(
      "activity",
    );
    expect(historyDepth()).toBe(1);

    useLayoutEditorStore.getState().undo();
    expect(useLayoutStore.getState().arrangement.sideStripView).toBe("layered");
  });
});
