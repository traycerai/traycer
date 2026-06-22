import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";

export function visibleComposerApprovals(
  approvals: ReadonlyArray<ChatApprovalState>,
): ReadonlyArray<ChatApprovalState> {
  return approvals.filter((approval) => approval.kind !== "plan");
}

// Plan approvals are owned by the inline plan card (its Implement/Reject
// actions) and are hidden from the generic composer approval queue. They must
// therefore NOT gate composer submit either - otherwise a plan-only approval
// becomes an invisible send block. File-edit approvals and non-plan tool
// approvals still block submit and remain visible in the composer surface.
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
