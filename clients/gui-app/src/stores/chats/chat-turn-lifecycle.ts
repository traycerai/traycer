import type {
  ChatActiveTurn,
  ChatRunStatus,
} from "@traycer/protocol/host/agent/gui/subscribe";

export interface ChatStopConfirmationTarget {
  readonly turnId: string | null;
  readonly revision: number;
  readonly connectionEpoch: number;
}

interface ChatTurnLifecycle {
  readonly activeTurn: ChatActiveTurn | null;
  readonly turnInProgress: boolean | undefined;
  readonly runStatus: ChatRunStatus;
}

/** Advance in the same store write as the lifecycle, including ID-less turns. */
export function nextTurnLifecycleRevision(
  previous: ChatTurnLifecycle & { readonly turnLifecycleRevision: number },
  next: ChatTurnLifecycle,
): number {
  const previousInProgress =
    previous.turnInProgress ?? previous.runStatus !== "idle";
  const nextInProgress = next.turnInProgress ?? next.runStatus !== "idle";
  const changed =
    (previous.activeTurn?.turnId ?? null) !==
      (next.activeTurn?.turnId ?? null) ||
    previousInProgress !== nextInProgress;
  return previous.turnLifecycleRevision + (changed ? 1 : 0);
}
