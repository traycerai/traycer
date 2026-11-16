import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ConfigurationRemovalPreview } from "@traycer-clients/shared/environment/configuration-members";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentMembersRemovePreviewResponse } from "@traycer/protocol/host/environment/contracts";
import { DemotionPreviewDialog } from "@/components/settings/members/demotion-preview";
import { InviteDialog } from "@/components/settings/members/invite-dialog";
import { InviteSeatLine } from "@/components/settings/members/invite-seat-line";
import { LegacyRoleNotice } from "@/components/settings/members/legacy-notice";
import { MembersList } from "@/components/settings/members/members-list";
import { RemovePreviewDialog } from "@/components/settings/members/remove-preview";
import { RevokeInviteDialog } from "@/components/settings/members/revoke-invite-dialog";
import {
  INVITE_LABEL,
  LAST_ADMIN_REFUSAL,
  MEMBER_REMOVED_TOAST,
  REMOVE_FAILED,
  REMOVE_FORBIDDEN_REFUSAL,
  SET_ROLE_FAILED,
  SET_ROLE_FORBIDDEN_REFUSAL,
  LEGACY_NOTICE_READ_FAILED,
  MANAGE_SEATS_LABEL,
  RETRY_LABEL,
  acceptedPeopleCount,
  addPlanOnDashboardLabel,
  isRoleDemotion,
  memberDisplayName,
  memberFirstName,
  memberRemovedToastBody,
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
  MemberWorkNow,
  PreviewState,
  RemovePreviewModel,
  TeamRole,
} from "@/components/settings/members/types";
import { DashboardLinkButton } from "@/components/settings/host-scope/dashboard-link-button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentMemberWorkNow } from "@/hooks/environment/use-environment-member-work-now";
import { useEnvironmentMembersRemovalPreviewQuery } from "@/hooks/environment/use-environment-members-removal-preview-query";

type PendingRemove =
  | { readonly kind: "accepted"; readonly member: MembersListMember }
  | { readonly kind: "pending-invite"; readonly member: MembersListMember };

type PendingDemotion = {
  readonly member: MembersListMember;
  readonly nextRole: TeamRole;
};

/**
 * The two roles the demotion confirm asks about. A closed dialog asks about
 * nothing, and the member it last named is already gone from the state, so it
 * reads the lowest role rather than claiming one it cannot see. A member whose
 * seat carries no role cannot be demoted, so it reads the lowest role too.
 */
function demotionRoles(demotion: PendingDemotion | null): {
  readonly currentRole: TeamRole;
  readonly nextRole: TeamRole;
} {
  const currentRole = demotion?.member.effectiveRole ?? null;
  if (demotion === null || currentRole === null) {
    return { currentRole: "editor", nextRole: "editor" };
  }
  return { currentRole, nextRole: demotion.nextRole };
}

/**
 * A removal that committed says so, by the one name the rest of the page uses.
 * A revoked invitation removes nobody, so it says nothing.
 */
function announceRemoval(removed: PendingRemove, teamName: string): void {
  if (removed.kind !== "accepted") return;
  toast.success(MEMBER_REMOVED_TOAST, {
    description: memberRemovedToastBody(
      memberDisplayName(removed.member),
      teamName,
    ),
  });
}

/**
 * The removal confirm's preview from authn's read: the answer once read
 * (while no re-read after a failure is in flight), the failure once a read is
 * refused, and loading otherwise. Never an answer read for another member.
 */
function previewState(
  query: UseQueryResult<ConfigurationRemovalPreview, HostRpcError>,
  workNow: MemberWorkNow | null,
): PreviewState<RemovePreviewModel> {
  if (query.isError) {
    return query.isFetching ? { status: "loading" } : { status: "failed" };
  }
  if (query.data === undefined) return { status: "loading" };
  return {
    status: "ready",
    preview: { sandboxesToRekey: query.data.sandboxesToRekey, workNow },
  };
}

/**
 * The member's running work where the window's own host, a team computer,
 * counted it. No answer, or that host's "cannot count", is no count.
 */
