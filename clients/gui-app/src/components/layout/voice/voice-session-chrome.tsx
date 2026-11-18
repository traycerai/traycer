import { useEffect, type ReactNode } from "react";
import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import {
  VoicePhoneBar,
  VoicePhoneView,
} from "@/components/layout/voice/voice-phone-view";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/**
 * The call's chrome under the header on the phone: the full-screen call view,
 * and the bar while that view is down. The view is a portal, so where this
 * mounts places only the bar. On desktop the call is in the message box it
 * was placed from (`ComposerCallBar`) and nothing is drawn here.
 */
export function VoiceSessionChrome(): ReactNode {
  const phoneLayout = useMobileHeaderActive();
  // The box's call bar has no talk button to hold, so a window widened out of the
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
