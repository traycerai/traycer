import { useState } from "react";
import type { EnvironmentPreviewLocalFactsResponse } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";

/** The turns running on the plan, and the team computer that counted them. */
export interface PlanWorkNow {
  readonly activeTurns: number;
  readonly hostId: string;
}

/**
 * One opening of the unlink confirm: the plan it names, the host asked for
 * its count (null when none is), and a number telling this opening's request
 * from any earlier one's.
 */
interface Opening {
  readonly profileId: string | null;
  readonly hostId: string | null;
  readonly nonce: number;
}

/** The count an opening's one request settled with; null when it failed. */
interface Settled {
  readonly nonce: number;
  readonly workNow: PlanWorkNow | null;
}

const CLOSED: Opening = { profileId: null, hostId: null, nonce: 0 };

/**
 * The opening this render is in: unchanged while the confirm names the same
 * plan, a new one once the team's host list has answered for a newly named
 * plan, closed when it names none. The window's own host is asked only when
 * it is one of the team's computers and can be asked at that moment.
 */
function openingFor(
  opening: Opening,
  profileId: string | null,
  teamHostIds: ReadonlyArray<string> | null,
  ownHost: { readonly hostId: string | null; readonly ready: boolean },
): Opening {
  if (profileId === null) {
    return opening.profileId === null
      ? opening
      : { ...CLOSED, nonce: opening.nonce };
  }
  if (opening.profileId === profileId || teamHostIds === null) return opening;
  return {
    profileId,
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

/**
 * The read's settled count: null when it failed or the host cannot count,
 * undefined while out.
 */
function settledWorkNow(
  query: {
    readonly isError: boolean;
    readonly data: EnvironmentPreviewLocalFactsResponse | undefined;
  },
  hostId: string,
): PlanWorkNow | null | undefined {
  if (query.isError) return null;
  if (query.data === undefined) return undefined;
  return query.data.activeTurns === null
    ? null
    : { activeTurns: query.data.activeTurns, hostId };
}

/**
 * The turns running on the plan for the unlink confirm, counted by the
 * window's own host when that host is one of the team's computers (authn's
 * list). The confirm never dials another computer for them.
 *
 * Chosen once per opening, once the team's host list has answered, and asked
 * once: the choice and the settled answer hold for that opening whatever the
 * selection, the directory or the host's readiness do afterwards, and the
 * read is never retried, refetched or re-read by an invalidation. Null until
 * it answers, and for good when no team host is the window's, the host does
 * not serve the read, cannot count, or the read fails.
 */
export function useEnvironmentPlanWorkNow(
  environmentId: string,
  profileId: string | null,
): PlanWorkNow | null {
  const hostLists = useEnvironmentHostLists(
    [environmentId],
    profileId !== null,
  );
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
  const current = openingFor(opening, profileId, teamHostIds, {
    hostId: ownHostId,
    ready: ownHostReady,
  });
  if (current !== opening) setOpening(current);

  const asking = current.profileId !== null && current.hostId !== null;
  const answered = settled !== null && settled.nonce === current.nonce;
  const hostClient = useHostClientForHostId(current.hostId);
  const query = useHostQuery<HostRpcRegistry, "environment.previewLocalFacts">({
    // Each opening is its own entry, so no answer from an earlier opening is
    // served to this one.
    cacheKeyIdentity: [current.nonce],
    // A null host follows the window's selection; only a chosen team host
    // is asked.
    client: current.hostId === null ? null : hostClient,
    method: "environment.previewLocalFacts",
    params: {
      environmentId,
      subject: { kind: "plan", profileId: current.profileId ?? "" },
    },
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

  const workNow =
    current.hostId === null ? undefined : settledWorkNow(query, current.hostId);
  if (asking && !answered && workNow !== undefined) {
    setSettled({ nonce: current.nonce, workNow });
  }

  if (current.profileId === null || settled === null) return null;
  return settled.nonce === current.nonce ? settled.workNow : null;
}
