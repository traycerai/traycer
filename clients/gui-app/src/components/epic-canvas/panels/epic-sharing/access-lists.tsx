import { Trash2, UserPlus, Users } from "lucide-react";
import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import {
  createReportIssueContext,
  type ReportIssueContext,
} from "@/lib/report-issue-context";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ROLE_PILL_CLASS,
  RoleBadge,
  RoleDropdown,
  RoleOrBadge,
} from "./role-control";
import type {
  TeamPendingState,
  TeamRow,
  SharingAccessLoadState,
  SharingAccessPermission,
} from "./types";
import type { EpicCollaboratorView } from "@/hooks/epics/use-epic-collaborators-query";
import { computeInitials } from "@/lib/auth/compute-initials";
import { type AssignableCollaboratorRole } from "@/lib/epic-collaborator-roles";
import { formatGithubHandle } from "@/lib/epic-invites";

export interface PeopleWithAccessProps {
  readonly loadState: SharingAccessLoadState;
  readonly collaborators: ReadonlyArray<EpicCollaboratorView>;
  readonly accessPermission: SharingAccessPermission;
  readonly directOwnerCount: number;
  readonly batchUpdateRolesPending: boolean;
  readonly pendingRoleUserId: string | null;
  readonly pendingRevokeUserId: string | null;
  readonly onRoleChange: (
    collaborator: EpicCollaboratorView,
    newRole: AssignableCollaboratorRole,
  ) => void;
  readonly onRevokeRequest: (collaborator: EpicCollaboratorView) => void;
}

export interface TeamsAccessProps {
  readonly loadState: SharingAccessLoadState;
  readonly rows: ReadonlyArray<TeamRow>;
  readonly accessPermission: SharingAccessPermission;
  readonly pending: TeamPendingState;
  readonly teamRolesById: Readonly<Record<string, AssignableCollaboratorRole>>;
  readonly onPendingTeamRoleChange: (
    teamId: string,
    role: AssignableCollaboratorRole,
  ) => void;
  readonly onShareTeam: (team: TeamRow) => void;
  readonly onRoleChange: (
    team: TeamRow,
    newRole: AssignableCollaboratorRole,
  ) => void;
  readonly onRevokeRequest: (team: TeamRow) => void;
}

const COLLABORATORS_LOAD_ERROR_CONTEXT = createReportIssueContext({
  title: "Couldn't load collaborators",
  message: "Epic collaborators could not be loaded.",
  code: null,
  source: "Epic sharing",
});

const TEAMS_LOAD_ERROR_CONTEXT = createReportIssueContext({
  title: "Couldn't load teams",
  message: "Epic teams could not be loaded.",
  code: null,
  source: "Epic sharing",
});

export function PeopleWithAccess(props: PeopleWithAccessProps) {
  if (props.loadState === "loading") return <SharingLoadingRows />;
  if (props.loadState === "error") {
    return (
      <SharingError
        label="Couldn't load collaborators."
        reportContext={COLLABORATORS_LOAD_ERROR_CONTEXT}
      />
    );
  }
  if (props.collaborators.length === 0) {
    return (
      <SharingEmpty
        icon={<UserPlus className="size-3.5" />}
        label="No direct collaborators yet."
      />
    );
  }
  return (
    <ul
      className="flex flex-col divide-y divide-border/50"
      data-testid="epic-sharing-people-list"
    >
      {props.collaborators.map((collaborator) => (
        <CollaboratorRow
          key={collaborator.key}
          collaborator={collaborator}
          isOwner={props.accessPermission === "owner"}
          isLastOwner={
            collaborator.role === "owner" && props.directOwnerCount === 1
          }
          batchUpdateRolesPending={props.batchUpdateRolesPending}
          isRoleUpdatePending={props.pendingRoleUserId === collaborator.userId}
          isRevokePending={props.pendingRevokeUserId === collaborator.userId}
          onRoleChange={(newRole) => {
            props.onRoleChange(collaborator, newRole);
          }}
          onRevokeRequest={() => {
            props.onRevokeRequest(collaborator);
          }}
        />
      ))}
    </ul>
  );
}

