import { useCallback, useMemo, useState } from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import { readConfigurationMembers } from "@traycer-clients/shared/environment/configuration-members";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  grantedEnvironmentRole,
  grantedTeamMemberRole,
  type EnvironmentDescriptorV11,
  type EnvironmentListResponseV11,
  type EnvironmentMembersResponseV12,
} from "@traycer/protocol/host/environment/contracts";
import type { TeamRole } from "@/components/settings/members/types";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  ENVIRONMENT_CLOUD_QUERY_SCOPE,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const METHOD = "environment.members";

const FIRST_PAGE: ReadonlyArray<string | null> = [null];

export interface EnvironmentMembersListMember {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  /** `null` for a member holding no seat authority: an older page's unknown
   *  role, or the retired view-only one. */
  readonly effectiveRole: TeamRole | null;
  readonly linkedPlan: boolean;
  readonly inviteState: "accepted" | "pending" | null;
  readonly invitedAddress: string | null;
}

export interface EnvironmentMembersListResult {
  readonly members: readonly EnvironmentMembersListMember[];
  readonly legacyMembers: readonly string[];
  readonly legacyRoleNoticeSeenAt: number | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: HostRpcError | null;
  /**
   * Reads every page that failed again; with none failed, every page (a row
   * with nothing to name it by asks for a fresh read).
   */
  readonly retry: () => void;
}

type Requested = {
  readonly environmentId: string | null;
  readonly viewerUserId: string;
  readonly cursors: ReadonlyArray<string | null>;
};

type CombinedPages = {
  readonly pages: ReadonlyArray<EnvironmentMembersResponseV12 | undefined>;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: HostRpcError | null;
  readonly retry: () => void;
};

function retryNothing(): void {}

const EMPTY_LIST: EnvironmentMembersListResult = {
  members: [],
  legacyMembers: [],
  legacyRoleNoticeSeenAt: null,
  isPending: false,
  isError: false,
  error: null,
  retry: retryNothing,
};

/** Where a page of members is cached: the app's own scope, by viewer. */
function membersPageKey(
  environmentId: string,
  cursor: string | null,
  viewerUserId: string,
): QueryKey {
  return [
    ...hostQueryKeys.scope(ENVIRONMENT_CLOUD_QUERY_SCOPE),
    METHOD,
    { environmentId, cursor },
    viewerUserId,
  ];
}

/**
 * Every page of `environment.members` for `environmentId`, the app's own
 * read of authn on the viewer's sign-in. The id is never rewritten to
 * Personal: Personal's page lists the reader alone, as the host answered it,
 * so the read waits for the account's environment list to say whose
 * environment this is. A page that fails surfaces as `isError` with an empty
 * list, so a truncated admin list is never shown as complete.
 * Pages are partitioned by viewer so an account switch cannot serve the
 * previous viewer's invitedAddress rows from the same cache.
 */
