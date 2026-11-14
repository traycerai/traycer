import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useHostDirectory, useOptionalHostClient } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface MembersPageProps {
  readonly environmentId: string;
}

const FALLBACK_TEAM_NAME = "this team";

/**
 * The members whose removal the host answered `pending` for. The members read
 * stops listing a person once their removal commits, and that read completes
 * it.
 */
const NO_PENDING_REMOVALS: ReadonlySet<string> = new Set();

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
    removalState: "none",
  };
}

/** The read's rows, each pending removal marked on its row. */
function overlayRemovals(
  members: readonly EnvironmentMembersListMember[],
  pendingRemovals: ReadonlySet<string>,
): readonly MembersListMember[] {
  return members.map((member): MembersListMember => {
    const row = listRow(member);
    return pendingRemovals.has(member.userId)
      ? { ...row, removalState: "pending" }
      : row;
  });
}

/**
 * The removals a successful read leaves pending: one whose person the read no
 * longer lists has committed, and is done. The same set when nothing moved.
 */
function settleRemovals(
  pendingRemovals: ReadonlySet<string>,
  members: readonly EnvironmentMembersListMember[],
): ReadonlySet<string> {
  const listed = new Set(members.map((member) => member.userId));
  const next = new Set([...pendingRemovals].filter((id) => listed.has(id)));
  return next.size === pendingRemovals.size ? pendingRemovals : next;
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
 * setRole / remove / noticeSeen as the app's own calls to authn; the view's
 * dialogs read removePreview for the member they name from the host, and the
 * invite sheet reads seats from authn.
 */
export function MembersPage(props: MembersPageProps): ReactNode {
  // Only a removal's preview is still the host's: what a team sandbox counts
  // of the member's running work.
  const client = usePoolTierHostClient(useOptionalHostClient());
  const teamLabel = usePickedTeamLabel(props.environmentId);
  const team = useTeamEnvironmentDescriptor(props.environmentId);
  const list = useEnvironmentMembersList(props.environmentId, true);
  const writes = useEnvironmentMembersWrites(props.environmentId);
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? "");
  const [pendingRemovals, setPendingRemovals] =
    useState<ReadonlySet<string>>(NO_PENDING_REMOVALS);
  const directory = useHostDirectory();
  const noticeSeenFor = useRef<string | null>(null);

  const membersRead = membersReadState(list.error, list.isPending);
  // Each successful read settles the removals once; a new removal clears this
  // so the read already in hand settles it too.
  const [settledRead, setSettledRead] = useState<
    readonly EnvironmentMembersListMember[] | null
  >(null);
  if (membersRead === "ready" && settledRead !== list.members) {
    setSettledRead(list.members);
    setPendingRemovals((current) => settleRemovals(current, list.members));
  }

  const members = useMemo(
    () => overlayRemovals(list.members, pendingRemovals),
    [list.members, pendingRemovals],
  );

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

  const onRemove = useCallback(
    (input: { readonly userId: string }) => {
      const listed = members.some((row) => row.userId === input.userId);
      return writes.remove(input).then((outcome) => {
        if (outcome.outcome === "pending" && listed) {
          setPendingRemovals((current) => new Set([...current, input.userId]));
          setSettledRead(null);
        }
        return outcome;
      });
    },
    [members, writes],
  );

  const hostLabel = useCallback(
    (hostId: string): string | null =>
      directory.findById(hostId)?.label ?? null,
    [directory],
  );

  return (
    <MembersView
      client={client}
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
      onRemove={onRemove}
      invitePending={writes.inviteMutation.isPending}
      setRolePending={writes.setRoleMutation.isPending}
      removePending={writes.removeMutation.isPending}
      hostLabel={hostLabel}
      onNoticeSeen={onNoticeSeen}
    />
  );
}
