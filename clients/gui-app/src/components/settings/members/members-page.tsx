import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { MemberRowDetails } from "@/components/settings/details/member-row-details";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { MembersView } from "@/components/settings/members/members-view";
import {
  demotionWhatKeepsWorking,
  memberDisplayName,
} from "@/components/settings/members/copy";
import type {
  MembersDetailsSubject,
  MembersListMember,
  PaidSandboxPreview,
  PlanUnlinkPreviewModel,
  RemovePreviewModel,
} from "@/components/settings/members/types";
import {
  useEnvironmentMembersList,
  useTeamEnvironmentDescriptor,
} from "@/hooks/environment/use-environment-members-list";
import { useEnvironmentMembersWrites } from "@/hooks/environment/use-environment-members-writes";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostDirectory, useOptionalHostClient } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface MembersPageProps {
  readonly environmentId: string;
}

const EMPTY_NAMES: readonly string[] = [];
const EMPTY_SANDBOXES: readonly PaidSandboxPreview[] = [];
const FALLBACK_TEAM_NAME = "this team";
const EMPTY_PENDING: ReadonlySet<string> = new Set();

function memberRowDetails(subject: MembersDetailsSubject): ReactNode {
  return (
    <MemberRowDetails
      environmentId={subject.environmentId}
      userId={subject.key}
    />
  );
}

function emptyRemovePreview(memberName: string): RemovePreviewModel {
  return {
    memberName,
    activeTurns: null,
    terminals: null,
    hostName: null,
    sharedSignIns: EMPTY_NAMES,
    paidSandboxes: EMPTY_SANDBOXES,
    linkedPlan: null,
  };
}

function overlayRemovalState(
  members: readonly {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string | null;
    readonly effectiveRole: MembersListMember["effectiveRole"];
    readonly linkedPlan: boolean;
    readonly inviteState: MembersListMember["inviteState"];
    readonly invitedAddress: string | null;
  }[],
  pendingRemovals: ReadonlySet<string>,
): readonly MembersListMember[] {
  return members.map((member) => ({
    userId: member.userId,
    displayName: member.displayName,
    email: member.email,
    effectiveRole: member.effectiveRole,
    linkedPlan: member.linkedPlan,
    inviteState: member.inviteState,
    invitedAddress: member.invitedAddress,
    removalState: pendingRemovals.has(member.userId) ? "pending" : "none",
  }));
}

function demotionFromPreview(
  memberName: string,
  preview: {
    readonly linkedPlan: string | null;
    readonly activeTurns: number | null;
  } | null,
): PlanUnlinkPreviewModel {
  if (preview === null) {
    return {
      memberName,
      planLabel: "",
      turnsOnPlan: 0,
      whatKeepsWorking: demotionWhatKeepsWorking(),
    };
  }
  return {
    memberName,
    planLabel: preview.linkedPlan ?? "",
    turnsOnPlan: preview.activeTurns ?? 0,
    whatKeepsWorking: demotionWhatKeepsWorking(),
  };
}

/**
 * Settings ▸ Members for a team pick. Reads `environment.members@1.1` and
 * writes through invite / setRole / remove / noticeSeen / removePreview.
 */
export function MembersPage(props: MembersPageProps): ReactNode {
  const client = useOptionalHostClient();
  const hostId = useReactiveHostReadiness(client).hostId;
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
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
    membersSupported,
  );
  const writes = useEnvironmentMembersWrites(client, props.environmentId);
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? "");
  const [pendingRemovals, setPendingRemovals] =
    useState<ReadonlySet<string>>(EMPTY_PENDING);
  const directory = useHostDirectory();
  const noticeSeenFor = useRef<string | null>(null);

  const members = useMemo(
    () => overlayRemovalState(list.members, pendingRemovals),
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
      return writes.remove(input).then((outcome) => {
        if (outcome.outcome === "pending") {
          setPendingRemovals((current) => {
            const next = new Set(current);
            next.add(input.userId);
            return next;
          });
        }
        return outcome;
      });
    },
    [writes],
  );

  const onLoadRemovePreview = useCallback(
    (userId: string): Promise<RemovePreviewModel> => {
      const member = members.find((row) => row.userId === userId);
      const memberName =
        member === undefined ? userId : memberDisplayName(member);
      return writes.loadRemovePreview(userId).then((preview) => {
        if (preview === null) return emptyRemovePreview(memberName);
        const hostName =
          preview.localHostId === null
            ? null
            : (directory.findById(preview.localHostId)?.label ?? null);
        return {
          memberName,
          activeTurns: preview.activeTurns,
          terminals: preview.terminals,
          hostName,
          sharedSignIns: preview.sharedSignIns,
          paidSandboxes: preview.paidSandboxes,
          linkedPlan: preview.linkedPlan,
        };
      });
    },
    [directory, members, writes],
  );

  const onLoadDemotionPreview = useCallback(
    (userId: string): Promise<PlanUnlinkPreviewModel> => {
      const member = members.find((row) => row.userId === userId);
      const memberName =
        member === undefined ? userId : memberDisplayName(member);
      return writes
        .loadRemovePreview(userId)
        .then((preview) => demotionFromPreview(memberName, preview));
    },
    [members, writes],
  );

  return (
    <MembersView
      environmentId={props.environmentId}
      teamName={teamName}
      teamHandle={team.teamHandle}
      currentUserId={currentUserId}
      viewerRole={viewerRole}
      members={members}
      legacyMembers={list.legacyMembers}
      legacyRoleNoticeSeenAt={list.legacyRoleNoticeSeenAt}
      rowDetails={memberRowDetails}
      onInvite={writes.invite}
      onSetRole={writes.setRole}
      onRemove={onRemove}
      onLoadRemovePreview={onLoadRemovePreview}
      onLoadDemotionPreview={onLoadDemotionPreview}
      onNoticeSeen={onNoticeSeen}
    />
  );
}