export function useEnvironmentMembersList(
  environmentId: string | null,
  enabled: boolean,
): EnvironmentMembersListResult {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  const viewerUserId = useCloudChatViewerId();
  const readerName = useAuthStore((state) => state.profile?.userName ?? "");
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const environments = useEnvironmentListQuery(
    enabled && environmentId !== null,
  );
  const ownerKind =
    environmentId === null
      ? undefined
      : environments.data?.environments.find(
          (environment) => environment.environmentId === environmentId,
        )?.ownerKind;
  const [requested, setRequested] = useState<Requested>({
    environmentId,
    viewerUserId,
    cursors: FIRST_PAGE,
  });
  let cursors = requested.cursors;
  if (
    requested.environmentId !== environmentId ||
    requested.viewerUserId !== viewerUserId
  ) {
    cursors = FIRST_PAGE;
    setRequested({ environmentId, viewerUserId, cursors });
  }
  const combine = useCallback(
    (
      results: Array<
        UseQueryResult<EnvironmentMembersResponseV12, HostRpcError>
      >,
    ): CombinedPages => {
      const errorResult = results.find((result) => result.error !== null);
      return {
        pages: results.map((result) => result.data),
        isPending: results.some((result) => result.isPending),
        isError: results.some((result) => result.isError),
        error: errorResult?.error ?? null,
        retry: () => {
          const failed = results.some((result) => result.isError);
          for (const result of results) {
            if (!failed || result.isError) void result.refetch();
          }
        },
      };
    },
    [],
  );
  const reader =
    ownerKind === "user"
      ? { userId: viewerUserId, displayName: readerName }
      : null;
  const combined = useQueries({
    queries:
      environmentId === null
        ? []
        : cursors.map((cursor) =>
            // `cloud` is the sign-in of the viewer the key already names, and
            // `reader` follows from the key's environment and viewer; adding
            // them would refetch on their identity alone.
            // eslint-disable-next-line @tanstack/query/exhaustive-deps
            queryOptions<EnvironmentMembersResponseV12, HostRpcError>({
              queryKey: membersPageKey(environmentId, cursor, viewerUserId),
              meta: stampHostRpcMethod(undefined, METHOD),
              queryFn: () =>
                withHostQueryErrorBoundary(METHOD, async () => {
                  cloudVerdictPreflight(METHOD)();
                  if (cloud === null) throw hostClientUnavailableError(METHOD);
                  try {
                    return await readConfigurationMembers(
                      cloud(),
                      environmentId,
                      cursor,
                      reader,
                    );
                  } catch (error) {
                    throw environmentCloudHostError(METHOD, error);
                  }
                }),
              enabled:
                enabled &&
                ownerKind !== undefined &&
                cloud !== null &&
                viewerUserId.length > 0 &&
                authorized,
              refetchOnWindowFocus: false,
            }),
          ),
    combine,
  });
  if (
    environmentId !== null &&
    viewerUserId.length > 0 &&
    combined.pages.length === cursors.length &&
    !combined.isError
  ) {
    const walked = cursorsNamedByPages(cursors, combined.pages, (cursor) =>
      queryClient.getQueryData<EnvironmentMembersResponseV12>(
        membersPageKey(environmentId, cursor, viewerUserId),
      ),
    );
    if (!sameCursors(walked, cursors)) {
      setRequested({ environmentId, viewerUserId, cursors: walked });
    }
  }
  return useMemo((): EnvironmentMembersListResult => {
    if (!enabled || environmentId === null) return EMPTY_LIST;
    if (viewerUserId.length === 0) {
      return {
        members: [],
        legacyMembers: [],
        legacyRoleNoticeSeenAt: null,
        isPending: true,
        isError: false,
        error: null,
        retry: retryNothing,
      };
    }
    // Whose environment this is was not read, so no page could be asked.
    const listFailed = ownerKind === undefined && environments.isError;
    if (listFailed) {
      return {
        members: [],
        legacyMembers: [],
        legacyRoleNoticeSeenAt: null,
        isPending: false,
        isError: true,
        error: environments.error,
        retry: () => {
          void environments.refetch();
        },
      };
    }
    if (combined.isError) {
      return {
        members: [],
        legacyMembers: [],
        legacyRoleNoticeSeenAt: null,
        isPending: false,
        isError: true,
        error: combined.error,
        retry: combined.retry,
      };
    }
    const lastAsked = combined.pages[combined.pages.length - 1];
    const walkComplete =
      lastAsked !== undefined && lastAsked.nextCursor === null;
    if (!walkComplete) {
      return {
        members: [],
        legacyMembers: [],
        legacyRoleNoticeSeenAt: null,
        isPending: true,
        isError: false,
        error: null,
        retry: retryNothing,
      };
    }
    const members: EnvironmentMembersListMember[] = [];
    for (const page of combined.pages) {
      if (page === undefined) continue;
      for (const member of page.members) {
        members.push({
          userId: member.userId,
          displayName: member.displayName,
          email: member.email,
          effectiveRole: grantedTeamMemberRole(member.effectiveRole),
          linkedPlan: member.linkedPlan,
          inviteState: member.inviteState,
          invitedAddress: member.invitedAddress,
        });
      }
    }
    const first = combined.pages[0];
    return {
      members,
      legacyMembers: first === undefined ? [] : first.legacyMembers,
      legacyRoleNoticeSeenAt:
        first === undefined ? null : first.legacyRoleNoticeSeenAt,
      isPending: combined.isPending,
      isError: false,
      error: null,
      retry: combined.retry,
    };
  }, [combined, enabled, environmentId, environments, ownerKind, viewerUserId]);
}

export interface TeamEnvironmentDescriptor {
  readonly teamName: string | null;
  readonly teamHandle: string;
  readonly viewerRole: TeamRole | null;
  readonly kind: "personal" | "team" | null;
}

const EMPTY_TEAM: TeamEnvironmentDescriptor = {
  teamName: null,
  teamHandle: "",
  viewerRole: null,
  kind: null,
};

/**
 * `environment.list@1.1` row for `environmentId`. Personal is reported as
 * `kind: "personal"` and never rewritten to another environment.
 */
export function useTeamEnvironmentDescriptor(
  environmentId: string | null,
): TeamEnvironmentDescriptor {
  const query = useEnvironmentListQuery(environmentId !== null);
  return useMemo((): TeamEnvironmentDescriptor => {
    if (environmentId === null) return EMPTY_TEAM;
    const data: EnvironmentListResponseV11 | undefined = query.data;
    if (data === undefined) return EMPTY_TEAM;
    const match = data.environments.find(
      (environment) => environment.environmentId === environmentId,
    );
    if (match === undefined) return EMPTY_TEAM;
    return descriptorFromListRow(match);
  }, [environmentId, query.data]);
}

function descriptorFromListRow(
  row: EnvironmentDescriptorV11,
): TeamEnvironmentDescriptor {
  const role = grantedEnvironmentRole(row.effectiveRole);
  return {
    teamName: row.label.length === 0 ? null : row.label,
    teamHandle: row.providerHandle ?? "",
    viewerRole: role === "owner" ? "admin" : role,
    kind: row.kind,
  };
}

function cursorsNamedByPages(
  asked: ReadonlyArray<string | null>,
  pages: ReadonlyArray<EnvironmentMembersResponseV12 | undefined>,
  cached: (cursor: string | null) => EnvironmentMembersResponseV12 | undefined,
): ReadonlyArray<string | null> {
  return walkChain((cursor) => {
    const index = asked.indexOf(cursor);
    return index === -1 ? cached(cursor) : pages[index];
  });
}

function walkChain(
  pageFor: (cursor: string | null) => EnvironmentMembersResponseV12 | undefined,
): ReadonlyArray<string | null> {
  const chain: Array<string | null> = [null];
  for (;;) {
    const next = pageFor(chain[chain.length - 1])?.nextCursor ?? null;
    if (next === null || chain.includes(next)) return chain;
    chain.push(next);
  }
}

function sameCursors(
  left: ReadonlyArray<string | null>,
  right: ReadonlyArray<string | null>,
): boolean {
  return (
    left.length === right.length &&
    left.every((cursor, index) => cursor === right[index])
  );
}
