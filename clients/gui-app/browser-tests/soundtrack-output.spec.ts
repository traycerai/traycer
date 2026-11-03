import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// What the soundtrack's Web Audio port renders when a voice or a gain is cut or
// turned round: a click is one wrong sample, and jsdom renders none. Every
// voice plays a constant 1, so a rendered sample reads as the gain on that
// frame.
//
// CHROMIUM'S ASSERTION. `rampParam` holds a ramp with `cancelAndHoldAtTime`,
// which Firefox does not have. There it falls back to cancelling the ramp, which
// can still let one sample through at the value before it, so the continuity
// checks here hold for the Chrome this suite drives and not for Firefox.

const SAMPLE_RATE = 48_000;
// `suspend` runs on a render quantum, so a step's time is one to be exact.
const QUANTUM_SECONDS = 128 / SAMPLE_RATE;
// A 10 ms fade from 0 to 1 moves this much per sample, and no step may pass it.
const TEN_MS_FADE_STEP = (1 / (0.01 * SAMPLE_RATE)) * 1.05;
// Well above either slope of the ramps turned round below, and far under the
// jump back to the pre-ramp value that this guards against.
const SLOW_RAMP_STEP = 0.001;

type Step =
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
  readonly voices: readonly {
    readonly when: number;
    readonly fadeInSeconds: number;
  }[];
  readonly steps: readonly Step[];
  readonly stepsFrom: number;
  readonly readAt: readonly number[];
}

interface Rendered {
  readonly peak: number;
  readonly biggestStep: number;
  readonly readings: readonly number[];
}

interface DimRequest {
  readonly seconds: number;
  readonly toneHz: number;
  readonly amplitude: number;
  readonly steps: readonly { readonly at: number; readonly dimmed: boolean }[];
  readonly windows: readonly { readonly from: number; readonly to: number }[];
}

interface DimRendered {
  readonly peaks: readonly number[];
  readonly rms: readonly number[];
}

function renderDim(page: Page, request: DimRequest): Promise<DimRendered> {
  return page.evaluate<DimRendered>(
    `window.__soundtrackOutputProbe.renderDim(${JSON.stringify(request)})`,
  );
}

function render(page: Page, request: RenderRequest): Promise<Rendered> {
  return page.evaluate<Rendered>(
    `window.__soundtrackOutputProbe.render(${JSON.stringify(request)})`,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto(fixture("soundtrack-output"));
  await page.waitForFunction("window.__soundtrackOutputProbe !== undefined");
});

test("a voice cut before its start renders silence", async ({ page }) => {
  const request = {
    seconds: 2,
    busGain: 1,
    stepsFrom: 0,
    readAt: [],
  };
  const uncut = await render(page, {
    ...request,
    voices: [{ when: 1.3, fadeInSeconds: 0.01 }],
    steps: [],
  });
  expect(uncut.peak).toBe(1);

  // The start falls inside a long cut's fade, then a short one's, then on the cut.
  for (const { when, seconds } of [
    { when: 1.3, seconds: 0.4 },
    { when: 1.005, seconds: 0.01 },
    { when: 1, seconds: 0.4 },
  ]) {
    const cut = await render(page, {
      ...request,
      voices: [{ when, fadeInSeconds: 0.01 }],
      steps: [{ kind: "cut", at: 1, voice: 0, seconds }],
    });
    expect(cut.peak, `starting at ${String(when)}`).toBe(0);
  }
});

test("cutting a voice before its start leaves a voice on the same gain sounding", async ({
  page,
}) => {
  const { peak, readings } = await render(page, {
    seconds: 2,
    busGain: 1,
    voices: [
      { when: 1.3, fadeInSeconds: 0.01 },
      { when: 0.2, fadeInSeconds: 0.01 },
    ],
    steps: [{ kind: "cut", at: 1, voice: 0, seconds: 0.4 }],
    stepsFrom: 0,
    readAt: [1.5],
  });
  expect(readings).toEqual([1]);
  // More than 1 would be the cut voice sounding on top of it.
  expect(peak).toBe(1);
});

