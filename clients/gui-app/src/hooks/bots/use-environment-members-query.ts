import { useCallback, useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentMembersResponse } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostQueries,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMember,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";

const METHOD = "environment.members";

const FIRST_PAGE: ReadonlyArray<string | null> = [null];

type PageChain = {
  readonly environmentId: string | null;
  /** The cursor of every page asked for so far, the first page's null. */
  readonly cursors: ReadonlyArray<string | null>;
};

/**
 * `environment.members` for one environment, as a member resolver for a bot
 * conversation (Tracy Bots): every page, each asked for once the page before
 * it names its cursor.
 *
 * A member no answered page lists - the list still loading, a page refused
 * or failed, or a host that cannot answer (`enabled` false) - resolves to
 * null, and the conversation shows their user id. `enabled` is the
 * capability gate the caller resolved with `useHostMethodSupport` on the same
 * client's host.
 */
export function useEnvironmentMembers(
  client: HostClient<HostRpcRegistry> | null,
  environmentId: string | null,
  enabled: boolean,
): BotMemberResolver {
  const [chain, setChain] = useState<PageChain>({
    environmentId,
    cursors: FIRST_PAGE,
  });
  // Another environment starts its own chain from the first page.
  const cursors =
    chain.environmentId === environmentId ? chain.cursors : FIRST_PAGE;
  if (chain.environmentId !== environmentId) {
    setChain({ environmentId, cursors: FIRST_PAGE });
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
  // The newest page names the next one: ask for it on this render. A cursor
  // already asked for is never asked again, so a page that repeats one
  // cannot loop.
  const nextCursor =
    pages.length === cursors.length
      ? (pages[pages.length - 1]?.nextCursor ?? null)
      : null;
  if (nextCursor !== null && !cursors.includes(nextCursor)) {
    setChain({ environmentId, cursors: [...cursors, nextCursor] });
  }
  return useMemo((): BotMemberResolver => {
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
  }, [pages]);
}
