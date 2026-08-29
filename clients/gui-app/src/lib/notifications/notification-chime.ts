export const CORE_NOTIFICATION_CHIME_SOUNDS = [
  "classic",
  "prism",
  "ripple",
  "ember",
  "orbit",
] as const;

export const PLAYFUL_NOTIFICATION_CHIME_SOUNDS = [
  "coin",
  "bloop",
  "cuckoo",
  "ta-da",
  "beacon",
] as const;

export const NOTIFICATION_CHIME_SOUNDS = [
  ...CORE_NOTIFICATION_CHIME_SOUNDS,
  ...PLAYFUL_NOTIFICATION_CHIME_SOUNDS,
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
    failure: "beacon",
    done: "prism",
    info: "ember",
  };

interface FrequencyWaypoint {
  readonly frequency: number;
  readonly time: number;
}

interface ChimeVoice {
  readonly attack: number;
  readonly delay: number;
  readonly duration: number;
  readonly endFrequency: number;
  readonly frequencyRampDuration: number;
  readonly gain: number;
  readonly startFrequency: number;
  readonly type: OscillatorType;
  readonly decayStart?: number;
  readonly decayTimeConstant?: number;
  readonly frequencyWaypoints?: ReadonlyArray<FrequencyWaypoint>;
}

const CHIME_MASTER_GAIN = 0.12;
const SILENCE_GAIN = 0.0001;
const SCHEDULE_AHEAD_SECONDS = 0.005;

const CHIME_VOICES: Readonly<
  Record<Exclude<NotificationChimeSound, "none">, ReadonlyArray<ChimeVoice>>
