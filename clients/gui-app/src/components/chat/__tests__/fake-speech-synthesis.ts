import { vi } from "vitest";

/**
 * A stand-in for the browser speech engine: utterances queue in order, and a
 * test decides when each one ends or fails. `cancel` interrupts everything
 * queued with an error event, as browsers do.
 */

export interface FakeVoice {
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
  readonly default: boolean;
  readonly voiceURI: string;
}

class FakeUtterance {
  readonly text: string;
  voice: FakeVoice | null = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

export interface FakeSynth {
  voices: FakeVoice[];
  readonly spoken: FakeUtterance[];
  readonly speak: (utterance: FakeUtterance) => void;
  readonly cancel: () => void;
  readonly getVoices: () => FakeVoice[];
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
  readonly fireVoicesChanged: () => void;
  /** Ends the utterance now playing. */
  readonly finishCurrent: () => void;
  /** Fails the utterance now playing, leaving the rest of the queue. */
  readonly failCurrent: () => void;
  /** Ends utterances until nothing is queued. */
  readonly finishAll: () => void;
  readonly cancelCount: () => number;
}

export function fakeVoice(
  name: string,
  localService: boolean,
  isDefault: boolean,
): FakeVoice {
  return {
    name,
    lang: "en-US",
    localService,
    default: isDefault,
    voiceURI: name,
  };
}

export const LOCAL_VOICE = fakeVoice("Samantha", true, false);
// Chrome lists its Google voices first and can mark one the default; they
// synthesize on Google's servers and report `localService: false`.
export const NETWORK_VOICE = fakeVoice("Google US English", false, true);

export function createSynth(voices: FakeVoice[]): FakeSynth {
  let queue: FakeUtterance[] = [];
  const spoken: FakeUtterance[] = [];
  const listeners = new Set<() => void>();
  const cancel = vi.fn(() => {
    const interrupted = queue;
    queue = [];
    for (const utterance of interrupted) utterance.onerror?.();
  });
  const synth: FakeSynth = {
    voices,
    spoken,
    speak: vi.fn((utterance: FakeUtterance) => {
      queue.push(utterance);
      spoken.push(utterance);
    }),
    cancel,
    getVoices: () => synth.voices,
    addEventListener: (type, listener) => {
      if (type === "voiceschanged") listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "voiceschanged") listeners.delete(listener);
    },
    fireVoicesChanged: () => {
      for (const listener of [...listeners]) listener();
    },
    finishCurrent: () => {
      queue.shift()?.onend?.();
    },
    failCurrent: () => {
      queue.shift()?.onerror?.();
    },
    finishAll: () => {
      while (queue.length > 0) queue.shift()?.onend?.();
    },
    cancelCount: () => cancel.mock.calls.length,
  };
  return synth;
}

export function installSpeech(synth: FakeSynth | null): void {
  if (synth === null) {
    Reflect.deleteProperty(window, "speechSynthesis");
    Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
    return;
  }
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    writable: true,
    value: synth,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    writable: true,
    value: FakeUtterance,
  });
}
