import type { ChatRunStatus } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";

// Pure readings of a chat's run state: whether a turn is genuinely in progress,
// and whether what keeps the chat non-idle is the agent or only background
// work. Shared by the chat surfaces (Stop/Send, spinners, row indicators) and
// by the chat session registry's release gates, so the two cannot disagree
// about what counts as the agent working.

/**
 * The composer's turn-status prop shape - a strict subset of
 * `ChatActiveTurn["status"]` (which also carries terminal values like
 * `"completed"`/`"errored"` that never apply here). Narrower than that wider
 * type so callers like `useRenderedMessages`'s `runStatus: ChatRunStatus`
 * input can consume it directly (`"running"`/`"stopping"` overlap exactly;
 * `null` maps to `"idle"`).
 */
export type ComposerTurnStatus = "running" | "stopping" | null;

/**
 * Maps the host-owned chat `runStatus` onto the composer's turn-status prop
 * shape. `running` shows the stop button, `stopping` shows the "Stopping"
 * affordance, `idle` returns the composer to its send state.
 */
export function composerTurnStatus(
  runStatus: ChatRunStatus,
): ComposerTurnStatus {
  if (runStatus === "running") return "running";
  if (runStatus === "stopping") return "stopping";
  return null;
}

/**
 * Local transcript sends show Stop from Enter. Runnable queue items keep it
 * across a drain boundary; paused queues and background work do not. Once
 * those local obligations are absent, prefer the host's exact turn bit and
 * retain the older-host approximation for an activation without a turn id.
 */
export function resolvedTurnStatus(
  state: Pick<
    ChatSessionState,
    | "activeTurn"
    | "queue"
    | "backgroundItems"
    | "turnInProgress"
    | "pendingTurn"
    | "heldStop"
    | "queueTurnContinuity"
  >,
  turnStatus: ComposerTurnStatus,
): ComposerTurnStatus {
  if (state.heldStop) return "stopping";
  if (state.pendingTurn) return turnStatus ?? "running";
  if (state.queueTurnContinuity) return turnStatus ?? "running";
  return resolvedHostTurnStatus(state, turnStatus);
}

/** Host turn work, excluding a local send and the composer's drain latch. */
export function resolvedHostTurnStatus(
  state: Pick<
    ChatSessionState,
    "activeTurn" | "queue" | "backgroundItems" | "turnInProgress"
  >,
  turnStatus: ComposerTurnStatus,
): ComposerTurnStatus {
  if (turnStatus === null) return null;
  if (state.turnInProgress !== undefined)
    return state.turnInProgress ? turnStatus : null;
  if (state.activeTurn !== null) return turnStatus;
  const runnableQueue =
    state.queue.status !== "paused" && state.queue.items.length > 0;
  const background = (state.backgroundItems?.length ?? 0) > 0;
  return runnableQueue || background ? null : turnStatus;
}

/**
 * Tri-state activity for the chat's progress indicators (sidebar tree, tab
 * icons): is the agent actually processing, or is only background work
 * (Bash `run_in_background` / Monitor / a scheduled wakeup) keeping the chat
 * non-idle? `runStatus` alone can't tell the two apart, and showing the same
 * spinner for both left users unable to see whether the agent was really
 * running.
 *
 * `"turn"` wins whenever a genuine turn is active or activating (the host's
 * `turnInProgress`, via {@link resolvedTurnStatus}) — background work running
 * alongside a turn is subsumed by it. A runnable queue also reads `"turn"`:
 * the next prompt is imminent, and the momentary turn-boundary gaps while a
 * queue drains must not flicker the indicator through the background style.
 *
 * Native agent work — a spawned subagent or a workflow fleet still running
 * after the turn ended — also reads `"turn"`: it IS the agent working, just
 * detached from the turn, so it gets the busy spinner rather than the muted
 * background-process glyph. Only process-like kinds (command / monitor /
 * wakeup / mcp) read `"background"`. This deliberately diverges from
 * {@link resolvedTurnStatus}, which keeps reporting no active turn for the
 * same state: a detached subagent must not surface a Stop-turn affordance.
 *
 * Running shells also count as `"background"`. Only running records count;
 * exited, stopped or interrupted shells are history rather than activity.
 */
export type ChatActivityIndicator = "turn" | "background" | null;

export function chatActivityIndicator(
  state: Pick<
    ChatSessionState,
    | "runStatus"
    | "activeTurn"
    | "queue"
    | "backgroundItems"
    | "turnInProgress"
    | "managedCommands"
  >,
): ChatActivityIndicator {
  const turnStatus = composerTurnStatus(state.runStatus);
  if (turnStatus === null) {
    return hasRunningManagedCommand(state.managedCommands)
      ? "background"
      : null;
  }
  if (resolvedTurnStatus(state, turnStatus) !== null) return "turn";
  const isQueueRunnable =
    state.queue.status !== "paused" && state.queue.items.length > 0;
  if (isQueueRunnable) return "turn";
  const hasNativeAgentWork =
    state.backgroundItems?.some(
      (item) => item.kind === "subagent" || item.kind === "workflow",
    ) ?? false;
  return hasNativeAgentWork ? "turn" : "background";
}

function hasRunningManagedCommand(
  managedCommands: ChatSessionState["managedCommands"],
): boolean {
  return managedCommands.some((command) => command.status.state === "running");
}
