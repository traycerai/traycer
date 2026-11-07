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
  readonly stallAfterStartMs: number | null;
  readonly failSliceRead: number | null;
  readonly pause: {
    readonly afterSeconds: number;
    readonly holdSeconds: number;
    readonly playInSameTask: boolean;
  } | null;
  readonly startHeldForSeconds: number | null;
  readonly stop: "playing" | "paused" | "refused-resume";
}

interface Recorded {
  readonly outcome:
    | {
        readonly kind: "saved";
        readonly durationSeconds: number;
        readonly reason: string;
      }
    | { readonly kind: "failed" | "empty" };
  readonly audioBytes: number;
  readonly logLines: readonly Record<string, unknown>[];
  readonly sampleRate: number;
  readonly decodedSeconds: number;
  readonly onsetOffsetsMs: readonly number[];
  readonly wavFrames: number | null;
  readonly onsetStarts: readonly number[];
  readonly logBytes: number;
  readonly closes: number;
  readonly wallSeconds: number;
  readonly suspendedSeconds: number;
  readonly clockDuringSuspensionSeconds: number;
  readonly clockToSuspension: {
    readonly fromCapture: number;
    readonly fromListening: number;
  } | null;
  readonly recorderPauses: number;
  readonly stopTookMs: number | null;
  readonly resumeOrder: readonly ("recorder" | "context")[];
  readonly maxPacketGapMs: number | null;
  readonly sliceBytesBeforeFailure: number | null;
  readonly slicesReadAfterFailure: number | null;
}

// Tones sound every 0.5 s: 2.5 s of music holds four, of which three are
// needed with the last one allowed to be cut by the stop.
const RECORD_SECONDS = 2.5;
const EXPECTED_ONSETS = 3;
// Stopped in the pause, 1 s in: tones at 0.5 s and 1 s.
const STOPPED_ONSETS = 2;
const DURATION_TOLERANCE_SECONDS = 0.1;
const LOSSLESS_ONSET_TOLERANCE_MS = 0.1;
const COMPRESSED_ONSET_SPREAD_MS = 2;
const COMPRESSED_RESIDUAL_MIN_MS = -0.5;
const COMPRESSED_RESIDUAL_MAX_MS = 11;
// Far past the residual bound, so a time origin taken after the stall fails.
const START_STALL_MS = 250;
// The second, so the file still holds the first slice and its WebM header.
const FAILED_SLICE = 2;
// A pause in the middle: 1 s of music, a hold of 0.5 s from the context
// reporting suspended, then 1.3 s of music after the Play.
const PAUSE = { afterSeconds: 1, holdSeconds: 0.5, playInSameTask: false };
const AFTER_PLAY_SECONDS = 1.3;
// What the recording lacks of the wall time is the suspension the context
// reported; the two are read from different clocks, so they meet within this.
const SUSPENSION_TOLERANCE_SECONDS = 0.3;
// The audio clock stands still while the context is suspended.
const CLOCK_DURING_SUSPENSION_MAX_SECONDS = 0.1;
// The clock moves a render quantum at a time, 2.7 ms at 48 kHz, so a reading
// can sit a quantum or two off one made beside it.
const CLOCK_READ_TOLERANCE_SECONDS = 0.01;
// Well under the capture's own 2 s grace for a stop it never hears back from,
// with room for a loaded machine.
const STOP_WITHIN_MS = 1500;
const HELD_SECONDS = 0.5;
// After Play in a recording started held: tones at 0.5, 1 and 1.5 s, and one
// more to keep the last from being cut by the stop.
const HELD_PLAY_SECONDS = 2.2;

test.beforeEach(async ({ page }) => {
  await page.goto(fixture("soundtrack-recording"));
  await page.waitForFunction("window.__soundtrackRecordingProbe !== undefined");
});

/** A plain recording: the music plays throughout, nothing is held or stalled. */
function plain(quality: Quality): RecordRequest {
  return {
    quality,
    seconds: RECORD_SECONDS,
    busy: null,
    stallAfterStartMs: null,
    failSliceRead: null,
    pause: null,
    startHeldForSeconds: null,
    stop: "playing",
  };
}

function record(page: Page, request: RecordRequest): Promise<Recorded> {
  return page.evaluate<Recorded>(
    `window.__soundtrackRecordingProbe.record(${JSON.stringify(request)})`,
  );
}

// Where log time 0 falls in the audio file, which the header says.
const AUDIO_OFFSET_SECONDS: Record<Quality, number> = {
  lossless: 0,
  compressed: 0.0065,
};

