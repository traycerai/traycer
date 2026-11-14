import { withIndefiniteArticle } from "@traycer/protocol/host/notifications/indefinite-article";
import type {
  MemberWorkNow,
  MembersListMember,
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
};

/** The label for a seat with no authority: the role is retired or unknown. */
const NO_ROLE_LABEL = "No access";

/** One row's role label, `null` included. */
export function roleLabelOf(role: TeamRole | null): string {
  return role === null ? NO_ROLE_LABEL : ROLE_LABELS[role];
}

export const HOW_TRAYCER_HANDLES_THIS = "How Traycer handles this";

export const ACCEPT_LABEL = "Accept";

/** The title over an invitation's grant and Accept. */
export function inviteAcceptTitle(teamName: string): string {
  return `You're invited to ${teamName}`;
}

/** An invitation withdrawn or already answered by the time Accept was pressed. */
export const INVITATION_GONE = "This invitation is no longer open.";

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

/**
 * The one-time notice over the Members list. It says what the update did and
 * whether anyone's access actually changed: with nobody named, every member
 * could already edit, and the notice says so rather than leaving the reader to
 * read "Nobody gained editing." as a loss.
 */
export function legacyRoleNotice(
  teamName: string,
  names: readonly string[],
): string {
  const lead = `With this update every existing member can edit ${teamName}'s settings`;
  const tail = "Set a role beside each name to change that.";
  if (names.length === 0) return `${lead}, as each one already could. ${tail}`;
  return `${lead}. ${joinNames(names)} can now edit. ${tail}`;
}

/**
 * The standing line on a team's settings this reader may read and not change:
 * a configuration read through the pool whose role authorizes nothing. There
 * is no read-only ROLE any more - this is what an older inventory's unknown
 * role reads as.
 */
export function seeButNotChangeLine(teamName: string): string {
  return `You can see ${teamName}'s settings but not change them.`;
}

export function roleGrantPrefix(role: TeamRole): string {
  const editor =
    "You can change the team's settings; every change reaches every team sandbox.";
  switch (role) {
    case "editor":
      return editor;
    case "admin":
      return `${editor} You can invite and remove people and change roles.`;
  }
}

export function roleGrantCommon(): string {
  return "Full use and management of the team's sandboxes and connected services. Uses your team credits. Every member can interrupt or permanently delete any team sandbox, including ones you created. Your name and email are visible to the team's members. Your actions are attributed to you in status, history and notifications that the reader is authorized to see.";
}

export function invitePendingSeatsSentence(): string {
  return "Pending invitations count toward the team's paid seats as soon as they are sent, before acceptance.";
}

/** The line under the invite's Role picker, for the role picked. */
export function inviteRoleLine(role: TeamRole): string {
  switch (role) {
    case "editor":
      return "Can change the team's settings; every change reaches every team sandbox.";
    case "admin":
      return "Can change the team's settings, invite and remove people, and change roles.";
  }
}

/**
 * What sending one more invitation does to the team's seats, from the seats
 * it holds before the send. The plan's seat count follows its membership
 * rows: past the last seat it grows at once, charged prorated now; with
 * seats to spare the unused ones end with the billing period.
 */
function inviteSeatDeltaSentence(seats: SeatDelta): string {
  const after = seats.used + 1;
  if (after > seats.total) {
    return `The team has no free seat, so sending this adds one: it will use ${String(after)} of ${String(after)} seats. The added seat is charged now to the team's card on file, prorated for the rest of the current billing period.`;
  }
  if (after === seats.total) {
    return `The team will use ${String(after)} of ${String(seats.total)} seats; nothing is charged now. The next invitation will add a seat.`;
  }
  return `The team will use ${String(after)} of ${String(seats.total)} seats; nothing is charged now. At the end of this billing period, the team keeps only the seats in use and stops paying for the others.`;
}

/**
 * The invite sheet's seat copy, from the seats the team holds before the
 * send. `seats` null means a free or pending plan: nothing about seats is
 * shown.
 */
export function inviteSeatCopy(seats: SeatDelta | null): string | null {
  if (seats === null) return null;
  return `${invitePendingSeatsSentence()} ${inviteSeatDeltaSentence(seats)}`;
}

export function inviteSeatsReadFailed(): string {
  return "Couldn't read the team's seats.";
}

export function acceptSeatAlreadyCounts(): string {
  return "Your seat already counts toward the team's seats; accepting does not add another.";
}

export function acceptSeatCopy(paidPlan: boolean): string {
  if (paidPlan) return acceptSeatAlreadyCounts();
  return "An admin sets how much of the team's credits you can spend.";
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

/** A member in the team, not an invitation. */
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
  return `${memberName} loses ${teamName}'s settings, hosts and connected services.`;
}

