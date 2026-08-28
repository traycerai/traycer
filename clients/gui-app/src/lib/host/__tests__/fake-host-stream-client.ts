import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

function fakeStreamSession(): IStreamSession {
  return {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    onStatusChange: () => undefined,
    getNegotiatedSchemaVersion: () => null,
    requestReconnect: () => undefined,
    close: () => undefined,
  };
}

export interface FakeHostStreamClient extends IHostStreamClient<HostStreamRpcRegistry> {
  /** Fires every listener registered through `subscribeAvailabilityRecovered`. */
  fireAvailabilityRecovered(): void;
  /** Fires every listener registered through `onClosed`. */
  fireClosed(): void;
  readonly recoveredListenerCount: number;
  readonly closedListenerCount: number;
}

/**
 * A minimal stand-in for the real transport client. Only
 * `subscribeAvailabilityRecovered` and `onClosed` are wired to a live listener
 * set - the session-connectivity store's `subscribe` calls exactly those two -
 * and the rest of the interface is stubbed with real no-op implementations so
 * the fake type-checks against `IHostStreamClient<HostStreamRpcRegistry>`
 * unchanged.
 *
 * `isReady` is fed from the SAME source as the store's injected readiness
 * thunk. The store reads the injected one, but the two answering differently
 * would be a fake that cannot occur in production, and a later reader wiring
 * the store to `client.isReady()` would then get silently inconsistent tests.
 * `reconnectAll` belongs to `useHostSessionWake` and is never called here.
 */
export function createFakeHostStreamClient(
  isReady: () => boolean,
): FakeHostStreamClient {
  const recoveredListeners = new Set<() => void>();
  const closedListeners = new Set<() => void>();
  let closed = false;
  const client: FakeHostStreamClient = {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => {
      closed = true;
    },
    isClosed: () => closed,
    isReady,
    getClosedReason: () => null,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    instanceId: "fake-stream-client",
    subscribeAvailabilityRecovered: (listener: () => void) => {
      recoveredListeners.add(listener);
      return () => {
        recoveredListeners.delete(listener);
      };
    },
    onClosed: (listener: () => void) => {
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
    fireAvailabilityRecovered: () => {
      for (const listener of [...recoveredListeners]) listener();
    },
    fireClosed: () => {
      for (const listener of [...closedListeners]) listener();
    },
    get recoveredListenerCount() {
      return recoveredListeners.size;
    },
    get closedListenerCount() {
      return closedListeners.size;
    },
  };
  return client;
}

/** A controllable readiness double: the same thunk shape the store takes. */
export function createReadyControl(initial: boolean): {
  readonly isReady: () => boolean;
  readonly setReady: (value: boolean) => void;
} {
  let ready = initial;
  return {
    isReady: () => ready,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}
