import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SplitContainer } from "@/components/epic-canvas/canvas/split-container";
import type {
  SizesByGroupId,
  TileGroup,
  TilePane,
} from "@/stores/epics/canvas/tile-tree";

function pane(id: string): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds: [],
    activeTabId: null,
    previewTabId: null,
    activationHistory: [],
  };
}

function TestPane() {
  return <div data-testid="test-pane" />;
}

describe("SplitContainer split-child height contract", () => {
  afterEach(() => {
    cleanup();
  });

  it("gives every data-split-child an explicit h-full so the percentage height chain stays unbroken", () => {
    // Regression guard for the split-only height collapse on a display:none ->
    // visible reveal: the `data-split-child` wrapper is the one node in the
    // chain that exists only in a split, and its descendants size via
    // `height:100%`. Without an explicit definite height here the cascade
    // collapses on reveal (panes shrink to content height). See split-container.
    const group: TileGroup = {
      kind: "group",
      id: "group-1",
      direction: "horizontal",
      children: [pane("pane-a"), pane("pane-b")],
    };
    const sizes: SizesByGroupId = { "group-1": [0.5, 0.5] };

    const { container } = render(
      <SplitContainer
        root={group}
        sizesByGroupId={sizes}
        PaneComponent={TestPane}
        onResizeGroup={vi.fn()}
      />,
    );

    // The split group fills its parent via `absolute inset-0` (definite height
    // on reveal) instead of `h-full`, so the children don't lose the
    // percentage-height race on a display:none -> visible reveal.
    const groupEl = container.querySelector('[data-testid="tile-split"]');
    expect(groupEl).not.toBeNull();
    expect(groupEl?.classList.contains("absolute")).toBe(true);
    expect(groupEl?.classList.contains("inset-0")).toBe(true);

    const children = container.querySelectorAll("[data-split-child]");
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.classList.contains("h-full")).toBe(true);
    }
  });
});
