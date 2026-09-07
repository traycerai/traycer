import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";

export function visibleComposerApprovals(
  approvals: ReadonlyArray<ChatApprovalState>,
): ReadonlyArray<ChatApprovalState> {
  return approvals.filter((approval) => approval.kind !== "plan");
}

// They must therefore NOT gate composer submit either - otherwise a plan-only approval becomes an invisible send block.
export function composerHasBlockingApprovals(
  pendingApprovals: ReadonlyArray<ChatApprovalState>,
  pendingFileEditApprovalCount: number,
): boolean {
  return (
    pendingFileEditApprovalCount +
      visibleComposerApprovals(pendingApprovals).length >
    0
  );
}
