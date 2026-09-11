import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import { JUDGE_UNAVAILABLE_HUMAN_LINE } from "@/components/chat/segments/approval-card-disclosure";

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

describe("<ComposerSlotApprovalQueue /> judge-unavailable human line", () => {
  it("renders the machine string verbatim plus the human line for an unavailability reason", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "auto: judge unavailable (traycer: not signed in)",
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(
      within(row).getByText("auto: judge unavailable (traycer: not signed in)"),
    ).toBeTruthy();
    expect(
      within(row).getByTestId("approval-judge-unavailable-line").textContent,
    ).toBe(JUDGE_UNAVAILABLE_HUMAN_LINE);
  });

  it("renders no unavailable line for the judge's ordinary reasoning prose", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reason: {
              rule: "Force push",
              text: "This rewrites remote history.",
            },
          }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(
      within(row).queryByTestId("approval-judge-unavailable-line"),
    ).toBeNull();
  });
});
