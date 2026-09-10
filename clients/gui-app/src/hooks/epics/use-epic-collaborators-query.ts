import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  CollaboratorEntry,
  ListEpicCollaboratorsResponse,
  PermissionRole,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { normalizeAvatarUrl } from "@/lib/avatar-url";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

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
  /**
   * The host to ask, explicitly. Inside an Epic tab this must be the Epic
   * session's client (`useEpicSessionHostClient()`), never the app-active
   * host — a retained tab whose owning host is still connected would
   * otherwise answer from whichever host the app moved to. `null` disables
   * the query until a client exists.
   */
  readonly client: HostRequester<HostRpcRegistry> | null;
  /**
   * Whether this caller may SPEND the account's cloud capability on the list.
   *
   * `epic.listCollaborators` resolves grants against the account's servers, so
   * it is a spend and not a local read - which makes it the wrong side of this
   * PR's split. A surface stays MOUNTED under `unverified` (`admitsLocalPlane`)
   * and may render whatever the local plane already holds; it does not thereby
   * acquire permission to ask the cloud who else has access.
   *
   * Required rather than defaulted, and required rather than read from the auth
   * store in here: three surfaces mount this hook and they do not all resolve
   * the question the same way, so the answer belongs at the call site where it
   * can be seen. A default of `true` would be the opposite - a decision nobody
   * made, recorded by the type system as though someone had.
   *
   * ANDed with the hook's own gates; it never overrides the null-client one.
   */
  readonly enabled: boolean;
  readonly poll: boolean | undefined;
  readonly staleTime: number | undefined;
}

/**
 * TanStack-Query-backed collaborators list, keyed off the caller-chosen host.
 * Returned data keeps direct-user grants separate from team grants so callers
 * can mutate the actual grant source instead of flattening team access into
 * person rows.
 *
 * Pass `poll: true` while the Sharing panel is open so out-of-band collaborator
 * changes converge on the table-owned five-minute cadence; the panel also
 * exposes a manual refresh control for on-demand updates. The fixed builder
 * keeps polling focus-gated. The default remains a relaxed 30 s stale window
 * with no polling.
 *
 * `options.enabled` is the cloud-authorization gate every caller must answer -
 * see {@link UseEpicCollaboratorsQueryOptions.enabled}. It holds at all three
 * edges, in here, so that no consumer has to remember it:
 *
 * - the NEXT fetch (`enabled` on the query);
 * - the DISPATCH of a fetch already committed to - a `refetch()` override, or
 *   the transient-retry episode running when the session is demoted, which a
 *   same-user demotion would otherwise carry through on the retained host
 *   credential (`preflight`, the same read every other cloud-gated query
 *   makes);
 * - the PROJECTION. `enabled: false` stops fetching, but TanStack keeps the
 *   last `data` on the shared cache entry, and a consumer that read only
 *   `data` kept rendering the grants it loaded under the verdict the session
 *   has since lost - the "Shared with task" glyph stayed on a chat after
 *   demotion for as long as the tab lived. Withheld means `data: undefined`,
 *   whatever the cache still holds, which every consumer renders as "not
 *   loaded" rather than as an empty grant set.
 */
export function useEpicCollaboratorsQuery(
  epicId: string,
  options: UseEpicCollaboratorsQueryOptions,
): UseEpicCollaboratorsQueryResult {
  const staleTime =
    options.staleTime ?? EPIC_COLLABORATORS_CLOSED_STALE_TIME_MS;
  const poll = options.poll ?? false;
  const client = options.client;
  const enabled = options.enabled;
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.listCollaborators",
    params: { epicId },
    preflight: cloudVerdictPreflight("epic.listCollaborators"),
    options: {
      enabled,
      poll,
      staleTime,
    },
  });

  const data = useMemo<EpicCollaboratorsView | undefined>(() => {
    if (!enabled || query.data === undefined) return undefined;
    return projectCollaborators(query.data.collaborators);
  }, [enabled, query.data]);

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
