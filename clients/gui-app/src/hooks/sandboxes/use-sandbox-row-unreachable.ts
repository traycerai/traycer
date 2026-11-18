import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  SandboxListResponse,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useAuthStore } from "@/stores/auth/auth-store";

interface ReachabilityObservation {
  readonly sandboxId: string;
  readonly userId: string | null;
  readonly unavailable: boolean;
  readonly listAtEdge: SandboxListResponse | null | undefined;
}

/**
 * A missing host may have been destroyed by another member. Check lifecycle
 * before calling it unreachable, keeping the lifecycle line during the read.
 * One read per outage; refetch joins the list's existing in-flight request,
 * including across directory flaps and other rows checking at the same time.
 */
export function useSandboxRowUnreachable(
  summary: SandboxSummary,
  statusFailed: boolean,
  list: UseQueryResult<SandboxListResponse | null>,
): boolean {
  const entry = useHostDirectoryEntry(summary.hostId);
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const { refetch } = list;
  const unavailable =
    summary.state === "awake" &&
    !summary.frozen &&
    summary.guestConfigured !== false &&
    (statusFailed || entry === null || hostUnavailability(entry) === "offline");
  const [observation, setObservation] = useState<ReachabilityObservation>({
    sandboxId: summary.id,
    userId,
    unavailable,
    listAtEdge: list.data,
  });
  if (
    observation.sandboxId !== summary.id ||
    observation.userId !== userId ||
    observation.unavailable !== unavailable
  ) {
    setObservation({
      sandboxId: summary.id,
      userId,
      unavailable,
      listAtEdge: list.data,
    });
  }

  useEffect(() => {
    if (observation.unavailable && observation.userId !== null) {
      void refetch({ cancelRefetch: false });
    }
  }, [observation, refetch]);

  // Each successful list read has its own response identity, even for an
  // identical answer. A failed refresh cannot validate the old awake row;
  // a later cadence read can.
  return (
    userId !== null &&
    unavailable &&
    list.data !== observation.listAtEdge &&
    (list.data?.sandboxes.some(
      (row) =>
        row.id === summary.id &&
        row.state === "awake" &&
        !row.frozen &&
        row.guestConfigured !== false,
    ) ??
      false)
  );
}