> = {
  classic: [
    {
      attack: 0.01,
      delay: 0,
      duration: 0.32,
      endFrequency: 880,
      frequencyRampDuration: 0.32,
      gain: 1,
      startFrequency: 880,
      type: "sine",
    },
    {
      attack: 0.004,
      delay: 0,
      duration: 0.14,
      endFrequency: 1760,
      frequencyRampDuration: 0.14,
      gain: 0.22,
      startFrequency: 1760,
      type: "sine",
    },
  ],
  prism: [
    {
      attack: 0.005,
      delay: 0,
      duration: 0.17,
      endFrequency: 659.25,
      frequencyRampDuration: 0.17,
      gain: 0.7,
      startFrequency: 659.25,
      type: "triangle",
    },
    {
      attack: 0.005,
      delay: 0.09,
      duration: 0.17,
      endFrequency: 880,
      frequencyRampDuration: 0.17,
      gain: 0.8,
      startFrequency: 880,
      type: "triangle",
    },
    {
      attack: 0.005,
      delay: 0.18,
      duration: 0.22,
      endFrequency: 1108.73,
      frequencyRampDuration: 0.22,
      gain: 0.9,
      startFrequency: 1108.73,
      type: "triangle",
    },
  ],
  ripple: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.26,
      endFrequency: 880,
      frequencyRampDuration: 0.09,
      gain: 1,
      startFrequency: 440,
      type: "sine",
    },
    {
      attack: 0.003,
      delay: 0.17,
      duration: 0.24,
      endFrequency: 659.25,
      frequencyRampDuration: 0.09,
      gain: 0.3,
      startFrequency: 330,
      type: "sine",
    },
  ],
  ember: [
    {
      attack: 0.012,
      delay: 0,
      duration: 0.42,
      endFrequency: 440,
      frequencyRampDuration: 0.42,
      gain: 0.9,
      startFrequency: 440,
      type: "triangle",
    },
    {
      attack: 0.012,
      delay: 0,
      duration: 0.3,
      endFrequency: 659.25,
      frequencyRampDuration: 0.3,
      gain: 0.3,
      startFrequency: 659.25,
      type: "sine",
    },
  ],
  orbit: [
    {
      attack: 0.005,
      delay: 0,
      duration: 0.16,
      endFrequency: 880,
      frequencyRampDuration: 0.16,
      gain: 0.9,
      startFrequency: 880,
      type: "sine",
    },
    {
      attack: 0.005,
      delay: 0.17,
      duration: 0.28,
      endFrequency: 659.25,
      frequencyRampDuration: 0.28,
      gain: 1,
      startFrequency: 659.25,
      type: "sine",
    },
    {
      attack: 0.005,
      delay: 0.17,
      duration: 0.28,
      endFrequency: 661,
      frequencyRampDuration: 0.28,
      gain: 0.35,
      startFrequency: 661,
      type: "sine",
    },
  ],
  coin: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.085,
      endFrequency: 988,
      frequencyRampDuration: 0.085,
      gain: 0.5,
      startFrequency: 988,
      type: "square",
      decayStart: 0.082,
      decayTimeConstant: 0.004,
    },
    {
      attack: 0.003,
      delay: 0.085,
      duration: 0.25,
      endFrequency: 1319,
      frequencyRampDuration: 0.25,
      gain: 0.5,
      startFrequency: 1319,
      type: "square",
      decayStart: 0.003,
      decayTimeConstant: 0.09,
    },
  ],
  bloop: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.24,
      endFrequency: 900,
      frequencyRampDuration: 0.17,
      frequencyWaypoints: [{ frequency: 350, time: 0.07 }],
      gain: 1,
      startFrequency: 700,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.07,
    },
  ],
  cuckoo: [
    {
      attack: 0.005,
      delay: 0,
      duration: 0.15,
      endFrequency: 784,
      frequencyRampDuration: 0.15,
      gain: 1,
      startFrequency: 784,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.06,
    },
    {
      attack: 0.005,
      delay: 0,
      duration: 0.15,
      endFrequency: 1176,
      frequencyRampDuration: 0.15,
      gain: 0.15,
      startFrequency: 1176,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.06,
    },
    {
      attack: 0.005,
      delay: 0.2,
      duration: 0.22,
      endFrequency: 622,
      frequencyRampDuration: 0.22,
      gain: 1,
      startFrequency: 622,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.09,
    },
    {
      attack: 0.005,
      delay: 0.2,
      duration: 0.22,
      endFrequency: 933,
      frequencyRampDuration: 0.22,
      gain: 0.15,
      startFrequency: 933,
      type: "sine",
      decayStart: 0.005,
      decayTimeConstant: 0.09,
    },
  ],
  "ta-da": [
    {
      attack: 0.004,
      delay: 0,
      duration: 0.07,
      endFrequency: 440,
      frequencyRampDuration: 0.025,
      gain: 0.38,
      startFrequency: 415.3,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.025,
    },
    {
      attack: 0.004,
      delay: 0.07,
      duration: 0.075,
      endFrequency: 554.37,
      frequencyRampDuration: 0.025,
      gain: 0.42,
      startFrequency: 523.25,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.028,
    },
    {
      attack: 0.004,
      delay: 0.145,
      duration: 0.25,
      endFrequency: 659.25,
      frequencyRampDuration: 0.25,
      gain: 0.55,
      startFrequency: 659.25,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.1,
    },
    {
      attack: 0.004,
      delay: 0.145,
      duration: 0.27,
      endFrequency: 880,
      frequencyRampDuration: 0.27,
      gain: 0.6,
      startFrequency: 880,
      type: "triangle",
      decayStart: 0.004,
      decayTimeConstant: 0.11,
    },
    {
      attack: 0.004,
      delay: 0.145,
      duration: 0.22,
      endFrequency: 1108.73,
      frequencyRampDuration: 0.22,
      gain: 0.35,
      startFrequency: 1108.73,
      type: "sine",
      decayStart: 0.004,
      decayTimeConstant: 0.09,
    },
    {
      attack: 0.003,
      delay: 0.155,
      duration: 0.11,
      endFrequency: 1760,
      frequencyRampDuration: 0.11,
      gain: 0.12,
      startFrequency: 1760,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.035,
    },
  ],
  beacon: [
    {
      attack: 0.003,
      delay: 0,
      duration: 0.09,
      endFrequency: 1047,
      frequencyRampDuration: 0.09,
      gain: 1,
      startFrequency: 1047,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.045,
    },
    {
      attack: 0.003,
      delay: 0.26,
      duration: 0.09,
      endFrequency: 1047,
      frequencyRampDuration: 0.09,
      gain: 0.3,
      startFrequency: 1047,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.045,
    },
    {
      attack: 0.003,
      delay: 0.44,
      duration: 0.09,
      endFrequency: 1047,
      frequencyRampDuration: 0.09,
      gain: 0.12,
      startFrequency: 1047,
      type: "sine",
      decayStart: 0.003,
      decayTimeConstant: 0.045,
    },
  ],
};

