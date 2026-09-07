import {
  foldRestorableSetupInterruption,
  selectRestorableSetupInterruption as protocolSelectRestorableSetupInterruption,
  type RestorableSetupInterruption,
} from "@traycer/protocol/persistence/chat-transcript/setup-interruption";
import {
  isWindowedTranscript,
  type ChatSessionState,
} from "@/stores/chats/chat-session-store";

/**
 * Composer-facing projections of the worktree-aware chat event stream. Each selector returns the
 * most recent matching event by array order.
 */

export type { RestorableSetupInterruption };

/**
 * Most recent setup interruption carrying a `messageId` (the gating-path emission) and not cleared
 * by a later retry/success for the same workspace.
 */
export function selectRestorableSetupInterruption(
  state: Pick<
    ChatSessionState,
    "events" | "transcriptDerived" | "transcriptWindow"
  >,
): RestorableSetupInterruption | null {
  if (isWindowedTranscript(state)) {
    return foldRestorableSetupInterruption({
      baseline: state.transcriptDerived.restorableSetupInterruption,
      laterEvents: state.transcriptWindow.liveEvents,
    });
  }
  return protocolSelectRestorableSetupInterruption(state.events);
}
