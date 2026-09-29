import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageWindowPicker } from "@/components/usage-analytics/usage-window-picker";

afterEach(cleanup);

describe("UsageWindowPicker", () => {
  it("calls onChange with the selected window length", async () => {
    // Tab selection also reacts to pointerdown, not just click - a bare
    // `fireEvent.click()` skips it. `userEvent` synthesizes the full
    // pointer sequence, matching real interaction.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <UsageWindowPicker
        windowDays={7}
        onChange={onChange}
        triggerClassName={undefined}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "30 days" }));
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it("marks the current window as the active tab", () => {
    render(
      <UsageWindowPicker
        windowDays={90}
        onChange={() => undefined}
        triggerClassName={undefined}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "90 days" }).hasAttribute("data-active"),
    ).toBe(true);
    expect(
      screen.getByRole("tab", { name: "7 days" }).hasAttribute("data-active"),
    ).toBe(false);
  });

  it("lets the window tabs wrap within a narrow container", () => {
    render(
      <UsageWindowPicker
        windowDays={7}
        onChange={() => undefined}
        triggerClassName={undefined}
      />,
    );
    expect(screen.getByRole("tablist").className).toContain("max-w-full");
    expect(screen.getByRole("tablist").className).toContain("flex-wrap");
  });
});
