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
  readonly failEncodeAt: number | null;
  readonly pause: {
    readonly afterSeconds: number;
    readonly holdSeconds: number;
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
  readonly decodedFrames: number | null;
  readonly decodeError: string | null;
  readonly audibleTone: {
    readonly sampleStartSeconds: number;
    readonly toneEnergy: number;
    readonly gapEnergy: number;
  } | null;
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
  readonly stopTookMs: number | null;
  readonly firstFrameStall: {
    readonly firstFrameClockSeconds: number | null;
    readonly clockAfterStallSeconds: number | null;
  } | null;
  readonly firstSampleStartClockSeconds: number | null;
  readonly packetGapsMs: readonly number[];
  readonly opusPreSkipSamples: number | null;
  readonly opusPacketCount: number | null;
  readonly opusDiscardPaddingNs: number | null;
  readonly framesSubmittedBeforeFailure: number | null;
  readonly encodeCallsAfterFailure: number | null;
}

// Tones sound every 0.5 s: 2.5 s of music holds four, of which three are
// needed with the last one allowed to be cut by the stop.
const RECORD_SECONDS = 2.5;
const EXPECTED_ONSETS = 3;
// Stopped in the pause, 1 s in: tones at 0.5 s and 1 s.
const STOPPED_ONSETS = 2;
const DURATION_TOLERANCE_SECONDS = 0.1;
const LOSSLESS_ONSET_TOLERANCE_MS = 0.1;
// Real enough to be the defect the diagnostic exists for: long past any
// render quantum, and past the Chromium scheduling slack a shorter stall
// could still be swallowed by.
const START_STALL_MS = 250;
// The second encode call, so one PCM batch was submitted successfully before
// the failure; whether its packet has been delivered yet is a separate,
// unasserted question.
const FAILED_ENCODE_AT = 2;
const PAUSE = { afterSeconds: 1, holdSeconds: 0.5 };
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
// 20 ms of Opus at 48 kHz: the frame every packet in the file is, and the
// rate every `OpusDiscardPadding`/`CodecDelay` value in it is counted in.
const OPUS_RATE = 48_000;
const OPUS_FRAME_SAMPLES = 960;

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
    failEncodeAt: null,
    pause: null,
    startHeldForSeconds: null,
    stop: "playing",
  };
}

async function record(page: Page, request: RecordRequest): Promise<Recorded> {
  const recorded = await page.evaluate<Recorded>(
    `window.__soundtrackRecordingProbe.record(${JSON.stringify(request)})`,
  );
  await test.info().attach("recorded-timing", {
    body: JSON.stringify(recorded),
    contentType: "application/json",
  });
  return recorded;
}

// Where log time 0 falls in the audio file, which the header says: zero for
// both qualities now that the file is made of the worklet's own frames from
// its first one, nothing else.
const AUDIO_OFFSET_SECONDS: Record<Quality, number> = {
  lossless: 0,
  compressed: 0,
};

