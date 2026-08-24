import type { IpcMainInvokeEvent } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type {
  PipCaptureIpcPayload,
  PipCaptureStartInput,
} from "../../ipc-contracts/pip-capture-types";
import type { BrowserViewManager } from "../browser-view/browser-view-manager";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { parseBrowserViewNativeTabCapability } from "./browser-view-native-tab-payload";

/**
 * Native-tab PiP capture IPC. Capture commands stay off the host CDP dispatch
 * path and go directly to `BrowserDebugSession`.
 */
export function registerPipCaptureIpc(
  bridge: RunnerIpcBridge,
  manager: BrowserViewManager,
): void {
  bridge.handleInvoke(
    RunnerHostInvoke.pipCaptureStart,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = parsePipCaptureStart(payload);
      manager.stopPipCapture();
      const onFrame = (framePayload: PipCaptureIpcPayload): void => {
        bridge.safeSendToWindow(
          windowId,
          RunnerHostEvent.pipCaptureFrame,
          framePayload,
        );
      };
      const started = await manager.startPipCapture(windowId, input, onFrame);
      if (!started) {
        throw new Error(
          "Electron browser tab is not available for pip capture",
        );
      }
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.pipCaptureStop, () => {
    manager.stopPipCapture();
  });
}

function readSenderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null) {
    throw new Error("Pip capture IPC sender window is not registered");
  }
  return windowId;
}

function parsePipCaptureStart(value: unknown): PipCaptureStartInput {
  const record = assertRecord(value, "Pip capture start payload");
  return {
    ...parseBrowserViewNativeTabCapability(record),
    maxWidth: readPositiveInt(record.maxWidth, "maxWidth"),
    maxHeight: readPositiveInt(record.maxHeight, "maxHeight"),
    quality: readQuality(record.quality),
  };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} must be an object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Pip capture ${field} must be a positive integer`);
  }
  return value;
}

function readQuality(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new Error("Pip capture quality must be an integer from 0 to 100");
  }
  return value;
}
