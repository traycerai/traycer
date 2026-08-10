import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageWindowPicker } from "@/components/usage-analytics/usage-window-picker";

afterEach(cleanup);

describe("UsageWindowPicker", () => {
  it("calls onChange with the selected window length", async () => {
    // Radix's `TabsTrigger` selects on `onMouseDown`, not `onClick` - a bare
    // `fireEvent.click()` never fires it. `userEvent` synthesizes the full
    // pointer sequence (mousedown included), matching real interaction.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UsageWindowPicker windowDays={7} onChange={onChange} />);
    await user.click(screen.getByTestId("usage-window-30"));
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it("marks the current window as the active tab", () => {
    render(<UsageWindowPicker windowDays={90} onChange={() => undefined} />);
    expect(
      screen.getByTestId("usage-window-90").getAttribute("data-state"),
    ).toBe("active");
    expect(
      screen.getByTestId("usage-window-7").getAttribute("data-state"),
    ).toBe("inactive");
  });
});
