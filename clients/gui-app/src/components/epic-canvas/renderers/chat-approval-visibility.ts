import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";

export function visibleComposerApprovals(
  approvals: ReadonlyArray<ChatApprovalState>,
): ReadonlyArray<ChatApprovalState> {
  return approvals.filter((approval) => approval.kind !== "plan");
}

/**
 * True while a host-side judge is still deciding this call (`auto` mode).
 *
 * The row is VISIBLE in that state - a tool that has gone quiet for a minute
 * with nothing on screen is indistinguishable from a hung one - but it is not a
 * question anyone can answer: the card carries no buttons while a judge runs
 * (plan decision 19).
 *
 * Nothing about this row clears ITSELF. It rides the subscribe frame, and it
 * goes when the host sends a frame that removes it: an escalation replaces it
 * by id with the real card, and every other exit - the allow, a Stop during
 * stage 2, a failed journal write, the agents-only denial - is retired by a
 * resolution frame the seam emits on purpose. The earlier reading of this
 * comment, that an allowed call disposed of its own row, described a frame
 * that was not being sent, and every allowed command left a permanent
 * "Checking…" row behind.
 */
export function approvalAwaitingJudge(approval: ChatApprovalState): boolean {
  return approval.reviewing !== null;
}

/**
 * The approvals a human can actually answer: visible in the composer queue AND
 * not currently under a judge.
 *
 * This is the set the bulk actions act on and the count they report. A judging
 * row must never be resolvable by "Approve all" - the decision belongs to the
 * judge until it escalates.
 */
export function humanActionableApprovals(
  approvals: ReadonlyArray<ChatApprovalState>,
): ReadonlyArray<ChatApprovalState> {
  return visibleComposerApprovals(approvals).filter(
    (approval) => !approvalAwaitingJudge(approval),
  );
}

// Plan approvals are owned by the inline plan card (its Implement/Reject
// actions) and are hidden from the generic composer approval queue. They must
// therefore NOT gate composer submit either - otherwise a plan-only approval
// becomes an invisible send block. File-edit approvals and non-plan tool
// approvals still block submit and remain visible in the composer surface.
//
// An approval under a JUDGE does not block either, and for the same reason
// read from the other end: this predicate says "the user must resolve
// something before sending", and the copy built on it says so literally
// ("Resolve the pending approval before sending."). While a judge is deciding
// there is nothing to resolve - the card offers no buttons - so blocking here
// would be a send lock with no way out for as long as the judge runs, up to
// the stage-2 cap. The row stays visible (`visibleComposerApprovals` still
// counts it, which is what shows the surface); only the gate ignores it.
export function composerHasBlockingApprovals(
  pendingApprovals: ReadonlyArray<ChatApprovalState>,
  pendingFileEditApprovalCount: number,
): boolean {
  return (
    pendingFileEditApprovalCount +
      humanActionableApprovals(pendingApprovals).length >
    0
  );
}
