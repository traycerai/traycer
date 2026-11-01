import { useEffect, type ReactNode } from "react";
import {
  VoicePhoneBar,
  VoicePhoneView,
} from "@/components/layout/voice/voice-phone-view";
import { VoiceSessionStrip } from "@/components/layout/voice/voice-session-strip";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/**
 * The live session's chrome for the layout in use: the strip on desktop
 * (V6); on the phone the full-screen view, and the bar while that view is
 * down (V5). The view is a portal, so where this mounts places only the
 * strip and the bar.
 */
export function VoiceSessionChrome(): ReactNode {
  const phoneLayout = useIsMobileViewport();
  // The strip has no talk button to hold, so a window widened out of the
  // phone layout leaves push-to-talk with the microphone closed; Unmute is
  // the person's way back to it.
  useEffect(() => {
    if (!phoneLayout) useVoiceSessionStore.getState().leavePushToTalkMuted();
  }, [phoneLayout]);
  if (!phoneLayout) return <VoiceSessionStrip />;
  return (
    <>
      <VoicePhoneBar />
      <VoicePhoneView />
    </>
  );
}
