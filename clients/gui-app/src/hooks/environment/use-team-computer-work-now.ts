import { useState } from "react";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The host read a confirm asks a team computer for its own running work, with
 * the request it sends for the subject the confirm names.
 */
export type TeamComputerWorkNowRead =
  | {
      readonly method: "environment.members.removePreview";
      readonly paramsFor: (
        subject: string,
      ) => RequestOfMethod<
        HostRpcRegistry,
        "environment.members.removePreview"
      >;
    }
  | {
      readonly method: "environment.previewLocalFacts";
      readonly paramsFor: (
        subject: string,
      ) => RequestOfMethod<HostRpcRegistry, "environment.previewLocalFacts">;
    };

/** What both reads count; a count the computer cannot make is null. */
export interface TeamComputerCounts {
  readonly activeTurns: number | null;
  readonly terminals: number | null;
}

/**
 * A confirm's running-work read: `pending` while the team's host list or the
 * chosen host's one answer is still out, then settled for the opening, with
 * the host it chose. A settled `answer` is null when no team host is the
 * window's, the host does not serve the read, could not be asked, or the read
 * failed.
 */
export type TeamComputerWorkNow =
  | { readonly status: "pending" }
  | {
      readonly status: "settled";
      readonly hostId: string | null;
      readonly answer: TeamComputerCounts | null;
    };

/**
 * One opening of the confirm: the subject it names, the host asked for its
 * counts (null when none is), and a number telling this opening's request
 * from any earlier one's.
 */
interface Opening {
  readonly subject: string | null;
  readonly hostId: string | null;
  readonly nonce: number;
}

/** The answer an opening's one request settled with; null when it failed. */
interface Settled {
  readonly nonce: number;
  readonly answer: TeamComputerCounts | null;
}

const CLOSED: Opening = { subject: null, hostId: null, nonce: 0 };
const PENDING = { status: "pending" } as const;

/**
 * The opening this render is in: unchanged while the confirm names the same
 * subject, a new one once the team's host list has answered for a newly named
 * subject, closed when it names none. The window's own host is asked only
 * when it is one of the team's computers and can be asked at that moment.
 */
function openingFor(
  opening: Opening,
  subject: string | null,
  teamHostIds: ReadonlyArray<string> | null,
  ownHost: { readonly hostId: string | null; readonly ready: boolean },
): Opening {
  if (subject === null) {
    return opening.subject === null
      ? opening
      : { ...CLOSED, nonce: opening.nonce };
  }
  if (opening.subject === subject || teamHostIds === null) return opening;
  return {
    subject,
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
 * The read's settled answer: null when it failed, or when it was never sent
 * and its host can no longer be asked (a disabled read would otherwise stay
 * out for good); undefined while out.
 */
function settledAnswer(
  query: {
    readonly isError: boolean;
    readonly data: TeamComputerCounts | undefined;
    readonly fetchStatus: "fetching" | "paused" | "idle";
  },
  hostReady: boolean,
): TeamComputerCounts | null | undefined {
  if (query.isError) return null;
  if (query.data !== undefined) return query.data;
  return query.fetchStatus === "idle" && !hostReady ? null : undefined;
}

/**
 * The subject's running work for a confirm, counted by the window's own host
 * when that host is one of the team's computers (authn's list). The confirm
 * never dials another computer for it.
 *
 * Chosen once per opening, once the team's host list has answered, and asked
 * once: the choice and the settled answer hold for that opening whatever the
 * selection, the directory or the host's readiness do afterwards, and the
 * read is never retried, refetched or re-read by an invalidation. Pending
 * until then, so a confirm can hold its loading state rather than say the
 * work could not be counted while it is being counted; the wait is that one
 * answer.
 */
export function useTeamComputerWorkNow(args: {
  readonly environmentId: string;
  /** What the confirm names (a member, a plan); null while it is closed. */
  readonly subject: string | null;
  readonly read: TeamComputerWorkNowRead;
}): TeamComputerWorkNow {
  const { environmentId, subject, read } = args;
  const hostLists = useEnvironmentHostLists([environmentId], subject !== null);
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
  const current = openingFor(opening, subject, teamHostIds, {
    hostId: ownHostId,
    ready: ownHostReady,
  });
  if (current !== opening) setOpening(current);

  const asking = current.subject !== null && current.hostId !== null;
  const answered = settled !== null && settled.nonce === current.nonce;
  const hostClient = useHostClientForHostId(current.hostId);
  const chosenHostReady = useReactiveHostReadiness(hostClient).canExecute;
  const query = useHostQuery<
    HostRpcRegistry,
    TeamComputerWorkNowRead["method"]
  >({
    // Each opening is its own entry, so no answer from an earlier opening is
    // served to this one.
    cacheKeyIdentity: [current.nonce],
    // A null host follows the window's selection; only a chosen team host is
    // asked.
    client: current.hostId === null ? null : hostClient,
    method: read.method,
    params: read.paramsFor(current.subject ?? ""),
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

  const answer = settledAnswer(query, chosenHostReady);
  if (asking && !answered && answer !== undefined) {
    setSettled({ nonce: current.nonce, answer });
  }

  if (current.subject !== subject) return PENDING;
  if (current.hostId === null) {
    return { status: "settled", hostId: null, answer: null };
  }
  if (!answered) return PENDING;
  return { status: "settled", hostId: current.hostId, answer: settled.answer };
}
