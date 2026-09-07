/** jsdom has no layout engine, so `document.elementFromPoint` cannot be used here to prove a real pointer
 * hit-test the way a live browser can. */
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
    // A CSS Grid item respects z-index without needing `position` declared.
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