function memberWorkNow(
  counts: EnvironmentMembersRemovePreviewResponse | null,
  hostLabel: (hostId: string) => string | null,
): MemberWorkNow | null {
  if (
    counts === null ||
    counts.activeTurns === null ||
    counts.terminals === null
  ) {
    return null;
  }
  return {
    activeTurns: counts.activeTurns,
    terminals: counts.terminals,
    hostName:
      counts.localHostId === null ? null : hostLabel(counts.localHostId),
  };
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
  if (outcome.outcome === "forbidden") return REMOVE_FORBIDDEN_REFUSAL;
  if (outcome.outcome === "failed") return REMOVE_FAILED;
  return null;
}

function refusalFromSetRole(
  teamName: string,
  outcome: MembersSetRoleOutcome,
): string | null {
  if (outcome.outcome === "last_admin") return LAST_ADMIN_REFUSAL;
  if (outcome.outcome === "plan_required") return planRequiredRefusal(teamName);
  if (outcome.outcome === "forbidden") return SET_ROLE_FORBIDDEN_REFUSAL;
  if (outcome.outcome === "failed") return SET_ROLE_FAILED;
  return null;
}

/**
 * The members read while it is not ready: loading, the failure on one line
 * with Retry, or a host that does not serve it, which only an update fixes.
 * An admin's failure names the one-time notice the same read carries.
 */
