import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EpicUsageWindowPicker } from "@/components/usage-analytics/epic-usage-window-picker";

afterEach(cleanup);

describe("EpicUsageWindowPicker", () => {
  it("calls onChange with a numeric window", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EpicUsageWindowPicker value={30} onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "7 days" }));
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it("calls onChange with 'epic' for the entire-epic option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EpicUsageWindowPicker value={30} onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "Entire epic" }));
    expect(onChange).toHaveBeenCalledWith("epic");
  });
});