export function TeamsAccess(props: TeamsAccessProps) {
  if (props.loadState === "loading") return <SharingLoadingRows />;
  if (props.loadState === "error") {
    return (
      <SharingError
        label="Couldn't load teams."
        reportContext={TEAMS_LOAD_ERROR_CONTEXT}
      />
    );
  }
  if (props.rows.length === 0) {
    return (
      <SharingEmpty
        icon={<Users className="size-3.5" />}
        label="No teams available."
      />
    );
  }
  return (
    <ul
      className="flex flex-col divide-y divide-border/50"
      data-testid="epic-sharing-teams-list"
    >
      {props.rows.map((row) => (
        <TeamAccessRow
          key={row.key}
          row={row}
          isOwner={props.accessPermission === "owner"}
          isPending={props.pending.anyMutation}
          isSharePending={props.pending.shareTeamId === row.teamId}
          isRoleUpdatePending={props.pending.roleTeamId === row.teamId}
          isRevokePending={props.pending.revokeTeamId === row.teamId}
          pendingRole={props.teamRolesById[row.teamId] ?? "viewer"}
          onPendingRoleChange={(role) => {
            props.onPendingTeamRoleChange(row.teamId, role);
          }}
          onShare={() => {
            props.onShareTeam(row);
          }}
          onRoleChange={(role) => {
            props.onRoleChange(row, role);
          }}
          onRevoke={() => {
            props.onRevokeRequest(row);
          }}
        />
      ))}
    </ul>
  );
}

function SharingLoadingRows() {
  return (
    <ul
      className="flex flex-col gap-2"
      data-testid="epic-sharing-loading"
      aria-busy="true"
    >
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3">
          <Skeleton className="size-7 rounded-full" />
          <div className="flex flex-1 flex-col gap-1">
            <Skeleton className="h-3 w-1/3 rounded" />
            <Skeleton className="h-3 w-1/2 rounded" />
          </div>
          <Skeleton className="h-5 w-16 rounded-md" />
        </li>
      ))}
    </ul>
  );
}

function SharingError(props: {
  readonly label: string;
  readonly reportContext: ReportIssueContext;
}) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border border-dashed border-destructive/40 px-3 py-2 text-ui-xs text-destructive"
      data-testid="epic-sharing-error"
    >
      <span>{props.label}</span>
      <ReportIssueAction
        context={props.reportContext}
        presentation="icon"
        className={undefined}
      />
    </div>
  );
}

function SharingEmpty(props: { icon: ReactNode; label: string }) {
  return (
    <p
      className="flex items-center gap-1.5 rounded-md border border-dashed border-border/60 px-3 py-2 text-ui-xs text-muted-foreground"
      data-testid="epic-sharing-empty"
    >
      {props.icon}
      {props.label}
    </p>
  );
}

function CollaboratorRow(props: {
  collaborator: EpicCollaboratorView;
  isOwner: boolean;
  isLastOwner: boolean;
  batchUpdateRolesPending: boolean;
  isRoleUpdatePending: boolean;
  isRevokePending: boolean;
  onRoleChange: (newRole: AssignableCollaboratorRole) => void;
  onRevokeRequest: () => void;
}) {
  const {
    collaborator,
    isOwner,
    isLastOwner,
    batchUpdateRolesPending,
    isRoleUpdatePending,
    isRevokePending,
  } = props;
  const initials = computeInitials(
    collaborator.displayName,
    collaborator.email,
  );
  const secondaryText =
    collaborator.email || formatGithubHandle(collaborator.handle);
  const canChangeRole = isOwner && !isLastOwner && collaborator.userId !== null;
  const canRevoke = isOwner && !isLastOwner && collaborator.userId !== null;
  const lastOwnerTitle = isLastOwner ? "Transfer ownership first." : undefined;

  return (
    <li
      className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
      data-testid="epic-sharing-row"
    >
      <Avatar size="sm">
        {collaborator.avatarUrl !== null ? (
          <AvatarImage src={collaborator.avatarUrl} alt="" />
        ) : null}
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui-sm text-foreground">
          {collaborator.displayName}
        </p>
        {secondaryText.length > 0 ? (
          <p className="truncate text-ui-xs text-muted-foreground">
            {secondaryText}
          </p>
        ) : null}
      </div>
      <CollaboratorRoleControl
        collaborator={collaborator}
        canChangeRole={canChangeRole}
        isLastOwner={isLastOwner}
        batchUpdateRolesPending={batchUpdateRolesPending}
        isPending={isRoleUpdatePending}
        lastOwnerTitle={lastOwnerTitle}
        onRoleChange={props.onRoleChange}
      />
      {isOwner && collaborator.userId !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={canRevoke ? props.onRevokeRequest : undefined}
          disabled={!canRevoke || isRevokePending}
          title={lastOwnerTitle}
          aria-label={`Remove ${collaborator.displayName}`}
          className="text-muted-foreground hover:text-destructive disabled:opacity-30"
          data-testid="collaborator-revoke-button"
        >
          {isRevokePending ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId="collaborator-revoke-spinner"
              variant={undefined}
            />
          ) : (
            <Trash2 className="size-3.5" />
          )}
        </Button>
      ) : null}
    </li>
  );
}

