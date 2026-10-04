import { describe, expect, it, vi, type Mock } from "vitest";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";

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

function fakeTransport(): {
  readonly transport: DurableStreamTransport;
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly closeTransport: Mock<() => void>;
} {
  const wsStreamClient: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => fakeStreamSession(),
    close: () => undefined,
    isClosed: () => false,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "owned-durable-client",
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    isReady: () => true,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
  };
  const closeTransport = vi.fn<() => void>();
  return {
    transport: { wsStreamClient, close: closeTransport },
    wsStreamClient,
    closeTransport,
  };
}

describe("openOwnedDurableStreamClient", () => {
  it("opens the transport for the host and builds the typed client over its stream client", () => {
    const fake = fakeTransport();
    const openTransport = vi.fn<(hostId: string) => DurableStreamTransport>(
      () => fake.transport,
    );
    const client = { close: vi.fn() };
    const build = vi.fn<
      (wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>) => {
        readonly close: () => void;
      }
    >(() => client);

    const owned = openOwnedDurableStreamClient(openTransport, "host-a", build);

    expect(openTransport).toHaveBeenCalledTimes(1);
    expect(openTransport).toHaveBeenCalledWith("host-a");
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(fake.wsStreamClient);
    expect(owned.client).toBe(client);
    // Opening owns the transport but must not tear anything down.
    expect(client.close).not.toHaveBeenCalled();
    expect(fake.closeTransport).not.toHaveBeenCalled();
  });

  it("closes the typed client before its transport, each exactly once", () => {
    const fake = fakeTransport();
    const order: string[] = [];
    const client = {
      close: vi.fn(() => {
        order.push("client");
      }),
    };
    fake.closeTransport.mockImplementation(() => {
      order.push("transport");
    });

    const owned = openOwnedDurableStreamClient(
      () => fake.transport,
      "host-a",
      () => client,
    );
    owned.close();

    expect(order).toEqual(["client", "transport"]);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(fake.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("closes the half-built transport and rethrows when the build throws synchronously", () => {
    const fake = fakeTransport();
    const failure = new Error("wiring failed");

    expect(() =>
      openOwnedDurableStreamClient(
        () => fake.transport,
        "host-a",
        () => {
          throw failure;
        },
      ),
    ).toThrow(failure);

    expect(fake.closeTransport).toHaveBeenCalledTimes(1);
  });
});
