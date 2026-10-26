import { useCallback, useMemo, useState } from "react";
import {
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RequiredHostMethodVersion } from "@traycer/protocol/host-transport/remote/rpc-types";
import type {
  EnvironmentDescriptorV11,
  EnvironmentListResponseV11,
  EnvironmentMembersResponseV12,
} from "@traycer/protocol/host/environment/contracts";
import type { TeamRole } from "@/components/settings/members/types";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  useHostQueries,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { queryKeys } from "@/lib/query-keys";

const METHOD = "environment.members";

/**
 * The members read the GUI needs: `@1.0` names no roles, and its upgrade
 * would show every member as a viewer. A `@1.1` host is still read: its
 * members upgrade with no email, and Members falls back to what it has.
 */
export const ENVIRONMENT_MEMBERS_FLOOR: RequiredHostMethodVersion = {
  method: METHOD,
  version: { major: 1, minor: 1 },
};

const FIRST_PAGE: ReadonlyArray<string | null> = [null];

const EMPTY_LIST_PARAMS = {};

export interface EnvironmentMembersListMember {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly effectiveRole: TeamRole;
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
  readonly hostId: string | null;
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

/**
 * Every page of `environment.members` (`@1.2` once the host serves it) for
 * `environmentId`. The id is never rewritten to Personal. A page that fails
 * surfaces as `isError` with an empty list, so a truncated admin list is
 * never shown as complete.
 * Pages are partitioned by viewer so an account switch cannot serve the
 * previous viewer's invitedAddress rows from the same host cache.
 */
export function useEnvironmentMembersList(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string | null,
  enabled: boolean,
): EnvironmentMembersListResult {
  const queryClient = useQueryClient();
  const servingClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  const hostId = useReactiveHostReadiness(servingClient).hostId;
  const viewerUserId = useCloudChatViewerId();
  const [requested, setRequested] = useState<Requested>({
    environmentId,
    hostId,
    viewerUserId,
    cursors: FIRST_PAGE,
  });
  let cursors = requested.cursors;
  if (
    requested.environmentId !== environmentId ||
    requested.hostId !== hostId ||
    requested.viewerUserId !== viewerUserId
  ) {
    cursors = FIRST_PAGE;
    setRequested({ environmentId, hostId, viewerUserId, cursors });
  }
  const requests = useMemo(
    (): ReadonlyArray<HostRequestSpec<HostRpcRegistry, typeof METHOD>> =>
      environmentId === null
        ? []
        : cursors.map((cursor) => ({
            method: METHOD,
            params: { environmentId, cursor },
          })),
    [environmentId, cursors],
  );
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
  const combined = useHostQueries<
    HostRpcRegistry,
    typeof METHOD,
    CombinedPages
  >({
    client: servingClient,
    requests,
    cacheKeyIdentity: viewerUserId,
    requiredHostMethodVersion: () => ENVIRONMENT_MEMBERS_FLOOR,
    options: {
      enabled: enabled && environmentId !== null && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    },
    combine,
  });
  if (
    environmentId !== null &&
    viewerUserId.length > 0 &&
    combined.pages.length === cursors.length &&
    !combined.isError
  ) {
    const walked = cursorsNamedByPages(cursors, combined.pages, (cursor) =>
      cachedPage(queryClient, hostId, viewerUserId, {
        environmentId,
        cursor,
      }),
    );
    if (!sameCursors(walked, cursors)) {
      setRequested({ environmentId, hostId, viewerUserId, cursors: walked });
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
          effectiveRole: member.effectiveRole,
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
  }, [combined, enabled, environmentId, viewerUserId]);
}

export interface TeamEnvironmentDescriptor {
  readonly teamName: string | null;
  readonly teamHandle: string;
  readonly viewerRole: TeamRole | null;
  readonly kind: "personal" | "team" | null;
  /** The hosts running the team, null until the list is read. */
  readonly hostCount: number | null;
}

const EMPTY_TEAM: TeamEnvironmentDescriptor = {
  teamName: null,
  teamHandle: "",
  viewerRole: null,
  kind: null,
  hostCount: null,
};

/**
 * `environment.list@1.1` row for `environmentId`. Personal is reported as
 * `kind: "personal"` and never rewritten to another environment.
 */
export function useTeamEnvironmentDescriptor(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string | null,
  enabled: boolean,
): TeamEnvironmentDescriptor {
  const servingClient = useMemo(
    () => (client === null ? null : resolvePoolTierHostClient(client)),
    [client],
  );
  const viewerUserId = useCloudChatViewerId();
  const query = useHostQuery<HostRpcRegistry, "environment.list">({
    cacheKeyIdentity: [viewerUserId],
    client: servingClient,
    method: "environment.list",
    params: EMPTY_LIST_PARAMS,
    options: {
      enabled: enabled && environmentId !== null && viewerUserId.length > 0,
      refetchOnWindowFocus: false,
    },
  });
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
  const role = row.effectiveRole;
  return {
    teamName: row.label.length === 0 ? null : row.label,
    teamHandle: row.providerHandle ?? "",
    viewerRole: role === "owner" ? "admin" : role,
    kind: row.kind,
    hostCount: row.hostCount,
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

function cachedPage(
  queryClient: QueryClient,
  hostId: string | null,
  viewerUserId: string,
  params: { readonly environmentId: string; readonly cursor: string | null },
): EnvironmentMembersResponseV12 | undefined {
  return queryClient.getQueryData<EnvironmentMembersResponseV12>([
    ...queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(
      hostId,
      METHOD,
      params,
    ),
    viewerUserId,
  ]);
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
