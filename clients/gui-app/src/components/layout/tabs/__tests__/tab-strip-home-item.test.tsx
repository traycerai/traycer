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
 * activation, badge formatting, and the precise absence of the dnd/index
 * attributes `TabItem` sets on its own DOM node. Assertions use plain DOM
 * reads (`getAttribute` / `hasAttribute`) rather than `jest-dom` matchers:
 * this suite has no global `jest-dom` setup, and no other test under
 * `tabs/__tests__/` imports it per-file either.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabStripHomeItem } from "@/components/layout/tabs/tab-strip-home-item";

afterEach(() => {
  cleanup();
});

function renderHomeItem(
  isActive: boolean,
  onActivate: () => void,
  badgeCount: number,
): void {
  render(
    <TooltipProvider>
      <TabStripHomeItem
        isActive={isActive}
        onActivate={onActivate}
        badgeCount={badgeCount}
      />
    </TooltipProvider>,
  );
}

describe("<TabStripHomeItem />", () => {
  it("renders as a tab with the plain Home label at rest", () => {
    renderHomeItem(false, vi.fn(), 0);

    const tab = screen.getByTestId("tab-home");
    expect(tab.getAttribute("role")).toBe("tab");
    expect(tab.getAttribute("aria-label")).toBe("Home");
  });

  it("follows the isActive prop through aria-selected", () => {
    const { unmount } = render(
      <TooltipProvider>
        <TabStripHomeItem isActive onActivate={vi.fn()} badgeCount={0} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("tab-home").getAttribute("aria-selected")).toBe(
      "true",
    );
    unmount();

    render(
      <TooltipProvider>
        <TabStripHomeItem
          isActive={false}
          onActivate={vi.fn()}
          badgeCount={0}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("tab-home").getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("fires onActivate when clicked", () => {
    const onActivate = vi.fn();
    renderHomeItem(false, onActivate, 0);

    fireEvent.click(screen.getByTestId("tab-home"));

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("carries no data-tab-index - the digit slot TabItem sets and Home must not", () => {
    renderHomeItem(true, vi.fn(), 0);

    expect(screen.getByTestId("tab-home").hasAttribute("data-tab-index")).toBe(
      false,
    );
  });

  it("is not a dnd draggable/droppable node like an ordinary TabItem", () => {
    renderHomeItem(false, vi.fn(), 0);

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

  it("keeps [-webkit-app-region:no-drag] so the window drag region skips the control", () => {
    renderHomeItem(false, vi.fn(), 0);

    expect(screen.getByTestId("tab-home").className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  it("hides the badge at zero - a permanent '0' would be decoration, not signal", () => {
    renderHomeItem(false, vi.fn(), 0);

    expect(screen.queryByTestId("tab-home-badge")).toBeNull();
    expect(screen.getByTestId("tab-home").getAttribute("aria-label")).toBe(
      "Home",
    );
  });

  it("shows the exact count under the 99 threshold", () => {
    renderHomeItem(false, vi.fn(), 3);

    const badge = screen.getByTestId("tab-home-badge");
    expect(badge.textContent).toBe("3");
    expect(badge.hasAttribute("aria-hidden")).toBe(true);
    expect(screen.getByTestId("tab-home").getAttribute("aria-label")).toBe(
      "Home, 3 waiting on you",
    );
  });

  // The threshold itself, from both sides. `badgeLabel` clamps on `>`, so 99
  // is the last exact count and 100 the first clamped one - an off-by-one
  // there would either print a four-character badge or lose a real 99.
  it("prints the threshold count exactly", () => {
    renderHomeItem(false, vi.fn(), 99);

    expect(screen.getByTestId("tab-home-badge").textContent).toBe("99");
    expect(screen.getByTestId("tab-home").getAttribute("aria-label")).toBe(
      "Home, 99 waiting on you",
    );
  });

  it("clamps the first count past the threshold", () => {
    renderHomeItem(false, vi.fn(), 100);

    expect(screen.getByTestId("tab-home-badge").textContent).toBe("99+");
    expect(screen.getByTestId("tab-home").getAttribute("aria-label")).toBe(
      "Home, 99+ waiting on you",
    );
  });

  it("clamps to 99+ once the count passes the threshold", () => {
    renderHomeItem(false, vi.fn(), 150);

    const badge = screen.getByTestId("tab-home-badge");
    expect(badge.textContent).toBe("99+");
    expect(screen.getByTestId("tab-home").getAttribute("aria-label")).toBe(
      "Home, 99+ waiting on you",
    );
  });
});