/** What a removal does to the member's work, with or without its count. */
export function removeWorkContinues(teamName: string): string {
  return `Their connections close now. Work they started keeps running for ${teamName} under their name.`;
}

/**
 * The member's running turns and terminals where a team computer counted
 * them, then what the removal does to that work; without a count, the second
 * part alone. Both counts zero is "None.". The host is named only when this
 * window knows it.
 */
export function removeWorkNow(
  teamName: string,
  workNow: MemberWorkNow | null,
): string {
  if (workNow === null) return removeWorkContinues(teamName);
  if (workNow.activeTurns === 0 && workNow.terminals === 0) return NONE;
  const where = workNow.hostName === null ? "" : ` on ${workNow.hostName}`;
  return `${countNoun(workNow.activeTurns, "turn")} and ${countNoun(workNow.terminals, "terminal")}${where}. ${removeWorkContinues(teamName)}`;
}

export function removeSharedSignInConsequence(
  teamName: string,
  sandboxesToRekey: number,
): string {
  if (sandboxesToRekey === 0) return NONE;
  return `${teamName}'s sandboxes get a replacement sign-in for the team's connected services; it is complete when each host and the provider confirm.`;
}

export function removeCannotRecall(
  memberName: string,
  teamName: string,
): string {
  return `Files ${memberName} already copied off a host and work already done upstream with ${teamName}'s services. What ${memberName} started stays, labelled "started by a former member".`;
}

export function removeConfirmLabel(firstName: string): string {
  return `Remove ${firstName}`;
}

/** The removal's own tell, by the name the row and the preview use. */
export const MEMBER_REMOVED_TOAST = "Member removed";

export function memberRemovedToastBody(
  memberName: string,
  teamName: string,
): string {
  return `${memberName} is no longer in ${teamName}.`;
}

/** How much a role may change: a lower one is a demotion, and confirms. */
const ROLE_RANK: Readonly<Record<TeamRole, number>> = {
  editor: 0,
  admin: 1,
};

/** The role's own word, as the confirm's question and button say it. */
const ROLE_WORDS: Readonly<Record<TeamRole, string>> = {
  admin: "admin",
  editor: "editor",
};

/**
 * Whether changing `from` to `to` takes something away. Only a demotion asks:
 * a promotion gives, so it is written straight through.
 */
export function isRoleDemotion(from: TeamRole, to: TeamRole): boolean {
  return ROLE_RANK[to] < ROLE_RANK[from];
}

export function demotionLossLine(memberName: string): string {
  return `${memberName} can no longer invite people, change roles or edit the approval policy.`;
}

export function demotionConfirmTitle(
  memberName: string,
  teamName: string,
  nextRole: TeamRole,
): string {
  return `Change ${memberName}'s role in ${teamName} to ${ROLE_WORDS[nextRole]}?`;
}

/**
 * What the demotion takes away. Admin to editor is the only demotion a team
 * has left - every other role change gives - so this names the admin powers.
 */
export function demotionConfirmBody(
  memberName: string,
  currentRole: TeamRole,
  nextRole: TeamRole,
): string {
  if (currentRole === "admin" && nextRole !== "admin") {
    return demotionLossLine(memberName);
  }
  return "";
}

export function demotionConfirmLabel(nextRole: TeamRole): string {
  return `Change to ${ROLE_WORDS[nextRole]}`;
}

export function removeWorkNowLabel(memberName: string): string {
  return `${memberName}'s work now`;
}

export const SHARED_SIGN_INS_LABEL = "Shared sign-ins";

export const CANNOT_RECALL_LABEL = "Can't be recalled";

export function revokeInviteTitle(): string {
  return "Revoke this invitation";
}

export function revokeInviteLead(address: string, teamName: string): string {
  return `${address} will not join ${teamName}. The pending seat is released.`;
}

export function seatLimitRefusal(): string {
  return "The team has no remaining seats. Manage seats and allowances on the dashboard.";
}

export function inviteForbiddenRefusal(): string {
  return "An admin invites people.";
}

export const SET_ROLE_FORBIDDEN_REFUSAL = "An admin changes roles.";
export const REMOVE_FORBIDDEN_REFUSAL = "An admin removes people.";
export const INVITE_FAILED = "Couldn't send that invitation.";
export const SET_ROLE_FAILED = "Couldn't change that role.";
export const REMOVE_FAILED = "Couldn't remove that member.";

export function inviteDialogLead(): string {
  return "They join the team when they accept.";
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
