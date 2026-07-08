import { useMemo, useReducer } from "react";
import {
  useEpicBatchUpdateRoles,
  useEpicGrantAccess,
  useEpicRevokeCollaborator,
} from "@/hooks/epic/use-epic-collaborator-mutations";
import {
  useEpicShareableTeams,
  type EpicShareableTeam,
} from "@/hooks/epic/use-epic-shareable-teams";
import {
  EPIC_COLLABORATORS_OPEN_REFRESH_MS,
  useEpicCollaboratorsQuery,
  type EpicCollaboratorView,
  type EpicTeamCollaboratorView,
} from "@/hooks/epics/use-epic-collaborators-query";
import { useEpicSendQueuedInvites } from "@/hooks/epic/use-epic-send-queued-invites-mutation";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { InviteCardProps } from "./invite-card";
import type { TeamsAccessProps, PeopleWithAccessProps } from "./access-lists";
import type {
  TeamPendingState,
  TeamRow,
  RevokeDialogProps,
  RevokeTarget,
  SharingAccessLoadState,
  SharingPendingAction,
} from "./types";
import type { AssignableCollaboratorRole } from "@/lib/epic-collaborator-roles";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import {
  buildExistingInviteIndex,
  formatInviteLabel,
  inviteKey,
  parseInviteIdentifier,
  validateInviteInput,
  type ParsedInviteIdentifier,
  type QueuedInvite,
} from "@/lib/epic-invites";
import { toast } from "sonner";

const EMPTY_DIRECT_USERS: ReadonlyArray<EpicCollaboratorView> = [];
const EMPTY_TEAMS: ReadonlyArray<EpicTeamCollaboratorView> = [];

interface SharingPanelState {
  readonly inviteInput: string;
  readonly selectedRole: AssignableCollaboratorRole;
  readonly queuedInvites: ReadonlyArray<QueuedInvite>;
  readonly teamRolesById: Readonly<Record<string, AssignableCollaboratorRole>>;
  readonly revokeTarget: RevokeTarget | null;
  readonly pendingAction: SharingPendingAction | null;
}

type SharingPanelAction =
  | { readonly type: "set-invite-input"; readonly value: string }
  | {
      readonly type: "set-selected-role";
      readonly role: AssignableCollaboratorRole;
    }
  | { readonly type: "queue-invite"; readonly invite: ParsedInviteIdentifier }
  | { readonly type: "remove-queued-invite"; readonly inviteKey: string }
  | {
      readonly type: "drop-succeeded-invites";
      readonly succeededInviteKeys: ReadonlySet<string>;
    }
  | {
      readonly type: "set-team-role";
      readonly teamId: string;
      readonly role: AssignableCollaboratorRole;
    }
  | {
      readonly type: "set-revoke-target";
      readonly target: RevokeTarget | null;
    }
  | {
      readonly type: "set-pending-action";
      readonly pendingAction: SharingPendingAction | null;
    };

const INITIAL_SHARING_PANEL_STATE: SharingPanelState = {
  inviteInput: "",
  selectedRole: "viewer",
  queuedInvites: [],
  teamRolesById: {},
  revokeTarget: null,
  pendingAction: null,
};

export interface SharingRefreshProps {
  /** Epoch ms of the last successful collaborator fetch, or null before the
   * first load completes. */
  readonly lastFetchedAt: number | null;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => Promise<unknown>;
}

export interface SharingPanelController {
  readonly canInvitePeople: boolean;
  readonly showTeams: boolean;
  readonly inviteCardProps: InviteCardProps;
  readonly peopleHint: string;
  readonly peopleProps: PeopleWithAccessProps;
  readonly teamHint: string;
  readonly teamsProps: TeamsAccessProps;
  readonly revokeDialogProps: RevokeDialogProps;
  readonly refreshProps: SharingRefreshProps;
}

