import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  RecordingEvent,
  RecordingProbeInput,
  RecordingProbeResult,
  RecordingProbeRun,
  RecordingProbeRunResult,
} from "@traycer-clients/shared/platform/browser-view";
import { describeLogError, log } from "../../app/logger";
import type { BrowserViewWebContents } from "../browser-view-port";
import {
  evaluateInRecordingHelper,
  recordingFrameStats,
  startRecordingHelper,
  stopRecordingHelper,
} from "./recording-helper-window";

/**
 * DEV-ONLY: WHICH CAPTURE SOURCE ACTUALLY ADVANCES ON THIS MACHINE.
 *
 * The sandbox probe (D15 PROBE STATUS) could not answer it - every placement
 * froze under Xvfb software compositing, which says nothing about a real GPU
 * desktop - and the failure mode is SILENT: a frozen `display-media` stream
 * still produces a well-formed mp4 of one still frame. So the answer is a
 * runtime seam plus this command, run once on a real desktop, whose result
 * flips the per-machine setting and, when it is consistent, the default in
 * `recording-capture-source-setting.ts`.
 *
 * Never a user-facing feature: the IPC handler is registered only in a dev
 * build, there is no UI, and each run needs a host-minted helper URL the dev
 * supplies by hand.
 */

/** Let the helper get its recorder running before the first sample. */
const SETTLE_MS = 1_000;

/**
 * HOW EACH SOURCE IS MEASURED, and the honest asymmetry between them.
 *
 * `capture-page` needs nothing from the helper: main encodes every frame it
 * pushes, so it counts them and counts how many differed from the frame
 * before. A frozen guest re-encodes to identical bytes, so `distinct == 1`
 * over a ten-second run IS the frozen verdict.
 *
 * `display-media` is the one main cannot see - the stream goes from the
 * compositor straight into the helper's `MediaRecorder`, and opening a second
 * capture to watch it takes the whole engine down (the sandbox probe found
 * that the hard way). So this reads whatever `<video>` the helper happens to
 * have the stream on: `totalVideoFrames` advances only when the source
 * delivers a NEW frame, which is exactly the question. If the helper hangs the
 * stream on no element, the run reports `measured: false` rather than a
 * verdict - a dev-only command that guesses is worse than one that says it
 * could not tell, and the fix is one `probeFrameStats()` on the helper
 * document (ticket 19), not a heuristic here.
 */
const VIDEO_FRAME_COUNT_SCRIPT = `(() => {
  const video = document.querySelector("video");
  if (video === null || typeof video.getVideoPlaybackQuality !== "function") {
    return null;
  }
  return video.getVideoPlaybackQuality().totalVideoFrames;
})()`;

const videoFrameCountSchema = z.number().nullable();

/**
 * Runs each requested source in turn against the same guest and reports
 * whether the recorded picture moved.
 *
 * Sequential, never concurrent: the sandbox probe found that a second
 * `getDisplayMedia` capture in one process takes the engine down with it, and
 * two helpers recording one guest is not a state production ever reaches
 * anyway.
 */
export async function runRecordingCaptureSourceProbe(args: {
  readonly guest: BrowserViewWebContents;
  readonly input: RecordingProbeInput;
}): Promise<RecordingProbeResult> {
  const runs: RecordingProbeRunResult[] = [];
  for (const run of args.input.runs) {
    runs.push(await probeOneSource(args.guest, run, args.input.durationMs));
  }
  for (const result of runs) {
    log.info("[browser-view] recording capture source probe", {
      source: result.source,
      helperReady: result.helperReady,
      measured: result.measured,
      framesAdvanced: result.framesAdvanced,
      pushedFrameCount: result.pushedFrameCount,
      distinctFrameCount: result.distinctFrameCount,
      endedReason: result.endedReason,
    });
  }
  return { runs };
}

async function probeOneSource(
  guest: BrowserViewWebContents,
  run: RecordingProbeRun,
  durationMs: number,
): Promise<RecordingProbeRunResult> {
  // The helper URL already names the recording the host minted for it; the
  // fallback id only ever keys this process's own map.
  const recordingId = readRecordingId(run.helperUrl);
  let helperReady = false;
  let endedReason: string | null = null;
  const onEvent = (event: RecordingEvent): void => {
    if (event.kind === "helperReady") helperReady = true;
    else endedReason = event.reason;
  };

  try {
    await startRecordingHelper({
      recordingId,
      helperUrl: run.helperUrl,
      guest,
      source: run.source,
      onEvent,
    });
  } catch (error) {
    log.warn("[browser-view] recording probe could not start", {
      source: run.source,
      error: describeLogError(error),
    });
    return blankResult(run, "probe-start-failed");
  }

  await delay(SETTLE_MS);
  const early = await readVideoFrameCount(recordingId);
  await delay(durationMs);
  const late = await readVideoFrameCount(recordingId);
  const frames = recordingFrameStats(recordingId);
  stopRecordingHelper(recordingId, "probe-complete");

  if (run.source === "capture-page") {
    return {
      source: run.source,
      helperReady,
      endedReason,
      pushedFrameCount: frames.pushed,
      distinctFrameCount: frames.distinct,
      measured: frames.pushed > 1,
      framesAdvanced: frames.distinct > 1,
    };
  }
  const measured = early !== null && late !== null;
  return {
    source: run.source,
    helperReady,
    endedReason,
    pushedFrameCount: 0,
    distinctFrameCount: 0,
    measured,
    framesAdvanced: early !== null && late !== null && late > early,
  };
}

function blankResult(
  run: RecordingProbeRun,
  endedReason: string,
): RecordingProbeRunResult {
  return {
    source: run.source,
    helperReady: false,
    endedReason,
    pushedFrameCount: 0,
    distinctFrameCount: 0,
    measured: false,
    framesAdvanced: false,
  };
}

async function readVideoFrameCount(
  recordingId: string,
): Promise<number | null> {
  try {
    const raw = await evaluateInRecordingHelper(
      recordingId,
      VIDEO_FRAME_COUNT_SCRIPT,
    );
    return videoFrameCountSchema.safeParse(raw).data ?? null;
  } catch {
    return null;
  }
}

function readRecordingId(helperUrl: string): string {
  try {
    return new URL(helperUrl).searchParams.get("recordingId") ?? randomUUID();
  } catch {
    return randomUUID();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
