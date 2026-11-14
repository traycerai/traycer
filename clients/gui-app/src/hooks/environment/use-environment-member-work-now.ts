import { useState } from "react";
import type { EnvironmentMembersRemovePreviewResponse } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * One opening of the removal confirm: the member it names, the host asked
 * for their counts (null when none is), and a number telling this opening's
 * request from any earlier one's.
 */
interface Opening {
  readonly userId: string | null;
  readonly hostId: string | null;
  readonly nonce: number;
}

/** The answer an opening's one request settled with; null when it failed. */
interface Settled {
  readonly nonce: number;
  readonly counts: EnvironmentMembersRemovePreviewResponse | null;
}

const CLOSED: Opening = { userId: null, hostId: null, nonce: 0 };

/**
 * The opening this render is in: unchanged while the confirm names the same
 * member, a new one once the team's host list has answered for a newly named
 * member, closed when it names nobody. The window's own host is asked only
 * when it is one of the team's computers and can be asked at that moment.
 */
function openingFor(
  opening: Opening,
  userId: string | null,
  teamHostIds: ReadonlyArray<string> | null,
  ownHost: { readonly hostId: string | null; readonly ready: boolean },
): Opening {
  if (userId === null) {
    return opening.userId === null
      ? opening
      : { ...CLOSED, nonce: opening.nonce };
  }
  if (opening.userId === userId || teamHostIds === null) return opening;
  return {
    userId,
    hostId:
      ownHost.ready &&
      ownHost.hostId !== null &&
      teamHostIds.includes(ownHost.hostId)
        ? ownHost.hostId
        : null,
    nonce: opening.nonce + 1,
  };
}

/** The team's host ids once its list has answered; a failed list names none. */
function answeredTeamHostIds(
  hosts: ReadonlyArray<{ readonly hostId: string }> | undefined,
  failed: boolean,
): ReadonlyArray<string> | null {
  if (hosts !== undefined) return hosts.map((host) => host.hostId);
  return failed ? [] : null;
}

/** The read's settled answer: null when it failed, undefined while out. */
function settledCounts(query: {
  readonly isError: boolean;
  readonly data: EnvironmentMembersRemovePreviewResponse | undefined;
}): EnvironmentMembersRemovePreviewResponse | null | undefined {
  return query.isError ? null : query.data;
}

/**
 * The member's running turns and terminals for the removal confirm, counted
 * by the window's own host when that host is one of the team's computers
 * (authn's list). The confirm never dials another computer for them.
 *
 * Chosen once per opening, once the team's host list has answered, and asked
 * once: the choice and the settled answer hold for that opening whatever the
 * selection, the directory or the host's readiness do afterwards, and the
 * read is never retried, refetched or re-read by an invalidation. Null until
 * it answers, and for good when no team host is the window's, the host does
 * not serve the read, or the read fails.
 */
export function useEnvironmentMemberWorkNow(
  environmentId: string,
  userId: string | null,
): EnvironmentMembersRemovePreviewResponse | null {
  const hostLists = useEnvironmentHostLists([environmentId], userId !== null);
  const teamHostIds = answeredTeamHostIds(
    hostLists.hostsByEnvironmentId.get(environmentId),
    hostLists.failedEnvironmentIds.has(environmentId),
  );
  const ownHostId = useEffectiveHostId();
  const ownHostReady = useReactiveHostReadiness(
    useHostClientForHostId(ownHostId),
  ).canExecute;
  const [opening, setOpening] = useState<Opening>(CLOSED);
  const [settled, setSettled] = useState<Settled | null>(null);
  const current = openingFor(opening, userId, teamHostIds, {
    hostId: ownHostId,
    ready: ownHostReady,
  });
  if (current !== opening) setOpening(current);

  const asking = current.userId !== null && current.hostId !== null;
  const answered = settled !== null && settled.nonce === current.nonce;
  const hostClient = useHostClientForHostId(current.hostId);
  const query = useHostQuery<
    HostRpcRegistry,
    "environment.members.removePreview"
  >({
    // Each opening is its own entry, so no answer from an earlier opening is
    // served to this one.
    cacheKeyIdentity: [current.nonce],
    // A null host follows the window's selection; only a chosen team host is
    // asked.
    client: current.hostId === null ? null : hostClient,
    method: "environment.members.removePreview",
    params: { environmentId, userId: current.userId ?? "" },
    options: {
      // Off once settled, so an invalidation cannot ask again.
      enabled: asking && !answered,
      gcTime: 0,
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });

  const counts = settledCounts(query);
  if (asking && !answered && counts !== undefined) {
    setSettled({ nonce: current.nonce, counts });
  }

  if (current.userId === null || settled === null) return null;
  return settled.nonce === current.nonce ? settled.counts : null;
}
