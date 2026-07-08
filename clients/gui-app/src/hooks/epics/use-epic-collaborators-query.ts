import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  CollaboratorEntry,
  ListEpicCollaboratorsResponse,
  PermissionRole,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { normalizeAvatarUrl } from "@/lib/avatar-url";

export const EPIC_COLLABORATORS_CLOSED_STALE_TIME_MS = 30_000;
export const EPIC_COLLABORATORS_OPEN_REFRESH_MS = 5 * 60_000;

export interface EpicCollaboratorView {
  readonly key: string;
  /** The underlying user id, used by role-change and revoke RPCs. Null only
   * when the entry lacks a resolvable user identity. */
  readonly userId: string | null;
  readonly displayName: string;
  readonly email: string;
  readonly handle: string;
  readonly avatarUrl: string | null;
  readonly role: PermissionRole;
  readonly accessSource: "direct-user" | "team";
  readonly teamId: string | null;
  readonly teamName: string | null;
}

export interface EpicTeamCollaboratorView {
  readonly key: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly role: PermissionRole;
  readonly members: ReadonlyArray<EpicCollaboratorView>;
}

export interface EpicCollaboratorsView {
  readonly directUsers: ReadonlyArray<EpicCollaboratorView>;
  readonly teams: ReadonlyArray<EpicTeamCollaboratorView>;
  readonly flatRows: ReadonlyArray<EpicCollaboratorView>;
}

export interface UseEpicCollaboratorsQueryResult {
  readonly query: UseQueryResult<ListEpicCollaboratorsResponse, HostRpcError>;
  readonly data: EpicCollaboratorsView | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: HostRpcError | null;
}

export interface UseEpicCollaboratorsQueryOptions {
  readonly staleTime: number | undefined;
  readonly refetchInterval: number | false | undefined;
}

/**
 * TanStack-Query-backed collaborators list keyed off the active host.
 * Returned data keeps direct-user grants separate from team grants so callers
 * can mutate the actual grant source instead of flattening team access into
 * person rows.
 *
 * Pass a 5-minute `staleTime` and `refetchInterval` while the Sharing panel is
 * open so out-of-band collaborator changes converge on a gentle cadence; the
 * panel also exposes a manual refresh control for on-demand updates. Polling is
 * focus-gated - `refetchIntervalInBackground` is off, so an open-but-unfocused
 * window stops ticking. The default remains a relaxed 30 s stale window with no
 * polling.
 */
export function useEpicCollaboratorsQuery(
  epicId: string,
  options: UseEpicCollaboratorsQueryOptions | null,
): UseEpicCollaboratorsQueryResult {
  const staleTime =
    options?.staleTime ?? EPIC_COLLABORATORS_CLOSED_STALE_TIME_MS;
  const refetchInterval = options?.refetchInterval ?? false;
  const client = useHostClient();
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.listCollaborators",
    params: { epicId },
    options: {
      refetchInterval,
      refetchIntervalInBackground: false,
      staleTime,
    },
  });

  const data = useMemo<EpicCollaboratorsView | undefined>(() => {
    if (query.data === undefined) return undefined;
    return projectCollaborators(query.data.collaborators);
  }, [query.data]);

  return {
    query,
    data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error ?? null,
  };
}

export function projectCollaborators(
  entries: ReadonlyArray<CollaboratorEntry>,
): EpicCollaboratorsView {
  const directUsers: EpicCollaboratorView[] = [];
  const teams: EpicTeamCollaboratorView[] = [];
  const flatRows: EpicCollaboratorView[] = [];

  entries.forEach((entry, i) => {
    const user = entry.user;
    if (user !== null && user !== undefined) {
      const row = buildUserView({
        entry,
        userId: user.userId,
        profile: user.profile,
        fallbackKey: `u-${i}`,
        accessSource: "direct-user",
        teamId: null,
        teamName: null,
      });
      directUsers.push(row);
      flatRows.push(row);
      return;
    }

    const team = entry.team;
    if (team !== null && team !== undefined) {
      const members = team.teamMembers.map((member, j) =>
        buildUserView({
          entry,
          userId: member.userId,
          profile: member.profile,
          fallbackKey: `t-${i}-${j}`,
          accessSource: "team",
          teamId: team.teamId,
          teamName: team.teamName,
        }),
      );
      teams.push({
        key: `team-${team.teamId}`,
        teamId: team.teamId,
        teamName: team.teamName,
        role: entry.role,
        members,
      });
      flatRows.push(...members);
    }
  });

  return { directUsers, teams, flatRows };
}

export function flattenCollaborators(
  entries: ReadonlyArray<CollaboratorEntry>,
): ReadonlyArray<EpicCollaboratorView> {
  return projectCollaborators(entries).flatRows;
}

interface BuildUserViewArgs {
  readonly entry: CollaboratorEntry;
  readonly userId: string;
  readonly profile: {
    avatarUrl: string;
    displayName: string;
    email: string;
    handle: string;
  } | null;
  readonly fallbackKey: string;
  readonly accessSource: EpicCollaboratorView["accessSource"];
  readonly teamId: string | null;
  readonly teamName: string | null;
}

function buildUserView(args: BuildUserViewArgs): EpicCollaboratorView {
  const {
    entry,
    userId,
    profile,
    fallbackKey,
    accessSource,
    teamId,
    teamName,
  } = args;
  const email = profile?.email ?? "";
  const handle = profile?.handle ?? "";
  const avatarUrl = normalizeAvatarUrl(profile?.avatarUrl ?? null);
  const displayName = resolveDisplayName(profile, email, userId);
  const resolvedUserId = userId.length > 0 ? userId : null;
  const sourceKey =
    accessSource === "direct-user" ? "user" : `team-${teamId ?? fallbackKey}`;
  const key = `${sourceKey}-${resolvedUserId ?? fallbackKey}`;
  return {
    key,
    userId: resolvedUserId,
    displayName,
    email,
    handle,
    avatarUrl,
    role: entry.role,
    accessSource,
    teamId,
    teamName,
  };
}

function resolveDisplayName(
  profile: { displayName: string } | null,
  email: string,
  userId: string,
): string {
  if (profile !== null && profile.displayName.length > 0) {
    return profile.displayName;
  }
  if (email.length > 0) return email;
  return userId;
}
