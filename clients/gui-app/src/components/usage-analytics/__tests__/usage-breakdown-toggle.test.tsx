import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageBreakdownToggle } from "@/components/usage-analytics/usage-breakdown-toggle";

afterEach(cleanup);

describe("UsageBreakdownToggle", () => {
  it("calls onChange with the selected grouping", async () => {
    // Radix `TabsTrigger` selects on `onMouseDown` - `userEvent` synthesizes
    // the full pointer sequence, matching real interaction.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UsageBreakdownToggle groupBy="model" onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "Day" }));
    expect(onChange).toHaveBeenCalledWith("day");
  });
});
