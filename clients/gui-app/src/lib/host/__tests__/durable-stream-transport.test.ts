import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";

// `openDurableStreamTransport` is the single place "durable stream = transport +
// auth + wake" is assembled. These tests pin its two load-bearing guarantees:
// the teardown order, and that a failure while wiring wake never leaks the
// socket. The socket builder and wake wiring are mocked so the test is about
// the assembly contract, not the real transport.
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
    expect(order).toEqual(["wake", "ws"]);
  });

  it("closes the half-built socket and rethrows if wiring wake throws", () => {
    const closeWs = vi.fn();
    const { params, fakeWs } = buildParams(closeWs);
    const wakeError = new Error("wake wiring failed");
    mocks.subscribeStreamWakeReconnect.mockImplementation(() => {
      throw wakeError;
    });

    expect(() => openDurableStreamTransport(params)).toThrow(wakeError);
    // The socket built moments earlier must be closed so neither it nor any
    // half-registered listener leaks for the lifetime of the window.
    expect(fakeWs.close).toHaveBeenCalledTimes(1);
    expect(closeWs).toHaveBeenCalledTimes(1);
  });
});
