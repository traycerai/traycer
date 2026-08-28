import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import { BrowserScreencastStreamClient } from "@traycer-clients/shared/host-transport/browser-screencast-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

export const PIP_HEADLESS_MAX_WIDTH = 480;
export const PIP_HEADLESS_MAX_HEIGHT = 360;
export const PIP_HEADLESS_QUALITY = 50;

interface PipHeadlessStreamHandle {
  close(): void;
}

/**
 * Same transport as the peek tile, without visibility registration, input
 * arming, or tile-open resume. A mirror has nothing to wait for, so it acks
 * on arrival rather than after paint.
 */
export function openPipHeadlessStream(input: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly onFrame: (
    frame: BrowserScreencastServerFrame,
    jpegBytes: Uint8Array | null,
  ) => void;
}): PipHeadlessStreamHandle {
  const stream = new BrowserScreencastStreamClient({
    wsStreamClient: input.client,
    epicId: input.epicId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    maxWidth: input.maxWidth,
    maxHeight: input.maxHeight,
    quality: input.quality,
    format: "jpeg",
    role: "pip",
    callbacks: {
      onServerFrame: (frame, jpegBytes) => {
        input.onFrame(frame, jpegBytes);
        if (frame.kind !== "frame") return;
        stream.sendClientFrame({
          kind: "ack",
          hasBinaryPayload: false,
          sequence: frame.sequence,
        });
      },
      onConnectionStatus: () => undefined,
    },
  });
  return {
    close: () => {
      stream.close();
    },
  };
}
