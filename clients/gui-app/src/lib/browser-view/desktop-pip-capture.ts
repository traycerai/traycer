import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewNativeTabCapability } from "./desktop-browser-view";

export interface DesktopPipCaptureStartInput extends BrowserViewNativeTabCapability {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
}

/**
 * Preload surface for native-tab PiP capture. Frames are the
 * `started` / `frame` / `stalled` variants of `browserScreencastServerFrame`
 * so ticket 03 can render host and IPC streams with one code path.
 *
 * Optional on purpose: a renderer newer than its preload (desktop
 * hot-reload) must not make every browser tile unavailable. Missing
 * methods resolve to null from `resolveDesktopPipCaptureBridge`.
 */
export interface DesktopPipCaptureBridge {
  start(input: DesktopPipCaptureStartInput): Promise<void>;
  stop(): Promise<void>;
  onFrame(
    handler: (
      frame: BrowserScreencastServerFrame,
      jpegBytes: Uint8Array | null,
    ) => void,
  ): { dispose: () => void };
}

export function resolveDesktopPipCaptureBridge(
  runnerHost: IRunnerHost | object,
): DesktopPipCaptureBridge | null {
  if (!isRecord(runnerHost)) return null;
  const value = runnerHost.pipCapture;
  if (!isRecord(value)) return null;
  const start = value.start;
  const stop = value.stop;
  const onFrame = value.onFrame;
  if (
    !isBridgeMethod(start) ||
    !isBridgeMethod(stop) ||
    !isBridgeMethod(onFrame)
  ) {
    return null;
  }
  return {
    start: (input) =>
      Promise.resolve(start.call(value, input)).then(() => undefined),
    stop: () => Promise.resolve(stop.call(value)).then(() => undefined),
    onFrame: (handler) => readDisposable(onFrame.call(value, handler)),
  };
}

type PipCaptureBridgeMethod = (this: unknown, ...args: unknown[]) => unknown;

function isBridgeMethod(value: unknown): value is PipCaptureBridgeMethod {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDisposable(value: unknown): { dispose: () => void } {
  if (isRecord(value)) {
    const dispose = value.dispose;
    if (typeof dispose === "function") {
      return {
        dispose: () => {
          dispose.call(value);
        },
      };
    }
  }
  return { dispose: () => undefined };
}
