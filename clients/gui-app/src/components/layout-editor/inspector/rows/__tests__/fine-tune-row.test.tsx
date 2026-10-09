import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armLayoutDrag } from "@/components/layout-editor/canvas/drag-engine";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import {
  FineTuneRowView,
  type FineTuneRowFacts,
} from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { useLayoutFormContext } from "@/components/layout-editor/inspector/use-layout-form-context";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import type { AnyGrammarRow } from "@/components/layout-editor/regions/region-facts";
import { orderedRows } from "@/components/layout-editor/regions/row-availability";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

// The drag itself (pointer capture, measured geometry) is the engine's own
// suite; here it is a spy that a press arms.
vi.mock(
  "@/components/layout-editor/canvas/drag-engine",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/layout-editor/canvas/drag-engine")
      >();
    return { ...actual, armLayoutDrag: vi.fn() };
  },
);

/**
 * `FineTuneRowView` draws ONE detail row, where the region's disclosure
 * places it (`orderedRows`): its control, its revert and, through the row
 * shell, what it depends on. Whether a row is disabled is the registry's
 * rule over the one form context (P1), so these tests ask the registry for
 * each row's availability exactly as `SurfaceSection` does, rather than
 * handing a row an answer of the test's own: "Breakdown rows" only means
 * something once "Pin breakdown" is on.
 */

function fineTuneRows(region: RegionId): ReadonlyArray<FineTuneRowFacts> {
  // Annotated rather than inferred: indexing the registry with a UNION of ids
  // gives a union of arrays, and `flatMap` on one has no single signature,
  // so both the walk and each row's answer are stated.
  const declared: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[region].rows;
  return declared.flatMap((row): ReadonlyArray<FineTuneRowFacts> =>
    row.kind === "fine-tune" ? row.rows : [],
  );
}

const CONTEXT_USAGE_ROWS = fineTuneRows("contextUsage");

function Rows(props: {
  readonly regionId: RegionId;
  readonly rows: ReadonlyArray<FineTuneRowFacts>;
}): ReactNode {
  const context = useLayoutFormContext();
  return orderedRows(props.rows, context).map(
    ({ row, depth, availability }) => (
      <FineTuneRowView
        key={row.id}
        row={row}
        regionId={props.regionId}
        regionValues={context.values[props.regionId]}
        arrangement={context.arrangement}
        availability={availability}
        depth={depth}
      />
    ),
  );
}

function renderContextUsageRows(): void {
  render(<Rows regionId="contextUsage" rows={CONTEXT_USAGE_ROWS} />);
}

/** The fieldset that holds a row's control, found through its label. */
function controlGroup(label: string): HTMLFieldSetElement {
  const group = screen.getByText(label).closest("[data-layout-form-row]");
  const fieldset = group?.querySelector("fieldset");
  if (!(fieldset instanceof HTMLFieldSetElement)) {
    throw new Error(`${label} has no control group`);
  }
  return fieldset;
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

describe("a row's own dependency (Breakdown rows needs Pin breakdown)", () => {
  it("disables its control group, keeps it in the tree, and says why through aria-describedby", () => {
    renderContextUsageRows();

    const group = controlGroup("Breakdown rows");
    expect(group.disabled).toBe(true);
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
    const reason = screen.getByText("Turn on Pin breakdown to use this.");
    expect(reason.getAttribute("data-row-availability")).toBe("disabled");
    expect(group.getAttribute("aria-describedby")).toBe(reason.id);
    // Drawn under the switch it depends on, one level in.
    expect(
      screen
        .getByText("Breakdown rows")
        .closest("[data-layout-form-row]")
        ?.getAttribute("data-row-depth"),
    ).toBe("1");
    // Pin breakdown itself, and the unrelated Compact conversation button
    // row, are never gated by it.
    expect(controlGroup("Pin breakdown").disabled).toBe(false);
    expect(controlGroup("Compact conversation button").disabled).toBe(false);
  });

  it("becomes operable once Pin breakdown is switched on", () => {
    useLayoutStore
      .getState()
      .setRegionValues("contextUsage", { pinBreakdown: true });
    renderContextUsageRows();

    expect(controlGroup("Breakdown rows").disabled).toBe(false);
    expect(screen.queryByText("Turn on Pin breakdown to use this.")).toBeNull();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox.matches(":disabled")).toBe(false);
    }
  });
});

