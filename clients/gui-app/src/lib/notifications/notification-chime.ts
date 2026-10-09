import classicUrl from "./chimes/classic.wav";
import prismUrl from "./chimes/prism.wav";
import rippleUrl from "./chimes/ripple.wav";
import emberUrl from "./chimes/ember.wav";
import orbitUrl from "./chimes/orbit.wav";
import riftUrl from "./chimes/rift.wav";
import coinUrl from "./chimes/coin.wav";
import bloopUrl from "./chimes/bloop.wav";
import cuckooUrl from "./chimes/cuckoo.wav";
import tadaUrl from "./chimes/ta-da.wav";
import beaconUrl from "./chimes/beacon.wav";
import silenceUrl from "./chimes/silence.wav?no-inline";

export const NOTIFICATION_CHIME_SOUNDS = [
  "classic",
  "prism",
  "ripple",
  "ember",
  "orbit",
  "rift",
  "coin",
  "bloop",
  "cuckoo",
  "ta-da",
  "beacon",
  "none",
] as const;

export type NotificationChimeSound = (typeof NOTIFICATION_CHIME_SOUNDS)[number];

export const DEFAULT_NOTIFICATION_CHIME_SOUND: NotificationChimeSound =
  "classic";

export const NOTIFICATION_CHIME_LABELS: Readonly<
  Record<NotificationChimeSound, string>
> = {
  classic: "Classic",
  prism: "Prism",
  ripple: "Ripple",
  ember: "Ember",
  orbit: "Orbit",
  rift: "Rift",
  coin: "Coin",
  bloop: "Bloop",
  cuckoo: "Cuckoo",
  "ta-da": "Ta-da",
  beacon: "Beacon",
  none: "None",
};

export const NOTIFICATION_CHIME_DESCRIPTIONS: Readonly<
  Record<NotificationChimeSound, string>
> = {
  classic: "A familiar, polished bell.",
  prism: "Bright and optimistic, with a three-note lift.",
  ripple: "A playful water-drop glide with a quiet echo.",
  ember: "Warm, calm, and deliberately subtle.",
  orbit: "An attentive two-note call with gentle width.",
  rift: "A restrained descending warning with a soft low resolve.",
  coin: "A tiny retro reward jingle.",
  bloop: "A comedic cartoon bubble bounce.",
  cuckoo: "A woody, two-note clock call.",
  "ta-da": "A syncopated mini-fanfare with a bright chord landing.",
  beacon: "A sci-fi sonar ping with a fading echo.",
  none: "Keep in-app notifications silent.",
};

export const NOTIFICATION_CHIME_EVENT_TYPES = [
  "needs_action",
  "failure",
  "done",
  "info",
] as const;

export type NotificationChimeEventType =
  (typeof NOTIFICATION_CHIME_EVENT_TYPES)[number];

export type NotificationChimeSoundsByEvent = Readonly<
  Record<NotificationChimeEventType, NotificationChimeSound>
>;

export const DEFAULT_NOTIFICATION_CHIME_SOUNDS: NotificationChimeSoundsByEvent =
  {
    needs_action: "orbit",
    failure: "rift",
    done: "prism",
    info: "ember",
  };

export function isNotificationChimeSound(
  value: unknown,
): value is NotificationChimeSound {
  return (
    typeof value === "string" &&
    NOTIFICATION_CHIME_SOUNDS.some((sound) => sound === value)
  );
}

export function isNotificationChimeSoundsByEvent(
  value: unknown,
): value is NotificationChimeSoundsByEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return NOTIFICATION_CHIME_EVENT_TYPES.every((eventType) =>
    isNotificationChimeSound(candidate[eventType]),
  );
}

export function notificationChimeEventTypeForSeverities(
  severities: ReadonlyArray<string>,
): NotificationChimeEventType | null {
  if (severities.includes("needs_action")) return "needs_action";
  if (severities.includes("failure")) return "failure";
  if (severities.includes("done")) return "done";
  if (severities.includes("info")) return "info";
  return null;
}

