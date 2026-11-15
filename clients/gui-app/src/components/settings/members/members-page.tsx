import { useCallback, useMemo, useRef, type ReactNode } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MemberRowDetails } from "@/components/settings/details/member-row-details";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { MembersView } from "@/components/settings/members/members-view";
import type {
  MembersDetailsSubject,
  MembersListMember,
  MembersReadState,
} from "@/components/settings/members/types";
import {
  useEnvironmentMembersList,
  useTeamEnvironmentDescriptor,
  type EnvironmentMembersListMember,
} from "@/hooks/environment/use-environment-members-list";
import { useEnvironmentMembersWrites } from "@/hooks/environment/use-environment-members-writes";
import { useHostDirectory } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface MembersPageProps {
  readonly environmentId: string;
}

const FALLBACK_TEAM_NAME = "this team";

function memberRowDetails(subject: MembersDetailsSubject): ReactNode {
  return (
    <MemberRowDetails
      environmentId={subject.environmentId}
      userId={subject.key}
      roleLabel={subject.roleLabel}
    />
  );
}

function listRow(member: EnvironmentMembersListMember): MembersListMember {
  return {
    userId: member.userId,
    displayName: member.displayName,
    email: member.email,
    effectiveRole: member.effectiveRole,
    linkedPlan: member.linkedPlan,
    inviteState: member.inviteState,
    invitedAddress: member.invitedAddress,
  };
}

function membersReadState(
  error: HostRpcError | null,
  waiting: boolean,
): MembersReadState {
  if (error !== null) return "failed";
  return waiting ? "loading" : "ready";
}

/**
 * Settings ▸ Members for a team pick. Reads the members and writes invite /
 * setRole / remove / noticeSeen, the invite sheet's seats and the removal
 * confirm's preview as the app's own calls to authn. Only the removed
 * member's running work is counted by a computer, a team one the app can
 * reach.
 */
export function MembersPage(props: MembersPageProps): ReactNode {
  const teamLabel = usePickedTeamLabel(props.environmentId);
  const team = useTeamEnvironmentDescriptor(props.environmentId);
  const list = useEnvironmentMembersList(props.environmentId, true);
  const writes = useEnvironmentMembersWrites(props.environmentId);
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? "");
  const directory = useHostDirectory();
  const noticeSeenFor = useRef<string | null>(null);

  const membersRead = membersReadState(list.error, list.isPending);
  const members = useMemo(() => list.members.map(listRow), [list.members]);

  const viewerFromList = members.find(
    (member) => member.userId === currentUserId,
  );
  // The listed seat is authoritative, including `null` for no seat authority.
  // Fall back to the descriptor only when the members read has no own row.
  const viewerRole =
    viewerFromList === undefined
      ? team.viewerRole
      : viewerFromList.effectiveRole;
  const teamName = team.teamName ?? teamLabel ?? FALLBACK_TEAM_NAME;

  const onNoticeSeen = useCallback((): void => {
    if (noticeSeenFor.current === props.environmentId) return;
    noticeSeenFor.current = props.environmentId;
    writes.noticeSeen();
  }, [props.environmentId, writes]);

  const hostLabel = useCallback(
    (hostId: string): string | null =>
      directory.findById(hostId)?.label ?? null,
    [directory],
  );

  return (
    <MembersView
      environmentId={props.environmentId}
      teamName={teamName}
      teamHandle={team.teamHandle}
      currentUserId={currentUserId}
      viewerRole={viewerRole}
      membersRead={membersRead}
      members={members}
      legacyMembers={list.legacyMembers}
      legacyRoleNoticeSeenAt={list.legacyRoleNoticeSeenAt}
      rowDetails={memberRowDetails}
      onRetryMembers={list.retry}
      onInvite={writes.invite}
      onSetRole={writes.setRole}
      onRemove={writes.remove}
      invitePending={writes.inviteMutation.isPending}
      setRolePending={writes.setRoleMutation.isPending}
      removePending={writes.removeMutation.isPending}
      hostLabel={hostLabel}
      onNoticeSeen={onNoticeSeen}
    />
  );
}
