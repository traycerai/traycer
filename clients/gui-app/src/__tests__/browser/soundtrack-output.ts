import { WebAudioDimFilter, WebAudioOutput } from "@/lib/soundtrack/output";

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

declare global {
  interface Window {
    __soundtrackOutputProbe: {
      readonly render: typeof render;
      readonly renderDim: typeof renderDim;
    };
  }
}

window.__soundtrackOutputProbe = { render, renderDim };
