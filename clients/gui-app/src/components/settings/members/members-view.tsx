import { useEffect, useState, type ReactNode } from "react";
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
  ROLE_LABELS,
  acceptedPeopleCount,
  addPlanOnDashboardLabel,
  membersHeaderLine,
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
  MembersRemoveOutcome,
  MembersSetRoleOutcome,
  PlanUnlinkPreviewModel,
  RemovePreviewModel,
  TeamRole,
} from "@/components/settings/members/types";
import { DashboardLinkButton } from "@/components/settings/host-scope/dashboard-link-button";
import { Button } from "@/components/ui/button";

type PendingRemove =
  | { readonly kind: "accepted"; readonly member: MembersListMember }
  | { readonly kind: "pending-invite"; readonly member: MembersListMember };

type PendingDemotion = {
  readonly member: MembersListMember;
  readonly nextRole: TeamRole;
};

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
 * Settings ▸ Members body: header, seats link, invite, legacy notice, the
 * list, and the invite / remove / demotion dialogs. E4's stub wraps this.
 */
export function MembersView(props: {
  readonly environmentId: string;
  readonly teamName: string;
  readonly teamHandle: string;
  readonly currentUserId: string;
  readonly viewerRole: TeamRole;
  readonly members: readonly MembersListMember[];
  readonly legacyMembers: readonly string[];
  readonly legacyRoleNoticeSeenAt: number | null;
  readonly rowDetails: (subject: MembersDetailsSubject) => ReactNode;
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
  readonly onLoadRemovePreview: (userId: string) => Promise<RemovePreviewModel>;
  readonly onLoadDemotionPreview: (
    userId: string,
  ) => Promise<PlanUnlinkPreviewModel>;
  readonly onNoticeSeen: () => void;
}): ReactNode {
  const {
    environmentId,
    teamName,
    teamHandle,
    currentUserId,
    members,
    legacyMembers,
    legacyRoleNoticeSeenAt,
    rowDetails,
    onInvite,
    onSetRole,
    onRemove,
    onLoadRemovePreview,
    onLoadDemotionPreview,
    onNoticeSeen,
  } = props;
  const viewerIsAdmin = props.viewerRole === "admin";
  const peopleCount = acceptedPeopleCount(members);
  const pendingCount = pendingInviteCount(members);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PendingRemove | null>(null);
  const [removePreview, setRemovePreview] = useState<RemovePreviewModel | null>(
    null,
  );
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeRefusal, setRemoveRefusal] = useState<string | null>(null);
  const [demotion, setDemotion] = useState<PendingDemotion | null>(null);
  const [demotionPreview, setDemotionPreview] =
    useState<PlanUnlinkPreviewModel | null>(null);
  const [demotionBusy, setDemotionBusy] = useState(false);
  const [demotionRefusal, setDemotionRefusal] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const showNotice = viewerIsAdmin && legacyRoleNoticeSeenAt === null;

  useEffect(() => {
    if (!showNotice) return;
    onNoticeSeen();
  }, [showNotice, onNoticeSeen]);

  const listMembers = viewerIsAdmin
    ? members
    : members.filter((member) => member.inviteState !== "pending");

  const openRemove = (member: MembersListMember): void => {
    setRemoveRefusal(null);
    if (member.inviteState === "pending") {
      setRemoveTarget({ kind: "pending-invite", member });
      setRemovePreview(null);
      return;
    }
    setRemoveTarget({ kind: "accepted", member });
    setRemovePreview(null);
    void onLoadRemovePreview(member.userId).then((preview) => {
      setRemovePreview(preview);
    });
  };

  const openRoleChange = (member: MembersListMember, role: TeamRole): void => {
    if (role === member.effectiveRole) return;
    if (member.effectiveRole === "admin" && role !== "admin") {
      setDemotionRefusal(null);
      setDemotion({ member, nextRole: role });
      setDemotionPreview(null);
      void onLoadDemotionPreview(member.userId).then((preview) => {
        setDemotionPreview(preview);
      });
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
          setRemoveTarget(null);
          setRemovePreview(null);
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
          setDemotion(null);
          setDemotionPreview(null);
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
  const planPage = (signInUrl: string): string => {
    return teamPlanUrl(signInUrl, teamHandle) ?? signInUrl;
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
        {viewerIsAdmin ? (
          <Button
            type="button"
            onClick={() => setInviteOpen(true)}
            data-testid="members-invite"
          >
            {INVITE_LABEL}
          </Button>
        ) : null}
      </header>
      {banner === null ? null : (
        <div
          className="flex flex-wrap items-center gap-2"
          role="status"
          data-testid="members-banner"
        >
          <p className="max-w-[72ch] text-ui-sm text-destructive">{banner}</p>
          {banner === planRequiredRefusal(teamName) && teamHandle.length > 0 ? (
            <DashboardLinkButton
              page={planPage}
              label={addPlanOnDashboardLabel()}
              testId="members-plan-required-link"
            />
          ) : null}
        </div>
      )}
      {showNotice ? (
        <LegacyRoleNotice
          teamName={teamName}
          names={legacyMembers}
          details={rowDetails(noticeSubject)}
        />
      ) : null}
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
      <InviteDialog
        open={inviteOpen}
        teamName={teamName}
        busy={inviteBusy}
        onOpenChange={setInviteOpen}
        onInvite={invite}
      />
      <RemovePreviewDialog
        open={removeTarget !== null && removeTarget.kind === "accepted"}
        teamName={teamName}
        preview={removePreview}
        busy={removeBusy}
        blockedReason={removeRefusal}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setRemovePreview(null);
            setRemoveRefusal(null);
          }
        }}
        onConfirm={confirmRemove}
      />
      <DemotionPreviewDialog
        open={demotion !== null}
        teamName={teamName}
        nextRoleLabel={demotion === null ? "" : ROLE_LABELS[demotion.nextRole]}
        preview={demotionPreview}
        busy={demotionBusy}
        blockedReason={demotionRefusal}
        onOpenChange={(open) => {
          if (!open) {
            setDemotion(null);
            setDemotionPreview(null);
            setDemotionRefusal(null);
          }
        }}
        onConfirm={confirmDemotion}
      />
      <RevokeInviteDialog
        open={removeTarget !== null && removeTarget.kind === "pending-invite"}
        teamName={teamName}
        member={
          removeTarget !== null && removeTarget.kind === "pending-invite"
            ? removeTarget.member
            : null
        }
        busy={removeBusy}
        blockedReason={removeRefusal}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setRemoveRefusal(null);
          }
        }}
        onConfirm={confirmRemove}
      />
    </section>
  );
}
