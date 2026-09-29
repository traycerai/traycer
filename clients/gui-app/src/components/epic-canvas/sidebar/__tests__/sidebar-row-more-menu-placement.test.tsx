/**
 * SidebarRowMoreMenu's column-edge placement, against REAL Radix.
 *
 * The more menu now reads `useColumnOverlayPlacement("row")` so a row's
 * dropdown opens toward the canvas content rather than off the visible edge
 * when the sidebar sits on the right. This is the same D7 wiring covered for
 * `ChatFilterMenu` in `epic-sidebar-side.test.tsx`'s "a real sidebar popover
 * under a right sidebar" case, applied to the row-level more menu, whose
 * trigger mounts its Radix root lazily on first use
 * (`use-sidebar-row-dropdown-mount.ts`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { SidebarRowMoreMenu } from "@/components/epic-canvas/sidebar/sidebar-row-more-menu";
import type { SidebarRowMenuEntry } from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";

const ROW_ID = "row-a";

function entries(): ReadonlyArray<SidebarRowMenuEntry> {
  return [
    {
      kind: "item",
      id: "rename",
      label: "Rename",
      icon: null,
      disabled: false,
      disabledTooltip: null,
      variant: "default",
      testIds: { dropdown: "item-rename", context: "ctx-rename" },
      onSelect: () => undefined,
    },
  ];
}

function renderMoreMenu(edge: "left" | "right" | null): void {
  const trigger = (
    <SidebarRowMoreMenu
      nodeId={ROW_ID}
      label="Row actions"
      className=""
      entries={entries()}
    />
  );
  render(
    edge === null ? (
      trigger
    ) : (
      <ColumnEdgeContext.Provider value={edge}>
        {trigger}
      </ColumnEdgeContext.Provider>
    ),
  );
}

function openMoreMenu(): void {
  fireEvent.pointerDown(screen.getByTestId(`epic-sidebar-more-${ROW_ID}`), {
    button: 0,
    pointerType: "mouse",
  });
}

describe("<SidebarRowMoreMenu /> placement (D7)", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens a never-touched row's More menu on the content-facing side under a right sidebar", () => {
    renderMoreMenu("right");

    openMoreMenu();

    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("data-side")).toBe("left");
    expect(menu.getAttribute("data-align")).toBe("start");
  });

  it("keeps the bottom/end placement outside a column", () => {
    renderMoreMenu(null);

    openMoreMenu();

    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("data-align")).toBe("end");
    expect(menu.getAttribute("data-side")).toBe("bottom");
  });
});
