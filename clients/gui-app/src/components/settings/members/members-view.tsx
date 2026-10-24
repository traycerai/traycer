import { useEffect, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentMembersRemovePreviewResponse } from "@traycer/protocol/host/environment/contracts";
import { DemotionPreviewDialog } from "@/components/settings/members/demotion-preview";
import { InviteDialog } from "@/components/settings/members/invite-dialog";
import { LegacyRoleNotice } from "@/components/settings/members/legacy-notice";
import { MembersList } from "@/components/settings/members/members-list";
import { RemovePreviewDialog } from "@/components/settings/members/remove-preview";
import { RevokeInviteDialog } from "@/components/settings/members/revoke-invite-dialog";
import {
  INVITE_LABEL,
  LAST_ADMIN_REFUSAL,
  MANAGE_SEATS_LABEL,
  MEMBERS_NEED_UPDATED_HOST,
  RETRY_LABEL,
  ROLE_LABELS,
  acceptedPeopleCount,
  addPlanOnDashboardLabel,
  demotionWhatKeepsWorking,
  memberDisplayName,
  membersHeaderLine,
  membersReadFailed,
  planRequiredRefusal,
} from "@/components/settings/members/copy";
import {
  seatsManagementUrl,
  teamPlanUrl,
} from "@/components/settings/members/dashboard-urls";
import type {
  MembersDetailsSubject,
  MembersInviteOutcome,
  MembersListMember,
  MembersReadState,
  MembersRemoveOutcome,
  MembersSetRoleOutcome,
  PlanUnlinkPreviewModel,
  PreviewState,
  RemovePreviewModel,
  TeamRole,
} from "@/components/settings/members/types";
import { DashboardLinkButton } from "@/components/settings/host-scope/dashboard-link-button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentMembersRemovePreviewQuery } from "@/hooks/environment/use-environment-members-remove-preview-query";
import type { HostRpcRegistry } from "@/lib/host";

type PendingRemove =
  | { readonly kind: "accepted"; readonly member: MembersListMember }
  | { readonly kind: "pending-invite"; readonly member: MembersListMember };

type PendingDemotion = {
  readonly member: MembersListMember;
  readonly nextRole: TeamRole;
};

/**
 * A dialog's preview from its read: the answer once read (while no re-read
 * after a failure is in flight), the failure once a read is refused, and
 * loading otherwise. Never an answer read for another member.
 */
function previewState<Preview>(
  query: UseQueryResult<EnvironmentMembersRemovePreviewResponse, HostRpcError>,
  model: (preview: EnvironmentMembersRemovePreviewResponse) => Preview,
): PreviewState<Preview> {
  if (query.isError) {
    return query.isFetching ? { status: "loading" } : { status: "failed" };
  }
  if (query.data === undefined) return { status: "loading" };
  return { status: "ready", preview: model(query.data) };
}

function pendingInviteCount(members: readonly MembersListMember[]): number {
  return members.filter((member) => member.inviteState === "pending").length;
}

function refusalFromRemove(
  teamName: string,
  outcome: MembersRemoveOutcome,
): string | null {
  if (outcome.outcome === "last_admin") return LAST_ADMIN_REFUSAL;
  if (outcome.outcome === "plan_required") return planRequiredRefusal(teamName);
  if (outcome.outcome === "forbidden") return LAST_ADMIN_REFUSAL;
  return null;
}

function refusalFromSetRole(
  teamName: string,
  outcome: MembersSetRoleOutcome,
): string | null {
  if (outcome.outcome === "last_admin") return LAST_ADMIN_REFUSAL;
  if (outcome.outcome === "plan_required") return planRequiredRefusal(teamName);
  if (outcome.outcome === "forbidden") return LAST_ADMIN_REFUSAL;
  return null;
}

/**
 * The members read while it is not ready: loading, the failure with Retry, or
 * a host that does not serve it, which only an update fixes.
 */
