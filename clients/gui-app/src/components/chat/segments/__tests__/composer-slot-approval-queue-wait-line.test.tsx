import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import { APPROVAL_PAUSED_LINE } from "@/components/chat/segments/approval-card-disclosure";

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

describe("<ComposerSlotApprovalQueue /> attended wait line", () => {
  it("shows the wait line on an answerable row whose requestedAt is old enough", () => {
    const requestedAt = Date.now() - 12 * 60_000;
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: null, requestedAt })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
      />,
    );

    const row = screen.getByTestId("approval-row");
    const waitLine = within(row).getByTestId("approval-wait-line");
    expect(waitLine.textContent).toContain(APPROVAL_PAUSED_LINE);
  });

  it("shows no wait line for a fresh answerable row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: null, requestedAt: Date.now() })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(within(row).queryByTestId("approval-wait-line")).toBeNull();
  });

  it("never shows the wait line on a reviewing row, however old", () => {
    const requestedAt = Date.now() - 60 * 60_000;
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: "reviewing", requestedAt })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(within(row).queryByTestId("approval-wait-line")).toBeNull();
  });
});
