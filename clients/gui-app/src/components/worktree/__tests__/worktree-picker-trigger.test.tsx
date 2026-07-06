import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { WorktreePickerTrigger } from "@/components/worktree/worktree-picker-trigger";

describe("WorktreePickerTrigger change-count badge", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the count plus a collapsible ' changed' suffix and announces 'N changed'", () => {
    render(
      <WorktreePickerTrigger
        worktreeLabel="traycer"
        secondaryLabel="/Users/anurag/work/traycer"
        changeCount={3}
        trailingStatus={null}
        testId="trigger"
      />,
    );

    // Screen-reader announcement stays "N changed" regardless of visual collapse.
    const badge = screen.getByLabelText("3 changed");
    expect(badge.textContent).toBe("3 changed");

    // The count is always visible; only the suffix drops under width pressure.
    const suffix = within(badge).getByText("changed", { exact: false });
    expect(suffix.className).toContain("@max-[16rem]:hidden");
    expect(within(badge).getByText("3").className).not.toContain("hidden");
  });

  it("renders no badge when changeCount is null", () => {
    render(
      <WorktreePickerTrigger
        worktreeLabel="traycer"
        secondaryLabel="/Users/anurag/work/traycer"
        changeCount={null}
        trailingStatus={null}
        testId="trigger"
      />,
    );

    expect(screen.queryByText("changed", { exact: false })).toBeNull();
  });
});
