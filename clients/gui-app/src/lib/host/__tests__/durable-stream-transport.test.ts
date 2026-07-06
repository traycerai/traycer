import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";

// `openDurableStreamTransport` is the single place "durable stream = transport +
// auth + bearer rotation + wake" is assembled. These tests pin its load-bearing
// guarantees: forwarding rotations, teardown order, and that a failure while
// wiring wake never leaks the socket. The socket builder and wake wiring are
// mocked so the test is about the assembly contract, not the real transport.
const mocks = vi.hoisted(() => ({
  buildHostStreamClient: vi.fn(),
  subscribeStreamWakeReconnect: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  buildHostStreamClient: mocks.buildHostStreamClient,
}));
vi.mock("@/lib/host/stream-wake-reconnect", () => ({
  subscribeStreamWakeReconnect: mocks.subscribeStreamWakeReconnect,
}));

import { openDurableStreamTransport } from "@/lib/host/durable-stream-transport";

const RUNNER_HOST = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://localhost:5005",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

const AUTH: StreamAuthRevalidator = {
  revalidateForReconnect: () => Promise.resolve("rotated"),
};

function buildParams(closeWs: () => void) {
  const order: string[] = [];
  const fakeWs = {
    close: vi.fn(() => {
      order.push("ws");
      closeWs();
    }),
    reconnectAll: vi.fn(),
    notifyBearerRotated: vi.fn(),
  };
  mocks.buildHostStreamClient.mockReturnValue(fakeWs);
  return {
    order,
    fakeWs,
    params: {
      endpoint: () => null,
      bearer: () => null,
      auth: AUTH,
      runnerHost: RUNNER_HOST,
      subscribeBearerRotation: (_onRotation: () => void) => {
        return () => {
          order.push("bearer");
        };
      },
      // No endpoint ever moves in these assembly tests; return a no-op disposer.
      subscribeEndpointChange: () => () => undefined,
    },
  };
}

beforeEach(() => {
  mocks.buildHostStreamClient.mockReset();
  mocks.subscribeStreamWakeReconnect.mockReset();
});

describe("openDurableStreamTransport", () => {
  it("wires wake on the built socket and tears down wake BEFORE the socket on close", () => {
    const { order, params } = buildParams(() => undefined);
    const disposeWake = vi.fn(() => {
      order.push("wake");
    });
    mocks.subscribeStreamWakeReconnect.mockReturnValue(disposeWake);

    const transport = openDurableStreamTransport(params);

    // Wake is subscribed against the freshly-built socket with the live host.
    expect(mocks.buildHostStreamClient).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeStreamWakeReconnect).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeStreamWakeReconnect.mock.calls[0][0]).toBe(
      transport.wsStreamClient,
    );
    expect(mocks.subscribeStreamWakeReconnect.mock.calls[0][1]).toBe(
      RUNNER_HOST,
    );
    expect(disposeWake).not.toHaveBeenCalled();

    transport.close();

    // Disposing wake before closing the socket avoids a wake firing
    // `reconnectAll` on a socket that is being torn down.
    expect(order).toEqual(["bearer", "wake", "ws"]);
  });

  it("forwards bearer rotations to the built socket and removes the listener before close", () => {
    const { order, params, fakeWs } = buildParams(() => undefined);
    const disposeWake = vi.fn(() => {
      order.push("wake");
    });
    let bearerListener: (() => void) | null = null;
    const disposeBearer = vi.fn(() => {
      order.push("bearer");
      bearerListener = null;
    });
    mocks.subscribeStreamWakeReconnect.mockReturnValue(disposeWake);
    params.subscribeBearerRotation = (listener: () => void) => {
      bearerListener = listener;
      return disposeBearer;
    };
    const fireBearerRotation = (): void => {
      if (bearerListener !== null) {
        bearerListener();
      }
    };

    const transport = openDurableStreamTransport(params);

    fireBearerRotation();
    expect(fakeWs.notifyBearerRotated).toHaveBeenCalledTimes(1);

    transport.close();
    expect(disposeBearer).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["bearer", "wake", "ws"]);

    fireBearerRotation();
    expect(fakeWs.notifyBearerRotated).toHaveBeenCalledTimes(1);
  });

  it("closes the half-built socket and rethrows if wiring wake throws", () => {
    const closeWs = vi.fn();
    const { order, params, fakeWs } = buildParams(closeWs);
    const wakeError = new Error("wake wiring failed");
    mocks.subscribeStreamWakeReconnect.mockImplementation(() => {
      throw wakeError;
    });

    expect(() => openDurableStreamTransport(params)).toThrow(wakeError);
    // The socket built moments earlier must be closed so neither it nor any
    // half-registered listener leaks for the lifetime of the window.
    expect(fakeWs.close).toHaveBeenCalledTimes(1);
    expect(closeWs).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["bearer", "ws"]);
  });

  it("re-dials at once when the host's dialable endpoint moves, not on benign re-emits", () => {
    const reconnectAll = vi.fn();
    const fakeWs = { close: vi.fn(), reconnectAll };
    mocks.buildHostStreamClient.mockReturnValue(fakeWs);
    mocks.subscribeStreamWakeReconnect.mockReturnValue(() => undefined);

    let websocketUrl: string | null = "ws://host-a/rpc";
    let fireDirectoryChange: () => void = () => undefined;
    const params = {
      endpoint: () =>
        websocketUrl === null ? null : { hostId: "host-a", websocketUrl },
      bearer: () => null,
      auth: AUTH,
      runnerHost: RUNNER_HOST,
      subscribeBearerRotation: () => () => undefined,
      subscribeEndpointChange: (onChange: () => void) => {
        fireDirectoryChange = onChange;
        return () => undefined;
      },
    };

    const transport = openDurableStreamTransport(params);

    // A benign re-emit with the SAME url (every `onLocalHostChange` rebuilds the
    // entry) must NOT churn the socket.
    fireDirectoryChange();
    expect(reconnectAll).not.toHaveBeenCalled();

    // Host restart / re-provision moves to a new `websocketUrl`: re-dial at once
    // rather than waiting out the pong timeout on a half-open socket.
    websocketUrl = "ws://host-a/rpc-2";
    fireDirectoryChange();
    expect(reconnectAll).toHaveBeenCalledTimes(1);
    expect(reconnectAll).toHaveBeenCalledWith("host-endpoint-change");

    // Endpoint goes away (host down), then returns on a new url: re-dial again -
    // a null gap is recorded but not nudged, the next non-null move fires it.
    websocketUrl = null;
    fireDirectoryChange();
    websocketUrl = "ws://host-a/rpc-3";
    fireDirectoryChange();
    expect(reconnectAll).toHaveBeenCalledTimes(2);

    transport.close();
  });
});
