import { useCallback, useMemo } from "react";
import {
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentMembersResponse } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  useHostQueries,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMember,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";

const METHOD = "environment.members";

/**
 * `environment.members` for one environment, as a member resolver for a bot
 * conversation (Tracy Bots): every page, each asked for once the page before
 * it names its cursor.
 *
 * The pages to ask for are derived, never stored: each render walks the
 * chain the cached pages name now, from the first page's null cursor through
 * each `nextCursor`, in one pass, and asks for every page on it plus the
 * next one. So a page that answers re-renders through its query and the walk
 * goes one further; a refetched page that names another cursor re-routes the
 * pages after it; and a warm cache of any number of pages is followed in a
 * single render rather than one cursor per render.
 *
 * A member no answered page lists - the list still loading, a page refused
 * or failed - resolves to null, and the conversation shows their user id.
 * `enabled` is the capability gate the caller resolved with
 * `useHostMethodSupport` on the same client's host; while it is false nobody
 * resolves, whatever an earlier answer left in the cache.
 */
export function useEnvironmentMembers(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string | null,
  enabled: boolean,
): BotMemberResolver {
  const queryClient = useQueryClient();
  // The same host id the batch below keys its queries with.
  const hostId = useReactiveHostReadiness(client).hostId;
  // By value, so an unchanged chain keeps the same requests.
  const cursorsKey =
    environmentId === null
      ? "[]"
      : JSON.stringify(cursorsNamedByCache(queryClient, hostId, environmentId));
  const requests = useMemo(
    (): ReadonlyArray<HostRequestSpec<HostRpcRegistry, typeof METHOD>> =>
      environmentId === null
        ? []
        : parseCursors(cursorsKey).map((cursor) => ({
            method: METHOD,
            params: { environmentId, cursor },
          })),
    [environmentId, cursorsKey],
  );
  const combine = useCallback(
    (
      results: Array<UseQueryResult<EnvironmentMembersResponse, HostRpcError>>,
    ): ReadonlyArray<EnvironmentMembersResponse | undefined> =>
      results.map((result) => result.data),
    [],
  );
  const pages = useHostQueries<
    HostRpcRegistry,
    typeof METHOD,
    ReadonlyArray<EnvironmentMembersResponse | undefined>
  >({
    client,
    requests,
    cacheKeyIdentity: undefined,
    options: {
      enabled: enabled && environmentId !== null,
      refetchOnWindowFocus: false,
    },
    combine,
  });
  return useMemo((): BotMemberResolver => {
    // A host that cannot answer now names nobody, whatever it answered
    // before: the gate, not the cache, decides.
    if (!enabled) return UNRESOLVED_BOT_MEMBERS;
    const byUserId = new Map<string, BotMember>();
    for (const page of pages) {
      for (const member of page?.members ?? []) {
        byUserId.set(member.userId, {
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
        });
      }
    }
    if (byUserId.size === 0) return UNRESOLVED_BOT_MEMBERS;
    return (userId) => byUserId.get(userId) ?? null;
  }, [enabled, pages]);
}

/**
 * The cursors of every page to ask for: the first page's null, then each
 * cached page's `nextCursor` in turn, ending at the first cursor whose page
 * is not cached yet (the next to ask for), at the last page (`nextCursor`
 * null), or at a cursor already on the chain, so a page that repeats one
 * cannot loop. Read with the key `useHostQueries` gives each request.
 */
function cursorsNamedByCache(
  queryClient: QueryClient,
  hostId: string | null,
  environmentId: string,
): ReadonlyArray<string | null> {
  const cursors: Array<string | null> = [null];
  for (;;) {
    const cursor = cursors[cursors.length - 1];
    const page = queryClient.getQueryData<EnvironmentMembersResponse>(
      queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(hostId, METHOD, {
        environmentId,
        cursor,
      }),
    );
    const next = page?.nextCursor ?? null;
    if (next === null || cursors.includes(next)) return cursors;
    cursors.push(next);
  }
}

/** `cursorsKey` back into cursors: a JSON array of strings and nulls. */
function parseCursors(cursorsKey: string): ReadonlyArray<string | null> {
  const parsed: unknown = JSON.parse(cursorsKey);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (cursor): cursor is string | null =>
      cursor === null || typeof cursor === "string",
  );
}
