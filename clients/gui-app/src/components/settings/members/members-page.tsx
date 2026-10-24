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
import { useCompletedMemberRemovalReceipts } from "@/hooks/environment/use-member-removal-receipts";
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

/**
 * A removal the host answered `pending` for: the row as it was when removed,
 * and the receipt that completes it. Kept apart from the members read, which
 * stops listing the person as soon as the removal commits.
 */
interface PendingRemoval {
  readonly member: MembersListMember;
  readonly receiptId: string;
  /**
   * Whether a successful read has stopped listing the person since the
   * removal was requested: the removal committed, so a read that lists them
   * again lists a newer membership, and the removal no longer describes them.
   */
  readonly unlisted: boolean;
}

const FALLBACK_TEAM_NAME = "this team";
const NO_PENDING_REMOVALS: ReadonlyMap<string, PendingRemoval> = new Map();

function memberRowDetails(subject: MembersDetailsSubject): ReactNode {
  return (
    <MemberRowDetails
      environmentId={subject.environmentId}
      userId={subject.key}
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

/**
 * The read's rows, each pending removal marked on its row, and a pending
 * removal the read no longer lists kept as its own row: `pending` until its
 * receipt completes, then `done`.
 */
function overlayRemovals(
  members: readonly EnvironmentMembersListMember[],
  pendingRemovals: ReadonlyMap<string, PendingRemoval>,
  completedReceipts: ReadonlySet<string>,
): readonly MembersListMember[] {
  const removalState = (
    removal: PendingRemoval,
  ): MembersListMember["removalState"] =>
    completedReceipts.has(removal.receiptId) ? "done" : "pending";
  const rows = members.map((member): MembersListMember => {
    const removal = pendingRemovals.get(member.userId);
    const row = listRow(member);
    return removal === undefined
      ? row
      : { ...row, removalState: removalState(removal) };
  });
  const listed = new Set(members.map((member) => member.userId));
  for (const removal of pendingRemovals.values()) {
    if (listed.has(removal.member.userId)) continue;
    rows.push({ ...removal.member, removalState: removalState(removal) });
  }
  return rows;
}

/**
 * The removals as a successful read leaves them: one whose person the read
 * no longer lists is marked unlisted, and one already unlisted whose person
 * the read lists again retires. The same map when nothing moved.
 */
function settleRemovals(
  pendingRemovals: ReadonlyMap<string, PendingRemoval>,
  members: readonly EnvironmentMembersListMember[],
): ReadonlyMap<string, PendingRemoval> {
  const listed = new Set(members.map((member) => member.userId));
  let next: Map<string, PendingRemoval> | null = null;
  for (const [userId, removal] of pendingRemovals) {
    const isListed = listed.has(userId);
    if (isListed === !removal.unlisted) continue;
    next ??= new Map(pendingRemovals);
    if (isListed) next.delete(userId);
    else next.set(userId, { ...removal, unlisted: true });
  }
  return next ?? pendingRemovals;
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
 * read removePreview for the member they name.
 */
export function MembersPage(props: MembersPageProps): ReactNode {
  const client = useOptionalHostClient();
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
    useState<ReadonlyMap<string, PendingRemoval>>(NO_PENDING_REMOVALS);
  const completedReceipts = useCompletedMemberRemovalReceipts(
    props.environmentId,
  );
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
    () => overlayRemovals(list.members, pendingRemovals, completedReceipts),
    [list.members, pendingRemovals, completedReceipts],
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
      const removed = members.find((row) => row.userId === input.userId);
      return writes.remove(input).then((outcome) => {
        if (outcome.outcome === "pending" && removed !== undefined) {
          setPendingRemovals((current) => {
            const next = new Map(current);
            next.set(input.userId, {
              member: removed,
              receiptId: outcome.receiptId,
              unlisted: false,
            });
            return next;
          });
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
      hostLabel={hostLabel}
      onNoticeSeen={onNoticeSeen}
    />
  );
}
