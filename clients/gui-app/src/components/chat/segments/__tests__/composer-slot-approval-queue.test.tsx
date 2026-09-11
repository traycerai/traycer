import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";

function approval(approvalId: string): ChatApprovalState {
  return {
    approvalId,
    toolName: "Bash",
    description: "Run a command",
    input: null,
    requestedAt: 1,
    kind: "tool",
    planId: null,
    actions: [],
  };
}

describe("ComposerSlotApprovalQueue navigation highlight", () => {
  it("flashes only the matching pending approval row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval("approval-a"), approval("approval-b")]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId="approval-b"
      />,
    );

    expect(
      screen
        .getByTestId("approval-prompt")
        .querySelector('[data-approval-id="approval-a"]')
        ?.getAttribute("data-navigation-highlighted"),
    ).toBeNull();
    expect(
      screen
        .getByTestId("approval-prompt")
        .querySelector('[data-approval-id="approval-b"]')
        ?.getAttribute("data-navigation-highlighted"),
    ).toBe("true");
  });
});
