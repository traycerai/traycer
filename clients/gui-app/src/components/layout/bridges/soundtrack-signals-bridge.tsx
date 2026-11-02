import { useMixSignalsFeed } from "@/hooks/soundtrack/use-mix-signals-feed";
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
