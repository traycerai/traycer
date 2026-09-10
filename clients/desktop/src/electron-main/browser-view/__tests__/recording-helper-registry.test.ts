import { afterEach, describe, expect, it } from "vitest";
import {
  isRecordingHelperWebContents,
  mediaPermissionAsksForAudio,
  recordingHelperRegistrationCount,
  registerRecordingHelper,
  resolveRecordingDisplayMediaVideo,
  type RecordingHelperRegistration,
} from "../recording/recording-helper-registry";

/**
 * The registry (`recording-helper-registry.ts`) is MODULE-GLOBAL: it imports
 * only `zod`, no Electron, so these are pure unit tests, but every
 * registration made here outlives the `it()` that made it unless the test
 * disposes it itself. Every test below tracks its own disposers and revokes
 * them in `afterEach` so this suite never leaks a registration into the
 * next one (or into another test file importing the same singleton module).
 */

let disposers: Array<() => void> = [];

function register(registration: RecordingHelperRegistration): () => void {
  const dispose = registerRecordingHelper(registration);
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  expect(recordingHelperRegistrationCount()).toBe(0);
});

function fixedFrame(frame: {
  readonly processId: number;
  readonly routingId: number;
}): () => { readonly processId: number; readonly routingId: number } {
  return () => frame;
}

describe("resolveRecordingDisplayMediaVideo", () => {
  it("denies a request whose frame matches no registration", () => {
    register({
      recordingId: "rec-1",
      helperWebContentsId: 1,
      helperFrame: fixedFrame({ processId: 10, routingId: 20 }),
      video: () => ({ guest: "video-1" }),
    });

    const result = resolveRecordingDisplayMediaVideo({
      frame: { processId: 999, routingId: 998 },
    });

    expect(result).toBeNull();
  });

  it("denies a malformed or unknown request shape", () => {
    register({
      recordingId: "rec-1",
      helperWebContentsId: 1,
      helperFrame: fixedFrame({ processId: 10, routingId: 20 }),
      video: () => ({ guest: "video-1" }),
    });

    expect(resolveRecordingDisplayMediaVideo(null)).toBeNull();
    expect(resolveRecordingDisplayMediaVideo(undefined)).toBeNull();
    expect(resolveRecordingDisplayMediaVideo({})).toBeNull();
    expect(resolveRecordingDisplayMediaVideo("frame")).toBeNull();
    expect(
      resolveRecordingDisplayMediaVideo({ frame: { processId: 10 } }),
    ).toBeNull();
    expect(
      resolveRecordingDisplayMediaVideo({
        frame: { processId: "10", routingId: 20 },
      }),
    ).toBeNull();
  });

  it("denies a registration whose helperFrame() now returns null", () => {
    register({
      recordingId: "rec-1",
      helperWebContentsId: 1,
      helperFrame: () => null,
      video: () => ({ guest: "video-1" }),
    });

    const result = resolveRecordingDisplayMediaVideo({
      frame: { processId: 10, routingId: 20 },
    });

    expect(result).toBeNull();
  });

  it("resolves exactly the matching helper's own guest video, never a crossed one", () => {
    const videoA = { guest: "A" };
    const videoB = { guest: "B" };
    register({
      recordingId: "rec-a",
      helperWebContentsId: 101,
      helperFrame: fixedFrame({ processId: 1, routingId: 11 }),
      video: () => videoA,
    });
    register({
      recordingId: "rec-b",
      helperWebContentsId: 102,
      helperFrame: fixedFrame({ processId: 2, routingId: 22 }),
      video: () => videoB,
    });

    expect(
      resolveRecordingDisplayMediaVideo({
        frame: { processId: 1, routingId: 11 },
      }),
    ).toBe(videoA);
    expect(
      resolveRecordingDisplayMediaVideo({
        frame: { processId: 2, routingId: 22 },
      }),
    ).toBe(videoB);
  });

  it("denies a registration whose video() returns null even though the helper frame matches", () => {
    register({
      recordingId: "rec-1",
      helperWebContentsId: 1,
      helperFrame: fixedFrame({ processId: 10, routingId: 20 }),
      video: () => null,
    });

    const result = resolveRecordingDisplayMediaVideo({
      frame: { processId: 10, routingId: 20 },
    });

    expect(result).toBeNull();
  });
});

