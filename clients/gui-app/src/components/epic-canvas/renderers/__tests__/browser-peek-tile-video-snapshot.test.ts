import { afterEach, describe, expect, it } from "vitest";
import {
  clearLastBrowserPeekFrame,
  getLastBrowserPeekFrame,
  snapshotVideoFrameIntoPeekCache,
} from "@/components/epic-canvas/renderers/browser-peek-tile";

/**
 * `snapshotVideoFrameIntoPeekCache` guards (ticket 13). jsdom has no real
 * canvas 2D backend, so `getContext`/`toDataURL` are stubbed the same way
 * `image-preview-clipboard.test.ts` stubs them - what this file pins is the
 * GUARD logic and the cache write/key, not the actual JPEG encode of a real
 * decoded video frame, which only a live pass through a real `<video>` can
 * verify (see the report for what remains live-verify-only).
 */

function fakeVideo(width: number, height: number): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height },
  });
  return video;
}

function stubCanvasPrototype(args: {
  readonly getContext: () => {
    readonly drawImage: (...values: unknown[]) => void;
  } | null;
  readonly toDataURL: (type: string, quality: number) => string;
}): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: args.getContext,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: args.toDataURL,
  });
}

const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
const originalToDataURL = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "toDataURL",
);

const KEY = "video-snapshot-guard-test";

afterEach(() => {
  clearLastBrowserPeekFrame(KEY);
  if (originalGetContext !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContext,
    );
  }
  if (originalToDataURL !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "toDataURL",
      originalToDataURL,
    );
  }
});

describe("snapshotVideoFrameIntoPeekCache", () => {
  it("draws the decoded frame and writes the cache under the given key when the video plane was active", () => {
    const drawImage: unknown[][] = [];
    let requestedQuality: number | null = null;
    stubCanvasPrototype({
      getContext: () => ({
        drawImage: (...args: unknown[]) => {
          drawImage.push(args);
        },
      }),
      toDataURL: (type, quality) => {
        requestedQuality = quality;
        expect(type).toBe("image/jpeg");
        return "data:image/jpeg;base64,FAKE";
      },
    });
    const video = fakeVideo(640, 480);

    snapshotVideoFrameIntoPeekCache(KEY, video, true);

    expect(getLastBrowserPeekFrame(KEY)?.src).toBe(
      "data:image/jpeg;base64,FAKE",
    );
    expect(drawImage).toEqual([[video, 0, 0, 640, 480]]);
    expect(requestedQuality).toBe(0.7);
  });

  it("does not write when the video plane was not the active/painting plane", () => {
    stubCanvasPrototype({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/jpeg;base64,SHOULD_NOT_WRITE",
    });
    const video = fakeVideo(640, 480);

    snapshotVideoFrameIntoPeekCache(KEY, video, false);

    expect(getLastBrowserPeekFrame(KEY)).toBeNull();
  });

  it("does not write when the video has no decoded frame (0x0)", () => {
    const createContext = { called: false };
    stubCanvasPrototype({
      getContext: () => {
        createContext.called = true;
        return { drawImage: () => {} };
      },
      toDataURL: () => "data:image/jpeg;base64,SHOULD_NOT_WRITE",
    });
    const video = fakeVideo(0, 0);

    snapshotVideoFrameIntoPeekCache(KEY, video, true);

    expect(getLastBrowserPeekFrame(KEY)).toBeNull();
    // The width/height guard is checked before touching the canvas at all.
    expect(createContext.called).toBe(false);
  });

  it("does not write when only one dimension has decoded", () => {
    stubCanvasPrototype({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/jpeg;base64,SHOULD_NOT_WRITE",
    });

    snapshotVideoFrameIntoPeekCache(KEY, fakeVideo(640, 0), true);
    expect(getLastBrowserPeekFrame(KEY)).toBeNull();

    snapshotVideoFrameIntoPeekCache(KEY, fakeVideo(0, 480), true);
    expect(getLastBrowserPeekFrame(KEY)).toBeNull();
  });

  it("does not write when the browser cannot provide a 2D context", () => {
    stubCanvasPrototype({
      getContext: () => null,
      toDataURL: () => {
        throw new Error("toDataURL should not be reached");
      },
    });
    const video = fakeVideo(640, 480);

    snapshotVideoFrameIntoPeekCache(KEY, video, true);

    expect(getLastBrowserPeekFrame(KEY)).toBeNull();
  });

  it("does not clobber an existing cache entry when a later call fails its guard", () => {
    stubCanvasPrototype({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/jpeg;base64,FIRST",
    });
    snapshotVideoFrameIntoPeekCache(KEY, fakeVideo(640, 480), true);
    expect(getLastBrowserPeekFrame(KEY)?.src).toBe(
      "data:image/jpeg;base64,FIRST",
    );

    stubCanvasPrototype({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/jpeg;base64,SECOND",
    });
    // Guard fails (not the active plane) - the earlier, still-relevant
    // snapshot must be left standing rather than blanked or replaced.
    snapshotVideoFrameIntoPeekCache(KEY, fakeVideo(640, 480), false);

    expect(getLastBrowserPeekFrame(KEY)?.src).toBe(
      "data:image/jpeg;base64,FIRST",
    );
  });
});
