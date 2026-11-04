import { useEffect } from "react";
import { useMixSignalsFeed } from "@/hooks/soundtrack/use-mix-signals-feed";
import { onNextAudioGesture } from "@/lib/notifications/notification-chime";
import { soundtrackOffered } from "@/lib/soundtrack/manifest";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

function SoundtrackSignalsFeed(): null {
  useMixSignalsFeed(useSoundtrackStore((state) => state.setSignals));
  return null;
}

/**
 * Feeds the soundtrack from the app while it is on, and reads nothing while it
 * is off. Mounted once at the app root.
 */
export function SoundtrackSignalsBridge() {
  const enabled = useSoundtrackStore((state) => state.enabled);
  return enabled ? <SoundtrackSignalsFeed /> : null;
}

/**
 * Brings back a soundtrack the person left on, on their next gesture, since
 * audio may only start from one: after a launch, a sign-in, or another account
 * taking over the window. Mounted once at the app root, signed in.
 *
 * The wish is read at these two moments and not subscribed to. Another window
 * turning the soundtrack on must not arm a second one here, and another window
 * turning it off must disarm this one, which reading it at the gesture does.
 */
export function SoundtrackWarmupBridge(): null {
  const enabled = useSoundtrackStore((state) => state.enabled);
  useEffect(() => {
    if (
      enabled ||
      !soundtrackOffered() ||
      !useSettingsStore.getState().soundtrackEnabled
    ) {
      return undefined;
    }
    return onNextAudioGesture(() => {
      if (useSettingsStore.getState().soundtrackEnabled) {
        useSoundtrackStore.getState().enable();
      }
    });
  }, [enabled]);
  return null;
}
