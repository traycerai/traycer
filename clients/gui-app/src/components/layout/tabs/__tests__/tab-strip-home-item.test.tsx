/**
 * `TabStripHomeItem` borrows `TabItem`'s tab silhouette but is deliberately
 * NOT a `TabItem` (`tab-strip-item.tsx`): Home has no strip ref, so it must
 * carry none of the affordances that depend on one - a drag source, a drop
 * slot, or the `data-tab-index` digit slot the Alt-digit chords index into.
 * If Home ever grew a `data-tab-index`, `useHeaderTabs()` (which does not
 * include Home) would disagree with the strip about which control "digit 1"
 * names, and the Alt+1 chord would silently point at the wrong control.
 *
 * This file locks the control's own contract in isolation - role, selection,
 * activation, the plain accessible name, and the precise absence of the
 * dnd/index attributes `TabItem` sets on its own DOM node. Assertions use plain DOM
 * reads (`getAttribute` / `hasAttribute`) rather than `jest-dom` matchers:
 * this suite has no global `jest-dom` setup, and no other test under
 * `tabs/__tests__/` imports it per-file either.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabStripHomeItem } from "@/components/layout/tabs/tab-strip-home-item";
import { headerTabClassName } from "@/components/layout/tabs/tab-chrome-tokens";

afterEach(() => {
  cleanup();
});

function renderHomeItem(isActive: boolean, onActivate: () => void): void {
  render(
    <TooltipProvider>
      <TabStripHomeItem isActive={isActive} onActivate={onActivate} />
    </TooltipProvider>,
  );
}

describe("<TabStripHomeItem />", () => {
  it("renders as a tab with the plain Home label", () => {
    renderHomeItem(false, vi.fn());

    const tab = screen.getByTestId("tab-home");
    expect(tab.getAttribute("role")).toBe("tab");
    expect(tab.getAttribute("aria-label")).toBe("Home");
  });

  it("follows the isActive prop through aria-selected", () => {
    const { unmount } = render(
      <TooltipProvider>
        <TabStripHomeItem isActive onActivate={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("tab-home").getAttribute("aria-selected")).toBe(
      "true",
    );
    unmount();

    render(
      <TooltipProvider>
        <TabStripHomeItem isActive={false} onActivate={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("tab-home").getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("fires onActivate when clicked", () => {
    const onActivate = vi.fn();
    renderHomeItem(false, onActivate);

    fireEvent.click(screen.getByTestId("tab-home"));

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("carries no data-tab-index - the digit slot TabItem sets and Home must not", () => {
    renderHomeItem(true, vi.fn());

    expect(screen.getByTestId("tab-home").hasAttribute("data-tab-index")).toBe(
      false,
    );
  });

  it("is not a dnd draggable/droppable node like an ordinary TabItem", () => {
    renderHomeItem(false, vi.fn());

    const tab = screen.getByTestId("tab-home");
    // `TabItem`'s own control node (`tab-strip-item.tsx`) sets
    // `data-tab-index` for every real strip tab, and its `HeaderTabMotionFrame`
    // wrapper (mounted around every real tab via `includeMotionFrame`) sets
    // `data-strip-item-id` / `data-strip-item-mergeable` for the reorder
    // model. Home renders neither: it is not wrapped in a motion frame and
    // never registers with `useDraggable`/`useDroppable`, so none of these
    // three should be present. No HTML5 `draggable` attribute either - the
    // strip's dnd-kit source uses pointer sensors, so absence of a literal
    // `draggable` attribute is not itself distinguishing (TabItem doesn't set
    // one either), but it is still asserted here as a direct contract check.
    expect(tab.hasAttribute("draggable")).toBe(false);
    expect(tab.hasAttribute("data-tab-index")).toBe(false);
    expect(tab.hasAttribute("data-strip-item-id")).toBe(false);
    expect(tab.hasAttribute("data-strip-item-mergeable")).toBe(false);
  });

  // The bubble used to be its own `h-10 w-11` box beside `h-9 … px-6` task
  // tabs, so it read narrower and taller than its neighbours. It now stands in
  // the same box, derived from the same token, and differs only in the width
  // rule: a task tab fills its frame, an icon-only item sizes to its padding.
  it("shares the task tabs' height and horizontal padding, and only the width rule differs", () => {
    renderHomeItem(false, vi.fn());

    const home = screen.getByTestId("tab-home").className.split(/\s+/);
    const epicTab = headerTabClassName("own", false).split(/\s+/);
    const sizing = epicTab.filter(
      (token) => token.startsWith("h-") || token.startsWith("px-"),
    );
    // The padding is a responsive variable so Shrink can compress it, with
    // the former px-6 (1.5rem) kept as the explicit fallback.
    expect(sizing).toEqual(["h-9", "px-[var(--header-tab-padding,1.5rem)]"]);
    for (const token of sizing) expect(home).toContain(token);
    expect(home).toContain("w-auto");
    expect(home).not.toContain("w-full");
    expect(home).not.toContain("h-10");
    expect(home).not.toContain("w-11");
  });

  it("keeps [-webkit-app-region:no-drag] so the window drag region skips the control", () => {
    renderHomeItem(false, vi.fn());

    expect(screen.getByTestId("tab-home").className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  // The header bell is the one attention counter; Home carries no count of
  // its own, so its accessible name never grows a suffix and there is no
  // badge node inside the tab's silhouette.
  it("carries no badge and no count in its accessible name", () => {
    renderHomeItem(false, vi.fn());

    expect(screen.queryByTestId("tab-home-badge")).toBeNull();
    expect(screen.getByTestId("tab-home").getAttribute("aria-label")).toBe(
      "Home",
    );
  });
});
