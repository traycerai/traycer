import { useState } from "react";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";

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

export interface TeamComputerCounts {
  readonly activeTurns: number | null;
  readonly terminals: number | null;
}

/** `answer` is null when no team host is the window's, or it does not serve, could not be asked or failed. */
export type TeamComputerWorkNow =
  | { readonly status: "pending" }
  | {
      readonly status: "settled";
      readonly hostId: string | null;
      readonly answer: TeamComputerCounts | null;
    };

interface Opening {
  readonly subject: string | null;
  readonly hostId: string | null;
  readonly nonce: number;
}

interface Settled {
  readonly nonce: number;
  readonly answer: TeamComputerCounts | null;
}

const CLOSED: Opening = { subject: null, hostId: null, nonce: 0 };
const PENDING = { status: "pending" } as const;

// The window's own host is asked only when it is one of the team's computers and can be asked now.
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

// Null when it failed, or was never sent and its host can no longer be asked (a
// disabled read would stay out for good).
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
 * Never dials another computer. Chosen and asked once per opening; never retried,
 * refetched or re-read by an invalidation.
 */
export function useTeamComputerWorkNow(args: {
  readonly environmentId: string;
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
    // A null host follows the window's selection.
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
