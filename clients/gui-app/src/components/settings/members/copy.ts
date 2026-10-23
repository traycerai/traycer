import type {
  MembersListMember,
  RemovePreviewModel,
  SeatDelta,
  TeamRole,
} from "@/components/settings/members/types";

export const MEMBERS_PAGE_TITLE = "Members";

export const MANAGE_SEATS_LABEL = "Manage seats and allowances ↗";

export const LAST_ADMIN_REFUSAL = "Promote another admin first.";

export const INVITE_LABEL = "Invite";

export const REVOKE_LABEL = "Revoke";

export const REMOVE_LABEL = "Remove";

export const YOU_TAG = "you";

export const GAINED_EDITING_TAG = "gained editing";

export const LINKED_CLAUDE_PLAN = "linked a Claude plan";

export const ROLE_LABELS: Readonly<Record<TeamRole, string>> = {
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

export const HOW_TRAYCER_HANDLES_THIS = "How Traycer handles this";

export const ACCEPT_LABEL = "Accept";

export const PENDING_REMOVAL_LABEL = "pending";

export function membersHeaderLine(teamName: string): string {
  return `Who is in ${teamName} and what each person can change. Seats and allowances are on the dashboard.`;
}

export function membersCardTitle(
  teamName: string,
  peopleCount: number,
): string {
  const noun = peopleCount === 1 ? "person" : "people";
  return `${teamName} · ${String(peopleCount)} ${noun}`;
}

export function planRequiredRefusal(teamName: string): string {
  return `${teamName} has no plan. Add one on the dashboard.`;
}

export function addPlanOnDashboardLabel(): string {
  return "Add one on the dashboard.";
}

export function lastAdminStepDownDetail(): string {
  return `to step down, ${LAST_ADMIN_REFUSAL.toLowerCase()}`;
}

export function pendingInviteHiddenAddress(count: number): string {
  return `Invited · ${String(count)} pending`;
}

export function pendingInviteTitle(): string {
  return "Invited";
}

export function gainedEditingSentence(names: readonly string[]): string {
  if (names.length === 0) return "Nobody gained editing.";
  if (names.length === 1) {
    return `One person gained editing: ${names[0]}.`;
  }
  return `${String(names.length)} people gained editing: ${joinNames(names)}.`;
}

export function legacyRoleNotice(
  teamName: string,
  names: readonly string[],
): string {
  return `With this update every existing member can edit ${teamName}'s settings. ${gainedEditingSentence(names)} Set a role beside each name; this notice goes away once you have seen it.`;
}

export function roleGrantPrefix(role: TeamRole, teamName: string): string {
  const editor = `You can change ${teamName}'s settings; every change reaches every ${teamName} sandbox.`;
  switch (role) {
    case "viewer":
      return "Read-only environment settings.";
    case "editor":
      return editor;
    case "admin":
      return `${editor} You can invite and remove people and change roles.`;
  }
}

export function roleGrantCommon(teamName: string): string {
  return `Full use and management of ${teamName}'s sandboxes and connected services. Uses your ${teamName} credits. Every member can interrupt or permanently delete any ${teamName} sandbox, including ones you created. Your name and email are visible to ${teamName}'s members. Your actions are attributed to you in status, history and notifications that the reader is authorized to see.`;
}

export function roleGrantText(role: TeamRole, teamName: string): string {
  return `${roleGrantPrefix(role, teamName)} ${roleGrantCommon(teamName)}`;
}

export function invitePendingSeatsSentence(teamName: string): string {
  return `Pending invitations count toward ${teamName}'s paid seats as soon as they are sent, before acceptance.`;
}

export function inviteSeatDeltaSentence(
  teamName: string,
  seatDelta: SeatDelta,
): string {
  return `${teamName} will use ${String(seatDelta.used)} of ${String(seatDelta.total)} seats`;
}

/**
 * Invite-dialog seat copy. `seatDelta` null means a free or pending plan:
 * nothing about seats is shown.
 */
export function inviteSeatCopy(
  teamName: string,
  seatDelta: SeatDelta | null,
): string | null {
  if (seatDelta === null) return null;
  return `${invitePendingSeatsSentence(teamName)} ${inviteSeatDeltaSentence(teamName, seatDelta)}.`;
}

export function acceptSeatAlreadyCounts(teamName: string): string {
  return `Your seat already counts toward ${teamName}'s seats; accepting does not add another.`;
}

export function acceptSeatAllowanceSentence(): string {
  return "Available Traycer credits and your assigned allowance determine what you can spend.";
}

export function acceptSeatCopy(teamName: string, paidPlan: boolean): string {
  if (paidPlan) {
    return `${acceptSeatAlreadyCounts(teamName)} ${acceptSeatAllowanceSentence()}`;
  }
  return acceptSeatAllowanceSentence();
}

export function memberDisplayName(member: MembersListMember): string {
  if (member.inviteState === "pending") {
    return pendingInviteTitle();
  }
  return member.displayName ?? member.email ?? member.userId;
}

export function memberDetailLine(
  member: MembersListMember,
  options: {
    readonly isSelf: boolean;
    readonly isLastAdmin: boolean;
    readonly viewerIsAdmin: boolean;
  },
): string {
  if (member.inviteState === "pending") {
    if (options.viewerIsAdmin && member.invitedAddress !== null) {
      return member.invitedAddress;
    }
    return pendingInviteHiddenAddress(1);
  }
  const parts: string[] = [];
  if (options.isSelf) {
    parts.push("you");
    if (options.isLastAdmin) parts.push(lastAdminStepDownDetail());
  } else if (member.email !== null) {
    parts.push(member.email);
  }
  if (member.linkedPlan) parts.push(LINKED_CLAUDE_PLAN);
  return parts.join(" · ");
}

function isAcceptedMember(member: MembersListMember): boolean {
  return member.inviteState !== "pending";
}

export function isLastAdminMember(
  members: readonly MembersListMember[],
  userId: string,
): boolean {
  const admins = members.filter(
    (member) => isAcceptedMember(member) && member.effectiveRole === "admin",
  );
  return admins.length === 1 && admins[0]?.userId === userId;
}

export function acceptedPeopleCount(
  members: readonly MembersListMember[],
): number {
  return members.filter(isAcceptedMember).length;
}

export function demotionWhatKeepsWorking(): string {
  return "Sandboxes keep running.";
}

export function removePreviewTitle(
  memberName: string,
  teamName: string,
): string {
  return `Remove ${memberName} from ${teamName}`;
}

export function removePreviewLead(
  memberName: string,
  teamName: string,
): string {
  return `${memberName} loses ${teamName}'s settings, hosts and connected services. Here is what that interrupts for everyone else.`;
}

export function removeActivityLine(preview: RemovePreviewModel): string | null {
  if (preview.activeTurns === null || preview.terminals === null) {
    return null;
  }
  if (preview.hostName === null) return null;
  return `${countNoun(preview.activeTurns, "turn")} and ${countNoun(preview.terminals, "terminal")} on ${preview.hostName}`;
}

export function removeTimingRule(memberName: string): string {
  return `${memberName}'s access is revoked now; each finishes its current step and starts no new one. If a host does not answer in time, stopping shows as pending until it does.`;
}

export function removeSharedSignInConsequence(teamName: string): string {
  return `${teamName}'s sandboxes get a replacement sign-in for the team's connected services; it is complete when each host and the provider confirm. Other members' agents there pause while it lands.`;
}

export function removePaidSandboxesConsequence(
  memberName: string,
  teamName: string,
  sandboxes: RemovePreviewModel["paidSandboxes"],
): string {
  if (sandboxes.length === 0) {
    return `${memberName} pays for no ${teamName} sandboxes.`;
  }
  const names = sandboxes.map((sandbox) => sandbox.name).join(", ");
  return `${names} pauses for everyone when ${memberName} leaves. Another member resumes it with their own ${teamName} credits; nothing transfers silently.`;
}

export function removeLinkedPlanConsequence(linkedPlan: string | null): string {
  if (linkedPlan === null) {
    return "None. An admin's linked plan unlinks on removal; agents on it finish their current step and stop.";
  }
  return linkedPlan;
}

export function removeCannotRecall(
  memberName: string,
  teamName: string,
): string {
  return `Files ${memberName} already copied off a host and work already done upstream with ${teamName}'s services. ${memberName}'s name stays on what ${memberName} started as Sandboxes labels a former member.`;
}

export function removePendingUntilDone(
  memberName: string,
  teamName: string,
): string {
  return `Removal shows as pending until every ${teamName} host has confirmed it, then as done; a sandbox action ${memberName} queued is rechecked when it runs. ${memberName} is told once: "You are no longer a member of ${teamName}."`;
}

export function removeConfirmLabel(memberName: string): string {
  return `Remove ${memberName}`;
}

export function demotionLossLine(memberName: string): string {
  return `${memberName} can no longer invite, change roles or edit the approval policy.`;
}

export function demotionTitle(memberName: string, teamName: string): string {
  return `Change ${memberName}'s role in ${teamName}`;
}

export function planUnlinkTitle(planLabel: string, teamName: string): string {
  return `Unlink ${planLabel} from ${teamName}`;
}

export function planUnlinkLead(teamName: string): string {
  return `${teamName}'s agents stop using this plan. Nothing about a sandbox changes: sandbox charges use ${teamName} credits, not the plan.`;
}

export function planUnlinkTurnsLineFor(
  teamName: string,
  turnsOnPlan: number,
): string {
  return `${countNoun(turnsOnPlan, "turn")} on Claude Code. Each finishes its current step, then stops with "${teamName}'s Claude plan was unlinked. An admin can link one."`;
}

export function planUnlinkAfterwards(teamName: string): string {
  return `A member who sends to Claude Code on a ${teamName} host gets the unlink sentence, with a link to Providers. A host that does not answer in time shows the unlink as pending until it confirms.`;
}

export function planUnlinkWhoPays(): string {
  return "Nobody changes: no sandbox's payer transfers on an unlink or a demotion.";
}

export function removeWorkNowLabel(memberName: string): string {
  return `${memberName}'s work now`;
}

export const SHARED_SIGN_INS_LABEL = "Shared sign-ins";

export function paidSandboxesLabel(memberName: string): string {
  return `Sandboxes ${memberName} pays for`;
}

export const LINKED_PLAN_LABEL = "Linked plan";

export const CANNOT_RECALL_LABEL = "Can't be recalled";

export const AGENTS_ON_PLAN_LABEL = "Agents on it now";

export const WHAT_KEEPS_WORKING_LABEL = "What keeps working";

export const AFTERWARDS_LABEL = "Afterwards";

export const WHO_PAYS_LABEL = "Who pays";

export function revokeInviteTitle(): string {
  return "Revoke this invitation";
}

export function revokeInviteLead(address: string, teamName: string): string {
  return `${address} will not join ${teamName}. The pending seat is released.`;
}

export function seatLimitRefusal(teamName: string): string {
  return `${teamName} has no remaining seats. Manage seats and allowances on the dashboard.`;
}

export function inviteForbiddenRefusal(): string {
  return "An admin invites people.";
}

export function inviteDialogLead(teamName: string): string {
  return `Invite someone to ${teamName}.`;
}

export function inviteEmailLabel(): string {
  return "Email";
}

export function inviteRoleLabel(): string {
  return "Role";
}

export function inviteSentLabel(): string {
  return "Invitation sent";
}

export const DONE_LABEL = "Done";

export const CANCEL_LABEL = "Cancel";

export const CHANGE_ROLE_LABEL = "Change role";

export function memberRoleAriaLabel(name: string): string {
  return `Role for ${name}`;
}

export function secretRemovedOutcomeWord(
  outcome: "revoked" | "cleanup_requested" | "destroyed",
): string {
  switch (outcome) {
    case "revoked":
      return "Access revoked";
    case "cleanup_requested":
      return "Cleanup requested";
    case "destroyed":
      return "Destroyed";
  }
}

export function teamHostReturnedBody(
  hostName: string,
  teamName: string,
): string {
  return `${hostName} went back to your own settings from ${teamName}.`;
}

export function moveStalledBody(
  hostName: string,
  remaining: number,
  reason: string,
): string {
  return `${hostName} has not finished moving. ${String(remaining)} remaining. ${reason}`;
}

export function applyFailedBody(
  hostName: string,
  itemKey: string,
  reason: string,
): string {
  return `${itemKey} was not applied on ${hostName}. ${reason}`;
}

export function openHostOverviewLabel(): string {
  return "Open Overview";
}

function countNoun(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${String(count)} ${noun}s`;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const head = names.slice(0, -1).join(", ");
  return `${head} and ${names[names.length - 1]}`;
}
