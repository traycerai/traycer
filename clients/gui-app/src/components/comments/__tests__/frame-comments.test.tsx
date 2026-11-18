/**
 * `FrameCommentsToolbar` is now a plain toggle: whether Comments mode is on
 * is the caller's state, and clicking it is the caller's business to act on.
 * The list/popover/pin-handoff behaviour this file used to cover moved to
 * the shared comments sidebar and the mode-model tests around it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameCommentsToolbar } from "@/components/comments/frame-comments";

afterEach(cleanup);

describe("<FrameCommentsToolbar />", () => {
  it("reflects whether Comments mode is active and reports a toggle request", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<FrameCommentsToolbar active={false} onToggle={onToggle} />);

    const button = screen.getByRole("button", { name: "Comments" });
    expect(button.getAttribute("aria-pressed")).toBe("false");

    await user.click(button);

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows the pressed state the caller gives it", () => {
    render(<FrameCommentsToolbar active onToggle={() => undefined} />);

    expect(
      screen
        .getByRole("button", { name: "Comments" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
