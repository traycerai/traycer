import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  disposeNotificationChimeAudio,
  notificationChimeEventTypeForSeverities,
  playNotificationChimeSound,
  prepareNotificationChimeAudio,
} from "@/lib/notifications/notification-chime";
import { __setBrowserDocumentHiddenForTests } from "@/lib/dom/document-visibility";

type AudioParamMock = Mock<(value: number, atTime: number) => void>;
type OscillatorEventMock = Mock<(atTime: number) => void>;

const oscillators: Array<{
  readonly frequency: {
    readonly exponentialRampToValueAtTime: AudioParamMock;
    readonly setValueAtTime: AudioParamMock;
  };
  readonly start: OscillatorEventMock;
  readonly stop: OscillatorEventMock;
  onended: (() => void) | null;
}> = [];

class FakeAudioContext {
  readonly currentTime = 2;
  readonly destination = {};
  state: AudioContextState = "running";
  readonly close = vi.fn(() => Promise.resolve());
  readonly resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });
  readonly suspend = vi.fn(() => {
    this.state = "suspended";
    return Promise.resolve();
  });

  createOscillator() {
    const oscillator = {
      type: "sine" as OscillatorType,
      frequency: {
        setValueAtTime: vi.fn<(value: number, atTime: number) => void>(),
        exponentialRampToValueAtTime:
          vi.fn<(value: number, atTime: number) => void>(),
      },
      connect: vi.fn(),
      start: vi.fn<(atTime: number) => void>(),
      stop: vi.fn<(atTime: number) => void>(),
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

  it("suspends the audio context after warmup so an idle renderer is not holding a running context", () => {
    const contexts: FakeAudioContext[] = [];
    class TrackingAudioContext extends FakeAudioContext {
      constructor() {
        super();
        contexts.push(this);
      }
    }
    vi.stubGlobal("AudioContext", TrackingAudioContext);

    prepareNotificationChimeAudio();

    expect(contexts).toHaveLength(1);
    expect(contexts[0].suspend).toHaveBeenCalledOnce();
    expect(contexts[0].state).toBe("suspended");
  });

  it("plays a chime while the document is hidden after warmup left the context suspended", async () => {
    const contexts: FakeAudioContext[] = [];
    class TrackingAudioContext extends FakeAudioContext {
      constructor() {
        super();
        contexts.push(this);
      }
    }
    vi.stubGlobal("AudioContext", TrackingAudioContext);

    prepareNotificationChimeAudio();
    expect(contexts[0].state).toBe("suspended");
    const oscillatorsAfterWarmup = oscillators.length;

    try {
      __setBrowserDocumentHiddenForTests(true);
      playNotificationChimeSound("classic");

      expect(contexts[0].resume).toHaveBeenCalledOnce();
      await contexts[0].resume.mock.results[0].value;
      await Promise.resolve();
      expect(oscillators.length).toBeGreaterThan(oscillatorsAfterWarmup);
    } finally {
      __setBrowserDocumentHiddenForTests(false);
    }
  });

  it("resumes again if a chime starts while an idle suspend is still in flight", async () => {
    const contexts: FakeAudioContext[] = [];
    let releaseSuspend: () => void = () => undefined;
    class DeferredSuspendContext extends FakeAudioContext {
      constructor() {
        super();
        contexts.push(this);
      }

      override readonly suspend = vi.fn(() => {
        return new Promise<void>((resolve) => {
          releaseSuspend = () => {
            this.state = "suspended";
            resolve();
          };
        });
      });
    }
    vi.stubGlobal("AudioContext", DeferredSuspendContext);

    prepareNotificationChimeAudio();
    expect(contexts[0].suspend).toHaveBeenCalledOnce();
    expect(contexts[0].state).toBe("running");

    playNotificationChimeSound("classic");
    expect(oscillators.length).toBeGreaterThan(1);
    expect(contexts[0].state).toBe("running");

    releaseSuspend();
    await Promise.resolve();
    await Promise.resolve();
    expect(contexts[0].resume).toHaveBeenCalled();
    expect(contexts[0].state).toBe("running");
  });

  it("suspends after the last oscillator of a chime ends", () => {
    const contexts: FakeAudioContext[] = [];
    class TrackingAudioContext extends FakeAudioContext {
      constructor() {
        super();
        contexts.push(this);
      }
    }
    vi.stubGlobal("AudioContext", TrackingAudioContext);

    playNotificationChimeSound("classic");
    const ended = oscillators.find((oscillator) => oscillator.onended !== null);
    expect(ended?.onended).toEqual(expect.any(Function));
    ended?.onended?.();
    expect(contexts[0].suspend).toHaveBeenCalledOnce();
    expect(contexts[0].state).toBe("suspended");
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
