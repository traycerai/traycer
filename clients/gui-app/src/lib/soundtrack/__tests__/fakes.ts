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
  private readonly base = Date.now();
  private buses = 0;

  currentTime(): number {
    return (Date.now() - this.base) / 1000;
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

  createChild(): OutputGain {
    const child = new FakeGain(
      `${this.name}/${String(this.children)}`,
      this.output,
    );
    this.children += 1;
    return child;
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