/**
 * Breakdown rows is a sortable check list (C2): a check writes the SET
 * (`pinnedFields`), a drag writes the ORDER (`pinnedContextFieldOrder`, every
 * field, checked or not). Driven through the list's own gestures - the
 * keyboard grab, and the pointer press that arms the drag engine (replaced by
 * a spy above: where a drop lands is `drag-engine.test.ts`'s business, that
 * the drop writes the order is this one's).
 */
describe("Breakdown rows' order (C2)", () => {
  const SHIPPED = DEFAULT_ARRANGEMENT.pinnedContextFieldOrder;

  function order(): ReadonlyArray<string> {
    return useLayoutStore.getState().arrangement.pinnedContextFieldOrder;
  }

  function listedRows(): ReadonlyArray<string> {
    return [...document.querySelectorAll("[data-sortable-id]")].map(
      (node) => node.getAttribute("data-sortable-id") ?? "",
    );
  }

  function sortableRow(id: string): HTMLElement {
    const node = document.querySelector(`[data-sortable-id="${id}"]`);
    if (!(node instanceof HTMLElement)) throw new Error(`no row: ${id}`);
    return node;
  }

  beforeEach(() => {
    useLayoutStore
      .getState()
      .setRegionValues("contextUsage", { pinBreakdown: true });
  });

  it("draws the rows in the stored order, every field, checked or not", () => {
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      pinnedContextFieldOrder: [...SHIPPED].reverse(),
    });
    renderContextUsageRows();

    expect(listedRows()).toEqual([...SHIPPED].reverse());
  });

  it("writes the order only on the drop of a keyboard grab, and leaves the checked set alone", () => {
    renderContextUsageRows();
    const checkedBefore =
      useLayoutStore.getState().overrides.contextUsage?.pinnedFields;
    const grabbed = sortableRow(SHIPPED[0]);

    fireEvent.keyDown(grabbed, { key: " " });
    fireEvent.keyDown(grabbed, { key: "ArrowDown" });
    fireEvent.keyDown(grabbed, { key: "ArrowDown" });
    // Nothing is written until the drop.
    expect(order()).toEqual(SHIPPED);
    fireEvent.keyDown(grabbed, { key: " " });

    expect(order()).toEqual([
      SHIPPED[1],
      SHIPPED[2],
      SHIPPED[0],
      ...SHIPPED.slice(3),
    ]);
    expect(
      useLayoutStore.getState().overrides.contextUsage?.pinnedFields,
    ).toEqual(checkedBefore);
  });

  it("writes the order from a pointer drop, once the press has armed the drag", () => {
    renderContextUsageRows();

    fireEvent.pointerDown(within(sortableRow(SHIPPED[1])).getByText("Fresh"), {
      button: 0,
      pointerId: 1,
    });

    const armed = vi.mocked(armLayoutDrag).mock.calls.at(-1)?.[0];
    if (armed === undefined) throw new Error("the press did not arm a drag");
    armed.onDrop(1, 4);

    expect(order()).toEqual([SHIPPED[0], ...SHIPPED.slice(2, 5), SHIPPED[1]]);
  });

  it("offers no drag while the list is disabled for want of Pin breakdown", () => {
    useLayoutStore
      .getState()
      .setRegionValues("contextUsage", { pinBreakdown: false });
    renderContextUsageRows();
    vi.mocked(armLayoutDrag).mockClear();

    fireEvent.pointerDown(within(sortableRow(SHIPPED[1])).getByText("Fresh"), {
      button: 0,
      pointerId: 1,
    });
    fireEvent.keyDown(sortableRow(SHIPPED[1]), { key: " " });
    fireEvent.keyDown(sortableRow(SHIPPED[1]), { key: "ArrowDown" });
    fireEvent.keyDown(sortableRow(SHIPPED[1]), { key: " " });

    expect(vi.mocked(armLayoutDrag)).not.toHaveBeenCalled();
    expect(order()).toEqual(SHIPPED);
  });

  it("puts the order back with the row's own revert, together with the checked set", () => {
    useLayoutStore.getState().setRegionValues("contextUsage", {
      pinBreakdown: true,
      pinnedFields: ["used", "output"],
    });
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      pinnedContextFieldOrder: [...SHIPPED].reverse(),
    });
    renderContextUsageRows();

    fireEvent.click(
      screen.getByRole("button", { name: "Revert Breakdown rows" }),
    );

    expect(order()).toEqual(SHIPPED);
    expect(
      useLayoutStore.getState().overrides.contextUsage?.pinnedFields,
    ).toBeUndefined();
  });
});
