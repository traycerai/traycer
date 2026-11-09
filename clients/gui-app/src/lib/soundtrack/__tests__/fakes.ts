import type { MixCapture } from "../recording";
import type { RandomSource } from "../scheduler";
import type { OutputGain, OutputVoice, SoundtrackOutput } from "../output";
import type { StemSource } from "../stems";
import type { Layer, VariableTrack } from "../variable-sound";
import { makeAudioBuffer } from "./audio-buffer";

interface PlayCall {
  readonly kind: "play";
  readonly gain: string;
  readonly duration: number;
  readonly when: number;
  readonly fadeIn: number;
  readonly at: number;
}
interface CutCall {
  readonly kind: "cut";
  readonly gain: string;
  readonly fade: number;
  readonly at: number;
}
interface RampCall {
  readonly kind: "ramp";
  readonly gain: string;
  readonly target: number;
  readonly seconds: number;
  readonly at: number;
}
type PortCall = PlayCall | CutCall | RampCall;

/** The ports' capture, for a fixture that never records. */
export function captureNothing(): Promise<MixCapture> {
  return Promise.reject(new Error("This fixture records nothing"));
}

/** mulberry32: the same draws on every run; each call owns its own state. */
export function mulberry32(seed: number): RandomSource {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isPlay(call: PortCall): call is PlayCall {
  return call.kind === "play";
}
function isCut(call: PortCall): call is CutCall {
  return call.kind === "cut";
}
export function isRamp(call: PortCall): call is RampCall {
  return call.kind === "ramp";
}

/** A port whose clock is the fake timers' clock, so ticks and time agree. */
export class FakeOutput implements SoundtrackOutput {
  readonly calls: PortCall[] = [];
  /** Each child gain's stereo position, by its name; null is the centre. */
  readonly pans = new Map<string, number | null>();
  private readonly base = Date.now();
  private buses = 0;
  /** How long the clock has stood still, and since when if it does now. */
  private stoodMs = 0;
  private stoppedAt: number | null = null;

  currentTime(): number {
    const reading = this.stoppedAt ?? Date.now();
    return (reading - this.base - this.stoodMs) / 1000;
  }

  /** What a suspended `AudioContext` does to its clock. */
  stopClock(): void {
    this.stoppedAt ??= Date.now();
  }

  startClock(): void {
    if (this.stoppedAt === null) return;
    this.stoodMs += Date.now() - this.stoppedAt;
    this.stoppedAt = null;
  }

  createBus(): OutputGain {
    const name = `bus${String(this.buses)}`;
    this.buses += 1;
    return new FakeGain(name, this);
  }

  plays(gain: string): PlayCall[] {
    return this.calls.filter(isPlay).filter((call) => call.gain === gain);
  }
  allPlays(): PlayCall[] {
    return this.calls.filter(isPlay);
  }
  cuts(): CutCall[] {
    return this.calls.filter(isCut);
  }
  ramps(gain: string): RampCall[] {
    return this.calls.filter(isRamp).filter((call) => call.gain === gain);
  }
}

class FakeGain implements OutputGain {
  private readonly name: string;
  private readonly output: FakeOutput;
  private children = 0;

  constructor(name: string, output: FakeOutput) {
    this.name = name;
    this.output = output;
  }

  ramp(target: number, seconds: number): void {
    this.output.calls.push({
      kind: "ramp",
      gain: this.name,
      target,
      seconds,
      at: this.output.currentTime(),
    });
  }

  createChild(_initial: number, pan: number | null): OutputGain {
    const name = `${this.name}/${String(this.children)}`;
    this.output.pans.set(name, pan);
    this.children += 1;
    return new FakeGain(name, this.output);
  }

  playRecording(
    buffer: AudioBuffer,
    when: number,
    _offset: number,
    _ended: () => void,
  ): OutputVoice {
    return this.play(buffer, when, 0.01);
  }

  play(buffer: AudioBuffer, when: number, fadeInSeconds: number): OutputVoice {
    this.output.calls.push({
      kind: "play",
      gain: this.name,
      duration: buffer.duration,
      when,
      fadeIn: fadeInSeconds,
      at: this.output.currentTime(),
    });
    return {
      cut: (fadeSeconds) => {
        this.output.calls.push({
          kind: "cut",
          gain: this.name,
          fade: fadeSeconds,
          at: this.output.currentTime(),
        });
      },
    };
  }
}

/** Every sample is `durationSeconds` long; a layer can fail or be held back. */
export class FakeStems implements StemSource {
  readonly requests: string[] = [];
  private readonly buffer: AudioBuffer;
  private readonly failing = new Set<string>();
  private readonly held = new Map<string, (() => void)[]>();

  constructor(durationSeconds: number) {
    this.buffer = makeAudioBuffer(durationSeconds, 10);
  }

  failLayer(layerName: string): void {
    this.failing.add(layerName);
  }

  holdLayer(layerName: string): void {
    this.held.set(layerName, []);
  }

  releaseLayer(layerName: string): void {
    for (const release of this.held.get(layerName) ?? []) release();
    this.held.delete(layerName);
  }

  load(
    _track: VariableTrack,
    layer: Layer,
    variant: number,
  ): Promise<AudioBuffer> {
    this.requests.push(`${layer.name}/${String(variant)}`);
    if (this.failing.has(layer.name)) {
      return Promise.reject(new Error("no such stem"));
    }
    const waiting = this.held.get(layer.name);
    if (waiting !== undefined) {
      return new Promise((resolve) => {
        waiting.push(() => {
          resolve(this.buffer);
        });
      });
    }
    return Promise.resolve(this.buffer);
  }
}