for (const { direction, from, to } of [
  { direction: "up", from: 0, to: 1 },
  { direction: "down", from: 1, to: 0 },
]) {
  test(`a ramp going ${direction} turned round is continuous, with no sample at the pre-ramp value`, async ({
    page,
  }) => {
    // Which cut frames click depends on rounding, so it sweeps a run of them.
    const rampStart = 20 * QUANTUM_SECONDS;
    const rampSeconds = 0.25;
    for (let quanta = 1; quanta <= 60; quanta += 1) {
      const turnAt = rampStart + quanta * QUANTUM_SECONDS;
      const beforeTurn = turnAt - 1 / SAMPLE_RATE;
      const { biggestStep, readings } = await render(page, {
        seconds: 0.6,
        busGain: from,
        voices: [{ when: 0, fadeInSeconds: 0.001 }],
        steps: [
          { kind: "ramp", at: rampStart, target: to, seconds: rampSeconds },
          { kind: "ramp", at: turnAt, target: from, seconds: 0.2 },
        ],
        stepsFrom: rampStart,
        readAt: [beforeTurn, 0.59],
      });
      const label = `turned after ${String(quanta)} quanta`;
      expect(biggestStep, label).toBeLessThan(SLOW_RAMP_STEP);
      // It had got this far, so the smoothness above is a turn and not a flat line.
      const progress = (beforeTurn - rampStart) / rampSeconds;
      expect(readings[0], label).toBeCloseTo(from + (to - from) * progress, 3);
      expect(readings[1], label).toBe(from);
    }
  });
}

test("a voice's 10 ms fade-in rises from nothing with no step", async ({
  page,
}) => {
  const when = 0.5;
  const { biggestStep, readings } = await render(page, {
    seconds: 1,
    busGain: 1,
    voices: [{ when, fadeInSeconds: 0.01 }],
    steps: [],
    stepsFrom: 0,
    readAt: [when - 0.001, when + 0.005, when + 0.011],
  });
  expect(readings[0]).toBe(0);
  expect(readings[1]).toBeCloseTo(0.5, 2);
  expect(readings[2]).toBe(1);
  expect(biggestStep).toBeLessThan(TEN_MS_FADE_STEP);
});

test("a 10 ms cut takes a sounding voice to nothing from the moment of the cut", async ({
  page,
}) => {
  const cutAt = 1;
  const { biggestStep, readings } = await render(page, {
    seconds: 1.5,
    busGain: 1,
    voices: [{ when: 0.5, fadeInSeconds: 0.01 }],
    steps: [{ kind: "cut", at: cutAt, voice: 0, seconds: 0.01 }],
    stepsFrom: 0,
    readAt: [cutAt - 0.001, cutAt + 0.005, cutAt + 0.011],
  });
  expect(readings[0]).toBe(1);
  expect(readings[1]).toBeCloseTo(0.5, 2);
  expect(readings[2]).toBe(0);
  expect(biggestStep).toBeLessThan(TEN_MS_FADE_STEP);
});

test("a cut inside a voice's 10 ms fade-in goes down from where it had reached", async ({
  page,
}) => {
  const when = 1;
  // The fade-in lasts just under 4 quanta.
  for (let quanta = 1; quanta <= 3; quanta += 1) {
    const { peak, biggestStep, readings } = await render(page, {
      seconds: 1.5,
      busGain: 1,
      voices: [{ when, fadeInSeconds: 0.01 }],
      steps: [
        {
          kind: "cut",
          at: when + quanta * QUANTUM_SECONDS,
          voice: 0,
          seconds: 0.01,
        },
      ],
      stepsFrom: 0,
      readAt: [when + 0.03],
    });
    const reached = (quanta * QUANTUM_SECONDS) / 0.01;
    const label = `cut after ${String(quanta)} quanta`;
    // The value it turns from is a frame old, which can add one more fade step.
    expect(biggestStep, label).toBeLessThan(2 * TEN_MS_FADE_STEP);
    // It never rises past the cut, so the fade-in was really turned round.
    expect(peak, label).toBeCloseTo(reached, 1);
    expect(readings, label).toEqual([0]);
  }
});

// A tone far above the dimmed cutoff (900 Hz), so the low-pass has to take it.
const TONE_HZ = 6000;

test("the dim filter takes a tone above its cutoff down once dimmed, and back once undimmed", async ({
  page,
}) => {
  // Dimmed at 0.5 s, its 1.2 s ramp over by 1.7 s; undimmed at 2.5 s, over by 3.7 s.
  const { rms } = await renderDim(page, {
    seconds: 4.2,
    toneHz: TONE_HZ,
    amplitude: 0.5,
    steps: [
      { at: 0.5, dimmed: true },
      { at: 2.5, dimmed: false },
    ],
    windows: [
      { from: 0.2, to: 0.4 },
      { from: 2.2, to: 2.4 },
      { from: 4, to: 4.2 },
    ],
  });
  const [open, dimmed, reopened] = rms;
  // Open, the tone passes: without a filter in the way its RMS is amplitude / sqrt 2.
  expect(open).toBeGreaterThan(0.2);
  expect(dimmed).toBeLessThan(open * 0.1);
  expect(reopened).toBeCloseTo(open, 2);
});