type AudibleChime = Exclude<NotificationChimeSound, "none">;

const CHIME_URLS: Readonly<Record<AudibleChime, string>> = {
  classic: classicUrl,
  prism: prismUrl,
  ripple: rippleUrl,
  ember: emberUrl,
  orbit: orbitUrl,
  rift: riftUrl,
  coin: coinUrl,
  bloop: bloopUrl,
  cuckoo: cuckooUrl,
  "ta-da": tadaUrl,
  beacon: beaconUrl,
};

interface ChimePlayer {
  readonly audio: HTMLAudioElement;
  playing: boolean;
  warmed: boolean;
  operation: number;
}

const players = new Map<AudibleChime, ChimePlayer>();

function getChimePlayer(sound: AudibleChime): ChimePlayer {
  let player = players.get(sound);
  if (player === undefined) {
    const audio = new window.Audio(CHIME_URLS[sound]);
    audio.preload = "auto";
    player = { audio, playing: false, warmed: false, operation: 0 };
    players.set(sound, player);
  }
  return player;
}

export function prepareNotificationChimeAudio(): void {
  if (typeof window === "undefined" || typeof window.Audio === "undefined")
    return;
  for (const sound of NOTIFICATION_CHIME_SOUNDS) {
    if (sound === "none") continue;
    try {
      const player = getChimePlayer(sound);
      if (player.playing || player.warmed) continue;
      const { audio } = player;
      const operation = ++player.operation;
      // A real silent file unlocks the same element on Safari too; playing a
      // muted chime would not grant permission for later audible playback.
      audio.src = silenceUrl;
      const restoreChime = (): void => {
        if (players.get(sound) !== player || player.operation !== operation)
          return;
        audio.pause();
        audio.src = CHIME_URLS[sound];
        audio.load();
      };
      void audio.play().then(() => {
        if (players.get(sound) !== player || player.operation !== operation)
          return;
        player.warmed = true;
        restoreChime();
      }, restoreChime);
    } catch {
      // Notifications must remain usable when the audio device is unavailable.
    }
  }
}

export function installNotificationChimeAudioWarmup(): () => void {
  if (typeof window === "undefined") return () => undefined;
  // HTML media opens its audio backend asynchronously. AudioContext's native
  // constructor can block this thread for 20 seconds on a Mac with no output.
  prepareNotificationChimeAudio();
  const removeListeners = (): void => {
    window.removeEventListener("pointerdown", prepareAndRemove, true);
    window.removeEventListener("keydown", prepareAndRemove, true);
  };
  const prepareAndRemove = (): void => {
    prepareNotificationChimeAudio();
    removeListeners();
  };
  window.addEventListener("pointerdown", prepareAndRemove, true);
  window.addEventListener("keydown", prepareAndRemove, true);
  return removeListeners;
}

function releaseAudio(audio: HTMLAudioElement): void {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

export function disposeNotificationChimeAudio(): void {
  for (const { audio } of players.values()) releaseAudio(audio);
  players.clear();
}

export function playNotificationChimeSound(
  sound: NotificationChimeSound,
): void {
  if (
    sound === "none" ||
    typeof window === "undefined" ||
    typeof window.Audio === "undefined"
  )
    return;
  try {
    const player = getChimePlayer(sound);
    const { audio } = player;
    const operation = ++player.operation;
    player.playing = true;
    // Supersede an in-flight silent warmup without letting its promise pause
    // the notification (a settings preview can happen in the same gesture).
    if (!player.warmed) audio.src = CHIME_URLS[sound];
    // Repeated instances of one sound restart its unlocked element; distinct sounds overlap.
    audio.currentTime = 0;
    const release = (): void => {
      if (player.operation === operation) player.playing = false;
    };
    audio.onended = release;
    audio.onerror = release;
    void audio.play().then(() => {
      if (player.operation === operation) player.warmed = true;
    }, release);
  } catch {
    // Autoplay and missing devices must not interrupt notification delivery.
  }
}
