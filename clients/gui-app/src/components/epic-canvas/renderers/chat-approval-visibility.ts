import type {
  ChatApprovalState,
  ChatFileEditApprovalState,
} from "@traycer/protocol/host/agent/gui/subscribe";

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

/**
 * True when the provider stamped this ask as one a person answers on its own
 * (`cautious`, `chat.subscribe@1.18`): Claude's "no one-key approve" or a
 * user's ask rule that forced the prompt.
 *
 * Not the judge's `tier`, which says why Traycer's judge escalated; this
 * exists in every mode, judge or none. An older host never sends it, and then
 * every row is bulk-approvable as before.
 *
 * The file-edit card carries the same stamp on the same line, for an edit a
 * user's ask rule forced to a person, and is read by this same predicate.
 */
export function approvalNeedsIndividualDecision(
  approval: Pick<ChatApprovalState, "cautious">,
): boolean {
  return approval.cautious === true;
}

/**
 * The rows "Approve all" acts on: answerable by a person, and not stamped for
 * an individual decision. "Deny all" still acts on every answerable row -
 * refusing is never the risky direction.
 */
export function bulkApprovableApprovals(
  approvals: ReadonlyArray<ChatApprovalState>,
): ReadonlyArray<ChatApprovalState> {
  return humanActionableApprovals(approvals).filter(
    (approval) => !approvalNeedsIndividualDecision(approval),
  );
}

/**
 * The ids of the rows "Approve all" leaves out on purpose: answerable, and
 * stamped for an individual decision. The header's count and each row's
 * marker both read this, so they cannot disagree - a cautious row still with
 * the judge has no Approve button yet, and is not one "left out" of it.
 */
export function approvalIdsLeftOutOfApproveAll(
  approvals: ReadonlyArray<ChatApprovalState>,
): ReadonlySet<string> {
  return new Set(
    humanActionableApprovals(approvals)
      .filter(approvalNeedsIndividualDecision)
      .map((approval) => approval.approvalId),
  );
}

/**
 * The file-edit rows "Approve all" acts on: every row not stamped for an
 * individual decision. No judge ever holds a file-edit card, so every row is
 * answerable; "Deny all" still acts on all of them.
 */
export function bulkApprovableFileEditApprovals(
  approvals: ReadonlyArray<ChatFileEditApprovalState>,
): ReadonlyArray<ChatFileEditApprovalState> {
  return approvals.filter(
    (approval) => !approvalNeedsIndividualDecision(approval),
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
