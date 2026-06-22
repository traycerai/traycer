import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentModeReadonlyLabel,
  AgentModeToggle,
} from "@/components/home/pickers/agent-mode-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("<AgentModeToggle />", () => {
  afterEach(() => {
    cleanup();
  });

  it("switches from epic to regular on click", () => {
    const onChange = vi.fn();

    render(
      <TooltipProvider>
        <AgentModeToggle value="epic" disabled={false} onChange={onChange} />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Regular Mode" }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("regular");
  });

  it("switches from regular to epic on click", () => {
    const onChange = vi.fn();

    render(
      <TooltipProvider>
        <AgentModeToggle value="regular" disabled={false} onChange={onChange} />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Epic Mode" }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("epic");
  });

  it("renders the read-only label without hover affordances", () => {
    render(<AgentModeReadonlyLabel value="regular" />);

    const label = screen.getByText("Regular Mode").parentElement;
    if (label === null) throw new Error("expected read-only mode label");
    expect(label.className).toContain("opacity-70");
    expect(label.className).not.toContain("hover:");
    expect(label.className).not.toContain("transition-colors");
  });
});
