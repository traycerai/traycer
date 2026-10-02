import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  layoutAreaChanged,
  layoutAreaSummary,
  SURFACE_AREAS,
} from "@/components/layout-editor/inspector/layout-areas";
import {
  LayoutAllSettings,
  LayoutAreaLevel,
} from "@/components/layout-editor/inspector/layout-form";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The two-level editor model itself (L-06/08/09): `LayoutAllSettings` is the
 * five surface areas, in `SURFACE_GROUPS`' own order, and opening one draws
 * `LayoutAreaLevel` over the shared `SurfaceSection` tree with the back row on
 * top (`inspector-keyboard-model.test.tsx` covers the keyboard path over the
 * same harness; this file covers what the levels themselves draw and the
 * per-area summary/changed words they read out).
 */

function Harness(): ReactNode {
  const area = useLayoutEditorStore((state) => state.area);
  return area === null ? (
    <LayoutAllSettings />
  ) : (
    <LayoutAreaLevel key={area} area={area} />
  );
}

function row(id: string): HTMLElement {
  const node = document.querySelector(
    `[data-sortable-id="${id}"], [data-region-section="${id}"]`,
  );
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
}

/** A reading's section is always open; every other row says so on its grab. */
function rowExpanded(id: string): boolean {
  const node = row(id);
  return (
    node.hasAttribute("data-region-section") ||
    node.querySelector("[data-row-grab]")?.getAttribute("aria-expanded") ===
      "true"
  );
}

function rowButton(id: string): HTMLElement {
  const node = row(id).querySelector("[data-row-grab]");
  if (!(node instanceof HTMLElement))
    throw new Error(`no button in row: ${id}`);
  return node;
}

function filterInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Find a setting" });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("LayoutAllSettings (L-06)", () => {
  it("lists the five surface areas, in reading order, and nothing else", () => {
    render(<Harness />);

    const rows = screen.getAllByRole("button", {
      name: new RegExp(SURFACE_AREAS.map((area) => area.label).join("|")),
    });
    expect(rows.map((row) => row.getAttribute("data-layout-area"))).toEqual(
      SURFACE_AREAS.map((area) => area.id),
    );
  });
});

