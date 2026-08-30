import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  disposeNotificationChimeAudio,
  notificationChimeEventTypeForSeverities,
  playNotificationChimeSound,
  prepareNotificationChimeAudio,
} from "@/lib/notifications/notification-chime";

const oscillators: Array<{
  readonly frequency: {
    readonly exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    readonly setValueAtTime: ReturnType<typeof vi.fn>;
  };
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
}> = [];

class FakeAudioContext {
  readonly currentTime = 2;
  readonly destination = {};
  state: AudioContextState = "running";
  readonly close = vi.fn(() => Promise.resolve());
  readonly resume = vi.fn(() => Promise.resolve());

  createOscillator() {
    const oscillator = {
      type: "sine" as OscillatorType,
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
}

afterEach(() => {
  disposeNotificationChimeAudio();
  oscillators.length = 0;
  vi.unstubAllGlobals();
});

describe("playNotificationChimeSound", () => {
  it("primes the audio renderer before the first audible chime", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    prepareNotificationChimeAudio();

    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].start).toHaveBeenCalledWith(2);
    expect(oscillators[0].stop).toHaveBeenCalledWith(2.02);
  });

  it("does not create an audio context when chimes are disabled", () => {
    const AudioContext = vi.fn(FakeAudioContext);
    vi.stubGlobal("AudioContext", AudioContext);

    playNotificationChimeSound("none");

    expect(AudioContext).not.toHaveBeenCalled();
  });

  it("plays Classic as a bell fundamental with a short octave shimmer", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    playNotificationChimeSound("classic");

    expect(oscillators).toHaveLength(2);
    expect(oscillators[0].start.mock.calls[0][0]).toBeCloseTo(2.005);
    expect(oscillators[0].stop.mock.calls[0][0]).toBeCloseTo(2.345);
    expect(oscillators[1].stop.mock.calls[0][0]).toBeCloseTo(2.165);
  });

  it("plays Prism as a three-note ascending chord", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    playNotificationChimeSound("prism");

    expect(oscillators).toHaveLength(3);
    expect(oscillators[0].start.mock.calls[0][0]).toBeCloseTo(2.005);
    expect(oscillators[1].start.mock.calls[0][0]).toBeCloseTo(2.095);
    expect(oscillators[2].start.mock.calls[0][0]).toBeCloseTo(2.185);
  });

  it("plays Ripple with fast upward water-drop motion", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    playNotificationChimeSound("ripple");

    expect(oscillators).toHaveLength(2);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      440,
      2.005,
    );
    const frequencyRamp =
      oscillators[0].frequency.exponentialRampToValueAtTime.mock.calls[0];
    expect(frequencyRamp[0]).toBe(880);
    expect(frequencyRamp[1]).toBeCloseTo(2.095);
  });

  it("plays Rift as a restrained descending failure cue", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    playNotificationChimeSound("rift");

    expect(oscillators).toHaveLength(3);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      659.25,
      2.005,
    );
    expect(oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      622.25,
      2.105,
    );
    expect(oscillators[2].frequency.setValueAtTime).toHaveBeenCalledWith(
      440,
      2.205,
    );
    expect(oscillators[2].stop.mock.calls[0][0]).toBeCloseTo(2.415);
  });

  it("reuses one interactive audio context across chimes", () => {
    const AudioContext = vi.fn(FakeAudioContext);
    vi.stubGlobal("AudioContext", AudioContext);

    playNotificationChimeSound("classic");
    playNotificationChimeSound("ember");

    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(AudioContext).toHaveBeenCalledWith({ latencyHint: "interactive" });
  });

  it("resumes a suspended audio context before scheduling the chime", async () => {
    const contexts: FakeAudioContext[] = [];
    class SuspendedAudioContext extends FakeAudioContext {
      constructor() {
        super();
        this.state = "suspended";
        contexts.push(this);
      }
    }
    vi.stubGlobal("AudioContext", SuspendedAudioContext);

    playNotificationChimeSound("classic");

    const context = contexts[0];
    expect(context.resume).toHaveBeenCalledOnce();
    expect(oscillators).toHaveLength(0);
    await context.resume.mock.results[0].value;
    await Promise.resolve();
    expect(oscillators).toHaveLength(2);
  });

  it.each([
    ["coin", 2],
    ["bloop", 1],
    ["cuckoo", 4],
    ["ta-da", 6],
    ["beacon", 3],
  ] as const)("plays the %s recipe", (sound, voiceCount) => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    playNotificationChimeSound(sound);

    expect(oscillators).toHaveLength(voiceCount);
  });

  it("plays Ta-da as two pickups followed by a compact chord landing", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);

    playNotificationChimeSound("ta-da");

    expect(oscillators[0].start.mock.calls[0][0]).toBeCloseTo(2.005);
    expect(oscillators[1].start.mock.calls[0][0]).toBeCloseTo(2.075);
    expect(oscillators[2].start.mock.calls[0][0]).toBeCloseTo(2.15);
    expect(oscillators[5].stop.mock.calls[0][0]).toBeCloseTo(2.29);
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
