/**
 * Sidebar row menu entries, against REAL Radix - no mocks.
 *
 * The sibling sidebar suites mock `@/components/ui/dropdown-menu` and
 * `@/components/ui/tooltip`, which is fine for wiring but structurally cannot
 * check the things this file exists for: the accessible NAME a browser would
 * compute, the `aria-disabled` Radix derives from `disabled`, and whether a
 * tooltip trigger placed on the menu item via `asChild` actually still fires.
 * A pass-through mock satisfies all three by construction.
 *
 * That last one is the reason this file was added. The disabled-reason tooltip
 * used to sit on an intermediate wrapper; moving it onto the item means Radix's
 * `Slot` has to merge the trigger's handlers into a Radix menu item that
 * defines several of its own. If that merge silently dropped them the tooltip
 * would simply never open, and every mocked test would still pass.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  DropdownMenu,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import {
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "../sidebar-row-menu-items";

const BUSY_REASON =
  "Can't archive while this agent has background items running.";

function entries(): ReadonlyArray<SidebarRowMenuEntry> {
  return [
    {
      kind: "item",
      id: "archive",
      label: "Archive",
      icon: null,
      // Disabled WITH a reason -> soft-disabled.
      disabled: true,
      disabledTooltip: BUSY_REASON,
      variant: "default",
      testIds: { dropdown: "item-archive", context: "ctx-archive" },
      onSelect: () => undefined,
    },
    {
      kind: "item",
      id: "rename",
      label: "Rename",
      icon: null,
      // Disabled with NO reason (a transient in-flight mutation) -> stays
      // hard-disabled.
      disabled: true,
      disabledTooltip: null,
      variant: "default",
      testIds: { dropdown: "item-rename", context: "ctx-rename" },
      onSelect: () => undefined,
    },
    {
      kind: "item",
      id: "delete",
      label: "Delete",
      icon: null,
      disabled: false,
      disabledTooltip: null,
      variant: "destructive",
      testIds: { dropdown: "item-delete", context: "ctx-delete" },
      onSelect: () => undefined,
    },
  ];
}

function renderMenu(): void {
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <SidebarDropdownMenuItems entries={entries()} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("SidebarDropdownMenuItems against real Radix", () => {
  // This project runs vitest with `globals: false`, so Testing Library's
  // auto-cleanup never registers - without this each test inherits the
  // previous one's DOM and every query matches twice.
  afterEach(() => {
    cleanup();
  });

  it("names a soft-disabled item by its LABEL, not label + reason", () => {
    // The reason lives in an `sr-only` span inside the item so the item can
    // describe itself without depending on the tooltip being open. `sr-only`
    // hides visually but does NOT leave the name-from-content subtree, so
    // without `aria-hidden` the item would be named "Archive Can't archive
    // while..." and then announce the very same sentence again as its
    // description. This query computes the real accessible name.
    renderMenu();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBe(
      screen.getByTestId("item-archive"),
    );
  });

  it("describes a soft-disabled item with the reason, resolvably", () => {
    renderMenu();
    const item = screen.getByTestId("item-archive");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    const describedBy = item.getAttribute("aria-describedby");
    if (describedBy === null) throw new Error("expected aria-describedby");
    const description = document.getElementById(describedBy);
    if (description === null) {
      throw new Error(`aria-describedby '${describedBy}' resolves to nothing`);
    }
    expect(description.textContent).toBe(BUSY_REASON);
    expect(item.contains(description)).toBe(true);
  });

  it("keeps a soft-disabled item focusable and out of the disabled state", () => {
    // The whole point of soft-disabling: Radix sets `focusable: !disabled` and
    // filters hard-disabled items out of typeahead, which would remove Archive
    // from the keyboard entirely - and with the hover button already hidden on
    // a busy row, that is the action AND its explanation gone.
    renderMenu();
    const item = screen.getByTestId("item-archive");
    expect(item.hasAttribute("data-disabled")).toBe(false);
    expect(item.matches(":disabled")).toBe(false);
  });

  it("leaves Radix's own aria-disabled intact on a HARD-disabled item", () => {
    // Radix renders `"aria-disabled": disabled || undefined` BEFORE spreading
    // caller props, so passing an explicit `false` overrides the `true` it
    // derived and announces an inert, keyboard-skipped item as available. The
    // hard-disabled arm must omit the prop entirely rather than pass `false`.
    renderMenu();
    const item = screen.getByTestId("item-rename");
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    // And it carries no description, so nothing dangles.
    expect(item.getAttribute("aria-describedby")).toBeNull();
  });

  it("puts no element between the menu and any item", () => {
    // An intermediate node breaks `menu` -> `menuitem` ownership, and
    // `role="presentation"` cannot save it: ARIA ignores a presentational role
    // on an element carrying a global ARIA property, and Radix Tooltip assigns
    // `aria-describedby` to its trigger while open.
    renderMenu();
    const menu = screen.getByRole("menu");
    for (const testId of ["item-archive", "item-rename", "item-delete"]) {
      expect(screen.getByTestId(testId).parentElement).toBe(menu);
    }
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
  });

  it("still opens the tooltip from the item itself", () => {
    // The regression removing the wrapper could have caused: Radix `Slot` has
    // to merge `TooltipTrigger`'s handlers into a menu item that defines its
    // own. If they were dropped, the tooltip would never open and only an
    // unmocked test would notice.
    renderMenu();
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(screen.getByTestId("item-archive"));

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain(BUSY_REASON);
  });

  it("opens no tooltip for an entry with no reason", () => {
    renderMenu();
    fireEvent.focus(screen.getByTestId("item-rename"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
