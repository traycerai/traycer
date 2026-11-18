import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import {
  ZOOM_PERCENT_LADDER,
  type ZoomPercent,
} from "../ipc-contracts/zoom-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface ZoomBridgeSurface {
  zoom: {
    readonly ladder: readonly ZoomPercent[];
    get(): Promise<ZoomPercent>;
    set(percent: ZoomPercent): Promise<ZoomPercent>;
    stepIn(): Promise<ZoomPercent>;
    stepOut(): Promise<ZoomPercent>;
    reset(): Promise<ZoomPercent>;
    onChange(handler: Listener<ZoomPercent>): Disposable;
  };
}

export function buildZoomBridge(): ZoomBridgeSurface {
  return {
    zoom: {
      ladder: ZOOM_PERCENT_LADDER,
      get: () =>
        ipcRenderer.invoke(RunnerHostInvoke.zoomGet) as Promise<ZoomPercent>,
      set: (percent) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.zoomSet,
          percent,
        ) as Promise<ZoomPercent>,
      stepIn: () =>
        ipcRenderer.invoke(RunnerHostInvoke.zoomStepIn) as Promise<ZoomPercent>,
      stepOut: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.zoomStepOut,
        ) as Promise<ZoomPercent>,
      reset: () =>
        ipcRenderer.invoke(RunnerHostInvoke.zoomReset) as Promise<ZoomPercent>,
      onChange: (handler) =>
        subscribe<ZoomPercent>(RunnerHostEvent.zoomChange, handler),
    },
  };
}
