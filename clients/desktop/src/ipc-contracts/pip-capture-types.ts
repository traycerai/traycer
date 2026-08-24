import type { BrowserViewNativeTabCapability } from "./browser-view-types";

/**
 * Native-tab PiP capture frames. Shaped as the `started` / `frame` /
 * `stalled` variants of `@traycer/protocol`'s `browserScreencastServerFrame`
 * so the renderer can feed host streams and this IPC stream through one
 * code path. Preload cannot import protocol, so the wire shape lives here.
 */
export interface PipCaptureFrameMetadata {
  readonly offsetTop: number;
  readonly pageScaleFactor: number;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly scrollOffsetX: number;
  readonly scrollOffsetY: number;
  readonly timestamp: number;
}

export interface PipCaptureStartedFrame {
  readonly kind: "started";
  readonly hasBinaryPayload: false;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly deviceScaleFactor: number;
}

export interface PipCaptureVideoFrame {
  readonly kind: "frame";
  readonly hasBinaryPayload: true;
  readonly sequence: number;
  readonly metadata: PipCaptureFrameMetadata;
}

export interface PipCaptureStalledFrame {
  readonly kind: "stalled";
  readonly hasBinaryPayload: false;
}

export type PipCaptureServerFrame =
  PipCaptureStartedFrame | PipCaptureVideoFrame | PipCaptureStalledFrame;

export interface PipCaptureStartInput extends BrowserViewNativeTabCapability {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
}

export interface PipCaptureIpcPayload {
  readonly frame: PipCaptureServerFrame;
  readonly jpegBytes: Uint8Array | null;
}
