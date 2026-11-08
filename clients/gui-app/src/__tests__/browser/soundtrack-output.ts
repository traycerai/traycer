import {
  WebAudioDimFilter,
  WebAudioLevel,
  WebAudioOutput,
} from "@/lib/soundtrack/output";
import { MIX_TUNING } from "@/lib/soundtrack/mix-tuning";
import type { SoundtrackPorts } from "@/lib/soundtrack/session";
import { openWebAudioPorts } from "@/lib/soundtrack/web-audio-ports";

/**
 * Browser fixture for what the soundtrack's Web Audio port puts in the output.
 *
 * WHY IT CANNOT BE A JSDOM TEST. A click is a rendered sample, and jsdom renders
 * no audio: only a browser's own automation timeline says what a gain reads on
 * each frame. See `browser-tests/soundtrack-output.spec.ts`.
 *
 * WHAT IS REAL: `WebAudioOutput`, `WebAudioDimFilter` and the browser's
 * `OfflineAudioContext`. In `render`, every voice plays a constant 1, so with
 * one voice sounding a rendered sample IS the gain on that frame.
 */

const SAMPLE_RATE = 48_000;

interface VoiceRequest {
  readonly when: number;
  readonly fadeInSeconds: number;
}

/** Runs on the render quantum its time falls in, while the render waits. */
type StepRequest =
  | {
      readonly kind: "ramp";
      readonly at: number;
      readonly target: number;
      readonly seconds: number;
    }
  | {
      readonly kind: "cut";
      readonly at: number;
      readonly voice: number;
      readonly seconds: number;
    };

interface RenderRequest {
  readonly seconds: number;
  readonly busGain: number;
  readonly voices: readonly VoiceRequest[];
  readonly steps: readonly StepRequest[];
  /** The biggest step is measured from here on. */
  readonly stepsFrom: number;
  /** The times to read a sample at. */
  readonly readAt: readonly number[];
}

interface Rendered {
  readonly peak: number;
  readonly biggestStep: number;
  readonly readings: readonly number[];
}

async function render(request: RenderRequest): Promise<Rendered> {
  const context = new OfflineAudioContext(
    1,
    Math.ceil(request.seconds * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const constantOne = context.createBuffer(
    1,
    context.length,
    context.sampleRate,
  );
  constantOne.getChannelData(0).fill(1);

  const bus = new WebAudioOutput(context, context.destination).createBus(
    request.busGain,
  );
  const voices = request.voices.map(({ when, fadeInSeconds }) =>
    bus.play(constantOne, when, fadeInSeconds),
  );
  for (const step of request.steps) {
    void context.suspend(step.at).then(() => {
      if (step.kind === "ramp") {
        bus.ramp(step.target, step.seconds);
      } else {
        voices[step.voice].cut(step.seconds);
      }
      return context.resume();
    });
  }

  const samples = (await context.startRendering()).getChannelData(0);
  let peak = 0;
  let biggestStep = 0;
  const firstStep = Math.round(request.stepsFrom * SAMPLE_RATE) + 1;
  for (const [index, sample] of samples.entries()) {
    peak = Math.max(peak, Math.abs(sample));
    if (index >= firstStep) {
      biggestStep = Math.max(
        biggestStep,
        Math.abs(sample - samples[index - 1]),
      );
    }
  }
  return {
    peak,
    biggestStep,
    readings: request.readAt.map(
      (time) => samples[Math.round(time * SAMPLE_RATE)],
    ),
  };
}

interface DimRequest {
  readonly seconds: number;
  readonly toneHz: number;
  readonly amplitude: number;
  /** Each runs on the render quantum its time falls in. */
  readonly steps: readonly { readonly at: number; readonly dimmed: boolean }[];
  /** Peak and RMS of the samples in each window, in seconds. */
  readonly windows: readonly { readonly from: number; readonly to: number }[];
}

interface DimRendered {
  readonly peaks: readonly number[];
  readonly rms: readonly number[];
}

/** A steady tone through `WebAudioDimFilter`, dimmed and undimmed on cue. */
async function renderDim(request: DimRequest): Promise<DimRendered> {
  const context = new OfflineAudioContext(
    1,
    Math.ceil(request.seconds * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const tone = context.createBuffer(1, context.length, context.sampleRate);
  const channel = tone.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) {
    channel[index] =
      request.amplitude *
      Math.sin((2 * Math.PI * request.toneHz * index) / SAMPLE_RATE);
  }
  const filter = new WebAudioDimFilter(context, context.destination);
  const source = context.createBufferSource();
  source.buffer = tone;
  source.connect(filter.input);
  source.start(0);
  for (const step of request.steps) {
    void context.suspend(step.at).then(() => {
      filter.setDimmed(step.dimmed);
      return context.resume();
    });
  }

  const samples = (await context.startRendering()).getChannelData(0);
  const peaks: number[] = [];
  const rms: number[] = [];
  for (const { from, to } of request.windows) {
    const first = Math.round(from * SAMPLE_RATE);
    const last = Math.round(to * SAMPLE_RATE);
    let peak = 0;
    let sumOfSquares = 0;
    for (let index = first; index < last; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]));
      sumOfSquares += samples[index] * samples[index];
    }
    peaks.push(peak);
    rms.push(Math.sqrt(sumOfSquares / (last - first)));
  }
  return { peaks, rms };
}

