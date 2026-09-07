/** A `DurableStreamTransport` opener that mints no socket. */
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";

/** One transport this opener minted, and what has happened to it since. */
export interface FakeTransportRecord {
  readonly hostId: string;
  closeCount: number;
  readonly closeReasons: string[];
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
}

export interface FakeDurableStreamTransports {
  /** Every transport minted since the last reset, in open order. */
  readonly records: ReadonlyArray<FakeTransportRecord>;
  /** The opener to return from a mocked `useDurableStreamTransportFactory`. */
  opener: (hostId: string) => AttributableDurableStreamTransport;
}

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

function createWsStreamClient(
  instanceIndex: number,
  closeReasons: string[],
): IHostStreamClient<HostStreamRpcRegistry> {
  let closed = false;
  let closedReason: string | null = null;
  return {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => fakeStreamSession(),
    close: (reason) => {
      if (closed) return;
      closed = true;
      closedReason = reason;
      closeReasons.push(reason);
    },
    isClosed: () => closed,
    isReady: () => true,
    getClosedReason: () => closedReason,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    // "unsupported" on every lane method pins the adapter-selection verdict to "legacy" - see `readEpicAdapterVerdict` / `EPIC_LANE_METHODS`.
    // It matters only for a suite that lets the real `buildProxiedStreamFactories` run; a suite supplying its own factories never reaches this member, because the composition takes `laneSelection` from those factories directly.
    getMethodSupport: () => "unsupported",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    instanceId: `fake-ws-stream-client-${instanceIndex}`,
    subscribeAvailabilityRecovered: () => () => undefined,
    onClosed: () => () => undefined,
  };
}

const records: FakeTransportRecord[] = [];

const defaultOpener = (hostId: string): AttributableDurableStreamTransport => {
  const closeReasons: string[] = [];
  const wsStreamClient = createWsStreamClient(records.length, closeReasons);
  const record: FakeTransportRecord = {
    hostId,
    closeCount: 0,
    closeReasons,
    wsStreamClient,
  };
  records.push(record);
  const closeWithReason = (reason: string): void => {
    record.closeCount += 1;
    wsStreamClient.close(reason);
  };
  return {
    wsStreamClient,
    close: () => {
      closeWithReason("durable-transport-closed");
    },
    closeWithReason,
  };
};

const shared: FakeDurableStreamTransports = { records, opener: defaultOpener };

/** The file's registry. */
export function fakeDurableStreamTransports(): FakeDurableStreamTransports {
  return shared;
}

/**
 * Forget every minted transport and restore the default opener.
 * Call in `beforeEach`.
 */
export function resetFakeDurableStreamTransports(): void {
  records.length = 0;
  shared.opener = defaultOpener;
}
