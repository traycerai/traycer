import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  useVoiceSessionStore,
  type VoiceSessionState,
} from "@/stores/voice/voice-session-store";

/** A session is running, or its line has not been dismissed: the strip's turn. */
export function voiceStripDrawn(state: VoiceSessionState): boolean {
  return (
    state.phase !== "idle" || state.endReason !== null || state.refusal !== null
  );
}

/**
 * Whether the top row has anything to carry: Talk once the server offers voice
 * and the session's owner is mounted, or the strip. Nothing otherwise, so a
 * deployment without voice gives up no height and no tab width for it. The
 * phone has its own places (V5).
 */
export function useVoiceTopRowDrawn(): boolean {
  const phoneLayout = useIsMobileViewport();
  const drawn = useVoiceSessionStore(
    (state) =>
      voiceStripDrawn(state) ||
      (state.availability === "live" && state.driver !== null),
  );
  return drawn && !phoneLayout;
}