interface LevelRequest {
  readonly seconds: number;
  readonly volume: number;
  /** Each runs on the render quantum its time falls in. */
  readonly steps: readonly {
    readonly kind: "volume" | "duck";
    readonly at: number;
    readonly value: number;
  }[];
  readonly readAt: readonly number[];
}

interface LevelRendered {
  readonly readings: readonly number[];
  /** The biggest jump between neighbouring samples from the first step on. */
  readonly biggestStep: number;
}

/** A constant 1 through `WebAudioLevel`: a sample reads as the level itself. */
async function renderLevel(request: LevelRequest): Promise<LevelRendered> {
  const context = new OfflineAudioContext(
    1,
    Math.ceil(request.seconds * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const constantOne = context.createBuffer(
    1,
    context.length,
    context.sampleRate,
  );
  constantOne.getChannelData(0).fill(1);
  const level = new WebAudioLevel(context, context.destination, request.volume);
  const source = context.createBufferSource();
  source.buffer = constantOne;
  source.connect(level.input);
  source.start(0);
  for (const step of request.steps) {
    void context.suspend(step.at).then(() => {
      if (step.kind === "volume") level.setVolume(step.value);
      else level.duck(step.value);
      return context.resume();
    });
  }

  const samples = (await context.startRendering()).getChannelData(0);
  const firstStep = Math.round(request.steps[0].at * SAMPLE_RATE) + 1;
  let biggestStep = 0;
  for (let index = firstStep; index < samples.length; index += 1) {
    biggestStep = Math.max(
      biggestStep,
      Math.abs(samples[index] - samples[index - 1]),
    );
  }
  return {
    readings: request.readAt.map(
      (time) => samples[Math.round(time * SAMPLE_RATE)],
    ),
    biggestStep,
  };
}

/** What a live device read on one animation frame. */
interface LiveFrame {
  readonly state: AudioContextState;
  readonly time: number;
  /** The pause's own gain, in front of the speakers. */
  readonly audible: number;
}

interface LiveProbe {
  /** Opens the ports on a real `AudioContext`; call it after a gesture. */
  readonly open: () => void;
  readonly read: () => LiveFrame;
  readonly startRecording: () => void;
  readonly stopRecording: () => readonly LiveFrame[];
  readonly pause: () => void;
  readonly resume: () => void;
}

/**
 * The real ports over a running `AudioContext`, for what a pause does to the
 * real clock. The first gain made on the context (the pause's fade) is caught as
 * the ports build it, since the ports expose neither it nor the context.
 */
function createLiveProbe(): LiveProbe {
  let ports: SoundtrackPorts | null = null;
  const gains: GainNode[] = [];
  const frames: LiveFrame[] = [];
  let recording = false;

  const read = (): LiveFrame => {
    if (ports === null || gains.length === 0) {
      throw new Error("open the live ports first");
    }
    return {
      state: gains[0].context.state,
      time: ports.output.currentTime(),
      audible: gains[0].gain.value,
    };
  };
  const record = (): void => {
    if (!recording) return;
    frames.push(read());
    requestAnimationFrame(record);
  };
  return {
    open(): void {
      const Real = window.AudioContext;
      class SpyContext extends Real {
        override createGain(): GainNode {
          const gain = super.createGain();
          gains.push(gain);
          return gain;
        }
      }
      window.AudioContext = SpyContext;
      try {
        ports = openWebAudioPorts({ tracks: [] }, 1);
      } finally {
        window.AudioContext = Real;
      }
    },
    read,
    startRecording(): void {
      frames.length = 0;
      recording = true;
      requestAnimationFrame(record);
    },
    stopRecording(): readonly LiveFrame[] {
      recording = false;
      return [...frames];
    },
    pause(): void {
      ports?.pause();
    },
    resume(): void {
      ports?.resume(() => undefined);
    },
  };
}

/** Exercises the real buffer offset and ended event, including a cut voice. */
async function renderRecording(): Promise<{
  readonly readings: readonly number[];
  readonly ended: readonly string[];
}> {
  const context = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
  const buffer = context.createBuffer(1, SAMPLE_RATE / 2, SAMPLE_RATE);
  const samples = buffer.getChannelData(0);
  samples.fill(0.25, 0, SAMPLE_RATE / 4);
  samples.fill(0.75, SAMPLE_RATE / 4);
  const bus = new WebAudioOutput(context, context.destination).createBus(1);
  const ended: string[] = [];
  const naturalEnd = new Promise<void>((resolve) => {
    bus.playRecording(buffer, 0, 0.25, () => {
      ended.push("natural");
      resolve();
    });
  });
  const cancelled = bus.playRecording(buffer, 0, 0, () =>
    ended.push("cancelled"),
  );
  void context.suspend(0.1).then(() => {
    cancelled.cut(0.01);
    return context.resume();
  });
  await context.startRendering().then((result) => {
    samples.set(result.getChannelData(0).subarray(0, samples.length));
  });
  await naturalEnd;
  return {
    readings: [
      samples[Math.round(0.05 * SAMPLE_RATE)],
      samples[Math.round(0.2 * SAMPLE_RATE)],
      samples[Math.round(0.3 * SAMPLE_RATE)],
    ],
    ended,
  };
}

/** Render the production mix path and its pre-volume recording tap on separate channels. */
async function renderRecordingGraph(): Promise<{
  readonly speaker: readonly number[];
  readonly capture: readonly number[];
}> {
  const context = new OfflineAudioContext(2, SAMPLE_RATE * 2, SAMPLE_RATE);
  const channels = context.createChannelMerger(2);
  channels.connect(context.destination);
  const level = new WebAudioLevel(context, channels, 1);
  const dim = new WebAudioDimFilter(context, level.input);
  const tap = context.createGain();
  dim.tap(tap);
  tap.connect(channels, 0, 1);
  const buffer = context.createBuffer(1, SAMPLE_RATE * 2, SAMPLE_RATE);
  buffer.getChannelData(0).fill(1);
  const output = new WebAudioOutput(context, dim.input);
  output.createBus(1).playRecording(buffer, 0, 0, () => undefined);
  void context.suspend(0.3).then(() => {
    level.setVolume(0.5);
    return context.resume();
  });
  void context.suspend(0.7).then(() => {
    level.duck(0.5);
    return context.resume();
  });
  const rendered = await context.startRendering();
  const times = [0.2, 0.6, 1];
  return {
    speaker: times.map(
      (time) => rendered.getChannelData(0)[Math.round(time * SAMPLE_RATE)],
    ),
    capture: times.map(
      (time) => rendered.getChannelData(1)[Math.round(time * SAMPLE_RATE)],
    ),
  };
}

declare global {
  interface Window {
    __soundtrackOutputProbe: {
      readonly render: typeof render;
      readonly renderRecording: typeof renderRecording;
      readonly renderRecordingGraph: typeof renderRecordingGraph;
      readonly renderDim: typeof renderDim;
      readonly renderLevel: typeof renderLevel;
      readonly duckTuning: typeof MIX_TUNING.duck;
      readonly live: LiveProbe;
    };
  }
}

window.__soundtrackOutputProbe = {
  render,
  renderRecording,
  renderRecordingGraph,
  renderDim,
  renderLevel,
  duckTuning: MIX_TUNING.duck,
  live: createLiveProbe(),
};