test("a dim ramp turned round goes on from where the cutoff had got to", async ({
  page,
}) => {
  // The cutoff falls from 20 kHz for 0.6 s, to about 4 kHz, where this tone is
  // still heard at a fraction of its open level. A turn that fell back to the
  // open cutoff would bring it up to a multiple of that within a quantum.
  const dimAt = 0.3;
  const turnFrom = 0.9;
  for (let quanta = 0; quanta < 8; quanta += 1) {
    const turnAt = turnFrom + quanta * QUANTUM_SECONDS;
    const { peaks } = await renderDim(page, {
      seconds: 1.5,
      toneHz: TONE_HZ,
      amplitude: 0.5,
      steps: [
        { at: dimAt, dimmed: true },
        { at: turnAt, dimmed: false },
      ],
      windows: [
        { from: turnAt - 0.004, to: turnAt },
        { from: turnAt + 0.004, to: turnAt + 0.024 },
      ],
    });
    const [beforeTurn, afterTurn] = peaks;
    const label = `turned after ${String(quanta)} quanta`;
    // It was well under the open level, so the ratio below is a turn and not a flat line.
    expect(beforeTurn, label).toBeLessThan(0.3);
    expect(afterTurn / beforeTurn, label).toBeLessThan(1.3);
  }
});

interface LevelRequest {
  readonly seconds: number;
  readonly volume: number;
  readonly steps: readonly {
    readonly kind: "volume" | "duck";
    readonly at: number;
    readonly value: number;
  }[];
  readonly readAt: readonly number[];
}

interface LevelRendered {
  readonly readings: readonly number[];
  readonly biggestStep: number;
}

interface DuckTuning {
  readonly gain: number;
  readonly attackSeconds: number;
  readonly releaseSeconds: number;
}

function renderLevel(
  page: Page,
  request: LevelRequest,
): Promise<LevelRendered> {
  return page.evaluate<LevelRendered>(
    `window.__soundtrackOutputProbe.renderLevel(${JSON.stringify(request)})`,
  );
}

function duckTuning(page: Page): Promise<DuckTuning> {
  return page.evaluate<DuckTuning>("window.__soundtrackOutputProbe.duckTuning");
}

// The person's volume and a chime's duck are two gains in a row: the volume
// scales the music, the duck drops it under a chime, and neither disturbs the
// other. A rendered sample is the product of both.
test("the level is the volume, ducked under a chime and back once it is over", async ({
  page,
}) => {
  const { gain, attackSeconds, releaseSeconds } = await duckTuning(page);
  const duckAt = 0.5;
  const chimeSeconds = 0.4;
  const { readings, biggestStep } = await renderLevel(page, {
    seconds: 3,
    volume: 0.6,
    steps: [{ kind: "duck", at: duckAt, value: chimeSeconds }],
    readAt: [
      0.3,
      duckAt + attackSeconds + 0.05,
      duckAt + chimeSeconds - 0.02,
      duckAt + chimeSeconds + releaseSeconds + 0.1,
    ],
  });
  const [before, held, endOfChime, after] = readings;
  expect(before).toBeCloseTo(0.6, 3);
  expect(held).toBeCloseTo(0.6 * gain, 3);
  expect(endOfChime).toBeCloseTo(0.6 * gain, 3);
  expect(after).toBeCloseTo(0.6, 3);
  // Down over its attack and back over its release, never a jump.
  expect(biggestStep).toBeLessThan(0.002);
});

test("a volume moved during a chime's duck leaves the duck alone", async ({
  page,
}) => {
  const { gain, attackSeconds, releaseSeconds } = await duckTuning(page);
  const duckAt = 0.5;
  const chimeSeconds = 0.6;
  const volumeAt = duckAt + 0.3;
  const { readings, biggestStep } = await renderLevel(page, {
    seconds: 3,
    volume: 0.5,
    steps: [
      { kind: "duck", at: duckAt, value: chimeSeconds },
      { kind: "volume", at: volumeAt, value: 0.9 },
    ],
    readAt: [
      duckAt + attackSeconds + 0.05,
      volumeAt + 0.2,
      duckAt + chimeSeconds + releaseSeconds + 0.1,
    ],
  });
  const [ducked, duckedLouder, released] = readings;
  expect(ducked).toBeCloseTo(0.5 * gain, 3);
  expect(duckedLouder).toBeCloseTo(0.9 * gain, 3);
  expect(released).toBeCloseTo(0.9, 3);
  expect(biggestStep).toBeLessThan(0.02);
});
