import type { StemDecoder } from "./stems";

/** A sample scheduled or sounding. */
export interface OutputVoice {
  /** Fades to silence from now over `fadeSeconds`, then stops. */
  cut(fadeSeconds: number): void;
}

export interface OutputGain {
  /** Moves linearly from the current value to `target` over `seconds`. */
  ramp(target: number, seconds: number): void;
  /** A gain that feeds this one. */
  createChild(initial: number): OutputGain;
  /** Starts `buffer` at clock time `when`, fading in, feeding this gain. */
  play(buffer: AudioBuffer, when: number, fadeInSeconds: number): OutputVoice;
}

/** All a player asks of Web Audio. */
export interface SoundtrackOutput {
  /** The clock every scheduled time is on, in seconds. */
  currentTime(): number;
  /** A gain that feeds the output. */
  createBus(initial: number): OutputGain;
}

// A voice outlives its fade by this much, so the stop never clips the ramp.
const STOP_AFTER_FADE_SECONDS = 0.01;

function rampParam(
  param: AudioParam,
  now: number,
  target: number,
  seconds: number,
): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + seconds);
}

class WebAudioGain implements OutputGain {
  private readonly context: BaseAudioContext;
  private readonly node: GainNode;

  constructor(
    context: BaseAudioContext,
    destination: AudioNode,
    initial: number,
  ) {
    this.context = context;
    this.node = context.createGain();
    this.node.gain.value = initial;
    this.node.connect(destination);
  }

  ramp(target: number, seconds: number): void {
    rampParam(this.node.gain, this.context.currentTime, target, seconds);
  }

  createChild(initial: number): OutputGain {
    return new WebAudioGain(this.context, this.node, initial);
  }

  play(buffer: AudioBuffer, when: number, fadeInSeconds: number): OutputVoice {
    const { context } = this;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const fade = context.createGain();
    fade.gain.setValueAtTime(0, when);
    fade.gain.linearRampToValueAtTime(1, when + fadeInSeconds);
    source.connect(fade);
    fade.connect(this.node);
    source.addEventListener(
      "ended",
      () => {
        source.disconnect();
        fade.disconnect();
      },
      { once: true },
    );
    source.start(when);
    return {
      cut: (fadeSeconds) => {
        const now = context.currentTime;
        rampParam(fade.gain, now, 0, fadeSeconds);
        source.stop(now + fadeSeconds + STOP_AFTER_FADE_SECONDS);
      },
    };
  }
}

/**
 * The real port. The caller creates the context and passes it in, because the
 * native `AudioContext` constructor can block the thread for 20 seconds on a
 * Mac with no output (see `lib/notifications/notification-chime.ts`): that wait
 * belongs to a moment the caller chooses, so nothing here ever constructs one.
 * `destination` is where the mix goes, so that a caller can put its own volume
 * or filter in front of the speakers.
 */
export class WebAudioOutput implements SoundtrackOutput, StemDecoder {
  private readonly context: BaseAudioContext;
  private readonly destination: AudioNode;

  constructor(context: BaseAudioContext, destination: AudioNode) {
    this.context = context;
    this.destination = destination;
  }

  currentTime(): number {
    return this.context.currentTime;
  }

  createBus(initial: number): OutputGain {
    return new WebAudioGain(this.context, this.destination, initial);
  }

  decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return this.context.decodeAudioData(bytes);
  }
}