export function useEpicSharingPanelController(
  epicId: string,
): SharingPanelController {
  const currentRole = useEpicPermissionRole();
  const isOwner = currentRole === "owner";
  const canInvitePeople = currentRole === "owner" || currentRole === "editor";
  const shareableTeams = useEpicShareableTeams();

  const collaboratorsQuery = useEpicCollaboratorsQuery(epicId, {
    refetchInterval: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
    staleTime: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
  });
  const lastFetchedAt =
    collaboratorsQuery.query.dataUpdatedAt > 0
      ? collaboratorsQuery.query.dataUpdatedAt
      : null;
  const handleRefresh = () => collaboratorsQuery.query.refetch();

  const batchUpdateRoles = useEpicBatchUpdateRoles();
  const revokeCollaborator = useEpicRevokeCollaborator();
  const grantAccess = useEpicGrantAccess();
  const sendInvites = useEpicSendQueuedInvites();

  const [state, dispatch] = useReducer(
    sharingPanelReducer,
    INITIAL_SHARING_PANEL_STATE,
  );

  const collaborators = collaboratorsQuery.data;
  const directUsers = collaborators?.directUsers ?? EMPTY_DIRECT_USERS;
  const teams = collaborators?.teams ?? EMPTY_TEAMS;
  const teamRows = useMemo(
    () => buildTeamRows(teams, shareableTeams, isOwner),
    [isOwner, teams, shareableTeams],
  );
  const isLoading = computeIsLoading(collaboratorsQuery);
  const loadState = buildSharingAccessLoadState(
    isLoading,
    collaboratorsQuery.isError,
  );
  const directOwnerCount = directUsers.reduce(
    (count, collaborator) =>
      collaborator.role === "owner" ? count + 1 : count,
    0,
  );
  const isInvitePending = sendInvites.isPending;
  const teamPending = buildTeamPendingState({
    pendingAction: state.pendingAction,
    anyMutation:
      grantAccess.isPending ||
      batchUpdateRoles.isPending ||
      revokeCollaborator.isPending,
  });
  const trimmedInviteInput = state.inviteInput.trim();
  const parsedInvite = parseInviteIdentifier(trimmedInviteInput);
  const { inputError, canAddInvite } = validateInviteInput({
    parsedInvite,
    queuedInvites: state.queuedInvites,
    isInvitePending: isInvitePending || !canInvitePeople,
  });

  const handleAddToQueue = () => {
    if (!canInvitePeople || !canAddInvite || parsedInvite === null) return;
    dispatch({ type: "queue-invite", invite: parsedInvite });
  };

  const handleSendInvites = async () => {
    if (!canInvitePeople || state.queuedInvites.length === 0 || isInvitePending)
      return;

    let result;
    try {
      result = await sendInvites.mutateAsync({
        epicId,
        queuedInvites: state.queuedInvites,
        existingByInviteKey: buildExistingInviteIndex(directUsers),
      });
    } catch {
      return;
    }

    dispatch({
      type: "drop-succeeded-invites",
      succeededInviteKeys: result.succeededInviteKeys,
    });

    if (result.succeededNewInvites.length > 0) {
      toast.success(`Invited ${result.succeededNewInvites.length} people`);
    }

    result.succeededReInvites.forEach((invite) => {
      toast.success(`Role updated for ${formatInviteLabel(invite)}`);
    });

    if (result.failedInvites.length > 0) {
      toast.error(
        `Couldn't invite ${result.failedInvites.map(formatInviteLabel).join(", ")}`,
      );
    }
  };

  const handleUserRoleChange = (
    collaborator: EpicCollaboratorView,
    newRole: AssignableCollaboratorRole,
  ) => {
    if (!isOwner) return;
    if (collaborator.userId === null) return;
    dispatch({
      type: "set-pending-action",
      pendingAction: { kind: "role-user", userId: collaborator.userId },
    });
    batchUpdateRoles.mutate(
      {
        epicId,
        input: { changes: [{ userId: collaborator.userId, newRole }] },
      },
      {
        onSuccess: () => {
          toast.success("Role updated");
        },
        onSettled: () => {
          dispatch({ type: "set-pending-action", pendingAction: null });
        },
      },
    );
  };

  const handleTeamRoleChange = (
    team: TeamRow,
    newRole: AssignableCollaboratorRole,
  ) => {
    if (!isOwner) return;
    if (team.kind !== "shared") return;
    dispatch({
      type: "set-pending-action",
      pendingAction: {
        kind: "role-team",
        teamId: team.teamId,
      },
    });
    batchUpdateRoles.mutate(
      {
        epicId,
        input: {
          changes: [{ teamId: team.teamId, newRole }],
        },
      },
      {
        onSuccess: () => {
          toast.success("Team role updated");
        },
        onSettled: () => {
          dispatch({ type: "set-pending-action", pendingAction: null });
        },
      },
    );
  };

  const handleShareTeam = (team: TeamRow) => {
    if (!isOwner) return;
    if (team.kind !== "unshared") return;
    const role = state.teamRolesById[team.teamId] ?? "viewer";
    dispatch({
      type: "set-pending-action",
      pendingAction: {
        kind: "share-team",
        teamId: team.teamId,
      },
    });
    grantAccess.mutate(
      {
        epicId,
        input: {
          kind: "team",
          teamId: team.teamId,
          role,
        },
      },
      {
        onSuccess: () => {
          toast.success(`Shared with ${team.name}`);
          Analytics.getInstance().track(AnalyticsEvent.TaskShared, null);
        },
        onSettled: () => {
          dispatch({ type: "set-pending-action", pendingAction: null });
        },
      },
    );
  };

  const handleRevokeConfirm = () => {
    if (!isOwner) return;
    const target = state.revokeTarget;
    if (target === null) return;
    if (target.kind === "user") {
      const { collaborator } = target;
      if (collaborator.userId === null) return;
      dispatch({
        type: "set-pending-action",
        pendingAction: { kind: "revoke-user", userId: collaborator.userId },
      });
      revokeCollaborator.mutate(
        { epicId, input: { kind: "users", userId: collaborator.userId } },
        {
          onSuccess: () => {
            dispatch({ type: "set-revoke-target", target: null });
            toast.success("Collaborator removed");
          },
          onSettled: () => {
            dispatch({ type: "set-pending-action", pendingAction: null });
          },
        },
      );
      return;
    }

    dispatch({
      type: "set-pending-action",
      pendingAction: {
        kind: "revoke-team",
        teamId: target.team.teamId,
      },
    });
    revokeCollaborator.mutate(
      {
        epicId,
        input: {
          kind: "team",
          teamId: target.team.teamId,
        },
      },
      {
        onSuccess: () => {
          dispatch({ type: "set-revoke-target", target: null });
          toast.success("Team access removed");
        },
        onSettled: () => {
          dispatch({ type: "set-pending-action", pendingAction: null });
        },
      },
    );
  };

  return {
    canInvitePeople,
    showTeams: isLoading || collaboratorsQuery.isError || teamRows.length > 0,
    inviteCardProps: {
      inviteInput: state.inviteInput,
      inputError,
      selectedRole: state.selectedRole,
      queuedInvites: state.queuedInvites,
      isPending: isInvitePending,
      canAddInvite,
      onInputChange: (value) => {
        dispatch({ type: "set-invite-input", value });
      },
      onRoleChange: (role) => {
        dispatch({ type: "set-selected-role", role });
      },
      onAddToQueue: handleAddToQueue,
      onRemoveFromQueue: (invite) => {
        dispatch({
          type: "remove-queued-invite",
          inviteKey: inviteKey(invite),
        });
      },
      onSendInvites: () => {
        void handleSendInvites();
      },
    },
    peopleHint: buildPeopleHint(
      isLoading,
      collaboratorsQuery.isError,
      directUsers.length,
    ),
    peopleProps: {
      loadState,
      collaborators: directUsers,
      accessPermission: isOwner ? "owner" : "read_only",
      directOwnerCount,
      batchUpdateRolesPending: batchUpdateRoles.isPending,
      pendingRoleUserId: getPendingRoleUserId(state.pendingAction),
      pendingRevokeUserId: getPendingRevokeUserId(state.pendingAction),
      onRoleChange: handleUserRoleChange,
      onRevokeRequest: (collaborator) => {
        dispatch({
          type: "set-revoke-target",
          target: { kind: "user", collaborator },
        });
      },
    },
    teamHint: buildTeamHint(
      isLoading,
      collaboratorsQuery.isError,
      teams.length,
      isOwner ? shareableTeams.length : 0,
    ),
    teamsProps: {
      loadState,
      rows: teamRows,
      accessPermission: isOwner ? "owner" : "read_only",
      pending: teamPending,
      teamRolesById: state.teamRolesById,
      onPendingTeamRoleChange: (teamId, role) => {
        dispatch({ type: "set-team-role", teamId, role });
      },
      onShareTeam: handleShareTeam,
      onRoleChange: handleTeamRoleChange,
      onRevokeRequest: (team) => {
        if (team.kind !== "shared") return;
        dispatch({
          type: "set-revoke-target",
          target: {
            kind: "team",
            team: {
              key: team.key,
              teamId: team.teamId,
              teamName: team.name,
              role: team.role,
              members: team.members,
            },
          },
        });
      },
    },
    revokeDialogProps: {
      open: state.revokeTarget !== null,
      onOpenChange: (open) => {
        if (!open) dispatch({ type: "set-revoke-target", target: null });
      },
      title: buildRevokeTitle(state.revokeTarget),
      description: buildRevokeDescription(state.revokeTarget),
      isPending: revokeCollaborator.isPending,
      onConfirm: handleRevokeConfirm,
    },
    refreshProps: {
      lastFetchedAt,
      isRefreshing: collaboratorsQuery.isFetching,
      onRefresh: handleRefresh,
    },
  };
}

