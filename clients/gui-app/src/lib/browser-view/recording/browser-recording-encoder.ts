/**
 * Encodes recorded frames into a real video file, in the renderer.
 *
 * Main captures frames but has no encoder; the renderer runs in a Chromium that
 * has `MediaRecorder` and `canvas.captureStream`, so the split is: main produces
 * JPEGs, this draws each one onto a canvas whose stream a `MediaRecorder` is
 * consuming, and the result is a WebM the user can play anywhere.
 *
 * ## Why a canvas stream rather than encoding frames directly
 *
 * `MediaRecorder` records a MediaStream, and the only way to make a stream out of
 * still images in a browser is to draw them somewhere that produces one.
 * `captureStream(0)` gives a track that emits exactly when
 * `requestFrame()` is called, which is what makes the output track the CAPTURE
 * cadence rather than the wall clock - a recording paced by a slow host plays back
 * at the speed it was captured instead of stalling.
 *
 * ## Why the first frame decides the size
 *
 * A canvas cannot change size mid-stream without tearing the recording, and a
 * tile can be resized while recording. The first frame fixes the dimensions and
 * later frames are drawn to fit, so a resize during a recording is a letterboxed
 * frame rather than a corrupt file.
 */
import { appLogger } from "@/lib/logger";

export interface BrowserRecordingEncoder {
  /** Draws one frame and asks the track to emit it. */
  addFrame(jpegBase64: string): Promise<void>;
  /** Finishes the file. Resolves with the encoded video, or null if empty. */
  finish(): Promise<Blob | null>;
  /** Abandons the recording without producing a file. */
  cancel(): void;
}

/**
 * The container and codec asked for.
 *
 * VP8-in-WebM rather than H.264: it is the format Chromium can always encode
 * without a platform codec, and `MediaRecorder` support for it is not
 * conditional. A file that sometimes fails to record is worse than one that needs
 * a modern player.
 */
const RECORDING_MIME_TYPE = "video/webm;codecs=vp8";
/**
 * A bitrate high enough that page text survives. Text is the payload in a screen
 * recording, and VP8 at a video-typical bitrate turns small type into mush.
 */
const RECORDING_BITS_PER_SECOND = 6_000_000;

export function createBrowserRecordingEncoder(): BrowserRecordingEncoder | null {
  if (typeof MediaRecorder === "undefined") return null;
  if (!MediaRecorder.isTypeSupported(RECORDING_MIME_TYPE)) return null;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return null;

  let recorder: MediaRecorder | null = null;
  let track: CanvasCaptureMediaStreamTrack | null = null;
  const chunks: Blob[] = [];
  let cancelled = false;
  /**
   * Read through a function rather than directly: `cancel()` can land while a
   * frame is being decoded, so the post-await check is the one that matters -
   * and a direct read there narrows to the value from before the await.
   */
  const isCancelled = (): boolean => cancelled;

  const ensureRecorder = (width: number, height: number): void => {
    if (recorder !== null) return;
    canvas.width = width;
    canvas.height = height;
    // 0 fps: the track emits only when `requestFrame` asks, so the output
    // follows the capture cadence rather than the wall clock.
    const stream = canvas.captureStream(0);
    const [first] = stream.getVideoTracks();
    track = (first as CanvasCaptureMediaStreamTrack | undefined) ?? null;
    recorder = new MediaRecorder(stream, {
      mimeType: RECORDING_MIME_TYPE,
      videoBitsPerSecond: RECORDING_BITS_PER_SECOND,
    });
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();
  };

  /**
   * The tail of the frame queue.
   *
   * Frames arrive from an IPC listener that cannot await, so without this each
   * `addFrame` would decode concurrently and draw whenever its own decode
   * finished. Decode time varies with frame content, so a heavy frame followed by
   * a light one lands in the wrong order - the recording plays back out of
   * sequence, which is worse than a dropped frame because it looks like the page
   * did something it never did.
   */
  let queue: Promise<void> = Promise.resolve();

  const drawFrame = async (jpegBase64: string): Promise<void> => {
    if (isCancelled()) return;
    const bitmap = await decodeJpeg(jpegBase64);
    if (bitmap === null) return;
    try {
      if (isCancelled()) return;
      ensureRecorder(bitmap.width, bitmap.height);
      // LETTERBOXED, not stretched. The canvas size is fixed by the first frame
      // because a mid-stream resize tears the recording, so a tile resized while
      // recording delivers frames of a different shape - and scaling those to the
      // original box distorts the page, which is worse than bars around it when
      // the artifact's job is to show what the page looked like.
      const box = containedBox(
        bitmap.width,
        bitmap.height,
        canvas.width,
        canvas.height,
      );
      // Cleared first, or the previous frame stays visible in the bars.
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, box.x, box.y, box.width, box.height);
      track?.requestFrame();
    } finally {
      // In a `finally` because an ImageBitmap holds native memory that GC does
      // not promptly reclaim, and every exit from here has to release it: the
      // cancellation check above, a throwing `drawImage`, and the ordinary path.
      bitmap.close();
    }
  };

  return {
    addFrame: (jpegBase64) => {
      // Chained, and the chain is what the caller awaits: order is preserved
      // even though every caller fires and forgets.
      //
      // The `catch` is what keeps the chain USABLE. A rejected link would be
      // inherited by every frame queued after it - `then` with no rejection
      // handler passes the rejection straight down - so one failed draw would
      // silently discard the rest of the recording AND reject `finish()`, whose
      // caller invokes it as `void finishRecording(...)`. A dropped frame is a
      // gap in a video; a rejected queue is the whole file, plus an unhandled
      // rejection.
      queue = queue.then(() =>
        drawFrame(jpegBase64).catch((cause: unknown) => {
          appLogger.warn("[browser-view] recording frame dropped", {
            error: cause instanceof Error ? cause.message : "unknown",
          });
        }),
      );
      return queue;
    },
    finish: async () => {
      // Drain first. Stopping the recorder with decodes still in flight loses
      // exactly the frames at the end of the recording - the ones the user was
      // most likely waiting for before pressing stop.
      await queue;
      const active = recorder;
      if (active === null || isCancelled()) return null;
      await new Promise<void>((resolve) => {
        active.onstop = () => resolve();
        active.stop();
      });
      recorder = null;
      if (chunks.length === 0) return null;
      return new Blob(chunks, { type: RECORDING_MIME_TYPE });
    },
    cancel: () => {
      cancelled = true;
      if (recorder !== null && recorder.state !== "inactive") recorder.stop();
      recorder = null;
      chunks.length = 0;
    },
  };
}

/**
 * Decodes one base64 JPEG. `createImageBitmap` rather than an `<img>` because it
 * decodes off the main thread and needs no load-event dance; a frame that fails
 * to decode is dropped, since one bad frame must not end a recording.
 */
/**
 * The largest rectangle of `sourceWidth x sourceHeight` proportions that fits in
 * the canvas, centred.
 */
function containedBox(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  }
  const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
}

async function decodeJpeg(jpegBase64: string): Promise<ImageBitmap | null> {
  try {
    const binary = atob(jpegBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  } catch {
    return null;
  }
}
