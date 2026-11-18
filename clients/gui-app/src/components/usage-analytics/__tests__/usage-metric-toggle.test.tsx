import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageMetricToggle } from "@/components/usage-analytics/usage-metric-toggle";

afterEach(cleanup);

describe("UsageMetricToggle", () => {
  it("calls onChange with the selected metric", async () => {
    // Radix's `TabsTrigger` selects on `onMouseDown`, not `onClick` - a bare
    // `fireEvent.click()` never fires it. `userEvent` synthesizes the full
    // pointer sequence (mousedown included), matching real interaction.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UsageMetricToggle metric="cost" onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "Tokens" }));
    expect(onChange).toHaveBeenCalledWith("tokens");
  });
});
