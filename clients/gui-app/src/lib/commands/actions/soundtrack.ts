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
 * Shows or hides the buttons. Hiding them while paused plays, because they were
 * the way back, and with no session yet this gesture is the one to open it.
 */
export function setPlaybackControlsOn(on: boolean): void {
  const settings = useSettingsStore.getState();
  settings.setSoundtrackPlaybackControls(on);
  if (!on && settings.soundtrackPaused) {
    useSoundtrackStore.getState().enable();
  }
}

export function pauseMusic(): void {
  useSettingsStore.getState().setSoundtrackPaused(true);
}

/**
 * Plays from a pause. After a launch that kept the pause there is no session
 * yet, so this gesture opens it.
 */
export function playMusic(): void {
  useSettingsStore.getState().setSoundtrackPaused(false);
  useSoundtrackStore.getState().enable();
}

export function nextTrack(): void {
  playMusic();
  useSoundtrackStore.getState().next();
}

export function previousTrack(): void {
  playMusic();
  useSoundtrackStore.getState().previous();
}

/**
 * Flips the person's wish rather than the session, because the two differ
 * until the first gesture after a launch, and that gesture may be this one:
 * the warm-up has just opened the session and this press is asking for it off.
 */
export function toggleSoundtrack(): void {
  setSoundtrackOn(!useSettingsStore.getState().soundtrackEnabled);
}
