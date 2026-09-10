import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";

afterEach(() => {
  cleanup();
});

// Parsed through the protocol schema (not a hand-typed object literal) so a
// future required field on `chatApprovalStateSchema` fails this fixture loudly
// instead of silently reading `undefined` in the component under test.
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

describe("<ComposerSlotApprovalQueue />", () => {
  it("shows a checking judge row with no Approve/Deny buttons", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: "checking" })]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(within(row).getByText("Checking…")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("shows a reviewing judge row with no Approve/Deny buttons", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: "reviewing" })]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    const row = screen.getByTestId("approval-row");
    expect(
      within(row).getByText("Judge reviewing the transcript…"),
    ).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("renders Approve/Deny for a non-reviewing row and calls onDecision", () => {
    const onDecision = vi.fn();
    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: null })]}
        canAct
        onDecision={onDecision}
      />,
    );

    const row = screen.getByTestId("approval-row");
    within(row).getByRole("button", { name: "Approve" }).click();
    within(row).getByRole("button", { name: "Deny" }).click();

    expect(onDecision).toHaveBeenNthCalledWith(1, "approval-1", true);
    expect(onDecision).toHaveBeenNthCalledWith(2, "approval-1", false);
  });

  it("renders the judge reason's rule and text on a reviewing row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reviewing: "reviewing",
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
    expect(within(row).getByText("Force push")).toBeTruthy();
    expect(within(row).getByText("This rewrites remote history.")).toBeTruthy();
  });

  it("renders the judge reason's rule and text on an actionable (non-reviewing) row", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({
            reviewing: null,
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
    expect(within(row).getByText("Force push")).toBeTruthy();
    expect(within(row).getByText("This rewrites remote history.")).toBeTruthy();
    // Still actionable: buttons remain even though a reason is shown.
    expect(within(row).getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("counts only actionable rows in the header and 'Approve all' skips the reviewing row", () => {
    const onDecision = vi.fn();
    const reviewing = approval({
      approvalId: "reviewing-1",
      reviewing: "checking",
    });
    const actionableA = approval({
      approvalId: "actionable-a",
      reviewing: null,
    });
    const actionableB = approval({
      approvalId: "actionable-b",
      reviewing: null,
    });

    render(
      <ComposerSlotApprovalQueue
        approvals={[reviewing, actionableA, actionableB]}
        canAct
        onDecision={onDecision}
      />,
    );

    expect(screen.getByText("2 pending")).toBeTruthy();

    screen.getByRole("button", { name: /Approve all/ }).click();

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision).toHaveBeenCalledWith("actionable-a", true);
    expect(onDecision).toHaveBeenCalledWith("actionable-b", true);
    expect(onDecision).not.toHaveBeenCalledWith("reviewing-1", true);
  });

  it("heads the card 'Judge review' while every row is still with the judge", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "reviewing-1", reviewing: "checking" }),
          approval({ approvalId: "reviewing-2", reviewing: "reviewing" }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    // Nothing is needed from the user yet, so the card must not say it is.
    expect(screen.getByText("Judge review")).toBeTruthy();
    expect(screen.queryByText("Approval needed")).toBeNull();
  });

  it("heads the card 'Approval needed' as soon as one row is answerable", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "reviewing-1", reviewing: "checking" }),
          approval({ approvalId: "actionable-a", reviewing: null }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.queryByText("Judge review")).toBeNull();
  });

  it("hides the bulk actions when fewer than two rows are actionable", () => {
    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ approvalId: "reviewing-1", reviewing: "checking" }),
          approval({ approvalId: "actionable-a", reviewing: null }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    expect(screen.queryByText(/pending$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deny all/ })).toBeNull();
  });
});
