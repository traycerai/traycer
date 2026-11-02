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
