import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  PipCaptureIpcPayload,
  PipCaptureServerFrame,
  PipCaptureStartInput,
} from "../ipc-contracts/pip-capture-types";
import { subscribe, type Disposable } from "./subscribe";

export interface PipCaptureBridgeSurface {
  pipCapture: {
    start(input: PipCaptureStartInput): Promise<void>;
    stop(): Promise<void>;
    onFrame(
      handler: (
        frame: PipCaptureServerFrame,
        jpegBytes: Uint8Array | null,
      ) => void,
    ): Disposable;
  };
}

export function buildPipCaptureBridge(): PipCaptureBridgeSurface {
  return {
    pipCapture: {
      start: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.pipCaptureStart,
          input,
        ) as Promise<void>,
      stop: () =>
        ipcRenderer.invoke(RunnerHostInvoke.pipCaptureStop) as Promise<void>,
      onFrame: (handler) =>
        subscribe<PipCaptureIpcPayload>(
          RunnerHostEvent.pipCaptureFrame,
          (payload) => {
            handler(payload.frame, payload.jpegBytes);
          },
        ),
    },
  };
}
