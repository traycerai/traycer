import { ipcRenderer } from "electron";
import {
  RunnerHostInvoke,
  RunnerHostSync,
} from "../ipc-contracts/ipc-channels";
import type {
  SoundtrackRecordingBridge,
  SoundtrackRecordingOpenResult,
  SoundtrackRecordingWriteResult,
} from "../ipc-contracts/soundtrack-recording-types";
import { readSyncBoolean } from "./sync-bootstrap";

/**
 * The `soundtrackRecording` member: null where main says this build cannot
 * record, which is every production build. The renderer hands over a quality
 * and bytes, never a path.
 */
export function buildSoundtrackRecordingBridge(): SoundtrackRecordingBridge | null {
  if (!readSyncBoolean(RunnerHostSync.soundtrackRecordingAvailable, false)) {
    return null;
  }
  return {
    open: (quality) =>
      ipcRenderer.invoke(RunnerHostInvoke.openSoundtrackRecording, {
        quality,
      }) as Promise<SoundtrackRecordingOpenResult>,
    append: (recordingId, file, bytes) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.appendSoundtrackRecording,
        recordingId,
        file,
        bytes,
      ) as Promise<SoundtrackRecordingWriteResult>,
    close: (recordingId, audioHeader) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.closeSoundtrackRecording,
        recordingId,
        audioHeader,
      ) as Promise<SoundtrackRecordingWriteResult>,
    reveal: (recordingId) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.revealSoundtrackRecording,
        recordingId,
      ) as Promise<boolean>,
  };
}
