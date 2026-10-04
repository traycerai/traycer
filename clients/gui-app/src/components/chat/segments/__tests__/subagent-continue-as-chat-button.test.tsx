import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentContinueAsChatButton } from "@/components/chat/segments/subagent-continue-as-chat-button";
import {
  SubagentContinueAsChatContext,
  type SubagentContinueAsChat,
} from "@/components/chat/segments/subagent-continue-as-chat";

const TEST_ID = "continue-button";

function renderWith(value: SubagentContinueAsChat | null) {
  return render(
    <SubagentContinueAsChatContext.Provider value={value}>
      <SubagentContinueAsChatButton testId={TEST_ID} />
    </SubagentContinueAsChatContext.Provider>,
  );
}

describe("SubagentContinueAsChatButton", () => {
  afterEach(cleanup);

  it("draws nothing without a provider", () => {
    const { container } = render(
      <SubagentContinueAsChatButton testId={TEST_ID} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("draws nothing when the action is not offered", () => {
    const { container } = renderWith(null);
    expect(container.firstChild).toBeNull();
  });

  it("runs the action on click when idle", () => {
    const run = vi.fn();
    renderWith({ run, isPending: false });
    const button = screen.getByRole("button", { name: "Continue as chat" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId(`${TEST_ID}-pending`)).toBeNull();
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is disabled with a spinner while pending and does not run", () => {
    const run = vi.fn();
    renderWith({ run, isPending: true });
    const button = screen.getByRole("button", { name: "Continue as chat" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Continue as chat");
    expect(screen.getByTestId(`${TEST_ID}-pending`)).not.toBeNull();
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
  });
});
