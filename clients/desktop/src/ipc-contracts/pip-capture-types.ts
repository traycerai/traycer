import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";

export interface PipCaptureIpcPayload {
  readonly frame: BrowserScreencastServerFrame;
  readonly jpegBytes: Uint8Array | null;
}