function TeamAccessRow(props: {
  row: TeamRow;
  isOwner: boolean;
  isPending: boolean;
  isSharePending: boolean;
  isRoleUpdatePending: boolean;
  isRevokePending: boolean;
  pendingRole: AssignableCollaboratorRole;
  onPendingRoleChange: (role: AssignableCollaboratorRole) => void;
  onShare: () => void;
  onRoleChange: (role: AssignableCollaboratorRole) => void;
  onRevoke: () => void;
}) {
  const {
    row,
    isOwner,
    isPending,
    isSharePending,
    isRoleUpdatePending,
    isRevokePending,
    pendingRole,
  } = props;
  const initials = row.name.slice(0, 1).toUpperCase();
  const memberLabel =
    row.kind === "shared" ? buildMemberLabel(row.members.length) : "Not shared";

  return (
    <li
      className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
      data-testid="team-access-row"
    >
      <Avatar size="sm">
        {row.avatarUrl !== null ? (
          <AvatarImage src={row.avatarUrl} alt="" />
        ) : null}
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui-sm font-medium text-foreground">
          {row.name}
        </p>
        <p className="truncate text-ui-xs text-muted-foreground">
          {memberLabel}
        </p>
      </div>
      {row.kind === "shared" ? (
        <>
          <RoleOrBadge
            value={row.role}
            canChange={isOwner}
            disabled={isPending}
            isPending={isRoleUpdatePending}
            ariaLabel={`Change role for ${row.name}`}
            testId="team-role-select"
            onChange={props.onRoleChange}
          />
          {isOwner ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={props.onRevoke}
              disabled={isPending}
              aria-label={`Remove ${row.name}`}
              className="text-muted-foreground hover:text-destructive disabled:opacity-30"
              data-testid="team-revoke-button"
            >
              {isRevokePending ? (
                <AgentSpinningDots
                  className="text-muted-foreground"
                  testId="team-revoke-spinner"
                  variant={undefined}
                />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <RoleOrBadge
            value={pendingRole}
            canChange={isOwner}
            disabled={isPending}
            isPending={false}
            ariaLabel={`Role for ${row.name}`}
            testId="team-pending-role-select"
            onChange={props.onPendingRoleChange}
          />
          {isOwner ? (
            <Button
              type="button"
              size="sm"
              onClick={props.onShare}
              disabled={isPending}
              data-testid="team-share-button"
            >
              {isSharePending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="team-share-spinner"
                  variant={undefined}
                />
              ) : null}
              Share
            </Button>
          ) : null}
        </>
      )}
    </li>
  );
}

function CollaboratorRoleControl(props: {
  readonly collaborator: EpicCollaboratorView;
  readonly canChangeRole: boolean;
  readonly isLastOwner: boolean;
  readonly batchUpdateRolesPending: boolean;
  readonly isPending: boolean;
  readonly lastOwnerTitle: string | undefined;
  readonly onRoleChange: (newRole: AssignableCollaboratorRole) => void;
}): ReactNode {
  const {
    collaborator,
    canChangeRole,
    isLastOwner,
    batchUpdateRolesPending,
    isPending,
    lastOwnerTitle,
    onRoleChange,
  } = props;

  if (canChangeRole) {
    return (
      <RoleDropdown
        value={collaborator.role}
        onChange={onRoleChange}
        disabled={batchUpdateRolesPending}
        isPending={isPending}
        className={ROLE_PILL_CLASS}
        aria-label={`Change role for ${collaborator.displayName}`}
        data-testid="collaborator-role-select"
      />
    );
  }
  return (
    <RoleBadge
      value={collaborator.role}
      testId={
        isLastOwner ? "collaborator-role-last-owner" : "collaborator-role-badge"
      }
      ariaLabel={
        isLastOwner ? `Change role for ${collaborator.displayName}` : undefined
      }
      title={lastOwnerTitle}
    />
  );
}

function buildMemberLabel(count: number): string {
  if (count === 0) return "No active members listed";
  if (count === 1) return "1 active member";
  return `${count} active members`;
}
