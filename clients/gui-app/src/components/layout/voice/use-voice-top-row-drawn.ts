import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { soundtrackOffered } from "@/lib/soundtrack/manifest";
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
 * and the session's owner is mounted, the strip, or the soundtrack's toggle in
 * a build with something to play. Nothing otherwise, so a deployment without
 * them gives up no height and no tab width for it. The phone has its own places
 * (V5), and no soundtrack yet. Decided as the header decides it, not by width:
 * a zoomed desktop window narrower than the phone breakpoint keeps its desktop
 * chrome, so it keeps this row.
 */
export function useVoiceTopRowDrawn(): boolean {
  const phoneLayout = useMobileHeaderActive();
  const drawn = useVoiceSessionStore(
    (state) =>
      voiceStripDrawn(state) ||
      (state.availability === "live" && state.driver !== null),
  );
  return (drawn || soundtrackOffered()) && !phoneLayout;
}
