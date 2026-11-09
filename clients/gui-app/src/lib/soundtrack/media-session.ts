import artworkUrl from "@/assets/soundtrack/traycer-icon.png";
import { appLogger, describeLogError } from "@/lib/logger";

/** What the system's media controls may ask of the soundtrack. */
export interface MediaSessionHandlers {
  readonly play: () => void;
  readonly pause: () => void;
  readonly next: () => void;
  readonly previous: () => void;
}

/** The soundtrack's entry in the system's media controls, for as long as a session lasts. */
export interface SoundtrackMediaSession {
  /** Names the track in front; null while the view in front has none. */
  setTrack(title: string | null): void;
  setPaused(paused: boolean): void;
  /** Takes the soundtrack out of the system's controls. */
  close(): void;
}

/**
 * Passed along with every title: a Mac or Windows would fall back to the app's
 * icon on its own, but Linux has nothing to fall back on. A fresh array each
 * time, because the metadata's type takes a mutable one.
 */
function artwork(): MediaImage[] {
  return [{ src: artworkUrl, sizes: "256x256", type: "image/png" }];
}

/**
 * Longer than the five seconds under which Chromium treats a sound as a
 * one-off and gives it no entry in the system's controls.
 */
const ANCHOR_SECONDS = 10;
const ANCHOR_SAMPLE_RATE = 8_000;

/**
 * A WAV of silence: 8-bit unsigned mono, whose rest level is 0x80, so the file
 * is as small as a WAV gets with nothing in it to hear.
 */
function silentWavUrl(): string {
  const sampleCount = ANCHOR_SECONDS * ANCHOR_SAMPLE_RATE;
  const bytes = new Uint8Array(44 + sampleCount);
  const view = new DataView(bytes.buffer);
  const writeTag = (offset: number, tag: string): void => {
    for (let index = 0; index < tag.length; index += 1) {
      view.setUint8(offset + index, tag.charCodeAt(index));
    }
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + sampleCount, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, ANCHOR_SAMPLE_RATE, true);
  view.setUint32(28, ANCHOR_SAMPLE_RATE, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeTag(36, "data");
  view.setUint32(40, sampleCount, true);
  bytes.fill(0x80, 44);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/**
 * Puts the soundtrack in the system's media controls: the Now Playing widget
 * and the media keys on a Mac, the media overlay on Windows, MPRIS on Linux.
 *
 * Chromium lists a page there only while a media element of its own is
 * playing: the soundtrack is mixed on Web Audio, which Chromium does not
 * count, so a looping element of silence plays alongside the mix for as long
 * as the session lasts, and pauses when the mix does. Everything the system
 * shows and every button it offers comes from the Media Session API. The
 * soundtrack has no length, which a zero duration tells the system, so no
 * timeline is drawn.
 *
 * Call it with the audio device open. The element starts under the autoplay
 * rules: the desktop app has none, and a browser is content with a gesture
 * earlier in the page's life. Null where there are no system controls to join.
 */
export function openSoundtrackMediaSession(
  handlers: MediaSessionHandlers,
): SoundtrackMediaSession | null {
  if (!("mediaSession" in navigator)) return null;
  const { mediaSession } = navigator;
  const url = silentWavUrl();
  // Unmuted on purpose: Chromium drops a muted element from the session.
  const anchor = new Audio(url);
  anchor.loop = true;
  const playAnchor = (): void => {
    anchor.play().catch((error: unknown) => {
      // A pause that lands while the start is still pending ends it this way,
      // and the pause was the point.
      if (error instanceof DOMException && error.name === "AbortError") return;
      appLogger.warn("[soundtrack] the media session's anchor would not play", {
        error: describeLogError(error),
      });
    });
  };
  const setTrack = (title: string | null): void => {
    mediaSession.metadata = new MediaMetadata(
      title === null
        ? { title: "Traycer", artwork: artwork() }
        : { title, artist: "Traycer", artwork: artwork() },
    );
  };
  const releaseAnchor = (): void => {
    anchor.pause();
    anchor.removeAttribute("src");
    anchor.load();
    URL.revokeObjectURL(url);
  };
  // Only the actions the system took: one it refused has nothing to clear.
  const registered: MediaSessionAction[] = [];
  const register = (action: MediaSessionAction, handler: () => void): void => {
    mediaSession.setActionHandler(action, handler);
    registered.push(action);
  };
  const leaveControls = (): void => {
    for (const action of registered)
      mediaSession.setActionHandler(action, null);
    mediaSession.setPositionState();
    mediaSession.metadata = null;
    mediaSession.playbackState = "none";
  };
  playAnchor();
  try {
    register("play", handlers.play);
    register("pause", handlers.pause);
    register("nexttrack", handlers.next);
    register("previoustrack", handlers.previous);
    mediaSession.setPositionState({
      duration: 0,
      position: 0,
      playbackRate: 1,
    });
    mediaSession.playbackState = "playing";
    // Ahead of the first track: without metadata the system shows the window's title.
    setTrack(null);
  } catch (error) {
    // The controls are an extra: the music plays on without them.
    appLogger.warn("[soundtrack] could not join the system's media controls", {
      error: describeLogError(error),
    });
    leaveControls();
    releaseAnchor();
    return null;
  }
  return {
    setTrack,
    setPaused: (paused) => {
      if (paused) anchor.pause();
      else playAnchor();
      mediaSession.playbackState = paused ? "paused" : "playing";
    },
    close: () => {
      releaseAnchor();
      leaveControls();
    },
  };
}
