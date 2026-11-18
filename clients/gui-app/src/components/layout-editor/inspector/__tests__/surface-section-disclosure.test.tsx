import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import { SurfaceSection } from "@/components/layout-editor/inspector/surface-section";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import {
  SURFACE_GROUPS,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * Item 1 - empty disclosures (G6): a row only discloses where opening it
 * shows something, which is `regionDetailRows(regionId).length > 0` or the
 * region's own presence-rule hint. `surface-section.tsx`'s `decorate`
 * computes `discloses` and feeds it to `detail` / `open` / `onToggleOpen`.
 *
 * Rendered through the real `SurfaceSection` (the page host) rather than a
 * hand-rolled decoration, because the claim under test is what THAT function
 * now computes for a real region, not what a test's own decorator would.
 */

function row(id: string): HTMLElement {
  const node = document.querySelector(`[data-sortable-id="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no such row: ${id}`);
  return node;
}

function grabOf(rowNode: HTMLElement): HTMLElement {
  const node = rowNode.querySelector("[data-row-grab]");
  if (!(node instanceof HTMLElement)) throw new Error("row has no grab");
  return node;
}

function chevronOf(rowNode: HTMLElement): SVGElement | null {
  return rowNode.querySelector("svg.lucide-chevron-right");
}

/** The page's real open/close wiring (`layout-settings-panel.tsx`'s own). */
function Card(props: {
  readonly surface: SurfaceGroupId;
  readonly onToggle?: (id: string) => void;
}): ReactNode {
  const [openRows, setOpenRows] = useState<ReadonlyArray<string>>([]);
  const state = useLayoutStore.getState();
  return (
    <LayoutFormHostContext value="page">
      <SurfaceSection
        surface={props.surface}
        snapshot={{
          basePreset: state.basePreset,
          overrides: state.overrides,
          arrangement: state.arrangement,
        }}
        openRows={openRows}
        onSelectRow={null}
        onToggleRow={(id) => {
          props.onToggle?.(id);
          setOpenRows((prev) =>
            prev.includes(id)
              ? prev.filter((existing) => existing !== id)
              : [...prev, id],
          );
        }}
        selectedRow={null}
      />
    </LayoutFormHostContext>
  );
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

describe("a row with nothing to disclose (G6)", () => {
  it("draws no chevron and no detail for a region with neither detail rows nor a hint", () => {
    // Home tab: rows: [], hint: null - the case the audit named.
    expect(regionFacts("homeTab").hint).toBeNull();

    render(<Card surface="topBar" />);
    const node = row("homeTab");

    expect(chevronOf(node)).toBeNull();
    expect(grabOf(node).getAttribute("aria-expanded")).toBeNull();
    expect(node.querySelector("[data-sortable-detail]")).toBeNull();
  });
});

describe("a row with a detail row discloses (G6)", () => {
  it("draws a chevron for a region with a position-side detail row, and toggles it open on click", () => {
    // Minimap: a position-side row, no hint - the "detail rows" half of the
    // rule rather than the hint half.
    expect(regionFacts("minimap").hint).toBeNull();

    render(<Card surface="chat" />);
    const node = row("minimap");

    expect(chevronOf(node)).not.toBeNull();
    expect(grabOf(node).getAttribute("aria-expanded")).toBe("false");
    expect(node.querySelector("[data-sortable-detail]")).toBeNull();

    fireEvent.click(grabOf(node));

    expect(
      row("minimap").querySelector("[data-sortable-detail]"),
    ).not.toBeNull();
    expect(grabOf(row("minimap")).getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(grabOf(row("minimap")));

    expect(row("minimap").querySelector("[data-sortable-detail]")).toBeNull();
    expect(grabOf(row("minimap")).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a hint alone is enough to disclose (G6)", () => {
  it("draws a chevron for a rail panel whose only fact is its presence rule", () => {
    // railPullRequests has the SAME rows as railAgents (one position-order
    // row, no detail kind at all) - what differs is the hint.
    expect(regionFacts("railPullRequests").hint).not.toBeNull();
    expect(regionFacts("railAgents").hint).toBeNull();

    render(<Card surface="sidebar" />);

    expect(chevronOf(row("railPullRequests"))).not.toBeNull();
    expect(grabOf(row("railPullRequests")).getAttribute("aria-expanded")).toBe(
      "false",
    );

    expect(chevronOf(row("railAgents"))).toBeNull();
    expect(grabOf(row("railAgents")).getAttribute("aria-expanded")).toBeNull();
  });

  it("opens the hint's own row on click, and leaves the hint-less one inert", () => {
    const onToggle = vi.fn();
    render(<Card surface="sidebar" onToggle={onToggle} />);

    fireEvent.click(grabOf(row("railAgents")));
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(grabOf(row("railPullRequests")));
    expect(onToggle).toHaveBeenCalledWith("railPullRequests");
    expect(
      row("railPullRequests").querySelector("[data-sortable-detail]"),
    ).not.toBeNull();
  });
});

describe("every chevron opens something with content (G6, all five areas)", () => {
  // The browser driver asked this of every row of every area, by opening each
  // one and reading its detail text. The per-region cases above name three
  // regions; this is the same claim over the whole registry, so a region whose
  // detail draws nothing (a row kind that returns null, a hint-only region
  // with an empty hint) is a failure here rather than a chevron that opens
  // onto blank space.
  // Task tabs (Home tab is its only row and has no detail) and Usage and
  // resources (its readings are always-open sections) have nothing to
  // disclose, so they are asserted to draw none; the others draw at least one, which is what keeps a broken selector from passing vacuously.
  const DISCLOSING_ROWS_AT_LEAST: Readonly<Record<SurfaceGroupId, number>> = {
    topBar: 0,
    sidebar: 1,
    chat: 1,
    composer: 1,
    // The two readings are always-open sections, not disclosures.
    statusBar: 0,
  };

  it.each(SURFACE_GROUPS.map((group) => group.id))(
    "%s: each row that draws a chevron discloses non-empty detail, and closes again",
    (surface) => {
      render(<Card surface={surface} />);

      const disclosing = [
        ...document.querySelectorAll("[data-sortable-id]"),
      ].filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.querySelector(":scope > [data-row-line] [aria-expanded]") !==
            null,
      );
      expect(disclosing.length).toBeGreaterThanOrEqual(
        DISCLOSING_ROWS_AT_LEAST[surface],
      );
      if (DISCLOSING_ROWS_AT_LEAST[surface] === 0) {
        expect(disclosing).toHaveLength(0);
      }

      for (const node of disclosing) {
        const id = node.getAttribute("data-sortable-id") ?? "";
        const grab = node.querySelector(
          ":scope > [data-row-line] [aria-expanded]",
        );
        if (!(grab instanceof HTMLElement)) throw new Error(`no grab: ${id}`);

        fireEvent.click(grab);
        const detail = row(id).querySelector(":scope > [data-sortable-detail]");
        expect(detail, `${surface}: ${id} opened no detail`).not.toBeNull();
        expect(
          detail?.textContent.trim().length,
          `${surface}: row ${id} has a chevron that opens nothing`,
        ).toBeGreaterThan(0);

        fireEvent.click(grab);
        expect(
          row(id).querySelector(":scope > [data-sortable-detail]"),
          `${surface}: ${id} did not close`,
        ).toBeNull();
      }
    },
  );
});
