import { useEffect, type ReactNode } from "react";
import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import {
  VoicePhoneBar,
  VoicePhoneView,
} from "@/components/layout/voice/voice-phone-view";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/**
 * The live session's chrome under the header on the phone: the full-screen
 * view, and the bar while that view is down (V5). The view is a portal, so
 * where this mounts places only the bar. On desktop the strip is in the top
 * row (`VoiceTopRowControl`) and nothing is drawn here.
 */
export function VoiceSessionChrome(): ReactNode {
  const phoneLayout = useMobileHeaderActive();
  // The strip has no talk button to hold, so a window widened out of the
  // phone layout leaves push-to-talk with the microphone closed; Unmute is
  // the person's way back to it.
  useEffect(() => {
    if (!phoneLayout) useVoiceSessionStore.getState().leavePushToTalkMuted();
  }, [phoneLayout]);
  if (!phoneLayout) return null;
  return (
    <>
      <VoicePhoneBar />
      <VoicePhoneView />
    </>
  );
}
