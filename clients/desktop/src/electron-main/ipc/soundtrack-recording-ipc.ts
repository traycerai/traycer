import type { WebContents } from "electron";
import {
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../ipc-contracts/ipc-channels";
import type { SessionRecordings } from "../soundtrack/session-recordings";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * The channels that save a recording of the music. The flag is read
 * synchronously at preload, because the renderer decides at render whether to
 * draw the switch. A production build answers false and registers nothing
 * else, so no path to a recording exists there at all.
 *
 * Every recording belongs to the window that opened it: another window cannot
 * write to it, and a window that goes away has its recordings closed.
 */
export function registerSoundtrackRecordingIpc(
  bridge: Pick<RunnerIpcBridge, "handleInvoke" | "handleSync" | "disposeFns">,
  recordings: SessionRecordings | null,
): void {
  bridge.handleSync(
    RunnerHostSync.soundtrackRecordingAvailable,
    () => recordings !== null,
  );
  if (recordings === null) return;
  const watched = new Set<number>();
  const watch = (sender: WebContents): number => {
    const ownerId = sender.id;
    if (watched.has(ownerId)) return ownerId;
    watched.add(ownerId);
    const release = (): void => {
      sender.off("destroyed", release);
      sender.off("render-process-gone", release);
      watched.delete(ownerId);
      void recordings.closeAllOf(ownerId);
    };
    sender.once("destroyed", release);
    sender.once("render-process-gone", release);
    return ownerId;
  };
  bridge.handleInvoke(
    RunnerHostInvoke.openSoundtrackRecording,
    (event, input) => recordings.openRecording(watch(event.sender), input),
  );
  bridge.handleInvoke(
    RunnerHostInvoke.appendSoundtrackRecording,
    (event, recordingId, file, bytes) =>
      recordings.append(event.sender.id, recordingId, file, bytes),
  );
  bridge.handleInvoke(
    RunnerHostInvoke.closeSoundtrackRecording,
    (event, recordingId, audioHeader) =>
      recordings.close(event.sender.id, recordingId, audioHeader),
  );
  bridge.handleInvoke(
    RunnerHostInvoke.revealSoundtrackRecording,
    (_event, recordingId) => recordings.reveal(recordingId),
  );
  bridge.disposeFns.push(() => {
    void recordings.closeAll();
  });
}
