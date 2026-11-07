/**
 * A recording of the music, written by main into its own folder
 * (`electron-main/soundtrack/session-recordings.ts`). The renderer names a
 * recording by the id `open` answered and hands over bytes; main picks the
 * folder and the file names, and a path never crosses.
 */

export type SoundtrackRecordingQuality = "compressed" | "lossless";

export type SoundtrackRecordingFile = "audio" | "log";

export type SoundtrackRecordingOpenResult =
  | {
      readonly kind: "opened";
      readonly recordingId: string;
      /** The name both files share, without their extensions. */
      readonly name: string;
    }
  | { readonly kind: "refused" };

/**
 * `write-failed`: the disk would not take the bytes, full or otherwise, and
 * the recording takes no more. `refused`: the input was not one main accepts,
 * or names no recording this window has open.
 */
export type SoundtrackRecordingWriteResult =
  | { readonly kind: "ok" }
  | { readonly kind: "write-failed" }
  | { readonly kind: "refused" };

/** The preload's `soundtrackRecording` member, on a build that can record. */
export interface SoundtrackRecordingBridge {
  open(
    quality: SoundtrackRecordingQuality,
  ): Promise<SoundtrackRecordingOpenResult>;
  append(
    recordingId: string,
    file: SoundtrackRecordingFile,
    bytes: Uint8Array,
  ): Promise<SoundtrackRecordingWriteResult>;
  /** Writes `audioHeader` over the start of a WAV, then closes both files. */
  close(
    recordingId: string,
    audioHeader: Uint8Array | null,
  ): Promise<SoundtrackRecordingWriteResult>;
  reveal(recordingId: string): Promise<boolean>;
}
