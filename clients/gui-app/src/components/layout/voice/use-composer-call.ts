import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { useCallHotkey } from "@/hooks/composer/use-dictation-hotkey";
import {
  callToggleAction,
  useVoiceSessionStore,
  type CallTarget,
  type VoiceSessionState,
} from "@/stores/voice/voice-session-store";

/**
 * A message box's place in a call (Call Tracy, VC3 rule 7): what its Call
 * places, and whether it draws the call bar in place of its field.
 */
export interface ComposerCall {
  /**
   * The bot and thread (`null` for the channel) a call from this box goes
   * to; `null` for a box replying under an announcement, which has no thread
   * to call into yet.
   */
  readonly target: CallTarget | null;
  /**
   * On desktop, while the call placed from this box runs, or its line has
   * not been dismissed.
   */
  readonly barShown: boolean;
}

/**
 * The call of a bot's message box: the channel's box (`threadId` and
 * `announcementId` both `null`) places a call that opens a new thread with the
 * first thing said; an opened thread's box, one that continues it. Binds the
 * composer microphone's chord to that call for the box's life.
 */
export function useComposerCall(
  botId: string,
  threadId: string | null,
  announcementId: string | null,
): ComposerCall {
  const target: CallTarget | null =
    announcementId === null ? { botId, threadId } : null;
  useComposerCallChord(target);
  const phoneLayout = useMobileHeaderActive();
  const placedHere = useVoiceSessionStore(
    (state) =>
      target !== null &&
      callPlacedFrom(state, target) &&
      (state.phase !== "idle" ||
        state.endReason !== null ||
        state.refusal !== null),
  );
  return { target, barShown: placedHere && !phoneLayout };
}

/** Whether the call running now, or the last one's line, was placed from `target`. */
export function callPlacedFrom(
  state: VoiceSessionState,
  target: CallTarget,
): boolean {
  const placed = state.placedFrom;
  return (
    placed !== null &&
    placed.botId === target.botId &&
    placed.threadId === target.threadId
  );
}

/**
 * The composer microphone's chord on a bot's box (P15), while its surface
 * owns the keyboard and the deployment offers voice: ends the call that is
 * live, else calls `target` at once. A thread's box wins over its channel's.
 * Dictation is a separate owner of the chord and is never touched here.
 * Bound for the box's life, so it ends the call from the bar too.
 */
function useComposerCallChord(target: CallTarget | null): void {
  const offered = useVoiceSessionStore(
    (state) => state.availability === "live" && state.driver !== null,
  );
  useCallHotkey({
    enabled: offered && target !== null,
    thread: target !== null && target.threadId !== null,
    toggle: () => {
      if (target === null) return;
      const state = useVoiceSessionStore.getState();
      const action = callToggleAction(state);
      if (action === "end") state.driver?.end();
      else if (action === "start") state.driver?.start(target);
    },
  });
}
