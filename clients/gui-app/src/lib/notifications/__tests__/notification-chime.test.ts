import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  NOTIFICATION_CHIME_SOUNDS,
  disposeNotificationChimeAudio,
  installNotificationChimeAudioWarmup,
  listenToNotificationChimes,
  onNextAudioGesture,
  notificationChimeEventTypeForSeverities,
  playNotificationChimeSound,
  prepareNotificationChimeAudio,
} from "@/lib/notifications/notification-chime";
import { restoreDefaultAudioSession } from "@/lib/audio-session";
import { setMobileApp } from "@/lib/mobile-app";

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
  readonly plays: Promise<void>[] = [];
  preload = "";
  duration = 0.4;
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
    const play = new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      if (playMode === "allow") resolve();
      if (playMode === "block") {
        reject(new DOMException("blocked", "NotAllowedError"));
      }
    });
    this.plays.push(play);
    return play;
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

/**
 * The code chains its handlers onto a `play()` before the test can, so they
 * have run once these plays settle.
 */
function afterPlays(plays: ReadonlyArray<Promise<void>>): Promise<unknown> {
  return Promise.allSettled(plays);
}

function afterAllPlays(): Promise<unknown> {
  return afterPlays(audios.flatMap((audio) => audio.plays));
}

const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function useUserAgent(ua: string): void {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

/** WebKit's `navigator.audioSession`, which the page types and WebKit activates. */
interface FakeAudioSession {
  type: string;
  state: "inactive" | "active" | "interrupted";
}

function installAudioSession(
  state: FakeAudioSession["state"],
): FakeAudioSession {
  const session: FakeAudioSession = { type: "auto", state };
  Object.defineProperty(window.navigator, "audioSession", {
    configurable: true,
    value: session,
  });
  return session;
}

beforeEach(() => {
  playMode = "allow";
  vi.stubGlobal("Audio", FakeAudio);
  useUserAgent(SAFARI_UA);
});

afterEach(() => {
  disposeNotificationChimeAudio();
  restoreDefaultAudioSession();
  audios.length = 0;
  setMobileApp(false);
  Reflect.deleteProperty(window.navigator, "audioSession");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    await afterAllPlays();

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
    await afterAllPlays();
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

  it("in a WebKit browser, plays nothing at startup and unlocks every chime on the first gesture, once", async () => {
    const uninstall = installNotificationChimeAudioWarmup();
    try {
      expect(audios).toHaveLength(0);

      window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await afterAllPlays();
      expect(audios).toHaveLength(AUDIBLE_SOUNDS.length);
      for (const audio of audios) {
        expect(audio.played.map(fileName)).toEqual(["silence.wav"]);
        expect(audio.src).toBe(audio.home);
      }

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      for (const audio of audios) expect(audio.played).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  it.each([
    ["the installed app", SAFARI_UA, true],
    ["a Chromium browser", CHROME_UA, false],
  ] as const)(
    "plays nothing at startup or on a gesture in %s",
    (_shell, ua, mobileApp) => {
      useUserAgent(ua);
      setMobileApp(mobileApp);
      const uninstall = installNotificationChimeAudioWarmup();
      try {
        window.dispatchEvent(new Event("pointerdown", { bubbles: true }));

        expect(audios).toHaveLength(0);
      } finally {
        uninstall();
      }
    },
  );

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
      await afterPlays([classic.plays[0]]);

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
    await afterAllPlays();

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

describe("notification chime listeners", () => {
  const heard = vi.fn<(chimeSeconds: number) => void>();
  // A listener is for good, so one is registered for the file.
  listenToNotificationChimes((chimeSeconds) => {
    heard(chimeSeconds);
  });

  beforeEach(() => {
    heard.mockClear();
  });

  it("hears the element's duration once the chime has started", async () => {
    playNotificationChimeSound("ripple");
    cachedAudioFor("ripple").duration = 0.435;
    // play() has been called but its promise has not yet answered.
    expect(heard).not.toHaveBeenCalled();

    await afterAllPlays();

    expect(heard).toHaveBeenCalledExactlyOnceWith(0.435);
  });

  it("hears nothing for the none sound", () => {
    playNotificationChimeSound("none");
    expect(heard).not.toHaveBeenCalled();
  });

  it("hears nothing when play() is refused", async () => {
    playMode = "block";
    playNotificationChimeSound("ripple");
    await afterAllPlays();
    expect(heard).not.toHaveBeenCalled();
  });

  it("hears only the play that was not superseded", async () => {
    playMode = "manual";
    playNotificationChimeSound("classic");
    playNotificationChimeSound("classic");
    const [first, second] = cachedAudioFor("classic").pending;

    first.resolve();
    await afterPlays([cachedAudioFor("classic").plays[0]]);
    expect(heard).not.toHaveBeenCalled();

    second.resolve();
    await afterPlays([cachedAudioFor("classic").plays[1]]);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("onNextAudioGesture", () => {
  it("runs once on the first press or key and no more, and can be called off", () => {
    const run = vi.fn<() => void>();
    onNextAudioGesture(run);
    expect(run).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);

    const calledOff = vi.fn<() => void>();
    onNextAudioGesture(calledOff)();
    window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(calledOff).not.toHaveBeenCalled();
  });
});

describe("notification chime audio session", () => {
  it("plays a chime ambient beside other apps' audio and hands the session back when it ends", async () => {
    const session = installAudioSession("inactive");

    playNotificationChimeSound("classic");
    expect(session.type).toBe("ambient");
    session.state = "active";
    await afterAllPlays();

    cachedAudioFor("classic").onended?.();
    expect(session.type).toBe("auto");
  });

  it("keeps the session ambient while a restarted chime still plays", () => {
    const session = installAudioSession("inactive");
    playNotificationChimeSound("classic");
    session.state = "active";

    playNotificationChimeSound("classic");
    expect(session.type).toBe("ambient");

    cachedAudioFor("classic").onended?.();
    expect(session.type).toBe("auto");
  });

  it("hands the session back when the chime is refused", async () => {
    playMode = "block";
    const session = installAudioSession("inactive");

    playNotificationChimeSound("classic");
    await afterAllPlays();

    expect(session.type).toBe("auto");
  });

  it("leaves a session another audio source holds as it is", () => {
    const session = installAudioSession("active");

    playNotificationChimeSound("classic");

    expect(session.type).toBe("auto");
  });

  it("gives audio that starts during a chime the default session, which the chime's end keeps", () => {
    const session = installAudioSession("inactive");
    playNotificationChimeSound("classic");
    session.state = "active";

    restoreDefaultAudioSession();
    expect(session.type).toBe("auto");
    session.type = "play-and-record";

    cachedAudioFor("classic").onended?.();
    expect(session.type).toBe("play-and-record");
  });

  it("types the first-gesture unlock ambient too", async () => {
    const session = installAudioSession("inactive");
    playMode = "manual";
    prepareNotificationChimeAudio();
    expect(session.type).toBe("ambient");

    for (const audio of audios) audio.pending[0].resolve();
    await afterAllPlays();

    expect(session.type).toBe("auto");
  });

  it("gives back the hold of a warmup a chime superseded, once that chime ends", async () => {
    const session = installAudioSession("inactive");
    playMode = "manual";
    prepareNotificationChimeAudio();
    playNotificationChimeSound("classic");
    session.state = "active";

    for (const audio of audios) audio.pending[0].resolve();
    await afterPlays(audios.map((audio) => audio.plays[0]));
    expect(session.type).toBe("ambient");

    const classic = cachedAudioFor("classic");
    classic.pending[1].resolve();
    await afterPlays([classic.plays[1]]);
    classic.onended?.();

    expect(session.type).toBe("auto");
  });
});
