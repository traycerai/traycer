import { describe, expect, it } from "vitest";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  BrowserSessionsLifecycle,
  BrowserSessionsStreamKey,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserSessionsUxServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { openBrowserSessionsSession } from "@/lib/browser-view/sessions/browser-sessions-session";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { epicScope } from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";

const KEY: BrowserSessionsStreamKey = {
  scope: epicScope("epic-1"),
  hostId: "host-1",
  identityKey: "local\u0000host-1\u0000user-1",
};

function recordingCallbacks(): {
  readonly statuses: Array<{
    readonly lifecycle: BrowserSessionsLifecycle;
    readonly errorMessage: string | null;
  }>;
  readonly frames: BrowserSessionsUxServerFrame[];
  readonly bound: BrowserViewNativeTabCapability[];
  readonly released: BrowserViewNativeTabCapability[];
  readonly callbacks: {
    readonly onStatus: (
      lifecycle: BrowserSessionsLifecycle,
      errorMessage: string | null,
    ) => void;
    readonly onFrame: (frame: BrowserSessionsUxServerFrame) => void;
    readonly onTabBound: (capability: BrowserViewNativeTabCapability) => void;
    readonly onTabReleased: (
      capability: BrowserViewNativeTabCapability,
    ) => void;
  };
} {
  const statuses: Array<{
    lifecycle: BrowserSessionsLifecycle;
    errorMessage: string | null;
  }> = [];
  const frames: BrowserSessionsUxServerFrame[] = [];
  const bound: BrowserViewNativeTabCapability[] = [];
  const released: BrowserViewNativeTabCapability[] = [];
  return {
    statuses,
    frames,
    bound,
    released,
    callbacks: {
      onStatus: (lifecycle, errorMessage) => {
        statuses.push({ lifecycle, errorMessage });
      },
      onFrame: (frame) => {
        frames.push(frame);
      },
      onTabBound: (capability) => {
        bound.push(capability);
      },
      onTabReleased: (capability) => {
        released.push(capability);
      },
    },
  };
}

const SNAPSHOT_FRAME: BrowserSessionsUxServerFrame = {
  kind: "snapshot",
  hasBinaryPayload: false,
  sessions: [],
};

describe("openBrowserSessionsSession on a desktop shell (browserView present)", () => {
  it("opens through IPC and relays only UX frames the bridge forwards", () => {
    const bridge = new FakeBrowserViewBridge();
    const { statuses, frames, callbacks } = recordingCallbacks();
    const session = openBrowserSessionsSession({
      key: KEY,
      userId: "user-1",
      browserView: bridge,
      openTransport: () => {
        throw new Error("the IPC path must never open its own transport");
      },
      callbacks,
    });

    // The key and nothing else: main reads the signed-in user itself, so a
    // renderer cannot name one (H10 ruling 1).
    expect(bridge.openSessionsStreamCalls).toEqual([KEY]);

    // A frame on some OTHER stream's key must not reach this session.
    bridge.emitSessionsStreamEvent({
      key: { ...KEY, scope: epicScope("other-epic") },
      event: { kind: "status", lifecycle: "live", errorMessage: null },
    });
    expect(statuses).toEqual([]);

    bridge.emitSessionsStreamEvent({
      key: KEY,
      event: { kind: "status", lifecycle: "live", errorMessage: null },
    });
    bridge.emitSessionsStreamEvent({
      key: KEY,
      event: { kind: "frame", frame: SNAPSHOT_FRAME },
    });
    expect(statuses).toEqual([{ lifecycle: "live", errorMessage: null }]);
    expect(frames).toEqual([SNAPSHOT_FRAME]);

    session.send({
      kind: "closeTab",
      hasBinaryPayload: false,
      requestId: "req-1",
      sessionId: "sess-1",
      tabId: "tab-1",
    });
    expect(bridge.sendSessionsFrameCalls).toEqual([
      {
        key: KEY,
        frame: {
          kind: "closeTab",
          hasBinaryPayload: false,
          requestId: "req-1",
          sessionId: "sess-1",
          tabId: "tab-1",
        },
      },
    ]);

    session.close();
    expect(bridge.closeSessionsStreamCalls).toEqual([KEY]);

    // Disposed: an event that arrives after close must not be delivered.
    bridge.emitSessionsStreamEvent({
      key: KEY,
      event: { kind: "frame", frame: SNAPSHOT_FRAME },
    });
    expect(frames).toEqual([SNAPSHOT_FRAME]);
  });

  it("relays tabBound and tabReleased by identity only", () => {
    const bridge = new FakeBrowserViewBridge();
    const { bound, released, callbacks } = recordingCallbacks();
    openBrowserSessionsSession({
      key: KEY,
      userId: "user-1",
      browserView: bridge,
      openTransport: () => {
        throw new Error("unused on the IPC path");
      },
      callbacks,
    });

    const capability: BrowserViewNativeTabCapability = {
      hostId: "host-1",
      sessionId: "sess-1",
      tabId: "tab-1",
      registrationId: "native:tab-1",
    };
    bridge.emitSessionsStreamEvent({
      key: KEY,
      event: { kind: "tabBound", capability },
    });
    bridge.emitSessionsStreamEvent({
      key: KEY,
      event: { kind: "tabReleased", capability },
    });
    expect(bound).toEqual([capability]);
    expect(released).toEqual([capability]);
  });
});

