import { describe, expect, it } from "vitest";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import {
  resolveDesktopPipCaptureBridge,
  type DesktopPipCaptureStartInput,
} from "@/lib/browser-view/desktop-pip-capture";

describe("resolveDesktopPipCaptureBridge", () => {
  it("returns null when pipCapture is missing", () => {
    const host: object = {};
    expect(resolveDesktopPipCaptureBridge(host)).toBeNull();
  });

  it("returns a working bridge when start, stop, and onFrame are present", async () => {
    const startCalls: DesktopPipCaptureStartInput[] = [];
    let stopCalls = 0;
    let disposed = false;
    const subscribed: Array<
      (
        frame: BrowserScreencastServerFrame,
        jpegBytes: Uint8Array | null,
      ) => void
    > = [];

    const host: object = {
      pipCapture: {
        start(input: DesktopPipCaptureStartInput): void {
          startCalls.push(input);
        },
        stop(): void {
          stopCalls += 1;
        },
        onFrame(
          handler: (
            frame: BrowserScreencastServerFrame,
            jpegBytes: Uint8Array | null,
          ) => void,
        ): { dispose: () => void } {
          subscribed.push(handler);
          return {
            dispose: () => {
              disposed = true;
            },
          };
        },
      },
    };

    const bridge = resolveDesktopPipCaptureBridge(host);
    if (bridge === null) {
      throw new Error("expected a pipCapture bridge");
    }

    await bridge.start({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      maxWidth: 320,
      maxHeight: 180,
      quality: 70,
    });
    expect(startCalls).toEqual([
      {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
        maxWidth: 320,
        maxHeight: 180,
        quality: 70,
      },
    ]);

    await bridge.stop();
    expect(stopCalls).toBe(1);

    const received: Array<{
      readonly frame: BrowserScreencastServerFrame;
      readonly jpegBytes: Uint8Array | null;
    }> = [];
    const subscription = bridge.onFrame((frame, jpegBytes) => {
      received.push({ frame, jpegBytes });
    });
    expect(subscribed).toHaveLength(1);

    const stalled: BrowserScreencastServerFrame = {
      kind: "stalled",
      hasBinaryPayload: false,
    };
    subscribed[0]?.(stalled, null);
    expect(received).toEqual([{ frame: stalled, jpegBytes: null }]);

    subscription.dispose();
    expect(disposed).toBe(true);
  });
});