function expectSavedAndDecoded(
  recorded: Recorded,
  quality: Quality,
  minOnsets: number,
): void {
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
  expect(recorded.onsetOffsetsMs.length).toBeGreaterThanOrEqual(minOnsets);
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
  const recorded = await record(page, plain("lossless"));

  expectSavedAndDecoded(recorded, "lossless", EXPECTED_ONSETS);
  expectLosslessTiming(recorded);
});

test("a lossless recording keeps its frames and its timing while the page is busy", async ({
  page,
}) => {
  const recorded = await record(page, {
    ...plain("lossless"),
    busy: { everyMs: 300, forMs: 250 },
  });

  expectSavedAndDecoded(recorded, "lossless", EXPECTED_ONSETS);
  expectLosslessTiming(recorded);
});

function expectCompressedTiming(recorded: Recorded): void {
  const residuals = residualsMs(recorded, "compressed");
  // Between the offset the header gives and one more device callback of it.
  for (const residual of residuals) {
    expect(residual).toBeGreaterThanOrEqual(COMPRESSED_RESIDUAL_MIN_MS);
    expect(residual).toBeLessThanOrEqual(COMPRESSED_RESIDUAL_MAX_MS);
  }
  expect(Math.max(...residuals) - Math.min(...residuals)).toBeLessThan(
    COMPRESSED_ONSET_SPREAD_MS,
  );
}

test("a compressed recording decodes and its tones sit at one steady offset from the log", async ({
  page,
}) => {
  const recorded = await record(page, plain("compressed"));

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  expectCompressedTiming(recorded);
});

test("a compressed recording keeps that offset when the page stalls as the recorder starts", async ({
  page,
}) => {
  const recorded = await record(page, {
    ...plain("compressed"),
    stallAfterStartMs: START_STALL_MS,
  });

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  expectCompressedTiming(recorded);
});

test("a compressed recording whose slice cannot be read stops as failed, and keeps no audio from after the failure", async ({
  page,
}) => {
  const recorded = await record(page, {
    ...plain("compressed"),
    failSliceRead: FAILED_SLICE,
  });

  expect(recorded.outcome).toMatchObject({ kind: "saved", reason: "failed" });
  // The recorder's last slice came after the failure, and was read.
  expect(recorded.slicesReadAfterFailure).toBeGreaterThan(0);
  // None of it reached the file: only the slices before the failed one did.
  expect(recorded.audioBytes).toBe(recorded.sliceBytesBeforeFailure);
});

const QUALITIES: readonly Quality[] = ["lossless", "compressed"];

function paused(quality: Quality, stop: RecordRequest["stop"]): RecordRequest {
  return {
    ...plain(quality),
    seconds: AFTER_PLAY_SECONDS,
    pause: PAUSE,
    stop,
  };
}

function lineOfType(
  recorded: Recorded,
  type: string,
): Record<string, unknown> | undefined {
  return recorded.logLines.find((line) => line.type === type);
}

function expectTiming(recorded: Recorded, quality: Quality): void {
  if (quality === "lossless") expectLosslessTiming(recorded);
  else expectCompressedTiming(recorded);
}

/**
 * The recording is shorter than the wall time by the suspension the context
 * reported, and the audio clock stood still through it.
 */
function expectShortBySuspension(recorded: Recorded): void {
  if (recorded.outcome.kind !== "saved") throw new Error("Not saved");
  const shortBy = recorded.wallSeconds - recorded.outcome.durationSeconds;
  expect(recorded.suspendedSeconds).toBeGreaterThanOrEqual(PAUSE.holdSeconds);
  expect(Math.abs(shortBy - recorded.suspendedSeconds)).toBeLessThan(
    SUSPENSION_TOLERANCE_SECONDS,
  );
  expect(recorded.clockDuringSuspensionSeconds).toBeLessThan(
    CLOCK_DURING_SUSPENSION_MAX_SECONDS,
  );
}

test("a lossless recording with a pause in the middle keeps its frames and its timing after the pause, and is shorter than the wall time by the suspension", async ({
  page,
}) => {
  const recorded = await record(page, paused("lossless", "playing"));

  expectSavedAndDecoded(recorded, "lossless", EXPECTED_ONSETS);
  expectLosslessTiming(recorded);
  const pauseAt = lineOfType(recorded, "pause")?.t;
  if (typeof pauseAt !== "number") throw new Error("No pause in the log");
  expect(
    recorded.logLines
      .map((line) => line.type)
      .filter((type) => type === "pause" || type === "play"),
  ).toEqual(["pause", "play"]);
  expect(
    recorded.onsetStarts.filter((start) => start > pauseAt).length,
  ).toBeGreaterThanOrEqual(2);
  expect(recorded.logLines.at(-1)?.frames).not.toBeNull();
  expectShortBySuspension(recorded);
});

