import type { IpcMainInvokeEvent } from "electron";
import { isDevBuild } from "../../config";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { BrowserViewManager } from "../browser-view/browser-view-manager";
import { runRecordingCaptureSourceProbe } from "../browser-view/recording/recording-probe";
import {
  startRecordingHelper,
  stopAllRecordingHelpers,
  stopRecordingHelper,
} from "../browser-view/recording/recording-helper-window";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { browserViewIpcPayload } from "./browser-view-ipc-payload";

/**
 * Browser tab recording IPC, modelled on `pip-capture-ipc.ts`.
 *
 * The renderer is a RELAY here, not the origin of anything: the host asks for
 * a recording on `browser.sessions`, the coordinator forwards the request to
 * main, and the two facts main answers with come back as one event the
 * coordinator sends up the same stream. Nothing on these channels carries a
 * recording byte - the helper `POST`s its chunks straight to the host (D15).
 */
export function registerRecordingIpc(
  bridge: RunnerIpcBridge,
  manager: BrowserViewManager,
): void {
  bridge.handleInvoke(
    RunnerHostInvoke.recordingStart,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = browserViewIpcPayload.recordingStart.parse(payload);
      const guest = manager.nativeGuestWebContents(input);
      if (guest === null) {
        throw new Error("Electron browser tab is not available for recording");
      }
      // A renderer that goes away takes its recordings with it: the answers
      // would reach nobody, and a helper window nothing can stop is exactly the
      // orphan this ticket must not leave behind. A RELOAD keeps the same
      // `WebContents`, and the host re-drives that case through the restarted
      // coordinator.
      event.sender.once("destroyed", () => {
        stopRecordingHelper(input.recordingId, "renderer-gone");
      });
      await startRecordingHelper({
        recordingId: input.recordingId,
        helperUrl: input.helperUrl,
        guest,
        source: null,
        onEvent: (recordingEvent) => {
          bridge.safeSendToWindow(
            windowId,
            RunnerHostEvent.recordingEvent,
            recordingEvent,
          );
        },
      });
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.recordingStop, (_event, payload) => {
    const input = browserViewIpcPayload.recordingStop.parse(payload);
    stopRecordingHelper(input.recordingId, "stop-requested");
  });

  // Dev builds only, and registered rather than gated inside the handler: a
  // channel that does not exist cannot be called at all, which is the point of
  // a probe command that must never ship as a feature.
  if (isDevBuild) {
    bridge.handleInvoke(
      RunnerHostInvoke.recordingProbe,
      async (_event, payload) => {
        const input = browserViewIpcPayload.recordingProbe.parse(payload);
        const guest = manager.nativeGuestWebContents(input);
        if (guest === null) {
          throw new Error(
            "Electron browser tab is not available for recording",
          );
        }
        return runRecordingCaptureSourceProbe({ guest, input });
      },
    );
  }

  bridge.disposeFns.push(() => {
    stopAllRecordingHelpers("desktop-shutdown");
  });
}

function readSenderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null) {
    throw new Error("Recording IPC sender window is not registered");
  }
  return windowId;
}
