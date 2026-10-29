import { withIndefiniteArticle } from "@traycer/protocol/host/notifications/indefinite-article";
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

export const DISMISS_LABEL = "Dismiss";

/** A member row with neither a name nor an email to show. */
export const MEMBER_UNLOADED = "Couldn't load this member";

export const GAINED_EDITING_TAG = "gained editing";

export const LINKED_CLAUDE_PLAN = "linked a Claude plan";

export const ROLE_LABELS: Readonly<Record<TeamRole, string>> = {
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

export const HOW_TRAYCER_HANDLES_THIS = "How Traycer handles this";

export const ACCEPT_LABEL = "Accept";

/** The title over an invitation's grant and Accept. */
export function inviteAcceptTitle(teamName: string): string {
  return `You're invited to ${teamName}`;
}

/** An invitation withdrawn or already answered by the time Accept was pressed. */
export const INVITATION_GONE = "This invitation is no longer open.";

/**
 * A removal that has not committed yet. A committed removal leaves the list,
 * so it has no label.
 */
export const PENDING_REMOVAL_LABEL = "removing";

export const RETRY_LABEL = "Retry";

/** A preview row with nothing to show. */
const NONE = "None.";

export const MEMBERS_NEED_UPDATED_HOST = "These members need an updated host.";

export function membersReadFailed(teamName: string): string {
  return `Couldn't load ${teamName}'s members.`;
}

/** An admin's members read failed, so the one-time notice cannot load. */
export const LEGACY_NOTICE_READ_FAILED =
  "Couldn't load who gained editing with this update.";

export function removePreviewFailed(memberName: string): string {
  return `Couldn't load what removing ${memberName} interrupts, so Remove stays off until it loads.`;
}

export function demotionPreviewFailed(memberName: string): string {
  return `Couldn't load what changing ${memberName}'s role interrupts, so Change role stays off until it loads.`;
}

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
  return `With this update every existing member can edit ${teamName}'s settings. ${gainedEditingSentence(names)} Set a role beside each name.`;
}

