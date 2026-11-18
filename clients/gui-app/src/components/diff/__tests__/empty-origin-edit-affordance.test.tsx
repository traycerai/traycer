/**
 * `EmptyOriginEditAffordance` is shared across the workspace-file source
 * surface and the single/aggregate Git-diff surfaces. jsdom has no layout
 * engine, so `document.elementFromPoint` cannot be used here to prove a real
 * pointer hit-test the way a live browser can - that gap is exactly why a
 * live E2E round (Playwright `force:true` masking the real bug) missed this
 * once already: the library's own rendered host can win hit-testing over a
 * same-DOM-order sibling with no z-index of its own, even when this control
 * comes later in markup. This suite instead asserts the CSS contract that
 * makes the fix work (an explicit `z-10` on a CSS Grid item, which Grid
 * respects without needing `position` declared) so a future edit that drops
 * the z-index class fails a test instead of only failing in a real browser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  EMPTY_ORIGIN_AFFORDANCE_LABEL,
  EMPTY_ORIGIN_AFFORDANCE_TEST_ID,
  EmptyOriginEditAffordance,
} from "@/components/diff/empty-origin-edit-affordance";

afterEach(() => {
  cleanup();
});

describe("EmptyOriginEditAffordance", () => {
  it("is an explicitly-elevated grid item, not relying on DOM order alone to win hit-testing", () => {
    const { getByTestId } = render(
      <EmptyOriginEditAffordance onActivate={vi.fn()} />,
    );
    const affordance = getByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID);
    // A CSS Grid item respects z-index without needing `position` declared -
    // this class is what guarantees the affordance paints above the
    // library's own rendered host regardless of what stacking context that
    // host establishes internally.
    expect(affordance.className).toContain("z-10");
    expect(affordance.className).toContain("col-start-1");
    expect(affordance.className).toContain("row-start-1");
  });

  it("is accessible: cursor-text, focusable, honest label", () => {
    const { getByTestId } = render(
      <EmptyOriginEditAffordance onActivate={vi.fn()} />,
    );
    const affordance = getByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID);
    expect(affordance.getAttribute("role")).toBe("button");
    expect(affordance.tabIndex).toBe(0);
    expect(affordance.getAttribute("aria-label")).toBe(
      EMPTY_ORIGIN_AFFORDANCE_LABEL,
    );
    expect(affordance.className).toContain("cursor-text");
  });

  it("activates on click, Enter, and Space, and ignores every other key", () => {
    const onActivate = vi.fn();
    const { getByTestId } = render(
      <EmptyOriginEditAffordance onActivate={onActivate} />,
    );
    const affordance = getByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID);

    fireEvent.keyDown(affordance, { key: "Tab" });
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.click(affordance);
    expect(onActivate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(affordance, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(affordance, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(3);
  });
});
