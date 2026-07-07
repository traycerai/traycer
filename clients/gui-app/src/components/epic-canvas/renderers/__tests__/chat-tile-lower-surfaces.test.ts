import { describe, expect, it } from "vitest";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  composerHasBlockingApprovals,
  visibleComposerApprovals,
} from "@/components/epic-canvas/renderers/chat-approval-visibility";

describe("visibleComposerApprovals", () => {
  it("suppresses only plan approvals from the generic composer queue", () => {
    const toolApproval = approval("tool-approval", "tool");
    const planApproval = approval("plan-approval", "plan");

    expect(visibleComposerApprovals([toolApproval, planApproval])).toEqual([
      toolApproval,
    ]);
  });
});

describe("composerHasBlockingApprovals", () => {
  it("does not block composer submit for a plan-only pending approval", () => {
    // Plan approvals are resolved via the plan card, so they must not become an
    // invisible composer send gate.
    expect(
      composerHasBlockingApprovals([approval("plan-approval", "plan")], 0),
    ).toBe(false);
  });

  it("blocks composer submit for a non-plan tool approval", () => {
    expect(
      composerHasBlockingApprovals([approval("tool-approval", "tool")], 0),
    ).toBe(true);
  });

  it("blocks composer submit for a pending file-edit approval alongside a plan approval", () => {
    expect(
      composerHasBlockingApprovals([approval("plan-approval", "plan")], 1),
    ).toBe(true);
  });
});

function approval(
  approvalId: string,
  kind: ChatApprovalState["kind"],
): ChatApprovalState {
  return {
    approvalId,
    toolName: "tool",
    description: "approval",
    input: null,
    requestedAt: 1,
    kind,
    planId: kind === "plan" ? "plan-1" : null,
    actions: [],
    suggestedRules: [],
    commandPreview: null,
  };
}
