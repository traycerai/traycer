import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useCompletedMemberRemovalReceipts } from "@/hooks/environment/use-member-removal-receipts";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
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

function membersReadState(failed: boolean, waiting: boolean): MembersReadState {
  if (failed) return "failed";
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
  const membersSupport = useHostMethodSupport(hostId, "environment.members");
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

  const members = useMemo(
    () => overlayRemovals(list.members, pendingRemovals, completedReceipts),
    [list.members, pendingRemovals, completedReceipts],
  );
  const membersRead = membersReadState(
    list.isError,
    client === null || membersSupport === null || list.isPending,
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
            });
            return next;
          });
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
