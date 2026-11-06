import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

/**
 * Turns the soundtrack on or off, from Settings and from the palette. On opens
 * the audio device, so it must run inside the person's gesture; off reaches
 * the session through the settings store, the way another window's does.
 */
export function setSoundtrackOn(on: boolean): void {
  useSettingsStore.getState().setSoundtrackEnabled(on);
  if (on) useSoundtrackStore.getState().enable();
}

/**
 * Flips the person's wish rather than the session, because the two differ
 * until the first gesture after a launch, and that gesture may be this one:
 * the warm-up has just opened the session and this press is asking for it off.
 */
export function toggleSoundtrack(): void {
  setSoundtrackOn(!useSettingsStore.getState().soundtrackEnabled);
}
