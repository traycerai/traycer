import { useCallback, useMemo, useState } from "react";
import {
  useQueries,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentMember,
  EnvironmentMembersResponseV12,
} from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentMembersPages } from "@/hooks/environment/use-environment-members-list";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMember,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";

const FIRST_PAGE: ReadonlyArray<string | null> = [null];

/** The pages asked for, and whose list they were asked of. */
type Requested = {
  readonly environmentId: string | null;
  readonly viewerUserId: string;
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
 * The cache only EXTENDS a walk the observed answers drove: past the last
 * page asked for, a page the cache already holds is followed in the same
 * walk, so a warm cache of any number of pages - on mount, or exposed later
 * by an answer - is asked for in one render rather than one per page.
 *
 * The pages are the ones Members reads ({@link useEnvironmentMembersPages}),
 * under the same keys. A member no answered page lists - the list still
 * loading, a page refused or failed - resolves to null, and the conversation
 * shows their user id. While `enabled` is false nobody resolves, whatever an
 * earlier answer left in the cache.
 */
export function useEnvironmentMembers(
  environmentId: string | null,
  enabled: boolean,
): BotMemberResolver {
  return useEnvironmentMemberDirectory(environmentId, enabled).resolve;
}

/**
 * The environment's members as a list and as a resolver: the pages
 * {@link useEnvironmentMembers} reads, in order. The list is `null` until
 * every page asked for has answered, and while the gate is shut.
 */
interface EnvironmentMemberDirectory {
  readonly resolve: BotMemberResolver;
  readonly members: ReadonlyArray<EnvironmentMember> | null;
}

export function useEnvironmentMemberDirectory(
  environmentId: string | null,
  enabled: boolean,
): EnvironmentMemberDirectory {
  return useMemberPages(environmentId, enabled, enabled);
}

/**
 * The members of an environment as far as another surface has already loaded
 * them: the same pages under the same keys, observed with fetching off, so
 * this sends no request of its own. `readable` is the caller's cloud verdict;
 * while it is false nobody resolves, whatever the cache holds.
 */
export function useLoadedEnvironmentMembers(
  environmentId: string | null,
  readable: boolean,
): BotMemberResolver {
  return useMemberPages(environmentId, false, readable).resolve;
}

function useMemberPages(
  environmentId: string | null,
  fetchPages: boolean,
  readable: boolean,
): EnvironmentMemberDirectory {
  const queryClient = useQueryClient();
  const { viewerUserId, pageKey, pageOptions } = useEnvironmentMembersPages(
    environmentId,
    fetchPages,
  );
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
    // Another list starts from its first page.
    cursors = FIRST_PAGE;
    setRequested({ environmentId, viewerUserId, cursors });
  }
  const combine = useCallback(
    (
      results: Array<
        UseQueryResult<EnvironmentMembersResponseV12, HostRpcError>
      >,
    ): ReadonlyArray<EnvironmentMembersResponseV12 | undefined> =>
      results.map((result) => result.data),
    [],
  );
  const pages = useQueries({
    queries:
      environmentId === null
        ? []
        : cursors.map((cursor) => pageOptions(environmentId, cursor)),
    combine,
  });
  if (environmentId !== null && pages.length === cursors.length) {
    const walked = cursorsNamedByPages(cursors, pages, (cursor) =>
      queryClient.getQueryData<EnvironmentMembersResponseV12>(
        pageKey(environmentId, cursor),
      ),
    );
    if (!sameCursors(walked, cursors)) {
      setRequested({ environmentId, viewerUserId, cursors: walked });
    }
  }
  return useMemo((): EnvironmentMemberDirectory => {
    // A closed gate names nobody, whatever was answered before: the gate,
    // not the cache, decides.
    if (!readable) return { resolve: UNRESOLVED_BOT_MEMBERS, members: null };
    const byUserId = new Map<string, BotMember>();
    const members: EnvironmentMember[] = [];
    for (const page of pages) {
      for (const member of page?.members ?? []) {
        if (!byUserId.has(member.userId)) members.push(member);
        byUserId.set(member.userId, {
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
        });
      }
    }
    const complete =
      pages.length > 0 &&
      pages.every((page) => page !== undefined) &&
      pages.at(-1)?.nextCursor === null;
    return {
      resolve:
        byUserId.size === 0
          ? UNRESOLVED_BOT_MEMBERS
          : (userId) => byUserId.get(userId) ?? null,
      members: complete ? members : null,
    };
  }, [readable, pages]);
}

/**
 * The chain the observed pages name: the first page's null, then each
 * answered page's `nextCursor` in turn. A cursor not asked for yet is read
 * through `cached` and followed for as long as the cache holds its pages, so
 * a cached tail an observed page exposes costs one render, not one per page.
 * The walk ends at a page asked for and not answered (or not cached), at the
 * last page (`nextCursor` null), or at a cursor already on the chain, so a
 * page that repeats one cannot loop. `pages[i]` is the answer for `asked[i]`.
 *
 * Compiler-safe: the observed `pages` are an input, and they change on the
 * render that needs the walk; the cache only extends a walk they drove.
 */
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

/**
 * From the first page's null cursor through each page's `nextCursor`,
 * stopping at a page `pageFor` does not have, at the last page, or at a
 * cursor already on the chain.
 */
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