function MembersReadFallback(props: {
  readonly membersRead: MembersReadState;
  readonly teamName: string;
  readonly viewerIsAdmin: boolean;
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
  if (props.membersRead === "failed") {
    return (
      <p
        className="flex max-w-[72ch] flex-wrap items-baseline gap-x-1 text-ui-sm text-destructive"
        role="status"
        data-testid="members-read-failed"
      >
        {props.viewerIsAdmin
          ? LEGACY_NOTICE_READ_FAILED
          : membersReadFailed(props.teamName)}
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={props.onRetry}
        >
          {RETRY_LABEL}
        </Button>
      </p>
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
 * in flight shows loading, a failed one says so with Retry. The removal
 * confirm's preview is read for the member it names.
 */
export function MembersView(props: {
  readonly environmentId: string;
  readonly teamName: string;
  readonly teamHandle: string;
  readonly currentUserId: string;
  /** `null` for a reader holding no seat authority. */
  readonly viewerRole: TeamRole | null;
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
  /** Whether the invite, set-role and remove requests are in flight. */
  readonly invitePending: boolean;
  readonly setRolePending: boolean;
  readonly removePending: boolean;
  /** The name a host id shows as, null when this window does not know it. */
  readonly hostLabel: (hostId: string) => string | null;
  /** The admin dismissed the legacy-role notice; nothing else calls it. */
  readonly onNoticeSeen: () => void;
}): ReactNode {
  const {
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
    invitePending,
    setRolePending,
    removePending,
    hostLabel,
    onNoticeSeen,
  } = props;
  const viewerIsAdmin = props.viewerRole === "admin";
  const peopleCount = acceptedPeopleCount(members);
  const pendingCount = pendingInviteCount(members);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PendingRemove | null>(null);
  const [removeRefusal, setRemoveRefusal] = useState<string | null>(null);
  const [demotion, setDemotion] = useState<PendingDemotion | null>(null);
  const [demotionRefusal, setDemotionRefusal] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const removing = removeTargetOfKind(removeTarget, "accepted");
  const revoking = removeTargetOfKind(removeTarget, "pending-invite");
  const demoting = demotion === null ? null : demotion.member;
  const demotionRoleChange = demotionRoles(demotion);
  const removeQuery = useEnvironmentMembersRemovalPreviewQuery(
    environmentId,
    targetUserId(removing),
  );
  const workNowCounts = useEnvironmentMemberWorkNow(
    environmentId,
    targetUserId(removing),
  );
  const removePreview = previewState(
    removeQuery,
    memberWorkNow(workNowCounts, hostLabel),
  );

  const membersReady = membersRead === "ready";
  // Dismissed here: hidden at once, before the read that carries the seen
  // time comes back. Keyed by team so another team's notice still shows.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const showNotice =
    membersReady &&
    viewerIsAdmin &&
    legacyRoleNoticeSeenAt === null &&
    dismissedFor !== environmentId;
  const dismissNotice = (): void => {
    setDismissedFor(environmentId);
    onNoticeSeen();
  };

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

  const openInvite = (): void => {
    setInviteOpen(true);
  };

  /**
   * One role write for both paths, the promotion written straight through and
   * the confirmed demotion: a refusal is said in the banner and handed back,
   * so a dialog that asked for the change stays open on it.
   */
  const writeRole = (
    input: { readonly userId: string; readonly role: TeamRole },
    onRefused: (line: string) => void,
    onWritten: () => void,
  ): void => {
    void onSetRole(input).then((outcome) => {
      const refusal = refusalFromSetRole(teamName, outcome);
      if (refusal === null) {
        onWritten();
        return;
      }
      onRefused(refusal);
      setBanner(refusal);
    });
  };

  const openRoleChange = (member: MembersListMember, role: TeamRole): void => {
    const currentRole = member.effectiveRole;
    if (role === currentRole) return;
    // Every demotion is confirmed, because it takes something away; a
    // promotion gives, so it is written straight through. A seat with no
    // authority has nothing to take away, so naming a role for it promotes.
    if (currentRole !== null && isRoleDemotion(currentRole, role)) {
      setDemotion({ member, nextRole: role });
      return;
    }
    writeRole(
      { userId: member.userId, role },
      () => undefined,
      () => undefined,
    );
  };

  const confirmRemove = (): void => {
    if (removeTarget === null) return;
    const removed = removeTarget;
    void onRemove({ userId: removed.member.userId }).then((outcome) => {
      const refusal = refusalFromRemove(teamName, outcome);
      if (refusal !== null) {
        setRemoveRefusal(refusal);
        setBanner(refusal);
        return;
      }
      announceRemoval(removed, teamName);
      closeRemove();
    });
  };

  const confirmDemotion = (): void => {
    if (demotion === null) return;
    writeRole(
      { userId: demotion.member.userId, role: demotion.nextRole },
      setDemotionRefusal,
      closeDemotion,
    );
  };

  const seatsPage = (signInUrl: string): string => {
    return seatsManagementUrl(signInUrl, teamHandle) ?? signInUrl;
  };

  // The notice is about the update, not about one member, so it names no role.
  const noticeSubject: MembersDetailsSubject = {
    environmentId,
    kind: "member",
    key: "",
    roleLabel: null,
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
            onClick={openInvite}
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
          onDismiss={dismissNotice}
        />
      ) : null}
      <MembersReadFallback
        membersRead={membersRead}
        teamName={teamName}
        viewerIsAdmin={viewerIsAdmin}
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
          onRetry={onRetryMembers}
        />
      ) : null}
      <InviteDialog
        open={inviteOpen}
        teamName={teamName}
        busy={invitePending}
        seatLine={<InviteSeatLine environmentId={environmentId} />}
        onOpenChange={setInviteOpen}
        onInvite={onInvite}
      />
      <RemovePreviewDialog
        open={removing !== null}
        memberName={targetName(removing)}
        memberEmail={removing?.email ?? null}
        confirmName={removing === null ? "" : memberFirstName(removing)}
        teamName={teamName}
        preview={removePreview}
        busy={removePending}
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
        open={demotion !== null}
        memberName={targetName(demoting)}
        teamName={teamName}
        currentRole={demotionRoleChange.currentRole}
        nextRole={demotionRoleChange.nextRole}
        busy={setRolePending}
        blockedReason={demotionRefusal}
        onOpenChange={(open) => {
          if (!open) closeDemotion();
        }}
        onConfirm={confirmDemotion}
      />
      <RevokeInviteDialog
        open={revoking !== null}
        teamName={teamName}
        member={revoking}
        busy={removePending}
        blockedReason={removeRefusal}
        onOpenChange={(open) => {
          if (!open) closeRemove();
        }}
        onConfirm={confirmRemove}
      />
    </section>
  );
}