describe("isRecordingHelperWebContents", () => {
  it("is true only for a registered helper's webContents id", () => {
    register({
      recordingId: "rec-1",
      helperWebContentsId: 55,
      helperFrame: fixedFrame({ processId: 10, routingId: 20 }),
      video: () => ({ guest: "video-1" }),
    });

    expect(isRecordingHelperWebContents({ id: 55 })).toBe(true);
    expect(isRecordingHelperWebContents({ id: 56 })).toBe(false);
  });

  it("is false for non-object or malformed input", () => {
    register({
      recordingId: "rec-1",
      helperWebContentsId: 55,
      helperFrame: fixedFrame({ processId: 10, routingId: 20 }),
      video: () => ({ guest: "video-1" }),
    });

    expect(isRecordingHelperWebContents(null)).toBe(false);
    expect(isRecordingHelperWebContents(undefined)).toBe(false);
    expect(isRecordingHelperWebContents("55")).toBe(false);
    expect(isRecordingHelperWebContents({})).toBe(false);
    expect(isRecordingHelperWebContents({ id: "55" })).toBe(false);
  });
});

describe("registerRecordingHelper disposer", () => {
  it("revokes both answers and is idempotent; count returns to 0", () => {
    const dispose = registerRecordingHelper({
      recordingId: "rec-1",
      helperWebContentsId: 55,
      helperFrame: fixedFrame({ processId: 10, routingId: 20 }),
      video: () => ({ guest: "video-1" }),
    });
    expect(recordingHelperRegistrationCount()).toBe(1);
    expect(isRecordingHelperWebContents({ id: 55 })).toBe(true);
    expect(
      resolveRecordingDisplayMediaVideo({
        frame: { processId: 10, routingId: 20 },
      }),
    ).not.toBeNull();

    dispose();

    expect(recordingHelperRegistrationCount()).toBe(0);
    expect(isRecordingHelperWebContents({ id: 55 })).toBe(false);
    expect(
      resolveRecordingDisplayMediaVideo({
        frame: { processId: 10, routingId: 20 },
      }),
    ).toBeNull();

    // Idempotent: a second call must not throw and must not affect a later
    // registration that happens to reuse the same recordingId.
    expect(() => dispose()).not.toThrow();
    expect(recordingHelperRegistrationCount()).toBe(0);

    const secondDispose = registerRecordingHelper({
      recordingId: "rec-1",
      helperWebContentsId: 55,
      helperFrame: fixedFrame({ processId: 10, routingId: 20 }),
      video: () => ({ guest: "video-2" }),
    });
    expect(recordingHelperRegistrationCount()).toBe(1);
    dispose(); // stale disposer from the first registration must be a no-op
    expect(recordingHelperRegistrationCount()).toBe(1);
    secondDispose();
    expect(recordingHelperRegistrationCount()).toBe(0);
  });
});

/**
 * The detail shapes Electron 42 hands the two permission handlers for a
 * `media` ask (`electron.d.ts`): `MediaAccessPermissionRequest.mediaTypes?:
 * Array<'video' | 'audio'>` on the request handler,
 * `PermissionCheckHandlerHandlerDetails.mediaType?: 'video' | 'audio' |
 * 'unknown'` on the check handler. Both optional, hence the "says nothing"
 * cases.
 */
describe("mediaPermissionAsksForAudio", () => {
  it("is true only when the details name audio", () => {
    expect(mediaPermissionAsksForAudio({ mediaTypes: ["audio"] })).toBe(true);
    expect(
      mediaPermissionAsksForAudio({ mediaTypes: ["video", "audio"] }),
    ).toBe(true);
    expect(mediaPermissionAsksForAudio({ mediaType: "audio" })).toBe(true);
  });

  it("is false for a video ask, and for details that say nothing", () => {
    expect(mediaPermissionAsksForAudio({ mediaTypes: ["video"] })).toBe(false);
    expect(mediaPermissionAsksForAudio({ mediaType: "video" })).toBe(false);
    expect(mediaPermissionAsksForAudio({ mediaType: "unknown" })).toBe(false);
    expect(mediaPermissionAsksForAudio({})).toBe(false);
    expect(mediaPermissionAsksForAudio({ isMainFrame: true })).toBe(false);
    expect(mediaPermissionAsksForAudio(null)).toBe(false);
    expect(mediaPermissionAsksForAudio(undefined)).toBe(false);
    expect(mediaPermissionAsksForAudio("audio")).toBe(false);
  });
});
