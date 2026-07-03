import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { IpcZoomController } from "./runner-ipc-bridge";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export interface ZoomIpcBridge {
  readonly zoomController: IpcZoomController;
  readonly disposeFns: Array<() => void>;
  handleInvoke(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
  fanOut(channel: string, payload: unknown): void;
}

export function registerZoomIpc(bridge: RunnerIpcBridge | ZoomIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.zoomGet, () =>
    bridge.zoomController.getZoomPercent(),
  );
  bridge.handleInvoke(RunnerHostInvoke.zoomSet, (_event, percent) =>
    bridge.zoomController.setZoomPercent(readZoomPercent(percent)),
  );
  bridge.handleInvoke(RunnerHostInvoke.zoomStepIn, () =>
    bridge.zoomController.zoomIn(),
  );
  bridge.handleInvoke(RunnerHostInvoke.zoomStepOut, () =>
    bridge.zoomController.zoomOut(),
  );
  bridge.handleInvoke(RunnerHostInvoke.zoomReset, () =>
    bridge.zoomController.reset(),
  );

  bridge.disposeFns.push(
    bridge.zoomController.onChange((percent) => {
      bridge.fanOut(RunnerHostEvent.zoomChange, percent);
    }),
  );
}

function readZoomPercent(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error("Zoom percent must be a finite number");
}
