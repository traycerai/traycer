import { useEffect, useState } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  sandboxWakeId,
  sandboxWakeWait,
  type SandboxWakeWait,
} from "@/lib/sandboxes/sandbox-wake-wait";
import { useSandboxWakeReportStore } from "@/stores/sandboxes/sandbox-wake-report-store";

/**
 * Whether an awake sandbox's host has yet to first report in this wake, and
 * the move to name until it does. The row turns awake when the host proves
 * itself to the control plane, before the relay or this device can reach it,
 * so `awake` alone says nothing about the host answering here.
 *
 * `surface` is what a surface knows beyond the row: its own read of the host
 * for this wake, `null` when it has none, and a wake it sent that the row may
 * not show yet. A surface with a read that watched the wake waits for that
 * answer, past the relay's word; one that opens on a settled row takes the
 * relay's word. Only an answer this device had counts for the wake: a cached
 * directory row may predate it.
 */
export function useSandboxWakeWait(
  summary: SandboxSummary | null,
  surface: {
    readonly hostAnswered: boolean | null;
    readonly wakeSent: boolean;
  },
): SandboxWakeWait | null {
  const hostId = summary?.hostId ?? null;
  const entry = useHostDirectoryEntry(hostId);
  const hasReadySession = useRemoteSessionPollReadiness(hostId ?? "");
  const watched = useWatchedWake(summary, surface.wakeSent);
  const answeredWake = useSandboxWakeReportStore((state) =>
    summary === null ? null : (state.answeredWakes[summary.id] ?? null),
  );
  const answered = surface.hostAnswered === true || hasReadySession;
  const relayAnswers =
    surface.hostAnswered !== null &&
    watched === null &&
    hostIsConnectable(entry);
  const sandboxId = summary?.id ?? null;
  const wake =
    summary !== null && hostCanAnswer(summary) ? sandboxWakeId(summary) : null;
  useEffect(() => {
    if (sandboxId === null || wake === null || !answered) return;
    useSandboxWakeReportStore.getState().recordAnswer(sandboxId, wake);
  }, [answered, sandboxId, wake]);
  if (summary === null) return null;
  const wait = sandboxWakeWait(summary, {
    answers: answered || relayAnswers,
    answeredWake,
  });
  if (wait === null) return null;
  // A row that records its move is right about this wake; a watched move may
  // be an earlier one's.
  return summary.operation === null ? (watched ?? wait) : wait;
}

/** The move this surface saw take the row toward awake, until it rests. */
function useWatchedWake(
  summary: SandboxSummary | null,
  wakeSent: boolean,
): SandboxWakeWait | null {
  const [watched, setWatched] = useState<{
    readonly sandboxId: string;
    readonly move: SandboxWakeWait;
  } | null>(null);
  const move = summary === null ? null : wakeMoveOf(summary, wakeSent);
  const held =
    summary?.state === "awake" && watched?.sandboxId === summary.id
      ? watched.move
      : null;
  const next = move ?? held;
  const changed =
    next !== (watched?.move ?? null) ||
    (next !== null && watched?.sandboxId !== summary?.id);
  if (changed) {
    setWatched(
      summary === null || next === null
        ? null
        : { sandboxId: summary.id, move: next },
    );
  }
  return next;
}

function wakeMoveOf(
  summary: SandboxSummary,
  wakeSent: boolean,
): SandboxWakeWait | null {
  switch (summary.state) {
    case "resuming":
      return "resuming";
    case "creating":
    case "starting":
      return "starting";
    case "suspended":
      return wakeSent ? "resuming" : null;
    case "stopped":
      return wakeSent ? "starting" : null;
    default:
      return null;
  }
}

/** A list can lag a wake, so an answer may arrive before the row says awake. */
function hostCanAnswer(summary: SandboxSummary): boolean {
  return summary.state === "awake" || wakeMoveOf(summary, false) !== null;
}

function hostIsConnectable(entry: HostDirectoryEntry | null): boolean {
  return (
    entry !== null &&
    isRemoteHostDirectoryEntry(entry) &&
    entry.remoteStatus.connectivity === "connectable"
  );
}