let notificationAudioContext: AudioContext | null = null;

function getNotificationAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (typeof window.AudioContext === "undefined") return null;
  if (
    notificationAudioContext === null ||
    notificationAudioContext.state === "closed"
  ) {
    notificationAudioContext = new window.AudioContext({
      latencyHint: "interactive",
    });
  }
  return notificationAudioContext;
}

export function prepareNotificationChimeAudio(): void {
  try {
    const context = getNotificationAudioContext();
    if (context?.state !== "suspended") return;
    void context.resume().catch(() => undefined);
  } catch {
    // Audio setup can be rejected by autoplay or device restrictions.
  }
}

export function installNotificationChimeAudioWarmup(): () => void {
  if (typeof window === "undefined") return () => undefined;
  // Construct early so the browser can bring up its audio backend before the
  // first notification. If autoplay policy suspends it, the listeners below
  // resume it inside the next trusted user gesture.
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

export function disposeNotificationChimeAudio(): void {
  const context = notificationAudioContext;
  notificationAudioContext = null;
  if (context === null || context.state === "closed") return;
  void context.close().catch(() => undefined);
}

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

export function playNotificationChimeSound(
  sound: NotificationChimeSound,
): void {
  if (sound === "none") return;

  try {
    const context = getNotificationAudioContext();
    if (context === null) return;

    const scheduleChime = (): void => {
      if (context.state === "closed") return;
      const voices = CHIME_VOICES[sound];
      const lastVoice = voices.reduce((latest, voice) =>
        voice.delay + voice.duration > latest.delay + latest.duration
          ? voice
          : latest,
      );
      const chimeStartsAt = context.currentTime + SCHEDULE_AHEAD_SECONDS;
      const master = context.createGain();
      master.gain.setValueAtTime(CHIME_MASTER_GAIN, chimeStartsAt);
      master.connect(context.destination);

      voices.forEach((voice) => {
        const startsAt = chimeStartsAt + voice.delay;
        const endsAt = startsAt + voice.duration;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = voice.type;
        oscillator.frequency.setValueAtTime(voice.startFrequency, startsAt);
        voice.frequencyWaypoints?.forEach((waypoint) => {
          oscillator.frequency.exponentialRampToValueAtTime(
            waypoint.frequency,
            startsAt + waypoint.time,
          );
        });
        oscillator.frequency.exponentialRampToValueAtTime(
          voice.endFrequency,
          startsAt + voice.frequencyRampDuration,
        );
        gain.gain.setValueAtTime(SILENCE_GAIN, startsAt);
        if (
          voice.decayStart !== undefined &&
          voice.decayTimeConstant !== undefined
        ) {
          gain.gain.linearRampToValueAtTime(
            voice.gain,
            startsAt + voice.attack,
          );
          gain.gain.setTargetAtTime(
            SILENCE_GAIN,
            startsAt + voice.decayStart,
            voice.decayTimeConstant,
          );
          gain.gain.exponentialRampToValueAtTime(SILENCE_GAIN, endsAt);
        } else {
          gain.gain.exponentialRampToValueAtTime(
            voice.gain,
            startsAt + voice.attack,
          );
          gain.gain.exponentialRampToValueAtTime(SILENCE_GAIN, endsAt);
        }
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(startsAt);
        oscillator.stop(endsAt + 0.02);
        if (voice === lastVoice) {
          oscillator.onended = () => master.disconnect();
        }
      });
    };

    if (context.state === "suspended") {
      void context
        .resume()
        .then(scheduleChime)
        .catch(() => undefined);
      return;
    }
    scheduleChime();
  } catch {
    // Audio setup can be rejected by autoplay or device restrictions.
  }
}
