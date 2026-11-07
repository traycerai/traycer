import type { WebContents } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../ipc-contracts/ipc-channels";
import type { SessionRecordings } from "../soundtrack/session-recordings";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * How long a window's new document waits before main closes what the last one
 * left open. The last document closes its own recording as it unloads, and
 * Chromium can run that after the new one has loaded; this lets it land first.
 */
const DOCUMENT_RESET_GRACE_MS = 2000;

/** Asks every recording window to finish, and waits until `deadlineMs`. */
export type FinishSoundtrackRecordings = (deadlineMs: number) => Promise<void>;

function within(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    void work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The channels that save a recording of the music. The flag is read
 * synchronously at preload, because the renderer decides at render whether to
 * draw the switch. A production build answers false and registers nothing
 * else, so no path to a recording exists there at all.
 *
 * Every recording belongs to the window that opened it and the document it
 * showed: another window cannot write to it, and a window that goes away or
 * loads a new document has its recordings closed. Answers how a quit finishes
 * them first, while these channels are still up; null where nothing records.
 */
export function registerSoundtrackRecordingIpc(
  bridge: Pick<RunnerIpcBridge, "handleInvoke" | "handleSync" | "disposeFns">,
  recordings: SessionRecordings | null,
): FinishSoundtrackRecordings | null {
  bridge.handleSync(
    RunnerHostSync.soundtrackRecordingAvailable,
    () => recordings !== null,
  );
  if (recordings === null) return null;
  const senders = new Map<number, WebContents>();
  const resets = new Set<NodeJS.Timeout>();
  const watch = (sender: WebContents): number => {
    const ownerId = sender.id;
    if (senders.has(ownerId)) return ownerId;
    senders.set(ownerId, sender);
    const onNavigate = (): void => {
      const document = recordings.beginDocument(ownerId);
      const reset = setTimeout(() => {
        resets.delete(reset);
        void recordings.closeDocumentsBefore(ownerId, document);
      }, DOCUMENT_RESET_GRACE_MS);
      resets.add(reset);
    };
    const release = (): void => {
      sender.off("did-navigate", onNavigate);
      sender.off("destroyed", release);
      sender.off("render-process-gone", release);
      senders.delete(ownerId);
      void recordings.closeAllOf(ownerId);
    };
    sender.on("did-navigate", onNavigate);
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
    for (const reset of resets) clearTimeout(reset);
    resets.clear();
    void recordings.closeAll();
  });
  return async (deadlineMs) => {
    const until = Date.now() + deadlineMs;
    const owners = recordings.ownersRecording();
    for (const ownerId of owners) {
      const sender = senders.get(ownerId);
      if (sender !== undefined && !sender.isDestroyed()) {
        sender.send(RunnerHostEvent.soundtrackRecordingFinish);
      }
    }
    // Each window flushes its last second, ends its log and closes; whatever
    // has not closed by the deadline is closed as it stands.
    await within(recordings.settled(owners), until - Date.now());
    await within(recordings.closeAll(), until - Date.now());
  };
}
