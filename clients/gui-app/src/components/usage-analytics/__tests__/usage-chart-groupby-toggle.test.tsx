import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageChartGroupByToggle } from "@/components/usage-analytics/usage-chart-groupby-toggle";

afterEach(cleanup);

describe("UsageChartGroupByToggle", () => {
  it("renders both triggers", () => {
    render(
      <UsageChartGroupByToggle
        groupBy="harness"
        onChange={vi.fn()}
        triggerClassName={undefined}
      />,
    );
    expect(screen.getByRole("tab", { name: "Harness" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Model" })).toBeDefined();
  });

  it("calls onChange with the selected grouping", async () => {
    // Radix `TabsTrigger` selects on `onMouseDown` - `userEvent` synthesizes
    // the full pointer sequence, matching real interaction.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <UsageChartGroupByToggle
        groupBy="harness"
        onChange={onChange}
        triggerClassName={undefined}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Model" }));
    expect(onChange).toHaveBeenCalledWith("model");
  });
});
