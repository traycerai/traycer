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
 * Narrows {@link composerTurnStatus} to the question every turn-scoped
 * consumer actually needs - the composer's Stop/Send toggle, restore/revert
 * gating, and the per-row "Working…"/"Stopping…" indicator: is there a turn
 * genuinely active or activating right now? `runStatus` also reads "running"
 * while a queued item is pending or visible background work outlives the
 * turn (Bash `run_in_background` / a subagent / Monitor) - neither of which
 * corresponds to an active turn. Background work already has its own
 * "stop all background" control, so rather than show a Stop button that
 * would fail, block a restore that isn't actually unsafe, or duplicate the
 * row indicator after the real turn already settled, this falls back to
 * `null` - exactly as if the chat were idle.
 *
 * Two layers, in priority order:
 *  1. `state.turnInProgress`, when present - the host's own
 *     `isTurnInProgress()`, sent verbatim. Exact, no known gaps.
 *  2. A local approximation, for an older host that predates the field:
 *     `activeTurn !== null` covers a genuinely running (or stopping) turn
 *     directly. When it's null but `runStatus` still reads "running",
 *     process of elimination against the queue/background signals is the
 *     only way to tell a pre-turn "activating" window (active) apart from a
 *     queue-only or background-only one (not active) - both look identical
 *     on the wire otherwise. Known gap: if a turn is still activating AND
 *     another item is queued behind it, the queue signal is also "runnable",
 *     so this can't distinguish that from a queue-only state and will
 *     (narrowly, incorrectly) fall back to `null` during that brief pre-turn
 *     window. Layer 1 closes this gap whenever the host supports it.
 */
export function resolvedTurnStatus(
  state: Pick<
    ChatSessionState,
    "activeTurn" | "queue" | "backgroundItems" | "turnInProgress"
  >,
  turnStatus: ComposerTurnStatus,
): ComposerTurnStatus {
  if (turnStatus === null) return null;
  if (state.turnInProgress !== undefined) {
    return state.turnInProgress ? turnStatus : null;
  }
  if (state.activeTurn !== null) return turnStatus;
  const isQueueRunnable =
    state.queue.status !== "paused" && state.queue.items.length > 0;
  const hasVisibleBackgroundWork = (state.backgroundItems?.length ?? 0) > 0;
  return isQueueRunnable || hasVisibleBackgroundWork ? null : turnStatus;
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
 * A running shell counts as `"background"` too, and it is the one source that
 * `runStatus` cannot speak for at all: a shell outlives the turn that started
 * it, so a chat whose only live thing is a shell reads `runStatus: "idle"` and
 * would otherwise present as fully idle while a process of its own is still
 * printing. Only `"running"` shells count - a shell that exited, was stopped,
 * or was interrupted by a host restart is a durable record, not activity.
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
