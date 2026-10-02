import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FineTuneRows,
  type FineTuneRowFacts,
} from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * `FineTuneRows` is always in place now, in both hosts (item 2, G6): the
 * collapsed "Fine-tune (n)" trigger `FineTuneDisclosure` used to draw is gone,
 * and there is no `filter` prop left to auto-expand it with - a Find match on
 * one of these rows opens the region row's OWN disclosure directly
 * (`layout-form.tsx`'s `openResult`, off `layoutFindResults`), not a second
 * collapsible nested inside it.
 *
 * What is still under test here is the per-row `requires` gate (item 3, L-08
 * overturned): "Breakdown rows" only means something once "Pin breakdown" is
 * on.
 */

function fineTuneRows(region: RegionId) {
  const row = LAYOUT_REGIONS[region].rows.find(
    (candidate) => candidate.kind === "fine-tune",
  );
  if (row === undefined) {
    throw new Error(`${region} has no fine-tune row`);
  }
  return row.rows;
}

const CONTEXT_USAGE_ROWS = fineTuneRows("contextUsage");

function regionValues(region: RegionId) {
  const state = useLayoutStore.getState();
  return effectiveLayoutValues(state.basePreset, state.overrides)[region];
}

function rows(
  region: RegionId,
  rowFacts: ReadonlyArray<FineTuneRowFacts>,
  regionHidden: boolean,
): ReactNode {
  return (
    <FineTuneRows
      rows={rowFacts}
      regionId={region}
      regionValues={regionValues(region)}
      regionHidden={regionHidden}
    />
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

describe("a row's own `requires` gate (Breakdown rows needs Pin breakdown)", () => {
  it("disables a fieldset around it, present in the tree, and says why (item 8)", () => {
    render(rows("contextUsage", CONTEXT_USAGE_ROWS, false));

    const wrapper = screen.getByText("Breakdown rows").closest("fieldset");
    expect(wrapper).not.toBeNull();
    expect((wrapper as HTMLFieldSetElement).disabled).toBe(true);
    // A disabled `fieldset` disables its own checkboxes without opacity or
    // `inert`: every one is still findable by role, and every one matches
    // `:disabled` - the CSS pseudo-class a browser (and jsdom) computes from
    // the ancestor fieldset, which a Radix `Checkbox` (a plain `<button>`
    // with no `disabled` attribute of its own) has no other way to carry.
    const breakdownCheckboxes = screen.getAllByRole("checkbox");
    expect(breakdownCheckboxes.length).toBeGreaterThan(0);
    for (const checkbox of breakdownCheckboxes) {
      expect(checkbox.matches(":disabled")).toBe(true);
    }
    expect(
      screen.getByText("Turn on Pin breakdown to change this."),
    ).not.toBeNull();
    // Pin breakdown itself, and the unrelated Compact conversation button
    // row, are never gated by it.
    expect(
      (
        screen
          .getByText("Pin breakdown")
          .closest("fieldset") as HTMLFieldSetElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen
          .getByText("Compact conversation button")
          .closest("fieldset") as HTMLFieldSetElement
      ).disabled,
    ).toBe(false);
  });

  it("becomes operable once Pin breakdown is switched on", () => {
    useLayoutStore
      .getState()
      .setRegionValues("contextUsage", { pinBreakdown: true });
    render(rows("contextUsage", CONTEXT_USAGE_ROWS, false));

    expect(
      (
        screen
          .getByText("Breakdown rows")
          .closest("fieldset") as HTMLFieldSetElement
      ).disabled,
    ).toBe(false);
    expect(
      screen.queryByText("Turn on Pin breakdown to change this."),
    ).toBeNull();
  });
});
