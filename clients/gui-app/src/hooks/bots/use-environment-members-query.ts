import { useCallback, useMemo, useState } from "react";
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

/** The pages asked for, and whose list they were asked of. */
type Requested = {
  readonly environmentId: string | null;
  readonly hostId: string | null;
  /** The cursor of every page asked for, the first page's null. */
  readonly cursors: ReadonlyArray<string | null>;
};

/**
 * `environment.members` for one environment, as a member resolver for a bot
 * conversation (Tracy Bots): every page, each asked for once the page before
 * it names its cursor.
 *
 * The chain of pages follows the ANSWERS this hook observes, never a read of
 * the query cache at render time: the React Compiler memoizes a render-time
 * cache read on its arguments alone, and a page that answered would then
 * re-render the hook with the cursors of its first render. Each render walks
 * the observed pages from the first page's null cursor through each
 * `nextCursor`; when that walk differs from what was asked - a newly named
 * page, a refetched page naming another cursor, a page turning terminal - the
 * asked-for list becomes the walk, once, for that render.
 *
 * The cache is read only to SEED that list, when the hook mounts or its
 * environment or host changes, so a warm cache of any number of pages is
 * asked for in one render rather than one page per render.
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
  const [requested, setRequested] = useState<Requested>(() => ({
    environmentId,
    hostId,
    cursors: cachedCursors(queryClient, hostId, environmentId),
  }));
  let cursors = requested.cursors;
  if (
    requested.environmentId !== environmentId ||
    requested.hostId !== hostId
  ) {
    // Another list: seed it from what the cache already holds for it.
    cursors = cachedCursors(queryClient, hostId, environmentId);
    setRequested({ environmentId, hostId, cursors });
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
  if (environmentId !== null && pages.length === cursors.length) {
    const walked = cursorsNamedByPages(cursors, pages);
    if (!sameCursors(walked, cursors)) {
      setRequested({ environmentId, hostId, cursors: walked });
    }
  }
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
 * The chain the observed pages name: the first page's null, then each
 * answered page's `nextCursor` in turn, ending at the first cursor whose page
 * has not answered (the next to ask for), at the last page (`nextCursor`
 * null), or at a cursor already on the chain, so a page that repeats one
 * cannot loop. `pages[i]` is the answer for `asked[i]`.
 */
function cursorsNamedByPages(
  asked: ReadonlyArray<string | null>,
  pages: ReadonlyArray<EnvironmentMembersResponse | undefined>,
): ReadonlyArray<string | null> {
  return walkChain((cursor) => {
    const index = asked.indexOf(cursor);
    return index === -1 ? undefined : pages[index];
  });
}

/**
 * The chain the cache already holds for one environment's list on one host,
 * read with the key `useHostQueries` gives each request. Only a seed: it is
 * read when the list changes, never to follow answers.
 */
function cachedCursors(
  queryClient: QueryClient,
  hostId: string | null,
  environmentId: string | null,
): ReadonlyArray<string | null> {
  if (environmentId === null) return [];
  return walkChain((cursor) =>
    queryClient.getQueryData<EnvironmentMembersResponse>(
      queryKeys.hostMethod<HostRpcRegistry, typeof METHOD>(hostId, METHOD, {
        environmentId,
        cursor,
      }),
    ),
  );
}

/**
 * From the first page's null cursor through each page's `nextCursor`,
 * stopping at a page `pageFor` does not have, at the last page, or at a
 * cursor already on the chain.
 */
function walkChain(
  pageFor: (cursor: string | null) => EnvironmentMembersResponse | undefined,
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