function expectSavedAndDecoded(
  recorded: Recorded,
  quality: Quality,
  minOnsets: number,
): void {
  const { outcome } = recorded;
  if (outcome.kind !== "saved") throw new Error(`Not saved: ${outcome.kind}`);
  expect(recorded.audioBytes).toBeGreaterThan(0);
  // A genuinely saved recording whose own bytes fail to decode is a defect
  // in the recording, never something to read past: only the deliberate
  // encode-failure path below is allowed to leave this non-null.
  expect(recorded.decodeError).toBeNull();
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

/**
 * Coarse audible alignment of ONE actually-logged, actually-complete,
 * uninterrupted sample against the silence that follows it, never a claim
 * about sample-exact onset: the fixture itself picks that sample from the
 * real log (never a position this spec assumed or inferred), and its tone
 * window must measurably out-energy its gap window, both read well away from
 * the 10 ms fade-in. A lossy threshold-crossing search for the exact onset
 * is not sample-exact merely because the container's own packet clock is;
 * the precision that search is actually good for is still an open design
 * question, not something this check stands in for.
 */
function expectAudibleTone(recorded: Recorded): void {
  const { audibleTone } = recorded;
  if (audibleTone === null) {
    throw new Error("No uninterrupted logged sample to measure");
  }
  expect(audibleTone.toneEnergy).toBeGreaterThan(audibleTone.gapEnergy);
}

function frameCountFromLog(recorded: Recorded): number {
  const frames = recorded.logLines.at(-1)?.frames;
  if (typeof frames !== "number") throw new Error("No frame count in the log");
  return frames;
}

/**
 * Reconciles the real, independently-read container against the frames the
 * worklet itself reported: `N` from the log, `K` and `S` from the file's own
 * packets and `OpusHead`, `decodedFrames` from decoding the actual bytes in
 * an explicit 48 kHz context. A real encoder's padding is whatever is left
 * once `K` whole 20 ms packets have to hold `S` skipped samples and `N`
 * captured ones; the file's own `DiscardPadding` must say exactly that.
 */
function expectReconciledOpusContainer(recorded: Recorded): void {
  const n = frameCountFromLog(recorded);
  const {
    opusPacketCount: k,
    opusPreSkipSamples: s,
    opusDiscardPaddingNs,
  } = recorded;
  if (k === null || s === null) {
    throw new Error("No Opus container to reconcile");
  }
  expect(recorded.decodedFrames).toBe(n);
  const padding = OPUS_FRAME_SAMPLES * k - s - n;
  expect(padding).toBeGreaterThanOrEqual(0);
  expect(padding).toBeLessThan(OPUS_FRAME_SAMPLES);
  expect(opusDiscardPaddingNs).toBe(Math.round((padding * 1e9) / OPUS_RATE));
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

test("a compressed recording decodes with its tone audible, and its container's own N, S, K and padding reconciled", async ({
  page,
}) => {
  const recorded = await record(page, plain("compressed"));

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  expectAudibleTone(recorded);
  expectReconciledOpusContainer(recorded);
});

test("a compressed recording keeps its frames while the page is busy", async ({
  page,
}) => {
  const recorded = await record(page, {
    ...plain("compressed"),
    busy: { everyMs: 300, forMs: 250 },
  });

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  expectAudibleTone(recorded);
  expectReconciledOpusContainer(recorded);
});

test("a compressed recording's first sample lines up with the worklet's own clock, not the clock a busy page delayed delivery to", async ({
  page,
}) => {
  const recorded = await record(page, {
    ...plain("compressed"),
    stallAfterStartMs: START_STALL_MS,
  });

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  const { firstFrameStall, firstSampleStartClockSeconds: a } = recorded;
  if (firstFrameStall === null) throw new Error("No stall was recorded");
  const { firstFrameClockSeconds: t, clockAfterStallSeconds: d } =
    firstFrameStall;
  if (t === null || d === null || a === null) {
    throw new Error("Missing a clock reading the stall needs");
  }
  const sample = recorded.logLines.find((line) => line.type === "sample");
  const l = sample?.start;
  if (typeof l !== "number") throw new Error("No sample in the log");
  const round = (value: number): number =>
    Math.round(value * 100_000) / 100_000;
  // The log's own serialization precision (`SessionRecorder`'s own rounding):
  // the real worklet clock is the origin the log counts from, not the clock
  // read once the page got around to the message.
  expect(l).toBe(round(a - t));
  // Different enough that the stall is actually exercising the bug this
  // guards: an origin taken after the delay would answer differently.
  expect(round(a - d)).not.toBe(round(a - t));
});

test("a compressed recording whose encoder cannot take a frame stops as failed, with nothing submitted after that failure", async ({
  page,
}) => {
  const recorded = await record(page, {
    ...plain("compressed"),
    failEncodeAt: FAILED_ENCODE_AT,
  });

  // `encode()` is a submission, not a delivery: whether the real encoder's
  // output for an earlier frame has reached `onEncoded` by the time this one
  // throws is not something submission order controls, so the file this
  // leaves behind is not asserted here — it can legitimately be empty (no
  // header ever delivered) or a header with no cluster yet, depending on
  // timing this test does not control and must not assume either way.
  expect(recorded.outcome).toMatchObject({ kind: "saved", reason: "failed" });
  expect(recorded.framesSubmittedBeforeFailure).toBeGreaterThan(0);
  expect(recorded.encodeCallsAfterFailure).toBe(0);
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

test("a compressed recording with a pause in the middle keeps its tone audible before and after it, with an exact 20 ms packet clock throughout", async ({
  page,
}) => {
  const recorded = await record(page, paused("compressed", "playing"));

  expectSavedAndDecoded(recorded, "compressed", EXPECTED_ONSETS);
  expectAudibleTone(recorded);
  expectReconciledOpusContainer(recorded);
  const pauseAt = lineOfType(recorded, "pause")?.t;
  if (typeof pauseAt !== "number") throw new Error("No pause in the log");
  expect(
    recorded.onsetStarts.filter((start) => start < pauseAt).length,
  ).toBeGreaterThanOrEqual(1);
  expect(
    recorded.onsetStarts.filter((start) => start > pauseAt).length,
  ).toBeGreaterThanOrEqual(2);
  // The container's own 20 ms media clock, one step per packet in the
  // SEQUENCE: never widened by the pause, which simply stops the worklet
  // being called at all rather than leaving a hole to fill, and never the
  // worklet's own bursty wall-clock arrival cadence.
  expect(recorded.packetGapsMs.every((gap) => gap === 20)).toBe(true);
  expectShortBySuspension(recorded);
});

for (const quality of QUALITIES) {
  test(`a ${quality} recording started during a pause decodes, with its tones found in the log`, async ({
    page,
  }) => {
    const recorded = await record(page, {
      ...plain(quality),
      seconds: HELD_PLAY_SECONDS,
      startHeldForSeconds: HELD_SECONDS,
    });

    expectSavedAndDecoded(recorded, quality, EXPECTED_ONSETS);
    if (quality === "lossless") expectLosslessTiming(recorded);
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
