import { MIX_TUNING } from "./mix-tuning";
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

/** Stops the param where it is, for a new ramp to start from. */
function holdParam(param: AudioParam, now: number): void {
  const value = param.value;
  // Cancelling a ramp under way can let one sample through at whatever came
  // before that ramp: a click. Holding leaves no gap, but adds no event when no
  // ramp is under way, so the value is still set for the new ramp to start from.
  // Firefox has no such method, so it takes the way with the risk.
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(now);
  } else {
    param.cancelScheduledValues(now);
  }
  param.setValueAtTime(value, now);
}

function rampParam(
  param: AudioParam,
  now: number,
  target: number,
  seconds: number,
): void {
  holdParam(param, now);
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
    // Silent from creation: a gain node reads 1 until its first event.
    fade.gain.value = 0;
    fade.gain.setValueAtTime(0, when);
    fade.gain.linearRampToValueAtTime(1, when + fadeInSeconds);
    source.connect(fade);
    fade.connect(this.node);
    const disconnect = (): void => {
      source.disconnect();
      fade.disconnect();
    };
    source.addEventListener("ended", disconnect, { once: true });
    source.start(when);
    return {
      cut: (fadeSeconds) => {
        const now = context.currentTime;
        // Not started yet: a ramp would replace its fade-in, and the source
        // would then start at whatever the ramp had reached, as a click.
        if (now <= when) {
          source.stop(now);
          disconnect();
          return;
        }
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

/** A low-pass in front of `destination`, wide open until it is dimmed. */
export class WebAudioDimFilter {
  /** Where the mix goes in. */
  readonly input: AudioNode;
  private readonly context: BaseAudioContext;
  private readonly filter: BiquadFilterNode;
  private dimmed = false;

  constructor(context: BaseAudioContext, destination: AudioNode) {
    const { openHz, q } = MIX_TUNING.dim;
    this.context = context;
    this.filter = context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = openHz;
    this.filter.Q.value = q;
    this.filter.connect(destination);
    this.input = this.filter;
  }

  /** A plan restates this every few seconds; only a change moves the filter. */
  setDimmed(dimmed: boolean): void {
    if (dimmed === this.dimmed) return;
    this.dimmed = dimmed;
    const { openHz, dimmedHz, rampSeconds } = MIX_TUNING.dim;
    const now = this.context.currentTime;
    holdParam(this.filter.frequency, now);
    // Pitch is heard in ratios, so a straight line in Hz would seem to drop at
    // once and then hang.
    this.filter.frequency.exponentialRampToValueAtTime(
      dimmed ? dimmedHz : openHz,
      now + rampSeconds,
    );
  }
}
