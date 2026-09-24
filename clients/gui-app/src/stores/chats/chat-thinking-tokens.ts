import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * One reading of the provider's thinking-token estimate (`chat.subscribe@1.18`),
 * keyed by the turn it measures. The estimate is turn-scoped on the wire, so a
 * reading that outlives its turn is not "stale", it is somebody else's number.
 */
export interface ChatThinkingTokensReading {
  readonly turnId: string;
  readonly estimate: number;
}

type ThinkingTurnStatus = ChatActiveTurn["status"];

// Exhaustive by construction: a status added to the wire enum without a
// verdict here is a compile error rather than a silently hidden estimate.
const STATUS_ACCEPTS_THINKING: Record<ThinkingTurnStatus, boolean> = {
  starting: true,
  running: true,
  stopping: true,
  completed: false,
  stopped: false,
  interrupted: false,
  errored: false,
};

/** Whether `turn` is a live turn that can still be thinking. */
function turnIsLive(turn: ChatActiveTurn | null): turn is ChatActiveTurn {
  return turn !== null && STATUS_ACCEPTS_THINKING[turn.status];
}

/**
 * The reading a snapshot seeds: its `thinkingTokensEstimate` paired with its
 * own active turn, or none. A host below `1.18` omits the key, and a snapshot
 * taken between turns has no live turn to pair it with.
 */
export function thinkingTokensFromSnapshot(
  activeTurn: ChatActiveTurn | null,
  estimate: number | undefined,
): ChatThinkingTokensReading | null {
  if (estimate === undefined || !turnIsLive(activeTurn)) return null;
  return { turnId: activeTurn.turnId, estimate };
}

/**
 * What survives a `turnStateChanged`: the reading only while the SAME turn is
 * still live. A turn that ended (terminal status or no turn at all) or was
 * replaced clears it - the "turn-end state the GUI already receives".
 */
export function thinkingTokensAfterTurnState(
  current: ChatThinkingTokensReading | null,
  activeTurn: ChatActiveTurn | null,
): ChatThinkingTokensReading | null {
  if (current === null || !turnIsLive(activeTurn)) return null;
  return activeTurn.turnId === current.turnId ? current : null;
}

/**
 * Applies a light `thinkingTokens` frame. Accepted only for the live active
 * turn; a frame for any other turn (one that already ended, or one this store
 * has not seen start) leaves the current reading as it is.
 */
export function thinkingTokensAfterFrame(
  current: ChatThinkingTokensReading | null,
  activeTurn: ChatActiveTurn | null,
  frame: ChatThinkingTokensReading,
): ChatThinkingTokensReading | null {
  if (!turnIsLive(activeTurn) || activeTurn.turnId !== frame.turnId) {
    return current;
  }
  // Same identity for an unchanged number, so a subscriber comparing by
  // reference re-renders nothing.
  if (
    current !== null &&
    current.turnId === frame.turnId &&
    current.estimate === frame.estimate
  ) {
    return current;
  }
  return { turnId: frame.turnId, estimate: frame.estimate };
}

/**
 * The estimate to show beside the streaming "Thinking" label, or `null`. Read
 * against the active turn at render time too, so a reading can never be drawn
 * under a turn it does not belong to.
 */
export function selectActiveThinkingTokensEstimate(state: {
  readonly activeTurn: ChatActiveTurn | null;
  readonly thinkingTokens: ChatThinkingTokensReading | null;
}): number | null {
  const reading = state.thinkingTokens;
  const turn = state.activeTurn;
  if (reading === null || !turnIsLive(turn)) return null;
  return turn.turnId === reading.turnId ? reading.estimate : null;
}
