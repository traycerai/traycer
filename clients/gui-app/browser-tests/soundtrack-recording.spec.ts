import { expect, test, type Page } from "@playwright/test";

import { chromeLaunchOptions, fixture } from "./support/fixtures.ts";

// A real recording of a short test tone, through the real Web Audio ports,
// player and recorder, into an in-memory save channel (the fixture,
// `src/__tests__/browser/soundtrack-recording.ts`). The page decodes what it
// recorded; jsdom has no audio clock, encoder or worklet to do that with.
// No file is written: the bytes stay in the page.

test.use({
  launchOptions: chromeLaunchOptions([
    "--autoplay-policy=no-user-gesture-required",
  ]),
});

type Quality = "lossless" | "compressed";

interface RecordRequest {
  readonly quality: Quality;
  readonly seconds: number;
  readonly busy: {
    readonly everyMs: number;
    readonly forMs: number;
  } | null;
}

interface Recorded {
  readonly outcome:
    | { readonly kind: "saved"; readonly durationSeconds: number }
    | { readonly kind: "failed" | "empty" };
  readonly audioBytes: number;
  readonly logLines: readonly Record<string, unknown>[];
  readonly sampleRate: number;
  readonly decodedSeconds: number;
  readonly onsetOffsetsMs: readonly number[];
  readonly wavFrames: number | null;
}

// About four seconds of tone fits the 20 s per-test budget.
const RECORD_SECONDS = 4;
const EXPECTED_ONSETS = 3;
const DURATION_TOLERANCE_SECONDS = 0.1;
const LOSSLESS_ONSET_TOLERANCE_MS = 0.1;
const COMPRESSED_ONSET_SPREAD_MS = 2;
const COMPRESSED_RESIDUAL_MIN_MS = -0.5;
const COMPRESSED_RESIDUAL_MAX_MS = 11;

test.beforeEach(async ({ page }) => {
  await page.goto(fixture("soundtrack-recording"));
  await page.waitForFunction("window.__soundtrackRecordingProbe !== undefined");
});

function record(page: Page, request: RecordRequest): Promise<Recorded> {
  return page.evaluate<Recorded>(
    `window.__soundtrackRecordingProbe.record(${JSON.stringify(request)})`,
  );
}

// Where log time 0 falls in the audio file, which the header says.
const AUDIO_OFFSET_SECONDS: Record<Quality, number> = {
  lossless: 0,
  compressed: 0.0705,
};

function expectSavedAndDecoded(recorded: Recorded, quality: Quality): void {
  const { outcome } = recorded;
  if (outcome.kind !== "saved") throw new Error(`Not saved: ${outcome.kind}`);
  expect(recorded.audioBytes).toBeGreaterThan(0);
  expect(
    Math.abs(recorded.decodedSeconds - outcome.durationSeconds),
  ).toBeLessThan(DURATION_TOLERANCE_SECONDS);
  expect(recorded.logLines[0]).toMatchObject({
    type: "header",
    quality,
    sampleRate: recorded.sampleRate,
    audioOffsetSeconds: AUDIO_OFFSET_SECONDS[quality],
  });
  expect(recorded.logLines.at(-1)).toMatchObject({ type: "recording-end" });
  expect(recorded.onsetOffsetsMs.length).toBeGreaterThanOrEqual(
    EXPECTED_ONSETS,
  );
}

/** Each onset's distance from where the header says its log time falls. */
function residualsMs(recorded: Recorded, quality: Quality): number[] {
  const offsetMs = AUDIO_OFFSET_SECONDS[quality] * 1000;
  return recorded.onsetOffsetsMs.map((offset) => offset - offsetMs);
}

function expectLosslessTiming(recorded: Recorded): void {
  expect(recorded.wavFrames).toBe(
    Math.round(recorded.decodedSeconds * recorded.sampleRate),
  );
  for (const residual of residualsMs(recorded, "lossless")) {
    expect(Math.abs(residual)).toBeLessThan(LOSSLESS_ONSET_TOLERANCE_MS);
  }
}

test("a lossless recording decodes, matches its length in frames, and lines up with its log", async ({
  page,
}) => {
  const recorded = await record(page, {
    quality: "lossless",
    seconds: RECORD_SECONDS,
    busy: null,
  });

  expectSavedAndDecoded(recorded, "lossless");
  expectLosslessTiming(recorded);
});

test("a lossless recording keeps its frames and its timing while the page is busy", async ({
  page,
}) => {
  const recorded = await record(page, {
    quality: "lossless",
    seconds: RECORD_SECONDS,
    busy: { everyMs: 300, forMs: 250 },
  });

  expectSavedAndDecoded(recorded, "lossless");
  expectLosslessTiming(recorded);
});

test("a compressed recording decodes and its tones sit at one steady offset from the log", async ({
  page,
}) => {
  const recorded = await record(page, {
    quality: "compressed",
    seconds: RECORD_SECONDS,
    busy: null,
  });

  expectSavedAndDecoded(recorded, "compressed");
  const residuals = residualsMs(recorded, "compressed");
  // Between the offset the header gives and one more device callback of it.
  for (const residual of residuals) {
    expect(residual).toBeGreaterThanOrEqual(COMPRESSED_RESIDUAL_MIN_MS);
    expect(residual).toBeLessThanOrEqual(COMPRESSED_RESIDUAL_MAX_MS);
  }
  expect(Math.max(...residuals) - Math.min(...residuals)).toBeLessThan(
    COMPRESSED_ONSET_SPREAD_MS,
  );
});
