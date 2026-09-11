import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";

afterEach(() => {
  cleanup();
});

function approval(
  overrides: Partial<ChatApprovalState> = {},
): ChatApprovalState {
  return chatApprovalStateSchema.parse({
    approvalId: "approval-1",
    toolName: "bash",
    description: "Run a shell command",
    input: null,
    requestedAt: 1,
    kind: "tool",
    planId: null,
    actions: [],
    reason: null,
    reviewing: null,
    ...overrides,
  });
}

describe("<ComposerSlotApprovalQueue /> chrome", () => {
  it("is quiet when every row is still with the judge", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "a", reviewing: "checking" }),
          approval({ approvalId: "b", reviewing: "reviewing" }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    const container = screen.getByTestId("approval-prompt");
    expect(container.getAttribute("data-chrome")).toBe("quiet");
    expect(container.className).not.toContain("bg-primary/5");
  });

  it("is alert the moment any row is answerable", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ approvalId: "a", reviewing: null })]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    const container = screen.getByTestId("approval-prompt");
    expect(container.getAttribute("data-chrome")).toBe("alert");
    expect(container.className).toContain("bg-primary/5");
  });

  it("is alert for a mixed queue - one reviewing row plus one answerable row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "reviewing-1", reviewing: "checking" }),
          approval({ approvalId: "actionable-1", reviewing: null }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    const container = screen.getByTestId("approval-prompt");
    expect(container.getAttribute("data-chrome")).toBe("alert");
    expect(container.className).toContain("bg-primary/5");
  });
});
