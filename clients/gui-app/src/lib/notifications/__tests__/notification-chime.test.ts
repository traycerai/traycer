import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  NOTIFICATION_CHIME_SOUNDS,
  disposeNotificationChimeAudio,
  installNotificationChimeAudioWarmup,
  notificationChimeEventTypeForSeverities,
  playNotificationChimeSound,
  prepareNotificationChimeAudio,
} from "@/lib/notifications/notification-chime";

// The HTML media element is the hardware boundary: play() is where autoplay
// policy and the audio device answer. "allow" resolves, "block" rejects like an
// autoplay refusal, "manual" leaves each play() pending for the test to settle.
type PlayMode = "allow" | "block" | "manual";

interface PendingPlay {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

let playMode: PlayMode = "allow";
const audios: FakeAudio[] = [];

class FakeAudio {
  readonly home: string;
  readonly played: string[] = [];
  readonly pending: PendingPlay[] = [];
  preload = "";
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly pause = vi.fn();
  readonly load = vi.fn();

  constructor(public src: string) {
    this.home = src;
    audios.push(this);
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  play(): Promise<void> {
    this.played.push(this.src);
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      if (playMode === "allow") resolve();
      if (playMode === "block") {
        reject(new DOMException("blocked", "NotAllowedError"));
      }
    });
  }
}

const AUDIBLE_SOUNDS = NOTIFICATION_CHIME_SOUNDS.filter(
  (sound) => sound !== "none",
);

function fileName(url: string): string {
  return (url.split("/").pop() ?? "").split("?")[0];
}

function cachedAudioFor(sound: string): FakeAudio {
  const audio = audios.find((candidate) =>
    candidate.home.endsWith(`/${sound}.wav`),
  );
  if (audio === undefined) throw new Error(`no audio element for ${sound}`);
  return audio;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  playMode = "allow";
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
  disposeNotificationChimeAudio();
  audios.length = 0;
  vi.unstubAllGlobals();
});

describe("notification chime audio", () => {
  it("does not construct an AudioContext from app startup or the first user gesture", () => {
    const AudioContext = vi.fn();
    vi.stubGlobal("AudioContext", AudioContext);

    const uninstall = installNotificationChimeAudioWarmup();
    try {
      window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

      expect(AudioContext).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it("plays nothing for the none sound", () => {
    playNotificationChimeSound("none");

    expect(audios).toHaveLength(0);
  });

  it("warms with silence only, then leaves every chime asset cached", async () => {
    prepareNotificationChimeAudio();
    await settle();

    expect(audios.map((audio) => fileName(audio.home)).sort()).toEqual(
      AUDIBLE_SOUNDS.map((sound) => `${sound}.wav`).sort(),
    );
    for (const audio of audios) {
      expect(audio.played.map(fileName)).toEqual(["silence.wav"]);
      expect(audio.pause).toHaveBeenCalledOnce();
      expect(audio.src).toBe(audio.home);
    }
  });

  it("plays a chime from its warmed element from the start", async () => {
    prepareNotificationChimeAudio();
    await settle();
    const classic = cachedAudioFor("classic");
    classic.currentTime = 1.5;

    playNotificationChimeSound("classic");

    expect(audios).toHaveLength(AUDIBLE_SOUNDS.length);
    expect(classic.played.map(fileName)).toEqual([
      "silence.wav",
      "classic.wav",
    ]);
    expect(classic.currentTime).toBe(0);
  });

  it("retries a warmup that autoplay refused on the next user gesture, once", async () => {
    playMode = "block";
    const uninstall = installNotificationChimeAudioWarmup();
    try {
      await settle();
      for (const audio of audios) expect(audio.src).toBe(audio.home);

      playMode = "allow";
      window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await settle();
      for (const audio of audios) {
        expect(audio.played.map(fileName)).toEqual([
          "silence.wav",
          "silence.wav",
        ]);
        expect(audio.src).toBe(audio.home);
      }

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      await settle();
      for (const audio of audios) expect(audio.played).toHaveLength(2);
    } finally {
      uninstall();
    }
  });

  it.each(["resolves", "rejects"] as const)(
    "a chime started during warmup is not paused or reset when the stale warmup %s",
    async (outcome) => {
      playMode = "manual";
      prepareNotificationChimeAudio();
      const classic = cachedAudioFor("classic");

      playNotificationChimeSound("classic");
      expect(classic.played.map(fileName)).toEqual([
        "silence.wav",
        "classic.wav",
      ]);

      if (outcome === "resolves") classic.pending[0].resolve();
      else classic.pending[0].reject(new DOMException("aborted", "AbortError"));
      await settle();

      expect(classic.pause).not.toHaveBeenCalled();
      expect(classic.load).not.toHaveBeenCalled();
      expect(fileName(classic.src)).toBe("classic.wav");
    },
  );

  it("restarts the same sound on its one element while it plays, and overlaps distinct sounds", () => {
    playNotificationChimeSound("classic");
    const classic = cachedAudioFor("classic");
    classic.currentTime = 1.2;

    playNotificationChimeSound("classic");

    expect(audios).toHaveLength(1);
    expect(classic.currentTime).toBe(0);
    expect(classic.played.map(fileName)).toEqual([
      "classic.wav",
      "classic.wav",
    ]);

    playNotificationChimeSound("prism");

    expect(audios).toHaveLength(2);
    expect(cachedAudioFor("prism").played.map(fileName)).toEqual(["prism.wav"]);
    expect(classic.played).toHaveLength(2);
  });

  it("still plays a later chime after autoplay rejected an earlier one", async () => {
    playMode = "block";
    playNotificationChimeSound("classic");
    await settle();

    playMode = "allow";
    playNotificationChimeSound("classic");

    expect(audios).toHaveLength(1);
    expect(audios[0].played.map(fileName)).toEqual([
      "classic.wav",
      "classic.wav",
    ]);
  });

  it("disposal stops and releases every retained element", () => {
    playNotificationChimeSound("classic");
    prepareNotificationChimeAudio();

    disposeNotificationChimeAudio();

    for (const audio of audios) {
      expect(audio.pause).toHaveBeenCalled();
      expect(audio.src).toBe("");
    }
    const before = audios.length;
    playNotificationChimeSound("classic");
    expect(audios).toHaveLength(before + 1);
  });
});

describe("notificationChimeEventTypeForSeverities", () => {
  it("uses distinct semantic defaults for each notification lane", () => {
    expect(DEFAULT_NOTIFICATION_CHIME_SOUNDS).toEqual({
      needs_action: "orbit",
      failure: "rift",
      done: "prism",
      info: "ember",
    });
  });

  it("maps informational events and preserves batch priority", () => {
    expect(notificationChimeEventTypeForSeverities(["info"])).toBe("info");
    expect(
      notificationChimeEventTypeForSeverities(["info", "done", "failure"]),
    ).toBe("failure");
    expect(
      notificationChimeEventTypeForSeverities([
        "done",
        "failure",
        "needs_action",
      ]),
    ).toBe("needs_action");
  });
});
