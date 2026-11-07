/** How a recording keeps the audio: Opus in WebM, or 16-bit stereo WAV. */
export type RecordingQuality = "compressed" | "lossless";

export const DEFAULT_RECORDING_QUALITY: RecordingQuality = "compressed";

export function isRecordingQuality(value: unknown): value is RecordingQuality {
  return value === "compressed" || value === "lossless";
}

/** How long a recording runs before it stops on its own, in audio time. */
export const RECORDING_LIMITS = {
  "30-minutes": 30 * 60,
  "1-hour": 60 * 60,
  "2-hours": 2 * 60 * 60,
  "until-off": null,
} as const satisfies Record<string, number | null>;

export type RecordingLimitId = keyof typeof RECORDING_LIMITS;

export const DEFAULT_RECORDING_LIMIT: RecordingLimitId = "1-hour";

export function isRecordingLimitId(value: unknown): value is RecordingLimitId {
  return typeof value === "string" && Object.hasOwn(RECORDING_LIMITS, value);
}

export interface MixCaptureHandlers {
  /** Once, with the audio clock time of the first frame captured. */
  readonly onFirstFrame: (clockSeconds: number) => void;
  /** The audio in order: WebM as it is made, or 16-bit stereo frames. */
  readonly onChunk: (bytes: Uint8Array) => void;
  /** Once, if it stops on its own; nothing is delivered after. */
  readonly onError: (error: unknown) => void;
}

/** What a capture can say about itself once it has stopped. */
export interface CaptureSummary {
  /** Frames delivered, where the capture counts them; null where it cannot. */
  readonly frames: number | null;
  /**
   * Frames the audio thread went past without handing over, delivered as
   * silence so that the file keeps time; null where it cannot tell.
   */
  readonly droppedFrames: number | null;
}

/** A copy of the mix being taken, from `start` until `stop`. */
export interface MixCapture {
  readonly sampleRate: number;
  /**
   * Where the clock time `onFirstFrame` gives, which is log time 0, falls in
   * the audio file, in seconds from its start.
   */
  readonly audioOffsetSeconds: number;
  start(handlers: MixCaptureHandlers): void;
  /** Delivers what is still on its way, then lets go of its audio nodes. */
  stop(): Promise<CaptureSummary>;
}

/** The two files of a recording, side by side. */
export type RecordingFile = "audio" | "log";

export type RecordingOpenResult =
  | {
      readonly kind: "opened";
      readonly recordingId: string;
      /** What the person sees it called, which both files share. */
      readonly name: string;
    }
  | { readonly kind: "refused" };

/**
 * `write-failed`: the disk would not take the bytes, full or otherwise.
 * `refused`: no such recording is open for them.
 */
export type RecordingWriteResult =
  | { readonly kind: "ok" }
  | { readonly kind: "write-failed" }
  | { readonly kind: "refused" };

/**
 * Where a recording is written. The writer picks the folder and the names; a
 * recording is addressed by the id it answered `open` with, and never by path.
 */
export interface RecordingSaveChannel {
  open(quality: RecordingQuality): Promise<RecordingOpenResult>;
  append(
    recordingId: string,
    file: RecordingFile,
    bytes: Uint8Array,
  ): Promise<RecordingWriteResult>;
  /**
   * Writes `audioHeader` over the start of the audio file, when there is one,
   * and closes both files.
   */
  close(
    recordingId: string,
    audioHeader: Uint8Array | null,
  ): Promise<RecordingWriteResult>;
  /** Shows the recording's files in the system's file manager. */
  reveal(recordingId: string): Promise<boolean>;
  /**
   * Calls `listener` when the app is about to quit and asks a recording to
   * finish while the writer can still take its last writes. Answers how to
   * stop listening.
   */
  onFinishRequested(listener: () => void): () => void;
}