test("a compressed recording with a pause in the middle keeps its offset before and after it, has no hole in its packets, and starts its recorder ahead of the clock", async ({
  page,
}) => {
  const recorded = await record(page, paused("compressed", "playing"));

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  expectCompressedTiming(recorded);
  const pauseAt = lineOfType(recorded, "pause")?.t;
  if (typeof pauseAt !== "number") throw new Error("No pause in the log");
  expect(
    recorded.onsetStarts.filter((start) => start < pauseAt).length,
  ).toBeGreaterThanOrEqual(1);
  expect(
    recorded.onsetStarts.filter((start) => start > pauseAt).length,
  ).toBeGreaterThanOrEqual(2);
  // A hole as long as the suspension is far past half of it; a packet is 60 ms.
  expect(recorded.maxPacketGapMs).toBeLessThan(
    (recorded.suspendedSeconds * 1000) / 2,
  );
  expect(recorded.recorderPauses).toBe(1);
  expectShortBySuspension(recorded);
  // Ahead of the clock: a recorder resumed after it drops what the clock made
  // in between.
  expect(recorded.resumeOrder.slice(0, 2)).toEqual(["recorder", "context"]);
});

for (const quality of QUALITIES) {
  test(`a ${quality} recording started during a pause decodes, with its tones at the same offset from the log`, async ({
    page,
  }) => {
    const recorded = await record(page, {
      ...plain(quality),
      seconds: HELD_PLAY_SECONDS,
      startHeldForSeconds: HELD_SECONDS,
    });

    expectSavedAndDecoded(recorded, quality, EXPECTED_ONSETS);
    expectTiming(recorded, quality);
    // Time starts at the clock the context stopped at, not one read when it ran.
    expect(lineOfType(recorded, "play")).toMatchObject({ t: 0 });
  });

  test(`a ${quality} recording started during a pause and stopped before Play leaves nothing in either file`, async ({
    page,
  }) => {
    const recorded = await record(page, {
      ...plain(quality),
      seconds: 0.5,
      startHeldForSeconds: HELD_SECONDS,
      stop: "paused",
    });

    expect(recorded.outcome).toEqual({ kind: "empty" });
    expect(recorded.audioBytes).toBe(0);
    expect(recorded.logBytes).toBe(0);
    expect(recorded.closes).toBe(1);
  });

  test(`a ${quality} recording stopped during a pause is saved at once, decodes, and has the duration of what played`, async ({
    page,
  }) => {
    const recorded = await record(page, paused(quality, "paused"));

    expectSavedAndDecoded(recorded, quality, STOPPED_ONSETS);
    expect(recorded.stopTookMs).toBeLessThan(STOP_WITHIN_MS);
    if (quality === "lossless") {
      expect(recorded.logLines.at(-1)?.frames).not.toBeNull();
    }
    if (recorded.outcome.kind !== "saved") throw new Error("Not saved");
    const { durationSeconds } = recorded.outcome;
    // 1 s of music, then the fade and drain of the pause, up to the suspension
    // and however long a loaded page takes to get there.
    expect(durationSeconds).toBeGreaterThan(PAUSE.afterSeconds);
    const span = recorded.clockToSuspension;
    if (span === null) throw new Error("No suspension after the start");
    // From the first frame, which comes between the capture being asked for and
    // the recording listening, to the suspension.
    expect(durationSeconds).toBeGreaterThan(
      span.fromListening - CLOCK_READ_TOLERANCE_SECONDS,
    );
    expect(durationSeconds).toBeLessThan(
      span.fromCapture + CLOCK_READ_TOLERANCE_SECONDS,
    );
  });

  test(`a ${quality} recording whose Play the device refuses ends as music off with its files closed once`, async ({
    page,
  }) => {
    const recorded = await record(page, paused(quality, "refused-resume"));

    expect(recorded.outcome).toMatchObject({
      kind: "saved",
      reason: "music-off",
    });
    expect(recorded.closes).toBe(1);
    expect(
      recorded.logLines.filter((line) => line.type === "recording-end"),
    ).toHaveLength(1);
    expect(recorded.logLines.slice(-2)).toEqual([
      expect.objectContaining({ type: "pause", cause: "refused-resume" }),
      expect.objectContaining({ type: "recording-end" }),
    ]);
  });
}

test("a compressed recording is not paused by a suspended report that comes after its Play", async ({
  page,
}) => {
  const recorded = await record(page, {
    ...paused("compressed", "playing"),
    pause: { ...PAUSE, playInSameTask: true },
  });

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  expectCompressedTiming(recorded);
  expect(recorded.recorderPauses).toBe(0);
});