function sharingPanelReducer(
  state: SharingPanelState,
  action: SharingPanelAction,
): SharingPanelState {
  switch (action.type) {
    case "set-invite-input":
      return { ...state, inviteInput: action.value };
    case "set-selected-role":
      return { ...state, selectedRole: action.role };
    case "queue-invite":
      return {
        ...state,
        inviteInput: "",
        queuedInvites: [
          ...state.queuedInvites,
          { ...action.invite, role: state.selectedRole },
        ],
      };
    case "remove-queued-invite":
      return {
        ...state,
        queuedInvites: state.queuedInvites.filter(
          (invite) => inviteKey(invite) !== action.inviteKey,
        ),
      };
    case "drop-succeeded-invites":
      return {
        ...state,
        queuedInvites: state.queuedInvites.filter(
          (invite) => !action.succeededInviteKeys.has(inviteKey(invite)),
        ),
      };
    case "set-team-role":
      return {
        ...state,
        teamRolesById: {
          ...state.teamRolesById,
          [action.teamId]: action.role,
        },
      };
    case "set-revoke-target":
      return { ...state, revokeTarget: action.target };
    case "set-pending-action":
      return { ...state, pendingAction: action.pendingAction };
  }
}

function buildTeamRows(
  teams: ReadonlyArray<EpicTeamCollaboratorView>,
  shareableTeams: ReadonlyArray<EpicShareableTeam>,
  includeUnsharedTeams: boolean,
): ReadonlyArray<TeamRow> {
  const teamsById = new Map(shareableTeams.map((team) => [team.teamId, team]));
  const sharedIds = new Set(teams.map((team) => team.teamId));
  return [
    ...teams.map((team): TeamRow => {
      const shareable = teamsById.get(team.teamId);
      return {
        kind: "shared",
        key: team.key,
        teamId: team.teamId,
        name: team.teamName,
        avatarUrl: shareable?.avatarUrl ?? null,
        role: team.role,
        members: team.members,
      };
    }),
    ...(includeUnsharedTeams
      ? shareableTeams
          .filter((team) => !sharedIds.has(team.teamId))
          .map((team): TeamRow => ({
            kind: "unshared",
            key: `unshared-${team.teamId}`,
            teamId: team.teamId,
            name: team.slug,
            avatarUrl: team.avatarUrl,
          }))
      : []),
  ];
}

