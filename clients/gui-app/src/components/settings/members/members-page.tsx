import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  HostMethodVersionUnsatisfiedError,
  negotiatedVersionMeetsRequirement,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { MemberRowDetails } from "@/components/settings/details/member-row-details";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { MembersView } from "@/components/settings/members/members-view";
import type {
  MembersDetailsSubject,
  MembersListMember,
  MembersReadState,
} from "@/components/settings/members/types";
import {
  ENVIRONMENT_MEMBERS_FLOOR,
  useEnvironmentMembersList,
  useTeamEnvironmentDescriptor,
  type EnvironmentMembersListMember,
} from "@/hooks/environment/use-environment-members-list";
import { useEnvironmentMembersWrites } from "@/hooks/environment/use-environment-members-writes";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
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
  served: boolean | null,
  error: HostRpcError | null,
  waiting: boolean,
): MembersReadState {
  if (served === false) return "unsupported";
  // A connection that negotiated below the floor refuses the read unsent.
  if (error instanceof HostMethodVersionUnsatisfiedError) return "unsupported";
  if (error !== null) return "failed";
  return waiting ? "loading" : "ready";
}

/**
 * Settings ▸ Members for a team pick. Reads `environment.members@1.1` and
 * writes through invite / setRole / remove / noticeSeen; the view's dialogs
 * read removePreview for the member they name, and the invite sheet reads
 * seats when the host serves it.
 */
export function MembersPage(props: MembersPageProps): ReactNode {
  const client = usePoolTierHostClient(useOptionalHostClient());
  const hostId = useReactiveHostReadiness(client).hostId;
  const membersPresent = useHostMethodSupport(hostId, "environment.members");
  const membersVersion = useHostMethodSchemaVersion(
    hostId,
    "environment.members",
  );
  // `null` until a handshake says; `false` for a host without the read or
  // below its floor, a name-only recording included.
  const membersSupport =
    membersPresent === true
      ? membersVersion !== null &&
        negotiatedVersionMeetsRequirement(
          membersVersion,
          ENVIRONMENT_MEMBERS_FLOOR,
        )
      : membersPresent;
  const listSupported =
    useHostMethodSupport(hostId, "environment.list") === true;
  const seatsSupported =
    useHostMethodSupport(hostId, "environment.members.seats") === true;
  const teamLabel = usePickedTeamLabel(props.environmentId);
  const team = useTeamEnvironmentDescriptor(
    client,
    props.environmentId,
    listSupported,
  );
  const list = useEnvironmentMembersList(
    client,
    props.environmentId,
    membersSupport === true,
  );
  const writes = useEnvironmentMembersWrites(client, props.environmentId);
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? "");
  const [pendingRemovals, setPendingRemovals] =
    useState<ReadonlySet<string>>(NO_PENDING_REMOVALS);
  const directory = useHostDirectory();
  const noticeSeenFor = useRef<string | null>(null);

  const membersRead = membersReadState(
    membersSupport,
    list.error,
    client === null || membersSupport === null || list.isPending,
  );
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
  const viewerRole =
    viewerFromList?.effectiveRole ?? team.viewerRole ?? "viewer";
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
      seatsSupported={seatsSupported}
      hostLabel={hostLabel}
      onNoticeSeen={onNoticeSeen}
    />
  );
}
