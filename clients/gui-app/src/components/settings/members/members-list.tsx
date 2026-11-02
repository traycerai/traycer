import type { ReactNode } from "react";
import { MemberRow } from "@/components/settings/members/member-row";
import {
  ROLE_LABELS,
  isLastAdminMember,
  memberGainedEditing,
  membersCardTitle,
  pendingInviteHiddenAddress,
  pendingInviteTitle,
} from "@/components/settings/members/copy";
import type {
  MembersDetailsSubject,
  MembersListMember,
  PendingRoleCheck,
  TeamRole,
} from "@/components/settings/members/types";

export function MembersList(props: {
  readonly environmentId: string;
  readonly teamName: string;
  readonly currentUserId: string;
  readonly viewerIsAdmin: boolean;
  readonly members: readonly MembersListMember[];
  readonly visibleMembers: readonly MembersListMember[];
  readonly pendingCount: number;
  readonly peopleCount: number;
  readonly legacyMembers: readonly string[];
  readonly rowDetails: (subject: MembersDetailsSubject) => ReactNode;
  /** The role change still waiting on its check, with no dialog up for it yet. */
  readonly checkingRole: PendingRoleCheck | null;
  readonly onCancelRoleChange: () => void;
  readonly onRoleChange: (member: MembersListMember, role: TeamRole) => void;
  readonly onRemove: (member: MembersListMember) => void;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
      <h2 className="border-b border-border/60 px-3 py-2 text-ui-sm font-medium">
        {membersCardTitle(props.teamName, props.peopleCount)}
      </h2>
      <ul data-testid="members-list">
        {props.visibleMembers.map((member) => {
          const lastAdmin = isLastAdminMember(props.members, member.userId);
          const gainedEditing = memberGainedEditing(
            member,
            props.legacyMembers,
          );
          return (
            <MemberRow
              key={member.userId}
              member={member}
              isSelf={member.userId === props.currentUserId}
              isLastAdmin={lastAdmin}
              viewerIsAdmin={props.viewerIsAdmin}
              gainedEditing={gainedEditing}
              checkingRole={
                props.checkingRole?.userId === member.userId
                  ? props.checkingRole
                  : null
              }
              onCancelRoleChange={props.onCancelRoleChange}
              details={props.rowDetails({
                environmentId: props.environmentId,
                kind: "member",
                key: member.userId,
                roleLabel: ROLE_LABELS[member.effectiveRole],
              })}
              onRoleChange={(role) => props.onRoleChange(member, role)}
              onRemove={() => props.onRemove(member)}
              onRetry={props.onRetry}
            />
          );
        })}
        {props.viewerIsAdmin || props.pendingCount === 0 ? null : (
          <li
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            data-testid="members-pending-summary"
          >
            <div className="min-w-0">
              <div className="font-medium text-ui-sm">
                {pendingInviteTitle()}
              </div>
              <p className="text-ui-xs text-muted-foreground">
                {pendingInviteHiddenAddress(props.pendingCount)}
              </p>
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