function buildPeopleHint(
  isLoading: boolean,
  isError: boolean,
  count: number,
): string {
  if (isLoading) return "Loading collaborators...";
  if (isError) return "Couldn't load collaborators.";
  const subject = count === 1 ? "person has" : "people have";
  return `${count} ${subject} direct access.`;
}

function buildTeamHint(
  isLoading: boolean,
  isError: boolean,
  sharedCount: number,
  availableCount: number,
): string {
  if (isLoading) return "Loading teams...";
  if (isError) return "Couldn't load teams.";
  if (sharedCount > 0) {
    const subject = sharedCount === 1 ? "team has" : "teams have";
    return `${sharedCount} ${subject} access.`;
  }
  if (availableCount > 0) return "Share with one of your teams.";
  return "No teams available.";
}

function buildRevokeTitle(target: RevokeTarget | null): string {
  if (target === null) return "Remove access?";
  if (target.kind === "user") {
    return `Remove ${target.collaborator.displayName}?`;
  }
  return `Remove ${target.team.teamName}?`;
}

function buildRevokeDescription(target: RevokeTarget | null): string {
  if (target?.kind === "team") {
    return "Everyone relying on this team grant will immediately lose access to this epic.";
  }
  return "They will immediately lose access to this epic, and any open sessions they have will be closed.";
}

function computeIsLoading(query: {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly data: unknown;
}): boolean {
  if (query.isLoading) return true;
  return query.isFetching && query.data === undefined;
}

function buildSharingAccessLoadState(
  isLoading: boolean,
  isError: boolean,
): SharingAccessLoadState {
  if (isLoading) return "loading";
  if (isError) return "error";
  return "ready";
}

function buildTeamPendingState(input: {
  readonly pendingAction: SharingPendingAction | null;
  readonly anyMutation: boolean;
}): TeamPendingState {
  const { pendingAction } = input;
  return {
    anyMutation: input.anyMutation,
    shareTeamId:
      pendingAction?.kind === "share-team" ? pendingAction.teamId : null,
    roleTeamId:
      pendingAction?.kind === "role-team" ? pendingAction.teamId : null,
    revokeTeamId:
      pendingAction?.kind === "revoke-team" ? pendingAction.teamId : null,
  };
}

function getPendingRoleUserId(
  pendingAction: SharingPendingAction | null,
): string | null {
  if (pendingAction?.kind !== "role-user") return null;
  return pendingAction.userId;
}

function getPendingRevokeUserId(
  pendingAction: SharingPendingAction | null,
): string | null {
  if (pendingAction?.kind !== "revoke-user") return null;
  return pendingAction.userId;
}
