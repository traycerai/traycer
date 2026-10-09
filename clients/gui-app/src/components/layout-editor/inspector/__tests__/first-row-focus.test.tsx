import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { focusSortableRowGrab } from "@/components/layout-editor/inspector/first-row-focus";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";
import {
  SortableList,
  type SortableListItem,
} from "@/components/layout-editor/inspector/sortable-list";
import { LIVE } from "@/components/layout-editor/regions/row-availability";

type RowId = "minimap" | "contextUsage";

/**
 * The real list, because the helper's whole content is two facts about ITS
 * markup - where a row's id lives and which element in the row is the tab stop
 * (L-114). A hand-built fixture would assert the helper's own selectors
 * against a copy of them and pass whatever the list did.
 *
 * Each row carries a control, so "the row's tab stop" is a claim with
 * something to be wrong about: the control is focusable too, and it is not the
 * thing a landing or an ArrowDown is meant to reach.
 */
function row(id: RowId, label: string): SortableListItem<RowId> {
  return {
    id,
    label,
    icon: null,
    glyph: null,
    divider: false,
    movable: true,
    dimmed: false,
    hint: null,
    control: (
      <button type="button" aria-label={`${label} display`}>
        Shown
      </button>
    ),
    revert: null,
    detail: null,
    open: false,
    onToggleOpen: null,
    onRemove: null,
    removeLabel: null,
    onStack: null,
    stackMembers: null,
    availability: LIVE,
  };
}

function renderPane(): HTMLElement {
  render(
    <LayoutFormHostContext value="page">
      <div data-testid="pane">
        <SortableList
          items={[
            row("minimap", "Minimap"),
            row("contextUsage", "Context usage"),
          ]}
          label="Chat"
          selectedId={null}
          onMove={() => {}}
        />
      </div>
    </LayoutFormHostContext>,
  );
  return screen.getByTestId("pane");
}

function card(id: RowId): Element {
  const found = document.querySelector(`[data-sortable-id="${id}"]`);
  if (found === null) throw new Error(`no row for ${id}`);
  return found;
}

afterEach(() => {
  cleanup();
});

describe("focusing a list row from outside the list", () => {
  it("lands on the row a caller already has in hand", () => {
    renderPane();

    focusSortableRowGrab(card("contextUsage"));

    const active = document.activeElement;
    if (active === null) throw new Error("nothing took focus");
    expect(card("contextUsage").contains(active)).toBe(true);
    expect(active.hasAttribute("data-row-grab")).toBe(true);
  });

  it("does nothing when there is no row", () => {
    renderPane();
    const before = document.activeElement;

    focusSortableRowGrab(null);

    expect(document.activeElement).toBe(before);
  });
});
