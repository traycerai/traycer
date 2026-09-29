import { describe, expect, it } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  approvalNeedsIndividualDecision,
  bulkApprovableApprovals,
} from "@/components/epic-canvas/renderers/chat-approval-visibility";

function approval(overrides: Partial<ChatApprovalState>): ChatApprovalState {
  return chatApprovalStateSchema.parse({
    approvalId: "a",
    toolName: "bash",
    description: "d",
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

describe("approvalNeedsIndividualDecision", () => {
  it("is true only for cautious: true", () => {
    expect(approvalNeedsIndividualDecision(approval({ cautious: true }))).toBe(
      true,
    );
    expect(approvalNeedsIndividualDecision(approval({ cautious: false }))).toBe(
      false,
    );
    expect(approvalNeedsIndividualDecision(approval({}))).toBe(false);
  });
});

describe("bulkApprovableApprovals", () => {
  it("drops cautious rows, judging rows and plan rows, keeping order", () => {
    const plain = approval({ approvalId: "plain" });
    const cautious = approval({ approvalId: "cautious", cautious: true });
    const judging = approval({ approvalId: "judging", reviewing: "checking" });
    const plan = approval({ approvalId: "plan", kind: "plan", planId: "p1" });
    const plain2 = approval({ approvalId: "plain2" });
    expect(
      bulkApprovableApprovals([plain, cautious, judging, plan, plain2]),
    ).toEqual([plain, plain2]);
  });

  it("is every answerable row when none is cautious (an older host)", () => {
    const rows = [approval({ approvalId: "x" }), approval({ approvalId: "y" })];
    expect(bulkApprovableApprovals(rows)).toEqual(rows);
  });

  it("is empty when every answerable row is cautious", () => {
    expect(bulkApprovableApprovals([approval({ cautious: true })])).toEqual([]);
  });
});
