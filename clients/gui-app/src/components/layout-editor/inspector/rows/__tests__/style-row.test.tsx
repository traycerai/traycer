import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StyleRow } from "@/components/layout-editor/inspector/rows/style-row";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * Model has two style rows sharing one component (`region-grammar.ts`): its
 * chip Style and its picker footer's Reasoning control. This covers the
 * second one - its checked example, a click writing the example's patch, and
 * the per-row revert only appearing once the value has actually moved off the
 * last-applied preset (L-133).
 */

function modelStyleRow(key: string) {
  const row = LAYOUT_REGIONS.model.rows.find(
    (candidate) => candidate.kind === "style" && candidate.key === key,
  );
  if (row === undefined || row.kind !== "style") {
    throw new Error(`model has no style row for "${key}"`);
  }
  return row;
}

function renderModelStyleRow(key: string) {
  const row = modelStyleRow(key);
  const state = useLayoutStore.getState();
  const values = effectiveLayoutValues(state.basePreset, state.overrides);
  return render(
    <StyleRow
      label={row.label}
      styleKey={row.key}
      examples={row.examples}
      regionId="model"
      values={values}
      arrangement={DEFAULT_ARRANGEMENT}
    />,
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

describe("<StyleRow /> Model's Reasoning control", () => {
  it("shows Slider checked by default (the shipped preset)", () => {
    renderModelStyleRow("reasoningControl");

    expect(
      screen
        .getByRole("radio", { name: "Slider" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "List" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("writes reasoningControl on a click of the List example", () => {
    renderModelStyleRow("reasoningControl");

    fireEvent.click(screen.getByRole("radio", { name: "List" }));

    expect(useLayoutStore.getState().overrides.model).toEqual({
      reasoningControl: "list",
    });
  });

  it("shows no revert until the value differs from the preset, then reverts it on click", () => {
    renderModelStyleRow("reasoningControl");
    expect(
      screen.queryByRole("button", { name: "Revert Reasoning control" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    cleanup();
    renderModelStyleRow("reasoningControl");

    const revert = screen.getByRole("button", {
      name: "Revert Reasoning control",
    });
    expect(revert).not.toBeNull();

    fireEvent.click(revert);

    expect(
      useLayoutStore.getState().overrides.model?.reasoningControl,
    ).toBeUndefined();
  });
});