/** A minimal, fully-typed, drivable fake for the direct (no-bridge) path. */
function fakeHostStreamClient(): {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly emit: (
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  readonly emitStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
  closed: boolean;
} {
  let onServerFrame:
    | ((
        envelope: StreamFrameEnvelope,
        binaryPayload: Uint8Array | null,
      ) => void)
    | null = null;
  let onStatusChange:
    | ((
        status: StreamConnectionStatus,
        reason: StreamCloseReason | null,
      ) => void)
    | null = null;
  const state = { closed: false };
  const session: IStreamSession = {
    sendClientFrame: () => undefined,
    onServerFrame: (handler) => {
      onServerFrame = handler;
    },
    onStatusChange: (handler) => {
      onStatusChange = handler;
    },
    getNegotiatedSchemaVersion: () => null,
    requestReconnect: () => undefined,
    close: () => {
      state.closed = true;
    },
  };
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe: () => session,
    subscribeWithParamsProvider: () => session,
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    getClosedReason: () => null,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unsupported",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    instanceId: "fake-ws-stream-client",
    subscribeAvailabilityRecovered: () => () => undefined,
    onClosed: () => () => undefined,
  };
  return {
    client,
    emit: (envelope, binaryPayload) => {
      onServerFrame?.(envelope, binaryPayload);
    },
    emitStatus: (status, reason) => {
      onStatusChange?.(status, reason);
    },
    get closed() {
      return state.closed;
    },
    set closed(value: boolean) {
      state.closed = value;
    },
  };
}

describe("openBrowserSessionsSession on a shell with no browserView bridge", () => {
  it("opens the stream itself and drops a jar frame instead of handing it to the callback", () => {
    const fake = fakeHostStreamClient();
    let transportClosed = false;
    const transport: DurableStreamTransport = {
      wsStreamClient: fake.client,
      close: () => {
        transportClosed = true;
      },
    };
    const { frames, callbacks } = recordingCallbacks();
    const session = openBrowserSessionsSession({
      key: KEY,
      userId: "user-1",
      browserView: null,
      openTransport: () => transport,
      callbacks,
    });

    fake.emit(
      {
        kind: "snapshot",
        hasBinaryPayload: false,
        sessions: [],
      },
      null,
    );
    expect(frames).toEqual([SNAPSHOT_FRAME]);

    // This shell has no keystore to hold a jar, so a jar frame - the host
    // should never send one here, but if it somehow did - has to be dropped
    // rather than handed to the coordinator.
    fake.emit(
      {
        kind: "primaryProfileObserved",
        hasBinaryPayload: false,
        domain: "example.com",
        cookies: [],
      },
      null,
    );
    expect(frames).toEqual([SNAPSHOT_FRAME]);

    session.close();
    expect(transportClosed).toBe(true);
  });
});
