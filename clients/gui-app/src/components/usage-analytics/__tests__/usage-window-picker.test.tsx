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
    await user.click(screen.getByRole("tab", { name: "30 days" }));
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it("marks the current window as the active tab", () => {
    render(<UsageWindowPicker windowDays={90} onChange={() => undefined} />);
    expect(
      screen.getByRole("tab", { name: "90 days" }).getAttribute("data-state"),
    ).toBe("active");
    expect(
      screen.getByRole("tab", { name: "7 days" }).getAttribute("data-state"),
    ).toBe("inactive");
  });

  it("lets the window tabs wrap within a narrow container", () => {
    render(<UsageWindowPicker windowDays={7} onChange={() => undefined} />);
    expect(screen.getByRole("tablist").className).toContain("max-w-full");
    expect(screen.getByRole("tablist").className).toContain("flex-wrap");
  });
});