export function roleGrantPrefix(role: TeamRole, teamName: string): string {
  const editor = `You can change ${teamName}'s settings; every change reaches every ${teamName} sandbox.`;
  switch (role) {
    case "viewer":
      return `You can see ${teamName}'s settings but not change them.`;
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

/** The line under the invite's Role picker, for the role picked. */
export function inviteRoleLine(role: TeamRole, teamName: string): string {
  switch (role) {
    case "viewer":
      return `Can see ${teamName}'s settings but not change them.`;
    case "editor":
      return `Can change ${teamName}'s settings; every change reaches every ${teamName} sandbox.`;
    case "admin":
      return `Can change ${teamName}'s settings, invite and remove people, and change roles.`;
  }
}

/**
 * What sending one more invitation does to the team's seats, from the seats
 * it holds before the send. The plan's seat count follows its membership
 * rows: past the last seat it grows at once, charged prorated now; with
 * seats to spare the unused ones end with the billing period.
 */
function inviteSeatDeltaSentence(teamName: string, seats: SeatDelta): string {
  const after = seats.used + 1;
  if (after > seats.total) {
    return `${teamName} has no free seat, so sending this adds one: ${teamName} will use ${String(after)} of ${String(after)} seats. The added seat is charged now to ${teamName}'s card on file, prorated for the rest of the current billing period.`;
  }
  if (after === seats.total) {
    return `${teamName} will use ${String(after)} of ${String(seats.total)} seats; nothing is charged now. The next invitation will add a seat.`;
  }
  return `${teamName} will use ${String(after)} of ${String(seats.total)} seats; nothing is charged now. At the end of this billing period, ${teamName} keeps only the seats in use and stops paying for the others.`;
}

/**
 * The invite sheet's seat copy, from the seats the team holds before the
 * send. `seats` null means a free or pending plan: nothing about seats is
 * shown.
 */
export function inviteSeatCopy(
  teamName: string,
  seats: SeatDelta | null,
): string | null {
  if (seats === null) return null;
  return `${invitePendingSeatsSentence(teamName)} ${inviteSeatDeltaSentence(teamName, seats)}`;
}

export function inviteSeatsReadFailed(teamName: string): string {
  return `Couldn't read ${teamName}'s seats.`;
}

export function acceptSeatAlreadyCounts(teamName: string): string {
  return `Your seat already counts toward ${teamName}'s seats; accepting does not add another.`;
}

export function acceptSeatCopy(teamName: string, paidPlan: boolean): string {
  if (paidPlan) return acceptSeatAlreadyCounts(teamName);
  return `An admin sets how much of ${teamName}'s credits you can spend.`;
}

/**
 * What a member is called: their name, else their email, else the invite's
 * placeholder. Never their user id; `null` when there is nothing to show.
 */
function memberName(member: MembersListMember): string | null {
  return member.displayName?.trim() || member.email;
}

/** The name dialogs and labels use for a member. */
export function memberDisplayName(member: MembersListMember): string {
  if (member.inviteState === "pending") {
    return pendingInviteTitle();
  }
  return memberName(member) ?? "this member";
}

/** A button's name for a member: the first word of their name, else as {@link memberDisplayName}. */
export function memberFirstName(member: MembersListMember): string {
  const first = member.displayName?.trim().split(/\s+/)[0] ?? "";
  return first.length > 0 ? first : memberDisplayName(member);
}

/**
 * A row's first line: "<name>", "<email>" with no name, and
 * "<name> · you" on the viewer's own row. `null` when an accepted member has
 * neither a name nor an email.
 */
export function memberRowTitle(
  member: MembersListMember,
  isSelf: boolean,
): string | null {
  if (member.inviteState === "pending") return pendingInviteTitle();
  const name = memberName(member);
  if (isSelf) return name === null ? YOU_TAG : `${name} · ${YOU_TAG}`;
  return name;
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
  if (member.displayName?.trim() && member.email !== null) {
    parts.push(member.email);
  }
  if (options.isSelf) {
    if (options.isLastAdmin) parts.push(lastAdminStepDownDetail());
  }
  if (member.linkedPlan) parts.push(LINKED_CLAUDE_PLAN);
  return parts.join(" · ");
}

/**
 * Whether the notice names this member: authn names each legacy member by
 * name, else by email.
 */
export function memberGainedEditing(
  member: MembersListMember,
  legacyMembers: readonly string[],
): boolean {
  const name = memberName(member);
  return (
    name !== null &&
    legacyMembers.some((legacyName) => legacyName.trim() === name.trim())
  );
}

/** A member still in the team: accepted, and not being removed. */
function isAcceptedMember(member: MembersListMember): boolean {
  return member.inviteState !== "pending" && member.removalState === "none";
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
  memberEmail: string | null,
  teamName: string,
): string {
  const identity =
    memberEmail !== null && memberEmail !== "" && memberEmail !== memberName
      ? `${memberName} (${memberEmail})`
      : memberName;
  return `Remove ${identity} from ${teamName}`;
}

export function removePreviewLead(
  memberName: string,
  teamName: string,
): string {
  return `${memberName} loses ${teamName}'s settings, hosts and connected services. Here is what the removal stops, for ${memberName} and for everyone else.`;
}

/**
 * The member's running turns and terminals with the timing rule. Null counts
 * (the serving host holds no facts for the team) are never shown as a count;
 * both zero is "None.". The host is named only when this window knows it.
 */
export function removeWorkNow(
  memberName: string,
  preview: RemovePreviewModel,
): string {
  if (preview.activeTurns === null || preview.terminals === null) {
    return `${memberName}'s access is revoked now. Anything they have running finishes its current step and starts no new one; Traycer can't list that work from here.`;
  }
  if (preview.activeTurns === 0 && preview.terminals === 0) return NONE;
  const where = preview.hostName === null ? "" : ` on ${preview.hostName}`;
  return `${countNoun(preview.activeTurns, "turn")} and ${countNoun(preview.terminals, "terminal")}${where}. ${memberName}'s access is revoked now; each finishes its current step and starts no new one. If a host does not answer in time, stopping shows as pending until it does.`;
}

export function removeSharedSignInConsequence(
  teamName: string,
  sharedSignIns: readonly string[],
): string {
  if (sharedSignIns.length === 0) return NONE;
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
  if (linkedPlan === null) return NONE;
  return linkedPlan;
}

export function removeCannotRecall(
  memberName: string,
  teamName: string,
): string {
  return `Files ${memberName} already copied off a host and work already done upstream with ${teamName}'s services. What ${memberName} started stays, labelled "started by a former member".`;
}

export const REMOVE_PENDING_UNTIL_COMMITTED =
  "Removal shows as pending until it commits.";

export function removeConfirmLabel(firstName: string): string {
  return `Remove ${firstName}`;
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
  turnsOnPlan: number | null,
): string {
  const stops = `then stops with "${teamName}'s Claude plan was unlinked. An admin can link one."`;
  if (turnsOnPlan === null) {
    return `Unavailable. Each turn on Claude Code finishes its current step, ${stops}`;
  }
  return `${countNoun(turnsOnPlan, "turn")} on Claude Code. Each finishes its current step, ${stops}`;
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

export const SET_ROLE_FORBIDDEN_REFUSAL = "An admin changes roles.";
export const REMOVE_FORBIDDEN_REFUSAL = "An admin removes people.";
export const INVITE_FAILED = "Couldn't send that invitation.";
export const SET_ROLE_FAILED = "Couldn't change that role.";
export const REMOVE_FAILED = "Couldn't remove that member.";

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

/**
 * The sent dialog's body. Every invitation is answered `sent` and waits for
 * the invited person's acceptance; no invite adds a member at once.
 */
export function inviteSentBody(
  email: string,
  teamName: string,
  role: TeamRole,
): string {
  return `We emailed ${email}. They join ${teamName} as ${withIndefiniteArticle(role)} when they accept.`;
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
