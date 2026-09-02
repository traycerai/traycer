import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
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

function controllableTransport(): {
  readonly transport: DurableStreamTransport;
  readonly emitClosed: (reason: string) => void;
  readonly closeTransport: Mock<() => void>;
} {
  const closedListeners = new Set<() => void>();
  let closed = false;
  let closedReason: string | null = null;
  const wsStreamClient: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => fakeStreamSession(),
    close: () => undefined,
    isClosed: () => closed,
    getClosedReason: () => closedReason,
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    instanceId: "controlled-durable-client",
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    isReady: () => !closed,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
  };
  const closeTransport = vi.fn();
  return {
    transport: { wsStreamClient, close: closeTransport },
    emitClosed: (reason) => {
      closed = true;
      closedReason = reason;
      for (const listener of [...closedListeners]) listener();
    },
    closeTransport,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("openOwnedDurableStreamClient plan-restricted reprobe", () => {
  it("asks the owner to rebuild at the session cache deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const controlled = controllableTransport();
    const rebuild = vi.fn();
    const owned = openOwnedDurableStreamClient(
      () => controlled.transport,
      "host-a",
      () => ({ close: vi.fn() }),
      rebuild,
    );

    controlled.emitClosed("plan-restricted:11000");
    vi.advanceTimersByTime(999);
    expect(rebuild).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rebuild).toHaveBeenCalledTimes(1);

    owned.close();
  });

  it("cancels an armed rebuild when the durable owner is disposed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const controlled = controllableTransport();
    const rebuild = vi.fn();
    const owned = openOwnedDurableStreamClient(
      () => controlled.transport,
      "host-a",
      () => ({ close: vi.fn() }),
      rebuild,
    );

    controlled.emitClosed("plan-restricted:21000");
    owned.close();
    vi.advanceTimersByTime(1_000);
    expect(rebuild).not.toHaveBeenCalled();
    expect(controlled.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("arms the deadline when the negative cache returns an already-closed client", () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const controlled = controllableTransport();
    controlled.emitClosed("plan-restricted:31000");
    const rebuild = vi.fn();
    const owned = openOwnedDurableStreamClient(
      () => controlled.transport,
      "host-a",
      () => ({ close: vi.fn() }),
      rebuild,
    );

    vi.advanceTimersByTime(1_000);
    expect(rebuild).toHaveBeenCalledTimes(1);
    owned.close();
  });

  it("retries an owner rebuild that throws synchronously", () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const controlled = controllableTransport();
    const rebuild = vi.fn<() => void>().mockImplementationOnce(() => {
      throw new Error("wiring failed");
    });
    const owned = openOwnedDurableStreamClient(
      () => controlled.transport,
      "host-a",
      () => ({ close: vi.fn() }),
      rebuild,
    );

    controlled.emitClosed("plan-restricted:41000");
    vi.advanceTimersByTime(1_000);
    expect(rebuild).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(rebuild).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(rebuild).toHaveBeenCalledTimes(2);

    owned.close();
  });

  it("bounds repeated synchronous rebuild failures", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const controlled = controllableTransport();
    const rebuild = vi.fn(() => {
      throw new Error("still unavailable");
    });
    const owned = openOwnedDurableStreamClient(
      () => controlled.transport,
      "host-a",
      () => ({ close: vi.fn() }),
      rebuild,
    );

    controlled.emitClosed("plan-restricted:51000");
    vi.advanceTimersByTime(10_000);
    expect(rebuild).toHaveBeenCalledTimes(3);

    owned.close();
  });
});