describe("selecting a row from the canvas opens its area with the row expanded (L-89)", () => {
  it("opens Composer with the selected row expanded and highlighted", () => {
    // "todo" (the coordinator's own example) has no detail rows of its own
    // (only a position-order row, DETAIL_ROW_KINDS's business, not a
    // disclosure's), so it never draws a chevron - `model` is the Composer
    // region that actually has one (a `style` row), which is what "expanded"
    // needs to mean something.
    render(<Harness />);

    act(() => {
      useLayoutEditorStore.getState().select("model");
    });

    expect(useLayoutEditorStore.getState().area).toBe("composer");
    const row = document.querySelector('[data-sortable-id="model"]');
    if (!(row instanceof HTMLElement)) throw new Error("no model row");
    expect(row.getAttribute("data-sortable-selected")).toBe("1");
    expect(
      row.querySelector("[data-row-grab]")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("a region row's own disclosure click selects it too (item toggleRow)", () => {
  it("selects on open, and clears on a second click", () => {
    render(<Harness />);
    act(() => {
      useLayoutEditorStore.getState().openArea("composer", null);
    });

    fireEvent.click(rowButton("model"));

    expect(useLayoutEditorStore.getState().selected).toBe("model");
    expect(rowExpanded("model")).toBe(true);

    fireEvent.click(rowButton("model"));

    expect(useLayoutEditorStore.getState().selected).toBeNull();
    expect(rowExpanded("model")).toBe(false);
  });
});

describe("a non-disclosing region row selects from its own label button (item C)", () => {
  // "Home tab" (topBar/"Task tabs") has no hint and no detail rows at all
  // (`rows: []`), and it is a LOOSE region - not part of any order group's
  // orderable SortableList - so it is the plain "select, nothing to open"
  // case `toggleSelected` exists for.
  it("selects on click with aria-pressed, and a second click clears it", () => {
    render(<Harness />);
    act(() => {
      useLayoutEditorStore.getState().openArea("topBar", null);
    });

    const button = rowButton("homeTab");
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);

    expect(useLayoutEditorStore.getState().selected).toBe("homeTab");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(row("homeTab").getAttribute("data-sortable-selected")).toBe("1");

    fireEvent.click(button);

    expect(useLayoutEditorStore.getState().selected).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("Enter selects it and Space clears it, both from the keyboard", () => {
    render(<Harness />);
    act(() => {
      useLayoutEditorStore.getState().openArea("topBar", null);
    });
    const button = rowButton("homeTab");
    button.focus();

    fireEvent.keyDown(button, { key: "Enter" });
    expect(useLayoutEditorStore.getState().selected).toBe("homeTab");

    fireEvent.keyDown(button, { key: " " });
    expect(useLayoutEditorStore.getState().selected).toBeNull();
  });
});

describe("Find (item 2, item 6)", () => {
  function findResult(key: string): HTMLElement {
    const node = document.querySelector(`[data-layout-find-result="${key}"]`);
    if (!(node instanceof HTMLElement))
      throw new Error(`no such result: ${key}`);
    return node;
  }

  it.each([
    { query: "Pin breakdown", area: "chat", region: "contextUsage" },
    { query: "Ring only", area: "chat", region: "contextUsage" },
    { query: "Cache read", area: "chat", region: "contextUsage" },
    { query: "Remaining", area: "statusBar", region: "usageLimits" },
  ] as const)(
    "lists $region alone for '$query', and Enter opens $area with it expanded",
    ({ query, area, region }) => {
      render(<Harness />);

      fireEvent.change(filterInput(), { target: { value: query } });
      expect(screen.queryAllByRole("button", { name: /^Chat$/ })).toHaveLength(
        0,
      );
      expect(findResult(region)).not.toBeNull();
      expect(
        document.querySelectorAll("[data-layout-find-result]"),
      ).toHaveLength(1);

      fireEvent.keyDown(filterInput(), { key: "Enter" });

      expect(useLayoutEditorStore.getState().area).toBe(area);
      expect(useLayoutEditorStore.getState().selected).toBe(region);
      // Find lives at All settings alone: opening the area consumes it.
      expect(useLayoutEditorStore.getState().filter).toBe("");
      expect(rowExpanded(region)).toBe(true);
    },
  );

  it("draws the highlighted name, the area breadcrumb and the current-state detail", () => {
    render(<Harness />);

    fireEvent.change(filterInput(), { target: { value: "minimap" } });

    const result = findResult("minimap");
    const mark = result.querySelector("mark");
    expect(mark?.textContent).toBe("Minimap");
    expect(result.textContent).toContain("Chat");
    // No detail matched the query itself, so the second line falls back to
    // Minimap's own current state (its side, under the default arrangement).
    expect(result.textContent).toContain("Right");
  });

  it("shows the empty-state copy once nothing matches", () => {
    render(<Harness />);

    fireEvent.change(filterInput(), { target: { value: "zzznomatch" } });

    expect(
      screen.queryByText('No layout settings match "zzznomatch".'),
    ).not.toBeNull();
    expect(
      screen.queryByRole("list", { name: "Matching settings" }),
    ).toBeNull();
  });

  it("clicking a result opens it exactly like Enter does", () => {
    render(<Harness />);
    fireEvent.change(filterInput(), { target: { value: "Remaining" } });

    fireEvent.click(findResult("usageLimits"));

    expect(useLayoutEditorStore.getState().area).toBe("statusBar");
    expect(useLayoutEditorStore.getState().selected).toBe("usageLimits");
    expect(useLayoutEditorStore.getState().filter).toBe("");
    expect(rowExpanded("usageLimits")).toBe(true);
  });

  it("walks the results with arrows and returns to the field on ArrowUp from the first", () => {
    render(<Harness />);
    // "usage" lists three results: the Usage and resources area, then
    // Context usage and Usage limits by name (region-filter-match.test.ts
    // pins this exact order).
    fireEvent.change(filterInput(), { target: { value: "usage" } });

    fireEvent.keyDown(filterInput(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(findResult("area:statusBar"));

    fireEvent.keyDown(findResult("area:statusBar"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(findResult("contextUsage"));

    fireEvent.keyDown(findResult("contextUsage"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(findResult("area:statusBar"));

    fireEvent.keyDown(findResult("area:statusBar"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(filterInput());
  });

  it("does not leave a stale query holding a row open once it is closed (L-89)", () => {
    render(<Harness />);
    fireEvent.change(filterInput(), { target: { value: "Pin breakdown" } });
    fireEvent.keyDown(filterInput(), { key: "Enter" });
    expect(rowExpanded("contextUsage")).toBe(true);

    // A different row selected off the canvas, the way `select` always
    // behaves - it opens alongside whatever was already open rather than
    // replacing it.
    act(() => {
      useLayoutEditorStore.getState().select("minimap");
    });
    expect(row("minimap").getAttribute("data-sortable-selected")).toBe("1");

    act(() => {
      useLayoutEditorStore.getState().popInspectorLevel();
    });

    expect(useLayoutEditorStore.getState().selected).toBeNull();
    expect(useLayoutEditorStore.getState().openRows).toEqual([]);
    // The query that opened it in the first place is long gone (cleared the
    // moment the area opened), so nothing forces it back open.
    expect(rowExpanded("contextUsage")).toBe(false);
  });

  describe("a matching area (R2-D addendum)", () => {
    it("lists Composer as an area result, labelled Area", () => {
      render(<Harness />);

      fireEvent.change(filterInput(), { target: { value: "composer" } });

      expect(findResult("area:composer").textContent).toContain("Composer");
      expect(findResult("area:composer").textContent).toContain("Area");
    });

    it("opens the area with nothing selected on Enter", () => {
      render(<Harness />);
      fireEvent.change(filterInput(), { target: { value: "composer" } });

      fireEvent.keyDown(filterInput(), { key: "Enter" });

      expect(useLayoutEditorStore.getState().area).toBe("composer");
      expect(useLayoutEditorStore.getState().selected).toBeNull();
      expect(useLayoutEditorStore.getState().filter).toBe("");
    });

    it("opens the area with nothing selected on click", () => {
      render(<Harness />);
      fireEvent.change(filterInput(), { target: { value: "composer" } });

      fireEvent.click(findResult("area:composer"));

      expect(useLayoutEditorStore.getState().area).toBe("composer");
      expect(useLayoutEditorStore.getState().selected).toBeNull();
      expect(useLayoutEditorStore.getState().filter).toBe("");
    });
  });
});

describe("layoutAreaSummary (L-91)", () => {
  it("reads the tab placement word for Task tabs", () => {
    expect(layoutAreaSummary("topBar", DEFAULT_LAYOUT_SNAPSHOT)).toBe("Top");
  });

  it("counts the Sidebar's panels, and how many are hidden", () => {
    const panelCount = DEFAULT_ARRANGEMENT.rail.filter(
      (entry) => entry.kind === "panel",
    ).length;
    expect(layoutAreaSummary("sidebar", DEFAULT_LAYOUT_SNAPSHOT)).toBe(
      `${String(panelCount)} panels`,
    );

    const snapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: {
        ...DEFAULT_LAYOUT_SNAPSHOT.overrides,
        railPullRequests: { shown: "hidden" as const },
      },
    };
    expect(layoutAreaSummary("sidebar", snapshot)).toBe(
      `${String(panelCount)} panels · 1 hidden`,
    );
  });

  it("reads Chips once every shown Composer dock member has folded to a chip", () => {
    act(() => {
      useLayoutStore.getState().applyPreset("compact");
    });
    expect(layoutAreaSummary("composer", useLayoutStore.getState())).toBe(
      "Chips",
    );
  });
});

/**
 * Side tab view is not a region, but it is a row a pointer can hover and
 * select from `LayoutAreaLevel` exactly like one - `use-layout-surface.ts`'s
 * `useLayoutSettingPart` reads `hoveredSetting`/`selectedSetting` to light and
 * ring its part on the canvas (D9, item B).
 */
describe("Side tab view's row lights and selects its canvas part", () => {
  function sideStripViewRow(): HTMLElement {
    const node = document.querySelector(
      '[data-settings-anchor="layout-side-strip-view"]',
    );
    if (!(node instanceof HTMLElement)) {
      throw new Error("no Side tab view row");
    }
    return node;
  }

  it("hovering the row sets hoveredSetting, and leaving the area clears it", () => {
    const view = render(<Harness />);
    act(() => {
      useLayoutEditorStore.getState().openArea("topBar", null);
    });

    fireEvent.pointerOver(sideStripViewRow());
    expect(useLayoutEditorStore.getState().hoveredSetting).toBe(
      "sideStripView",
    );

    const outer = view.container.firstElementChild;
    if (!(outer instanceof HTMLElement)) throw new Error("no area root");
    fireEvent.pointerLeave(outer);

    expect(useLayoutEditorStore.getState().hoveredSetting).toBeNull();
  });

  it("hovering a region row instead clears any hovered setting", () => {
    render(<Harness />);
    act(() => {
      useLayoutEditorStore.getState().openArea("topBar", null);
    });
    fireEvent.pointerOver(sideStripViewRow());
    expect(useLayoutEditorStore.getState().hoveredSetting).toBe(
      "sideStripView",
    );

    fireEvent.pointerOver(row("homeTab"));

    expect(useLayoutEditorStore.getState().hoveredSetting).toBeNull();
    expect(useLayoutEditorStore.getState().hovered).toBe("homeTab");
  });

  it("a pointerdown inside the row selects the setting", () => {
    render(<Harness />);
    act(() => {
      useLayoutEditorStore.getState().openArea("topBar", null);
    });

    fireEvent.pointerDown(sideStripViewRow());

    expect(useLayoutEditorStore.getState().selectedSetting).toBe(
      "sideStripView",
    );
    expect(useLayoutEditorStore.getState().area).toBe("topBar");
  });
});

describe("layoutAreaChanged (L-91)", () => {
  it("reads Presets off the whole-layout modified flag, not a surface diff", () => {
    expect(layoutAreaChanged("presets", DEFAULT_LAYOUT_SNAPSHOT)).toBe(false);

    // Applying a preset alone is not a modification (it clears the delta
    // rather than creating one - `layoutModified` reads the delta), so this
    // needs an actual arrangement change to light the Presets area's dot.
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
      });
    });
    expect(layoutAreaChanged("presets", useLayoutStore.getState())).toBe(true);
  });
});
