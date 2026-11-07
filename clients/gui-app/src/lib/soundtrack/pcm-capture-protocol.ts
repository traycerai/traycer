/**
 * What passes between the lossless capture and its worklet. Its own module, so
 * that the page can know the messages without loading the worklet's code.
 */

export const PCM_CAPTURE_PROCESSOR = "traycer-pcm-capture";

/** The one message the page sends: finish, handing over what is held. */
export const PCM_CAPTURE_FINISH = "finish";

export type PcmCaptureMessage =
  /** The audio clock time of the first frame, as the worklet saw it. */
  | { readonly type: "first-frame"; readonly time: number }
  /** Interleaved 16-bit stereo frames, in order. */
  | { readonly type: "pcm"; readonly buffer: ArrayBuffer }
  /** After the last `pcm`: every frame handed over, and the silence put in. */
  | {
      readonly type: "finished";
      readonly frames: number;
      readonly droppedFrames: number;
    };

export function isPcmCaptureMessage(
  value: unknown,
): value is PcmCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const type: unknown = Reflect.get(value, "type");
  return type === "first-frame" || type === "pcm" || type === "finished";
}