function MembersReadFallback(props: {
  readonly membersRead: MembersReadState;
  readonly teamName: string;
  readonly onRetry: () => void;
}): ReactNode {
  if (props.membersRead === "loading") {
    return (
      <AgentSpinningDots
        className={undefined}
        testId="members-loading"
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (props.membersRead === "unsupported") {
    return (
      <p
        role="status"
        className="text-ui-sm text-muted-foreground"
        data-testid="members-needs-update"
      >
        {MEMBERS_NEED_UPDATED_HOST}
      </p>
    );
  }
  if (props.membersRead === "failed") {
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        role="status"
        data-testid="members-read-failed"
      >
        <p className="max-w-[72ch] text-ui-sm text-destructive">
          {membersReadFailed(props.teamName)}
        </p>
        <Button type="button" variant="outline" onClick={props.onRetry}>
          {RETRY_LABEL}
        </Button>
      </div>
    );
  }
  return null;
}

function targetName(member: MembersListMember | null): string {
  return member === null ? "" : memberDisplayName(member);
}

function targetUserId(member: MembersListMember | null): string | null {
  return member === null ? null : member.userId;
}

/** The member a Remove or a Revoke names, when the open dialog is that one. */
function removeTargetOfKind(
  target: PendingRemove | null,
  kind: PendingRemove["kind"],
): MembersListMember | null {
  return target !== null && target.kind === kind ? target.member : null;
}

/** A refusal from the last write, with the dashboard link when it names one. */
function MembersBanner(props: {
  readonly banner: string | null;
  readonly teamName: string;
  readonly teamHandle: string;
}): ReactNode {
  if (props.banner === null) return null;
  const planPage = (signInUrl: string): string => {
    return teamPlanUrl(signInUrl, props.teamHandle) ?? signInUrl;
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="status"
      data-testid="members-banner"
    >
      <p className="max-w-[72ch] text-ui-sm text-destructive">{props.banner}</p>
      {props.banner === planRequiredRefusal(props.teamName) &&
      props.teamHandle.length > 0 ? (
        <DashboardLinkButton
          page={planPage}
          label={addPlanOnDashboardLabel()}
          testId="members-plan-required-link"
        />
      ) : null}
    </div>
  );
}

/**
 * Settings ▸ Members body: header, seats link, invite, legacy notice, the
 * list, and the invite / remove / demotion dialogs. E4's stub wraps this.
 * Until the members read succeeds the list, Invite and the notice wait: a read
 * in flight shows loading, a failed one says so with Retry. Each dialog's
 * preview is read for the member it names.
 */
export function MembersView(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly environmentId: string;
  readonly teamName: string;
  readonly teamHandle: string;
  readonly currentUserId: string;
  readonly viewerRole: TeamRole;
  readonly membersRead: MembersReadState;
  readonly members: readonly MembersListMember[];
  readonly legacyMembers: readonly string[];
  readonly legacyRoleNoticeSeenAt: number | null;
  readonly rowDetails: (subject: MembersDetailsSubject) => ReactNode;
  readonly onRetryMembers: () => void;
  readonly onInvite: (input: {
    readonly email: string;
    readonly role: TeamRole;
  }) => Promise<MembersInviteOutcome>;
  readonly onSetRole: (input: {
    readonly userId: string;
    readonly role: TeamRole;
  }) => Promise<MembersSetRoleOutcome>;
  readonly onRemove: (input: {
    readonly userId: string;
  }) => Promise<MembersRemoveOutcome>;
  /** The name a host id shows as, null when this window does not know it. */
  readonly hostLabel: (hostId: string) => string | null;
  readonly onNoticeSeen: () => void;
}): ReactNode {
  const {
    client,
    environmentId,
    teamName,
    teamHandle,
    currentUserId,
    membersRead,
    members,
    legacyMembers,
    legacyRoleNoticeSeenAt,
    rowDetails,
    onRetryMembers,
    onInvite,
    onSetRole,
    onRemove,
    hostLabel,
    onNoticeSeen,
  } = props;
  const viewerIsAdmin = props.viewerRole === "admin";
  const peopleCount = acceptedPeopleCount(members);
  const pendingCount = pendingInviteCount(members);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PendingRemove | null>(null);

  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeRefusal, setRemoveRefusal] = useState<string | null>(null);
  const [demotion, setDemotion] = useState<PendingDemotion | null>(null);

  const [demotionBusy, setDemotionBusy] = useState(false);
  const [demotionRefusal, setDemotionRefusal] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const removing = removeTargetOfKind(removeTarget, "accepted");
  const revoking = removeTargetOfKind(removeTarget, "pending-invite");
  const demoting = demotion === null ? null : demotion.member;
  const removeQuery = useEnvironmentMembersRemovePreviewQuery(
    client,
    environmentId,
    targetUserId(removing),
  );
  const demotionQuery = useEnvironmentMembersRemovePreviewQuery(
    client,
    environmentId,
    targetUserId(demoting),
  );
  const removePreview = previewState(
    removeQuery,
    (preview): RemovePreviewModel => ({
      activeTurns: preview.activeTurns,
      terminals: preview.terminals,
      hostName:
        preview.localHostId === null ? null : hostLabel(preview.localHostId),
      sharedSignIns: preview.sharedSignIns,
      paidSandboxes: preview.paidSandboxes,
      linkedPlan: preview.linkedPlan,
    }),
  );
  const demotionPreview = previewState(
    demotionQuery,
    (preview): PlanUnlinkPreviewModel => ({
      planLabel: preview.linkedPlan ?? "",
      turnsOnPlan: preview.activeTurns,
      whatKeepsWorking: demotionWhatKeepsWorking(),
    }),
  );

  const membersReady = membersRead === "ready";
  const showNotice =
    membersReady && viewerIsAdmin && legacyRoleNoticeSeenAt === null;

  useEffect(() => {
    if (!showNotice) return;
    onNoticeSeen();
  }, [showNotice, onNoticeSeen]);

  const listMembers = viewerIsAdmin
    ? members
    : members.filter((member) => member.inviteState !== "pending");

  const closeRemove = (): void => {
    setRemoveTarget(null);
    setRemoveRefusal(null);
  };

  const closeDemotion = (): void => {
    setDemotion(null);
    setDemotionRefusal(null);
  };

  const openRemove = (member: MembersListMember): void => {
    setRemoveRefusal(null);
    setRemoveTarget({
      kind: member.inviteState === "pending" ? "pending-invite" : "accepted",
      member,
    });
  };

  const openRoleChange = (member: MembersListMember, role: TeamRole): void => {
    if (role === member.effectiveRole) return;
    if (member.effectiveRole === "admin" && role !== "admin") {
      setDemotionRefusal(null);
      setDemotion({ member, nextRole: role });
      return;
    }
    void onSetRole({ userId: member.userId, role }).then((outcome) => {
      const refusal = refusalFromSetRole(teamName, outcome);
      if (refusal !== null) setBanner(refusal);
    });
  };

  const confirmRemove = (): void => {
    if (removeTarget === null) return;
    setRemoveBusy(true);
    void onRemove({ userId: removeTarget.member.userId })
      .then(
        (outcome) => {
          const refusal = refusalFromRemove(teamName, outcome);
          if (refusal !== null) {
            setRemoveRefusal(refusal);
            setBanner(refusal);
            return;
          }
          closeRemove();
        },
        () => undefined,
      )
      .finally(() => {
        setRemoveBusy(false);
      });
  };

  const confirmDemotion = (): void => {
    if (demotion === null) return;
    setDemotionBusy(true);
    void onSetRole({
      userId: demotion.member.userId,
      role: demotion.nextRole,
    })
      .then(
        (outcome) => {
          const refusal = refusalFromSetRole(teamName, outcome);
          if (refusal !== null) {
            setDemotionRefusal(refusal);
            setBanner(refusal);
            return;
          }
          closeDemotion();
        },
        () => undefined,
      )
      .finally(() => {
        setDemotionBusy(false);
      });
  };

  const invite = (input: {
    readonly email: string;
    readonly role: TeamRole;
  }): Promise<MembersInviteOutcome> => {
    setInviteBusy(true);
    return onInvite(input)
      .then(
        (outcome) => outcome,
        (): MembersInviteOutcome => ({ outcome: "forbidden" }),
      )
      .finally(() => {
        setInviteBusy(false);
      });
  };

  const seatsPage = (signInUrl: string): string => {
    return seatsManagementUrl(signInUrl, teamHandle) ?? signInUrl;
  };

  const noticeSubject: MembersDetailsSubject = {
    environmentId,
    kind: "member",
    key: "",
  };

  return (
    <section className="flex flex-col gap-4" data-testid="members-view">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
            {membersHeaderLine(teamName)}
          </p>
          {teamHandle.length === 0 ? null : (
            <DashboardLinkButton
              page={seatsPage}
              label={MANAGE_SEATS_LABEL}
              testId="members-seats-link"
            />
          )}
        </div>
        {viewerIsAdmin && membersReady ? (
          <Button
            type="button"
            onClick={() => setInviteOpen(true)}
            data-testid="members-invite"
          >
            {INVITE_LABEL}
          </Button>
        ) : null}
      </header>
      <MembersBanner
        banner={banner}
        teamName={teamName}
        teamHandle={teamHandle}
      />
      {showNotice ? (
        <LegacyRoleNotice
          teamName={teamName}
          names={legacyMembers}
          details={rowDetails(noticeSubject)}
        />
      ) : null}
      <MembersReadFallback
        membersRead={membersRead}
        teamName={teamName}
        onRetry={onRetryMembers}
      />
      {membersReady ? (
        <MembersList
          environmentId={environmentId}
          teamName={teamName}
          currentUserId={currentUserId}
          viewerIsAdmin={viewerIsAdmin}
          members={members}
          visibleMembers={listMembers}
          pendingCount={pendingCount}
          peopleCount={peopleCount}
          legacyMembers={legacyMembers}
          rowDetails={rowDetails}
          onRoleChange={openRoleChange}
          onRemove={openRemove}
        />
      ) : null}
      <InviteDialog
        open={inviteOpen}
        teamName={teamName}
        busy={inviteBusy}
        onOpenChange={setInviteOpen}
        onInvite={invite}
      />
      <RemovePreviewDialog
        open={removing !== null}
        memberName={targetName(removing)}
        teamName={teamName}
        preview={removePreview}
        busy={removeBusy}
        blockedReason={removeRefusal}
        onOpenChange={(open) => {
          if (!open) closeRemove();
        }}
        onRetry={() => {
          void removeQuery.refetch();
        }}
        onConfirm={confirmRemove}
      />
      <DemotionPreviewDialog
        open={demoting !== null}
        memberName={targetName(demoting)}
        teamName={teamName}
        nextRoleLabel={demotion === null ? "" : ROLE_LABELS[demotion.nextRole]}
        preview={demotionPreview}
        busy={demotionBusy}
        blockedReason={demotionRefusal}
        onOpenChange={(open) => {
          if (!open) closeDemotion();
        }}
        onRetry={() => {
          void demotionQuery.refetch();
        }}
        onConfirm={confirmDemotion}
      />
      <RevokeInviteDialog
        open={revoking !== null}
        teamName={teamName}
        member={revoking}
        busy={removeBusy}
        blockedReason={removeRefusal}
        onOpenChange={(open) => {
          if (!open) closeRemove();
        }}
        onConfirm={confirmRemove}
      />
    </section>
  );
}
