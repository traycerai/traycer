import { describe, expect, it } from "vitest";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { openPipHeadlessStream } from "../pip-headless-stream";

function unusedClientMethod(): never {
  throw new Error("not exercised by this test");
}

function createScreencastClientHarness(): {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly subscribeCalls: Array<{
    readonly method: string;
    readonly params: unknown;
  }>;
  readonly sentClientFrames: Array<{
    readonly envelope: StreamFrameEnvelope;
    readonly binaryPayload: Uint8Array | null;
  }>;
  readonly closeCount: { value: number };
  deliverServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void;
} {
  const subscribeCalls: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  const sentClientFrames: Array<{
    readonly envelope: StreamFrameEnvelope;
    readonly binaryPayload: Uint8Array | null;
  }> = [];
  const closeCount = { value: 0 };
  let serverFrameHandler: ServerFrameHandler | null = null;

  const session: IStreamSession = {
    sendClientFrame(envelope, binaryPayload) {
      sentClientFrames.push({ envelope, binaryPayload });
    },
    onServerFrame(handler) {
      serverFrameHandler = handler;
    },
    onStatusChange() {},
    getNegotiatedSchemaVersion: () => null,
    requestReconnect() {},
    close() {
      closeCount.value += 1;
    },
  };

  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe(method, params) {
      subscribeCalls.push({ method, params });
      return session;
    },
    subscribeWithParamsProvider: unusedClientMethod,
    close() {},
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated() {},
    reconnectAll() {},
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => {},
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => {},
    getClosedReason: () => null,
    onClosed: () => () => {},
    instanceId: "pip-headless-stream-test-client",
  };

  return {
    client,
    subscribeCalls,
    sentClientFrames,
    closeCount,
    deliverServerFrame(envelope, binaryPayload) {
      if (serverFrameHandler === null) {
        throw new Error("expected onServerFrame to be installed");
      }
      serverFrameHandler(envelope, binaryPayload);
    },
  };
}

describe("openPipHeadlessStream", () => {
  it("subscribes as role pip, closes, and forwards jpeg frames", () => {
    const harness = createScreencastClientHarness();
    const received: Array<{
      readonly frame: BrowserScreencastServerFrame;
      readonly jpegBytes: Uint8Array | null;
    }> = [];

    const handle = openPipHeadlessStream({
      client: harness.client,
      epicId: "epic-1",
      sessionId: "session-1",
      tabId: "tab-1",
      maxWidth: 480,
      maxHeight: 360,
      quality: 50,
      onFrame: (frame, jpegBytes) => {
        received.push({ frame, jpegBytes });
      },
    });

    expect(harness.subscribeCalls).toEqual([
      {
        method: "browser.screencast",
        params: {
          epicId: "epic-1",
          sessionId: "session-1",
          tabId: "tab-1",
          maxWidth: 480,
          maxHeight: 360,
          quality: 50,
          format: "jpeg",
          role: "pip",
        },
      },
    ]);

    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const frame: BrowserScreencastServerFrame = {
      kind: "frame",
      hasBinaryPayload: true,
      sequence: 7,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: 1,
      },
    };
    harness.deliverServerFrame(frame, jpegBytes);
    expect(received).toEqual([{ frame, jpegBytes }]);
    expect(harness.sentClientFrames).toEqual([
      {
        envelope: {
          kind: "ack",
          hasBinaryPayload: false,
          sequence: 7,
        },
        binaryPayload: null,
      },
    ]);

    handle.close();
    expect(harness.closeCount.value).toBe(1);
  });
});
